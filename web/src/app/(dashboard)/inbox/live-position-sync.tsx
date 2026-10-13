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
    let cancelado = false;
    void fetch(`/api/leads/${leadId}/position`, { method: "POST" })
      .then(async (res) => {
        if (cancelado || !res.ok) return;
        const json = await res.json().catch(() => ({}));
        if (json?.outcome === "applied") {
          window.dispatchEvent(new Event("inbox:reload"));
          router.refresh();
        }
      })
      .catch(() => {
        /* fail-open: se sigue mostrando lo de Kommo; el webhook o el backfill lo guardan */
      });
    return () => {
      cancelado = true;
    };
  }, [leadId, router]);

  return null;
}
