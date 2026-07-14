// INVARIANT: this route MUST NOT import @/lib/runtime-config or
// @/lib/supabase/service. It uses the provision lib layer only.
// INVARIANT: verify_jwt:false MUST be passed in every deployFunction call.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { FUNCTIONS } from "@/lib/provision/functions.generated";
import { getRef } from "@/lib/provision/ref";
import { listFunctions, deployFunction } from "@/lib/provision/management";
import { readAccessToken } from "@/lib/provision/config-token";
import { saveDeployedHash } from "@/lib/provision/function-hashes";

export async function POST(request: Request): Promise<NextResponse> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) {
    return NextResponse.json(
      { ok: false, error: "Supabase env not configured" },
      { status: 503 }
    );
  }

  let body: { accessToken?: string; ref?: string; slug?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { accessToken, ref: bodyRef, slug: requestedSlug } = body;

  // Token: del body, o el guardado en runtime_config (centro de updates).
  let token = accessToken && typeof accessToken === "string" ? accessToken.trim() : "";
  if (!token && serviceRoleKey) token = (await readAccessToken(supabaseUrl, serviceRoleKey)) ?? "";
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "No hay token de Supabase (pegá uno o corré el wizard)." },
      { status: 400 }
    );
  }
  const ref = bodyRef?.trim() || getRef(supabaseUrl);
  const total = FUNCTIONS.length;

  try {
    // Determine which slug to deploy
    let slugToDeploy: string;

    if (requestedSlug) {
      // Caller explicitly requested a slug — validate it exists in our bundle
      const knownSlugs = FUNCTIONS.map((f) => f.slug);
      if (!knownSlugs.includes(requestedSlug)) {
        return NextResponse.json(
          { ok: false, error: `Unknown function slug: ${requestedSlug}` },
          { status: 400 }
        );
      }
      slugToDeploy = requestedSlug;
    } else {
      // Diff live list against our bundle to find the first missing slug
      const deployed = await listFunctions(ref, token);
      const deployedSlugs = new Set(deployed.map((f) => f.slug));

      // Sort alphabetically for deterministic order
      const allSlugs = FUNCTIONS.map((f) => f.slug).sort();
      const missingSlugs = allSlugs.filter((s) => !deployedSlugs.has(s));

      if (missingSlugs.length === 0) {
        // All functions already deployed
        return NextResponse.json({
          ok: true,
          deployed: null,
          count: total,
          total,
          done: true,
        });
      }

      slugToDeploy = missingSlugs[0];
    }

    // Find the function bundle
    const fn = FUNCTIONS.find((f) => f.slug === slugToDeploy);
    if (!fn) {
      return NextResponse.json(
        { ok: false, error: `Function bundle not found for slug: ${slugToDeploy}` },
        { status: 500 }
      );
    }

    // Deploy — verify_jwt:false is enforced inside deployFunction() (INVARIANT)
    await deployFunction(ref, token, fn.slug, fn.files, fn.entrypoint);

    // Registrar el hash desplegado para que el centro de updates sepa que esta
    // versión ya está al día.
    if (serviceRoleKey) {
      await saveDeployedHash(supabaseUrl, serviceRoleKey, fn.slug, fn.hash);
    }

    // Re-check deployed count after this deploy
    const nowDeployed = await listFunctions(ref, token).catch(() => [] as typeof FUNCTIONS);
    const nowDeployedSlugs = new Set(nowDeployed.map((f) => f.slug));
    const nowMissing = FUNCTIONS.map((f) => f.slug).filter(
      (s) => !nowDeployedSlugs.has(s)
    );
    const deployedCount = total - nowMissing.length;
    const done = nowMissing.length === 0;

    return NextResponse.json({
      ok: true,
      deployed: slugToDeploy,
      count: deployedCount,
      total,
      done,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[provision/functions/deploy] Error:", msg);
    return NextResponse.json(
      { ok: false, slug: requestedSlug ?? "unknown", error: msg },
      { status: 502 }
    );
  }
}
