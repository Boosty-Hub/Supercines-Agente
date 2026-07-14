import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Publicación Kommo (Config → Kommo): campo destino + salesbot del reply principal.
// Los switches de encendido/publicación/revisión viven ahora en Agente →
// "Encendido y publicación" (POST /api/agent/publish); acá NO se tocan para no
// pisarlos al guardar el campo/salesbot.
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await request.formData();
  const fieldId = form.get("response_custom_field_id")?.toString().trim();
  const botId = form.get("salesbot_id")?.toString().trim();

  const update: Record<string, unknown> = {
    response_custom_field_id: fieldId ? Number(fieldId) : null,
    salesbot_id: botId ? Number(botId) : null,
  };

  // Go-live (idempotente): si el sistema YA está en producción (publishing_enabled)
  // y recién ahora se carga el salesbot, estampamos la línea de corte publish_from
  // para que los borradores de validación viejos NUNCA se disparen. El otro disparo
  // (activar publishing con salesbot ya cargado) vive en /api/agent/publish.
  const { data: current } = await supabase
    .from("kommo_publish_config")
    .select("publishing_enabled, publish_from")
    .eq("is_active", true)
    .maybeSingle();
  if (current?.publishing_enabled && botId && !current?.publish_from) {
    update.publish_from = new Date().toISOString();
  }

  const { error } = await supabase
    .from("kommo_publish_config")
    .update(update)
    .eq("is_active", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.redirect(new URL("/config/kommo?saved=1", request.url), { status: 303 });
}
