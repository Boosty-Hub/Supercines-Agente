// Reintento manual de un seguimiento POR INTENTO (0077): lógica pura compartida por
// la ruta /api/follow-up/retry y el panel /seguimiento.
//
// Un intento (fila de `follow_ups`) solo se puede reintentar si es el ÚLTIMO de su
// (lead, paso): si hubo uno posterior, la fila es historia y reintentarla repetiría (o
// confirmaría) algo que la persona no está mirando. El servidor lo verifica de forma
// atómica al reservar (claim_follow_up → `superseded`, 409); el panel ni siquiera
// muestra el botón en esas filas.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RetryBody = {
  followUpId: string;
  step: number;
  force: boolean;
  confirmResend: boolean;
};

/** Valida el body de POST /api/follow-up/retry: { followUpId, step, force?, confirmResend? }. */
export function parseRetryBody(body: unknown): { ok: true; value: RetryBody } | { ok: false; error: string } {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body inválido" };
  }
  const b = body as Record<string, unknown>;
  const id = Object.hasOwn(b, "followUpId") ? b.followUpId : undefined;
  if (typeof id !== "string" || !UUID_RE.test(id.trim())) {
    return { ok: false, error: "falta followUpId (el intento a reintentar)" };
  }
  const step = Object.hasOwn(b, "step") ? b.step : undefined;
  if (typeof step !== "number" || !Number.isInteger(step) || step < 1) {
    return { ok: false, error: "falta step (el paso del intento, entero ≥ 1)" };
  }
  return {
    ok: true,
    value: {
      followUpId: id.trim().toLowerCase(),
      step,
      force: Object.hasOwn(b, "force") && b.force === true,
      confirmResend: Object.hasOwn(b, "confirmResend") && b.confirmResend === true,
    },
  };
}

export type AttemptRow = { id: string; leadId: string; step: number; sentAt: string };

/**
 * IDs de los intentos que son el ÚLTIMO de su (lead, paso) dentro de `rows`. Mismo
 * orden que la base (sent_at desc, id desc). `rows` debe ser un prefijo del log
 * ordenado por sent_at desc (las N filas más nuevas): así, si un intento está en la
 * lista, todos los posteriores también.
 */
export function latestAttemptIds(rows: readonly AttemptRow[]): Set<string> {
  const latest = new Map<string, AttemptRow>();
  for (const r of rows) {
    const key = `${r.leadId}:${r.step}`;
    const cur = latest.get(key);
    if (!cur || isNewer(r, cur)) latest.set(key, r);
  }
  return new Set([...latest.values()].map((r) => r.id));
}

function isNewer(a: AttemptRow, b: AttemptRow): boolean {
  const ta = Date.parse(a.sentAt);
  const tb = Date.parse(b.sentAt);
  if (ta !== tb) return ta > tb;
  return a.id.toLowerCase() > b.id.toLowerCase();
}
