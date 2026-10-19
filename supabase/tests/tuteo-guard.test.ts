// supabase/tests/tuteo-guard.test.ts
// GUARDIA: todo texto que viaja al MODELO o al cliente final va en tuteo neutro
// (los clientes son venezolanos y los prompts de los operadores piden tuteo). El
// voseo rioplatense («Ejecutá», «Leé», «tenés», «vos»…) en el scaffold
// contradecía al prompt del operador. Texto del PANEL dirigido al operador
// (errores de UI, alertas, avisos) queda fuera: está en las listas OPERATOR_OK.
// Correr con: deno test --allow-read --node-modules-dir=none supabase/tests/tuteo-guard.test.ts
import { assertEquals } from "jsr:@std/assert@^1.0.0";

const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname);

// Archivos cuyo texto va al modelo (prompts, avisos, resultados de tools, mensajes de corrección).
const FILES = [
  "agent/system-prompt.example.md",
  "web/src/lib/agent-prompt.ts",
  "web/src/lib/crm-context.ts",
  "web/src/lib/dashboard-ai.ts",
  "supabase/functions/_shared/crm-etapa.ts",
  "supabase/functions/_shared/memory-instructions.ts",
  "supabase/functions/_shared/untrusted.ts",
  "supabase/functions/_shared/grader-prompt.ts",
  "supabase/functions/_shared/agent-output.ts",
  "supabase/functions/_shared/dreams-digest-block.ts",
  "supabase/functions/_shared/dreams-consolidation.ts",
  "supabase/functions/_shared/response-guard.ts",
  "supabase/functions/_shared/outbound.ts",
  "supabase/functions/_shared/history.ts",
  "supabase/functions/_shared/llm.ts",
  "supabase/functions/generate-response/index.ts",
  "supabase/functions/follow-up-scan/index.ts",
  "supabase/functions/process-inbound/index.ts",
  "supabase/functions/dreams-run/index.ts",
  "supabase/functions/evaluate-outcomes/index.ts",
  "web/src/app/api/setup/generate-agent/route.ts",
  "web/src/app/api/setup/suggest-verticals/route.ts",
  "web/src/app/api/setup/suggest-identity/route.ts",
  "web/src/app/api/setup/plan-edit/route.ts",
  "web/src/app/api/setup/memory/route.ts",
  "web/src/app/api/filters/generate/route.ts",
  "web/src/app/api/graders/generate/route.ts",
  "web/src/app/api/verticales/generate/route.ts",
  "web/src/app/api/follow-up/templates/generate/route.ts",
];

// Frases dirigidas al OPERADOR (UI / alertas), no al modelo ni al cliente: se ignoran.
// Clave = archivo; valor = fragmentos exactos.
const OPERATOR_OK: Record<string, string[]> = {
  // Contraejemplo explícito dentro del prompt de ejemplo: «nunca vos/tenés/decís».
  "agent/system-prompt.example.md": ["nunca vos/tenés/decís"],
  // Alertas y errores que lee el operador en el panel (el panel habla en voseo).
  "supabase/functions/follow-up-scan/index.ts": [
    "Revisá si le llegó un seguimiento automático",
    "Revisá la conversación en Kommo y, si no le llegó, ",
    "Revisá la plantilla y las instrucciones del seguimiento.",
  ],
  "supabase/functions/generate-response/index.ts": ["Revisá el comentario y respondé a mano si corresponde."],
  "web/src/lib/dashboard-ai.ts": ["Probá con un pedido más acotado.", "Reformulá el pedido."],
  "web/src/app/api/setup/memory/route.ts": ["completá el paso de credenciales primero"],
  "web/src/app/api/setup/suggest-verticals/route.ts": ["Configurá primero la API key", "Creá primero el agente"],
  "web/src/app/api/setup/plan-edit/route.ts": ["Configurá primero la API key"],
  "web/src/app/api/setup/suggest-identity/route.ts": ["Configurá primero la API key"],
  "web/src/app/api/filters/generate/route.ts": ["Describí qué no querés que responda el agente.", "Configurá primero la API key"],
  "web/src/app/api/graders/generate/route.ts": ["Describí qué querés medir con este grader.", "Configurá primero la API key"],
  "web/src/app/api/verticales/generate/route.ts": ["Describí qué vertical querés crear.", "Configurá primero la API key"],
  "web/src/app/api/follow-up/templates/generate/route.ts": [
    "Describí qué plantilla de seguimiento querés crear.",
    "Configurá primero la API key",
  ],
};

// Formas de voseo. Verbos con acento final (imperativo voseante) a partir de una lista
// curada de raíces: así NO chocan «está», «así», «será», «podrá» ni los pretéritos
// de 1ª persona («registré», «dejé»).
const STEMS_A = [
  "ejecut", "us", "escal", "registr", "agreg", "notific", "continu", "actu", "habl", "avis", "cerr", "ignor",
  "list", "revis", "configur", "recarg", "conserv", "termin", "gener", "complet", "aplic", "verific", "reintent",
  "peg", "pas", "esper", "declar", "prob", "empez", "refin", "redeploy", "recort", "puntu", "preserv", "notific",
  "marc", "invit", "incorpor", "guard", "etiquet", "desactiv", "cre", "corr", "baj", "aprob", "and", "reformul",
  "redact", "quit", "pulsa", "prioriz", "fusion", "evalu", "especific", "descart", "clasific", "cit", "activ",
  "indic", "dej", "mand", "busc", "toma", "intent", "cont", "mir", "llam", "pregunt", "respet", "trat", "evit",
  "asegur", "document", "analiz", "inform", "mostr", "explic", "aclar", "trabaj", "corrig", "copi", "compar",
  "valid", "mencion", "confirm", "consult", "borr", "actualiz", "cambi", "elimin", "ofrec", "adapt", "ajust",
  "calcul", "defin", "determin", "devolv", "detect", "dirig", "enfoc", "extra", "filtr", "interpret", "limit",
  "manej", "nombr", "organiz", "program", "propon", "rellen", "repas", "salud", "segu", "sintetiz", "tom",
  "transcrib", "tradu", "utiliz", "vuelc", "ayud", "acept", "rechaz", "apunt", "sugi", "fij", "olvid", "cuid",
  "contest", "contact", "escrib", "añad",
];
const STEMS_E = [
  "le", "respond", "volv", "ten", "pon", "manten", "devolv", "resolv", "reconoc", "agradec", "extra",
  "hac", "propon", "ofrec", "entend", "com", "recib", "sab", "prefer", "ve", "ced", "defend", "escond", "ejerc",
  "obedec", "cumpl", "convenc", "met", "ofend", "aprend", "suspend", "vend", "respet", "cre", "conoc", "mant",
];
const STEMS_I = [
  "escrib", "describ", "eleg", "decid", "segu", "resum", "omit", "inclu", "instru", "cubr", "sub", "mov",
  "convert", "constru", "asum", "decir", "dec", "sobrescrib", "reescrib", "transcrib", "repet", "ped", "ven",
  "sal", "permit", "recib", "abr", "sent", "cumpl", "aplic", "infer", "añad", "medi", "elig", "dividi",
  "compart", "divid", "unifi", "sumi", "combin", "mostr",
];
const CLITIC = "(?:lo|la|le|los|las|me|te|nos)?";
const ACCENT_FORMS = [
  `(?:${STEMS_A.join("|")})á`,
  `(?:${STEMS_E.join("|")})é`,
  `(?:${STEMS_I.join("|")})í`,
].map((p) => `${p}${CLITIC}`);

// Pronombres/verbos conjugados al voseo + «acá» (usar «aquí»).
const FIXED = [
  "vos", "sos", "acá", "tenés", "podés", "querés", "sabés", "hablás", "decís", "hacés", "venís", "mirás", "pensás",
  "necesitás", "entendés", "tomás", "usás", "ponés", "sentís", "escribís", "elegís", "decidís", "seguís", "pedís",
  "salís", "vivís", "andás", "cerrás", "mandás", "pasás", "buscás", "esperás", "trabajás", "llamás", "guardás",
  "dejás", "respondés", "leés", "creés", "traés", "conocés", "ofrecés", "permitís", "recibís", "compartís",
  "debés", "encontrás", "volvés", "sentís", "agregalo", "agregalas", "aplicalas", "mencionalas", "buscalo", "guardalo", "movelos", "Construila", "nombrala", "dejalas", "borralo", "reescribilo", "decilo", "fijate", "acordate", "referite", "decime", "decile", "avisale", "mandale", "contale", "movelo", "tené",
];
// Presente indicativo voseante: «evaluás», «consolidás», «construís». Se excluyen el futuro de
// 2ª persona del tuteo («podrás») y los sustantivos/adverbios en -ás/-ís.
const GENERIC_AS_IS = "[\\p{L}]{3,}(?:ás|ís)";
const NOT_VOSEO = new Set([
  "más", "estás", "además", "jamás", "atrás", "detrás", "demás", "país", "anís", "gratís", "compás", "cafés", "adiós",
]);
const VOSEO = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${ACCENT_FORMS.join("|")}|${FIXED.join("|")}|${GENERIC_AS_IS})(?![\\p{L}\\p{N}_])`,
  "giu",
);

function scan(text: string): string[] {
  const hits: string[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    // «\nUsá» dentro de un literal: la \n escapada no es parte de la palabra.
    for (const m of line.replaceAll("\\n", " ").matchAll(VOSEO)) {
      const w = m[0].toLowerCase();
      if (NOT_VOSEO.has(w) || (/rás$/.test(w) && !FIXED.includes(w))) continue;
      hits.push(`L${i + 1}: «${m[0]}» en «${line.trim().slice(0, 120)}»`);
    }
  });
  return hits;
}

Deno.test("GUARDIA: el texto al modelo y al cliente va en tuteo, sin voseo", async () => {
  const problems: string[] = [];
  for (const f of FILES) {
    let text = await Deno.readTextFile(ROOT + f);
    for (const ok of OPERATOR_OK[f] ?? []) text = text.split(ok).join("");
    for (const h of scan(text)) problems.push(`${f} ${h}`);
  }
  assertEquals(problems, [], "Voseo en texto al modelo/cliente (usar tuteo neutro):\n" + problems.join("\n"));
});

Deno.test("GUARDIA: el detector reconoce voseo y deja pasar tuteo y futuros", () => {
  for (const s of ["Ejecutá esto", "\\nUsá la tool", "proponé", "debés", "encontrás", "leé el archivo", "usá la tool", "tenés que", "podés", "vos sos", "escalá", "Mantené", "acá", "agregalo y notificá"]) {
    if (scan(s).length === 0) throw new Error(`no detectó voseo en: ${s}`);
  }
  for (const s of ["Ejecuta esto", "lee el archivo", "usa la tool", "tienes que", "puedes", "tú eres", "escala", "Mantén", "aquí", "agrégalo y notifica",
    "está así más también aquí allí será podrá dirá habrá aplicará seguirá registré dejé guardé pasé", "qué sí caché"]) {
    assertEquals(scan(s), [], s);
  }
});
