"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export type Incidente = {
  id: string;
  kind: string;
  severity: "critical" | "warning";
  title: string;
  description: string | null;
  remedy: string | null;
  detected_at: string;
  muted_until: string | null;
};

function hace(desde: string): string {
  const min = Math.round((Date.now() - new Date(desde).getTime()) / 60000);
  if (min < 1) return "recién";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

export function SystemBannerClient({
  incidentes,
  puedeActuar = false,
}: {
  incidentes: Incidente[];
  puedeActuar?: boolean;
}) {
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Realtime: el incidente aparece (y desaparece) sin recargar. Es la mitad
  // de "detectarlo de inmediato" — detectarlo rápido no sirve si el operador
  // tiene que apretar F5 para verlo.
  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    let t: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => router.refresh(), 400);
    };
    const ch = supabase
      .channel("system-incidents-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "system_incidents" }, refresh)
      .subscribe();
    return () => {
      if (t) clearTimeout(t);
      supabase.removeChannel(ch);
    };
  }, [router]);

  // Red de contención por si el canal realtime se cae (pestaña dormida, red
  // intermitente): revalida sola cada 60s.
  useEffect(() => {
    const id = setInterval(() => router.refresh(), 60_000);
    return () => clearInterval(id);
  }, [router]);

  async function accion(url: string, clave: string) {
    setOcupado(clave);
    setError(null);
    try {
      const r = await fetch(url, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error ?? `Error ${r.status}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOcupado(null);
    }
  }

  const principal = incidentes[0];
  const critico = incidentes.some((i) => i.severity === "critical");
  const resto = incidentes.length - 1;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`shrink-0 border-b text-white ${
        critico ? "border-red-800 bg-red-600" : "border-amber-700 bg-amber-600"
      }`}
    >
      <div className="mx-auto flex max-w-[1600px] flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3">
        <span
          aria-hidden
          className={`hidden h-2.5 w-2.5 shrink-0 rounded-full bg-white sm:block ${
            critico ? "animate-pulse" : ""
          }`}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-snug">
            {principal.title}
            <span className="ml-2 font-normal text-white/75">{hace(principal.detected_at)}</span>
          </p>
          {principal.remedy && (
            <p className="mt-0.5 text-[13px] leading-snug text-white/90">{principal.remedy}</p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {puedeActuar && incidentes.some((i) => i.kind === "kommo_webhook_caido") && (
            <button
              onClick={() => accion("/api/kommo/reconnect-webhook", "webhook")}
              disabled={ocupado !== null}
              className="rounded-lg bg-white px-3 py-1.5 text-[13px] font-medium text-red-700 shadow-sm hover:bg-white/90 disabled:opacity-60"
            >
              {ocupado === "webhook" ? "Reconectando…" : "Reconectar webhook"}
            </button>
          )}
          {puedeActuar && incidentes.some((i) => i.kind === "cola_atascada") && (
            <button
              onClick={() => {
                if (
                  window.confirm(
                    "Los mensajes atascados se van a DESCARTAR: nunca se van a procesar ni responder. " +
                      "Quedan guardados para auditoría, pero el cliente no recibe respuesta. ¿Confirmás?",
                  )
                ) {
                  accion("/api/incidents/skip-queue", "omitir");
                }
              }}
              disabled={ocupado !== null}
              title="Darlos por perdidos. La franja se apaga sola en el próximo chequeo."
              className="rounded-lg bg-white px-3 py-1.5 text-[13px] font-medium text-red-700 shadow-sm hover:bg-white/90 disabled:opacity-60"
            >
              {ocupado === "omitir" ? "Omitiendo…" : "Omitir atascados"}
            </button>
          )}
          {(resto > 0 || principal.description) && (
            <button
              onClick={() => setAbierto((v) => !v)}
              className="rounded-lg border border-white/40 px-3 py-1.5 text-[13px] font-medium hover:bg-white/10"
            >
              {abierto ? "Ocultar" : resto > 0 ? `Ver detalle (+${resto})` : "Ver detalle"}
            </button>
          )}
          {puedeActuar && (
            <button
              onClick={() => accion(`/api/incidents/${principal.id}/mute`, "mute")}
              disabled={ocupado !== null}
              title="Ocultar 1 hora. Si el problema sigue, la franja vuelve sola."
              className="rounded-lg border border-white/40 px-3 py-1.5 text-[13px] font-medium hover:bg-white/10 disabled:opacity-60"
            >
              {ocupado === "mute" ? "…" : "Silenciar 1h"}
            </button>
          )}
        </div>
      </div>

      {abierto && (
        <div className="border-t border-white/25 bg-black/10 px-4 py-3">
          <ul className="mx-auto flex max-w-[1600px] flex-col gap-3">
            {incidentes.map((i) => (
              <li key={i.id} className="text-[13px] leading-snug">
                <p className="font-semibold">
                  {i.title}
                  <span className="ml-2 font-normal text-white/70">
                    {i.severity === "critical" ? "crítico" : "advertencia"} · {hace(i.detected_at)}
                  </span>
                </p>
                {i.description && <p className="mt-0.5 text-white/90">{i.description}</p>}
                {i.remedy && <p className="mt-0.5 text-white/75">→ {i.remedy}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p className="border-t border-white/25 bg-black/20 px-4 py-2 text-[13px]">{error}</p>
      )}
    </div>
  );
}
