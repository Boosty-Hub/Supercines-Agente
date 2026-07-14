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

// Generate ONE custom vertical from a free-text instruction the operator types
// in /verticales. Unlike the wizard's suggest-verticals (which proposes several
// starter categories), here the user says exactly what they want and the AI
// builds that single vertical, grounded in the saved agent context (its system
// prompt + operator name) so it speaks in the same voice.
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
      { ok: false, error: "Describí qué vertical querés crear." },
      { status: 400 }
    );
  }

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

  // Optional: the vertical currently being edited, so the model refines it
  // instead of starting from scratch.
  const current = (body.current ?? null) as {
    name?: string;
    description?: string;
    system_prompt?: string;
  } | null;

  // La IA necesita saber qué puede HACER el agente (operar el CRM + tienda
  // Shopify) y con qué nombres reales, para escribir esas instrucciones en el
  // system_prompt de la vertical cuando corresponda.
  const [crmContext, shopifyContext] = await Promise.all([
    buildCrmActionsContext(),
    buildShopifyContext(),
  ]);

  const context = [
    operatorName ? `Operador / marca: ${operatorName}` : "",
    systemPrompt ? `System prompt del agente:\n${systemPrompt}` : "",
    crmContext,
    shopifyContext,
  ]
    .filter(Boolean)
    .join("\n\n");

  const currentBlock = current
    ? `\n\nVERTICAL ACTUAL (refinála, no empieces de cero):
nombre: ${current.name ?? ""}
descripción: ${current.description ?? ""}
system_prompt actual:
${current.system_prompt ?? ""}`
    : "";

  try {
    const anthropic = createAnthropic({ apiKey });
    const { object, usage } = await generateObject({
      model: anthropic("claude-sonnet-4-6"),
      schema: z.object({
        slug: z
          .string()
          .describe("Identificador en snake_case, minúsculas, sin espacios (ej: 'consulta_cartelera')"),
        name: z.string().describe("Nombre corto y legible (ej: 'Consulta de cartelera')"),
        description: z
          .string()
          .describe(
            "Una frase: qué tipo de mensajes caen en esta vertical. La usa el clasificador para asignarla."
          ),
        system_prompt: z
          .string()
          .describe(
            "Instrucción breve (2-4 frases) para el agente sobre cómo manejar este tipo de mensaje, en la voz del operador. En segunda persona dirigido al agente, español neutro, sin el nombre literal del negocio."
          ),
        auto_reply: z
          .boolean()
          .describe(
            "true si el agente puede responder solo este tipo de mensaje (consultas comerciales/info claras). false si conviene revisión."
          ),
        requires_review: z
          .boolean()
          .describe(
            "true si SIEMPRE debe pasar por revisión humana (temas sensibles, reclamos, pagos). Inverso natural de auto_reply."
          ),
      }),
      prompt: `Sos un experto en clasificación de mensajes entrantes para agentes de ventas/atención sobre CRM.

El operador quiere crear UNA vertical (categoría de mensaje entrante) específica. Construila a partir de su pedido, alineada al agente ya configurado.

PEDIDO DEL OPERADOR:
${instruction}

CONTEXTO DEL AGENTE (para que la vertical hable en la misma voz):
${context || "(sin contexto previo del agente)"}${currentBlock}

Reglas:
- Generá UNA sola vertical que represente fielmente lo que pidió el operador.
- Si te pasaron una VERTICAL ACTUAL, conservá su intención y solo aplicá el ajuste pedido.
- Consultas comerciales o de información clara: auto_reply=true, requires_review=false.
- Temas sensibles (reclamos, pagos, datos personales, soporte crítico): auto_reply=false, requires_review=true.
- Si el pedido implica una ACCIÓN del agente (mover de etapa o guardar datos en el CRM; o buscar productos, consultar pedidos o vender por la tienda Shopify), incluí esa instrucción dentro del system_prompt usando los nombres EXACTOS (ver capacidades del agente arriba). Si no aplica, no la agregues.
- slug en snake_case. system_prompt en segunda persona dirigido al agente, sin el nombre literal del negocio.`,
    });
    await recordWebUsage({ component: "dashboard_verticales_generate", model: "claude-sonnet-4-6", usage });
    return NextResponse.json({ ok: true, vertical: object });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
