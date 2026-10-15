// _shared/health-detectores.ts
//
// Lógica PURA de los cuatro chequeos de `health-scan`: dado el estado ya
// obtenido (la respuesta de Kommo, el timestamp del último mensaje, el
// conteo de la cola), decide si hay que abrir un incidente y con qué texto.
// Separada de health-scan/index.ts para poder probarla sin levantar
// Supabase ni pegarle a la API de Kommo — index.ts se limita a hacer el I/O
// (fetch, query) y pasarle el resultado a estas funciones.
//
// Reusa `filterOurWebhooks` de `_shared/alerts-kommo-webhook.ts` en vez de
// reimplementar el filtro por destination: es la MISMA pregunta ("¿cuáles de
// estos webhooks son el nuestro?") que ya resuelve y prueba ese módulo para
// la alerta `kommo_webhook_disabled` de alerts-scan. Dos copias del filtro
// se desincronizan, y la que quede vieja es la que deja pasar lo que no debe.
import { filterOurWebhooks, type KommoWebhookHook } from "./alerts-kommo-webhook.ts";
import type { IncidentInput } from "./health-incidentes.ts";
import { maskDestination } from "./webhook-mask.ts";

// ---------------- Webhook de Kommo: sin suscripción o deshabilitado ----------------
/**
 * Asume que la respuesta de Kommo YA llegó con éxito (2xx) y ya se parseó.
 * El manejo de fallos reales (red, 5xx, token vencido) vive en index.ts, que
 * es fail-open a propósito: un timeout hacia Kommo no es evidencia de que
 * NUESTRO webhook esté caído.
 */
export function decidirWebhookKommo(
  webhooks: KommoWebhookHook[],
  destinationPath: string,
): IncidentInput | null {
  const nuestro = filterOurWebhooks(webhooks, destinationPath);

  if (nuestro.length === 0) {
    return {
      kind: "kommo_webhook_caido",
      severity: "critical",
      title: "No hay webhook de Kommo suscrito — no entra ningún mensaje",
      description:
        "Kommo no tiene ninguna suscripción apuntando a kommo-webhook. El sistema está ciego: no llegan leads ni mensajes nuevos.",
      remedy:
        "Reactivalo desde el botón 'Reconectar webhook' en esta misma franja, o re-corré el wizard /setup.",
      metadata: { webhooks_totales: webhooks.length },
    };
  }

  const deshabilitados = nuestro.filter((w) => w.disabled === true);
  if (deshabilitados.length === nuestro.length) {
    return {
      kind: "kommo_webhook_caido",
      severity: "critical",
      title: "Kommo deshabilitó el webhook — no entra ningún mensaje",
      description:
        "Kommo apaga la suscripción tras varias entregas fallidas seguidas. El sistema no recibe leads ni mensajes nuevos, y Kommo no reenvía lo perdido durante el apagón.",
      remedy:
        "Reactivalo desde el botón 'Reconectar webhook' en esta misma franja. Si se vuelve a apagar, revisá primero por qué fallaban las entregas.",
      // system_incidents la lee cualquier usuario con sesión: el destino va SIN el secreto.
      metadata: {
        destination: deshabilitados[0]?.destination ? maskDestination(deshabilitados[0].destination) : null,
      },
    };
  }

  return null;
}

// ---------------- Token de Kommo inválido ----------------
/** `status` es el código HTTP que devolvió `GET /api/v4/webhooks`. */
export function decidirTokenKommo(status: number): IncidentInput | null {
  if (status !== 401 && status !== 403) return null;
  return {
    kind: "kommo_token",
    severity: "critical",
    title: "Token de Kommo inválido — no se puede leer ni publicar",
    description: `Kommo respondió ${status} al consultar los webhooks.`,
    remedy:
      "Generá un long-lived token nuevo en Kommo (Ajustes → Integraciones) y pegalo en Configuración → Kommo.",
    metadata: { status },
  };
}

// ---------------- Ingesta viva ----------------
/**
 * `minutosMudos` ya viene calculado por el llamador a partir del
 * `created_at` del último mensaje inbound. `null` significa "nunca entró
 * nada" (instalación recién desplegada) — no hay nada que romper.
 */
export function decidirIngestaDetenida(
  minutosMudos: number | null,
  umbralMinutos: number,
  ultimoIngreso: string | null,
): IncidentInput | null {
  if (minutosMudos === null) return null;
  if (minutosMudos < umbralMinutos) return null;

  return {
    kind: "ingesta_detenida",
    severity: "critical",
    title: `Sin mensajes entrantes hace ${minutosMudos} min`,
    description:
      "Hace rato que no entra nada a la cola. Si Kommo sí está recibiendo conversaciones, el puente entre Kommo y el sistema está cortado.",
    remedy:
      "Revisá el estado del webhook de Kommo. Si figura activo, verificá que la Edge Function kommo-webhook responda.",
    metadata: { ultimo_ingreso: ultimoIngreso, minutos_mudos: minutosMudos },
  };
}

// ---------------- Cola atascada ----------------
export function decidirColaAtascada(
  atascados: number,
  umbral: number,
  minutos: number,
): IncidentInput | null {
  if (atascados < umbral) return null;

  return {
    kind: "cola_atascada",
    severity: "warning",
    title: `${atascados} mensajes atascados procesándose`,
    description: `Hay ${atascados} items tomados hace más de ${minutos} min que nunca terminaron. Son corridas que se cortaron a mitad; esos mensajes quedaron sin clasificar y sin respuesta.`,
    remedy:
      "Suele ser consecuencia de otra falla (proveedor de IA caído, cuota agotada). Resolvé el incidente de arriba primero — la cola se drena sola con los próximos barridos.",
    metadata: { atascados, umbral, minutos },
  };
}

// ---------------- Registro público de Supabase Auth abierto ----------------
/**
 * `disableSignup` es el `disable_signup` que expone GoTrue en `GET /auth/v1/settings` (público:
 * no necesita el token de Management API). Abierto = cualquiera con la anon key (pública) puede
 * crearse una cuenta. El panel no le da nada a un usuario sin rol, pero una cuenta que nadie dio
 * de alta no debería poder existir: el /first-run lo cierra al crear al maestro y este chequeo
 * avisa si quedó (o volvió a quedar) abierto.
 */
export function decidirRegistroAbierto(disableSignup: boolean): IncidentInput | null {
  if (disableSignup) return null;
  return {
    kind: "registro_abierto",
    severity: "critical",
    title: "Registro público abierto — cualquiera puede crearse una cuenta",
    description:
      "Supabase Auth acepta altas nuevas con la anon key (que es pública). Esas cuentas no ven nada del panel (sin rol = sin acceso), pero no deberían poder existir.",
    remedy:
      "Supabase → tu proyecto → Authentication → Sign In / Providers → desactivá «Allow new users to sign up» y guardá. Después revisá en Usuarios que no haya cuentas que nadie dio de alta.",
    metadata: { disable_signup: false },
  };
}
