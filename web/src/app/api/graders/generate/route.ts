import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { configValue } from "@/lib/runtime-config";
import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { recordWebUsage } from "@/lib/usage";

// nodejs runtime: the Anthropic path returns spurious 401s on Netlify's Edge.
export const runtime = "nodejs";
export const maxDuration = 60;

// Build (or refine) ONE LLM-judge grader from a free-text instruction, grounded
// in the saved agent context. Used both when CREATING a new grader and when
// EDITING one (pass `current` so the model refines instead of starting blank).
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

  const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
  if (!instruction) {
    return NextResponse.json(
      { ok: false, error: "Describí qué querés medir con este grader." },
      { status: 400 }
    );
  }

  // Optional: the grader currently being edited (so the model refines it).
  const current = (body.current ?? null) as {
    name?: string;
    description?: string;
    prompt?: string;
    scale?: string;
  } | null;

  const [apiKey, systemPrompt, operatorName] = await Promise.all([
    configValue("ANTHROPIC_API_KEY"),
    configValue("SYSTEM_PROMPT"),
    configValue("OPERATOR_NAME"),
  ]);

  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "Configurá primero la API key de Anthropic." },
      { status: 400 }
    );
  }

  const context = [
    operatorName ? `Operador / marca: ${operatorName}` : "",
    systemPrompt ? `System prompt del agente:\n${systemPrompt}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const currentBlock = current
    ? `GRADER ACTUAL (refinálo, no empieces de cero):
nombre: ${current.name ?? ""}
descripción: ${current.description ?? ""}
escala: ${current.scale ?? "numeric_0_1"}
prompt actual:
${current.prompt ?? ""}`
    : "";

  try {
    const anthropic = createAnthropic({ apiKey });
    const { object, usage } = await generateObject({
      model: anthropic("claude-sonnet-4-6"),
      schema: z.object({
        slug: z
          .string()
          .describe("Identificador en snake_case, minúsculas (ej: 'ofrece_proximo_paso')"),
        name: z.string().describe("Nombre corto y legible (ej: 'Ofrece próximo paso')"),
        description: z.string().describe("Una frase: qué mide este grader."),
        scale: z
          .enum(["numeric_0_1", "pass_fail"])
          .describe(
            "numeric_0_1 para evaluaciones graduales (0.0 a 1.0); pass_fail para criterios binarios (sí/no)."
          ),
        weight: z
          .number()
          .describe("Importancia relativa del grader, entre 0.5 y 2.0 (default 1.0)."),
        prompt: z
          .string()
          .describe(
            "El PROMPT del juez LLM: una instrucción imparcial que evalúa la respuesta del agente y devuelve SOLO un JSON {\"score\": ..., \"reasoning\": \"...\"}. Para numeric_0_1 el score va de 0.0 a 1.0; para pass_fail usá 1.0 (cumple) o 0.0 (no cumple). Indicá claramente qué se considera bueno y qué malo. Si dudás, bajá el score."
          ),
      }),
      prompt: `Sos un experto en evaluación de calidad (graders / LLM-as-judge) para respuestas de un agente conversacional de ventas/atención.

Construí UN grader que mida exactamente lo que pide el operador, alineado al agente ya configurado.

PEDIDO DEL OPERADOR:
${instruction}

${currentBlock}

CONTEXTO DEL AGENTE:
${context || "(sin contexto previo del agente)"}

Reglas:
- El prompt del juez DEBE pedir que devuelva únicamente un JSON {"score": ..., "reasoning": "..."}.
- numeric_0_1: score 0.0-1.0 (gradual). pass_fail: score 1.0 (cumple) o 0.0 (no cumple).
- Sé concreto sobre qué es un buen vs mal resultado. slug en snake_case.
- Si te pasaron un GRADER ACTUAL, conservá su intención y solo aplicá el ajuste pedido.`,
    });
    await recordWebUsage({ component: "dashboard_graders_generate", model: "claude-sonnet-4-6", usage });
    return NextResponse.json({ ok: true, grader: object });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
