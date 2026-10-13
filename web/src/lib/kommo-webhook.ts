// Lógica PURA del webhook autenticado de Kommo (sin I/O): URL con secreto y plan de
// actualización de la suscripción en Kommo. La parte con I/O vive en
// lib/kommo-webhook-apply.ts (que usan /api/kommo/webhook-auth y /api/kommo/reconnect-webhook).
//
// Kommo no firma sus webhooks: el control es un secreto en la URL (?token=). La Edge
// Function (supabase/functions/_shared/webhook-auth.ts) lo compara en tiempo constante.

export const WEBHOOK_PATH = "/functions/v1/kommo-webhook";
export const SETTINGS_DEFAULT = ["add_lead", "add_message", "update_lead"];

/** Destino completo que se registra en Kommo: <SUPABASE_URL>/functions/v1/kommo-webhook?token=<secreto>. */
export function webhookDestination(supabaseUrl: string, secret: string | null | undefined): string {
  const base = `${supabaseUrl.replace(/\/+$/, "")}${WEBHOOK_PATH}`;
  return secret ? `${base}?token=${encodeURIComponent(secret)}` : base;
}

/**
 * Enmascara el token para logs/mensajes de error/respuestas: nunca se vuelve a mostrar
 * completo fuera del panel. Sirve para URLs y para texto libre (errores de Kommo).
 * Copia exacta en supabase/functions/_shared/webhook-mask.ts (paridad en web-parity.test.ts).
 */
export function maskDestination(destination: string): string {
  return destination.replace(/(token|secret)=[^&#\s"'<>]+/gi, "$1=***");
}

export type KommoHook = { destination?: string | null; settings?: string[] | null; disabled?: boolean | null };

export type WebhookPlan = {
  /** Eventos a suscribir: los que ya tenía el nuestro (no se pisan los que el operador sumó a mano). */
  settings: string[];
  /** Suscripciones nuestras (mismo path) con OTRO destino: se dan de baja tras registrar la nueva. */
  toDelete: string[];
  /** ¿Ya existe exactamente el destino pedido? */
  alreadyRegistered: boolean;
};

/**
 * Qué hacer para que Kommo apunte SOLO a `destination`. Kommo no permite editar la URL
 * de una suscripción: se registra la nueva (POST, idempotente por destino) y después se
 * da de baja la vieja (DELETE), en ese orden, para que nunca haya una franja sin webhook.
 */
export function planWebhookUpdate(hooks: KommoHook[], destination: string): WebhookPlan {
  const ours = hooks.filter((h) => (h.destination ?? "").includes(WEBHOOK_PATH));
  const exact = ours.find((h) => h.destination === destination);
  const source = exact ?? ours.find((h) => Array.isArray(h.settings) && h.settings.length > 0);
  const settings = source?.settings && source.settings.length > 0 ? [...source.settings] : SETTINGS_DEFAULT;
  return {
    settings,
    toDelete: ours.map((h) => h.destination as string).filter((d) => d !== destination),
    alreadyRegistered: Boolean(exact),
  };
}

/** Ventana en la que una request SIN clave hace riesgoso pasar a estricto. */
export const STRICT_UNSIGNED_WINDOW_MS = 3600 * 1000;

export type StrictBlocker = { code: "never_signed" | "recent_unsigned"; message: string };

/**
 * ¿Pasar a modo estricto cortaría el webhook real? Pura: el servidor la usa para responder
 * 409 (salvo `force`) y el panel muestra el motivo antes de confirmar.
 *  - nunca llegó una request con clave → Kommo todavía no usa la URL nueva;
 *  - llegó una SIN clave hace menos de una hora → hay un webhook (o una cuenta) sin actualizar.
 */
export function strictModeBlocker(
  auth: { last_signed_at?: string | null; last_unsigned_at?: string | null } | null | undefined,
  nowMs = Date.now(),
): StrictBlocker | null {
  if (!auth?.last_signed_at) {
    return {
      code: "never_signed",
      message:
        "Todavía no llegó ninguna request de Kommo con la clave: Kommo sigue usando la URL vieja. En modo estricto dejarían de entrar los mensajes.",
    };
  }
  const unsigned = auth.last_unsigned_at ? Date.parse(auth.last_unsigned_at) : NaN;
  if (Number.isFinite(unsigned) && nowMs - unsigned < STRICT_UNSIGNED_WINDOW_MS) {
    const min = Math.max(1, Math.round((nowMs - unsigned) / 60_000));
    return {
      code: "recent_unsigned",
      message: `Hace ${min} min llegó una request SIN la clave: hay un webhook en Kommo que todavía usa la URL vieja. En modo estricto esas requests se rechazarían.`,
    };
  }
  return null;
}

/** Nuevo secreto: 48 caracteres hex (192 bits) del CSPRNG. */
export function generateWebhookSecret(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
