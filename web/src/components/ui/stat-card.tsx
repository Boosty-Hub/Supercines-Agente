import React from "react";

export type StatCardTone = "default" | "brand" | "amber" | "red" | "emerald";

export type StatCardProps = {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: React.ReactNode;
  tone?: StatCardTone;
};

const chipCls: Record<StatCardTone, string> = {
  default:  "bg-neutral-100 text-neutral-500",
  brand:    "bg-brand-soft text-brand",
  amber:    "bg-amber-100 text-amber-700",
  red:      "bg-red-100 text-red-600",
  emerald:  "bg-emerald-100 text-emerald-600",
};

/**
 * Tarjeta de estadística — re-presenta conteos que YA calcula el server component.
 * Cero queries nuevas.
 * REQ-01 (sistema UI), REQ-04 (densidad), REQ-05 (stat visible arriba de listas).
 * Server-safe (sin directiva "use client").
 */
export function StatCard({ label, value, hint, icon, tone = "default" }: StatCardProps) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-neutral-500">{label}</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight text-neutral-900 tabular-nums leading-none">
            {value}
          </p>
          {hint && <p className="mt-1 text-xs text-neutral-400">{hint}</p>}
        </div>
        {icon && (
          <div
            className={[
              "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
              chipCls[tone],
            ].join(" ")}
          >
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}
