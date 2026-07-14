import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { configValue } from "@/lib/runtime-config";
import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { recordWebUsage } from "@/lib/usage";

// nodejs runtime: the Anthropic path returns spurious 401s on Netlify's Edge.
export const runtime = "nodejs";

// Tiny, fast structured call (two short strings) — no timeout risk. Suggests
// the operator name and the dashboard label from a business description, so the
// AI assistant can fill those fields too (the prompt itself is built by the
// streaming /generate-agent route).
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!description) {
    return NextResponse.json({ ok: false, error: "Falta la descripción." }, { status: 400 });
  }

  const apiKey = await configValue("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "Configurá primero la API key de Anthropic." },
      { status: 400 }
    );
  }

  try {
    const anthropic = createAnthropic({ apiKey });
    const { object, usage } = await generateObject({
      model: anthropic("claude-sonnet-4-6"),
      schema: z.object({
        operatorName: z
          .string()
          .describe(
            "Nombre corto de la marca/empresa o persona detrás del agente, tal como debe aparecer cuando el agente habla (ej: 'SUPERCINES', 'María de CursosIngles')"
          ),
        agentLabel: z
          .string()
          .describe(
            "Nombre corto y amigable para mostrar en el panel/dashboard (ej: 'Agente SUPERCINES', 'Asistente de Ventas')"
          ),
      }),
      prompt: `Del siguiente negocio, extraé el nombre del operador/marca y un nombre para el panel.\n\n${description}`,
    });
    await recordWebUsage({ component: "dashboard_suggest_identity", model: "claude-sonnet-4-6", usage });
    return NextResponse.json({ ok: true, ...object });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
