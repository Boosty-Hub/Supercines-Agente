"use client";

// Selector visual de etapas del embudo de Kommo para el seguimiento.
// Reemplaza el viejo textarea de "IDs separados por coma": trae los pipelines
// reales desde /api/kommo/pipelines y deja marcar 1-2 etapas con un clic.
// Si Kommo no está conectado o la lectura falla, cae a mostrar las etapas
// guardadas como chips para no perder la configuración.

import { useEffect, useState } from "react";

type Stage = { id: number; name: string; color?: string };
type Pipeline = { id: number; name: string; statuses: Stage[] };

export function StageSelector({
  value,
  onChange,
}: {
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const [pipelines, setPipelines] = useState<Pipeline[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/kommo/pipelines", { cache: "no-store" });
        const j = await res.json();
        if (cancelled) return;
        if (!j.ok) {
          setError(j.error ?? "No se pudieron leer las etapas de Kommo.");
          setPipelines(null);
        } else if (!j.configured) {
          setError("Kommo todavía no está conectado.");
          setPipelines(null);
        } else {
          setPipelines((j.pipelines ?? []) as Pipeline[]);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Error de red");
          setPipelines(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = new Set(value);
  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next).sort((a, b) => a - b));
  }

  // Mapa id→nombre para mostrar chips legibles aún si la lectura falla.
  const stageName = new Map<number, string>();
  (pipelines ?? []).forEach((p) => p.statuses.forEach((s) => stageName.set(s.id, s.name)));

  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-neutral-600">
        Etapas donde se hace seguimiento
      </label>
      <p className="text-[11px] text-neutral-500">
        Marcá en qué etapas del embudo el agente sigue insistiendo (normalmente
        una o dos). Si no marcás ninguna, el seguimiento corre en{" "}
        <span className="font-medium">todas</span> las etapas.
      </p>

      {loading ? (
        <p className="text-xs text-neutral-400">Cargando etapas de Kommo…</p>
      ) : error ? (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          ⚠ {error}
          {value.length > 0 && (
            <span className="mt-1 block text-amber-700">
              Etapas guardadas:{" "}
              {value.map((id) => stageName.get(id) ?? `#${id}`).join(", ")}.
            </span>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {(pipelines ?? []).map((p) => (
            <div key={p.id} className="rounded-lg border border-neutral-200 p-3">
              <p className="mb-2 text-xs font-semibold text-neutral-700">{p.name}</p>
              <div className="flex flex-wrap gap-1.5">
                {p.statuses.map((s) => {
                  const on = selected.has(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => toggle(s.id)}
                      aria-pressed={on}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                        on
                          ? "border-neutral-900 bg-neutral-900 text-white"
                          : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400"
                      }`}
                    >
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: s.color ?? "#cbd5e1" }}
                      />
                      {s.name}
                      {on && <span aria-hidden>✓</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {value.length === 0 ? (
            <p className="rounded-lg bg-neutral-50 px-3 py-2 text-[11px] text-neutral-500">
              Ninguna etapa marcada → el seguimiento corre en todas las etapas.
            </p>
          ) : (
            <p className="text-[11px] text-neutral-500">
              {value.length} etapa{value.length === 1 ? "" : "s"} marcada
              {value.length === 1 ? "" : "s"} — solo ahí se hace seguimiento.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
