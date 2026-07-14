import React from "react";

export type PageHeaderProps = {
  title: string;
  description?: string;
  /** Botones u otras acciones a la derecha del título */
  actions?: React.ReactNode;
  children?: never;
};

/**
 * Encabezado estándar de página del dashboard.
 * REQ-03-D: un solo PageHeader en todas las páginas del grupo (dashboard).
 * Responsive: apila en mobile, fila en sm+.
 * Server-safe (sin directiva "use client").
 */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          {title}
        </h1>
        {description && (
          <p className="mt-1 text-sm text-neutral-600">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap gap-2">{actions}</div>
      )}
    </div>
  );
}
