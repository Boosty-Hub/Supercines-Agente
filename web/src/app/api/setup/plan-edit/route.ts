import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { configValue } from "@/lib/runtime-config";
import { generateObject } from "ai";
import { z } from "zod";
import { recordWebUsage } from "@/lib/usage";
import { aiErrorMessage, DASHBOARD_MODEL, DASHBOARD_TASKS, dashboardModel } from "@/lib/dashboard-ai";
import { readJson } from "@/lib/api/body";

// nodejs runtime: the Anthropic path returns spurious 401s on Netlify's Edge.
export const runtime = "nodejs";

// Fast structured decision (no content) — given the current section titles and
// an instruction, decide whether to EDIT an existing section or INSERT a new
// one, and (for new) where it belongs thematically. Tiny output → no timeout.
const PlanEditBody = z.object({
  instruction: z.string().optional(),
  // Títulos de las secciones actuales del prompt.
  sections: z.array(z.string()).optional(),
});

export async function POST(request: Request) {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;

  const input = await readJson(request, PlanEditBody);
  if (!input.ok) return input.response;
  const body = input.data;

  const instruction = body.instruction?.trim() ?? "";
  const sections = body.sections ?? [];
  if (!instruction) {
    return NextResponse.json({ ok: false, error: "Falta la instrucción." }, { status: 400 });
  }

  const apiKey = await configValue("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "Configurá primero la API key de Anthropic." },
      { status: 400 }
    );
  }

  try {
    const numbered = sections.map((t, i) => `${i + 1}. ${t}`).join("\n");
    const { object, usage } = await generateObject({
      model: dashboardModel(apiKey, DASHBOARD_TASKS.planEdit),
      schema: z.object({
        action: z
          .enum(["edit", "new"])
          .describe(
            "edit = la instrucción modifica una sección que ya existe; new = aporta información que merece una sección nueva"
          ),
        targetTitle: z
          .string()
          .describe(
            "Si action=edit: el título EXACTO (de la lista) de la sección a modificar. Si action=new: cadena vacía."
          ),
        newTitle: z
          .string()
          .describe(
            "Si action=new: un título corto y claro para la sección nueva (sin '##'). Si action=edit: cadena vacía."
          ),
        afterTitle: z
          .string()
          .describe(
            "Si action=new: el título EXACTO (de la lista) de la sección DESPUÉS de la cual insertar la nueva, eligiendo el lugar temáticamente correcto. Cadena vacía = al final."
          ),
        summary: z
          .string()
          .describe("Una frase corta explicando qué vas a hacer (para mostrarle al usuario)."),
      }),
      prompt: `Sos un editor experto de system prompts. Estas son las secciones actuales, en orden:\n${numbered || "(todavía no hay secciones)"}\n\nInstrucción del usuario:\n${instruction}\n\nDecidí si modifica una sección existente o agrega una nueva, y dónde ubicarla.`,
    });
    await recordWebUsage({ component: "dashboard_plan_edit", model: DASHBOARD_MODEL, usage });
    return NextResponse.json({ ok: true, ...object });
  } catch (err) {
    const msg = aiErrorMessage(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
