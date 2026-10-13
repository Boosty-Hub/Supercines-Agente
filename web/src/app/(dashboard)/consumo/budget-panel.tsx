"use client";

// Panel "Techo de gasto mensual": fija runtime_config.MONTHLY_BUDGET_USD vía
// /api/usage/budget. Muestra lo gastado en el mes (UTC) contra el techo.
// Al 100% el agente deja de generar respuestas y seguimientos; al 110% también
// deja de clasificar (los mensajes quedan en cola, no se pierden).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { inputCls } from "@/components/ui/styles";

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function BudgetPanel({
  budgetUsd,
  excludeBefore,
  spendUsd,
}: {
  budgetUsd: number | null;
  excludeBefore: string | null;
  spendUsd: number;
}) {
  const router = useRouter();
  const [value, setValue] = useState(budgetUsd !== null ? String(budgetUsd) : "");
  const [excludeSoFar, setExcludeSoFar] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const pct = budgetUsd ? (spendUsd / budgetUsd) * 100 : null;
  const dirty = value.trim() !== (budgetUsd !== null ? String(budgetUsd) : "");
  const barColor = pct === null ? "bg-neutral-300" : pct >= 110 ? "bg-red-500" : pct >= 100 ? "bg-amber-500" : "bg-emerald-500";

  async function save() {
    const trimmed = value.trim();
    const parsed = trimmed === "" ? null : Number(trimmed.replace(",", "."));
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
      setMsg({ ok: false, text: "Ingresá un monto en USD (por ejemplo 50)." });
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/usage/budget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          monthlyBudgetUsd: parsed,
          // Solo tiene sentido al ACTIVAR el techo; al cambiarlo, no se toca.
          ...(budgetUsd === null && parsed ? { excludeSpentSoFar: excludeSoFar } : {}),
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setMsg({ ok: true, text: parsed ? "Techo guardado. Aplica en menos de 1 minuto." : "Techo quitado: sin límite." });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Error al guardar" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-semibold text-neutral-900">
            Gastado este mes: {usd(spendUsd)}
            {budgetUsd !== null && <span className="font-normal text-neutral-500"> de {usd(budgetUsd)}</span>}
          </p>
          {pct !== null && <p className="font-mono text-xs font-semibold text-neutral-700">{pct.toFixed(0)}%</p>}
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-200">
          <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          {budgetUsd === null
            ? "Sin techo: el agente no se detiene por gasto."
            : "Se cuenta el mes calendario en UTC."}
          {excludeBefore && ` No cuenta lo gastado antes del ${new Date(excludeBefore).toLocaleDateString("es")}.`}
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="sm:w-56">
          <label className="mb-1 block text-xs font-medium text-neutral-600" htmlFor="budget-usd">
            Techo mensual (USD) — vacío = sin techo
          </label>
          <input
            id="budget-usd"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="50"
            className={inputCls}
          />
        </div>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-40"
        >
          {saving ? "Guardando…" : "Guardar techo"}
        </button>
      </div>

      {budgetUsd === null && value.trim() !== "" && (
        <label className="flex items-center gap-2 text-xs text-neutral-600">
          <input type="checkbox" checked={excludeSoFar} onChange={(e) => setExcludeSoFar(e.target.checked)} />
          No contar lo gastado este mes hasta ahora (activar a mitad de mes sin que dispare el freno)
        </label>
      )}
      {msg && <p className={`text-xs ${msg.ok ? "text-emerald-700" : "text-red-600"}`}>{msg.text}</p>}
    </div>
  );
}
