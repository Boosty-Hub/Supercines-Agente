"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// Refresco en vivo de la conversación ABIERTA, y solo de ella. La lista tiene su
// propio refresco (inbox-shell.tsx), que ya no pasa por router.refresh().
//
// Antes `drafts` se escuchaba SIN filtro (no tiene lead_id) y en modo rápido:
// cualquier respuesta del agente a CUALQUIER lead recargaba la conversación
// abierta en 700 ms. Ahora se filtra por los ids de los mensajes que se están
// mostrando (`in` admite hasta 100 valores, justo MAX_MESSAGES): un draft nuevo
// siempre cuelga de un mensaje, y cuando llega un mensaje nuevo este componente
// se vuelve a montar con la lista de ids actualizada.
const RAPIDO_MS = 700;

export default function ConversationRealtime({
  leadId,
  messageIds,
}: {
  leadId: string;
  messageIds: string[];
}) {
  const router = useRouter();
  const idsKey = messageIds.slice(-100).join(",");

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refrescar = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        router.refresh();
      }, RAPIDO_MS);
    };

    // Nombre único por montaje: reusar un nombre fijo mientras `removeChannel`
    // (que es asíncrono) sigue en vuelo hace que Supabase tire
    // "cannot add postgres_changes callbacks ... after subscribe()".
    const channel = supabase
      .channel(`inbox-conv-${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `lead_id=eq.${leadId}` }, refrescar)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lead_stage_events", filter: `lead_id=eq.${leadId}` },
        refrescar
      );
    if (idsKey) {
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table: "drafts", filter: `message_id=in.(${idsKey})` },
        refrescar
      );
    }
    channel.subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [router, leadId, idsKey]);

  return null;
}
