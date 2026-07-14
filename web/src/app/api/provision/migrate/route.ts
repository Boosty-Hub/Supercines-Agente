// INVARIANT: this route MUST NOT import @/lib/runtime-config or
// @/lib/supabase/service. It uses the provision lib layer only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { MIGRATIONS } from "@/lib/provision/migrations.generated";
import { getRef } from "@/lib/provision/ref";
import { runQuery } from "@/lib/provision/management";
import { saveAccessToken, readAccessToken } from "@/lib/provision/config-token";

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

export async function POST(request: Request): Promise<NextResponse> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json(
      { ok: false, error: "Supabase env not configured" },
      { status: 503 }
    );
  }

  let body: { accessToken?: string; ref?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { accessToken, ref: bodyRef } = body;

  // Token: del body, o el guardado en runtime_config (así el centro de updates
  // no necesita manejar el token en el cliente).
  let token = accessToken && typeof accessToken === "string" ? accessToken.trim() : "";
  if (!token) token = (await readAccessToken(supabaseUrl, serviceRoleKey)) ?? "";
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No hay token de Supabase (pegá uno o corré el wizard)." },
      { status: 400 }
    );
  }
  const ref = bodyRef?.trim() || getRef(supabaseUrl);
  const total = MIGRATIONS.length;

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
