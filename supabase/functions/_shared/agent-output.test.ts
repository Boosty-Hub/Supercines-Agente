// Decisión sobre la salida del agente (_shared/agent-output.ts). Los casos base salen de
// sesiones reales de SuperCines (oct-2026) que terminaban en «agent devolvió respuesta
// vacía»: el agente obedecía «solo emojis → no respondas» y no había forma de decirlo.
// Los adversariales cubren el «parser differential» de la revisión de seguridad: la
// decisión y la extracción salen de UN parse, y el texto de una respuesta siempre está
// adentro de un bloque <respuesta> del input (nunca el crudo).
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  AgentTranscript,
  type AgentDecision,
  decideAgentOutput,
  emptyOutputCorrectionMessage,
  hasProtocolMarkers,
  NO_REPLY_INSTRUCTION,
  NO_REPLY_REASON_MAX,
} from "./agent-output.ts";
import { leakCorrectionMessage } from "./response-guard.ts";

const INTERNAL = "ANÁLISIS INTERNO: el lead es spam, leí learnings.md";

/** Contenidos de bloques <respuesta> cerrados (parse independiente, solo para la propiedad). */
function replyContents(s: string): string[] {
  return [...s.matchAll(/<\s*respuesta\s*>([\s\S]*?)<\s*\/\s*respuesta\s*>/gi)].map((m) => m[1]);
}

/** Propiedad: el texto expuesto (reply.text o malformed.rescue) nunca sale de afuera de un bloque. */
function assertNoOutsideText(input: string, d: AgentDecision) {
  const exposed = d.kind === "reply" ? d.text : d.kind === "malformed" ? d.rescue : null;
  if (exposed === null || exposed === "") return;
  const openOnly = /<\s*respuesta\s*>([\s\S]*)$/i.exec(input)?.[1] ?? "";
  const param = /name\s*=\s*"respuesta"\s*>([\s\S]*?)(?:<\s*\/\s*parameter\s*>|$)/i.exec(input)?.[1] ?? "";
  const pool = [...replyContents(input), openOnly, param];
  assert(pool.some((c) => c.includes(exposed)), `texto fuera de un bloque <respuesta>: ${JSON.stringify(exposed)}`);
  assert(!exposed.includes(INTERNAL) || pool.some((c) => c.includes(INTERNAL)), "se filtró razonamiento interno");
}

type Case = [name: string, input: string, kind: AgentDecision["kind"], extra?: Partial<Record<string, unknown>>];

const CASES: Case[] = [
  // ---- casos reales / base ----
  ["bloque vacío (real)", "<respuesta>\n</respuesta>", "empty"],
  ["vacío", "", "empty"],
  ["solo espacios", "  \n ", "empty"],
  ["respuesta normal", "razono...\n<respuesta>Hola, ¿cómo estás?</respuesta>", "reply", { text: "Hola, ¿cómo estás?" }],
  ["sin_respuesta con motivo", `${INTERNAL}\n<sin_respuesta>solo emojis 😂</sin_respuesta>`, "no_reply", { reason: "solo emojis 😂" }],
  ["sin_respuesta autocerrada", "<sin_respuesta/>", "no_reply", { reason: "sin motivo indicado" }],
  ["sin_respuesta + respuesta vacía", "<respuesta></respuesta>\n<sin_respuesta>reacción</sin_respuesta>", "no_reply", { reason: "reacción" }],
  ["análisis sin bloque (real previo)", "**Decisión:** No responder. El mensaje es solo emojis.", "malformed", { rescue: null }],
  // ---- adversariales ----
  ["<respuesta> DENTRO del motivo (fuga reportada)", `${INTERNAL}\n<sin_respuesta>no uso <respuesta> porque es spam</sin_respuesta>`, "malformed", { rescue: null }],
  ["</respuesta> dentro del motivo", `${INTERNAL}<sin_respuesta>x </respuesta> y</sin_respuesta>`, "malformed", { rescue: null }],
  ["bloque completo dentro del motivo", `${INTERNAL}<sin_respuesta>a <respuesta>hola</respuesta> b</sin_respuesta>`, "malformed", { rescue: null }],
  ["sin_respuesta dentro de respuesta", "<respuesta>Hola <sin_respuesta>x</sin_respuesta></respuesta>", "malformed", { rescue: null }],
  ["respuesta anidada", "<respuesta>a<respuesta>b</respuesta>c</respuesta>", "malformed"],
  ["dos sin_respuesta: se consumen ambos", "<sin_respuesta>uno</sin_respuesta> texto <sin_respuesta>dos</sin_respuesta>", "no_reply", { reason: "uno · dos" }],
  ["dos respuestas con contenido", "<respuesta>borrador</respuesta>\n<respuesta>final</respuesta>", "malformed", { rescue: "final" }],
  ["ambas con contenido", "<respuesta>Hola!</respuesta><sin_respuesta>emoji</sin_respuesta>", "malformed", { rescue: "Hola!" }],
  ["mayúsculas y espacios en las etiquetas", "< RESPUESTA >Hola</ respuesta >", "reply", { text: "Hola" }],
  ["SIN_RESPUESTA en mayúsculas", "<SIN_RESPUESTA>  spam \n repetido </SIN_RESPUESTA>", "no_reply", { reason: "spam repetido" }],
  ["shape name=respuesta", `${INTERNAL}<parameter name="respuesta">Hola cliente</parameter>`, "malformed", { rescue: "Hola cliente" }],
  ["shape name=respuesta sin cerrar", `${INTERNAL}<parameter name="respuesta">Hola`, "malformed", { rescue: "Hola" }],
  ["respuesta sin cerrar", `${INTERNAL}<respuesta>Hola cliente`, "malformed", { rescue: "Hola cliente" }],
  ["sin_respuesta sin cerrar", `${INTERNAL}<sin_respuesta>spam`, "malformed", { rescue: null }],
  ["cierre sin apertura", `${INTERNAL}</respuesta>`, "malformed", { rescue: null }],
  ["cierre cruzado", "<respuesta>hola</sin_respuesta>", "malformed", { rescue: null }],
  ["texto después del bloque no se expone", `<respuesta>Hola</respuesta>\n${INTERNAL}`, "reply", { text: "Hola" }],
  ["fullwidth ＜respuesta＞", `${INTERNAL}＜respuesta＞Hola＜/respuesta＞`, "malformed", { rescue: null }],
  ["fullwidth dentro de un bloque válido", "<respuesta>Hola ＜sin_respuesta＞</respuesta>", "malformed", { rescue: null }],
  ["etiqueta inválida </respuesta/>", "<respuesta>a</respuesta/>", "malformed"],
];

for (const [name, input, kind, extra] of CASES) {
  Deno.test(`decideAgentOutput: ${name}`, () => {
    const d = decideAgentOutput(input);
    assertEquals(d.kind, kind, JSON.stringify(d));
    for (const [k, v] of Object.entries(extra ?? {})) assertEquals((d as Record<string, unknown>)[k], v, k);
    assertNoOutsideText(input, d);
  });
}

Deno.test("propiedad (fuzz): lo expuesto siempre sale de adentro de un bloque <respuesta>", () => {
  const parts = [
    "<respuesta>", "</respuesta>", "<sin_respuesta>", "</sin_respuesta>", "<sin_respuesta/>", "< Respuesta >",
    '<parameter name="respuesta">', "</parameter>", "＜respuesta＞", INTERNAL, "Hola cliente", " ", "\n", "😂",
  ];
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let i = 0; i < 4000; i++) {
    let s = "";
    for (let j = rnd(8); j >= 0; j--) s += parts[rnd(parts.length)];
    const d = decideAgentOutput(s);
    assertNoOutsideText(s, d);
    if (d.kind === "reply") assert(replyContents(s).some((c) => c.trim() === d.text), s);
  }
});

Deno.test("el motivo se acota", () => {
  const d = decideAgentOutput(`<sin_respuesta>${"x".repeat(1000)}</sin_respuesta>`);
  assert(d.kind === "no_reply" && d.reason.length === NO_REPLY_REASON_MAX);
});

Deno.test("AgentTranscript usa el MISMO parser: gana el último mensaje con marcas", () => {
  const t = new AgentTranscript();
  t.addMessage([{ type: "text", text: "Voy a revisar la memoria." }]);
  t.addMessage([{ type: "text", text: "<respuesta>Hola!</respuesta>" }]);
  t.addMessage([{ type: "text", text: "Listo, actualicé learnings.md." }]);
  assertEquals(t.text, "<respuesta>Hola!</respuesta>");
  // Lookalikes y el shape name="respuesta" cuentan como marcas (no se pierden detrás de un «Listo.»).
  for (const tagged of ["＜respuesta＞x", '<parameter name="respuesta">x']) {
    assert(hasProtocolMarkers(tagged), tagged);
  }
  assert(!hasProtocolMarkers("hola, la respuesta es sí"));
});

Deno.test("AgentTranscript: sin marcas usa el último; startTurn descarta el turno viejo", () => {
  const t = new AgentTranscript();
  t.addMessage([{ type: "thinking" }, { type: "text", text: "a" }, { type: "text", text: "b" }]);
  t.addMessage([{ type: "text", text: "último" }]);
  assertEquals(t.text, "último");
  t.addMessage([{ type: "text", text: "<respuesta>\n</respuesta>" }]);
  t.startTurn();
  assertEquals(t.text, "");
  t.addMessage([{ type: "text", text: "<sin_respuesta>emoji</sin_respuesta>" }]);
  assertEquals(decideAgentOutput(t.text), { kind: "no_reply", reason: "emoji" });
  t.addMessage(null);
  assertEquals(t.text, "<sin_respuesta>emoji</sin_respuesta>");
});

Deno.test("las correcciones ofrecen las dos salidas y van en tuteo (sin voseo)", () => {
  const empty = emptyOutputCorrectionMessage();
  assert(empty.includes("<respuesta>") && empty.includes("<sin_respuesta>"));
  assert(leakCorrectionMessage("x", { allowNoReply: true }).includes("<sin_respuesta>"));
  assert(!leakCorrectionMessage("x").includes("<sin_respuesta>"));
  const VOSEO = /\b(terminá|elegí|escribí|usá|evaluá|compará|respondé|devolvé|tenés|podés|querés)\b/i;
  for (const s of [empty, NO_REPLY_INSTRUCTION, leakCorrectionMessage("x", { allowNoReply: true })]) {
    assert(!VOSEO.test(s), s);
  }
});

Deno.test("generate-response usa el protocolo: contexto, skipped, session_id y verificador final", async () => {
  const src = await Deno.readTextFile(new URL("../generate-response/index.ts", import.meta.url));
  assert(src.includes("${NO_REPLY_INSTRUCTION}"), "el [CONTEXTO] debe explicar <sin_respuesta>");
  assert(/status:\s*"skipped"/.test(src), "la no-respuesta a propósito queda skipped");
  assert(/session_id:\s*failedSession/.test(src), "un draft failed guarda el session_id");
  assert(!src.includes("extractResponseBlock("), "la extracción final usa el mismo parser que la decisión");
  assert(/leakOf\(clean\)/.test(src), "el texto final pasa por el verificador de fuga (leakOf)");
  // La no-respuesta explícita se decide ANTES de leakOf (la red propia de SuperCines).
  const decide = src.indexOf("decideAgentOutput(transcript.text)");
  const noReplyBreak = src.indexOf('decision.kind === "no_reply"');
  const leak = src.indexOf("leakOf(decision.text)");
  assert(decide > 0 && noReplyBreak > decide && leak > noReplyBreak, "<sin_respuesta> se decide antes de leakOf");
});

Deno.test("la migración del CHECK incluye skipped", async () => {
  const dir = new URL("../../migrations/", import.meta.url);
  let last = "";
  const files = [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = await Deno.readTextFile(new URL(f, dir));
    for (const m of sql.matchAll(/add constraint drafts_status_check\s+check \(status in \(([^)]*)\)\)/gi)) last = m[1];
  }
  assert(last.includes("'skipped'"), "drafts_status_check debe aceptar 'skipped'");
});
