import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { syncAgentTools } from "@/lib/sync-agent-tools";

// nodejs runtime — syncAgentTools llama a Anthropic.
export const runtime = "nodejs";

// Gate de las acciones de Shopify (Módulo 4). Instantáneo a runtime
// (generate-response lee los flags con TTL 60s) + sync idempotente que registra
// las tools internas de Shopify en Anthropic la primera vez que se activa una.
const FIELDS = new Set([
  "shopify_actions_enabled",
  "shopify_can_search",
  "shopify_can_orders",
  "shopify_can_checkout",
]);

export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const patch: Record<string, boolean> = {};
  if (typeof body.field === "string" && FIELDS.has(body.field)) {
    patch[body.field] = body.value === true;
  } else {
    for (const [k, v] of Object.entries(body)) {
      if (FIELDS.has(k)) patch[k] = v === true;
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "sin flags válidos para actualizar" }, { status: 400 });
  }

  // Apagar el master apaga todo.
  if ("shopify_actions_enabled" in patch && patch.shopify_actions_enabled === false) {
    patch.shopify_can_search = false;
    patch.shopify_can_orders = false;
    patch.shopify_can_checkout = false;
  }

  const { error } = await supabase
    .from("kommo_publish_config")
    .update(patch)
    .eq("is_active", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const sync = await syncAgentTools(user.email ?? "dashboard").catch((e) => ({
    synced: false,
    version: null,
    error: String(e),
  }));

  return NextResponse.json({ ok: true, applied: patch, sync });
}
