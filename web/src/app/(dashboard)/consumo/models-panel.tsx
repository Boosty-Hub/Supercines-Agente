"use client";

// Panel "Modelos por componente": cada pieza del pipeline puede usar un modelo
// distinto (Haiku barato, Sonnet equilibrado, Opus potente). Guarda en
// runtime_config vía /api/usage/models; las Edge Functions lo toman en <60s
// sin redeploy. AGENT_MODEL además actualiza el agente en Anthropic.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { selectCls } from "@/components/ui";
import { ALLOWED_MODELS, MODEL_LABELS, MODEL_KEY_INFO } from "@/lib/model-config";

export function ModelsPanel({ current }: { current: Record<string, string> }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(current);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

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
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
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
            </div>
            <select
              value={values[key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
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
          disabled={!dirty || saving}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-40"
        >
          {saving ? "Guardando…" : "Guardar modelos"}
        </button>
        {msg && (
          <p className={`text-xs ${msg.ok ? "text-emerald-700" : "text-red-600"}`}>{msg.text}</p>
        )}
      </div>
    </div>
  );
}
