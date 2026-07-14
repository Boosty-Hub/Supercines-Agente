"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui";

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  telegram: "Telegram",
  other: "Otro",
};

export default function InboxFilters({
  channels,
  verticals,
  searchPlaceholder = "Buscar nombre o mensaje…",
  collapsible = false,
  inline = false,
}: {
  channels: string[];
  verticals: string[];
  searchPlaceholder?: string;
  collapsible?: boolean;
  /** Todos los filtros en una sola fila horizontal a lo ancho (inbox). */
  inline?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const [q, setQ] = useState(sp.get("q") ?? "");
  const [open, setOpen] = useState(false);

  // Debounce de la búsqueda de texto
  useEffect(() => {
    const cur = sp.get("q") ?? "";
    if (q === cur) return;
    const t = setTimeout(() => apply("q", q), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function apply(key: string, value: string) {
    const params = new URLSearchParams(sp.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    const lead = sp.get("lead");
    if (lead) params.set("lead", lead);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  function clearAll() {
    const params = new URLSearchParams();
    const lead = sp.get("lead");
    if (lead) params.set("lead", lead);
    setQ("");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  const activeCount =
    (sp.get("q") ? 1 : 0) +
    (sp.get("channel") ? 1 : 0) +
    (sp.get("vertical") ? 1 : 0) +
    (sp.get("estado") ? 1 : 0) +
    (sp.get("rango") ? 1 : 0) +
    (sp.get("sort") && sp.get("sort") !== "recent" ? 1 : 0) +
    (sp.get("urgent") === "1" ? 1 : 0);
  const active = activeCount > 0;

  const selectCls =
    "rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-700 focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900";

  const show = !collapsible || open;

  const searchEl = (
    <input
      type="search"
      value={q}
      onChange={(e) => setQ(e.target.value)}
      placeholder={searchPlaceholder}
      className={
        "rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900 " +
        (inline ? "min-w-[180px] flex-1" : "w-full")
      }
    />
  );

  const controls = (
    <>
      <select
        value={sp.get("channel") ?? ""}
        onChange={(e) => apply("channel", e.target.value)}
        className={selectCls}
      >
        <option value="">Canal: todos</option>
        {channels.map((c) => (
          <option key={c} value={c}>
            {CHANNEL_LABEL[c] ?? c}
          </option>
        ))}
      </select>

      <select
        value={sp.get("vertical") ?? ""}
        onChange={(e) => apply("vertical", e.target.value)}
        className={selectCls}
      >
        <option value="">Vertical: todas</option>
        {verticals.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>

      <select
        value={sp.get("estado") ?? ""}
        onChange={(e) => apply("estado", e.target.value)}
        className={selectCls}
      >
        <option value="">Estado: todos</option>
        <option value="waiting">Esperando respuesta</option>
        <option value="answered">Respondidos</option>
        <option value="review">Pendientes de review</option>
        <option value="toxic">Tóxicos</option>
      </select>

      <select
        value={sp.get("rango") ?? ""}
        onChange={(e) => apply("rango", e.target.value)}
        className={selectCls}
      >
        <option value="">Fecha: todo</option>
        <option value="1h">Última hora</option>
        <option value="today">Últimas 24h</option>
        <option value="7d">Últimos 7 días</option>
        <option value="30d">Últimos 30 días</option>
      </select>

      <select
        value={sp.get("sort") ?? "recent"}
        onChange={(e) =>
          apply("sort", e.target.value === "recent" ? "" : e.target.value)
        }
        className={selectCls}
      >
        <option value="recent">Orden: más recientes</option>
        <option value="oldest">Más antiguos primero</option>
        <option value="urgency">Mayor urgencia</option>
        <option value="messages">Más mensajes</option>
      </select>

      <button
        type="button"
        onClick={() => apply("urgent", sp.get("urgent") === "1" ? "" : "1")}
        className={
          "rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors " +
          (sp.get("urgent") === "1"
            ? "border-red-300 bg-red-50 text-red-700"
            : "border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-50")
        }
      >
        Solo urgentes
      </button>

      {active && (
        <Button type="button" variant="ghost" size="sm" onClick={clearAll}>
          Limpiar
        </Button>
      )}
    </>
  );

  // Modo inline: search + todos los filtros en UNA fila a lo ancho (inbox).
  if (inline) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {searchEl}
        {controls}
      </div>
    );
  }

  return (
    <div className="mt-3">
      {collapsible && (
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setOpen((o) => !o)}
          >
            <span>Filtros</span>
            {activeCount > 0 && (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-neutral-900 px-1 text-[10px] font-semibold text-white">
                {activeCount}
              </span>
            )}
            <span
              className={
                "text-[10px] text-neutral-400 transition-transform " +
                (open ? "rotate-180" : "")
              }
            >
              ▼
            </span>
          </Button>
          {active && !open && (
            <Button type="button" variant="ghost" size="sm" onClick={clearAll}>
              Limpiar
            </Button>
          )}
        </div>
      )}
      {show && (
        <div className={collapsible ? "mt-2 space-y-2" : "space-y-2"}>
          {searchEl}
          <div className="flex flex-wrap gap-2">{controls}</div>
        </div>
      )}
    </div>
  );
}
