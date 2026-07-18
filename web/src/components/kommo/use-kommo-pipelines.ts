"use client";

// Fuente única de los embudos/etapas de Kommo para los selectores de cliente.
//
// Lo pedían por separado el selector de etapas ignoradas (Ajustes → Agente →
// Comportamiento) y el de etapas del seguimiento, cada uno con su propio
// useEffect, su propio estado loading/error/configured y su propia copia de los
// tipos. Acá se hace un solo fetch por carga de página y se comparte.
//
// Los tipos son los de lib/kommo.ts (los mismos que devuelve la API), en vez de
// las tres redeclaraciones locales que había.

import { useEffect, useState } from "react";
import type { KommoPipeline, KommoStage } from "@/lib/kommo";

export type { KommoPipeline, KommoStage };

export type KommoPipelinesState = {
  loading: boolean;
  error: string | null;
  /** false = Kommo sin credenciales todavía. */
  configured: boolean;
  pipelines: KommoPipeline[];
};

type Payload = Omit<KommoPipelinesState, "loading" | "error">;

let inflight: Promise<Payload> | null = null;

function load(): Promise<Payload> {
  if (inflight) return inflight;
  inflight = (async () => {
    const res = await fetch("/api/kommo/pipelines");
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
    return {
      configured: j.configured !== false,
      pipelines: (j.pipelines ?? []) as KommoPipeline[],
    };
  })().catch((e) => {
    inflight = null; // permitir reintento
    throw e;
  });
  return inflight;
}

export function useKommoPipelines(): KommoPipelinesState {
  const [state, setState] = useState<KommoPipelinesState>({
    loading: true,
    error: null,
    configured: true,
    pipelines: [],
  });

  useEffect(() => {
    let alive = true;
    load()
      .then((p) => alive && setState({ loading: false, error: null, ...p }))
      .catch(
        (e) =>
          alive &&
          setState({
            loading: false,
            error: e instanceof Error ? e.message : String(e),
            configured: true,
            pipelines: [],
          })
      );
    return () => {
      alive = false;
    };
  }, []);

  return state;
}
