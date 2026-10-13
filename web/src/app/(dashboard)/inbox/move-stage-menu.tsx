"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { BoardPipeline } from "@/lib/inbox-data";
import { leadMoves } from "@/lib/move-client";

// "Mover a…" en la cabecera de la conversación: la alternativa al arrastre en
// móvil (el drag & drop nativo no existe con el dedo) y la única forma de
// pasar un lead a OTRO pipeline (el tablero muestra uno a la vez).
// Dos pasos a propósito —elegir y confirmar— para que un toque accidental en
// el select no mueva un lead real en Kommo.
export default function MoveStageMenu({
  leadId,
  pipelineId,
  stageId,
  pipelines,
}: {
  leadId: string;
  pipelineId: number | null;
  stageId: number | null;
  pipelines: BoardPipeline[];
}) {
  const router = useRouter();
  const current = pipelineId != null && stageId != null ? `${pipelineId}:${stageId}` : "";
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mover() {
    const [p, s] = value.split(":").map(Number);
    setBusy(true);
    setError(null);
    // Misma cola que el tablero: si la tarjeta se está moviendo desde ahí, este
    // movimiento espera su turno y gana el último destino.
    const out = await leadMoves.enqueue(leadId, { pipeline: p, stage: s }, { pipeline: pipelineId, stage: stageId });
    if (out.kind === "failed") {
      setError(out.message);
      setValue(current);
    } else {
      // done / noop / superseded (otro movimiento posterior manda): recargar la posición real.
      if (out.kind === "done" && out.warning) setError(out.warning);
      window.dispatchEvent(new Event("inbox:reload"));
      router.refresh();
    }
    setBusy(false);
  }

  if (pipelines.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <label className="sr-only" htmlFor={`mover-${leadId}`}>
        Mover a otra etapa
      </label>
      <select
        id={`mover-${leadId}`}
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        className="max-w-[16rem] rounded-lg border border-neutral-300 bg-white px-2 py-1 text-[11px] text-neutral-700 focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900"
      >
        {!current && <option value="">Mover a…</option>}
        {pipelines.map((p) => (
          <optgroup key={p.id} label={p.name}>
            {p.stages.map((s) => (
              <option key={s.id} value={`${p.id}:${s.id}`}>
                {s.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {value && value !== current && (
        <button
          type="button"
          onClick={mover}
          disabled={busy}
          className="rounded-lg bg-neutral-900 px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50"
        >
          {busy ? "Moviendo…" : "Mover en Kommo"}
        </button>
      )}
      {error && <span className="text-[11px] text-red-600">{error}</span>}
    </div>
  );
}
