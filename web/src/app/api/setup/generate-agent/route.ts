import { createSupabaseServerClient } from "@/lib/supabase/server";
import { configValue } from "@/lib/runtime-config";
import { buildCrmActionsContext } from "@/lib/crm-context";
import { buildShopifyContext } from "@/lib/shopify-context";
import { streamText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { recordWebUsage } from "@/lib/usage";

// nodejs runtime: the Anthropic path returns spurious 401s on Netlify's Edge.
export const runtime = "nodejs";
export const maxDuration = 60;

// End-of-output sentinel. The client requests continuations until it appears,
// so output is never left truncated — even across calls.
const END = "<!--FIN-->";

// CREATE: build ONLY the operator-editable part (identity/voice/business) from a
// business description. The technical machinery (mandatory flow, <respuesta>
// output format, system variables, priorities, security/anti-abuse) is added by
// the system automatically (CORE_SCAFFOLD in lib/agent-prompt.ts) — the AI must
// NOT generate it, so prompts stay short and the operator can't break the runtime.
const CREATE_RULES = `Sos un experto en prompt engineering. Construís SOLO la parte de IDENTIDAD, VOZ y NEGOCIO de un agente conversacional de ventas/soporte que corre sobre Kommo CRM y responde a leads por mensajería (WhatsApp / Instagram / web).

CRÍTICO — NO incluyas la maquinaria técnica: el sistema agrega automáticamente, por detrás, el flujo obligatorio (leer voz/dreams/memoria, usar search_kb), el formato de salida \`<respuesta>\`, las variables del sistema, el orden de prioridad y las reglas de seguridad/anti-abuso. NO generes ninguna de esas secciones — solo lo específico de este negocio.

FORMATO:
- Markdown bien estructurado, secciones con encabezados \`##\`. Conciso, sin relleno.
- Respondés ÚNICAMENTE con el system prompt. Nada de explicaciones.

Secciones, en este orden (y SOLO estas): ## Identidad y misión · ## Voz y tono · ## Saludo y primer contacto · ## Manejo de objeciones y precios · ## Información y reglas del negocio · ## Cuándo escalar a un humano

NO generes: "Flujo obligatorio", "Formato del output", "Variables del sistema", "Orden de prioridad" ni reglas de seguridad — las pone el sistema.

PLACEHOLDERS: referite a la marca SIEMPRE como {{OPERATOR_NAME}} (token literal, NO el nombre real). Podés usarlo libremente; no inventes otros placeholders.`;

const PLACEHOLDER_NOTE = `Referite a la marca como {{OPERATOR_NAME}} (no el nombre real). No toques otros placeholders ({{MASTER_PATH}}, {{LEADS_PATH}}, etc.).`;

// SECTION: produce ONE new section (the client inserts it at the right place).
const SECTION_RULES = `Vas a generar UNA sección nueva para un system prompt que ya existe. NO devuelvas el resto del prompt.

REGLAS ESTRICTAS:
- Devolvé ÚNICAMENTE UNA sección en markdown, empezando con un encabezado \`##\`.
- Convertí la información del usuario en una sección clara y bien redactada (instrucciones de cómo el agente debe usar esa info). Pero preservá TEXTUAL los datos concretos: tablas, URLs, direcciones, precios y las respuestas literales entre comillas. NO inventes datos ni categorías que el usuario no dio.
- ${PLACEHOLDER_NOTE}
- NADA de introducción ni explicaciones. Empezá directo con el \`##\`.
- Terminá con la línea exacta:
${END}`;

// EDIT: rewrite ONE existing section applying a change (the client replaces it).
const EDIT_RULES = `Vas a MODIFICAR una sola sección de un system prompt. Te paso la sección actual y el cambio pedido.

REGLAS ESTRICTAS:
- Devolvé ESA MISMA sección, completa, con su encabezado \`##\`, aplicando el cambio pedido.
- Conservá TODO lo que no cambia. No reescribas por reescribir. Preservá textual tablas, URLs, direcciones, precios y respuestas entre comillas que sigan vigentes.
- ${PLACEHOLDER_NOTE}
- NADA de introducción ni explicaciones. Empezá directo con el \`##\`.
- Terminá con la línea exacta:
${END}`;

const CONTINUE_RULES = `Continuá EXACTAMENTE desde donde termina el texto que te paso, SIN repetir ni una palabra y SIN agregar introducción. Mantené el formato markdown. Terminá con la línea exacta:
${END}`;

interface Body {
  mode?: "create" | "section" | "edit" | "continue";
  instruction?: string;
  partial?: string;
  title?: string;
  currentSection?: string;
  existingSections?: string[];
}

export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }

  const apiKey = await configValue("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response("Configurá primero la API key de Anthropic (paso anterior).", {
      status: 400,
    });
  }

  const mode = body.mode ?? "create";
  const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
  const partial = typeof body.partial === "string" ? body.partial : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const currentSection = typeof body.currentSection === "string" ? body.currentSection : "";

  let system: string;
  let prompt: string;

  // Conocimiento de las acciones de CRM (mover etapa / completar campos) + nombres
  // reales de Kommo, para que la voz generada incluya esas instrucciones cuando el
  // negocio lo implique. No se carga en 'continue' (es solo continuación de texto).
  let crmBlock = "";
  if (mode !== "continue") {
    const [crm, shop] = await Promise.all([buildCrmActionsContext(), buildShopifyContext()]);
    crmBlock = `\n\n${[crm, shop].filter(Boolean).join("\n\n")}\n\nSi el negocio implica alguna de esas acciones (CRM o tienda Shopify), incorporá la instrucción dentro de la sección que corresponda (típicamente «## Información y reglas del negocio»), con los nombres exactos. Si no aplica, no la agregues ni inventes campos/etapas/productos.`;
  }

  if (mode === "continue") {
    if (!partial) return new Response("Falta el texto parcial.", { status: 400 });
    system = CONTINUE_RULES;
    prompt = `Texto parcial (seguí desde el final):\n\n${partial}`;
  } else if (mode === "edit") {
    if (!instruction || !currentSection) {
      return new Response("Falta la sección o el cambio.", { status: 400 });
    }
    system = EDIT_RULES + crmBlock;
    prompt = `Sección actual:\n\n${currentSection}\n\n--- Cambio pedido ---\n${instruction}`;
  } else if (mode === "section") {
    if (!instruction) return new Response("Falta la información a agregar.", { status: 400 });
    const titles = Array.isArray(body.existingSections)
      ? body.existingSections.filter((s) => typeof s === "string")
      : [];
    const ctx = titles.length
      ? `\n\nSecciones ya existentes (no las dupliques): ${titles.join(" · ")}`
      : "";
    const titleHint = title ? `\n\nUsá EXACTAMENTE este encabezado para la sección: ## ${title}` : "";
    system = SECTION_RULES + titleHint + ctx + crmBlock;
    prompt = `Información a transformar en una sección:\n\n${instruction}`;
  } else {
    if (!instruction) return new Response("Falta la descripción del negocio.", { status: 400 });
    system = CREATE_RULES + crmBlock + `\n\nCreá el prompt base. Terminá con la línea exacta:\n${END}`;
    prompt = instruction;
  }

  const anthropic = createAnthropic({ apiKey });
  const result = streamText({
    model: anthropic("claude-sonnet-4-6"),
    system,
    prompt,
    maxTokens: 4000,
    onFinish: ({ usage }) => {
      // fail-open: no awaitar para no bloquear el stream
      recordWebUsage({ component: "dashboard_generate_agent", model: "claude-sonnet-4-6", usage }).catch(() => {});
    },
  });

  return result.toTextStreamResponse();
}
