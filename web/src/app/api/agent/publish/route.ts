import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Gate de encendido y publicación del agente (Módulo "Agente" → tarjeta
// "Encendido y publicación"). Consolida en un solo lugar los tres switches que
// antes vivían en el form de Kommo:
//   - agent_enabled     → kill switch global (sin él no se genera nada).
//   - publishing_enabled→ Validación (shadow) vs Producción (publica a Kommo).
//   - review_mode       → tri-estado que fusiona auto_reply_mode + bypass_review:
//        "todo"   → auto_reply_mode=review_only, bypass=false  (todo a revisión)
//        "normal" → auto_reply_mode=auto,        bypass=false  (flujo normal)
//        "sin"    → auto_reply_mode=auto,        bypass=true   (publica sin revisión)
// Acepta un patch parcial: la ruta lee la fila actual y deriva el resto, así el
// cliente no necesita conocer el salesbot ni el estado completo.
//
// INVARIANTES preservados (CLAUDE.md #4):
//   - bypass_review solo puede quedar true si publishing_enabled=true.
//   - publish_from (línea de corte go-live) se estampa UNA sola vez, cuando el
//     sistema queda por primera vez habilitado para publicar de verdad
//     (publishing_enabled=true Y salesbot_id cargado Y publish_from null).
//     Como el disparo se reparte entre este route (setea publishing) y
//     /api/settings/kommo (setea salesbot), ambos hacen el chequeo idempotente.

type ReviewMode = "todo" | "normal" | "sin";

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

  const { data: current } = await supabase
    .from("kommo_publish_config")
    .select("agent_enabled, publishing_enabled, bypass_review, auto_reply_mode, salesbot_id, publish_from")
    .eq("is_active", true)
    .maybeSingle();

  // Estado actual como base; el patch pisa solo lo que venga.
  const agentEnabled =
    typeof body.agent_enabled === "boolean" ? body.agent_enabled : current?.agent_enabled ?? true;
  const publishing =
    typeof body.publishing_enabled === "boolean"
      ? body.publishing_enabled
      : current?.publishing_enabled ?? false;

  // review_mode: si viene en el patch se usa; si no, se deriva del estado actual.
  const currentReview: ReviewMode =
    current?.bypass_review && current?.publishing_enabled
      ? "sin"
      : current?.auto_reply_mode === "review_only"
        ? "todo"
        : "normal";
  const reviewRaw = typeof body.review_mode === "string" ? body.review_mode : currentReview;
  const reviewMode: ReviewMode =
    reviewRaw === "todo" || reviewRaw === "sin" ? reviewRaw : "normal";

  const update: Record<string, unknown> = {
    agent_enabled: agentEnabled,
    publishing_enabled: publishing,
    auto_reply_mode: reviewMode === "todo" ? "review_only" : "auto",
    // bypass solo puede quedar true con publishing on.
    bypass_review: reviewMode === "sin" && publishing,
  };

  // Go-live: estampar publish_from la primera vez que quede habilitado para
  // publicar de verdad (publishing on + salesbot cargado) y aún sin corte.
  if (publishing && current?.salesbot_id && !current?.publish_from) {
    update.publish_from = new Date().toISOString();
  }

  const { error } = await supabase
    .from("kommo_publish_config")
    .update(update)
    .eq("is_active", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, applied: update });
}
