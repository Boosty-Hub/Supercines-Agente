import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fromReviewMode, asReviewMode } from "@/lib/review-mode";

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
const BOOL_FIELDS = ["system_halted", "agent_enabled", "publishing_enabled"] as const;
type BoolField = (typeof BOOL_FIELDS)[number];
type Field = BoolField | "review_mode";

function isBoolField(value: unknown): value is BoolField {
  return typeof value === "string" && (BOOL_FIELDS as readonly string[]).includes(value);
}

export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const field = body?.field as Field | undefined;
  const value = body?.value;

  if (field === "system_halted") {
    if (typeof value !== "boolean") {
      return NextResponse.json({ error: "payload inválido" }, { status: 400 });
    }
    const update: Record<string, unknown> = { system_halted: value };
    // halted_at/halted_by se estampan solo al PRENDER — se conservan después
    // de reactivar (columna comentada en la migración) para reconstruir el
    // incidente; no hace falta borrarlos al apagar el switch.
    if (value) {
      update.halted_at = new Date().toISOString();
      update.halted_by = user.id;
    }
    const { error } = await supabase.from("kommo_publish_config").update(update).eq("is_active", true);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (field === "review_mode") {
    if (typeof value !== "string" || !["todo", "normal", "sin"].includes(value)) {
      return NextResponse.json({ error: "payload inválido" }, { status: 400 });
    }
    const mode = asReviewMode(value);

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

  if (!isBoolField(field) || typeof value !== "boolean") {
    return NextResponse.json({ error: "payload inválido" }, { status: 400 });
  }

  if (field === "agent_enabled") {
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
