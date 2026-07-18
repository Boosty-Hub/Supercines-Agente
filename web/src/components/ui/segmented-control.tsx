"use client";

// Barra de pestañas (segmented control) — fuente canónica.
//
// Había cinco copias del mismo markup (`inline-flex gap-1 rounded-lg
// bg-neutral-100 p-1`) repartidas entre las pestañas de Agente, Ajustes,
// Herramientas y los dos selectores del panel de publicación. Al unificar los
// módulos, tres de esas barras quedaban apiladas en la misma pantalla.

import { focusRing } from "./styles";

export type SegmentedItem<T extends string> = {
  id: T;
  label: string;
  /** Contador opcional a la derecha del label (ej. cantidad de tools). */
  count?: number;
};

export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  size = "md",
  "aria-label": ariaLabel,
}: {
  items: ReadonlyArray<SegmentedItem<T>>;
  value: T;
  onChange: (next: T) => void;
  /** `sm` para barras anidadas dentro de una card. */
  size?: "sm" | "md";
  "aria-label"?: string;
}) {
  const pad = size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm";

  return (
    <div role="tablist" aria-label={ariaLabel} className="inline-flex gap-1 rounded-lg bg-neutral-100 p-1">
      {items.map((it) => {
        const active = it.id === value;
        return (
          <button
            key={it.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(it.id)}
            className={[
              "inline-flex items-center gap-1.5 rounded-md font-medium transition-colors",
              pad,
              focusRing,
              active
                ? "bg-white text-neutral-900 shadow-sm"
                : "text-neutral-600 hover:text-neutral-900",
            ].join(" ")}
          >
            {it.label}
            {typeof it.count === "number" && (
              <span
                className={
                  "rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums " +
                  (active ? "bg-neutral-100 text-neutral-600" : "bg-neutral-200 text-neutral-600")
                }
              >
                {it.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
