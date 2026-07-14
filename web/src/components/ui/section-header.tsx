import React from "react";

export type SectionHeaderProps = {
  title: string;
  /** Texto de ayuda debajo del título */
  hint?: string;
  /** Acciones opcionales a la derecha */
  actions?: React.ReactNode;
};

/**
 * Encabezado de sección dentro de una tarjeta o página.
 * Unifica el patrón h3+p repetido en Agente, Filtros y Settings.
 * Server-safe (sin directiva "use client").
 */
export function SectionHeader({ title, hint, actions }: SectionHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div>
        <h3 className="text-sm font-semibold tracking-tight text-neutral-900">
          {title}
        </h3>
        {hint && (
          <p className="text-xs text-neutral-500">{hint}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}
