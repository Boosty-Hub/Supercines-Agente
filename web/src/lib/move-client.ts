"use client";

// Cola ÚNICA de movimientos de etapa del navegador: el tablero (arrastrar) y el menú
// «Mover a…» de la conversación comparten esta instancia, así que dos movimientos del
// mismo lead se serializan aunque salgan de componentes distintos.
// La lógica vive en move-queue.ts (pura, con tests); acá solo el transporte HTTP.
import { interpretMoveResponse, MoveQueue, type SendResult } from "./move-queue";

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
  return interpretMoveResponse(res.status, json);
}

export const leadMoves = new MoveQueue(sendMove);
