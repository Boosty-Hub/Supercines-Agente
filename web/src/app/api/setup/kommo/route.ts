import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { createServiceClient } from "@/lib/supabase/service";
import { setConfigValues } from "@/lib/runtime-config";
import { normalizeHost } from "@/lib/http-tool-keys";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

// accessToken es un secreto: los errores de forma nunca incluyen su valor.
const KommoSetupBody = z.object({
  subdomain: z.string().optional(),
  apiDomain: z.string().optional(),
  accessToken: z.string().optional(),
  clientId: z.string().optional(),
  responseCustomFieldId: z.string().optional(),
  salesbotId: z.string().optional(),
});

// Run on Node (not Edge) for consistent fetch/runtime behavior on Netlify.
export const runtime = "nodejs";

// Decode a JWT payload without verifying the signature (we only need exp /
// account_id / scopes; the token is verified for real against the Kommo API).
function decodeJwt(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length < 2) throw new Error("Token Kommo malformado (no es un JWT)");
  const json = Buffer.from(parts[1], "base64url").toString("utf-8");
  return JSON.parse(json) as Record<string, unknown>;
}

// Step 4: verify the Kommo long-lived token, upsert kommo_credentials, and write
// KOMMO_* to runtime_config. Ports scripts/save-kommo-credentials.mjs MINUS the
// Management-API secret push — Edge Functions read these from runtime_config now.
export async function POST(request: Request) {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;

  const input = await readJson(request, KommoSetupBody);
  if (!input.ok) return input.response;
  const body = input.data;

  const str = (k: keyof typeof body) => body[k]?.trim() ?? "";
  // Accept just the subdomain ("miempresa"); derive the api domain from it.
  // apiDomain is still accepted for back-compat but optional.
  const subdomain = str("subdomain").replace(/\.kommo\.com.*$/i, "").toLowerCase();
  const rawApiDomain = str("apiDomain") || (subdomain ? `${subdomain}.kommo.com` : "");
  const accessToken = str("accessToken");
  const clientId = str("clientId") || "long-lived-token";
  // Optional response config (the wizard can set these here too). Persisted to
  // kommo_publish_config so the agent knows where to write + which bot sends it.
  const responseFieldId = str("responseCustomFieldId");
  const salesbotId = str("salesbotId");

  const missing: string[] = [];
  if (!subdomain) missing.push("subdomain");
  if (!accessToken) missing.push("accessToken");
  if (missing.length) {
    return NextResponse.json(
      { ok: false, error: `Faltan: ${missing.join(", ")}` },
      { status: 400 }
    );
  }
  // El token viaja a KOMMO_API_DOMAIN (API, http tools): tiene que ser un dominio atable, el
  // mismo que valida lib/http-tool-keys.ts (sin rutas, puertos, IPs ni caracteres ambiguos).
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
    return NextResponse.json({ ok: false, error: "Subdominio de Kommo inválido." }, { status: 400 });
  }
  const apiDomain = normalizeHost(rawApiDomain);
  if (!apiDomain || apiDomain !== rawApiDomain.toLowerCase()) {
    return NextResponse.json({ ok: false, error: "api_domain de Kommo inválido: debe ser un dominio (p. ej. miempresa.kommo.com)." }, { status: 400 });
  }

  // Decode claims.
  let claims: Record<string, unknown>;
  try {
    claims = decodeJwt(accessToken);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
  const exp = typeof claims.exp === "number" ? claims.exp : Number(claims.exp);
  if (!exp || Number.isNaN(exp)) {
    return NextResponse.json(
      { ok: false, error: "El token no tiene claim 'exp' válido" },
      { status: 400 }
    );
  }
  const expiresAt = new Date(exp * 1000).toISOString();
  const accountId =
    typeof claims.account_id === "number" ? claims.account_id : Number(claims.account_id);
  const scopes = Array.isArray(claims.scopes) ? (claims.scopes as string[]).join(",") : null;

  // Verify the token against the live Kommo API.
  try {
    const accountRes = await fetch(`https://${apiDomain}/api/v4/account`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "manual", // el token no sigue un 302 a otro host
    });
    if (!accountRes.ok) {
      return NextResponse.json(
        { ok: false, error: `Kommo respondió HTTP ${accountRes.status} — token inválido o api_domain incorrecto` },
        { status: 400 }
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: `No se pudo contactar Kommo: ${msg}` }, { status: 400 });
  }

  // Persist credentials (service-role client bypasses RLS).
  const service = createServiceClient();

  // Deactivate previous active row (unique partial index allows one active).
  const { error: deactErr } = await service
    .from("kommo_credentials")
    .update({ is_active: false })
    .eq("is_active", true);
  if (deactErr) {
    return NextResponse.json({ ok: false, error: `deactivate: ${deactErr.message}` }, { status: 500 });
  }

  const { data: inserted, error: insErr } = await service
    .from("kommo_credentials")
    .insert({
      subdomain,
      api_domain: apiDomain,
      client_id: clientId,
      encrypted_access_token: accessToken,
      encrypted_refresh_token: null,
      token_expires_at: expiresAt,
      account_id: Number.isNaN(accountId) ? null : accountId,
      scope: scopes,
      is_active: true,
    })
    .select("id")
    .single();
  if (insErr) {
    return NextResponse.json({ ok: false, error: `insert: ${insErr.message}` }, { status: 500 });
  }

  try {
    await setConfigValues(
      {
        KOMMO_SUBDOMAIN: subdomain,
        KOMMO_API_DOMAIN: apiDomain,
        KOMMO_ACCESS_TOKEN: accessToken,
      },
      auth.writer
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }

  // Optional: persist the response config (custom field + salesbot) if provided.
  const publishUpdate: Record<string, number> = {};
  const fieldNum = Number(responseFieldId);
  const botNum = Number(salesbotId);
  if (responseFieldId && !Number.isNaN(fieldNum)) publishUpdate.response_custom_field_id = fieldNum;
  if (salesbotId && !Number.isNaN(botNum)) publishUpdate.salesbot_id = botNum;
  if (Object.keys(publishUpdate).length > 0) {
    await service.from("kommo_publish_config").update(publishUpdate).eq("is_active", true);
  }

  return NextResponse.json({
    ok: true,
    credentialId: inserted?.id ?? null,
    expiresAt,
    accountId: Number.isNaN(accountId) ? null : accountId,
  });
}
