"use client";

// Botón "Reintentar" de un seguimiento que quedó en `failed`. Vive fuera de
// cualquier <Link> de fila para no anidar un botón dentro de un <a> (HTML
// inválido, y cada click navegaría además de reintentar).
//
// Ningún camino de fallo del scan avanza el estado del lead, así que el paso
// no se consumió: reintentar vuelve a correr el mismo paso.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { truncateGraphemes } from "@/lib/text-safe";

type RetryResponse = {
  ok?: boolean;
  /** El sistema está frenado (`system_halted`). OJO: viene con `ok: true`,
   *  porque para la Edge Function no es un fallo sino una decisión del
   *  operador — pero NO se envió nada, así que tiene que chequearse ANTES
   *  que `ok` o el botón dice "Enviado ✓" sobre un mensaje que nunca salió. */
  halted?: boolean;
  skipped?: string;
  outsideHours?: boolean;
  status?: string;
  error?: string | null;
};

export function FollowUpRetryButton({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);

  async function run(force: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/follow-up/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId, force }),
      });
      const j = (await res.json().catch(() => null)) as RetryResponse | null;

      // ANTES que `ok`: ver la nota en RetryResponse.
      if (j?.halted) {
        setMsg({
          tone: "warn",
          text: "No se envió: el sistema está frenado (apagado total). Reactivalo en Ajustes.",
        });
        return;
      }
      if (j?.ok) {
        setMsg({ tone: "ok", text: "Enviado ✓" });
        router.refresh();
        return;
      }
      // Fuera de horario: se ofrece forzar, confirmando. No se manda solo.
      if (j?.outsideHours && !force) {
        if (
          window.confirm(
            "Está fuera del horario laboral configurado. ¿Enviar el seguimiento igual, ahora?"
          )
        ) {
          await run(true);
          return;
        }
        setMsg({ tone: "warn", text: "No se envió (fuera de horario)." });
        return;
      }
      if (j?.skipped) {
        setMsg({ tone: "warn", text: `No se envió: ${j.skipped}` });
        router.refresh();
        return;
      }
      // Volvió a fallar: el motivo real viene en `error`.
      setMsg({
        tone: "err",
        text: j?.error ? `Falló de nuevo: ${truncateGraphemes(j.error, 120)}` : "Falló de nuevo.",
      });
      router.refresh();
    } catch (err) {
      setMsg({ tone: "err", text: err instanceof Error ? err.message : "error de red" });
    } finally {
      setBusy(false);
    }
  }

  const toneCls =
    msg?.tone === "ok"
      ? "text-emerald-600"
      : msg?.tone === "warn"
        ? "text-amber-700"
        : "text-red-600";

  return (
    <div className="mt-1.5 flex items-center gap-2">
      <button
        type="button"
        onClick={() => run(false)}
        disabled={busy}
        className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-[11px] font-medium text-neutral-700 shadow-sm transition-colors hover:bg-neutral-50 disabled:opacity-60"
      >
        {busy ? "Reintentando…" : "↻ Reintentar"}
      </button>
      {msg && <span className={`text-[11px] leading-snug ${toneCls}`}>{msg.text}</span>}
    </div>
  );
}
