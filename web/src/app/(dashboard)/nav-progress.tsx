"use client";

// Indicador global de navegación. Cubre dos casos que el usuario no ve claros:
//   1) Cambio de módulo (/inbox → /leads, etc.).
//   2) Abrir una conversación (/inbox?lead=X) — que es un cambio de searchParam
//      y NO dispara los loading.tsx de App Router.
// Estrategia: escuchamos clicks en links internos para PRENDER el indicador y lo
// APAGAMOS cuando cambia la ruta o los searchParams (navegación terminada).

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { LoadingOverlay } from "@/components/ui";

export function NavProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, setPending] = useState(false);
  // Qué se está cargando, para que el popup lo diga en vez de un "Cargando…" seco.
  const [what, setWhat] = useState<{ label: string; hint?: string }>({ label: "Cargando…" });
  const lastHref = useRef<string | null>(null);

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
      lastHref.current = href;
      setWhat(describeTarget(href, a));
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
      {/* Barra superior: feedback instantáneo, sin esperar al overlay. */}
      <div className="fixed inset-x-0 top-0 z-[130] h-0.5 bg-brand/25">
        <div className="h-full w-full animate-pulse bg-brand" />
      </div>
      {/* Popup: solo si la carga se hace notar (ver delay en LoadingOverlay). */}
      <LoadingOverlay label={what.label} hint={what.hint} />
    </>
  );
}

// Etiqueta legible de a dónde se va, tomada del propio link: para los módulos
// alcanza con su texto; para una conversación se muestra el nombre del lead.
function describeTarget(href: string, a: Element): { label: string; hint?: string } {
  if (href.includes("lead=")) {
    // El texto del link trae iniciales del avatar + nombre + "hace 3 min" todo
    // pegado, así que el nombre limpio viaja en un data-attribute.
    const nombre = (a.getAttribute("data-lead-name") ?? "").trim().slice(0, 40);
    return {
      label: "Abriendo conversación…",
      hint: nombre ? `${nombre} — trayendo mensajes y borradores` : "Trayendo mensajes y borradores",
    };
  }
  const modulo = (a.textContent ?? "").trim().split("\n")[0].slice(0, 30);
  return {
    label: modulo ? `Cargando ${modulo}…` : "Cargando…",
    hint: "Un momento, estamos trayendo los datos",
  };
}
