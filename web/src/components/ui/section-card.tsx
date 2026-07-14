import React from "react";

export type SectionCardTone = "default" | "danger";

export type SectionCardProps = {
  /** Ícono SVG de icons.tsx */
  icon?: React.ReactNode;
  title: string;
  description?: string;
  /** Elemento a la derecha del header (botón, badge, etc.) */
  action?: React.ReactNode;
  children: React.ReactNode;
  /** "danger" → chip e ícono en rojo (zonas destructivas) */
  tone?: SectionCardTone;
};

const iconChipCls: Record<SectionCardTone, string> = {
  default: "bg-neutral-100 text-neutral-500",
  danger:  "bg-red-100 text-red-600",
};

/**
 * Tarjeta de sección con header estructurado (ícono + título + descripción + acción).
 * Reemplaza las cards de settings/agent donde antes eran bloques planos e indistinguibles.
 * REQ-01, REQ-04 (C - configuración).
 * Server-safe (sin directiva "use client").
 */
export function SectionCard({
  icon,
  title,
  description,
  action,
  children,
  tone = "default",
}: SectionCardProps) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white shadow-card overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-neutral-100 px-5 py-4">
        <div className="flex items-start gap-3 min-w-0">
          {icon && (
            <div
              className={[
                "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
                iconChipCls[tone],
              ].join(" ")}
            >
              {icon}
            </div>
          )}
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-tight text-neutral-900">{title}</p>
            {description && (
              <p className="mt-0.5 text-xs text-neutral-500">{description}</p>
            )}
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>

      {/* Body */}
      <div className="px-5 py-5 space-y-4">{children}</div>
    </div>
  );
}
