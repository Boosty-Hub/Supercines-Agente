"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Bell, Alert as AlertIcon, Spinner, ChevronRight } from "@/components/ui";
import { timeAgo } from "@/lib/time-ago";
import type { FeedItem, FeedSystemStatus } from "@/app/api/alerts/feed/route";

// Torre de control: panel ACOPLADO a la derecha, no flotante.
//
// Es hermano flex de <main>, así que al abrirse EMPUJA el contenido en vez de
// taparlo. Una posición fija (fixed/overlay) tarde o temprano choca con el
// contenido de alguna página.
//
// Colapsado queda un riel de 44px con la campana y el contador — la torre nunca
// desaparece del todo, que es el punto de una torre de control.
//
// Autocontenida: se monta en el layout como un componente más, sin tocar
// nav.tsx. El contador de alertas que YA vive en el nav (junto al ítem
// "Alertas") no se toca — esta torre lo complementa, no lo reemplaza.
//
// Al hacer clic en un ítem navega con router.push y el panel no se desmonta,
// porque no forma parte del árbol que Next reemplaza al cambiar de ruta.

const LS_KEY = "torre-de-control:abierta";

const SEVERIDAD: Record<string, string> = {
  critical: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-blue-500",
};

// Mismas etiquetas que /alerts (kindMeta) — se mantienen en los dos lugares
// porque son listas cortas y cada dashboard de origen de este template las
// duplica igual; centralizarlas no vale el acoplamiento extra.
const KINDS: Record<string, string> = {
  draft_failed: "Falló una respuesta",
  human_review_needed: "Necesita tu revisión",
  outcomes_regression: "Bajó la calidad",
  budget_exceeded: "Presupuesto mensual",
  outbound_blocked: "Texto bloqueado antes de enviar",
};

export function TorreDeControl({
  conteoInicial,
  systemStatusInicial,
}: {
  conteoInicial: number;
  systemStatusInicial: FeedSystemStatus;
}) {
  // Arranca colapsada SIEMPRE y se ajusta post-mount desde localStorage: el
  // server no conoce la preferencia y renderizar el estado guardado de entrada
  // rompería la hidratación. Mismo patrón que el colapso de la barra lateral.
  const [abierta, setAbierta] = useState(false);
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [systemStatus, setSystemStatus] = useState<FeedSystemStatus>(systemStatusInicial);
  const [cargando, setCargando] = useState(false);
  const [conteo, setConteo] = useState(conteoInicial);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    try {
      if (window.localStorage.getItem(LS_KEY) === "1") setAbierta(true);
    } catch {
      /* modo privado o storage bloqueado: se queda colapsada */
    }
  }, []);

  const alternar = useCallback((v: boolean) => {
    setAbierta(v);
    try {
      window.localStorage.setItem(LS_KEY, v ? "1" : "0");
    } catch {
      /* no persistir no es motivo para no abrir */
    }
  }, []);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const res = await fetch("/api/alerts/feed", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { items: FeedItem[]; systemStatus: FeedSystemStatus };
      setItems(data.items);
      setConteo(data.items.length);
      setSystemStatus(data.systemStatus);
    } catch {
      setItems([]);
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    if (abierta) void cargar();
  }, [abierta, cargar]);

  useEffect(() => {
    if (!abierta) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") alternar(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [abierta, alternar]);

  async function marcarVisto(id: string) {
    setOcupado(id);
    try {
      await fetch(`/api/alerts/${id}/acknowledge`, { method: "POST" });
      setItems((prev) => prev?.filter((i) => i.id !== id) ?? null);
      setConteo((c) => Math.max(c - 1, 0));
      router.refresh();
    } finally {
      setOcupado(null);
    }
  }

  async function marcarTodoVisto() {
    setOcupado("__todo__");
    try {
      await fetch("/api/alerts/acknowledge-all", { method: "POST" });
      setItems([]);
      setConteo(0);
      router.refresh();
    } finally {
      setOcupado(null);
    }
  }

  const actual = `${pathname}${searchParams.toString() ? `?${searchParams}` : ""}`;

  // ---- Riel colapsado -----------------------------------------------------
  if (!abierta) {
    return (
      <aside
        data-torre="colapsada"
        className="hidden w-11 shrink-0 flex-col items-center gap-3 border-l border-neutral-200 bg-white py-3 sm:flex"
      >
        <button
          type="button"
          onClick={() => alternar(true)}
          aria-label={`Abrir torre de control${conteo > 0 ? ` — ${conteo} sin ver` : ""}`}
          aria-expanded={false}
          title="Torre de control"
          className="relative grid h-8 w-8 place-items-center rounded-lg text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900"
        >
          <Bell size={16} />
          {conteo > 0 && (
            <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
              {conteo > 99 ? "99+" : conteo}
            </span>
          )}
        </button>
        <span
          className="select-none text-[10px] font-medium uppercase tracking-wider text-neutral-300"
          style={{ writingMode: "vertical-rl" }}
        >
          Torre de control
        </span>
      </aside>
    );
  }

  // ---- Panel abierto ------------------------------------------------------
  return (
    <aside
      data-torre="abierta"
      aria-label="Torre de control"
      className="flex w-full shrink-0 flex-col border-l border-neutral-200 bg-white sm:w-[380px]"
    >
      <header className="flex items-center justify-between gap-2 border-b border-neutral-200 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Bell size={16} className="shrink-0 text-neutral-400" />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-neutral-900">Torre de control</h2>
            <p className="truncate text-xs text-neutral-500">
              {items === null
                ? "Cargando…"
                : items.length === 0
                  ? "Todo en orden"
                  : `${items.length} ${items.length === 1 ? "cosa que mirar" : "cosas que mirar"}`}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {items !== null && items.length > 0 && (
            <button
              type="button"
              onClick={() => void marcarTodoVisto()}
              disabled={ocupado === "__todo__"}
              className="rounded-lg px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 disabled:opacity-50"
            >
              {ocupado === "__todo__" ? "…" : "Marcar todo"}
            </button>
          )}
          <button
            type="button"
            onClick={() => void cargar()}
            className="rounded-lg px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
          >
            Actualizar
          </button>
          <button
            type="button"
            onClick={() => alternar(false)}
            aria-label="Colapsar torre de control"
            title="Colapsar"
            className="grid h-7 w-7 place-items-center rounded-lg text-neutral-500 hover:bg-neutral-100"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Estado del sistema: encendido y publicación, siempre visibles —
            no dependen de si hay alertas o no. */}
        <div className="space-y-1.5 border-b border-neutral-100 px-3 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Estado del sistema
          </p>
          <EstadoRow label="Agente" ok={systemStatus.agentEnabled} okLabel="Activo" badLabel="Deshabilitado" />
          <EstadoRow
            label="Publicación"
            ok={systemStatus.publishingEnabled}
            okLabel="Producción"
            badLabel="Validación"
          />
        </div>

        {cargando && items === null && (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-neutral-400">
            <Spinner size={16} /> Cargando…
          </div>
        )}

        {items !== null && items.length === 0 && (
          <div className="px-6 py-12 text-center">
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-neutral-100 text-neutral-400">
              <Bell size={20} />
            </div>
            <p className="text-sm font-medium text-neutral-900">Sin alertas pendientes</p>
            <p className="mt-1 text-xs text-neutral-500">No hay nada que necesite tu atención ahora mismo.</p>
          </div>
        )}

        <ul className="divide-y divide-neutral-100">
          {(items ?? []).map((item) => {
            const esActual = item.href !== null && item.href === actual;
            return (
              <li
                key={item.id}
                className={`px-3 py-2.5 transition ${esActual ? "bg-brand-soft" : "hover:bg-neutral-50"}`}
              >
                <div className="flex items-start gap-2">
                  <span
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERIDAD[item.severity] ?? SEVERIDAD.warning}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-medium text-neutral-500">
                        {KINDS[item.kind] ?? item.kind}
                      </span>
                      <span className="text-xs text-neutral-400">· {timeAgo(item.createdAt)}</span>
                    </div>
                    <p className="mt-0.5 truncate text-sm font-medium text-neutral-900" title={item.title}>
                      {item.title}
                    </p>
                    {item.description && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-neutral-500">{item.description}</p>
                    )}
                    <div className="mt-1.5 flex items-center gap-1.5">
                      {item.href ? (
                        <button
                          type="button"
                          onClick={() => item.href && router.push(item.href)}
                          className="rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-neutral-700"
                        >
                          {esActual ? "Estás aquí" : "Ver"}
                        </button>
                      ) : (
                        <span className="text-xs text-neutral-400">Sin destino</span>
                      )}
                      <button
                        type="button"
                        onClick={() => void marcarVisto(item.id)}
                        disabled={ocupado === item.id}
                        className="rounded-md border border-neutral-200 px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
                      >
                        {ocupado === item.id ? "…" : "Marcar visto"}
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <footer className="border-t border-neutral-200 px-3 py-2">
        <div className="flex items-start gap-1.5">
          <AlertIcon size={12} className="mt-px shrink-0 text-neutral-400" />
          <p className="text-[11px] leading-snug text-neutral-400">
            Historial completo, incluidas las ya vistas, en{" "}
            <button
              type="button"
              onClick={() => router.push("/alerts")}
              className="font-medium text-neutral-500 underline hover:text-neutral-700"
            >
              /alerts
            </button>
            .
          </p>
        </div>
      </footer>
    </aside>
  );
}

function EstadoRow({
  label,
  ok,
  okLabel,
  badLabel,
}: {
  label: string;
  ok: boolean;
  okLabel: string;
  badLabel: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 py-1.5">
      <span className="text-xs font-medium text-neutral-700">{label}</span>
      <span
        className={
          "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold " +
          (ok ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700")
        }
      >
        {ok ? okLabel : badLabel}
      </span>
    </div>
  );
}
