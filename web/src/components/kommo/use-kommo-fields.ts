"use client";

// Fuente única de los custom fields de Kommo para todos los selectores.
//
// Antes cada selector hacía su propio fetch a /api/kommo/fields. Con los
// módulos unificados en Ajustes, los tres consumidores (apagado por lead,
// comentarios de IG y publicación de Kommo) se montan en la MISMA página: eso
// eran tres peticiones idénticas al abrir la pestaña. Acá el fetch se hace una
// sola vez por carga de página y se comparte.

import { useEffect, useState } from "react";

export type KommoFieldLite = {
  id: number;
  name: string;
  type: string;
  entity: "leads" | "contacts";
};

export type KommoFieldsState = {
  loading: boolean;
  /** true = fetch fallido; el consumidor degrada a input numérico. */
  failed: boolean;
  /** false = Kommo sin credenciales todavía. */
  configured: boolean;
  leads: KommoFieldLite[];
  contacts: KommoFieldLite[];
};

type Payload = Omit<KommoFieldsState, "loading" | "failed">;

// Cache a nivel de módulo: se resuelve una vez y todos los hooks comparten la
// misma promesa. Se descarta si falla, para que un reintento (remontaje) pueda
// volver a pedirla.
let inflight: Promise<Payload> | null = null;

function load(): Promise<Payload> {
  if (inflight) return inflight;
  inflight = (async () => {
    const res = await fetch("/api/kommo/fields");
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
    return {
      configured: j.configured !== false,
      leads: (j.leads ?? []) as KommoFieldLite[],
      contacts: (j.contacts ?? []) as KommoFieldLite[],
    };
  })().catch((e) => {
    inflight = null; // permitir reintento
    throw e;
  });
  return inflight;
}

export function useKommoFields(): KommoFieldsState {
  const [state, setState] = useState<KommoFieldsState>({
    loading: true,
    failed: false,
    configured: true,
    leads: [],
    contacts: [],
  });

  useEffect(() => {
    let alive = true;
    load()
      .then((p) => alive && setState({ loading: false, failed: false, ...p }))
      .catch(
        () =>
          alive &&
          setState({ loading: false, failed: true, configured: true, leads: [], contacts: [] })
      );
    return () => {
      alive = false;
    };
  }, []);

  return state;
}

/** Etiqueta legible del tipo de campo de Kommo. */
export const KOMMO_TYPE_LABEL: Record<string, string> = {
  text: "texto",
  textarea: "texto largo",
  numeric: "número",
  checkbox: "casilla (sí/no)",
  select: "lista",
  multiselect: "lista múltiple",
  date: "fecha",
  date_time: "fecha/hora",
  url: "url",
  radiobutton: "opción",
  multitext: "multi (tel/email)",
  birthday: "cumpleaños",
};
