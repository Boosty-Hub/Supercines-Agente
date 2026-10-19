// INVARIANT: this route MUST NOT import @/lib/runtime-config or
// @/lib/supabase/service. It uses the provision lib layer only.
// INVARIANT: verify_jwt:false MUST be passed in every deployFunction call.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { FUNCTIONS } from "@/lib/provision/functions.generated";
import { listFunctions, deployFunction } from "@/lib/provision/management";
import { readAccessToken } from "@/lib/provision/config-token";
import { readDeployedHashes, saveDeployedHash } from "@/lib/provision/function-hashes";
import { authorizeProvision } from "@/lib/provision/gate";
import { pendingFunctionSlugs, pickProvisionToken, provisionRef } from "@/lib/provision/gate-logic";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

// accessToken (sbp_, secreto de la CUENTA de Supabase): nunca aparece en un mensaje de error.
const DeployBody = z.object({ accessToken: z.string().optional(), slug: z.string().optional() });

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
  const gate = await authorizeProvision(supabaseUrl, serviceRoleKey);
  if (!gate.ok) return gate.response;

  const input = await readJson(request, DeployBody);
  if (!input.ok) return input.response;
  const body = input.data;
  const requestedSlug = body.slug || undefined;

  // Token: del body, o el guardado en runtime_config SOLO con sesión (centro de updates).
  const stored = gate.mode === "session" ? await readAccessToken(supabaseUrl, serviceRoleKey) : null;
  const picked = pickProvisionToken(gate.mode, body.accessToken, stored);
  if (!picked.ok) return NextResponse.json({ ok: false, error: picked.error }, { status: 400 });
  const token = picked.token;
  // El proyecto es SIEMPRE el de este despliegue: un `ref` en el body se ignora.
  const ref = provisionRef(supabaseUrl);
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
      // Pendiente = no desplegada o desplegada con OTRA versión (hash registrado distinto o
      // ausente). Con solo «falta en vivo», una función desplegada fuera del wizard (CLI) sin hash
      // registrado quedaba «hecha» acá y «faltante» para /status, y el /first-run no avanzaba.
      // Orden de FUNCTIONS = DEPLOY_ORDER (scripts/lib/function-bundles.mjs): invocadores
      // antes que invocados, para que ninguna función empiece a exigir el secreto
      // interno antes de que quienes la llaman lo manden. NO ordenar alfabéticamente.
      const deployed = await listFunctions(ref, token);
      const pending = pendingFunctionSlugs(
        FUNCTIONS,
        new Set(deployed.map((f) => f.slug)),
        await readDeployedHashes(supabaseUrl, serviceRoleKey)
      );

      if (pending.length === 0) {
        return NextResponse.json({
          ok: true,
          deployed: null,
          count: total,
          total,
          done: true,
        });
      }

      slugToDeploy = pending[0];
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

    // Registrar el hash desplegado para que el centro de updates (y /status del
    // first-run) sepan que esta versión ya está al día. Si no se puede registrar,
    // es un error: sin el registro el first-run no vería la función como hecha.
    await saveDeployedHash(supabaseUrl, serviceRoleKey, fn.slug, fn.hash);

    // Re-check after this deploy
    const nowDeployed = await listFunctions(ref, token).catch(() => []);
    const nowPending = pendingFunctionSlugs(
      FUNCTIONS,
      new Set(nowDeployed.map((f) => f.slug)),
      await readDeployedHashes(supabaseUrl, serviceRoleKey)
    );
    const deployedCount = total - nowPending.length;
    const done = nowPending.length === 0;

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
