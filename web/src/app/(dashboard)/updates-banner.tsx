"use client";

// Banner global de actualizaciones del sistema (migraciones + Edge Functions).
//
// Reemplaza al viejo AutoUpdater (toast abajo-derecha) y unifica los dos modos
// en un solo lugar, montado en el layout del dashboard → visible en TODAS las
// pestañas (agente, seguimiento, etc.):
//   - auto-update ON  → aplica solo en la primera visita del build (igual que
//     antes), mostrando el progreso en el banner. Guard 1x por sesión.
//   - auto-update OFF → muestra "Hay N actualizaciones disponibles" con un botón
//     "Actualizar ahora" para aplicarlas manualmente desde cualquier pestaña.
//
// El drift se detecta en /api/provision/updates (server-side, con el token sbp
// guardado en DB — no hay que pegarlo acá). Aplicar es idempotente: usa los
// mismos endpoints que el panel de /settings (migrate + functions/deploy).

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type FnStatus = "missing" | "changed" | "ok";
type FnItem = { slug: string; status: FnStatus };
type Updates = {
  ok: boolean;
  hasSupabaseEnv: boolean;
  hasToken?: boolean;
  migrations: { applied: number; total: number; pending: string[] };
  functions: { total: number; items: FnItem[] };
};

type Phase = "checking" | "available" | "updating" | "done" | "error";

const AUTO_GUARD = "auto-update-checked";
const DISMISS_KEY = "updates-banner-dismissed";

export function UpdatesBanner({ autoUpdate }: { autoUpdate: boolean }) {
  const router = useRouter();
  const [data, setData] = useState<Updates | null>(null);
  const [phase, setPhase] = useState<Phase>("checking");
  const [progress, setProgress] = useState("");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const apply = useCallback(
    async (items: FnItem[]) => {
      setPhase("updating");
      setErrMsg(null);
      try {
        // 1) Migraciones (el route aplica de a una; loop como el panel).
        for (let i = 0; i < 60; i++) {
          setProgress("Aplicando migraciones…");
          const r = await fetch("/api/provision/migrate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          const m = await r.json();
          if (!r.ok || !m.ok) throw new Error(m.error || `migrate HTTP ${r.status}`);
          if (m.done || !m.justApplied) break;
        }
        // 2) Funciones cambiadas/faltantes, una por una.
        const todo = items.filter((i) => i.status !== "ok");
        let done = 0;
        for (const fn of todo) {
          setProgress(`Desplegando ${fn.slug} (${done + 1}/${todo.length})…`);
          const r = await fetch("/api/provision/functions/deploy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ slug: fn.slug }),
          });
          const d = await r.json();
          if (!r.ok || !d.ok) throw new Error(d.error || `deploy ${fn.slug} falló`);
          done++;
        }
        setProgress("");
        setPhase("done");
        router.refresh();
        setTimeout(() => setPhase("checking"), 5000);
        setTimeout(() => setData(null), 5000); // tras refresh, ocultar
      } catch (err) {
        setErrMsg(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    },
    [router]
  );

  useEffect(() => {
    let cancelled = false;
    setDismissed(sessionStorage.getItem(DISMISS_KEY) === "1");
    (async () => {
      let j: Updates | null = null;
      try {
        const res = await fetch("/api/provision/updates");
        if (!res.ok) {
          if (!cancelled) setPhase("checking");
          return;
        }
        j = (await res.json()) as Updates;
      } catch {
        return;
      }
      if (cancelled || !j) return;
      setData(j);
      // Sin entorno / sin token / sin updates → no se muestra nada.
      if (!j.ok || !j.hasSupabaseEnv || j.hasToken === false) {
        setPhase("checking");
        return;
      }
      const pendingMig = j.migrations?.pending ?? [];
      const fnsToUpdate = (j.functions?.items ?? []).filter((i) => i.status !== "ok");
      if (pendingMig.length === 0 && fnsToUpdate.length === 0) {
        setPhase("checking");
        return;
      }
      // Hay actualizaciones. Si auto-update está ON y no corrió esta sesión,
      // las aplicamos solas; si no, mostramos el banner accionable.
      if (autoUpdate && !sessionStorage.getItem(AUTO_GUARD)) {
        sessionStorage.setItem(AUTO_GUARD, "1");
        await apply(j.functions.items);
      } else {
        setPhase("available");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apply, autoUpdate]);

  const pendingMig = data?.migrations.pending ?? [];
  const fnsToUpdate = (data?.functions.items ?? []).filter((i) => i.status !== "ok");
  const count = pendingMig.length + fnsToUpdate.length;

  // Resumen legible: "1 migración · 2 funciones"
  const parts: string[] = [];
  if (pendingMig.length > 0)
    parts.push(`${pendingMig.length} migración${pendingMig.length > 1 ? "es" : ""}`);
  if (fnsToUpdate.length > 0)
    parts.push(`${fnsToUpdate.length} función${fnsToUpdate.length > 1 ? "es" : ""}`);
  const detail = parts.join(" · ");

  function dismiss() {
    sessionStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  }

  // Nada que mostrar
  if (phase === "checking") return null;
  if (phase === "available" && (dismissed || count === 0)) return null;

  const tone =
    phase === "error"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : phase === "done"
        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
        : "border-blue-200 bg-blue-50 text-blue-900";

  return (
    <div className={`shrink-0 border-b px-4 py-2.5 ${tone}`}>
      <div className="flex items-center gap-3 text-sm">
        {phase === "updating" && (
          <>
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-500" />
            <span className="font-medium">Actualizando el sistema…</span>
            {progress && <span className="text-blue-700">{progress}</span>}
          </>
        )}

        {phase === "done" && (
          <>
            <span className="shrink-0">✓</span>
            <span className="font-medium">Sistema actualizado correctamente</span>
          </>
        )}

        {phase === "error" && (
          <>
            <span className="shrink-0">⚠️</span>
            <span className="min-w-0 flex-1">
              <span className="font-medium">No se pudo actualizar.</span>{" "}
              <span className="text-amber-800">{errMsg}</span>
            </span>
            <button
              type="button"
              onClick={() => data && apply(data.functions.items)}
              className="shrink-0 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-700"
            >
              Reintentar
            </button>
            <a
              href="/settings"
              className="shrink-0 text-xs font-medium text-amber-800 underline"
            >
              Configuración
            </a>
          </>
        )}

        {phase === "available" && (
          <>
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="font-medium">
                Hay {count} actualización{count > 1 ? "es" : ""} disponible{count > 1 ? "s" : ""}
              </span>
              {detail && <span className="ml-1 text-blue-700">· {detail}</span>}
            </span>
            <button
              type="button"
              onClick={() => data && apply(data.functions.items)}
              className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700"
            >
              Actualizar ahora
            </button>
            <button
              type="button"
              onClick={dismiss}
              aria-label="Cerrar aviso"
              className="shrink-0 rounded p-1 text-blue-500 transition-colors hover:bg-blue-100 hover:text-blue-700"
            >
              ✕
            </button>
          </>
        )}
      </div>
    </div>
  );
}
