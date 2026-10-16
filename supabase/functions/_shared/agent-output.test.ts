// Decisión sobre la salida del agente (_shared/agent-output.ts). Los casos salen de
// sesiones reales de SuperCines (oct-2026) que terminaban en «agent devolvió respuesta
// vacía»: el agente obedecía «solo emojis → no respondas» y no había forma de decirlo.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  AgentTranscript,
  decideAgentOutput,
  emptyOutputCorrectionMessage,
  NO_REPLY_INSTRUCTION,
  NO_REPLY_REASON_MAX,
} from "./agent-output.ts";
import { leakCorrectionMessage } from "./response-guard.ts";

Deno.test("bloque <respuesta> vacío (caso real) = sin decisión, no una respuesta", () => {
  assertEquals(decideAgentOutput("<respuesta>\n</respuesta>"), { kind: "empty" });
  assertEquals(decideAgentOutput(""), { kind: "empty" });
  assertEquals(decideAgentOutput(null), { kind: "empty" });
  assertEquals(decideAgentOutput("   "), { kind: "empty" });
});

Deno.test("<sin_respuesta> = decisión explícita de no responder, con motivo", () => {
  const d = decideAgentOutput(
    "El lead mandó solo emojis; la regla del operador dice no responder.\n<sin_respuesta>solo emojis 😂</sin_respuesta>",
  );
  assertEquals(d, { kind: "no_reply", reason: "solo emojis 😂" });
  assertEquals(decideAgentOutput("<sin_respuesta/>"), { kind: "no_reply", reason: "sin motivo indicado" });
  assertEquals(decideAgentOutput("<SIN_RESPUESTA>  spam \n repetido </SIN_RESPUESTA>"), {
    kind: "no_reply",
    reason: "spam repetido",
  });
});

Deno.test("<sin_respuesta> junto a un <respuesta> vacío sigue siendo no responder", () => {
  assertEquals(decideAgentOutput("<respuesta></respuesta>\n<sin_respuesta>reacción</sin_respuesta>"), {
    kind: "no_reply",
    reason: "reacción",
  });
});

Deno.test("respuesta Y sin_respuesta con contenido = ambiguo, nunca auto-enviable", () => {
  const d = decideAgentOutput("<respuesta>Hola!</respuesta><sin_respuesta>emoji</sin_respuesta>");
  assertEquals(d, { kind: "reply", text: "Hola!", wellFormed: false, ambiguous: true });
});

Deno.test("respuesta normal y malformada siguen como antes", () => {
  assertEquals(decideAgentOutput("razono...\n<respuesta>Hola, ¿cómo estás?</respuesta>"), {
    kind: "reply",
    text: "Hola, ¿cómo estás?",
    wellFormed: true,
    ambiguous: false,
  });
  // Análisis «no respondo» sin bloque (forma real previa): texto malformado → el
  // verificador reprocesa ofreciendo <sin_respuesta>; jamás se envía tal cual.
  const d = decideAgentOutput("**Decisión:** No responder. El mensaje es solo emojis.");
  assertEquals(d.kind, "reply");
  assert(d.kind === "reply" && d.wellFormed === false);
});

Deno.test("el motivo se acota", () => {
  const d = decideAgentOutput(`<sin_respuesta>${"x".repeat(1000)}</sin_respuesta>`);
  assert(d.kind === "no_reply" && d.reason.length === NO_REPLY_REASON_MAX);
});

Deno.test("AgentTranscript: el bloque no se pierde si después viene un mensaje sin marcas", () => {
  const t = new AgentTranscript();
  t.addMessage([{ type: "text", text: "Voy a revisar la memoria." }]);
  t.addMessage([{ type: "text", text: "<respuesta>Hola!</respuesta>" }]);
  t.addMessage([{ type: "text", text: "Listo, actualicé learnings.md." }]);
  assertEquals(t.text, "<respuesta>Hola!</respuesta>");
});

Deno.test("AgentTranscript: sin marcas usa el último mensaje; startTurn descarta el turno viejo", () => {
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

Deno.test("las correcciones ofrecen las dos salidas del protocolo", () => {
  const empty = emptyOutputCorrectionMessage();
  assert(empty.includes("<respuesta>") && empty.includes("<sin_respuesta>"));
  assert(leakCorrectionMessage("x", { allowNoReply: true }).includes("<sin_respuesta>"));
  // Con una respuesta bien formada pero con fuga NO se ofrece la salida (no es una duda
  // sobre responder, es un texto que hay que limpiar).
  assert(!leakCorrectionMessage("x").includes("<sin_respuesta>"));
  assert(NO_REPLY_INSTRUCTION.includes("<sin_respuesta>"));
});

Deno.test("generate-response usa el protocolo: contexto, skipped y session_id en fallas", async () => {
  const src = await Deno.readTextFile(new URL("../generate-response/index.ts", import.meta.url));
  assert(src.includes("${NO_REPLY_INSTRUCTION}"), "el [CONTEXTO] debe explicar <sin_respuesta>");
  assert(/status:\s*"skipped"/.test(src), "la no-respuesta a propósito queda skipped");
  assert(/session_id:\s*failedSession/.test(src), "un draft failed guarda el session_id");
  assert(!/responseText = "";\s*for \(const block of ev\.content/.test(src), "no volver a quedarse solo con el último mensaje");
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
