// server-only: valida sesión + alcance en una ruta de API o una página de servidor.
//
// Toda ruta/página que lee config o secretos con el cliente de servicio (runtime-config,
// supabase/service) pasa por acá ANTES de leer: el middleware ya filtra por prefijo, pero una
// ruta no puede depender de que nadie haya reordenado PATH_SCOPES (test-guardia:
// lib/config-access.test.ts exige la llamada y que el alcance coincida con el de PATH_SCOPES).
import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { RUTA_SIN_ACCESO, type Scope } from "@/lib/auth/roles";
import { authorizeScope, configWriterFor, type ConfigWriter } from "@/lib/auth/scope-guard";

type SessionClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export type ScopeGranted = {
  readonly ok: true;
  readonly supabase: SessionClient;
  readonly user: User;
  readonly scope: Scope;
  /** Única forma de obtener con qué llamar a setConfigValues. */
  readonly writer: ConfigWriter;
};

/** Rutas de API: 401 sin sesión, 403 sin alcance. */
export async function requireScope(
  required: Scope
): Promise<ScopeGranted | { readonly ok: false; readonly response: NextResponse }> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const decision = authorizeScope(user, required);
  if (!decision.ok) {
    return { ok: false, response: NextResponse.json({ error: decision.error }, { status: decision.status }) };
  }
  return { ok: true, supabase, user: user!, scope: decision.scope, writer: configWriterFor(user, decision.scope) };
}

/**
 * Páginas de servidor: sin sesión → /login; sin rol → /sin-acceso; sin alcance suficiente →
 * /inbox (lo que todo alcance ve).
 */
export async function requirePageScope(required: Scope): Promise<ScopeGranted> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const decision = authorizeScope(user, required);
  if (!decision.ok) redirect(decision.status === 401 ? "/login" : decision.sinAcceso ? RUTA_SIN_ACCESO : "/inbox");
  return { ok: true, supabase, user: user!, scope: decision.scope, writer: configWriterFor(user, decision.scope) };
}
