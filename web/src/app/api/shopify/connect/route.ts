import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { setConfigValues } from "@/lib/runtime-config";
import {
  validateShopifyConnection,
  exchangeShopifyToken,
  normalizeShopDomain,
  DEFAULT_SHOPIFY_API_VERSION,
} from "@/lib/shopify";

// nodejs runtime — llama a la Admin API de Shopify para validar.
export const runtime = "nodejs";

// Conecta (o desconecta) Shopify. Dos modos:
//   - clientId + clientSecret (apps del Dev Dashboard 2026+): canjea el token vía
//     client credentials grant para validar, y guarda LAS CREDENCIALES (no el
//     token, que expira a las 24h) en runtime_config.
//   - token estático legacy (shpat_ de custom apps viejas): valida y guarda como antes.
// En ambos casos valida con un { shop { name } } antes de persistir.
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  // Desconectar: limpia las credenciales (ambos modos).
  if (body.disconnect === true) {
    await setConfigValues(
      {
        SHOPIFY_STORE_DOMAIN: "",
        SHOPIFY_ACCESS_TOKEN: "",
        SHOPIFY_CLIENT_ID: "",
        SHOPIFY_CLIENT_SECRET: "",
      },
      user.email ?? "dashboard"
    );
    return NextResponse.json({ ok: true, disconnected: true });
  }

  const domain = normalizeShopDomain(String(body.domain ?? ""));
  const token = String(body.token ?? "").trim();
  const clientId = String(body.clientId ?? "").trim();
  const clientSecret = String(body.clientSecret ?? "").trim();
  const version = String(body.version ?? "").trim() || DEFAULT_SHOPIFY_API_VERSION;

  if (!domain) return NextResponse.json({ ok: false, error: "Falta el dominio de la tienda." }, { status: 400 });
  // Estricto: exactamente <slug>.myshopify.com — evita dominios custom (la Admin
  // API no vive ahí) y hosts arbitrarios que terminen en .myshopify.com.
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
    return NextResponse.json(
      { ok: false, error: "Usá el dominio .myshopify.com de la tienda (no el dominio propio)." },
      { status: 400 }
    );
  }

  // Modo client credentials (Dev Dashboard 2026+).
  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) {
      return NextResponse.json(
        { ok: false, error: "Faltan el Client ID o el Client Secret." },
        { status: 400 }
      );
    }
    const grant = await exchangeShopifyToken(domain, clientId, clientSecret);
    if (!grant.ok) return NextResponse.json({ ok: false, error: grant.error }, { status: 400 });

    const check = await validateShopifyConnection(domain, grant.token, version);
    if (!check.ok) return NextResponse.json({ ok: false, error: check.error }, { status: 400 });

    await setConfigValues(
      {
        SHOPIFY_STORE_DOMAIN: domain,
        SHOPIFY_CLIENT_ID: clientId,
        SHOPIFY_CLIENT_SECRET: clientSecret,
        SHOPIFY_ACCESS_TOKEN: "", // el token vigente se canjea on-demand, nunca se persiste
        SHOPIFY_API_VERSION: version,
      },
      user.email ?? "dashboard"
    );
    return NextResponse.json({ ok: true, shopName: check.shopName, domain });
  }

  // Modo legacy: token estático shpat_ de una custom app vieja.
  if (!token) return NextResponse.json({ ok: false, error: "Falta el token de Shopify." }, { status: 400 });

  const check = await validateShopifyConnection(domain, token, version);
  if (!check.ok) return NextResponse.json({ ok: false, error: check.error }, { status: 400 });

  await setConfigValues(
    {
      SHOPIFY_STORE_DOMAIN: domain,
      SHOPIFY_ACCESS_TOKEN: token,
      SHOPIFY_CLIENT_ID: "",
      SHOPIFY_CLIENT_SECRET: "",
      SHOPIFY_API_VERSION: version,
    },
    user.email ?? "dashboard"
  );

  return NextResponse.json({ ok: true, shopName: check.shopName, domain });
}
