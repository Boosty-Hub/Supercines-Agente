"use client";

// Overlay de carga — el "cargando" visible del dashboard.
//
// Se usa en dos lugares:
//   · NavProgress, mientras se navega entre módulos o se abre una conversación.
//   · Cualquier loading.tsx que quiera algo más explícito que un esqueleto.
//
// Detalle importante: NO se muestra de inmediato. Una navegación de 150ms con
// un popup encima se ve como un parpadeo molesto, peor que no poner nada. El
// overlay aparece recién pasado `delayMs`, así que las cargas rápidas siguen
// sintiéndose instantáneas y solo las lentas explican por qué se esperan.

import { useEffect, useState } from "react";

export function LoadingOverlay({
  label = "Cargando…",
  hint,
  delayMs = 180,
}: {
  label?: string;
  /** Segunda línea, para decir qué se está trayendo. */
  hint?: string;
  delayMs?: number;
}) {
  const [visible, setVisible] = useState(delayMs === 0);

  useEffect(() => {
    if (delayMs === 0) return;
    const t = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(t);
  }, [delayMs]);

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="fixed inset-0 z-[120] flex items-center justify-center bg-neutral-900/10 backdrop-blur-[2px]"
    >
      <div className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white px-5 py-4 shadow-modal">
        <span
          aria-hidden
          className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-neutral-200 border-t-brand motion-reduce:animate-none"
        />
        <div className="min-w-0">
          <p className="text-sm font-medium text-neutral-900">{label}</p>
          {hint && <p className="mt-0.5 text-xs text-neutral-500">{hint}</p>}
        </div>
      </div>
    </div>
  );
}
