import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Switches del ruteo de leads (singleton kommo_publish_config, 0052):
//   routing_enabled            → kill switch del módulo
//   routing_takeover_user_ids  → usuarios de Kommo que NO cuentan como dueño
//                                real (cuentas genéricas). Un lead con uno de
//                                ellos como responsable se puede reasignar.
//   routing_min_confidence     → confianza mínima de la clasificación para
//                                tocar el CRM (0-1).
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const update: Record<string, unknown> = {};

  if (typeof body.routing_enabled === "boolean") {
    update.routing_enabled = body.routing_enabled;
  }
  if (body.routing_min_confidence !== undefined) {
    const n = Number(body.routing_min_confidence);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return NextResponse.json(
        { error: "routing_min_confidence debe estar entre 0 y 1" },
        { status: 400 }
      );
    }
    update.routing_min_confidence = Math.round(n * 100) / 100;
  }
  if (body.routing_takeover_user_ids !== undefined) {
    const ids = Array.isArray(body.routing_takeover_user_ids)
      ? body.routing_takeover_user_ids
      : [];
    update.routing_takeover_user_ids = Array.from(
      new Set(ids.map((n: unknown) => Number(n)).filter((n: number) => Number.isFinite(n) && n > 0))
    );
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "nada para actualizar" }, { status: 400 });
  }

  const { error } = await supabase
    .from("kommo_publish_config")
    .update(update)
    .eq("is_active", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
