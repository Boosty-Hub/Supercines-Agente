import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { configValue } from "@/lib/runtime-config";
import { buildCrmActionsContext } from "@/lib/crm-context";
import { buildShopifyContext } from "@/lib/shopify-context";
import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { recordWebUsage } from "@/lib/usage";

// nodejs runtime: the Anthropic path returns spurious 401s on Netlify's Edge.
export const runtime = "nodejs";
export const maxDuration = 60;

// Suggests domain-specific verticals from the agent already created in the
// wizard. The AI reads the saved system prompt + operator name (full context of
// who the agent is) and proposes 3-5 message categories specific to the
// business. The three generic verticals (general, engagement_social,
// hate_sarcasmo) are already seeded, so we tell the model NOT to repeat them.
export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // Optional extra context the client may pass (the business description typed
  // in the agent step). The saved system prompt is the primary source of truth.
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    /* body is optional */
  }
  const extra = typeof body.description === "string" ? body.description.trim() : "";

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
  if (!systemPrompt && !extra) {
    return NextResponse.json(
      { ok: false, error: "Creá primero el agente (su system prompt) para poder sugerir verticales." },
      { status: 400 }
    );
  }

  const [crmContext, shopifyContext] = await Promise.all([
    buildCrmActionsContext(),
    buildShopifyContext(),
  ]);

  const context = [
    operatorName ? `Operador / marca: ${operatorName}` : "",
    systemPrompt ? `System prompt del agente:\n${systemPrompt}` : "",
    extra ? `Descripción adicional del negocio:\n${extra}` : "",
    crmContext,
    shopifyContext,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const anthropic = createAnthropic({ apiKey });
    const { object, usage } = await generateObject({
      model: anthropic("claude-sonnet-4-6"),
      schema: z.object({
        verticals: z
          .array(
            z.object({
              slug: z
                .string()
                .describe("Identificador en snake_case, minúsculas, sin espacios (ej: 'compra_entradas')"),
              name: z.string().describe("Nombre corto y legible (ej: 'Compra de entradas')"),
              description: z
                .string()
                .describe("Una frase: qué tipo de mensajes caen en esta vertical."),
              system_prompt: z
                .string()
                .describe(
                  "Instrucción breve (2-4 frases) para el agente sobre cómo manejar este tipo de mensaje, en la voz del operador. No incluyas el nombre del negocio literal; hablá en segunda persona al agente."
                ),
              auto_reply: z
                .boolean()
                .describe(
                  "true si el agente puede responder solo este tipo de mensaje (consultas comerciales claras, info de producto). false si conviene que pase por revisión."
                ),
              requires_review: z
                .boolean()
                .describe(
                  "true si SIEMPRE debe pasar por revisión humana antes de enviar (temas sensibles, reclamos, pagos). Inverso natural de auto_reply."
                ),
            })
          )
          .min(2)
          .max(5)
          .describe(
            "Entre 2 y 5 verticales ESPECÍFICAS del negocio. NO incluyas categorías genéricas como 'general', 'engagement social/saludos' ni 'hate/sarcasmo' — esas ya existen."
          ),
      }),
      prompt: `Sos un experto en clasificación de mensajes entrantes para agentes de ventas/atención sobre CRM.

A partir del siguiente agente ya configurado, proponé las verticales (categorías de mensajes entrantes) ESPECÍFICAS de este negocio. Cada vertical agrupa un tipo de consulta y define si el agente puede responderla solo o si debe ir a revisión humana.

Reglas:
- Proponé SOLO verticales propias del dominio del negocio (productos, servicios, etapas del funnel). NO repitas las genéricas ('general', saludos/engagement, hate/sarcasmo): esas ya están creadas.
- Consultas comerciales o de información clara: auto_reply=true, requires_review=false.
- Temas sensibles (reclamos, pagos, datos personales, soporte crítico): auto_reply=false, requires_review=true.
- Si una vertical implica una ACCIÓN EN EL CRM (mover de etapa, guardar un dato en un campo), incluí esa instrucción en su system_prompt usando los nombres EXACTOS de Kommo (ver capacidad del agente en el contexto). Si no aplica, no la agregues.
- slug en snake_case. system_prompt en segunda persona dirigido al agente, en español neutro, sin el nombre literal del negocio.

CONTEXTO DEL AGENTE:
${context}`,
    });
    await recordWebUsage({ component: "dashboard_suggest_verticals", model: "claude-sonnet-4-6", usage });
    return NextResponse.json({ ok: true, verticals: object.verticals });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
