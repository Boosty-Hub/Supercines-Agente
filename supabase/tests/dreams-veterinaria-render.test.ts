// supabase/tests/dreams-veterinaria-render.test.ts
// Regresión con los dreams REALES de Veterinaria (51 activos, 20-oct-2026; fixture anonimizado:
// sin los UUID de los leads del frontmatter y sin el nombre del especialista).
//
// El armado del digest (renderDigest) mutilaba reglas de conducta: «24/7» caía en el patrón de
// fechas y la oración entera desaparecía, dejando huérfanas las siguientes («Esto acelera la acción
// sin rodeos.», «Mantener este orden en futuras respuestas.»); «de 8:00 am a 12:00 pm» quedaba
// «de los canales oficiales»; una cita con «...» se partía a la mitad. Esta prueba arma el digest
// con todos los dreams y exige:
//  1) ninguna oración de ningún dream se pierde ni se parte: cada viñeta tiene las MISMAS oraciones
//     que su dream, iguales salvo el token del dato reemplazado por su frase natural;
//  2) cada regla de conducta del digest anterior (el que el agente tenía antes del armado
//     determinístico) sigue presente;
//  3) lo que el dream le dice al operador («Gap para el operador: …») no llega al agente.
// Correr con: deno test --allow-read --node-modules-dir=none supabase/tests/dreams-veterinaria-render.test.ts
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { dreamRuleText, renderDigest, splitOperatorAddress } from "../functions/_shared/dreams-digest-render.ts";
import {
  AGENT_AVAILABILITY_PHRASE,
  AGENT_FACT_PHRASE,
  AGENT_SCHEDULE_PHRASE,
  FACT_MARKER_RE,
  splitSentences,
} from "../functions/_shared/dreams-facts.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const dreams: { path: string; content: string }[] = JSON.parse(
  await Deno.readTextFile(new URL("veterinaria-dreams-2026-10-20.json", FIXTURES)),
);
const previousDigest = await Deno.readTextFile(new URL("veterinaria-digest-anterior-2026-10-20.md", FIXTURES));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** La oración de salida, como patrón: las frases naturales valen por el dato que reemplazan. */
function outputPattern(out: string): RegExp {
  let p = escapeRe(out);
  for (const phrase of [AGENT_SCHEDULE_PHRASE, AGENT_AVAILABILITY_PHRASE, AGENT_FACT_PHRASE]) {
    p = p.split(escapeRe(phrase)).join("(?:de |a |en |desde |las )?.{1,60}?");
  }
  // protocolSafeRule pasa los corchetes a paréntesis («[teléfono]» → «(teléfono)»).
  p = p.replace(/\\\(/g, "[\\[(]").replace(/\\\)/g, "[\\])]");
  return new RegExp(`^${p}$`);
}

Deno.test("Veterinaria: ninguna oración de ningún dream se pierde, se parte ni queda huérfana", () => {
  assertEquals(dreams.length, 51);
  for (const d of dreams) {
    const name = d.path.split("/").pop();
    const { rule } = splitOperatorAddress(dreamRuleText(d.content));
    const r = renderDigest([d], "");
    assertEquals(r.notes, [], `${name}: no debe ir a notas de datos`);
    assertEquals(r.bullets, 1, `${name}: una viñeta`);
    const line = r.text.split("\n").find((l) => l.startsWith("- "))!.slice(2);
    const inSentences = splitSentences(rule);
    const outSentences = splitSentences(line);
    assertEquals(outSentences.length, inSentences.length, `${name}:\nIN : ${rule}\nOUT: ${line}`);
    outSentences.forEach((o, i) => {
      assert(outputPattern(o).test(inSentences[i]), `${name} oración ${i + 1}:\nIN : ${inSentences[i]}\nOUT: ${o}`);
    });
    // Nada de lo que dejaba el corte viejo.
    assert(!/de los canales oficiales'|el dato oficial/.test(line), `${name}: ${line}`);
    assert(!FACT_MARKER_RE.test(line), `${name}: marcador en ${line}`);
  }
});

// Cada regla del digest anterior → frase(s) que la sostienen en el digest armado.
const PREVIOUS_RULES: ReadonlyArray<[string, string[]]> = [
  ["No prometas que alguien contactará", ["No prometas que alguien lo contactará"]],
  ["Ante reclamos por negligencia o mala praxis, reconoce la gravedad", ["reconocer la gravedad con empatía, sin defenderse ni minimizar"]],
  ["Ante reclamos clínicos no admitas culpa", ["sin validar responsabilidad ni prometer escalamientos"]],
  ["Nunca ofrezcas WhatsApp, Instagram ni este chat", ["nunca ofrezcas escribir por WhatsApp, Instagram ni este chat"]],
  ["No des diagnósticos ni orientaciones clínicas", ["sin recomendar medicamentos ni dar diagnósticos"]],
  ["No recomiendes, mantengas ni cambies medicación", ["sugirió o validó tratamientos"]],
  ["No confirmes procedimientos antes de la evaluación presencial", ["Debe limitarse a derivar a evaluación presencial"]],
  ["Ante síntomas graves deriva de inmediato a emergencias", ["dirigir INMEDIATAMENTE a emergencias", "NO debe normalizar el síntoma"]],
  ["Ante posible envenenamiento o agua de extraños", ["salivación anormal tras agua de extraños"]],
  ["Ante emergencia con síntomas, evaluación presencial inmediata", ["necesita evaluación presencial inmediata"]],
  ["No des precios en rangos", ["nunca des rangos aproximados"]],
  ["No fijes precios de consulta de memoria", ["sin fijar una cifra de memoria"]],
  ["Antes de cotizar cirugías pide especie, sexo y peso", ["sin especificar especie, sexo o peso"]],
  ["No afirmes métodos de pago (Cashea)", ["acepta Cashea u otros métodos de pago"]],
  ["No inventes planes de pago en cuotas", ["planes de pago en cuotas"]],
  ["No prometas envío de exámenes", ["No prometer envíos que no puede cumplir"]],
  ["No des horas de ayuno ni de agua", ["nunca des horas de ayuno ni de agua inventadas"]],
  ["No afirmes el estado, paradero ni cuidados de Draco", ["SIN afirmar el estado de salud, el paradero ni quién lo cuida"]],
  ["No nombres organizaciones de rescate", ["no nombres ninguna"]],
  ["No inventes procesos de adopción", ["no inventes un proceso de adopción"]],
  ["No afirmes disponibilidad de especialistas", ["qué especialidades están disponibles en cada sede"]],
  ["No des horarios de oftalmología sin tomarlos de tu fuente oficial", [`oftalmología se atiende lunes a viernes ${AGENT_SCHEDULE_PHRASE}`]],
  ["No afirmes que un servicio existe en una sede sin confirmarlo", ["matriz clara de servicios por ubicación"]],
  ["No digas que Instagram bloquea", ["Nunca digas que Instagram bloquea"]],
  ["Publicación sin texto: pregúntale con naturalidad", ["pregúntale con naturalidad en qué puedes ayudarle", "No repitas la misma respuesta"]],
  ["No prometas consultas online", ["consultas virtuales"]],
  ["No guardes silencio ante emoción genuina", ["si hay sustancia emocional genuina, responder"]],
  ["Silencio solo ante emojis o bendiciones genéricas", ["si es solo emojis/bendiciones genéricas sin contexto, silencio es correcto"]],
  ["Audios largos: resume y recomienda evaluación presencial", ["resuma comprensión y próximos pasos"]],
  ["Insistencia en cita: orden de llegada, sin cita/turno/hora", ["nunca 'hora aproximada', 'cita' ni 'turno'"]],
  ["Spam o marcas: breve, no es el canal", ["Llegaste a un canal equivocado"]],
  ["No coordines rescates ni prometas transporte", ["no pueden transportar a Caracas"]],
  ["Rescates de emergencia (sismo, La Guaira): tono urgente y llamada inmediata", ["El tono debe ser más directo y urgente", "la necesidad de llamada inmediata"]],
  ["No confirmes stock de medicamentos", ["sin confirmar disponibilidad"]],
  ["No mezcles rescate con soporte técnico", ["es diferente de soporte técnico"]],
  ["No inventes comunicaciones previas ni datos", ["no inventes"]],
  ["Gratitud emocional: frases cortas y auténticas", ["frases cortas, auténticas y empáticas sin exagerar"]],
  ["Cierra bloques en orden: horario, emergencias, teléfono", [`horario de consulta → emergencias ${AGENT_AVAILABILITY_PHRASE} → teléfono. Mantener este orden en futuras respuestas.`]],
  ["Pago en bolívares a la tasa BCV del euro del día", ["El pago se realiza en bolívares a la tasa BCV del euro del día"]],
  ["Limitación económica: no hay capacidad para asumir más casos", ["no contamos con capacidad económica ni logística para asumir más casos"]],
  ["Delimita el rol: clínica, solo perros y gatos", ["Centro Veterinario atiende SOLO perros y gatos"]],
  ["Fauna silvestre: deriva fuera de la clínica", ["deriva fuera de la clínica"]],
  ["Exóticos: mismo script", ["para exóticos te recomiendo buscar un veterinario especializado"]],
  ["Coordinación flexible de horarios ante síntomas complejos", ["coordinación flexible"]],
  ["Reconoce la continuidad del mismo cliente", ["reconocimiento inicial"]],
  ["Tono cálido en contextos humanitarios y donaciones", ["Mantener esta voz en contextos humanitarios"]],
  ["Adopción o rescate: límite y atención si el animal llega", [`ofrecer atención veterinaria ${AGENT_AVAILABILITY_PHRASE} si el animal llega`]],
  ["Emergencias 24/7: «acude ahora» o «llama» (y por qué)", [`la sede atiende ${AGENT_AVAILABILITY_PHRASE} sin espera de horario`, "Esto acelera la acción sin rodeos."]],
];

Deno.test("Veterinaria: cada regla de conducta del digest anterior sigue en el digest armado", () => {
  const r = renderDigest(dreams, "");
  // El digest anterior tenía 47 reglas (36 + 11); todas están mapeadas arriba (más la de 24/7,
  // que el digest anterior había resumido dentro de «emergencias según fuente»).
  const prevBullets = previousDigest.split("\n").filter((l) => l.startsWith("- ")).length;
  assertEquals(prevBullets, 47);
  assert(PREVIOUS_RULES.length >= prevBullets);
  for (const [rule, phrases] of PREVIOUS_RULES) {
    for (const p of phrases) assert(r.text.includes(p), `falta «${rule}»: no aparece «${p}»`);
  }
  assertEquals(r.bullets, 51);
  assertEquals(r.notes, []);
  // (El digest nombra search_kb a propósito; lo que no puede traer es un marcador de dato.)
  assert(!FACT_MARKER_RE.test(r.text), "sin marcadores de dato");
});

Deno.test("Veterinaria: «Gap para el operador» va a las notas del operador, no al agente", () => {
  const r = renderDigest(dreams, "");
  assert(!/para el operador/i.test(r.text), "el digest no le habla al operador");
  assertEquals(r.operatorNotes.length, 1);
  assert(r.operatorNotes[0].includes("cargar en la KB las indicaciones de ayuno reales"), r.operatorNotes[0]);
  // La regla de conducta del mismo dream sigue entera.
  assert(r.text.includes("Indica que las indicaciones previas a la cirugía o sedación las da la sede"));
});
