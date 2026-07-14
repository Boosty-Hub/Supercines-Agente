"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Template = {
  id: string;
  name: string;
};

type Step = {
  id?: string;
  step_number: number;
  delay_hours: number;
  template_id: string | null;
  enabled: boolean;
};

export function SequenceEditor({
  steps: initialSteps,
  templates,
}: {
  steps: Step[];
  templates: Template[];
}) {
  const router = useRouter();
  const [steps, setSteps] = useState<Step[]>(initialSteps);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function updateStep(i: number, patch: Partial<Step>) {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  function addStep() {
    const nextNumber = steps.length > 0 ? Math.max(...steps.map((s) => s.step_number)) + 1 : 1;
    const nextDelay = steps.length > 0 ? steps[steps.length - 1].delay_hours + 24 : 24;
    setSteps((prev) => [
      ...prev,
      { step_number: nextNumber, delay_hours: nextDelay, template_id: null, enabled: true },
    ]);
  }

  function removeStep(i: number) {
    const updated = steps
      .filter((_, idx) => idx !== i)
      .map((s, idx) => ({ ...s, step_number: idx + 1 }));
    setSteps(updated);
  }

  function moveUp(i: number) {
    if (i === 0) return;
    const updated = [...steps];
    [updated[i - 1], updated[i]] = [updated[i], updated[i - 1]];
    setSteps(updated.map((s, idx) => ({ ...s, step_number: idx + 1 })));
  }

  function moveDown(i: number) {
    if (i === steps.length - 1) return;
    const updated = [...steps];
    [updated[i], updated[i + 1]] = [updated[i + 1], updated[i]];
    setSteps(updated.map((s, idx) => ({ ...s, step_number: idx + 1 })));
  }

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/follow-up/steps", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ steps }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError((j as { error?: string }).error ?? "Error al guardar");
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white shadow-sm p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <h2 className="text-base font-semibold tracking-tight text-neutral-900">
            Secuencia de pasos
          </h2>
          <p className="text-xs text-neutral-500">
            Cada paso asigna una plantilla y una demora desde el último evento del lead.
          </p>
        </div>
        <button
          type="button"
          onClick={addStep}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
        >
          + Paso
        </button>
      </div>

      {steps.length === 0 && (
        <p className="text-sm text-neutral-500">Sin pasos. Agregá al menos uno para activar el seguimiento.</p>
      )}

      {steps.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-neutral-200">
          <table className="w-full text-sm min-w-[560px]">
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Demora (horas)</th>
                <th className="px-3 py-2 font-medium">Plantilla</th>
                <th className="px-3 py-2 font-medium">Activo</th>
                <th className="px-3 py-2 font-medium text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {steps.map((step, i) => (
                <tr key={i}>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700">
                      {step.step_number}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      min={1}
                      value={step.delay_hours}
                      onChange={(e) => updateStep(i, { delay_hours: Number(e.target.value) })}
                      className="w-20 rounded border border-neutral-300 px-2 py-1 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={step.template_id ?? ""}
                      onChange={(e) => updateStep(i, { template_id: e.target.value || null })}
                      className="rounded border border-neutral-300 px-2 py-1 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
                    >
                      <option value="">— sin plantilla —</option>
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => updateStep(i, { enabled: !step.enabled })}
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors ${
                        step.enabled
                          ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                          : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                      }`}
                    >
                      {step.enabled ? "ON" : "OFF"}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => moveUp(i)}
                        disabled={i === 0}
                        aria-label="Subir"
                        className="rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => moveDown(i)}
                        disabled={i === steps.length - 1}
                        aria-label="Bajar"
                        className="rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-100 disabled:opacity-30"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        onClick={() => removeStep(i)}
                        aria-label="Eliminar paso"
                        className="rounded px-1.5 py-0.5 text-xs text-red-500 hover:bg-red-50"
                      >
                        ✕
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {saved && <p className="text-sm text-emerald-600">Secuencia guardada.</p>}

      <button
        type="button"
        onClick={save}
        disabled={busy}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
      >
        {busy ? "Guardando…" : "Guardar secuencia"}
      </button>
    </div>
  );
}
