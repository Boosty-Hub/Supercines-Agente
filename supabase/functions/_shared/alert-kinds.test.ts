// Correr con: deno test --allow-read supabase/functions/_shared/alert-kinds.test.ts
// El registro de tipos de alerta, el default de webhook_kinds (0076) y lo que el código y el SQL
// realmente insertan tienen que decir lo MISMO. Y todo insert a `alerts` desde TypeScript pasa
// por el helper único (_shared/alerts.ts).
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { ALERT_KINDS, type RegisteredKind, shouldSweep, webhookKindsDefault, type WebhookConfigLike } from "./alert-kinds.ts";

const root = new URL("../../", import.meta.url); // supabase/
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));

async function* walk(dir: URL): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      yield* walk(u);
    } else yield u;
  }
}

const relOf = (u: URL) => decodeURIComponent(u.pathname).replace(/^.*?\/(supabase|web)\//, "$1/");
const isSource = (u: URL) => /\.(ts|tsx)$/.test(u.pathname) && !/\.test\.tsx?$|\.generated\.ts$/.test(u.pathname);

// ---------------------------------------------------------------------------------------------
// Escáneres (exportados a sus auto-pruebas abajo: si dejan de ver un formato, falla el test)
// ---------------------------------------------------------------------------------------------

/** Texto del argumento de la llamada que abre en `open` (índice del "("), con paréntesis balanceados. */
function callArgs(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** `kind: "x"` o `kind: CONST` (resuelta en el mismo archivo) dentro de `chunk`. */
function kindsIn(chunk: string, file: string): string[] {
  const out: string[] = [];
  for (const m of chunk.matchAll(/\bkind:\s*(?:"([a-z_]+)"|'([a-z_]+)'|([A-Z][A-Z0-9_]*))/g)) {
    if (m[1] || m[2]) out.push(m[1] ?? m[2]);
    else {
      const c = file.match(new RegExp(`\\b${m[3]}\\s*=\\s*["']([a-z_]+)["']`));
      out.push(c ? c[1] : `<constante ${m[3]} sin resolver>`);
    }
  }
  return out;
}

/** Tipos de alerta que un archivo TS inserta o arma como fila de alerta. */
export function tsAlertKinds(text: string): string[] {
  const found: string[] = [];
  // 1) insertAlert(cliente, { kind: … })
  for (const m of text.matchAll(/\binsertAlert\s*\(/g)) {
    const args = callArgs(text, m.index! + m[0].length - 1);
    found.push(...kindsIn(args, text));
  }
  // 2) toda fila de alerta armada aparte (plan.row, detectores, wrappers): un objeto con
  //    `kind` y `severity` (sin cerrar el objeto entre medio) ES una alerta/incidente.
  for (const m of text.matchAll(/\bkind:\s*(?:"[a-z_]+"|'[a-z_]+'|[A-Z][A-Z0-9_]*)\s*,[^{}]{0,160}?\bseverity:/g)) {
    found.push(...kindsIn(m[0], text));
  }
  for (const m of text.matchAll(/\bseverity:\s*[^,{}]+,[^{}]{0,160}?\bkind:\s*(?:"[a-z_]+"|'[a-z_]+'|[A-Z][A-Z0-9_]*)/g)) {
    found.push(...kindsIn(m[0].slice(m[0].search(/\bkind:/)), text));
  }
  // 3) constantes declaradas como tipo de alerta
  for (const m of text.matchAll(/=\s*["']([a-z_]+)["']\s*satisfies\s+AlertKind\b/g)) found.push(m[1]);
  return [...new Set(found)];
}

/** Inserts directos a `alerts` (todo debe pasar por insertAlert de _shared/alerts.ts). */
export function directAlertInserts(text: string): number {
  return [...text.matchAll(/\.from\(\s*["'`]alerts["'`]\s*\)\s*\.(?:insert|upsert)\s*\(/g)].length;
}

/** Parte por comas de nivel superior (respeta paréntesis y literales '…'). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = false, cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === "'" && s[i + 1] === "'") cur += s[++i];
      else if (c === "'") quote = false;
      continue;
    }
    if (c === "'") quote = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Bloque entre paréntesis balanceados que empieza en `open` (incluye literales con paréntesis). */
function parenBlock(s: string, open: number): [string, number] {
  let depth = 0, quote = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "'" && s[i + 1] === "'") i++;
      else if (c === "'") quote = false;
      continue;
    }
    if (c === "'") quote = true;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return [s.slice(open + 1, i), i + 1];
  }
  return [s.slice(open + 1), s.length];
}

/**
 * Tipos que el SQL inserta en `alerts` (alerts / public.alerts / "alerts", values de una o
 * varias filas, o insert … select). Un insert que no se puede verificar (sin lista de columnas,
 * kind no literal) se informa como `<…>` para que el test falle: el SQL no puede saltarse el registro.
 */
export function sqlAlertKinds(sqlRaw: string): string[] {
  const sql = sqlRaw.replace(/--[^\n]*/g, "");
  const found: string[] = [];
  const re = /insert\s+into\s+(?:"?public"?\s*\.\s*)?"?alerts"?(?=[\s(])/gi;
  for (const m of sql.matchAll(re)) {
    let i = m.index! + m[0].length;
    while (/\s/.test(sql[i])) i++;
    if (sql[i] !== "(") {
      found.push("<insert into alerts sin lista de columnas>");
      continue;
    }
    const [colsText, afterCols] = parenBlock(sql, i);
    const cols = splitTop(colsText).map((c) => c.replace(/"/g, "").toLowerCase());
    const k = cols.indexOf("kind");
    if (k < 0) {
      found.push("<insert into alerts sin columna kind>");
      continue;
    }
    const rest = sql.slice(afterCols);
    const head = rest.match(/^\s*(values|select)\b/i);
    if (!head) {
      found.push("<insert into alerts con forma no reconocida>");
      continue;
    }
    const literal = (expr: string) => {
      const lit = expr.match(/^'([a-z_]+)'(?:::text)?$/);
      return lit ? lit[1] : `<kind no literal: ${expr.slice(0, 40)}>`;
    };
    if (head[1].toLowerCase() === "values") {
      let j = head[0].length;
      for (;;) {
        while (/\s/.test(rest[j])) j++;
        if (rest[j] !== "(") break;
        const [tuple, next] = parenBlock(rest, j);
        found.push(literal(splitTop(tuple)[k] ?? ""));
        j = next;
        while (/\s/.test(rest[j])) j++;
        if (rest[j] !== ",") break;
        j++;
      }
    } else {
      const body = rest.slice(head[0].length);
      const end = body.search(/\bfrom\b|;|\bwhere\b/i);
      found.push(literal(splitTop(end < 0 ? body : body.slice(0, end))[k] ?? ""));
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------

// El default VIGENTE de webhook_kinds lo fija la última migración que lo cambió (hoy 0092, que
// sumó inbound_lead_unresolved). Un tipo nuevo notificable: migración nueva y apuntar acá.
Deno.test("el default de webhook_kinds vigente (0092) es EXACTAMENTE el del registro (y dream_error no está)", () => {
  const sql = read("migrations/0092_inbound_queue_not_before.sql");
  const m = sql.match(/set default array\[([\s\S]*?)\]::text\[\]/);
  assert(m, "no se encontró el default de webhook_kinds");
  const kinds = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  assertEquals(kinds, webhookKindsDefault());
  assert(!kinds.includes("dream_error"));
  assertEquals(ALERT_KINDS.dream_error.webhook, false);
  assert(ALERT_KINDS.dream_error.reason.includes("/dreams"));
  // Cambio de un dream ACTIVO (refresco de Dreams): aviso en /alerts, no al webhook.
  assert(!kinds.includes("dream_updated"));
  assertEquals(ALERT_KINDS.dream_updated.webhook, false);
  assertEquals(ALERT_KINDS.dream_updated.table, "alerts");
});

Deno.test("los tipos nuevos de esta versión están como notificables", () => {
  const kinds: RegisteredKind[] = [
    "salesbot_not_delivered",
    "provider_credit_exhausted",
    "webhook_rejected",
    "webhook_unsigned",
    "outbound_blocked",
    "inbound_dropped",
  ];
  for (const k of kinds) assertEquals(ALERT_KINDS[k].webhook, true, k);
});

Deno.test("0076 suma a las configs EXISTENTES exactamente los tipos que no existían en producción", () => {
  const sql = read("migrations/0076_alert_webhook_delivery.sql");
  const m = sql.match(/foreach k in array array\[([\s\S]*?)\]::text\[\]/);
  assert(m, "no se encontró la lista de tipos nuevos para configs existentes");
  const added = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  assertEquals(added, ["outbound_blocked", "webhook_unsigned", "webhook_rejected", "salesbot_not_delivered", "provider_credit_exhausted", "registro_abierto"]);
  for (const k of added) assertEquals(ALERT_KINDS[k as RegisteredKind].webhook, true, k);
});

Deno.test("0092 suma inbound_lead_unresolved a las configs EXISTENTES (tipo nuevo: nadie pudo haberlo quitado)", () => {
  const sql = read("migrations/0092_inbound_queue_not_before.sql");
  const m = sql.match(/foreach k in array array\[([\s\S]*?)\]::text\[\]/);
  assert(m, "no se encontró la lista de tipos nuevos para configs existentes en 0092");
  const added = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  assertEquals(added, ["inbound_lead_unresolved", "inbound_processing_failed"]);
  assertEquals(ALERT_KINDS.inbound_processing_failed.webhook, true);
  assertEquals(ALERT_KINDS.inbound_lead_unresolved.webhook, true);
});

Deno.test("ningún insert directo a `alerts` fuera del helper (_shared/alerts.ts), ni en las funciones ni en web/src", async () => {
  const offenders: string[] = [];
  for (const dir of [new URL("functions/", root), new URL("../web/src/", root)]) {
    for await (const u of walk(dir)) {
      if (!isSource(u) || u.pathname.endsWith("/_shared/alerts.ts")) continue;
      const n = directAlertInserts(await Deno.readTextFile(u));
      if (n > 0) offenders.push(`${relOf(u)} (${n})`);
    }
  }
  assertEquals(offenders, [], `inserts directos a alerts (usá insertAlert de _shared/alerts.ts): ${offenders.join(", ")}`);
});

Deno.test("todo tipo que el código o el SQL insertan en `alerts` está en el registro (y en la tabla correcta)", async () => {
  const bad: string[] = [];
  let seen = 0;
  for await (const u of walk(new URL("functions/", root))) {
    if (!isSource(u)) continue;
    const rel = relOf(u);
    const incidents = /health-detectores\.ts$/.test(u.pathname); // filas de system_incidents
    for (const k of tsAlertKinds(await Deno.readTextFile(u))) {
      seen++;
      const info = (ALERT_KINDS as Record<string, { table: string }>)[k];
      if (!info) bad.push(`${k} (${rel}): no registrado`);
      else if (info.table !== (incidents ? "system_incidents" : "alerts")) bad.push(`${k} (${rel}): tabla ${info.table}`);
    }
  }
  for await (const u of walk(new URL("migrations/", root))) {
    if (!u.pathname.endsWith(".sql")) continue;
    // insert_alert_aggregated (0076) es el camino agregado: su propio cuerpo recibe el tipo por
    // parámetro, así que se verifican sus LLAMADAS (tipo literal) en vez de su INSERT interno.
    const raw = await Deno.readTextFile(u);
    const body = raw.replace(/create or replace function insert_alert_aggregated[\s\S]*?\n\$\$;/i, "");
    const aggregatedCalls = [...body.replace(/--[^\n]*/g, "").matchAll(/insert_alert_aggregated\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
    for (const k of [...sqlAlertKinds(body), ...aggregatedCalls]) {
      seen++;
      const info = (ALERT_KINDS as Record<string, { table: string }>)[k];
      if (!info || info.table !== "alerts") bad.push(`${k} (${relOf(u)})`);
    }
  }
  assert(seen >= 20, `el escaneo casi no encontró tipos (${seen}): dejó de ver los inserts`);
  assertEquals(bad, [], `tipos de alerta sin registrar en _shared/alert-kinds.ts: ${bad.join(", ")}`);
});

Deno.test("auto-prueba: el escáner TS ve insertAlert, filas armadas aparte, constantes y wrappers", () => {
  assertEquals(tsAlertKinds(`await insertAlert(supabase, { kind: "tipo_raro", severity: "warning", title: f(x) })`), ["tipo_raro"]);
  assertEquals(tsAlertKinds(`const K = "otro_raro"; insertAlert(sb, { severity: "info", kind: K, title: "t" })`), ["otro_raro"]);
  assertEquals(tsAlertKinds(`return { action: "insert", row: {\n kind: "fila_rara",\n severity: "warning",\n ...txt } }`), ["fila_rara"]);
  assertEquals(tsAlertKinds(`await alertOrWarn({\n  kind: "wrapper_raro",\n  severity: "warning",\n  title: \`x\` }, "l")`), ["wrapper_raro"]);
  assertEquals(tsAlertKinds(`const CREDIT = "credito_raro" satisfies AlertKind;`), ["credito_raro"]);
  assertEquals(tsAlertKinds(`writeClientText({ kind: "dm", text })`), [], "un kind sin severity no es una alerta");
  assertEquals(directAlertInserts(`await supabase.from("alerts").insert(plan.row)`), 1);
  assertEquals(directAlertInserts(`await (sb as any).from('alerts')\n  .upsert({})`), 1);
  assertEquals(directAlertInserts(`await supabase.from("alerts").update({}).eq("id", id)`), 0);
});

Deno.test("auto-prueba: el escáner SQL ve alerts / public.alerts, varias filas, select y orden de columnas", () => {
  assertEquals(sqlAlertKinds(`insert into alerts (kind, severity, title) values ('a_uno', 'warning', 'x')`), ["a_uno"]);
  assertEquals(sqlAlertKinds(`INSERT INTO public.alerts (severity, title, kind)\n VALUES ('warning', 'x, (y)', 'a_dos'), ('info', 'z', 'a_tres');`), ["a_dos", "a_tres"]);
  assertEquals(sqlAlertKinds(`insert into "public"."alerts"(title, kind) select 'x', 'a_cuatro'::text from t where q`), ["a_cuatro"]);
  assertEquals(sqlAlertKinds(`insert into public.alerts (kind, title) values (p_kind, 'x')`), ["<kind no literal: p_kind>"]);
  assertEquals(sqlAlertKinds(`insert into alerts values ('a', 'b')`), ["<insert into alerts sin lista de columnas>"]);
  assertEquals(sqlAlertKinds(`-- insert into alerts (kind) values ('comentario')\ninsert into alerts_archive (kind) values ('otra_tabla')`), []);
});

Deno.test("todo tipo del registro tiene motivo", () => {
  for (const [k, v] of Object.entries(ALERT_KINDS)) assert(v.reason.length > 20, k);
});

const CFG: WebhookConfigLike = { webhook_enabled: true, webhook_url: "https://hooks.example/x", webhook_kinds: webhookKindsDefault() };

Deno.test("shouldSweep: sin webhook activo no se reclama nada", () => {
  assertEquals(shouldSweep(null), false);
  assertEquals(shouldSweep({ ...CFG, webhook_enabled: false }), false);
  assertEquals(shouldSweep({ ...CFG, webhook_url: null }), false);
  assertEquals(shouldSweep(CFG), true);
});
