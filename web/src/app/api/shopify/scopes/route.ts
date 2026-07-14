import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getShopifyScopes } from "@/lib/shopify";

export const runtime = "nodejs";

// GET /api/shopify/scopes — devuelve los permisos REALES concedidos a la app de
// Shopify en la tienda (no los que la app pide). El dashboard lo usa para avisar
// si se activa una tool sin el scope correspondiente.
export async function GET() {
  const authClient = createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  // Siempre 200 con { ok, ... }: el cliente lee j.ok y muestra el error inline.
  const r = await getShopifyScopes();
  return NextResponse.json(r);
}
