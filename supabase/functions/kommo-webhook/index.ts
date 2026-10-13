// Edge Function: kommo-webhook
// Recibe webhooks de Kommo (mensajes, leads, etc.), responde 200 DE INMEDIATO y, en
// segundo plano (EdgeRuntime.waitUntil), valida el secreto de la URL con el estado real
// de la base (_shared/webhook-auth.ts) y encola el payload en `inbound_queue` para que
// process-inbound lo procese. El handler vive en _shared/kommo-webhook-handler.ts (con tests).
//
// URL pública (una vez deployada):
//   https://<project-ref>.supabase.co/functions/v1/kommo-webhook
//   ?token=<secreto>   (lo muestra el dashboard: Configuración → Kommo)
//
// POR QUÉ ESTA FUNCIÓN ES PÚBLICA (única excepción al gate interno): Kommo NO firma
// sus webhooks (no hay HMAC ni header de autenticación que verificar) y no manda un
// JWT de Supabase, así que no puede presentar el secreto interno que exigen las
// demás funciones (_shared/auth.ts). Mitigaciones:
//   - Secreto en la URL (?token=, tabla _app_secrets), comparado en tiempo constante.
//     Lo que no trae un secreto válido (en modo estricto) o trae uno incorrecto se
//     DESCARTA sin encolar; Kommo recibe 200 igual (un 4xx/5xx sostenido haría que
//     Kommo deshabilite el webhook, invariante 6). Modo 'permissive' (transición de
//     clientes vivos: acepta también sin secreto y alerta) o 'strict'. Sin él,
//     cualquiera podía postear un leads.update con fecha futura y congelar a un lead.
//   - Lo único que hace es ENCOLAR el payload (inbound_queue): no ejecuta nada del
//     payload, no llama a modelos ni a Kommo. El procesamiento (process-inbound) es
//     una función con gate interno y trata el payload como dato no confiable (cada
//     campo se valida; el texto del lead entra a los prompts saneado, ver
//     _shared/untrusted.ts).
//   - El trigger a process-inbound está coalescido (≤ 1 cada 2 s por instancia) y
//     todo lo que toca la base corre después de responder: un flood no multiplica el
//     trabajo, solo llena la cola, que el reaper y el barrido de pg_cron acotan.
//   - Alertas: inbound_dropped (insert fallido o estado de auth ilegible),
//     webhook_unsigned / webhook_rejected (kommo_webhook_note) e
//     inbound_silence/kommo_webhook_* (apagón) en alerts-scan / health-scan.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { callInternal } from "../_shared/auth.ts";
import { createKommoWebhookHandler } from "../_shared/kommo-webhook-handler.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Secreto legado por env (aceptado como uno más; el vigente vive en _app_secrets).
const LEGACY_ENV_SECRET = Deno.env.get("KOMMO_WEBHOOK_SECRET") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

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
  // process-inbound exige el secreto interno (callInternal lo lee de _app_secrets,
  // con caché de 60 s): el webhook sigue siendo público, lo que dispara no.
  const p = callInternal(supabase, "process-inbound", {}).catch((e) =>
    console.warn("trigger process-inbound failed:", e)
  );
  // @ts-ignore: EdgeRuntime existe en Supabase
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(p);
  }
}

Deno.serve(
  createKommoWebhookHandler(supabase, { legacySecret: LEGACY_ENV_SECRET, trigger: triggerProcessInbound }),
);
