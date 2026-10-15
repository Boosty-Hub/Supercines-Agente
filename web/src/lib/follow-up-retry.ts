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
  const ta = timestampMicros(a.sentAt);
  const tb = timestampMicros(b.sentAt);
  if (ta !== tb) {
    // Un sent_at ilegible cuenta como el más viejo (nunca le gana a uno legible).
    if (ta === null) return false;
    if (tb === null) return true;
    return ta > tb;
  }
  return a.id.toLowerCase() > b.id.toLowerCase();
}

const TS_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)$/i;

/**
 * Microsegundos desde epoch de un timestamptz tal como lo devuelve PostgREST
 * (`2026-10-13T12:00:00.123456+00:00`, fracción de 0 a 6 dígitos, cualquier offset), como
 * BigInt: la MISMA precisión que `sent_at` en la base. `Date.parse` trunca a milisegundos
 * y dos intentos en el mismo milisegundo quedarían empatados (y se desempatarían por id
 * aunque la base diga otra cosa). null si no es un timestamp reconocible.
 */
export function timestampMicros(ts: string): bigint | null {
  const m = TS_RE.exec(ts.trim());
  if (!m) return null;
  const [, date, time, frac = "", zone] = m;
  const offset = zone.toUpperCase() === "Z" ? "Z" : zone.length === 3 ? `${zone}:00` : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const ms = Date.parse(`${date}T${time}${offset}`);
  if (Number.isNaN(ms)) return null;
  // Más de 6 dígitos (no lo produce Postgres) se trunca a microsegundos.
  const micros = BigInt((frac + "000000").slice(0, 6));
  return BigInt(ms) * BigInt(1000) + micros;
}
