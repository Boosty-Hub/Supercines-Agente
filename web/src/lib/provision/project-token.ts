// lib/provision/project-token.ts — el «secreto de arranque» del /first-run: el token sbp_ de la
// cuenta de Supabase que es DUEÑA de este proyecto.
//
// INVARIANT: no importa runtime-config.ts ni service.ts (ni alias `@/`): lo prueba un fetch falso.
//
// El problema: en un despliegue recién creado (host con la URL pública y sin usuarios), el primero
// que llame POST /api/provision/register se queda con el panel como maestro. Quien lo desplegó es
// quien tiene acceso al proyecto de Supabase, así que se le exige lo único que solo él tiene: un
// token sbp_ con el que la Management API pueda LEER ESTE proyecto (el `ref` sale de
// NEXT_PUBLIC_SUPABASE_URL, nunca del body). Un token ajeno, inventado o de otra cuenta no pasa.

export const MGMT_BASE = "https://api.supabase.com";

export type ProjectTokenResult = { ok: true } | { ok: false; status: 401 | 403 | 502; error: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function validateProjectToken(ref: string, token: string, fetchImpl: FetchLike = fetch): Promise<ProjectTokenResult> {
  if (!token.trim()) return { ok: false, status: 401, error: "Falta el token de Supabase (sbp_…)." };
  try {
    const res = await fetchImpl(`${MGMT_BASE}/v1/projects/${encodeURIComponent(ref)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token.trim()}` },
    });
    await res.body?.cancel().catch(() => {});
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return {
        ok: false,
        status: 403,
        error: "Ese token de Supabase no tiene acceso a este proyecto. Usá un token de la cuenta que lo creó.",
      };
    }
    return { ok: false, status: 502, error: `No se pudo validar el token con Supabase (${res.status}); reintentá.` };
  } catch (e) {
    return { ok: false, status: 502, error: `No se pudo validar el token con Supabase: ${e instanceof Error ? e.message : String(e)}` };
  }
}
