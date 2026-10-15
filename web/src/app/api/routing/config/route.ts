import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

const RoutingConfigBody = z.object({
  routing_enabled: z.boolean().optional(),
  routing_min_confidence: z.number().optional(),
  routing_takeover_user_ids: z.array(z.unknown()).optional(),
});

// Switches del ruteo de leads (singleton kommo_publish_config, 0052):
//   routing_enabled            → kill switch del módulo
//   routing_takeover_user_ids  → usuarios de Kommo que NO cuentan como dueño
//                                real (cuentas genéricas). Un lead con uno de
//                                ellos como responsable se puede reasignar.
//   routing_min_confidence     → confianza mínima de la clasificación para
//                                tocar el CRM (0-1).
export async function POST(request: Request) {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;
  const { supabase } = auth;

  const input = await readJson(request, RoutingConfigBody);
  if (!input.ok) return input.response;
  const body = input.data;
  const update: Record<string, unknown> = {};

  if (body.routing_enabled !== undefined) {
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
    const ids = body.routing_takeover_user_ids;
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
