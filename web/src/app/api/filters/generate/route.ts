import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { configValue } from "@/lib/runtime-config";
import { fetchPipelines } from "@/lib/kommo";
import { generateObject } from "ai";
import { z } from "zod";
import { recordWebUsage } from "@/lib/usage";
import { aiErrorMessage, DASHBOARD_MODEL, DASHBOARD_TASKS, dashboardModel } from "@/lib/dashboard-ai";
import { readJson } from "@/lib/api/body";

const GenerateBody = z.object({ instruction: z.string().optional() });

export const runtime = "nodejs";
export const maxDuration = 60;

// Canales conocidos de Kommo (valor canónico = el que persiste process-inbound).
const CHANNEL_VALUES = [
  "whatsapp",
  "instagram_dm",
  "facebook",
  "telegram",
  "tiktok_kommo",
  "onlinechat",
] as const;

// Asistente IA general de Filtros: a partir de una instrucción en lenguaje
// natural arma TODO lo necesario para que el agente no responda — reglas de
// texto, canales y etapas de Kommo. Le pasamos las etapas reales para que
// mapee nombres → status_id.
export async function POST(request: Request) {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;

  const input = await readJson(request, GenerateBody);
  if (!input.ok) return input.response;
  const body = input.data;

  const instruction = body.instruction?.trim() ?? "";
  if (!instruction) {
    return NextResponse.json(
      { ok: false, error: "Describí qué no querés que responda el agente." },
      { status: 400 }
    );
  }

  const apiKey = await configValue("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "Configurá primero la API key de Anthropic." },
      { status: 400 }
    );
  }

  // Traer etapas reales de Kommo para que la IA pueda elegir status_id por nombre.
  let stageCatalog: { id: number; name: string; pipeline: string }[] = [];
  try {
    const { configured, pipelines } = await fetchPipelines();
    if (configured) {
      stageCatalog = pipelines.flatMap((p) =>
        p.statuses.map((s) => ({ id: s.id, name: s.name, pipeline: p.name }))
      );
    }
  } catch {
    // Si Kommo falla, seguimos: la IA puede armar texto y canales igual.
    stageCatalog = [];
  }

  const stageList =
    stageCatalog.length > 0
      ? stageCatalog.map((s) => `  - id ${s.id}: "${s.name}" (pipeline "${s.pipeline}")`).join("\n")
      : "  (sin etapas disponibles)";

  try {
    const { object, usage } = await generateObject({
      model: dashboardModel(apiKey, DASHBOARD_TASKS.filters),
      schema: z.object({
        textRules: z
          .array(
            z.object({
              match_type: z.enum(["contains", "regex", "mention_tag"]),
              pattern: z.string(),
              case_sensitive: z.boolean(),
              description: z.string(),
            })
          )
          .describe("Filtros por contenido del mensaje. Vacío si el pedido no es de texto."),
        channels: z
          .array(z.enum(CHANNEL_VALUES))
          .describe("Canales a ignorar, SOLO de la lista de valores válidos. Vacío si no aplica."),
        stageIds: z
          .array(z.number())
          .describe(
            "status_id de etapas a ignorar, SOLO de la lista de etapas provista. Vacío si no aplica."
          ),
        summary: z.string().describe("Resumen de 1 frase de lo que vas a configurar."),
      }),
      prompt: `Eres un asistente que configura los filtros de un agente de atención sobre Kommo CRM. El operador describe qué NO quiere que el agente responda y tú armas los filtros concretos. Hay tres dimensiones; usa las que correspondan al pedido (pueden ser varias o una sola).

PEDIDO DEL OPERADOR:
${instruction}

DIMENSIÓN 1 — TEXTO (textRules): el mensaje contiene algo.
- match_type "contains": palabra/frase (ej "sorteo", "ganatelo"), pattern en minúsculas.
- match_type "mention_tag": etiqueta @ (pattern vacío = cualquier @mención; o un handle sin @).
- match_type "regex": variantes en un patrón (ej "gana(te|telo)"). Úsalo solo si conviene.

DIMENSIÓN 2 — CANALES (channels): el mensaje llega por cierto canal.
Valores válidos (usa EXACTAMENTE estos): ${CHANNEL_VALUES.join(", ")}.
Equivalencias: whatsapp=waba, instagram_dm=instagram/instagram_business, onlinechat=chat web, tiktok_kommo=tiktok.

DIMENSIÓN 3 — ETAPAS (stageIds): el lead está en cierta etapa del pipeline.
Etapas disponibles en Kommo (elige status_id por nombre; si el pedido no menciona etapas, deja vacío):
${stageList}

Reglas:
- Devuelve SOLO lo que el pedido pide. No inventes filtros de dimensiones no mencionadas (déjalas en array vacío).
- En channels usa únicamente los valores válidos listados. En stageIds usa únicamente status_id de la lista de etapas.
- Para texto, cubre variantes comunes (ej "sorteos" → "sorteo", "ganatelo", "etiqueta", y un mention_tag vacío).
- summary: una frase clara en español de lo que vas a configurar.`,
    });

    const textRules = (object.textRules ?? []).filter((r) =>
      r.match_type === "mention_tag" ? true : r.pattern.trim().length > 0
    );
    const channels = Array.from(new Set((object.channels ?? []) as string[]));
    const validStageIds = new Set(stageCatalog.map((s) => s.id));
    const stages = Array.from(new Set((object.stageIds ?? []) as number[]))
      .filter((id) => validStageIds.has(id))
      .map((id) => {
        const s = stageCatalog.find((x) => x.id === id)!;
        return { id, label: `${s.pipeline} · ${s.name}` };
      });

    await recordWebUsage({ component: "dashboard_filters_generate", model: DASHBOARD_MODEL, usage });
    return NextResponse.json({
      ok: true,
      textRules,
      channels,
      stages,
      summary: object.summary ?? "",
    });
  } catch (err) {
    const msg = aiErrorMessage(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
