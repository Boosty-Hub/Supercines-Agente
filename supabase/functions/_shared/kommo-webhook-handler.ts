// _shared/kommo-webhook-handler.ts
// El handler de kommo-webhook, separado de index.ts para poder probarlo con un cliente
// falso (el bundle de deploy solo lleva <slug>/index.ts + _shared/).
//
// INVARIANTE 6 (CLAUDE.md): Kommo DESHABILITA un webhook cuyo endpoint le falla de forma
// sostenida (KIA: apagones de 6 y 4 días, 219 mensajes perdidos). Por eso la request solo
// hace validaciones baratas (método, tamaño, parseo del cuerpo) y responde 200 de
// INMEDIATO; la autenticación (_shared/webhook-auth.ts, con el estado REAL de la base) y la
// persistencia corren después, en EdgeRuntime.waitUntil. Nada que dependa de Postgres o de
// PostgREST está en el camino de la respuesta.
//
// Trade-offs aceptados:
//   - Un rechazo (token incorrecto, o sin token en modo estricto) es un DESCARTE silencioso:
//     Kommo recibe 200 igual. El emisor no se entera; la auditoría queda en logs (sin el
//     token) y en la alerta `webhook_rejected` (kommo_webhook_note, estrangulada).
//   - Si el estado de autenticación nunca se pudo leer (base caída al arrancar la
//     instancia) se reintenta hasta STATE_DEADLINE_MS y, si sigue caída, el payload se
//     pierde con la alerta `inbound_dropped` (con la base caída tampoco se podría encolar).
//     Nunca se acepta en modo estricto por falta de estado.

// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { insertAlert } from "./alerts.ts";
import { authorizeWebhook, extractToken, type LoadOptions, noteWebhookRequest, withTimeout } from "./webhook-auth.ts";

/** Kommo manda payloads de pocos KB; algo mucho más grande no es Kommo. */
export const MAX_BODY_BYTES = 1_000_000;
/** Techo duro para el insert: una conexión colgada no retiene el worker indefinidamente. */
export const INSERT_TIMEOUT_MS = 5000;

// Parse application/x-www-form-urlencoded con notación de brackets de Kommo
// ("leads[add][0][id]=123" → { leads: { add: [{ id: "123" }] } })
//
// SEGURIDAD: corre ANTES de autorizar y las claves las pone el EMISOR. Con objetos {}
// normales, `__proto__[x]=1` o `constructor[prototype][x]=1` contaminaban Object.prototype
// de la instancia caliente (y con él cualquier lectura heredada, p. ej. opciones de
// seguridad como legacySecret). Por eso:
//  - todo se construye con Object.create(null) (sin cadena de prototipos);
//  - una clave con un segmento __proto__ / constructor / prototype se descarta ENTERA;
//  - se acota la profundidad, la cantidad de claves y el índice máximo de los arrays
//    (un `a[999999999]=x` armaría un array disperso gigante: DoS al serializarlo);
//  - nunca se lee una propiedad que no sea propia (Object.hasOwn).
// maxDepth 10: el payload real más profundo de Kommo es
// leads[update][0][custom_fields][0][values][0][value] = 8 segmentos; 10 deja margen sin
// abrir la puerta a anidados patológicos.
export const FORM_LIMITS = { maxDepth: 10, maxKeys: 5000, maxIndex: 1000 } as const;

/** Qué descartó el parser (contadores, nunca contenido). */
export type FormParseStats = { depth: number; keys: number; forbidden: number; index: number };
export const newFormParseStats = (): FormParseStats => ({ depth: 0, keys: 0, forbidden: 0, index: 0 });
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const INDEX_RE = /^\d{1,6}$/;

export function parseFormBracketed(body: string, stats: FormParseStats = newFormParseStats()): Record<string, unknown> {
  const params = new URLSearchParams(body);
  const result: Record<string, unknown> = Object.create(null);
  let n = 0;
  for (const [key, value] of params.entries()) {
    if (++n > FORM_LIMITS.maxKeys) {
      stats.keys++;
      break;
    }
    const path = key.replace(/\]/g, "").split("[");
    if (path.length > FORM_LIMITS.maxDepth) {
      stats.depth++;
      continue;
    }
    if (path.some((seg) => FORBIDDEN_SEGMENTS.has(seg))) {
      stats.forbidden++;
      continue;
    }
    // deno-lint-ignore no-explicit-any
    let cursor: any = result;
    for (let i = 0; i < path.length; i++) {
      const seg = path[i];
      // Un array solo admite índices numéricos acotados.
      if (Array.isArray(cursor) && (!INDEX_RE.test(seg) || Number(seg) > FORM_LIMITS.maxIndex)) {
        stats.index++;
        break;
      }
      if (i === path.length - 1) {
        cursor[seg] = value;
      } else {
        const nextIsArray = /^\d+$/.test(path[i + 1]); // todo-dígitos => array (el índice se valida arriba)
        const existing = Object.hasOwn(cursor, seg) ? cursor[seg] : undefined;
        if (existing === undefined || existing === null || typeof existing !== "object") {
          cursor[seg] = nextIsArray ? [] : Object.create(null);
        }
        cursor = cursor[seg];
      }
    }

  }
  return result;
}

// ¿El payload tiene algo que process-inbound sepa procesar de INMEDIATO?
// processPayload procesa `leads.add`, `leads.update`, `leads.status` y
// `message.add`. `update` / `status` son ~64% del tráfico real, pero solo
// importan cuando mueven al lead de etapa o de pipeline: es lo que mueve la
// tarjeta en el tablero del inbox (0061).
//
//  - `leads.status` (cambio de etapa) y `leads.add` / `message.add` disparan
//    process-inbound al instante: la tarjeta se mueve en vivo.
//  - `leads.update` SOLO se encola: el sweep de pg_cron (cada minuto) lo
//    procesa. En SuperCines los Salesbots escriben custom fields del lead todo
//    el día y cada escritura genera un leads.update; disparar una invocación por
//    cada ráfaga de esos eventos cambiaría 1.440 barridos/día por miles de
//    invocaciones para, casi siempre, no escribir nada. Un movimiento de etapa
//    siempre trae su `leads.status`, así que no se pierde tiempo real donde
//    importa, y el barrido igual sincroniza la posición de los `update`.
//
// El costo sigue acotado por dos lados más: el coalescing del trigger (como
// mucho UNO cada 2 s por instancia) y que process-inbound solo ESCRIBE si la
// etapa/pipeline cambió (_shared/lead-position.ts). Y en este endpoint el trabajo
// de fondo por request es "autenticar con el estado en caché + encolar"
// (kommo-webhook-handler.test.ts mide las consultas por request).
//
// FAIL-OPEN a propósito: ante cualquier forma que no sepamos inspeccionar
// (`_raw` de un body que no parseó, un grupo nuevo de Kommo) devolvemos true y
// disparamos igual. Perder el mensaje de un lead es muchísimo peor que gastar
// una invocación de más.
export function isActionable(payload: Record<string, unknown>): boolean {
  if (!payload || typeof payload !== "object") return true;
  if ("_raw" in payload) return true; // body que no se pudo parsear

  const group = (key: string): Record<string, unknown> | null => {
    const g = payload[key];
    return g && typeof g === "object" ? (g as Record<string, unknown>) : null;
  };
  const leads = group("leads");
  const message = group("message");
  // Ningún grupo conocido → puede ser una forma nueva de Kommo: disparar.
  if (!leads && !message) return true;
  return Boolean(leads?.add || leads?.status) || Boolean(message?.add);
}

export function parseBody(raw: string, contentType: string): Record<string, unknown> {
  const ct = contentType.toLowerCase();
  if (!raw) return {};
  if (ct.includes("application/json")) {
    try {
      return JSON.parse(raw);
    } catch {
      return { _raw: raw };
    }
  }
  if (ct.includes("application/x-www-form-urlencoded")) {
    const stats = newFormParseStats();
    const parsed = parseFormBracketed(raw, stats);
    // Lo descartado se registra (solo contadores): un payload legítimo de Kommo que
    // se pasara de los límites se vería acá; uno malicioso también.
    if (stats.depth + stats.keys + stats.forbidden + stats.index > 0) {
      console.warn(`kommo-webhook: el parser descartó claves del form (profundidad=${stats.depth}, claves=${stats.keys}, prohibidas=${stats.forbidden}, indice=${stats.index})`);
    }
    return parsed;
  }
  // Best-effort: probar JSON, si falla devolver raw
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

export type WebhookHandlerOptions = {
  /** Secreto legado por env (aceptado como uno más). */
  legacySecret?: string;
  /** Dispara process-inbound (coalescido por el llamador). */
  trigger?: () => void;
  /** Registra el trabajo de fondo (default: EdgeRuntime.waitUntil; sin él, se espera antes de responder). */
  background?: (p: Promise<unknown>) => void;
  /** Opciones de la carga del estado (tests). */
  auth?: LoadOptions;
  insertTimeoutMs?: number;
  /** Espera entre reintentos del insert (tests). */
  retryDelayMs?: number;
};

function edgeWaitUntil(): ((p: Promise<unknown>) => void) | null {
  // @ts-ignore: EdgeRuntime existe en Supabase
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) return (p) => EdgeRuntime.waitUntil(p);
  return null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function dropAlert(supabase: SupabaseClient, description: string, metadata: Record<string, unknown>) {
  const { error } = await insertAlert(supabase, {
    kind: "inbound_dropped",
    severity: "critical",
    title: "Se perdió un webhook de Kommo",
    description,
    ref_table: "inbound_queue",
    metadata,
  });
  if (error) console.error("no se pudo ni dejar la alerta de payload perdido:", error);
}

export function createKommoWebhookHandler(supabase: SupabaseClient, rawOptions: WebhookHandlerOptions = {}) {
  // Las opciones de seguridad (legacySecret, auth…) se leen SOLO como propiedades propias:
  // una copia con prototipo nulo no hereda nada de Object.prototype (defensa en profundidad
  // ante una contaminación de prototipo en la instancia).
  const options: WebhookHandlerOptions = Object.assign(Object.create(null), rawOptions);
  const insertTimeoutMs = options.insertTimeoutMs ?? INSERT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? 1000;

  // Encola con reintentos. Agotados, deja una alerta: Kommo ya recibió su 200 y no
  // reintenta, y un console.error solo no es consultable después.
  async function persist(payload: Record<string, unknown>): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { error } = await withTimeout(
          (supabase as any).from("inbound_queue").insert({ source: "kommo_webhook", payload, status: "pending" }),
          insertTimeoutMs,
        ) as { error: { message: string } | null };
        if (!error) {
          if (isActionable(payload)) options.trigger?.();
          return;
        }
        console.error(`inbound_queue insert (intento ${attempt}):`, error.message);
      } catch (e) {
        console.error(`inbound_queue insert timeout/error (intento ${attempt}):`, e);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * retryDelayMs));
    }
    console.error("inbound_queue insert: agotados los reintentos, payload perdido");
    // Mejor esfuerzo: si Postgres está caído del todo, esto también falla, y lo cubre
    // `inbound_silence`. Lo que atrapa es el hipo de PostgREST que se come un payload suelto.
    await dropAlert(
      supabase,
      "El insert a inbound_queue falló 3 veces seguidas (timeout o error de la base). " +
        "Kommo ya recibió 200 y NO lo reintenta, así que ese mensaje del cliente no entró al sistema. " +
        "Si se repite, revisá la salud de la base y de PostgREST.",
      { intentos: 3, timeout_ms: insertTimeoutMs },
    );
  }

  // Todo lo que depende de la base, DESPUÉS de responder.
  async function process(token: string | null, payload: Record<string, unknown>): Promise<void> {
    const decision = await authorizeWebhook(supabase, token, options.legacySecret ?? "", options.auth);
    if (decision.reason === "state_unavailable") {
      console.error("kommo-webhook: estado de autenticación ilegible tras reintentar; payload descartado");
      await dropAlert(
        supabase,
        "No se pudo leer el estado de autenticación del webhook (base caída o lenta) y no había uno conocido: " +
          "el payload se descartó sin encolar para no aceptar requests sin verificar. Kommo ya recibió 200 y NO lo reintenta. " +
          "Revisá la salud de la base y de PostgREST.",
        { motivo: "auth_state_unavailable" },
      );
      return;
    }
    // Estrangulado (1/min por tipo e instancia); no bloquea el encolado.
    const note = noteWebhookRequest(supabase, decision);
    if (!decision.allow) {
      // Sin el token: solo el motivo.
      console.warn(`kommo-webhook: descartado (${decision.reason})`);
      await note;
      return;
    }
    await Promise.all([note, persist(payload)]);
  }

  return async function handle(req: Request): Promise<Response> {
    // Healthcheck / GET → 200
    if (req.method === "GET") return new Response("kommo-webhook OK", { status: 200 });
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return json({ ok: false, error: "payload too large" }, 413);

    let payload: Record<string, unknown>;
    try {
      const raw = await req.text();
      if (raw.length > MAX_BODY_BYTES) return json({ ok: false, error: "payload too large" }, 413);
      payload = parseBody(raw, req.headers.get("content-type") ?? "");
    } catch (err) {
      console.error("kommo-webhook: no se pudo leer el cuerpo:", err instanceof Error ? err.message : err);
      return json({ ok: false });
    }

    const token = extractToken(new URL(req.url), req.headers);
    const work = process(token, payload).catch((e) => console.error("kommo-webhook: error en segundo plano:", e));
    const bg = options.background ?? edgeWaitUntil();
    if (bg) bg(work);
    else await work; // fallback local: sin waitUntil, mantener el comportamiento
    return json({ ok: true });
  };
}
