"use client";

// Panel "Modelos por componente": cada pieza del pipeline puede usar un modelo
// distinto (Haiku 5.5 por defecto; Sonnet u Opus si una evaluación lo justifica). Guarda en
// runtime_config vía /api/usage/models; las Edge Functions lo toman en <60s
// sin redeploy. AGENT_MODEL además actualiza el agente en Anthropic.

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { selectCls } from "@/components/ui";
import { interpretSyncResponse } from "@/lib/sync-response";
import { ALLOWED_MODELS, MODEL_LABELS, MODEL_KEY_INFO, MODEL_NAMES } from "@/lib/model-config";

export function ModelsPanel({
  current,
  readOnly = false,
  liveAgentModel = null,
}: {
  current: Record<string, string>;
  readOnly?: boolean;
  /** Modelo que Anthropic tiene guardado en el agente (puede diferir de la config). */
  liveAgentModel?: string | null;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(current);
  const [saving, setSaving] = useState(false);
  // `resolveInAgent`: el cambio se frenó por un conflicto de prompt, que solo se resuelve en /agent.
  const [msg, setMsg] = useState<{ ok: boolean; text: string; resolveInAgent?: boolean } | null>(null);

  const dirty = Object.keys(values).some((k) => values[k] !== current[k]);

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const changed: Record<string, string> = {};
      for (const k of Object.keys(values)) {
        if (values[k] !== current[k]) changed[k] = values[k];
      }
      const res = await fetch("/api/usage/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changed),
      });
      const outcome = interpretSyncResponse(res.status, await res.json().catch(() => null));
      if (outcome.kind === "conflict" || outcome.kind === "stale") {
        // El prompt vivo se editó fuera del dashboard: no se tocó el agente. Se resuelve en /agent.
        setMsg({
          ok: false,
          text: "El prompt del agente fue modificado fuera del dashboard: resolvelo en la página Agente antes de cambiar el modelo.",
          resolveInAgent: true,
        });
        return;
      }
      if (outcome.kind === "error") throw new Error(outcome.message);
      setMsg({ ok: true, text: "Modelos guardados. Las funciones lo toman en menos de 1 minuto." });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Error al guardar" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      {Object.entries(MODEL_KEY_INFO).map(([key, info]) => (
        <div key={key}>
          <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-neutral-50 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-neutral-900">{info.label}</p>
              <p className="mt-0.5 text-xs text-neutral-500">{info.detail}</p>
              {key === "AGENT_MODEL" && liveAgentModel && (
                <p className={`mt-1 text-xs ${liveAgentModel === current.AGENT_MODEL ? "text-neutral-500" : "font-medium text-amber-700"}`}>
                  En Anthropic corre ahora: {MODEL_NAMES[liveAgentModel] ?? liveAgentModel}
                  {liveAgentModel !== current.AGENT_MODEL && " — distinto de la configuración; guardá o usá Sincronizar"}
                </p>
              )}
            </div>
            <select
              value={values[key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
              disabled={readOnly}
              className={selectCls + " sm:w-72 shrink-0"}
            >
              {ALLOWED_MODELS.map((m) => (
                <option key={m} value={m}>
                  {MODEL_LABELS[m] ?? m}
                </option>
              ))}
            </select>
          </div>
          {key === "AGENT_MODEL" && (
            // Seguimientos: corren sobre el MISMO Managed Agent que las
            // respuestas — en Anthropic el modelo vive en el agente, no en la
            // sesión, así que no puede configurarse por separado.
            <div className="mt-2 flex items-center gap-2 rounded-xl border border-dashed border-neutral-200 bg-white px-3 py-2">
              <span className="text-sm">🔁</span>
              <p className="text-xs text-neutral-500">
                <span className="font-medium text-neutral-700">Seguimientos a leads fríos:</span>{" "}
                usan el mismo agente que las Respuestas, así que siempre corren con el modelo de arriba.
              </p>
            </div>
          )}
        </div>
      ))}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={readOnly || !dirty || saving}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-40"
        >
          {saving ? "Guardando…" : "Guardar modelos"}
        </button>
        {readOnly && (
          <p className="text-xs text-neutral-500">Solo quien tiene acceso de configuración puede cambiar los modelos.</p>
        )}
        {msg && (
          <p className={`text-xs ${msg.ok ? "text-emerald-700" : "text-red-600"}`}>
            {msg.text}
            {msg.resolveInAgent && (
              <>
                {" "}
                <Link href="/agent" className="font-medium underline">
                  Resolver en Agente
                </Link>
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
