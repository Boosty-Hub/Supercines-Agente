import React from "react";

export type EmptyStateProps = {
  /** Ícono SVG de icons.tsx — decorativo */
  icon?: React.ReactNode;
  title: string;
  description?: string;
  /** CTA (Button o Link) */
  action?: React.ReactNode;
};

/**
 * Estado vacío estándar con tarjeta de borde punteado.
 * REQ-05: páginas que lo requieren según spec.
 * Server-safe (sin directiva "use client").
 */
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-8 text-center">
      {icon && (
        <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-neutral-100 text-neutral-400">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-neutral-900">{title}</p>
      {description && (
        <p className="mt-1 text-sm text-neutral-500">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
