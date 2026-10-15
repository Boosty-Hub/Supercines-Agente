// INVARIANT: this route MUST NOT import @/lib/runtime-config or
// @/lib/supabase/service. It uses the provision lib layer only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { MIGRATIONS } from "@/lib/provision/migrations.generated";
import { runQuery } from "@/lib/provision/management";
import { saveAccessToken, readAccessToken } from "@/lib/provision/config-token";
import { authorizeProvision } from "@/lib/provision/gate";
import { pickProvisionToken, provisionRef } from "@/lib/provision/gate-logic";
import { ensureSignupLocked } from "@/lib/provision/ensure-signup-lock";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

// accessToken (sbp_, secreto de la CUENTA de Supabase): nunca aparece en un mensaje de error.
const MigrateBody = z.object({ accessToken: z.string().optional() });

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function ensureMigrationsTable(ref: string, token: string): Promise<void> {
  const sql = `
    CREATE TABLE IF NOT EXISTS _migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `.trim();
  await runQuery(ref, token, sql);
}

async function getApplied(
  ref: string,
  token: string
): Promise<Set<string>> {
  try {
    const result = await runQuery(
      ref,
      token,
      "SELECT filename FROM _migrations ORDER BY filename"
    ) as Array<{ filename: string }>;
    return new Set(result.map((r) => r.filename));
  } catch {
    // Table may not exist yet on the very first call
    return new Set();
  }
}

async function recordApplied(
  ref: string,
  token: string,
  filename: string
): Promise<void> {
  await runQuery(
    ref,
    token,
    `INSERT INTO _migrations (filename) VALUES ('${filename.replace(/'/g, "''")}') ON CONFLICT DO NOTHING`
  );
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json(
      { ok: false, error: "Supabase env not configured" },
      { status: 503 }
    );
  }

  // Sin usuarios = primer arranque (sin sesión, token del body); con usuarios = sesión
  // `configuracion`. Ver lib/provision/gate-logic.ts.
  // `legacySinRol`: el maestro sin rol de un despliegue anterior puede aplicar migraciones SOLO
  // hasta que quede aplicada la de roles (0078), que le asigna `configuracion`.
  const gate = await authorizeProvision(supabaseUrl, serviceRoleKey, { legacySinRol: true });
  if (!gate.ok) return gate.response;

  const input = await readJson(request, MigrateBody);
  if (!input.ok) return input.response;
  const body = input.data;

  // Token: del body, o el guardado en runtime_config SOLO con sesión (centro de updates).
  const stored = gate.mode === "session" ? await readAccessToken(supabaseUrl, serviceRoleKey) : null;
  const picked = pickProvisionToken(gate.mode, body.accessToken, stored);
  if (!picked.ok) return NextResponse.json({ ok: false, error: picked.error }, { status: 400 });
  const token = picked.token;
  // El proyecto es SIEMPRE el de este despliegue: un `ref` en el body se ignora.
  const ref = provisionRef(supabaseUrl);
  const total = MIGRATIONS.length;

  // Al actualizar, cierra el registro público (disable_signup) y lo verifica: todo cliente existente
  // lo cierra la primera vez que actualiza. No frena la migración si falla: se informa en la respuesta.
  const signupLock = await ensureSignupLocked(ref, token);

  try {
    // Ensure _migrations table exists (idempotent)
    await ensureMigrationsTable(ref, token);

    const applied = await getApplied(ref, token);
    const appliedCount = applied.size;

    // Find the first pending migration in lexical order
    const next = MIGRATIONS.find((m) => !applied.has(m.filename));

    if (!next) {
      // All done
      return NextResponse.json({
        ok: true,
        applied: appliedCount,
        total,
        justApplied: null,
        done: true,
        signupLock,
      });
    }

    // INVARIANT: substitute ${SUPABASE_URL} placeholder with actual project URL
    // This mirrors what scripts/migrate.mjs did.
    const projectUrl = `https://${ref}.supabase.co`;
    const sql = next.sql.replace(/\$\{SUPABASE_URL\}/g, projectUrl);

    // Execute the migration
    await runQuery(ref, token, sql);

    // Record it as applied
    await recordApplied(ref, token, next.filename);

    const newAppliedCount = appliedCount + 1;
    const done = newAppliedCount >= total;

    // After the final migration (or once runtime_config exists), persist the
    // access token so /status and future operations can read it without prompting.
    // We attempt after 0017 (creates runtime_config) and on the final migration.
    const isRuntimeConfigMigration =
      next.filename.startsWith("0017_") || done;

    if (isRuntimeConfigMigration) {
      // Fire-and-forget — if the table isn't ready yet it returns false gracefully
      await saveAccessToken(supabaseUrl, serviceRoleKey, token).catch(() => {});
    }

    return NextResponse.json({
      ok: true,
      applied: newAppliedCount,
      total,
      justApplied: next.filename,
      done,
      signupLock,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[provision/migrate] Error:", msg);
    return NextResponse.json(
      { ok: false, file: "unknown", error: msg },
      { status: 502 }
    );
  }
}
