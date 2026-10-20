// _shared/dreams-facts.test.ts
// Correr con: deno test --allow-read supabase/functions/_shared/dreams-facts.test.ts
//
// Casos reales (SuperCines, oct-2026): Dreams fijó como «aprendizaje» datos del negocio que
// solo respaldaba lo que había dicho el agente. Un aprendizaje describe CONDUCTA; los datos
// salen de las fuentes oficiales. El corte determinista los neutraliza o descarta.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { FACT_PLACEHOLDER, neutralizeBusinessFacts, neutralizeLearning } from "./dreams-facts.ts";

const L = (title: string, content: string, evidence = "Lead#1 preguntó.") => ({
  title, category: "anti_pattern", severity: "error", vertical: "cross", content, evidence, updates: "",
});

Deno.test("estado + causa de una sede (Playa Mar «por afectación sísmica») se descarta", () => {
  const r = neutralizeBusinessFacts(
    "La sede Playa Mar está cerrada por afectación sísmica. Ofrece otra sede cercana cuando el lead pregunte por ella.",
  );
  assert(!/sísmic|cerrada/i.test(r.text), r.text);
  assertStringIncludes(r.text, "Ofrece otra sede cercana");
  assertEquals(r.dropped, 1);
});

Deno.test("una orden de decir el estado («dile que está cerrada por…») también se descarta", () => {
  const r = neutralizeBusinessFacts("Si preguntan por Playa Mar, di que permanece cerrada por remodelación.");
  assertEquals(r.text, "");
});

Deno.test("el título que afirma un estado con causa descarta el aprendizaje entero", () => {
  assertEquals(
    neutralizeLearning(L("sede_playa_mar_cerrada_por_afectacion_sismica", "Avisa a los leads de la situación de la sede.")),
    null,
  );
});

Deno.test("correo electrónico → marcador de fuente oficial", () => {
  const r = neutralizeBusinessFacts("Para reclamos, indica el correo atencion@supercines.com.");
  assert(!r.text.includes("@"), r.text);
  assertStringIncludes(r.text, FACT_PLACEHOLDER);
  assertEquals(r.redacted, 1);
});

Deno.test("montos («Cashea desde $25», «Bs. 120», «30 USD») → marcador", () => {
  for (const s of ["Cashea está disponible desde $25.", "La entrada cuesta Bs. 120,50.", "El combo sale 30 USD."]) {
    const r = neutralizeBusinessFacts(s);
    assert(!/\d/.test(r.text), `${s} → ${r.text}`);
    assertStringIncludes(r.text, FACT_PLACEHOLDER);
  }
});

Deno.test("horarios («horario 9–6», «de 9:00 a 18:00», «10am») → marcador", () => {
  for (const s of [
    "El horario de atención es 9–6 de lunes a viernes.",
    "Atienden de 9:00 a 18:00.",
    "La taquilla abre a las 10am.",
  ]) {
    const r = neutralizeBusinessFacts(s);
    assert(!/\d/.test(r.text), `${s} → ${r.text}`);
  }
});

Deno.test("teléfonos, URLs y fechas → marcador", () => {
  for (const s of [
    "Que llamen al +58 212-555-1234.",
    "Que escriban al 0414 555 12 34.",
    "Las bases están en https://supercines.com/promos.",
    "La promo vence el 31/10/2026.",
    "La preventa empieza el 5 de noviembre.",
  ]) {
    const r = neutralizeBusinessFacts(s);
    assert(!/\d|https?:/.test(r.text), `${s} → ${r.text}`);
    assertStringIncludes(r.text, FACT_PLACEHOLDER);
  }
});

Deno.test("los aprendizajes de CONDUCTA quedan intactos", () => {
  for (const s of [
    "Antes de confirmar que una sede está cerrada, consulta search_kb y responde solo con lo que diga.",
    "Cuando el lead pregunte por métodos de pago, toma las condiciones solo de la KB o de promociones_activas.",
    "Si el lead pide hablar con una persona, deriva al equipo sin insistir.",
    "Responde en 2-3 oraciones y cierra con una pregunta.",
    "Lead#3 y Lead#12 recibieron respuestas sin saludo: saluda por el nombre.",
    "Verifica en la KB si una sede está cerrada por mantenimiento antes de responder.",
  ]) {
    const r = neutralizeBusinessFacts(s);
    assertEquals(r.text, s);
    assertEquals(r.redacted + r.dropped, 0, s);
  }
});

Deno.test("un aprendizaje de conducta pasa entero; uno solo de datos se descarta", () => {
  const ok = L("verificar_estado_de_sede", "Antes de decir que una sede está cerrada, consulta search_kb.");
  assertEquals(neutralizeLearning(ok), ok);
  assertEquals(neutralizeLearning(L("sede_cerrada", "La sede Playa Mar está cerrada por afectación sísmica.")), null);
});

Deno.test("la evidencia también se neutraliza (entra a la consolidación)", () => {
  const r = neutralizeLearning(
    L("correo_de_reclamos", "Para reclamos, da el correo oficial que figure en la KB.", "El agente dio atencion@x.com a Lead#2."),
  );
  assert(r);
  assert(!r.evidence.includes("@"), r.evidence);
  assertStringIncludes(r.evidence, "Lead#2");
});

Deno.test("en un digest con viñetas se quitan las viñetas que quedan vacías, no los encabezados con contenido", () => {
  const r = neutralizeBusinessFacts(
    "## Errores a no repetir\n- La sede Playa Mar está cerrada por afectación sísmica.\n- No prometas descuentos.\n## Refuerzos y estilo\n- Saluda por el nombre.",
  );
  assertEquals(r.text, "## Errores a no repetir\n- No prometas descuentos.\n## Refuerzos y estilo\n- Saluda por el nombre.");
});

// ---- Revisión de c833dd4: sobre-redacción (lo que debe quedar INTACTO) ----
Deno.test("oraciones condicionales sobre lo que dice el lead quedan intactas", () => {
  for (const s of [
    "Si el lead dice que la función está agotada, ofrécele otro horario.",
    "Cuando el lead reporte una afectación en su pago, deriva al equipo.",
    "En caso de que el lead diga que la sede está cerrada, pídele el nombre de la sede.",
    "Ofrece otra función si el lead dice que la sala está agotada.",
  ]) {
    const r = neutralizeBusinessFacts(s);
    assertEquals(r.text, s);
    assertEquals(r.redacted + r.dropped, 0, s);
  }
});

Deno.test("una causa mencionada sin afirmar un estado no se descarta", () => {
  const s = "Muestra empatía cuando el lead mencione el sismo y ofrece ayuda.";
  assertEquals(neutralizeBusinessFacts(s).text, s);
  const s2 = "Pregunta con calma por la remodelación que el lead menciona.";
  assertEquals(neutralizeBusinessFacts(s2).text, s2);
});

Deno.test("rangos que no son horarios quedan intactos aunque la oración hable de horario o funciones", () => {
  for (const s of [
    "Si el lead pregunta por el horario, responde en 2-3 oraciones.",
    "Al hablar de la taquilla, ofrece 2 a 3 opciones de funciones.",
    "Cuando pregunten el horario, contesta en 1-2 mensajes cortos.",
    "Si preguntan cuándo abre, responde en 3-5 minutos.",
    "Para el horario, lista 2-4 funciones como máximo.",
  ]) {
    const r = neutralizeBusinessFacts(s);
    assertEquals(r.text, s);
    assertEquals(r.redacted, 0, s);
  }
});

Deno.test("números cortos con separadores no son teléfonos", () => {
  for (const s of ["Responde en 2 - 3 oraciones (máx. 4).", "Usa listas de 1. 2. 3. pasos."]) {
    assertEquals(neutralizeBusinessFacts(s).redacted, 0, s);
  }
});

Deno.test("un fin de oración sin espacio no es un dominio", () => {
  for (const s of ["El lead nunca uses.Es mejor saludar.", "Cierra con una pregunta.Es más efectivo."]) {
    assertEquals(neutralizeBusinessFacts(s).redacted, 0, s);
  }
});

Deno.test("un título con «agotada» no descarta el aprendizaje de conducta", () => {
  const ok = L("funcion_agotada_ofrecer_alternativa", "Cuando el lead pida una función sin cupo, ofrece la siguiente disponible según la cartelera.");
  assertEquals(neutralizeLearning(ok), ok);
  const ok2 = L("entradas_siguen_agotadas_ofrecer_otra_sala", "Ofrece otra sala o función de la cartelera vigente.");
  assertEquals(neutralizeLearning(ok2), ok2);
});

// ---- Los casos reales malos SIGUEN neutralizándose ----
Deno.test("casos reales malos siguen neutralizados", () => {
  assertEquals(neutralizeBusinessFacts("La sede Playa Mar sufrió afectación sísmica.").text, "");
  assertEquals(neutralizeBusinessFacts("Las entradas siguen agotadas para el estreno.").text, "");
  assertEquals(neutralizeBusinessFacts("Si preguntan por Playa Mar, di que permanece cerrada por remodelación.").text, "");
  for (const s of ["Atienden de 9 a 6 pm.", "La taquilla abre de 10 a 22 horas.", "El horario es 9–6.", "Abren de 9:00 a 18:00."]) {
    assert(!/\d/.test(neutralizeBusinessFacts(s).text), s);
  }
  assert(!/\d/.test(neutralizeBusinessFacts("Escribe al 0414-5551234.").text));
  assertStringIncludes(neutralizeBusinessFacts("Las bases están en supercines.com/promos.").text, FACT_PLACEHOLDER);
  assertStringIncludes(neutralizeBusinessFacts("Las bases están en SuperCines.com.").text, FACT_PLACEHOLDER);
});

// ---- Rendimiento: nada cuadrático con entradas patológicas ----
Deno.test("entradas patológicas de 60k caracteres se procesan en < 200 ms", () => {
  const inputs = [
    "a".repeat(60_000),
    "a.".repeat(30_000),
    "a@".repeat(30_000),
    "1 ".repeat(30_000),
    "a-".repeat(30_000) + "@",
    ("x".repeat(1999) + "\n").repeat(30),
  ];
  for (const s of inputs) {
    const t0 = performance.now();
    neutralizeBusinessFacts(s);
    const ms = performance.now() - t0;
    assert(ms < 200, `${s.slice(0, 10)}…: ${ms.toFixed(0)} ms`);
  }
});
