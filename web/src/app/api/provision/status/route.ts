// INVARIANT: this route MUST NOT import @/lib/runtime-config or
// @/lib/supabase/service. It uses the provision lib layer only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { MIGRATIONS } from "@/lib/provision/migrations.generated";
import { FUNCTIONS } from "@/lib/provision/functions.generated";
import { getRef } from "@/lib/provision/ref";
import { runQuery } from "@/lib/provision/management";
import { listFunctions } from "@/lib/provision/management";
import { listUsersHead } from "@/lib/provision/admin";
import { readAccessToken } from "@/lib/provision/config-token";
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

  let dbInitialized = false;
  let appliedCount = 0;
  let pendingMigrations: string[] = [];

  // ── Step 1: migrations check ─────────────────────────────────────────────
  try {
    const ref = getRef(supabaseUrl);
    // Read the stored access token (may be null if not yet persisted)
    const token = await readAccessToken(supabaseUrl, serviceRoleKey);

    if (token) {
      const result = await runQuery(
        ref,
        token,
        "SELECT filename FROM _migrations ORDER BY filename"
      ) as Array<{ filename: string }>;

      const applied = new Set(result.map((r) => r.filename));
      appliedCount = applied.size;
      pendingMigrations = MIGRATIONS.map((m) => m.filename).filter(
        (f) => !applied.has(f)
      );
      dbInitialized = appliedCount > 0;
    } else {
      // No token yet → can't check migrations
      pendingMigrations = MIGRATIONS.map((m) => m.filename);
    }
  } catch {
    // _migrations doesn't exist or query failed → DB not initialized
    dbInitialized = false;
    appliedCount = 0;
    pendingMigrations = MIGRATIONS.map((m) => m.filename);
  }

  // ── Step 2: functions check ───────────────────────────────────────────────
  let deployedCount = 0;
  let missingFunctions = FUNCTIONS.map((f) => f.slug);

  try {
    const ref = getRef(supabaseUrl);
    const token = await readAccessToken(supabaseUrl, serviceRoleKey);

    if (token) {
      const deployed = await listFunctions(ref, token);
      const deployedSlugs = new Set(deployed.map((f) => f.slug));
      missingFunctions = FUNCTIONS.map((f) => f.slug).filter(
        (s) => !deployedSlugs.has(s)
      );
      deployedCount = FUNCTIONS.length - missingFunctions.length;
    }
  } catch {
    // Token absent or Management API call failed → treat as none deployed
  }

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
      const supabase = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false },
      });
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
  let nextStep: NextStep;
  if (!dbInitialized || pendingMigrations.length > 0 || missingFunctions.length > 0) {
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
