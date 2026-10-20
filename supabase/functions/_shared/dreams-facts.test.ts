// _shared/dreams-facts.test.ts
// Correr con: deno test --allow-read supabase/functions/_shared/dreams-facts.test.ts
//
// Casos reales (SuperCines, oct-2026): Dreams fijó como «aprendizaje» datos del negocio que
// solo respaldaba lo que había dicho el agente. Un aprendizaje describe CONDUCTA; los datos
// salen de las fuentes oficiales. El corte determinista los neutraliza o descarta.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import {
  AGENT_AVAILABILITY_PHRASE,
  AGENT_FACT_PHRASE,
  AGENT_FACT_STANDALONE,
  AGENT_SCHEDULE_PHRASE,
  agentFacingFacts,
  AVAILABILITY_PLACEHOLDER,
  FACT_PLACEHOLDER,
  highRiskDataShapes,
  isAnaphoric,
  SCHEDULE_PLACEHOLDER,
  splitSentences,
  neutralizeBusinessFacts,
  neutralizeLearning,
  removeDataShapeLines,
} from "./dreams-facts.ts";
import { detectInternalLeak } from "./response-guard.ts";

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

Deno.test("LAM: las fechas de la evidencia se conservan (metadato), los datos no; el contenido sí neutraliza fechas", () => {
  const r = neutralizeLearning(
    L(
      "correo_de_reclamos",
      "Para reclamos, da el correo oficial que figure en la KB.",
      "El 2026-10-19 (y el 19/10 y el 19 de octubre) el agente dio atencion@x.com y el 0414-1234567 a Lead#2.",
    ),
  );
  assert(r);
  for (const keep of ["2026-10-19", "19/10", "19 de octubre", "Lead#2"]) assertStringIncludes(r.evidence, keep);
  for (const bad of ["@", "0414"]) assert(!r.evidence.includes(bad), r.evidence);
  assert(!r.evidence.includes("\u2060"), "sin caracteres de control residuales");
  assertStringIncludes(neutralizeBusinessFacts("Abre el 19 de octubre.").text, "[dato");
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

// ─── Versión para el AGENTE: sin el marcador literal (SuperCines, oct-2026) ──
// El marcador sirve en los archivos de dreams (los lee el operador), pero en el digest el
// agente lo copiaba tal cual al cliente: «remite a [dato: tomarlo de la fuente oficial]».

Deno.test("agentFacingFacts: la regla de SuperCines queda con una frase natural, sin marcador", () => {
  const regla =
    "- Si no tienes confirmado un dato de la KB, dilo sin inventar y remite a [dato: tomarlo de la fuente oficial] o al correo de gerencia.";
  const out = agentFacingFacts(regla);
  assertEquals(
    out,
    `- Si no tienes confirmado un dato de la KB, dilo sin inventar y remite a ${AGENT_FACT_PHRASE} o al correo de gerencia.`,
  );
  assert(!out.includes("[dato"), out);
  assertEquals(detectInternalLeak(out), null);
});

Deno.test("agentFacingFacts: preposiciones contraídas y marcadores seguidos", () => {
  assertEquals(agentFacingFacts(`Deriva al ${FACT_PLACEHOLDER}.`), `Deriva a ${AGENT_FACT_PHRASE}.`);
  assertEquals(agentFacingFacts(`Informa el horario del ${FACT_PLACEHOLDER}.`), `Informa el horario de ${AGENT_FACT_PHRASE}.`);
  assertEquals(agentFacingFacts(`Indica que se consulta en ${FACT_PLACEHOLDER}.`), `Indica que se consulta en ${AGENT_FACT_PHRASE}.`);
  // Un marcador SIN preposición no tiene frase natural («abre el dato oficial» es basura que
  // el agente podía copiar al cliente): se quita la cláusula entera, sin dejar fragmentos.
  assertEquals(agentFacingFacts(`Abre ${FACT_PLACEHOLDER} a ${FACT_PLACEHOLDER}; confírmalo.`), "Confírmalo.");
  assertEquals(agentFacingFacts(`- Cashea desde ${FACT_PLACEHOLDER}.`), "");
  assert(!agentFacingFacts(`Cashea desde ${FACT_PLACEHOLDER}.`).includes(AGENT_FACT_STANDALONE));
});

// ─── Producción (oct-2026): la red de salida no puede dejar reglas mutiladas ──
// Veterinaria: «atiende emergencias 24/7; llama ahora…» salió «atiende emergencias el dato
// oficial; llama ahora…». KIA: una regla de conducta válida quedó «El horario es único, el de
// tu prompt;». El agente podía copiar esos fragmentos al cliente.

Deno.test("agentFacingFacts: Veterinaria — la cláusula con el marcador se quita limpia", () => {
  const out = agentFacingFacts(
    `- Atiende emergencias ${FACT_PLACEHOLDER}; llama ahora al lead y ofrece la cita más próxima.`,
  );
  assertEquals(out, "- Llama ahora al lead y ofrece la cita más próxima.");
  assert(!out.includes(AGENT_FACT_STANDALONE), out);
  assertEquals(detectInternalLeak(out), null);
});

Deno.test("agentFacingFacts: KIA — nunca queda una oración colgando en «;», «:» o «,»", () => {
  const out = agentFacingFacts(
    `- El horario es único, el de tu prompt; los domingos abre ${FACT_PLACEHOLDER}.\n- No prometas descuentos.`,
  );
  assertEquals(out, "- El horario es único, el de tu prompt.\n- No prometas descuentos.");
  for (const l of out.split("\n")) assert(!/[;:,]\s*$/.test(l), l);
});

Deno.test("agentFacingFacts: una regla de conducta sin marcador pasa intacta (KIA, Veterinaria)", () => {
  for (const t of [
    "- No digas que abre el domingo; si preguntan, aclara que está cerrado y cuándo abre.",
    "- Usa solo el horario de tu system prompt; si no lo tienes, deriva a un asesor.",
  ]) assertEquals(agentFacingFacts(t), t);
});

Deno.test("neutralizeBusinessFacts: al descartar una oración no deja la anterior colgando en «;»", () => {
  const r = neutralizeBusinessFacts("No digas que abre el domingo; la sede está cerrada por remodelación.");
  assertEquals(r.text, "No digas que abre el domingo.");
});

Deno.test("neutralizeBusinessFacts({ markDropped }): la oración descartada deja el marcador (entrada de la consolidación)", () => {
  const r = neutralizeBusinessFacts("No digas que abre el domingo; la sede está cerrada por remodelación.", { markDropped: true });
  assertEquals(r.text, `No digas que abre el domingo; ${FACT_PLACEHOLDER}.`);
  // sin la opción (generación) se descarta como siempre
  assertEquals(neutralizeBusinessFacts("La sede Playa Mar sufrió afectación sísmica.").text, "");
});

Deno.test("agentFacingFacts: también reescribe variantes que el modelo copió del marcador", () => {
  const out = agentFacingFacts("- Remite a [Dato: correo oficial] para reclamos.");
  assertEquals(out, `- Remite a ${AGENT_FACT_PHRASE} para reclamos.`);
});

Deno.test("agentFacingFacts: sin marcador no cambia nada y es idempotente", () => {
  const t = "## Errores a no repetir\n- No prometas descuentos.\n- Pide la cédula antes de reservar.";
  assertEquals(agentFacingFacts(t), t);
  const once = agentFacingFacts(`Remite a ${FACT_PLACEHOLDER}.`);
  assertEquals(agentFacingFacts(once), once);
});

Deno.test("agentFacingFacts: lo que produce el corte nunca dispara el verificador de salida", () => {
  const raw = neutralizeBusinessFacts(
    "- Para reclamos da atencion@supercines.com o llama al 0212-555-1234.\n- El horario es de 9 a 6 pm.\n- Cashea desde $25.",
  ).text;
  assert(raw.includes(FACT_PLACEHOLDER), raw);
  const out = agentFacingFacts(raw);
  assertEquals(detectInternalLeak(out), null, out);
  assert(!/\[\s*dato/i.test(out), out);
});

Deno.test("agentFacingFacts: un marcador de más de 80 caracteres también se reescribe", () => {
  for (const n of [120, 900]) {
    const largo = `[dato: tomarlo de la fuente oficial ${"del banco, sección de tasas ".repeat(40).slice(0, n)}]`;
    assert(largo.length > 80);
    const out = agentFacingFacts(`- Remite a ${largo} para reclamos.`);
    assertEquals(out, `- Remite a ${AGENT_FACT_PHRASE} para reclamos.`, `${n}`);
    assertEquals(detectInternalLeak(out), null, out);
  }
});

Deno.test("agentFacingFacts: no toca links markdown ni etiquetas «[Datos]:» de un texto con marcador", () => {
  const out = agentFacingFacts(`- Pide [Datos]: nombre y cédula; ver [datos](https://x.com); remite a ${FACT_PLACEHOLDER}.`);
  assertEquals(out, `- Pide [Datos]: nombre y cédula; ver [datos](https://x.com); remite a ${AGENT_FACT_PHRASE}.`);
});

Deno.test("agentFacingFacts: un marcador sin cerrar y enorme no vuelve lento el corte", () => {
  const s = "- " + "[dato: x".repeat(3000);
  const t0 = performance.now();
  agentFacingFacts(s);
  assert(performance.now() - t0 < 500);
});

// ─── Salida de la consolidación: formas de dato de alto riesgo (oct-2026) ───
// La salida del consolidador ya no pasa por el corte de datos (mutilaba reglas válidas), así
// que una salida manipulada (prompt injection en un dream) podía reintroducir un correo, un
// enlace, un teléfono o un monto en el contexto privilegiado del agente. Solo se detectan
// esas formas, nunca horas, fechas, «24/7» ni rangos.

Deno.test("highRiskDataShapes: correo, URL/dominio, teléfono y monto", () => {
  assertEquals(highRiskDataShapes("- Si piden reclamos, escribe a ventas@x.com."), ["email"]);
  assertEquals(highRiskDataShapes("- Para promociones, visita https://x.com/promo."), ["url"]);
  assertEquals(highRiskDataShapes("- Remite a kia.com.ve para el catálogo."), ["url"]);
  assertEquals(highRiskDataShapes("- Para citas, llama al 0414-1234567."), ["phone"]);
  assertEquals(highRiskDataShapes("- El combo cuesta $25, ofrécelo siempre."), ["money"]);
  assertEquals(highRiskDataShapes("- La inicial es de 500 Bs."), ["money"]);
  assertEquals(highRiskDataShapes("- El precio es 30 USD."), ["money"]);
});

Deno.test("highRiskDataShapes: horas, fechas, 24/7, rangos y cantidades NO son de alto riesgo", () => {
  for (const s of [
    "- Atiende emergencias 24/7; llama ahora al lead y ofrece la cita más próxima.",
    "- No digas que abre el domingo; si preguntan, aclara que está cerrado y cuándo abre.",
    "- El horario es de 9 a 6; usa solo el de tu system prompt.",
    "- Responde en 2-3 oraciones.",
    "- Desde el 2026-10-19 confirma la sede antes de agendar.",
    "- Abre a las 9:00 am; no lo repitas sin verificar.",
    "- Usa search_kb antes de responder sobre USD o bolívares.",
    "- Escribe learnings.md solo si aprendiste algo nuevo.",
  ]) assertEquals(highRiskDataShapes(s), [], s);
});

Deno.test("highRiskDataShapes: una línea enorme no se vuelve cuadrática (tope por línea)", () => {
  const t0 = performance.now();
  highRiskDataShapes("a".repeat(200_000) + "@" + "1 ".repeat(100_000));
  highRiskDataShapes("1-".repeat(200_000));
  assert(performance.now() - t0 < 1000);
});

Deno.test("removeDataShapeLines: quita la viñeta ENTERA (sin cirugía) y conserva el resto", () => {
  const r = removeDataShapeLines(
    "## Errores a no repetir\n- Escribe a ventas@x.com para reclamos.\n- Pide el nombre de la mascota.\n## Refuerzos y estilo\n- Llama al 0414-1234567.",
  );
  assertEquals(r.text, "## Errores a no repetir\n- Pide el nombre de la mascota.");
  assertEquals(r.removed, ["Escribe a ventas@x.com para reclamos.", "Llama al 0414-1234567."]);
  const same = "## Errores a no repetir\n- Atiende emergencias 24/7; llama ahora al lead.";
  assertEquals(removeDataShapeLines(same), { text: same, removed: [] });
});

Deno.test("removeDataShapeLines: una línea más larga que lo escaneado sale entera (un dato después del corte no pasa)", async () => {
  const { removeDataShapeLines, MAX_LINE_CHARS } = await import("./dreams-facts.ts");
  const larga = "- " + "a ".repeat(MAX_LINE_CHARS) + "escribe a ventas@x.com";
  const r = removeDataShapeLines(`## Errores a no repetir\n${larga}\n- Pregunta la sede antes de dar horarios.`);
  assertEquals(r.removed.length, 1);
  assert(!r.text.includes("ventas@x.com"));
  assert(r.text.includes("Pregunta la sede antes de dar horarios."));
});

Deno.test("redacción: invisibles en medio de un teléfono o correo no esquivan el filtro (tampoco en la evidencia con fechas)", async () => {
  const { neutralizeBusinessFacts } = await import("./dreams-facts.ts");
  const tel = "Llama al 0414⁠123​4567 para reservar.";
  for (const keepDates of [false, true]) {
    const r = neutralizeBusinessFacts(tel, { keepDates });
    assert(!/\d{4}.?\d{3}.?\d{4}/.test(r.text.replace(/[⁠​]/g, "")), r.text);
    assert(!r.text.includes("1234567"), r.text);
  }
  const ev = neutralizeBusinessFacts("El 2026-10-19 el lead pidió escribir a ven⁠tas@x.com", { keepDates: true });
  assert(ev.text.includes("2026-10-19"), ev.text);
  assert(!ev.text.includes("tas@x.com"), ev.text);
});

// ─── Veterinaria (oct-2026): el corte NO mutila reglas de conducta ───────────
// Textos REALES de dreams activos de Veterinaria (ver también supabase/tests/
// dreams-veterinaria-render.test.ts, que arma el digest con los 51).
const render = (t: string) => agentFacingFacts(neutralizeBusinessFacts(t, { markDropped: true }).text);

Deno.test("Veterinaria: «24/7» es disponibilidad, no una fecha: se reemplaza SOLO el token", () => {
  const t =
    "Cuando un usuario reporta un animal en situación de emergencia, la respuesta debe enfatizar que la sede atiende 24/7 sin espera de horario, con instrucción clara: \"acude ahora mismo\". Esto acelera la acción sin rodeos.";
  const r = neutralizeBusinessFacts(t);
  assertEquals(r.dropped, 0);
  assertStringIncludes(r.text, `la sede atiende ${AVAILABILITY_PLACEHOLDER} sin espera de horario`);
  assertEquals(
    render(t),
    `Cuando un usuario reporta un animal en situación de emergencia, la respuesta debe enfatizar que la sede atiende ${AGENT_AVAILABILITY_PHRASE} sin espera de horario, con instrucción clara: "acude ahora mismo". Esto acelera la acción sin rodeos.`,
  );
  assertEquals(
    render("El agente comunica consistentemente que emergencias se atienden 24/7 al final de bloques de información. Esta estructura funciona bien: horario de consulta → emergencias 24/7 → teléfono. Mantener este orden en futuras respuestas."),
    `El agente comunica consistentemente que emergencias se atienden ${AGENT_AVAILABILITY_PHRASE} al final de bloques de información. Esta estructura funciona bien: horario de consulta → emergencias ${AGENT_AVAILABILITY_PHRASE} → teléfono. Mantener este orden en futuras respuestas.`,
  );
  for (const s of ["Atiende las 24 horas.", "Abierto 24h al día.", "Emergencias 24 horas los 7 días.", "Guardia 24/7/365."]) {
    const out = render(s);
    assertStringIncludes(out, AGENT_AVAILABILITY_PHRASE, s);
    assert(!/\d/.test(out), `${s} → ${out}`);
  }
  // «24 horas» / «24h» sueltos son una duración: no se tocan.
  for (const s of ["Responde en las próximas 24h si el caso no es urgente.", "Indica que el ayuno lo define la sede, nunca digas 24 horas de ayuno.", "Si pasaron más de 24 hrs, deriva."]) {
    assertEquals(neutralizeBusinessFacts(s).text, s, s);
  }
  // y no es un dato de alto riesgo (sigue entrando al digest)
  assertEquals(highRiskDataShapes("- La sede atiende 24/7."), []);
});

Deno.test("Veterinaria: un horario se reescribe como horario («en el horario oficial»), nunca como canal", () => {
  const t =
    "El agente menciona 'oftalmología se atiende lunes a viernes de 8:00 am a 12:00 pm' (Lead#10, Lead#74) pero esta información no aparece en todas las respuestas de oftalmología.";
  assertStringIncludes(neutralizeBusinessFacts(t).text, SCHEDULE_PLACEHOLDER);
  const out = render(t);
  assertEquals(
    out,
    `El agente menciona 'oftalmología se atiende lunes a viernes ${AGENT_SCHEDULE_PHRASE}' (Lead#10, Lead#74) pero esta información no aparece en todas las respuestas de oftalmología.`,
  );
  assert(!out.includes(AGENT_FACT_PHRASE), out);
  assertStringIncludes(render("El agente confirma disponibilidad de oftalmología (lunes-viernes 8am-12pm) pero recibe consultas."), `(lunes-viernes ${AGENT_SCHEDULE_PHRASE})`);
  assertEquals(render("Atienden desde las 9am, pide la sede."), `Atienden ${AGENT_SCHEDULE_PHRASE}, pide la sede.`);
  // Una oración que SOLO afirma el horario no deja una tautología: se quita.
  assertEquals(render("Saluda por el nombre. El horario es de 9 a 6 pm."), "Saluda por el nombre.");
  // Los canales siguen con su frase: correo/teléfono/URL.
  assertEquals(render("Para reclamos remite al correo atencion@x.com."), `Para reclamos remite a ${AGENT_FACT_PHRASE}.`);
});

Deno.test("Veterinaria: una oración que remite a una descartada no queda huérfana", () => {
  for (const s of ["Esto acelera la acción sin rodeos.", "Mantener este orden en futuras respuestas.", "Así evitas incertidumbre.", "De esa forma se evita confusión.", "Esta frontera está bien definida."]) {
    assert(isAnaphoric(s), s);
  }
  for (const s of ["Estaciona en la sede.", "Esther llamó.", "Mantén el tono cálido.", "Asimismo, pide la cédula."]) assert(!isAnaphoric(s), s);
  const r = neutralizeBusinessFacts("Saluda por el nombre. La sede está cerrada por remodelación. Esto evita confusiones. Pide la cédula.");
  assertEquals(r.text, "Saluda por el nombre. Pide la cédula.");
  assertEquals(agentFacingFacts(`- Atiende emergencias ${FACT_PLACEHOLDER}. Esto acelera la acción sin rodeos. Pide la sede.`), "- Pide la sede.");
  // Sin descarte previo, la anáfora se queda.
  const ok = "Responde breve. Esto acelera la acción.";
  assertEquals(render(ok), ok);
});

Deno.test("Veterinaria: el corte en oraciones no parte citas, puntos suspensivos ni abreviaturas", () => {
  const t =
    "Responde con firmeza: 'Sin poder verlo, no puedo recomendar... necesita evaluación presencial inmediata' y proporciona teléfono 24/7. Ver Lead#273 (cachorro sin comer ni pararse).";
  assertEquals(splitSentences(t), [
    "Responde con firmeza: 'Sin poder verlo, no puedo recomendar... necesita evaluación presencial inmediata' y proporciona teléfono 24/7.",
    "Ver Lead#273 (cachorro sin comer ni pararse).",
  ]);
  assertEquals(
    render(t),
    `Responde con firmeza: 'Sin poder verlo, no puedo recomendar... necesita evaluación presencial inmediata' y proporciona teléfono ${AGENT_AVAILABILITY_PHRASE}. Ver Lead#273 (cachorro sin comer ni pararse).`,
  );
  assertEquals(splitSentences("Di «Hola. Te ayudo» y sigue. Luego pide el nombre."), ["Di «Hola. Te ayudo» y sigue.", "Luego pide el nombre."]);
  assertEquals(splitSentences("Espera… y responde. Listo."), ["Espera… y responde.", "Listo."]);
  assertEquals(splitSentences("Confirma (p. ej. Cashea) con la sede. Que el Dr. revise. Fin."), ["Confirma (p. ej. Cashea) con la sede.", "Que el Dr. revise.", "Fin."]);
  // Una comilla suelta no vuelve el renglón entero una sola oración.
  assertEquals(splitSentences("Di 'hola. Pide el nombre. Fin."), ["Di 'hola.", "Pide el nombre.", "Fin."]);
  // apóstrofo dentro de una palabra no es comilla
  assertEquals(splitSentences("Usa O'Higgins. Fin."), ["Usa O'Higgins.", "Fin."]);
});

// Port de Veterinaria 22f216b: una cita que cierra la oración («…de rescates." Derivar…») no la une
// con la siguiente: el corte del marcador se lleva solo la cláusula que lo trae.
Deno.test("agentFacingFacts: una oración que termina en comillas se separa de la siguiente", () => {
  const out = agentFacingFacts(
    `- Sé claro: "Somos una clínica, no una plataforma de rescates." Ofrece atención ${FACT_PLACEHOLDER} si el animal llega.`,
  );
  assertEquals(out, `- Sé claro: "Somos una clínica, no una plataforma de rescates."`);
  assertEquals(agentFacingFacts(`- Responde breve (sin listas). Abre ${FACT_PLACEHOLDER}.`), "- Responde breve (sin listas).");
  // y el texto real: «24/7» ya no se lleva nada
  assertEquals(
    render(`El agente debe ser claro: "Centro Veterinario es una clínica veterinaria, no una plataforma de coordinación de rescates." Derivar a grupos de rescate en general pero ofrecer atención veterinaria 24/7 si el animal llega.`),
    `El agente debe ser claro: "Centro Veterinario es una clínica veterinaria, no una plataforma de coordinación de rescates." Derivar a grupos de rescate en general pero ofrecer atención veterinaria ${AGENT_AVAILABILITY_PHRASE} si el animal llega.`,
  );
});

Deno.test("neutralizeBusinessFacts: el estado tras una cita se descarta sin llevarse la cita", () => {
  const r = neutralizeBusinessFacts(`- Di: "Somos una clínica." La sede está cerrada por remodelación.`);
  assert(r.text.includes(`"Somos una clínica."`), r.text);
  assert(!/remodelaci/i.test(r.text), r.text);
});

Deno.test("Veterinaria: una causa sin estado solo se descarta si habla del negocio", () => {
  const caso =
    "Múltiples leads (#194-195, #248) compartieron casos de animales (perro pitbull, roedor) en La Guaira que sufrieron terremoto y necesitaban atención urgente.";
  assertEquals(neutralizeBusinessFacts(caso).text, caso);
  assertEquals(neutralizeBusinessFacts("La sede Playa Mar sufrió afectación sísmica.").text, "");
});
