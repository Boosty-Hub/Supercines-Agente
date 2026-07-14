"use client";

// Badge de la tasa BCV del día. Se muestra en todo el dashboard cuando la
// capacidad tasa_bcv está activa: es la MISMA tasa (misma fuente + cache) que
// usa el agente en el chat, así el operador sabe con qué número está
// convirtiendo. Click = copiar la tasa.
//
// variant="sidebar" → tarjeta compacta dentro de la barra lateral (desktop)
// variant="mini"    → solo el número, para la barra del MobileNav
// (sin variant)     → pill original (ya no se usa en layout, mantenido por compat)

import { useEffect, useState } from "react";

export function BcvBanner({
  rate,
  source,
  fetchedAt,
  variant,
}: {
  rate: number;
  source: string;
  fetchedAt: string;
  variant?: "sidebar" | "mini";
}) {
  const [copied, setCopied] = useState(false);

  const formatted = new Intl.NumberFormat("es-VE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rate);

  // El timestamp se formatea SOLO en el cliente (useEffect): formatearlo en
  // el render servidor producía un hydration mismatch en el atributo title
  // (locale/zona horaria del server ≠ browser).
  const [time, setTime] = useState<string | null>(null);
  useEffect(() => {
    setTime(
      new Date(fetchedAt).toLocaleString("es-VE", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    );
  }, [fetchedAt]);

  const title =
    `Tasa que usa el agente para convertir precios.\nFuente: ${source}` +
    (time ? ` · Actualizada: ${time}` : "") +
    `\nClick para copiar.`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(String(rate));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard no disponible (http local) — el badge sigue siendo informativo
    }
  }

  // Versión mini: solo el número, inline en la barra del MobileNav
  if (variant === "mini") {
    return (
      <button
        type="button"
        onClick={copy}
        title={title}
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums text-neutral-600 transition-colors hover:bg-neutral-100"
      >
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
        {copied ? "✓" : `${formatted} Bs`}
      </button>
    );
  }

  // Versión sidebar: tarjeta sutil con dot + etiqueta + número
  if (variant === "sidebar") {
    return (
      <button
        type="button"
        onClick={copy}
        title={title}
        className="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-neutral-50"
      >
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
        <span className="font-medium text-neutral-500">Tasa BCV</span>
        <span className="ml-auto font-semibold tabular-nums text-neutral-700">
          {copied ? "✓ copiada" : `${formatted} Bs`}
        </span>
      </button>
    );
  }

  // Pill original (fallback — no se usa desde layout, mantenido por compat)
  return (
    <button
      type="button"
      onClick={copy}
      title={title}
      className="group inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white py-1 pl-2.5 pr-3 text-xs shadow-sm transition-all hover:border-emerald-300 hover:shadow"
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>
      <span className="font-medium text-neutral-500">Tasa BCV</span>
      <span className="font-semibold tabular-nums text-neutral-900">
        {copied ? "✓ copiada" : `1 US$ = ${formatted} Bs`}
      </span>
    </button>
  );
}
