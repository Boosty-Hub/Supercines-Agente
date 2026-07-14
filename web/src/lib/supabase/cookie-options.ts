/**
 * Embed-friendly cookie attributes (CHIPS) for when this agent is framed
 * cross-site by the Boosty Hub workspace.
 *
 * A default `SameSite=Lax` session cookie is NOT sent inside a cross-site
 * iframe, so the brokered magic-link logs in but the session evaporates on the
 * next request → the app bounces back to /login. `SameSite=None; Secure` lets
 * the cookie ride the cross-site request, and `Partitioned` (CHIPS) scopes it
 * to the embedding top-level site so modern browsers still accept it even with
 * third-party cookies blocked.
 *
 * Applied ONLY in an embedded context (see `isEmbeddedContext`) so normal
 * top-level use — and local http dev, where `Secure` cookies can't be set —
 * keeps the safer `SameSite=Lax` default.
 */
export const EMBED_COOKIE_OPTIONS = {
  sameSite: "none",
  secure: true,
  partitioned: true,
} as const;

/** Browser-side: true when this document is running inside an iframe. */
export function isEmbeddedContext(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    // Cross-origin access to window.top throws → we ARE in a foreign frame.
    return true;
  }
}
