"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const OPTIONS: { value: string; label: string; hint: string }[] = [
  {
    value: "all",
    label: "Activar todo automáticamente",
    hint: "Cada aprendizaje se aplica al instante (comportamiento original).",
  },
  {
    value: "error",
    label: "Auto-activar solo errores",
    hint: "Los errores se corrigen solos; sugerencias y advertencias esperan tu aprobación.",
  },
  {
    value: "none",
    label: "Aprobar todo manualmente",
    hint: "Ningún aprendizaje se aplica hasta que lo apruebes acá.",
  },
];

export default function PolicySelector({ initial }: { initial: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function change(policy: string) {
    const prev = value;
    setValue(policy);
    setBusy(true);
    try {
      const res = await fetch("/api/dreams/policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy }),
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
      <label className="text-xs font-medium text-neutral-700">
        Activación de nuevos aprendizajes
      </label>
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
