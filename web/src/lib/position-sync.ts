// Pide al servidor que guarde la posición (etapa + pipeline) que Kommo tiene hoy
// para un lead (POST /api/leads/[id]/position). Puro: sin React, el fetch se inyecta.
//
// Las pedidas CONCURRENTES del mismo lead comparten una sola request. Así el
// ciclo montar → desmontar → montar de React 19 StrictMode (dev) no dispara dos
// POST, y la segunda corrida del efecto se engancha a la respuesta de la primera
// en vez de perderla: lo que se recuerda es la request EN VUELO, no «ya lo hice».
// Cuando la respuesta llega (bien o mal) se olvida, y un montaje posterior vuelve
// a consultar (el POST es idempotente: apply_lead_position respeta el orden de
// los eventos).

const enVuelo = new Map<string, Promise<boolean>>();

/** Resuelve `true` solo si el servidor aplicó un cambio (hay que refrescar la vista). */
export function requestPositionSync(
  leadId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const previa = enVuelo.get(leadId);
  if (previa) return previa;
  const pedida = (async () => {
    try {
      const res = await fetchImpl(`/api/leads/${leadId}/position`, { method: "POST" });
      if (!res.ok) return false;
      const json = (await res.json().catch(() => ({}))) as { outcome?: string };
      return json?.outcome === "applied";
    } catch {
      // fail-open: se sigue mostrando lo de Kommo; el webhook o el backfill lo guardan.
      return false;
    } finally {
      enVuelo.delete(leadId);
    }
  })();
  enVuelo.set(leadId, pedida);
  return pedida;
}
