import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { configValue } from "@/lib/runtime-config";
import { generateObject } from "ai";
import { z } from "zod";
import { recordWebUsage } from "@/lib/usage";
import { aiErrorMessage, DASHBOARD_MODEL, DASHBOARD_TASKS, dashboardModel } from "@/lib/dashboard-ai";
import { readJson } from "@/lib/api/body";

const GenerateBody = z.object({
  instruction: z.string().optional(),
  // Nombres de campos custom existentes en Kommo.
  fields: z.array(z.string()).optional(),
});

// nodejs runtime: el SDK oficial de Anthropic da 401 spurios en Netlify Edge.
// Usar generateObject (Vercel AI SDK) vía dashboardModel, como en /api/verticales/generate.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;

  const input = await readJson(request, GenerateBody);
  if (!input.ok) return input.response;
  const body = input.data;

  const instruction = body.instruction?.trim() ?? "";
  if (!instruction) {
    return NextResponse.json(
      { ok: false, error: "Describí qué plantilla de seguimiento querés crear." },
      { status: 400 }
    );
  }

  // Nombres de los campos custom que ya existen en Kommo (entidad leads). Se los
  // pasamos a la IA para que, cuando una variable corresponda a un campo existente,
  // la nombre IGUAL y haga match automático en el dashboard (sin crear duplicados).
  const existingFields = (body.fields ?? []).filter(Boolean).slice(0, 80);

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

  try {
    const { object, usage } = await generateObject({
      model: dashboardModel(apiKey, DASHBOARD_TASKS.followUpTemplate),
      schema: z.object({
        name: z
          .string()
          .describe("Nombre corto en snake_case (ej: 'reactivacion_carrito'). Único por template."),
        description: z
          .string()
          .describe("Una frase: cuándo usar esta plantilla y qué tipo de lead apunta a reactivar."),
        body: z
          .string()
          .describe(
            "Cuerpo fijo de la plantilla de WhatsApp. Usar {{nombre_variable}} para los placeholders. Debe ser un mensaje ya aprobable por Meta (conciso, no promocional agresivo, claro)."
          ),
        variables: z
          .array(
            z.object({
              name: z
                .string()
                .describe("Nombre del placeholder en la plantilla (coincide con {{nombre}})"),
              description: z
                .string()
                .describe("Descripción para el agente: qué valor debe poner aquí para este lead."),
            })
          )
          .describe("Lista de variables que el agente debe completar con datos del lead."),
        when_to_use: z
          .string()
          .describe(
            "Condiciones de uso para el operador: en qué situación del pipeline conviene usar esta plantilla."
          ),
        delay_hours: z
          .number()
          .int()
          .describe(
            "Horas de inactividad tras las cuales se envía este seguimiento (paso de la secuencia). Ej: 24 para un primer recordatorio, 48/72 para los siguientes. Default 24 si no hay pista."
          ),
      }),
      prompt: `Eres un experto en WhatsApp Business y seguimiento automático de leads para agentes de ventas.

El operador quiere crear UNA plantilla de seguimiento de WhatsApp. Constrúyela a partir de su pedido, alineada al agente ya configurado.

PEDIDO DEL OPERADOR:
${instruction}

CONTEXTO DEL AGENTE (para que la plantilla hable en la misma voz):
${context || "(sin contexto previo del agente)"}

CAMPOS QUE YA EXISTEN EN KOMMO (entidad lead):
${existingFields.length > 0 ? existingFields.map((f) => `- ${f}`).join("\n") : "(no hay campos custom todavía)"}

Reglas:
- El cuerpo (body) debe ser un mensaje que Meta aprobaría: sin spam, conciso, útil.
- Usa {{nombre_variable}} en el body para los placeholders. Las variables son completadas por el agente en runtime.
- Las variables deben ser pocas (idealmente 1-3) y con descripciones claras para que el agente sepa qué poner.
- IMPORTANTE: si una variable corresponde a un campo que YA EXISTE en Kommo (lista de arriba), nómbrala EXACTAMENTE igual que ese campo para que se reuse automáticamente y no se creen duplicados.
- La plantilla es fija (texto aprobado) — el agente NO modifica el body, solo rellena los placeholders.
- name en snake_case, sin espacios.`,
    });
    await recordWebUsage({ component: "dashboard_follow_up_templates", model: DASHBOARD_MODEL, usage });
    return NextResponse.json({ ok: true, template: object });
  } catch (err) {
    const msg = aiErrorMessage(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
