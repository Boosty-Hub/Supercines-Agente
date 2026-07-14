import React from "react";

export type PageShellWidth = "default" | "narrow";

export type PageShellProps = {
  title: string;
  description?: string;
  /** Botones u otras acciones a la derecha del topbar */
  actions?: React.ReactNode;
  /** Fila de filtros o toolbar opciona bajo el título, dentro del topbar */
  toolbar?: React.ReactNode;
  /** "default" = max-w-6xl; "narrow" = max-w-3xl */
  width?: PageShellWidth;
  children: React.ReactNode;
};

const maxWidthCls: Record<PageShellWidth, string> = {
  default: "max-w-6xl",
  narrow: "max-w-3xl",
};

/**
 * Shell de página con topbar sticky y área de contenido con ritmo único.
 * Reemplaza el wrapper `<div className="px-... max-w-... space-y-...">` inline de cada página.
 * Al usar PageShell, eliminar el <PageHeader> interno de la página (PageShell asume ese rol).
 * REQ-01 (sistema UI), REQ-03-D (no duplicar headers), REQ-04 (densidad consistente).
 * Server-safe (sin directiva "use client").
 */
export function PageShell({
  title,
  description,
  actions,
  toolbar,
  width = "default",
  children,
}: PageShellProps) {
  const mw = maxWidthCls[width];

  return (
    <>
      {/* Topbar sticky */}
      <div className="sticky top-0 z-20 border-b border-neutral-200/80 bg-white/80 backdrop-blur-md">
        <div className={`mx-auto ${mw} px-4 sm:px-6 lg:px-8`}>
          {/* En móvil las acciones bajan a su propia fila: lado a lado aplastan
              la descripción a una palabra por línea. */}
          <div className="flex min-h-[52px] flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <h1 className="text-[15px] font-semibold tracking-tight text-neutral-900 leading-tight">
                {title}
              </h1>
              {description && (
                <p className="mt-0.5 text-xs text-neutral-500 leading-snug">{description}</p>
              )}
            </div>
            {actions && (
              <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
            )}
          </div>
          {toolbar && (
            <div className="pb-3">{toolbar}</div>
          )}
        </div>
      </div>

      {/* Área de contenido */}
      <div className={`mx-auto ${mw} px-4 py-6 sm:px-6 lg:px-8 space-y-6`}>
        {children}
      </div>
    </>
  );
}
