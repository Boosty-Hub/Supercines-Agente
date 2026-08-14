"use client";

// Fuente única de los usuarios de Kommo para los selectores de cliente.
// Espeja exactamente a use-kommo-pipelines: un solo fetch por carga de página,
// compartido entre el selector de responsables del seguimiento y el panel de
// ruteo de leads.

import { useEffect, useState } from "react";
import type { KommoUser } from "@/lib/kommo";

export type { KommoUser };

export type KommoUsersState = {
  loading: boolean;
  error: string | null;
  /** false = Kommo sin credenciales todavía. */
  configured: boolean;
  users: KommoUser[];
};

type Payload = Omit<KommoUsersState, "loading" | "error">;

let inflight: Promise<Payload> | null = null;

function load(): Promise<Payload> {
  if (inflight) return inflight;
  inflight = (async () => {
    const res = await fetch("/api/kommo/users");
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
    return {
      configured: j.configured !== false,
      users: (j.users ?? []) as KommoUser[],
    };
  })().catch((e) => {
    inflight = null; // permitir reintento
    throw e;
  });
  return inflight;
}

export function useKommoUsers(): KommoUsersState {
  const [state, setState] = useState<KommoUsersState>({
    loading: true,
    error: null,
    configured: true,
    users: [],
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
            users: [],
          })
      );
    return () => {
      alive = false;
    };
  }, []);

  return state;
}
