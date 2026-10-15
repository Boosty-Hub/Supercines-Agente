import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { configValue, setConfigValues } from "@/lib/runtime-config";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

// openaiKey es un secreto: el mensaje de error de un body inválido nunca incluye su valor.
const MediaBody = z.object({
  images: z.boolean().optional(),
  documents: z.boolean().optional(),
  audio: z.boolean().optional(),
  openaiKey: z.string().optional(),
});

// Habilita/deshabilita que el agente responda a adjuntos del lead.
// images/documents son nativos en Claude. audio requiere transcripción
// externa (OpenAI Whisper): para activarlo hace falta una OPENAI_API_KEY
// en runtime_config (se puede mandar acá mismo como body.openaiKey).
export async function POST(request: Request) {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;
  const { supabase } = auth;

  const input = await readJson(request, MediaBody);
  if (!input.ok) return input.response;
  const body = input.data;
  const update: Record<string, unknown> = {};
  if (typeof body.images === "boolean") update.respond_to_images = body.images;
  if (typeof body.documents === "boolean") update.respond_to_documents = body.documents;

  if (typeof body.audio === "boolean") {
    if (body.audio === true) {
      // Guardar la key si vino en el request; si no, exigir que ya exista.
      const incomingKey = body.openaiKey?.trim() ?? "";
      if (incomingKey) {
        if (!incomingKey.startsWith("sk-")) {
          return NextResponse.json(
            { error: "La key de OpenAI no parece válida (debe empezar con sk-)" },
            { status: 400 }
          );
        }
        await setConfigValues({ OPENAI_API_KEY: incomingKey }, auth.writer);
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
