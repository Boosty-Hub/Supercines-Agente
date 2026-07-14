"use client";

// Sección colapsable reutilizable (cards de config).
//
// Affordance intuitivo: TODO el header es un botón con hover, un hint
// "Editar/Cerrar" y un chevron que rota — para que se intuya que se despliega.
// Colapsada muestra un RESUMEN en vivo (qué hay configurado); abierta muestra la
// descripción + los controles. El cuerpo se oculta con CSS (no se desmonta), así
// los selectores con fetch no recargan ni se pierde lo editado al colapsar.

import { useState } from "react";

export function CollapsibleSection({
  title,
  description,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  /** Qué hace la sección — se muestra cuando está ABIERTA, sobre los controles. */
  description?: React.ReactNode;
  /** Resumen de lo configurado — se muestra cuando está CERRADA. */
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 p-6 text-left transition-colors hover:bg-neutral-50"
      >
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-semibold tracking-tight text-neutral-900">{title}</h3>
          {open
            ? description && <p className="text-xs text-neutral-500">{description}</p>
            : summary && <div className="text-xs text-neutral-500">{summary}</div>}
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-neutral-400">
          <span className="hidden sm:inline">{open ? "Cerrar" : "Editar"}</span>
          <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden
            className={
              "h-4 w-4 transition-transform duration-200 motion-reduce:transition-none " +
              (open ? "rotate-180" : "")
            }
          >
            <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>

      <div className={"border-t border-neutral-100 p-6 pt-5 " + (open ? "" : "hidden")}>
        {children}
      </div>
    </section>
  );
}
