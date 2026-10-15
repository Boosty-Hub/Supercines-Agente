// lib/provision/signup-lock.ts — cierra el registro público de Supabase Auth del proyecto.
//
// INVARIANT: this module MUST NOT import runtime-config.ts or service.ts (ni alias `@/`): lo usa
// /api/provision/register y lo prueba lib/provision-gate.test.ts con un fetch falso.
//
// Por qué: un proyecto Supabase nuevo nace con «Allow new users to sign up» ENCENDIDO. Con la anon
// key (pública por diseño) cualquiera hace `POST /auth/v1/signup` y obtiene una sesión válida del
// panel. El panel ya no le da nada a un usuario sin rol (lib/auth/roles.ts), pero una cuenta que
// nadie dio de alta no debería poder existir: el /first-run lo cierra al crear al maestro
// (`disable_signup: true`) y lo VERIFICA leyendo la config de vuelta. La Admin API (con la que se
// crean usuarios desde /usuarios) no se ve afectada por `disable_signup`.

export const MGMT_BASE = "https://api.supabase.com";

/** Lo que tiene que hacer una persona si el cierre automático falló. */
export const SIGNUP_LOCK_MANUAL_STEP =
  "Supabase → tu proyecto → Authentication → Sign In / Providers → desactivá «Allow new users to sign up» y guardá.";

export type SignupLockResult = { ok: true } | { ok: false; error: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function bodyText(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).slice(0, 300);
}

export async function lockPublicSignup(ref: string, token: string, fetchImpl: FetchLike = fetch): Promise<SignupLockResult> {
  const url = `${MGMT_BASE}/v1/projects/${encodeURIComponent(ref)}/config/auth`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    const patch = await fetchImpl(url, { method: "PATCH", headers, body: JSON.stringify({ disable_signup: true }) });
    if (!patch.ok) return { ok: false, error: `Management API respondió ${patch.status} al cerrar el registro: ${await bodyText(patch)}` };
    await patch.body?.cancel().catch(() => {});

    // Verificar: que el PATCH haya respondido 2xx no prueba que quedó cerrado.
    const get = await fetchImpl(url, { method: "GET", headers });
    if (!get.ok) return { ok: false, error: `No se pudo verificar el cierre del registro (${get.status}): ${await bodyText(get)}` };
    const cfg = (await get.json().catch(() => null)) as { disable_signup?: unknown } | null;
    if (cfg?.disable_signup !== true) {
      return { ok: false, error: "La configuración de Auth sigue con el registro público abierto (disable_signup no quedó en true)." };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `No se pudo cerrar el registro: ${e instanceof Error ? e.message : String(e)}` };
  }
}
