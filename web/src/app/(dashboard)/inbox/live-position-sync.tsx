"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { requestPositionSync } from "@/lib/position-sync";

// La conversación leyó de Kommo una etapa/pipeline distinta de la guardada. La
// página (GET) NO escribe nada: este componente pide que el servidor la guarde
// (POST /api/leads/[id]/position) y refresca la vista y el tablero cuando termina.
// Sin UI propia.
//
// Robusto a React 19 StrictMode (dev: montar → desmontar → montar): la request en
// vuelo se comparte entre montajes (lib/position-sync) y cada efecto se engancha a
// ella. Antes un ref marcaba «hecho» al EMPEZAR y el 2º montaje salía sin pedir,
// mientras el 1º ya estaba cancelado: el refresh se perdía.
export default function LivePositionSync({ leadId }: { leadId: string }) {
  const router = useRouter();

  useEffect(() => {
    let vigente = true;
    void requestPositionSync(leadId).then((applied) => {
      if (!vigente || !applied) return;
      window.dispatchEvent(new Event("inbox:reload"));
      router.refresh();
    });
    return () => {
      vigente = false;
    };
  }, [leadId, router]);

  return null;
}
