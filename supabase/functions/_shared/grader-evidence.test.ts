// _shared/grader-evidence.test.ts
// Correr con: deno test supabase/functions/_shared/grader-evidence.test.ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import {
  CLIP_MARKER,
  clipMiddle,
  EVIDENCE_EVENT_TYPES,
  EVIDENCE_LIMITS,
  evidenceFromEvents,
  fetchSessionEvidence,
  type SessionEventsClient,
} from "./grader-evidence.ts";

const txt = (text: string) => [{ type: "text", text }];

// Forma real de los eventos de una sesión CMA (LAM, oct-2026), reducida.
const EVENTS = [
  { type: "session.status_running" },
  { type: "user.message", content: txt("[CONTEXTO]\nfecha_hora_actual: hoy\n[MENSAJES DEL LEAD]\n<turno rol=\"lead\">¿precio?</turno>") },
  { type: "agent.tool_use", id: "t1", name: "bash", input: { command: "cat /mnt/memory/leads/x/learnings.md" } },
  { type: "agent.custom_tool_use", id: "c1", name: "search_kb", input: { query: "precio plan" } },
  { type: "agent.tool_result", tool_use_id: "t1", is_error: true, content: txt("cat: No such file or directory") },
  { type: "user.custom_tool_result", custom_tool_use_id: "c1", is_error: false, content: txt("### Resultado 1\nPlan Oro USD 120") },
  { type: "agent.tool_use", id: "t2", name: "bash", input: { command: "cat >> learnings.md" } },
  { type: "agent.tool_result", tool_use_id: "t2", is_error: false, content: txt("(no output)") },
  { type: "agent.tool_use", id: "t3", name: "read", input: { file_path: "/mnt/memory/master/kb/precios.md" } },
  { type: "agent.tool_result", tool_use_id: "t3", content: txt("Plan Plata USD 80") },
  { type: "agent.custom_tool_use", id: "c2", name: "mover_etapa", input: { stage_name: "ATENDER" } },
  { type: "user.custom_tool_result", custom_tool_use_id: "c2", content: txt("Listo: moví el lead") },
  { type: "user.message", content: txt("corrección: usá el bloque <respuesta>") },
  { type: "agent.message", content: txt("<respuesta>Cuesta USD 120</respuesta>") },
];

Deno.test("evidenceFromEvents: contexto = primer user.message; herramientas emparejadas, sin errores ni escrituras vacías", () => {
  const ev = evidenceFromEvents(EVENTS);
  assert(ev.context?.startsWith("[CONTEXTO]"));
  assert(!ev.context?.includes("corrección"));
  assertEquals(ev.tools.map((t) => t.name), ["search_kb", "read", "mover_etapa"]);
  assertEquals(ev.tools[0].input, '{"query":"precio plan"}');
  assertEquals(ev.tools[0].result, "### Resultado 1\nPlan Oro USD 120");
  assertEquals(ev.tools[1].result, "Plan Plata USD 80");
  assertEquals(ev.omittedTools, 0);
  assertEquals(ev.contextClipped, false);
});

Deno.test("evidenceFromEvents: eventos raros o sin uso emparejado no rompen", () => {
  const ev = evidenceFromEvents([null, 3, "x", { type: "user.custom_tool_result", custom_tool_use_id: "zz", content: "texto plano" }]);
  assertEquals(ev.context, null);
  assertEquals(ev.tools, [{ name: "herramienta", input: "", result: "texto plano" }]);
});

Deno.test("topes: resultado por herramienta, total de herramientas (cuenta lo omitido) y contexto inicio+final", () => {
  const big = "a".repeat(EVIDENCE_LIMITS.toolResultChars * 3);
  const events: unknown[] = [];
  for (let i = 0; i < 8; i++) {
    events.push({ type: "agent.custom_tool_use", id: `u${i}`, name: "search_kb", input: { query: "q".repeat(1000) } });
    events.push({ type: "user.custom_tool_result", custom_tool_use_id: `u${i}`, content: txt(big) });
  }
  events.unshift({ type: "user.message", content: txt("INICIO" + "x".repeat(50_000) + "FINAL") });
  const ev = evidenceFromEvents(events);
  assert(ev.tools.every((t) => t.result.length <= EVIDENCE_LIMITS.toolResultChars));
  assert(ev.tools.every((t) => t.input.length <= EVIDENCE_LIMITS.toolInputChars));
  const total = ev.tools.reduce((n, t) => n + t.result.length, 0);
  assert(total <= EVIDENCE_LIMITS.toolsTotalChars);
  assertEquals(ev.tools.length + ev.omittedTools, 8);
  assert(ev.omittedTools > 0);
  assert(ev.context!.length <= EVIDENCE_LIMITS.contextChars);
  assert(ev.context!.startsWith("INICIO") && ev.context!.endsWith("FINAL"));
  assert(ev.contextClipped);
  // El inicio (datos del operador: aprendizajes, promociones) recibe la mayor parte.
  const [head, tail] = ev.context!.split(CLIP_MARKER);
  assert(head.length > tail.length * 1.5, `${head.length} vs ${tail.length}`);
});

Deno.test("los topes se miden sobre el texto en NFKC (un carácter que NFKC expande no burla el tope)", () => {
  const ev = evidenceFromEvents([
    { type: "agent.custom_tool_use", id: "u", name: "http_x", input: { q: "\uFDFA".repeat(500) } },
    { type: "user.custom_tool_result", custom_tool_use_id: "u", content: txt("\uFDFA".repeat(2500)) },
  ]);
  assert(ev.tools[0].result.length <= EVIDENCE_LIMITS.toolResultChars);
  assert(ev.tools[0].input.length <= EVIDENCE_LIMITS.toolInputChars);
  assert(!ev.tools[0].result.includes("\uFDFA"), "ya viene en NFKC");
});

Deno.test("clipMiddle no parte grafemas (emoji ZWJ, banderas) ni deja surrogates sueltos", () => {
  const fam = "👨‍👩‍👧‍👦";
  const s = fam.repeat(400) + "🇻🇪".repeat(400);
  const c = clipMiddle(s, 300);
  assert(c.length <= 300);
  assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(c));
  const [head, tail] = c.split(CLIP_MARKER);
  assertEquals(head.replaceAll(fam, ""), "");
  assertEquals(tail.replaceAll("🇻🇪", ""), "");
  assertEquals(clipMiddle("corto", 300), "corto");
});

function fakeClient(events: unknown[], fail = false): SessionEventsClient & { read: number; types?: string[] } {
  const c: SessionEventsClient & { read: number; types?: string[] } = {
    read: 0,
    types: undefined,
    beta: {
      sessions: {
        events: {
          list(_id: string, params?: { types?: string[] }): AsyncIterable<unknown> {
            c.types = params?.types;
            return (async function* () {
              if (fail) throw new Error("503 overloaded");
              for (const e of events) {
                c.read++;
                yield e;
              }
            })();
          },
        },
      },
    },
  };
  return c;
}

Deno.test("fetchSessionEvidence: lee hasta el tope de eventos y propaga el error de la API (no evalúa «sin KB»)", async () => {
  const many = Array.from({ length: EVIDENCE_LIMITS.maxEvents + 50 }, () => ({ type: "span.model_request_start" }));
  const client = fakeClient(many);
  const cut = await fetchSessionEvidence(client, "sesn_x");
  assertEquals(client.read, EVIDENCE_LIMITS.maxEvents + 1);
  assert(cut.truncatedEvents, "el corte por tope se informa");
  // Solo se piden los tipos que aportan evidencia (sin thinking/spans/estados).
  assertEquals(client.types, [...EVIDENCE_EVENT_TYPES]);
  const ev = await fetchSessionEvidence(fakeClient(EVENTS), "sesn_x");
  assertEquals(ev.tools.length, 3);
  assertEquals(ev.truncatedEvents, false);
  await assertRejects(() => fetchSessionEvidence(fakeClient([], true), "sesn_x"), Error, "503");
});
