import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { configValue, setConfigValues } from "@/lib/runtime-config";

// Habilita/deshabilita que el agente responda a adjuntos del lead.
// images/documents son nativos en Claude. audio requiere transcripción
// externa (OpenAI Whisper): para activarlo hace falta una OPENAI_API_KEY
// en runtime_config (se puede mandar acá mismo como body.openaiKey).
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const update: Record<string, unknown> = {};
  if (typeof body.images === "boolean") update.respond_to_images = body.images;
  if (typeof body.documents === "boolean") update.respond_to_documents = body.documents;

  if (typeof body.audio === "boolean") {
    if (body.audio === true) {
      // Guardar la key si vino en el request; si no, exigir que ya exista.
      const incomingKey = typeof body.openaiKey === "string" ? body.openaiKey.trim() : "";
      if (incomingKey) {
        if (!incomingKey.startsWith("sk-")) {
          return NextResponse.json(
            { error: "La key de OpenAI no parece válida (debe empezar con sk-)" },
            { status: 400 }
          );
        }
        await setConfigValues({ OPENAI_API_KEY: incomingKey }, user.email ?? "dashboard");
      } else {
        const existing = await configValue("OPENAI_API_KEY");
        if (!existing) {
          return NextResponse.json(
            { error: "Para activar audios hace falta la API key de OpenAI (Whisper)" },
            { status: 400 }
          );
        }
      }
    }
    update.respond_to_audio = body.audio;
  }

  if (Object.keys(update).length === 0) return NextResponse.json({ ok: true });

  const { error } = await supabase
    .from("kommo_publish_config")
    .update(update)
    .eq("is_active", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
