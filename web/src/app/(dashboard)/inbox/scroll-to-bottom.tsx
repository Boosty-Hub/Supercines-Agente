"use client";

import { useEffect, useRef } from "react";

// Ancla al final de la conversación. Cuando cambia `dep` (el lead seleccionado)
// o llega un mensaje nuevo, hace scroll al fondo del panel de conversación.
export default function ScrollToBottom({ dep }: { dep: string | null }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollIntoView({ block: "end" });
  }, [dep]);

  return <div ref={ref} aria-hidden />;
}
