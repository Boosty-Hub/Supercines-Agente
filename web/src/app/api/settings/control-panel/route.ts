import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fromReviewMode, asReviewMode } from "@/lib/review-mode";
import { truncateGraphemes } from "@/lib/text-safe";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

// Los interruptores críticos del Panel de control (Ajustes → arriba de las
// pestañas), cada uno se guarda al toque desde el cliente — sin formulario
// grande ni recarga de página. Reemplaza /api/agent/publish (borrada): ese
// route guardaba agent_enabled/publishing_enabled/review_mode juntos, en un
// solo POST con el estado completo; acá cada switch viaja solo.
//
// `system_halted` se lee/escribe en su PROPIA rama, sin tocar el select de
// los otros tres campos: si la migración que agrega la columna todavía no se
// aplicó en este proyecto, el resto del panel (agente/publicación/revisión)
// tiene que seguir funcionando — el switch de Apagado total ya llega
// deshabilitado desde el server component (ver settings/page.tsx).
const ControlPanelBody = z.discriminatedUnion("field", [
  z.object({
    field: z.literal("system_halted"),
    value: z.boolean(),
    // Motivo opcional al detener el sistema.
    reason: z.string().optional(),
  }),
  z.object({ field: z.literal("agent_enabled"), value: z.boolean() }),
  z.object({ field: z.literal("publishing_enabled"), value: z.boolean() }),
  z.object({ field: z.literal("review_mode"), value: z.enum(["todo", "normal", "sin"]) }),
]);

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const input = await readJson(request, ControlPanelBody);
  if (!input.ok) return input.response;
  const body = input.data;

  if (body.field === "system_halted") {
    const value = body.value;
    const update: Record<string, unknown> = { system_halted: value };
    // halted_at/halted_by se estampan solo al PRENDER — se conservan después
    // de reactivar (columna comentada en la migración) para reconstruir el
    // incidente; no hace falta borrarlos al apagar el switch.
    if (value) {
      update.halted_at = new Date().toISOString();
      update.halted_by = user.id;
      const reason = body.reason ? truncateGraphemes(body.reason.trim(), 500) : "";
      update.halted_reason = reason || null;
    }
    const { error } = await supabase.from("kommo_publish_config").update(update).eq("is_active", true);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (body.field === "review_mode") {
    const mode = asReviewMode(body.value);

    const { data: current, error: readError } = await supabase
      .from("kommo_publish_config")
      .select("publishing_enabled")
      .eq("is_active", true)
      .maybeSingle();
    if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });

    const publishing = current?.publishing_enabled === true;
    if (mode === "sin" && !publishing) {
      return NextResponse.json(
        { error: "Activá primero “Publicar respuestas en Kommo”." },
        { status: 400 }
      );
    }

    const update = fromReviewMode(mode, publishing);
    const { error } = await supabase.from("kommo_publish_config").update(update).eq("is_active", true);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  const value = body.value;

  if (body.field === "agent_enabled") {
    const { error } = await supabase
      .from("kommo_publish_config")
      .update({ agent_enabled: value })
      .eq("is_active", true);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  // field === "publishing_enabled"
  const { data: current, error: readError } = await supabase
    .from("kommo_publish_config")
    .select("salesbot_id, publish_from")
    .eq("is_active", true)
    .maybeSingle();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });

  const update: Record<string, unknown> = { publishing_enabled: value };
  if (!value) {
    // Apagar publicación también apaga "sin revisión": bypass_review solo
    // tiene sentido con publishing activo. Se fuerza acá, server-side, en la
    // MISMA escritura — antes esto vivía derivado en el cliente (que mandaba
    // agent_enabled + publishing_enabled + review_mode juntos en un solo
    // POST); ahora cada switch se guarda por separado, así que si no se
    // fuerza acá, "sin revisión" queda pegado en true hasta que alguien abra
    // la pestaña de revisión y lo cambie a mano.
    update.bypass_review = false;
  } else {
    // Línea de corte de publicación (go-live): la primera vez que publishing
    // queda habilitado de verdad (con salesbot ya cargado) y no hay corte
    // previo, se estampa "desde ahora" para que los borradores viejos de
    // validación nunca se disparen.
    if (current?.salesbot_id && !current?.publish_from) {
      update.publish_from = new Date().toISOString();
    }
  }

  const { error } = await supabase.from("kommo_publish_config").update(update).eq("is_active", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
