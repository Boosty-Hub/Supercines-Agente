"use client";

import { focusRing } from "./styles";

export type SwitchTone = "emerald" | "brand";

export type SwitchProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  busy?: boolean;
  /** Color del estado activo: emerald (default) o brand (neutral-900 por defecto) */
  tone?: SwitchTone;
  "aria-label"?: string;
};

const toneCls: Record<SwitchTone, string> = {
  emerald: "bg-emerald-500",
  brand:   "bg-brand",
};

/**
 * Switch estilo iOS — fuente canónica.
 * REQ-03-B: un solo Switch en todo el dashboard.
 * Copia exacta del Switch de filters-panel.tsx + prop `tone`.
 */
export function Switch({
  checked,
  onChange,
  disabled,
  busy,
  tone = "emerald",
  "aria-label": ariaLabel,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
      className={[
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        focusRing,
        checked ? toneCls[tone] : "bg-neutral-300",
      ].join(" ")}
    >
      <span
        className={[
          "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-[1.375rem]" : "translate-x-0.5",
        ].join(" ")}
      />
    </button>
  );
}
