// ¿El rol que viaja en el access token (JWT) quedó viejo respecto del usuario real?
//
// El middleware decide con `getUser()` (rol ACTUAL, leído de GoTrue), pero la RLS de PostgREST
// decide con el rol del JWT, que se fijó al emitirlo y dura hasta `jwt_expiry` (3600 s por
// default). Tras un cambio de rol hecho por fuera de la sesión —la migración que asigna
// `configuracion` a los usuarios viejos sin rol, o /usuarios al subir un alcance— el panel dejaba
// pasar al usuario pero la base le devolvía páginas vacías hasta 1 h. Si difieren, el middleware
// refresca la sesión (un JWT nuevo trae el rol actual). Puro: sin verificar firma (no decide
// acceso, solo si vale la pena refrescar).

function decodePayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    // atob + TextDecoder: corre igual en el runtime edge del middleware y en node (sin Buffer).
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const norm = (r: unknown): unknown => (r === undefined || r === null || r === "" ? null : r);

export function jwtRoleDesfasado(accessToken: string | null | undefined, userRole: unknown): boolean {
  if (!accessToken) return false;
  const payload = decodePayload(accessToken);
  if (!payload) return false;
  const meta = payload.app_metadata as Record<string, unknown> | undefined;
  return norm(meta?.role) !== norm(userRole);
}
