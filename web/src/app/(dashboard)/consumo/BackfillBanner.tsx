"use client";

import { useState } from "react";
import { Spinner } from "@/components/ui";

export function BackfillBanner() {
  const [state, setState] = useState<"idle" | "running" | "done">("idle");
  const [progress, setProgress] = useState(0);
  const [totalInserted, setTotalInserted] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setState("running");
    setProgress(0);
    setTotalInserted(0);
    setError(null);

    let cursor: string | null = null;
    let inserted = 0;
    let iterations = 0;
    const MAX_ITERATIONS = 50; // protección ante loops infinitos

    try {
      while (iterations < MAX_ITERATIONS) {
        const body: { cursor?: string } = {};
        if (cursor) body.cursor = cursor;

        const r = await fetch("/api/usage/backfill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!r.ok) {
          const t = await r.text().catch(() => "error desconocido");
          throw new Error(`${r.status}: ${t.slice(0, 200)}`);
        }

        const data = (await r.json()) as { done: boolean; cursor: string | null; inserted: number };
        inserted += data.inserted;
        cursor = data.cursor;
        iterations++;

        setTotalInserted(inserted);
        setProgress(data.done ? 100 : Math.min(95, iterations * 10));

        if (data.done) break;
      }

      setState("done");
      setProgress(100);
      // Reload para que el server component refleje los nuevos datos
      setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("idle");
    }
  }

  if (state === "done") {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
        Backfill completado — {totalInserted} eventos importados. Recargando...
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-amber-900">
          <span className="font-medium">Hay consumo histórico sin importar.</span>
          {" "}Importá las sesiones pasadas para ver el costo real desde el primer día.
        </div>
        <button
          onClick={run}
          disabled={state === "running"}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-800 disabled:opacity-60"
        >
          {state === "running" ? (
            <>
              <Spinner size={14} className="animate-spin" />
              Importando... {progress}%
            </>
          ) : (
            "Importar histórico"
          )}
        </button>
      </div>
      {state === "running" && (
        <div className="mt-2 h-1.5 w-full rounded-full bg-amber-200">
          <div
            className="h-1.5 rounded-full bg-amber-600 transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
      {error && (
        <p className="mt-1.5 text-xs text-red-700">Error: {error}</p>
      )}
    </div>
  );
}
