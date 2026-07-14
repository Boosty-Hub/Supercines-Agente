"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: "daily", label: "Diario", hint: "El agente aprende todas las noches." },
  { value: "3d", label: "Cada 3 días", hint: "Analiza las conversaciones cada 3 días." },
  { value: "7d", label: "Cada 7 días", hint: "Un análisis semanal de lo aprendido." },
  { value: "15d", label: "Cada 15 días", hint: "Análisis quincenal; menos frecuente." },
];

export default function FrequencySelector({ initial }: { initial: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function change(frequency: string) {
    const prev = value;
    setValue(frequency);
    setBusy(true);
    try {
      const res = await fetch("/api/dreams/frequency", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frequency }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      router.refresh();
    } catch {
      setValue(prev);
    } finally {
      setBusy(false);
    }
  }

  const current = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0];

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-neutral-700">Frecuencia del análisis</label>
      <select
        value={value}
        disabled={busy}
        onChange={(e) => change(e.target.value)}
        className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-800 focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900 disabled:opacity-50"
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <p className="max-w-xs text-[11px] leading-snug text-neutral-500">{current.hint}</p>
    </div>
  );
}
