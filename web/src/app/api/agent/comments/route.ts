import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Configuración de comentarios de Instagram en kommo_publish_config.
// Patrón: auth → validar → update kommo_publish_config where is_active.
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

  const update: Record<string, unknown> = {};

  if (typeof body.comment_reply_enabled === "boolean") {
    update.comment_reply_enabled = body.comment_reply_enabled;
  }

  if (body.comment_salesbot_id !== undefined) {
    const v = body.comment_salesbot_id;
    if (v === null || v === "") {
      update.comment_salesbot_id = null;
    } else {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        return NextResponse.json({ error: "comment_salesbot_id debe ser un número positivo" }, { status: 400 });
      }
      update.comment_salesbot_id = n;
    }
  }

  if (body.comment_field_id !== undefined) {
    const v = body.comment_field_id;
    if (v === null || v === "") {
      update.comment_field_id = null;
    } else {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        return NextResponse.json({ error: "comment_field_id debe ser un número positivo" }, { status: 400 });
      }
      update.comment_field_id = n;
    }
  }

  if (body.comment_reply_rules !== undefined) {
    const rulesStr = String(body.comment_reply_rules ?? "").trim();
    if (rulesStr.length > 1000) {
      return NextResponse.json({ error: "comment_reply_rules no puede superar 1000 caracteres" }, { status: 400 });
    }
    update.comment_reply_rules = rulesStr || null;
  }

  if (body.comment_instructions !== undefined) {
    update.comment_instructions = String(body.comment_instructions ?? "").trim() || null;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "sin cambios" }, { status: 400 });
  }

  const { error } = await supabase
    .from("kommo_publish_config")
    .update(update)
    .eq("is_active", true);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
