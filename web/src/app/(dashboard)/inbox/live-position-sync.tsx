"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

// La conversación leyó de Kommo una etapa/pipeline distinta de la guardada. La
// página (GET) NO escribe nada: este componente pide, una sola vez por lead, que
// el servidor la guarde (POST /api/leads/[id]/position) y refresca la vista y el
// tablero cuando termina. Sin UI propia.
export default function LivePositionSync({ leadId }: { leadId: string }) {
  const router = useRouter();
  const hecho = useRef<string | null>(null);

  useEffect(() => {
    if (hecho.current === leadId) return;
    hecho.current = leadId;
    // SIN bandera de cancelación: con el guard `hecho` de arriba, el StrictMode de
    // React 19 (monta, desmonta y vuelve a montar) corría el efecto UNA vez, lo
    // cancelaba en el cleanup y la segunda pasada salía por el guard — la respuesta
    // se perdía y la etapa nunca se guardaba. Un refresh tras desmontar es inocuo.
    void fetch(`/api/leads/${leadId}/position`, { method: "POST" })
      .then(async (res) => {
        if (!res.ok) return;
        const json = await res.json().catch(() => ({}));
        if (json?.outcome === "applied") {
          window.dispatchEvent(new Event("inbox:reload"));
          router.refresh();
        }
      })
      .catch(() => {
        /* fail-open: se sigue mostrando lo de Kommo; el webhook o el backfill lo guardan */
      });
  }, [leadId, router]);

  return null;
}
