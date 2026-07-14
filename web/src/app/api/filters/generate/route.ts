import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { configValue } from "@/lib/runtime-config";
import { fetchPipelines } from "@/lib/kommo";
import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { recordWebUsage } from "@/lib/usage";

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
    const anthropic = createAnthropic({ apiKey });
    const { object, usage } = await generateObject({
      model: anthropic("claude-sonnet-4-6"),
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
      prompt: `Sos un asistente que configura los filtros de un agente de atención sobre Kommo CRM. El operador describe qué NO quiere que el agente responda y vos armás los filtros concretos. Hay tres dimensiones; usá las que correspondan al pedido (pueden ser varias o una sola).

PEDIDO DEL OPERADOR:
${instruction}

DIMENSIÓN 1 — TEXTO (textRules): el mensaje contiene algo.
- match_type "contains": palabra/frase (ej "sorteo", "ganatelo"), pattern en minúsculas.
- match_type "mention_tag": etiqueta @ (pattern vacío = cualquier @mención; o un handle sin @).
- match_type "regex": variantes en un patrón (ej "gana(te|telo)"). Usalo solo si conviene.

DIMENSIÓN 2 — CANALES (channels): el mensaje llega por cierto canal.
Valores válidos (usá EXACTAMENTE estos): ${CHANNEL_VALUES.join(", ")}.
Equivalencias: whatsapp=waba, instagram_dm=instagram/instagram_business, onlinechat=chat web, tiktok_kommo=tiktok.

DIMENSIÓN 3 — ETAPAS (stageIds): el lead está en cierta etapa del pipeline.
Etapas disponibles en Kommo (elegí status_id por nombre; si el pedido no menciona etapas, dejá vacío):
${stageList}

Reglas:
- Devolvé SOLO lo que el pedido pide. No inventes filtros de dimensiones no mencionadas (dejalas en array vacío).
- En channels usá únicamente los valores válidos listados. En stageIds usá únicamente status_id de la lista de etapas.
- Para texto, cubrí variantes comunes (ej "sorteos" → "sorteo", "ganatelo", "etiquetá", y un mention_tag vacío).
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

    await recordWebUsage({ component: "dashboard_filters_generate", model: "claude-sonnet-4-6", usage });
    return NextResponse.json({
      ok: true,
      textRules,
      channels,
      stages,
      summary: object.summary ?? "",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
