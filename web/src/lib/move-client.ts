"use client";

// Cola ÚNICA de movimientos de etapa del navegador: el tablero (arrastrar) y el menú
// «Mover a…» de la conversación comparten esta instancia, así que dos movimientos del
// mismo lead se serializan aunque salgan de componentes distintos.
// La lógica vive en move-queue.ts (pura, con tests); acá solo el transporte HTTP.
import { MoveQueue, type SendResult } from "./move-queue";

async function sendMove(
  leadId: string,
  dest: { pipeline: number; stage: number },
  expected: { pipeline: number | null; stage: number | null }
): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(`/api/leads/${leadId}/stage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pipeline_id: dest.pipeline,
        stage_id: dest.stage,
        expected: { pipeline_id: expected.pipeline, stage_id: expected.stage },
      }),
    });
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
  const json = await res.json().catch(() => ({}));
  if (res.status === 409 && json?.code === "position_changed") {
    const c = json.current ?? {};
    return {
      kind: "conflict",
      current: {
        pipeline: typeof c.pipeline_id === "number" ? c.pipeline_id : null,
        stage: typeof c.stage_id === "number" ? c.stage_id : null,
      },
    };
  }
  if (!res.ok) return { kind: "error", message: json.error ?? `HTTP ${res.status}` };
  return { kind: "ok", warning: typeof json.warning === "string" ? json.warning : undefined };
}

export const leadMoves = new MoveQueue(sendMove);
