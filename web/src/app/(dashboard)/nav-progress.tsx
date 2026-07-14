"use client";

// Indicador global de navegación. Cubre dos casos que el usuario no ve claros:
//   1) Cambio de módulo (/inbox → /leads, etc.).
//   2) Abrir una conversación (/inbox?lead=X) — que es un cambio de searchParam
//      y NO dispara los loading.tsx de App Router.
// Estrategia: escuchamos clicks en links internos para PRENDER el indicador y lo
// APAGAMOS cuando cambia la ruta o los searchParams (navegación terminada).

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

export function NavProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, setPending] = useState(false);

  // Navegación terminada → apagar. (Cambió pathname o searchParams.)
  const key = pathname + "?" + (searchParams?.toString() ?? "");
  useEffect(() => {
    setPending(false);
  }, [key]);

  // Inicio de navegación: click en un <a> interno hacia OTRA URL.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      const target = e.target as HTMLElement | null;
      const a = target?.closest?.("a");
      if (!a) return;
      const href = a.getAttribute("href");
      if (!href) return;
      if (a.getAttribute("target") === "_blank" || a.hasAttribute("download")) return;
      // Solo links internos de navegación (no externos, anclas, mailto/tel).
      if (/^([a-z]+:)?\/\//i.test(href) || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("#")) {
        return;
      }
      if (href === window.location.pathname + window.location.search) return;
      setPending(true);
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // Red de seguridad: si por algún motivo no hubo navegación, apagar tras 10s.
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setPending(false), 10000);
    return () => clearTimeout(t);
  }, [pending]);

  if (!pending) return null;

  return (
    <>
      {/* Barra superior */}
      <div className="fixed inset-x-0 top-0 z-[100] h-0.5 bg-brand/25">
        <div className="h-full w-full animate-pulse bg-brand" />
      </div>
      {/* Pill de carga */}
      <div className="fixed bottom-4 right-4 z-[100] inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white/95 px-3 py-1.5 text-xs font-medium text-neutral-600 shadow-modal backdrop-blur">
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-300 border-t-brand" />
        Cargando…
      </div>
    </>
  );
}
