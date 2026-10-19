import { requireScope } from "@/lib/auth/require-scope";
import { configValue } from "@/lib/runtime-config";
import { buildCrmActionsContext } from "@/lib/crm-context";
import { streamText } from "ai";
import { recordWebUsage } from "@/lib/usage";
import { DASHBOARD_MODEL, DASHBOARD_TASKS, dashboardModel } from "@/lib/dashboard-ai";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

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
const CREATE_RULES = `Eres un experto en prompt engineering. Construyes SOLO la parte de IDENTIDAD, VOZ y NEGOCIO de un agente conversacional de ventas/soporte que corre sobre Kommo CRM y responde a leads por mensajería (WhatsApp / Instagram / web).

CRÍTICO — NO incluyas la maquinaria técnica: el sistema agrega automáticamente, por detrás, el flujo obligatorio (consultar la voz y la memoria del lead, usar search_kb), el formato de salida \`<respuesta>\`, las variables del sistema, el orden de prioridad y las reglas de seguridad/anti-abuso. NO generes ninguna de esas secciones — solo lo específico de este negocio.

FORMATO:
- Markdown bien estructurado, secciones con encabezados \`##\`. Conciso, sin relleno.
- Respondes ÚNICAMENTE con el system prompt. Nada de explicaciones.

Secciones, en este orden (y SOLO estas): ## Identidad y misión · ## Voz y tono · ## Saludo y primer contacto · ## Manejo de objeciones y precios · ## Información y reglas del negocio · ## Cuándo escalar a un humano

NO generes: "Flujo obligatorio", "Formato del output", "Variables del sistema", "Orden de prioridad" ni reglas de seguridad — las pone el sistema.

PLACEHOLDERS: refiérete a la marca SIEMPRE como {{OPERATOR_NAME}} (token literal, NO el nombre real). Puedes usarlo libremente; no inventes otros placeholders.`;

const PLACEHOLDER_NOTE = `Refiérete a la marca como {{OPERATOR_NAME}} (no el nombre real). No toques otros placeholders ({{MASTER_PATH}}, {{LEADS_PATH}}, etc.).`;

// SECTION: produce ONE new section (the client inserts it at the right place).
const SECTION_RULES = `Vas a generar UNA sección nueva para un system prompt que ya existe. NO devuelvas el resto del prompt.

REGLAS ESTRICTAS:
- Devuelve ÚNICAMENTE UNA sección en markdown, empezando con un encabezado \`##\`.
- Convierte la información del usuario en una sección clara y bien redactada (instrucciones de cómo el agente debe usar esa info). Pero preserva TEXTUAL los datos concretos: tablas, URLs, direcciones, precios y las respuestas literales entre comillas. NO inventes datos ni categorías que el usuario no dio.
- ${PLACEHOLDER_NOTE}
- NADA de introducción ni explicaciones. Empieza directo con el \`##\`.
- Termina con la línea exacta:
${END}`;

// EDIT: rewrite ONE existing section applying a change (the client replaces it).
const EDIT_RULES = `Vas a MODIFICAR una sola sección de un system prompt. Te paso la sección actual y el cambio pedido.

REGLAS ESTRICTAS:
- Devuelve ESA MISMA sección, completa, con su encabezado \`##\`, aplicando el cambio pedido.
- Conserva TODO lo que no cambia. No reescribas por reescribir. Preserva textual tablas, URLs, direcciones, precios y respuestas entre comillas que sigan vigentes.
- ${PLACEHOLDER_NOTE}
- NADA de introducción ni explicaciones. Empieza directo con el \`##\`.
- Termina con la línea exacta:
${END}`;

const CONTINUE_RULES = `Continúa EXACTAMENTE desde donde termina el texto que te paso, SIN repetir ni una palabra y SIN agregar introducción. Mantén el formato markdown. Termina con la línea exacta:
${END}`;

const GenerateAgentBody = z.object({
  mode: z.enum(["create", "section", "edit", "continue"]).optional(),
  instruction: z.string().optional(),
  partial: z.string().optional(),
  title: z.string().optional(),
  currentSection: z.string().optional(),
  existingSections: z.array(z.string()).optional(),
});

export async function POST(request: Request) {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;

  const input = await readJson(request, GenerateAgentBody);
  if (!input.ok) return input.response;
  const body = input.data;

  const apiKey = await configValue("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response("Configura primero la API key de Anthropic (paso anterior).", {
      status: 400,
    });
  }

  const mode = body.mode ?? "create";
  const instruction = body.instruction?.trim() ?? "";
  const partial = body.partial ?? "";
  const title = body.title?.trim() ?? "";
  const currentSection = body.currentSection ?? "";

  let system: string;
  let prompt: string;

  // Conocimiento de las acciones de CRM (mover etapa / completar campos) + nombres
  // reales de Kommo, para que la voz generada incluya esas instrucciones cuando el
  // negocio lo implique. No se carga en 'continue' (es solo continuación de texto).
  let crmBlock = "";
  if (mode !== "continue") {
    const crm = await buildCrmActionsContext();
    crmBlock = crm
      ? `\n\n${crm}\n\nSi el negocio implica alguna de esas acciones del CRM, incorpora la instrucción dentro de la sección que corresponda (típicamente «## Información y reglas del negocio»), con los nombres exactos. Si no aplica, no la agregues ni inventes campos ni etapas.`
      : "";
  }

  if (mode === "continue") {
    if (!partial) return new Response("Falta el texto parcial.", { status: 400 });
    system = CONTINUE_RULES;
    prompt = `Texto parcial (sigue desde el final):\n\n${partial}`;
  } else if (mode === "edit") {
    if (!instruction || !currentSection) {
      return new Response("Falta la sección o el cambio.", { status: 400 });
    }
    system = EDIT_RULES + crmBlock;
    prompt = `Sección actual:\n\n${currentSection}\n\n--- Cambio pedido ---\n${instruction}`;
  } else if (mode === "section") {
    if (!instruction) return new Response("Falta la información a agregar.", { status: 400 });
    const titles = body.existingSections ?? [];
    const ctx = titles.length
      ? `\n\nSecciones ya existentes (no las dupliques): ${titles.join(" · ")}`
      : "";
    const titleHint = title ? `\n\nUsa EXACTAMENTE este encabezado para la sección: ## ${title}` : "";
    system = SECTION_RULES + titleHint + ctx + crmBlock;
    prompt = `Información a transformar en una sección:\n\n${instruction}`;
  } else {
    if (!instruction) return new Response("Falta la descripción del negocio.", { status: 400 });
    system = CREATE_RULES + crmBlock + `\n\nCrea el prompt base. Termina con la línea exacta:\n${END}`;
    prompt = instruction;
  }

  const result = streamText({
    model: dashboardModel(apiKey, DASHBOARD_TASKS.generateAgent),
    system,
    prompt,
    onFinish: async ({ usage, finishReason }) => {
      // Sin END el cliente ya detecta el corte; aquí queda el motivo en el log
      // ("length" = tope de tokens, "content-filter" = rechazo por políticas de seguridad).
      if (finishReason !== "stop") {
        console.warn(`generate-agent: finishReason=${finishReason} (la respuesta puede estar incompleta)`);
      }
      // El stream ya se entregó al cliente; se espera el registro para que serverless
      // no congele la ejecución antes de escribir. recordWebUsage es fail-open (no lanza).
      await recordWebUsage({ component: "dashboard_generate_agent", model: DASHBOARD_MODEL, usage });
    },
  });

  return result.toTextStreamResponse();
}
