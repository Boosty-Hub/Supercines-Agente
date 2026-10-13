// Edge Function: kommo-webhook
// Recibe webhooks de Kommo (mensajes, leads, etc), valida un secreto
// opcional, y encola el payload completo en `inbound_queue` para que
// un worker lo procese asincrónicamente. Responde 200 lo más rápido
// posible para que Kommo no reintente.
//
// URL pública (una vez deployada):
//   https://<project-ref>.supabase.co/functions/v1/kommo-webhook
//   (Kommo permite agregar ?secret=XXX como query param — si la env
//    KOMMO_WEBHOOK_SECRET está configurada, exigimos que coincida.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("KOMMO_WEBHOOK_SECRET") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

// Parse application/x-www-form-urlencoded con notación de brackets de Kommo
// ("leads[add][0][id]=123" → { leads: { add: [{ id: "123" }] } })
function parseFormBracketed(body: string): Record<string, unknown> {
  const params = new URLSearchParams(body);
  const result: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) {
    const path = key.replace(/\]/g, "").split("[");
    // deno-lint-ignore no-explicit-any
    let cursor: any = result;
    for (let i = 0; i < path.length; i++) {
      const seg = path[i];
      const last = i === path.length - 1;
      if (last) {
        cursor[seg] = value;
      } else {
        const nextIsArray = /^\d+$/.test(path[i + 1]);
        if (cursor[seg] == null) {
          cursor[seg] = nextIsArray ? [] : {};
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
// El costo sigue acotado por dos lados más: el coalescing de abajo (como mucho
// UN trigger cada 2 s por instancia) y que process-inbound solo ESCRIBE si la
// etapa/pipeline cambió (_shared/lead-position.ts). Este endpoint no hace más
// trabajo por eso: sigue siendo "insertar y responder" (invariante 6).
//
// FAIL-OPEN a propósito: ante cualquier forma que no sepamos inspeccionar
// (`_raw` de un body que no parseó, un grupo nuevo de Kommo) devolvemos true y
// disparamos igual. Perder el mensaje de un lead es muchísimo peor que gastar
// una invocación de más.
function isActionable(payload: Record<string, unknown>): boolean {
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

// Coalescing del trigger a process-inbound.
//
// ANTES: cada webhook disparaba su propio process-inbound y lo mantenía
// enganchado con EdgeRuntime.waitUntil hasta que TERMINABA de procesar el
// batch (hasta MAX_BATCH payloads con llamadas al clasificador + API de Kommo
// → minutos). El worker de kommo-webhook quedaba vivo tanto como el downstream,
// y con una ráfaga real eso agota el pool de workers → 5xx/546 en el endpoint
// → Kommo DESHABILITA el webhook (en KIA: apagones de 6 y 4 días seguidos).
//
// AHORA: como mucho un trigger cada TRIGGER_COALESCE_MS por instancia. No hace
// falta uno por webhook — process-inbound drena en lote y el cron barre cada
// minuto como piso. `lastTriggerAt` es module scope: vive lo que vive la
// instancia, que es exactamente el alcance que queremos limitar.
const TRIGGER_COALESCE_MS = 2000;
let lastTriggerAt = 0;

function triggerProcessInbound(): void {
  const now = Date.now();
  if (now - lastTriggerAt < TRIGGER_COALESCE_MS) return;
  lastTriggerAt = now;
  // process-inbound responde 202 de inmediato y drena en su propio waitUntil,
  // así que este fetch resuelve en milisegundos y libera el worker enseguida.
  const p = fetch(`${SUPABASE_URL}/functions/v1/process-inbound`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).catch((e) => console.warn("trigger process-inbound failed:", e));
  // @ts-ignore: EdgeRuntime existe en Supabase
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(p);
  }
}

// Techo duro para el insert. Sin esto, una conexión colgada a PostgREST
// retiene el worker indefinidamente y agota el pool de la función.
const INSERT_TIMEOUT_MS = 5000;

function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  const raw = await req.text();
  if (!raw) return {};
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(raw);
    } catch {
      return { _raw: raw };
    }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return parseFormBracketed(raw);
  }
  // Best-effort: probar JSON, si falla devolver raw
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

Deno.serve(async (req: Request) => {
  // Healthcheck / GET → 200
  if (req.method === "GET") {
    return new Response("kommo-webhook OK", { status: 200 });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Validar secreto si está configurado
  if (WEBHOOK_SECRET) {
    const url = new URL(req.url);
    const provided = url.searchParams.get("secret") ?? req.headers.get("x-webhook-secret");
    if (provided !== WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
  }

  try {
    const payload = await readBody(req);

    // RESPONDER PRIMERO, PERSISTIR DESPUÉS (invariante 6 del CLAUDE.md). Este es
    // el único endpoint que Kommo juzga: si no le contestamos rápido, DESHABILITA
    // el webhook y el sistema queda mudo durante días (le pasó a KIA: 6 y 4 días
    // seguidos, 219 mensajes perdidos, porque el insert se awaiteaba antes de
    // responder y la salud del webhook quedaba atada a la de Postgres/PostgREST).
    //
    // Tradeoff aceptado: si la DB está caída se pierde ESE payload (Kommo ya
    // recibió su 200 y no reintenta). Perder un payload puntual es
    // infinitamente más barato que perder TODO el tráfico por días. Los
    // reintentos cubren los hipos cortos, y `inbound_silence` es la red final.
    const persist = (async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const { error } = await withTimeout(
            supabase.from("inbound_queue").insert({
              source: "kommo_webhook",
              payload,
              status: "pending",
            }),
            INSERT_TIMEOUT_MS
          );
          if (!error) {
            // Solo si el payload trae trabajo real, y como mucho una vez cada
            // TRIGGER_COALESCE_MS. Lo demás lo levanta el sweep de pg_cron.
            if (isActionable(payload)) triggerProcessInbound();
            return;
          }
          console.error(`inbound_queue insert (intento ${attempt}):`, error.message);
        } catch (e) {
          console.error(`inbound_queue insert timeout/error (intento ${attempt}):`, e);
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
      }
      // Agotados los reintentos, ese payload se perdió: Kommo ya recibió su 200
      // y no lo va a reintentar. Un console.error NO alcanza — los logs de una
      // Edge Function no son consultables y se borran, así que el mensaje de un
      // cliente desaparecería sin dejar rastro que alguien pueda mirar después.
      // Se deja una alerta, que es lo único que convierte esto en visible.
      //
      // Mejor esfuerzo a propósito: si Postgres está caído del todo, este insert
      // también falla, y está bien — ese caso lo cubre `inbound_silence`. Lo que
      // esta alerta atrapa es el caso COMÚN y silencioso: un hipo de PostgREST
      // que se come un payload suelto mientras todo lo demás sigue andando.
      console.error("inbound_queue insert: agotados los reintentos, payload perdido");
      try {
        await supabase.from("alerts").insert({
          kind: "inbound_dropped",
          severity: "critical",
          title: "Se perdió un webhook de Kommo",
          description:
            "El insert a inbound_queue falló 3 veces seguidas (timeout o error de la base). " +
            "Kommo ya recibió 200 y NO lo reintenta, así que ese mensaje del cliente no entró al sistema. " +
            "Si se repite, revisá la salud de la base y de PostgREST.",
          ref_table: "inbound_queue",
          metadata: { intentos: 3, timeout_ms: INSERT_TIMEOUT_MS },
        });
      } catch (e) {
        console.error("no se pudo ni dejar la alerta de payload perdido:", e);
      }
    })();

    // @ts-ignore: EdgeRuntime existe en Supabase
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(persist);
    } else {
      await persist; // fallback local/test: sin waitUntil, mantener el comportamiento
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("kommo-webhook error:", err);
    return new Response(JSON.stringify({ ok: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
});
