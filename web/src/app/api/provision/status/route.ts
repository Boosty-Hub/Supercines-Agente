// INVARIANT: this route MUST NOT import @/lib/runtime-config or
// @/lib/supabase/service. It uses the provision lib layer only.
//
// Ruta PÚBLICA (la consulta el /first-run antes de que exista ningún usuario): NO usa el token
// sbp_ guardado. Ese token es de la cuenta de Supabase y solo se usa con sesión `configuracion`
// (o, en el primer arranque, el que el wizard manda en el body): ver lib/provision/gate-logic.ts.
// El estado sale de la propia base con la service-role del env: `_migrations` (lo que aplicó el
// wizard) y DEPLOYED_FUNCTION_HASHES (lo que desplegó, en esta versión).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { MIGRATIONS } from "@/lib/provision/migrations.generated";
import { FUNCTIONS } from "@/lib/provision/functions.generated";
import { listUsersHead } from "@/lib/provision/admin";
import { readDeployedHashes } from "@/lib/provision/function-hashes";
import { createClient } from "@supabase/supabase-js";

type NextStep =
  | "connect-supabase"
  | "initialize"
  | "create-user"
  | "login"
  | "anthropic"
  | "kommo"
  | "done";

export interface ProvisionStatus {
  hasSupabaseEnv: boolean;
  dbInitialized: boolean;
  migrationsApplied: { applied: number; total: number; pending: string[] };
  functionsDeployed: { count: number; total: number; missing: string[] };
  hasUser: boolean;
  anthropicProvisioned: boolean;
  kommoConnected: boolean;
  nextStep: NextStep;
}

export async function GET(): Promise<NextResponse> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const total = MIGRATIONS.length;
  const totalFunctions = FUNCTIONS.length;

  // ── Step 0: env check ────────────────────────────────────────────────────
  if (!supabaseUrl || !serviceRoleKey) {
    const status: ProvisionStatus = {
      hasSupabaseEnv: false,
      dbInitialized: false,
      migrationsApplied: { applied: 0, total, pending: MIGRATIONS.map((m) => m.filename) },
      functionsDeployed: { count: 0, total: totalFunctions, missing: FUNCTIONS.map((f) => f.slug) },
      hasUser: false,
      anthropicProvisioned: false,
      kommoConnected: false,
      nextStep: "connect-supabase",
    };
    return NextResponse.json(status);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ── Step 1: migrations (tabla _migrations, con la service-role) ──────────
  let appliedCount = 0;
  let pendingMigrations = MIGRATIONS.map((m) => m.filename);
  {
    const { data, error } = await supabase.from("_migrations").select("filename");
    if (!error && data) {
      // Solo cuentan las del bundle: una fila vieja de una migración renombrada no completa nada.
      const applied = new Set((data as Array<{ filename: string }>).map((r) => r.filename));
      pendingMigrations = MIGRATIONS.map((m) => m.filename).filter((f) => !applied.has(f));
      appliedCount = total - pendingMigrations.length;
    }
    // error = la tabla todavía no existe (o PostgREST no la ve aún) → todo pendiente.
  }
  const dbInitialized = appliedCount > 0;

  // ── Step 2: functions (desplegadas por el wizard EN ESTA VERSIÓN) ───────────
  const hashes = dbInitialized ? await readDeployedHashes(supabaseUrl, serviceRoleKey) : {};
  const missingFunctions = FUNCTIONS.filter((f) => hashes[f.slug] !== f.hash).map((f) => f.slug);
  const deployedCount = totalFunctions - missingFunctions.length;

  // ── Step 3: user check ────────────────────────────────────────────────────
  let hasUser = false;
  try {
    const page = await listUsersHead(supabaseUrl, serviceRoleKey);
    hasUser = page.users.length > 0;
  } catch {
    // Auth Admin API failed — treat as no user
  }

  // ── Step 4: anthropic + kommo check ──────────────────────────────────────
  let anthropicProvisioned = false;
  let kommoConnected = false;

  if (dbInitialized) {
    try {
      const { data } = await supabase
        .from("runtime_config")
        .select("key, value")
        .in("key", ["ANTHROPIC_AGENT_ID", "KOMMO_ACCESS_TOKEN"]);

      for (const row of data ?? []) {
        const r = row as { key: string; value: string | null };
        if (r.key === "ANTHROPIC_AGENT_ID" && r.value && r.value !== "") {
          anthropicProvisioned = true;
        }
        if (r.key === "KOMMO_ACCESS_TOKEN" && r.value && r.value !== "") {
          kommoConnected = true;
        }
      }
    } catch {
      // runtime_config may not exist yet — tolerate
    }
  }

  // ── Compute nextStep ──────────────────────────────────────────────────────
  // Con un usuario creado, el first-run terminó: inicializar ya no es un paso del wizard (las
  // migraciones/funciones nuevas las aplica el centro de updates del panel, con sesión). Antes se
  // volvía a «initialize» y esas rutas ahora exigen sesión `configuracion`.
  let nextStep: NextStep;
  if (!hasUser && (!dbInitialized || pendingMigrations.length > 0 || missingFunctions.length > 0)) {
    nextStep = "initialize";
  } else if (!hasUser) {
    nextStep = "create-user";
  } else if (!anthropicProvisioned) {
    nextStep = "anthropic";
  } else if (!kommoConnected) {
    nextStep = "kommo";
  } else {
    nextStep = "done";
  }

  const status: ProvisionStatus = {
    hasSupabaseEnv: true,
    dbInitialized,
    migrationsApplied: { applied: appliedCount, total, pending: pendingMigrations },
    functionsDeployed: { count: deployedCount, total: totalFunctions, missing: missingFunctions },
    hasUser,
    anthropicProvisioned,
    kommoConnected,
    nextStep,
  };

  return NextResponse.json(status);
}
