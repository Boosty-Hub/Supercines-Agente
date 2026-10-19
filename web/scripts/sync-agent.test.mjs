// Tests de scripts/sync-agent.mjs con Supabase y Anthropic FALSOS (globalThis.fetch).
import test from "node:test";
import assert from "node:assert/strict";
import { EXIT, main, parseArgs } from "./sync-agent.mjs";
import { composeSyncPayload } from "../src/lib/agent-sync-core.ts";
import { hashPrompt } from "../src/lib/agent-prompt-sync.ts";
import { scaffoldHash } from "../src/lib/agent-prompt.ts";

const KEY = "eyJ-service-role-SECRETA-0123456789";
const URL_ = "https://abc.supabase.co";
const ARGV = ["--supabase-url", URL_, "--service-role-key-env", "K"];
const ENV = { K: KEY };

function makeWorld({ liveSystem, liveVersion = 5, config = {}, model = { id: "claude-haiku-5-5", effort: "medium" } } = {}) {
  const cfg = { ANTHROPIC_API_KEY: "sk-ant-x", ANTHROPIC_AGENT_ID: "agent_1", SYSTEM_PROMPT: "Sos el agente de {{OPERATOR_NAME}}.", OPERATOR_NAME: "ACME", ...config };
  const composed = () => composeSyncPayload({ cfg, toolRows: [], gateRow: null, hasVoice: true, baseline: { syncedHash: undefined, registeredVersion: null } }).system;
  const w = { cfg, live: { id: "agent_1", version: liveVersion, system: liveSystem ?? composed(), model }, calls: [], upserts: [], composed };
  w.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    w.calls.push({ method, url, headers: init.headers });
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.startsWith(URL_)) {
      assert.equal(init.headers.apikey, KEY);
      if (url.includes("/rest/v1/runtime_config") && method === "GET") {
        const keys = decodeURIComponent(url.match(/key=in\.\((.*)\)/)[1]).split(",");
        return json(keys.filter((k) => w.cfg[k] !== undefined).map((k) => ({ key: k, value: w.cfg[k] })));
      }
      if (url.includes("/rest/v1/runtime_config") && method === "POST") {
        const rows = JSON.parse(init.body);
        w.upserts.push(rows);
        for (const r of rows) w.cfg[r.key] = r.value;
        return new Response(null, { status: 201 });
      }
      if (url.includes("/rest/v1/agent_tools") || url.includes("/rest/v1/kommo_publish_config")) return json([]);
    }
    if (url.startsWith("https://api.anthropic.com/v1/agents/agent_1")) {
      if (method === "GET") return json(w.live);
      const body = JSON.parse(init.body);
      if (body.version !== w.live.version) return json({ error: "conflict" }, 409);
      w.live = { ...w.live, version: w.live.version + 1, system: body.system, ...(body.model ? { model: body.model } : {}) };
      w.pushed = body;
      return json(w.live);
    }
    throw new Error(`fetch inesperado ${method} ${url}`);
  };
  return w;
}

async function run(w, argv) {
  const orig = globalThis.fetch;
  const logs = [];
  const { log, error } = console;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));
  globalThis.fetch = w.fetch;
  try {
    const code = await main(argv, ENV);
    return { code, out: logs.join("\n") };
  } finally {
    globalThis.fetch = orig;
    console.log = log;
    console.error = error;
  }
}

const noWrites = (w) => !w.calls.some((c) => c.method === "POST");

test("parseArgs: exige url https, nombre de variable, y hash con --resolve", () => {
  assert.throws(() => parseArgs([]), /--supabase-url/);
  assert.throws(() => parseArgs(["--supabase-url", "http://x.co", "--service-role-key-env", "K"]), /https/);
  assert.throws(() => parseArgs(["--supabase-url", URL_, "--service-role-key-env", "eyJabc"]), /NOMBRE/);
  assert.throws(() => parseArgs([...ARGV, "--resolve", "overwrite"]), /expected-live-hash/);
  assert.throws(() => parseArgs([...ARGV, "--resolve", "nada", "--expected-live-hash", "h"]), /overwrite \| import_live/);
  assert.throws(() => parseArgs([...ARGV, "--key", "x"]), /desconocido/);
  assert.equal(parseArgs([...ARGV, "--dry-run"]).dryRun, true);
});

test("sin la variable de entorno: uso incorrecto, sin red", async () => {
  const w = makeWorld();
  const orig = globalThis.fetch;
  globalThis.fetch = w.fetch;
  const err = console.error;
  console.error = () => {};
  try {
    assert.equal(await main(ARGV, {}), EXIT.usage);
  } finally {
    globalThis.fetch = orig;
    console.error = err;
  }
  assert.equal(w.calls.length, 0);
});

test("dry-run sin conflicto: no escribe, no empuja y no imprime la clave", async () => {
  const w = makeWorld();
  w.cfg.AGENT_PROMPT_SYNCED_HASH = hashPrompt(w.live.system);
  w.cfg.ANTHROPIC_AGENT_VERSION = "5";
  const { code, out } = await run(w, [...ARGV, "--dry-run"]);
  assert.equal(code, EXIT.ok);
  assert.match(out, /\[dry-run\]/);
  assert.ok(noWrites(w));
  assert.ok(!out.includes(KEY));
});

test("dry-run con scaffold viejo en el vivo: alcance scaffold, exit 2, sin escribir", async () => {
  const w = makeWorld();
  const old = w.live.system.replace("Flujo obligatorio antes de redactar", "Flujo obligatorio antes de redactar (v0)");
  w.live.system = old;
  w.cfg.AGENT_PROMPT_SYNCED_HASH = hashPrompt(w.composed()); // lo último enviado fue otra cosa -> el vivo cambió
  const { code, out } = await run(w, [...ARGV, "--dry-run"]);
  assert.equal(code, EXIT.conflict);
  assert.match(out, /alcance scaffold/);
  assert.match(out, /liveHash/);
  assert.ok(noWrites(w));
});

test("conflicto prompt_changed: aborta con el diff, exit 2, nada escrito ni empujado", async () => {
  const w = makeWorld();
  w.cfg.AGENT_PROMPT_SYNCED_HASH = hashPrompt(w.live.system);
  w.live.system = w.live.system.replace("Sos el agente", "Sos otro agente");
  const { code, out } = await run(w, ARGV);
  assert.equal(code, EXIT.conflict);
  assert.match(out, /CONFLICTO prompt_changed/);
  assert.match(out, /^- Sos otro agente/m);
  assert.ok(noWrites(w));
});

test("sync normal: empuja, registra las 3 claves y NUNCA toca SYSTEM_PROMPT", async () => {
  const w = makeWorld();
  w.cfg.AGENT_PROMPT_SYNCED_HASH = hashPrompt(w.live.system);
  w.cfg.ANTHROPIC_AGENT_VERSION = "5";
  const before = w.cfg.SYSTEM_PROMPT;
  const { code, out } = await run(w, ARGV);
  assert.equal(code, EXIT.ok);
  assert.equal(w.upserts.length, 1);
  const keys = w.upserts[0].map((r) => r.key).sort();
  assert.deepEqual(keys, ["AGENT_PROMPT_SYNCED_HASH", "AGENT_SCAFFOLD_HASH", "ANTHROPIC_AGENT_VERSION"]);
  assert.equal(w.cfg.AGENT_SCAFFOLD_HASH, scaffoldHash());
  assert.equal(w.cfg.ANTHROPIC_AGENT_VERSION, "6");
  assert.equal(w.cfg.AGENT_PROMPT_SYNCED_HASH, hashPrompt(w.pushed.system));
  assert.equal(w.cfg.SYSTEM_PROMPT, before);
  assert.equal(w.pushed.model, undefined, "sin --sync-model no se toca el modelo");
  assert.ok(w.upserts[0].every((r) => r.updated_by === "cli:sync-agent"));
  assert.ok(!out.includes(KEY));
});

test("--sync-model alinea el modelo vivo con AGENT_MODEL (objeto con effort)", async () => {
  const w = makeWorld({ model: "claude-haiku-4-5" });
  w.cfg.AGENT_PROMPT_SYNCED_HASH = hashPrompt(w.live.system);
  w.cfg.ANTHROPIC_AGENT_VERSION = "5";
  const { code } = await run(w, [...ARGV, "--sync-model"]);
  assert.equal(code, EXIT.ok);
  assert.deepEqual(w.pushed.model, { id: "claude-haiku-5-5", effort: "medium" });
});

test("--resolve overwrite con hash viejo: stale, exit 3, no empuja", async () => {
  const w = makeWorld();
  w.cfg.AGENT_PROMPT_SYNCED_HASH = hashPrompt(w.live.system);
  w.live.system += "\nEditado por fuera";
  const { code } = await run(w, [...ARGV, "--resolve", "overwrite", "--expected-live-hash", "deadbeef"]);
  assert.equal(code, EXIT.stale);
  assert.ok(noWrites(w));
});

test("--resolve overwrite con el liveHash mostrado: pisa y registra", async () => {
  const w = makeWorld();
  w.cfg.AGENT_PROMPT_SYNCED_HASH = hashPrompt(w.live.system);
  w.live.system = w.live.system.replace("Sos el agente", "Sos otro agente");
  const { code } = await run(w, [...ARGV, "--resolve", "overwrite", "--expected-live-hash", hashPrompt(w.live.system)]);
  assert.equal(code, EXIT.ok);
  assert.match(w.pushed.system, /Sos el agente de ACME/);
  assert.equal(w.cfg.SYSTEM_PROMPT, "Sos el agente de {{OPERATOR_NAME}}.");
});

test("--resolve import_live: única vía que escribe SYSTEM_PROMPT, restituyendo placeholders", async () => {
  const w = makeWorld();
  w.cfg.AGENT_PROMPT_SYNCED_HASH = hashPrompt(w.live.system);
  w.live.system = w.live.system.replace("Sos el agente de ACME.", "Sos el agente de ACME. Regla nueva extensa.");
  const { code } = await run(w, [...ARGV, "--resolve", "import_live", "--expected-live-hash", hashPrompt(w.live.system)]);
  assert.equal(code, EXIT.ok);
  assert.match(w.cfg.SYSTEM_PROMPT, /Regla nueva extensa/);
  assert.ok(w.cfg.SYSTEM_PROMPT.includes("{{OPERATOR_NAME}}"));
  assert.equal(w.pushed, undefined, "import_live no empuja");
});
