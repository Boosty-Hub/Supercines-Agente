// Correr con: deno test supabase/functions/_shared/alerts.test.ts
// insertAlert: único punto de inserción en `alerts` (tipado por el registro) y tolerante a que
// la migración 0076 todavía no esté aplicada.
import { assertEquals } from "jsr:@std/assert@^1.0.0";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { ALERT_INSERT_COLUMNS, alertRow, insertAlert } from "./alerts.ts";

/** Fake con el esquema de alerts SIN 0076: rechaza cualquier columna que no exista (como PostgREST, PGRST204). */
function fakeWithoutMigration() {
  const base = new Set(["kind", "severity", "title", "description", "ref_table", "ref_id", "metadata"]);
  const rows: Record<string, unknown>[] = [];
  const sb = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          const unknown = Object.keys(row).find((k) => !base.has(k));
          if (table !== "alerts" || unknown) {
            return Promise.resolve({ error: { code: "PGRST204", message: `Could not find the '${unknown}' column of 'alerts' in the schema cache` } });
          }
          rows.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { sb: sb as unknown as SupabaseClient, rows };
}

Deno.test("la fila nunca lleva columnas del barrido (0076): el insert funciona con o sin la migración aplicada", async () => {
  for (const col of ALERT_INSERT_COLUMNS) assertEquals(col.startsWith("webhook_"), false, col);
  const { sb, rows } = fakeWithoutMigration();
  const r = await insertAlert(sb, {
    kind: "salesbot_not_delivered",
    severity: "warning",
    title: "t",
    description: "d",
    ref_table: "drafts",
    ref_id: "00000000-0000-0000-0000-000000000001",
    metadata: { a: 1 },
  });
  assertEquals(r, { error: null });
  assertEquals(rows.length, 1);
  assertEquals(Object.keys(rows[0]).filter((k) => k.startsWith("webhook_")), []);
});

Deno.test("alertRow solo incluye las claves presentes (no agrega nulls que el que llama no pidió)", () => {
  assertEquals(alertRow({ kind: "inbound_dropped", severity: "critical", title: "t", metadata: { m: 1 } }), {
    kind: "inbound_dropped",
    severity: "critical",
    title: "t",
    metadata: { m: 1 },
  });
});

Deno.test("insertAlert nunca lanza: un error o una excepción vuelven como { error }", async () => {
  const failing = { from: () => ({ insert: () => Promise.resolve({ error: { message: "boom" } }) }) } as unknown as SupabaseClient;
  assertEquals(await insertAlert(failing, { kind: "draft_failed", severity: "critical", title: "t" }), { error: "boom" });
  const throwing = { from: () => ({ insert: () => Promise.reject(new Error("red caída")) }) } as unknown as SupabaseClient;
  assertEquals(await insertAlert(throwing, { kind: "draft_failed", severity: "critical", title: "t" }), { error: "red caída" });
});

Deno.test("una copia de un tipo onePerRef que la base rechaza (23505) no es un error: vuelve como duplicate", async () => {
  const dup = {
    from: () => ({ insert: () => Promise.resolve({ error: { code: "23505", message: "duplicate key value violates unique constraint" } }) }),
  } as unknown as SupabaseClient;
  assertEquals(await insertAlert(dup, { kind: "human_review_needed", title: "t", ref_table: "messages", ref_id: "00000000-0000-0000-0000-000000000001" }), {
    error: null,
    duplicate: true,
  });
});

// Chequeo de TIPOS (deno test typechequea): un tipo no registrado, o uno de system_incidents,
// no compila. Si alguno de estos @ts-expect-error deja de ser un error, el test no compila.
function _typeOnly(sb: SupabaseClient) {
  // @ts-expect-error tipo no registrado en _shared/alert-kinds.ts
  void insertAlert(sb, { kind: "tipo_raro", severity: "warning", title: "t" });
  // @ts-expect-error los incidentes de salud viven en system_incidents, no en alerts
  void insertAlert(sb, { kind: "kommo_token", severity: "warning", title: "t" });
  // @ts-expect-error severidad fuera del check de la tabla
  void insertAlert(sb, { kind: "draft_failed", severity: "grave", title: "t" });
}
void _typeOnly;

// ---- Severidad por tipo y agregación de los tipos de origen externo ----
import { aggregateWindowMinutes, ALERT_KINDS, criticalKinds } from "./alert-kinds.ts";

function fakeRpc(opts: { rpcError?: { code: string; message: string } } = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const inserts: Record<string, unknown>[] = [];
  const sb = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve({ data: "id", error: opts.rpcError ?? null });
    },
    from() {
      return { insert: (row: Record<string, unknown>) => (inserts.push(row), Promise.resolve({ error: null })) };
    },
  };
  return { sb: sb as unknown as SupabaseClient, calls, inserts };
}

Deno.test("la severidad por defecto de una alerta es la del registro", () => {
  assertEquals(alertRow({ kind: "kommo_webhook_disabled", title: "t" }).severity, "critical");
  assertEquals(alertRow({ kind: "dream_error", title: "t" }).severity, "info");
  assertEquals(alertRow({ kind: "draft_failed", title: "t", severity: "critical" }).severity, "critical"); // explícita gana
});

Deno.test("los críticos del registro incluyen lo que NO puede esperar detrás de una inundación", () => {
  const c = criticalKinds();
  for (const k of ["kommo_webhook_disabled", "provider_credit_exhausted", "budget_exceeded", "salesbot_not_delivered", "inbound_dropped"]) {
    assertEquals(c.includes(k), true, k);
  }
  // los de origen externo y los informativos NO son críticos
  for (const k of ["webhook_rejected", "webhook_unsigned", "dream_error", "outbound_blocked"]) assertEquals(c.includes(k), false, k);
});

Deno.test("los tipos de origen externo se AGREGAN en el insert (una fila por ventana, con contador)", async () => {
  assertEquals(aggregateWindowMinutes("webhook_rejected"), 60);
  assertEquals(aggregateWindowMinutes("webhook_unsigned"), 360);
  assertEquals(aggregateWindowMinutes("inbound_dropped"), 15);
  assertEquals(aggregateWindowMinutes("draft_failed"), undefined);
  const f = fakeRpc();
  const r = await insertAlert(f.sb, { kind: "webhook_rejected", title: "Se descartaron", description: "d", metadata: { m: 1 } });
  assertEquals(r.error, null);
  assertEquals(f.calls.length, 1);
  assertEquals(f.calls[0].fn, "insert_alert_aggregated");
  assertEquals(f.calls[0].args.p_window, "60 minutes");
  assertEquals(f.calls[0].args.p_severity, "warning");
  assertEquals(f.inserts.length, 0, "no inserta una fila por evento");
});

Deno.test("un tipo NO agregable se inserta como fila normal", async () => {
  const f = fakeRpc();
  await insertAlert(f.sb, { kind: "draft_failed", title: "t" });
  assertEquals(f.calls.length, 0);
  assertEquals(f.inserts.length, 1);
});

Deno.test("sin la migración 0076 (PGRST202) el tipo agregable se inserta igual: no se pierde la alerta", async () => {
  const f = fakeRpc({ rpcError: { code: "PGRST202", message: "Could not find the function" } });
  const r = await insertAlert(f.sb, { kind: "inbound_dropped", title: "Se perdió un webhook" });
  assertEquals(r.error, null);
  assertEquals(f.inserts.length, 1);
});

Deno.test("otro error del RPC se devuelve (no se enmascara con un insert)", async () => {
  const f = fakeRpc({ rpcError: { code: "42501", message: "insufficient_privilege" } });
  const r = await insertAlert(f.sb, { kind: "webhook_unsigned", title: "t" });
  assertEquals(r.error, "insufficient_privilege");
  assertEquals(f.inserts.length, 0);
});

Deno.test("las ventanas del registro coinciden con las de la migración 0073 (webhook_rejected 1 h, webhook_unsigned 6 h)", () => {
  const sql = Deno.readTextFileSync(new URL("../../migrations/0073_kommo_webhook_auth.sql", import.meta.url));
  const win = (kind: string) => {
    const m = sql.match(new RegExp(`'${kind}',[\\s\\S]{0,900}?interval '(\\d+) hours?'`));
    return m ? Number(m[1]) * 60 : null;
  };
  assertEquals(win("webhook_rejected"), ALERT_KINDS.webhook_rejected.aggregateMinutes);
  assertEquals(win("webhook_unsigned"), ALERT_KINDS.webhook_unsigned.aggregateMinutes);
});

// El índice vigente lo crea la última migración que amplió la lista (hoy 0092, que sumó
// inbound_lead_unresolved; 0091 creó el original).
Deno.test("los tipos de UNA alerta por entidad coinciden con el índice único vigente (0092)", async () => {
  const { onePerRefKinds } = await import("./alert-kinds.ts");
  const sql = Deno.readTextFileSync(new URL("../../migrations/0092_inbound_queue_not_before.sql", import.meta.url));
  const idx = sql.match(/create unique index[\s\S]*?where kind in \(([^)]*)\)/);
  const enIndice = (idx?.[1] ?? "").split(",").map((k) => k.trim().replace(/'/g, "")).filter(Boolean).sort();
  assertEquals(enIndice, onePerRefKinds().sort());
  // El DELETE de las copias barre exactamente los mismos tipos que el índice protege.
  const del = sql.match(/delete from public\.alerts[\s\S]*?where kind in \(([^)]*)\)/);
  const enDelete = (del?.[1] ?? "").split(",").map((k) => k.trim().replace(/'/g, "")).filter(Boolean).sort();
  assertEquals(enDelete, enIndice);
});
