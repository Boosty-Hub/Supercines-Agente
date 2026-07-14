import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { setConfigValues } from "@/lib/runtime-config";
import { syncAgentTools } from "@/lib/sync-agent-tools";

// nodejs runtime — syncAgentTools llama a Anthropic.
export const runtime = "nodejs";

// Gate + fuente de la tool interna tasa_bcv (Módulo 5).
//   - enabled → kommo_publish_config.bcv_rate_enabled (runtime, TTL 60s en edge)
//   - url/apiKey → runtime_config BCV_RATE_URL / BCV_RATE_APIKEY (fuente custom;
//     vacío = usar el fallback público sin credenciales)
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

  if (typeof body.enabled === "boolean") {
    const { error } = await supabase
      .from("kommo_publish_config")
      .update({ bcv_rate_enabled: body.enabled })
      .eq("is_active", true);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Solo https y URL parseable — el fetch de la tasa corre server-side (web y
  // edge); mismo nivel de confianza que las HTTP tools del operador, pero sin
  // esquemas raros (http/file/etc.).
  if (typeof body.url === "string" && body.url.trim() !== "") {
    try {
      const parsed = new URL(body.url.trim());
      if (parsed.protocol !== "https:") throw new Error("solo https");
    } catch {
      return NextResponse.json(
        { error: "URL inválida: debe ser una URL https válida." },
        { status: 400 }
      );
    }
  }

  if (body.url !== undefined || body.apiKey !== undefined) {
    await setConfigValues(
      {
        ...(body.url !== undefined ? { BCV_RATE_URL: String(body.url).trim() } : {}),
        ...(body.apiKey !== undefined ? { BCV_RATE_APIKEY: String(body.apiKey).trim() } : {}),
      },
      user.email ?? "dashboard"
    );
  }

  // Registra la tool en Anthropic la primera vez que se activa (idempotente).
  const sync = await syncAgentTools(user.email ?? "dashboard").catch((e) => ({
    synced: false,
    version: null,
    error: String(e),
  }));

  return NextResponse.json({ ok: true, sync });
}
