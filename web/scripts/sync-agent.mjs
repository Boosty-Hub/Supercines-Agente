#!/usr/bin/env node
// sync-agent.mjs
// Sincroniza el scaffold / tools del Managed Agent de UN cliente desde la terminal, con las
// MISMAS garantías que el botón «Sincronizar» de /agent y /consumo (mantenimiento de flota
// tras un deploy que cambia CORE_SCAFFOLD o las tools).
//
// NO reimplementa la lógica: importa los mismos módulos de la web (type-stripping nativo de
// Node >= 22.18; ver CLAUDE.md «Sincronización segura del system prompt»):
//   · composición  → src/lib/agent-sync-core.ts (composeSyncPayload: composeSystem +
//                    CORE_SCAFFOLD + renderToolsList + compuertas de tools)
//   · decisión     → src/lib/agent-sync-core.ts (runAgentSync: guardedPush, detectPromptConflict,
//                    anti-TOCTOU `expectedLiveHash`, registro de las 3 huellas/versión)
//   · Anthropic    → src/lib/anthropic-managed.ts (retrieveAgent / updateAgent / listMemories)
//
// Uso (desde la raíz del repo o desde web/):
//   SUPABASE_SERVICE_ROLE_KEY_CLIENTE=eyJ... node web/scripts/sync-agent.mjs \
//     --supabase-url https://<ref>.supabase.co --service-role-key-env SUPABASE_SERVICE_ROLE_KEY_CLIENTE \
//     [--dry-run] [--sync-model] [--resolve import_live|overwrite --expected-live-hash <hash>]
//
//   --dry-run          solo lee: muestra alcance (operator/scaffold), resumen del diff y qué
//                      cambiaría. No empuja ni escribe NADA.
//   --sync-model       además alinea el modelo del agente vivo con runtime_config.AGENT_MODEL
//                      (agentModelParam: objeto {id, effort} o string plano según el modelo).
//   --resolve          decisión EXPLÍCITA ante un conflicto (el mismo que muestra el dry-run):
//                        overwrite   empuja el prompt de la DB y pisa lo editado por fuera;
//                        import_live trae el prompt vivo del operador a SYSTEM_PROMPT (única
//                                    escritura de SYSTEM_PROMPT que existe; igual que el botón).
//                      Exige --expected-live-hash = el `liveHash` que mostró el conflicto; si el
//                      agente vivo cambió desde entonces se ABORTA (exit 3).
//
// Códigos de salida: 0 ok / sin cambios · 1 error · 2 conflicto (nada se sincronizó) · 3 el vivo
// cambió desde que se revisó (stale) · 64 uso incorrecto.
//
// Seguridad: la service-role key se lee SOLO de la variable de entorno cuyo NOMBRE se pasa
// (nunca por argv) y no se imprime. La configuración sale de runtime_config por la base (sin
// fallback al entorno de esta máquina: ese entorno no es el del cliente). Sin ellas la CLI no
// escribe más que ANTHROPIC_AGENT_VERSION / AGENT_SCAFFOLD_HASH / AGENT_PROMPT_SYNCED_HASH.
// Nunca modifica SYSTEM_PROMPT salvo con --resolve import_live.

import { pathToFileURL } from "node:url";
import {
  PAYLOAD_CONFIG_KEYS,
  composeSyncPayload,
  conflictFor,
  diffCounts,
  runAgentSync,
} from "../src/lib/agent-sync-core.ts";
import { hashPrompt, extractOperatorPrompt, extractScaffold } from "../src/lib/agent-prompt-sync.ts";
import { scaffoldHash } from "../src/lib/agent-prompt.ts";
import { retrieveAgent, updateAgent } from "../src/lib/anthropic-managed.ts";
import { detectVoiceFiles } from "../src/lib/voice-detect.ts";
import { agentModelMatches, agentModelParam } from "../src/lib/model-capabilities.ts";
import { DEFAULT_MODEL } from "../src/lib/model-config.ts";

export const EXIT = { ok: 0, error: 1, conflict: 2, stale: 3, usage: 64 };
const UPDATED_BY = "cli:sync-agent";
/** Claves que la CLI puede escribir; SYSTEM_PROMPT solo con --resolve import_live. */
const WRITABLE = new Set(["ANTHROPIC_AGENT_VERSION", "AGENT_SCAFFOLD_HASH", "AGENT_PROMPT_SYNCED_HASH"]);

class UsageError extends Error {}

export function parseArgs(argv) {
  const out = { dryRun: false, syncModel: false };
  const valued = {
    "--supabase-url": "supabaseUrl",
    "--service-role-key-env": "keyEnv",
    "--resolve": "resolve",
    "--expected-live-hash": "expectedLiveHash",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--sync-model") out.syncModel = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (valued[a]) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} requiere un valor`);
      out[valued[a]] = v;
    } else throw new UsageError(`argumento desconocido: ${a}`);
  }
  if (out.help) return out;
  if (!out.supabaseUrl) throw new UsageError("falta --supabase-url");
  if (!out.keyEnv) throw new UsageError("falta --service-role-key-env <NOMBRE_DE_LA_VARIABLE>");
  if (/^eyJ|^sb_secret_/.test(out.keyEnv)) throw new UsageError("--service-role-key-env lleva el NOMBRE de la variable, nunca la clave");
  if (out.resolve && !["overwrite", "import_live"].includes(out.resolve)) throw new UsageError("--resolve admite overwrite | import_live");
  if (out.resolve && !out.dryRun && !out.expectedLiveHash) throw new UsageError("--resolve exige --expected-live-hash (el liveHash que mostró el conflicto)");
  if (out.expectedLiveHash && !out.resolve) throw new UsageError("--expected-live-hash solo tiene sentido con --resolve");
  let u;
  try {
    u = new URL(out.supabaseUrl);
  } catch {
    throw new UsageError("--supabase-url no es una URL válida");
  }
  if (u.protocol !== "https:" || u.username || u.password) throw new UsageError("--supabase-url debe ser https://<ref>.supabase.co");
  out.supabaseUrl = u.origin;
  return out;
}

/** Cliente PostgREST mínimo con la service-role. Los mensajes de error nunca llevan la clave. */
function restClient(baseUrl, key) {
  const headers = { apikey: key, authorization: `Bearer ${key}` };
  const fail = async (res, what) => {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`${what} → HTTP ${res.status}: ${body}`);
  };
  return {
    async get(path) {
      const res = await fetch(`${baseUrl}/rest/v1/${path}`, { headers });
      if (!res.ok) await fail(res, `GET ${path.split("?")[0]}`);
      return res.json();
    },
    async upsertConfig(rows) {
      const res = await fetch(`${baseUrl}/rest/v1/runtime_config?on_conflict=key`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows),
      });
      if (!res.ok) await fail(res, "POST runtime_config");
    },
  };
}

/** runtime_config SOLO de la base; null/"" = ausente (misma regla que configValues). */
async function readConfig(rest, keys) {
  const rows = await rest.get(`runtime_config?select=key,value&key=in.(${keys.join(",")})`);
  const out = {};
  for (const r of rows) if (typeof r.value === "string" && r.value.trim() !== "") out[r.key] = r.value;
  return out;
}

const lineOf = (d) => `${d.type === "add" ? "+" : "-"} ${d.text}`;
const printDiff = (title, diff) => {
  const changed = (diff ?? []).filter((d) => d.type !== "same");
  console.log(`\n${title} (- = vivo en Anthropic, + = lo que enviaría la plataforma):`);
  for (const d of changed) console.log(lineOf(d));
};

export async function main(argv, env = process.env) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`Error de uso: ${e.message}\nVer: node web/scripts/sync-agent.mjs --help`);
    return EXIT.usage;
  }
  if (args.help) {
    console.log("Uso: node web/scripts/sync-agent.mjs --supabase-url <url> --service-role-key-env <VAR> [--dry-run] [--sync-model] [--resolve import_live|overwrite --expected-live-hash <hash>]\nDetalle en el encabezado del script y en CLAUDE.md.");
    return EXIT.ok;
  }
  const key = env[args.keyEnv];
  if (!key) {
    console.error(`La variable de entorno ${args.keyEnv} está vacía o no existe.`);
    return EXIT.usage;
  }
  const rest = restClient(args.supabaseUrl, key);

  const cfg = await readConfig(rest, [...PAYLOAD_CONFIG_KEYS, "AGENT_MODEL", "AGENT_SCAFFOLD_HASH"]);
  const apiKey = cfg.ANTHROPIC_API_KEY;
  const agentId = cfg.ANTHROPIC_AGENT_ID;
  if (!apiKey || !agentId) {
    console.error("El agente no está aprovisionado en este cliente (falta ANTHROPIC_API_KEY o ANTHROPIC_AGENT_ID en runtime_config). Nada que sincronizar.");
    return EXIT.error;
  }

  const readBaseline = async () => {
    const c = await readConfig(rest, ["AGENT_PROMPT_SYNCED_HASH", "ANTHROPIC_AGENT_VERSION"]);
    const reg = Number(c.ANTHROPIC_AGENT_VERSION);
    return { syncedHash: c.AGENT_PROMPT_SYNCED_HASH || undefined, registeredVersion: Number.isFinite(reg) && reg > 0 ? reg : null };
  };
  const toolRows = await rest.get("agent_tools?select=name,description,input_schema,tool_type&enabled=eq.true&order=tool_type.desc,created_at.asc");
  const gates = await rest.get("kommo_publish_config?select=*&is_active=eq.true&limit=1");
  const hasVoice = await detectVoiceFiles(apiKey, cfg.ANTHROPIC_MEMORY_MASTER_ID);
  const payload = composeSyncPayload({ cfg, toolRows, gateRow: gates[0] ?? null, hasVoice, baseline: await readBaseline() });

  const live = await retrieveAgent(apiKey, agentId);
  const conflict = conflictFor(payload, live);
  const desiredModel = agentModelParam(cfg.AGENT_MODEL || DEFAULT_MODEL);
  const modelDrift = !agentModelMatches(live.model, desiredModel);
  const extraBody = args.syncModel && modelDrift ? { model: desiredModel } : undefined;
  const liveSystem = typeof live.system === "string" ? live.system : "";

  // ── Resumen (siempre; es lo único que hace --dry-run) ──
  const liveOp = extractOperatorPrompt(liveSystem);
  const dbOp = extractOperatorPrompt(payload.system);
  const liveScaffold = extractScaffold(liveSystem);
  const dbScaffold = extractScaffold(payload.system);
  console.log(`Agente ${agentId}  versión viva ${live.version ?? "?"} · registrada ${payload.baseline.registeredVersion ?? "—"}`);
  console.log(`System vivo hash ${hashPrompt(liveSystem).slice(0, 16)} · a enviar ${hashPrompt(payload.system).slice(0, 16)} · último sincronizado ${payload.baseline.syncedHash?.slice(0, 16) ?? "— (primera vez)"}`);
  console.log(`Scaffold del código ${scaffoldHash()} · registrado ${cfg.AGENT_SCAFFOLD_HASH ?? "—"}${cfg.AGENT_SCAFFOLD_HASH === scaffoldHash() ? " (al día)" : " (DESACTUALIZADO)"}`);
  console.log(`Prompt del operador: ${liveOp === null || dbOp === null ? "no separable" : liveOp.trim() === dbOp.trim() ? "idéntico" : "DIFIERE"} · scaffold: ${liveScaffold === null || dbScaffold === null ? "no separable" : liveScaffold.trim() === dbScaffold.trim() ? "idéntico" : "DIFIERE"}`);
  console.log(`Modelo vivo: ${JSON.stringify(live.model)} · deseado: ${JSON.stringify(desiredModel)}${modelDrift ? (args.syncModel ? " (se alineará)" : " (difiere; usá --sync-model)") : " (igual)"}`);
  if (conflict) {
    const o = diffCounts(conflict.diff);
    const s = diffCounts(conflict.scaffoldDiff);
    console.log(`\nCONFLICTO ${conflict.kind} · alcance ${conflict.scope}\n${conflict.message}`);
    console.log(`Diff del operador: +${o.add} -${o.del} líneas · diff del scaffold: +${s.add} -${s.del} líneas`);
    console.log(`liveHash (para --expected-live-hash): ${conflict.liveHash}`);
    if (!args.dryRun || !args.resolve) {
      printDiff(conflict.scope === "unknown" ? "Diff del system completo" : "Diff del prompt del operador", conflict.diff);
      if (conflict.scaffoldDiff) printDiff("Diff del scaffold", conflict.scaffoldDiff);
    }
  } else {
    console.log("\nSin conflicto: el agente vivo coincide con la última sincronización.");
  }

  if (args.dryRun) {
    const would = conflict && !args.resolve ? "NO se sincronizaría (conflicto sin resolver)" : args.resolve === "import_live" ? "se importaría el prompt vivo a SYSTEM_PROMPT (nada se empuja)" : `se empujaría system + ${payload.tools.length} tools${extraBody ? " + modelo" : ""} y se registrarían ANTHROPIC_AGENT_VERSION, AGENT_SCAFFOLD_HASH, AGENT_PROMPT_SYNCED_HASH`;
    console.log(`\n[dry-run] ${would}. No se escribió ni se empujó nada.`);
    return conflict && !args.resolve ? EXIT.conflict : EXIT.ok;
  }

  const io = {
    readBaseline,
    retrieve: () => retrieveAgent(apiKey, agentId),
    update: async (version, body) => {
      const updated = await updateAgent(apiKey, agentId, { version, ...body });
      return updated.version ?? 0;
    },
    writeConfig: async (values) => {
      for (const k of Object.keys(values)) {
        const allowed = WRITABLE.has(k) || (k === "SYSTEM_PROMPT" && args.resolve === "import_live");
        if (!allowed) throw new Error(`La CLI no puede escribir ${k}`);
      }
      const at = new Date().toISOString();
      await rest.upsertConfig(Object.entries(values).map(([k, value]) => ({ key: k, value, updated_at: at, updated_by: UPDATED_BY })));
    },
  };
  const res = await runAgentSync(io, payload, { resolve: args.resolve, expectedLiveHash: args.expectedLiveHash, extraBody });

  if (res.stale) {
    console.error(`\n${res.error}`);
    if (res.conflict) console.error(`liveHash actual: ${res.conflict.liveHash}`);
    return EXIT.stale;
  }
  if (res.conflict) {
    console.error(`\n${res.error}\nResolvelo con --resolve overwrite|import_live --expected-live-hash ${res.conflict.liveHash}`);
    return EXIT.conflict;
  }
  if (!res.synced) {
    console.error(`\nError: ${res.error ?? "no se sincronizó"}`);
    return EXIT.error;
  }
  if (res.imported) {
    console.log(`\nImportado el prompt vivo a SYSTEM_PROMPT (versión ${res.version}). Placeholders restituidos: ${res.placeholders?.replaced.length ?? 0}; ambiguos sin tocar: ${res.placeholders?.ambiguous.length ?? 0}.`);
  } else {
    console.log(`\nSincronizado. Versión nueva ${res.version}. Registradas: ANTHROPIC_AGENT_VERSION, AGENT_SCAFFOLD_HASH=${scaffoldHash()}, AGENT_PROMPT_SYNCED_HASH.`);
  }
  return EXIT.ok;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(EXIT.error);
    }
  );
}
