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
