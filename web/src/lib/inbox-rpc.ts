// Llamadas a las funciones del inbox paginado (0079) desde las rutas /api/inbox/*, con el
// error traducido: si la migración todavía no se aplicó (la web nueva llega antes que la base
// en el centro de actualizaciones) la API responde 503 `migration_pending` con un mensaje
// accionable en vez de un 500 críptico.
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

export class InboxRpcError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined
  ) {
    super(message);
  }
}

export async function rpcOrThrow(supabase: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new InboxRpcError(`${fn}: ${error.message}`, error.code);
  return data;
}

/** PGRST202 = PostgREST no encuentra la función; 42883 = Postgres no la encuentra. */
export function isMissingFunction(code: string | undefined): boolean {
  return code === "PGRST202" || code === "42883";
}

export function inboxRpcError(e: unknown): NextResponse {
  if (e instanceof InboxRpcError && isMissingFunction(e.code)) {
    return NextResponse.json(
      {
        error: "El inbox se actualizó y falta aplicar la migración 0085 de la base.",
        code: "migration_pending",
      },
      { status: 503 }
    );
  }
  return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
}
