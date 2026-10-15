import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

// La ruta coerciona a enteros (0 = desactivado; ventana mínima 1h).
const LimitsBody = z.object({
  cooldown: z.union([z.number(), z.string()]).optional(),
  max: z.union([z.number(), z.string()]).optional(),
  window: z.union([z.number(), z.string()]).optional(),
});

// Persiste los límites de respuesta por lead en el singleton kommo_publish_config.
// Enteros no negativos; ventana mínima 1h. 0 = desactivado (cooldown / tope).
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const input = await readJson(request, LimitsBody);
  if (!input.ok) return input.response;
  const body = input.data;
  const cooldown = Math.max(0, Math.trunc(Number(body.cooldown) || 0));
  const max = Math.max(0, Math.trunc(Number(body.max) || 0));
  const windowH = Math.max(1, Math.trunc(Number(body.window) || 24));

  const { error } = await supabase
    .from("kommo_publish_config")
    .update({
      response_cooldown_seconds: cooldown,
      max_responses_per_lead: max,
      cooldown_window_hours: windowH,
    })
    .eq("is_active", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
