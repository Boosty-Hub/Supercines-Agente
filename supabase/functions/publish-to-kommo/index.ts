// Edge Function: publish-to-kommo
//
// Publica en Kommo los drafts con status='approved':
//   1. PATCH /api/v4/leads/{kommo_lead_id} — actualiza el custom field con la respuesta
//   2. POST  /api/v2/salesbot/run — dispara el salesbot que lee el campo y envía al canal
//
// Si publishing_enabled=false en kommo_publish_config, no hace nada (shadow mode).
//
// CONTRATO HTTP (desde 0074): responde **202 {ok, accepted:true, run_id}** de
// inmediato y publica dentro de EdgeRuntime.waitUntil (invariante 2 del CLAUDE.md).
// Antes publicaba de forma síncrona (PATCH + salesbot + verificación de hasta 12 s
// por draft) ANTES de responder: el panel corta a los 4 s y pg_net a los 30 s, el
// runtime mataba la función a mitad y el draft quedaba `approved` aunque el salesbot
// ya hubiera salido → el siguiente barrido lo reenviaba (WhatsApp DUPLICADO). Los
// conteos (published/undelivered/failed/expired/…) ya NO vienen en la respuesta:
// quedan en el log (`publish-to-kommo run <id>: …`) y en el estado de cada draft.
// Ningún llamador los usaba (cron: ignora el cuerpo; panel y generate-response: solo
// miran el status HTTP). Sin EdgeRuntime (tests/local) corre síncrono y devuelve 200
// con los conteos, como antes. Los cortes tempranos (apagado total, sin config,
// shadow mode) siguen respondiendo 200 síncrono.
//
// IDEMPOTENCIA DEL ENVÍO (máquina de estados de 0074, decisiones en _shared/draft-publish.ts):
//   · Cada draft se RESERVA de a uno con claim_draft_for_publish (approved →
//     publishing, dueño = run_id, lease de 10 min). De dos reservas concurrentes
//     (barrido de pg_cron vs. aprobación en el panel vs. generate-response) gana UNA.
//   · Antes de CADA salesbot (respuesta pública y DM) se fija la marca write-ahead
//     `publish_sending_at` (mark_draft_publish_sending). Si el lease venció o lo tomó
//     otro, la marca falla y no se dispara nada → a lo sumo UN envío por reserva.
//   · Escribir el campo (PATCH) no le manda nada al cliente: lo envía el salesbot.
//     (Supuesto: la cuenta no tiene un trigger de Kommo que dispare un bot al
//     cambiar ese campo; el template siempre lo dispara por API.)
//   · Si el worker muere: sin la marca → recover_dead_draft_publishes lo devuelve a
//     `approved` (reintento seguro; a las 3 reservas muertas → failed). Con la marca
//     (murió después de PATCH+marca, durante o después del salesbot, o antes de
//     registrar el resultado) → NUNCA se reenvía: se verifica en Kommo si apareció un
//     saliente nuevo respecto de la foto previa → `auto_sent` (delivery_recovered), y
//     si no se puede confirmar → `failed` + alerta para revisión humana.
//     Muerte entre la respuesta pública y el DM: la pública salió y el DM no; no hay
//     foto del DM → failed + alerta (reenviar duplicaría el comentario público).
//   · Toda escritura final lleva la guarda `status='publishing' AND publish_owner=yo`.
//
// Apagado total (system_halted, 0057): si está en true, NO se publica NADA,
// ni siquiera drafts que ya estaban 'approved' antes de que el operador
// activara el switch. Decisión deliberada: esta es la ÚNICA función de las
// seis que efectivamente le manda un mensaje a un cliente real — un "apagado
// total" que deje salir lo que ya estaba aprobado no corta "los mensajes
// salientes automáticos" (el problema que motiva este switch), lo posterga
// unos minutos nada más. No se pierde nada: el draft se queda con
// status='approved' y sent_at IS NULL, así que claim_draft_for_publish lo vuelve a
// levantar solo, en el mismo orden, en cuanto el operador reactiva el
// sistema. La alternativa (dejar pasar lo ya aprobado) premia justo el caso
// más peligroso: un draft aprobado por bypass_review —sin ojos humanos—
// segundos antes del incidente que hizo que alguien frenara todo. El switch se
// relee antes de reservar cada draft: activarlo frena también una corrida en curso.
//
// Soporte de comentarios de Instagram:
//   Si el draft tiene agent_metadata.from_comment=true y agent_metadata.public_reply
//   y comment_reply_enabled=true y están configurados comment_field_id + comment_salesbot_id:
//   - ANTES del flujo normal, escribe la respuesta pública (generada por IA) en
//     comment_field_id y dispara comment_salesbot_id (fail-open: si falla, el DM normal sigue).
//   - El flujo normal (campo normal + salesbot normal) SIEMPRE corre.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { authorizeInternal, callInternal } from "../_shared/auth.ts";
import { truncateGraphemes } from "../_shared/text-safe.ts";
import { loadConfig } from "../_shared/config.ts";
import { draftText, OutboundBlockedError, outboundLeak, writeClientText } from "../_shared/outbound.ts";
import {
  runSalesbot,
  fetchOutgoingEventIds,
  verifyOutgoingDelivery,
} from "../_shared/kommo.ts";
import { isHaltedRow, haltedResponse, logHalted } from "../_shared/halt.ts";
import { isStaleBacklog } from "../_shared/backlog.ts";
import {
  finalPatch,
  LeaseLostError,
  PUBLISH_LEASE_SECONDS,
  PUBLISH_MAX_ATTEMPTS,
  resolveInterrupted,
  runPublishLoop,
  type DraftOutcome,
  type PublishTally,
} from "../_shared/draft-publish.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

type KommoConfig = {
  id: string;
  response_custom_field_id: number | null;
  salesbot_id: number | null;
  publishing_enabled: boolean;
  auto_reply_mode: "auto" | "review_only";
  // Línea de corte: nunca publicar drafts anteriores a esta fecha (go-live).
  publish_from: string | null;
  // Comentarios de Instagram
  comment_reply_enabled: boolean;
  comment_salesbot_id: number | null;
  comment_field_id: number | null;
  // Apagado total (0057) — se agrega a este select existente, cero
  // round-trips extra (ver _shared/halt.ts).
  system_halted: boolean;
  // Ventana de frescura (0040/0064) — mismo default (1h) que generate-response
  // y process-inbound. Se usa para vencer drafts auto-aprobados que quedaron
  // esperando publicación desde antes de una pausa larga (ver isExpiredAutoApproved).
  answer_max_age_hours: number;
};

type Verify = { enabled: boolean; timeoutMs: number };

async function getConfig(): Promise<KommoConfig | null> {
  const { data, error } = await supabase
    .from("kommo_publish_config")
    .select(
      "id, response_custom_field_id, salesbot_id, publishing_enabled, auto_reply_mode, publish_from, comment_reply_enabled, comment_salesbot_id, comment_field_id, system_halted, answer_max_age_hours"
    )
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`config: ${error.message}`);
  return data;
}

type ClaimedDraft = {
  id: string;
  message_id: string;
  body: string;
  edited_body: string | null;
  agent_metadata: Record<string, unknown> | null;
  reviewer_id: string | null;
  created_at: string;
  publish_baseline: string[] | null;
  // Sin el hint de FK el cliente tipado infiere `messages` como 1:N; en runtime es
  // un objeto único (lead del mensaje).
  // deno-lint-ignore no-explicit-any
  messages: any;
};

const DRAFT_SELECT =
  "id, message_id, body, edited_body, agent_metadata, reviewer_id, created_at, publish_baseline, messages!drafts_message_id_fkey(lead_id, leads(kommo_lead_id, display_name))";

async function loadDraft(id: string): Promise<ClaimedDraft> {
  const { data, error } = await supabase.from("drafts").select(DRAFT_SELECT).eq("id", id).single();
  if (error || !data) throw new Error(`leer draft ${id}: ${error?.message ?? "no existe"}`);
  return data as unknown as ClaimedDraft;
}

// ---- Vencimiento de drafts auto-aprobados (sin humano de por medio) ----
//
// Éste es el último punto antes de mandarle algo a Kommo: si el sistema
// estuvo `system_halted` (o el agente apagado) varios días, generate-response
// ya descarta el backlog viejo al reactivar, pero un draft que YA estaba
// 'approved' —auto-aprobado por bypass_review o por un vertical auto_reply—
// antes de que arrancara la pausa se queda esperando en la tabla y se vuelve a
// reservar tal cual al volver. Publicarlo ahora sería mandarle al lead una
// respuesta vieja a algo que probablemente ya venció, ya se resolvió con un
// humano en Kommo, o es simplemente un lead frío. Un draft con reviewer_id (un
// humano lo aprobó a mano en el dashboard) queda EXENTO a propósito: esa
// aprobación es una decisión explícita, no algo que el paso del tiempo deba invalidar.
function isExpiredAutoApproved(d: ClaimedDraft, maxAgeHours: number): boolean {
  if (!(maxAgeHours > 0)) return false;
  return !d.reviewer_id && isStaleBacklog(d.created_at, Date.now(), maxAgeHours);
}

// Cap duro de seguridad en profundidad: 280 chars, cortando en el último espacio.
function capPublicReply(text: string): string {
  const sanitized = text.replace(/[\n\r\t]/g, " ").trim();
  return truncateGraphemes(sanitized, 280, { wordBoundary: true });
}

/**
 * Publica UN draft ya reservado. `markSending(baseline)` es el write-ahead previo a
 * cada salesbot: lanza LeaseLostError si la reserva ya no es nuestra (y entonces no
 * se dispara nada).
 */
async function publishOne(
  draft: ClaimedDraft,
  config: KommoConfig,
  kommoDomain: string,
  kommoToken: string,
  verify: Verify,
  markSending: (baseline: string[] | null) => Promise<void>
): Promise<{ delivered: boolean; verified: boolean; publicBlocked: string | null }> {
  const kommoLeadId = draft.messages?.leads?.kommo_lead_id;
  if (!kommoLeadId) throw new Error("kommo_lead_id missing");
  if (!config.response_custom_field_id) throw new Error("response_custom_field_id no configurado");
  if (!config.salesbot_id) throw new Error("salesbot_id no configurado");

  const leadId = Number(kommoLeadId);
  const meta = draft.agent_metadata ?? {};

  // ---- Respuesta pública IA (comentario de Instagram) — fail-open ----
  // Usa meta.public_reply generado por Haiku en generate-response.
  // Corre ANTES del flujo normal; si falla, el DM normal sigue igual.
  //
  // El DM se verifica ANTES de publicar la parte pública: si el DM va a quedar
  // bloqueado, no puede haber salido ya un comentario público (al aprobar de nuevo
  // se publicaría dos veces). writeClientText lo vuelve a verificar al escribir —
  // este chequeo solo fija el ORDEN. Y es el texto REAL (edited_body ?? body).
  const dmLeak = outboundLeak(draftText(draft));
  if (dmLeak) throw new OutboundBlockedError("dm", dmLeak);

  let publicBlocked: string | null = null;
  const rawPublicReply = typeof meta.public_reply === "string" ? meta.public_reply : null;
  if (
    meta.from_comment === true &&
    config.comment_reply_enabled &&
    config.comment_salesbot_id != null &&
    config.comment_field_id != null &&
    rawPublicReply
  ) {
    try {
      const publicText = capPublicReply(rawPublicReply);
      await writeClientText({
        kind: "public_reply",
        kommoLeadId: leadId,
        fieldId: config.comment_field_id,
        text: publicText,
        kommoDomain,
        kommoToken,
      });
      // Write-ahead antes del primer salesbot: desde acá el cliente puede recibir algo.
      await markSending(null);
      await runSalesbot(config.comment_salesbot_id, leadId, kommoDomain, kommoToken);
    } catch (err) {
      if (err instanceof LeaseLostError) throw err;
      // Respuesta pública con residuo interno: NO se publica (la leería todo el
      // mundo) pero el DM, si está limpio, sigue. El caller marca el draft y alerta.
      if (err instanceof OutboundBlockedError) {
        publicBlocked = err.reason;
        console.error(`publish-to-kommo: respuesta pública del draft ${draft.id} bloqueada — ${err.reason}`);
      }
      console.warn(
        `publish-to-kommo: respuesta pública comentario (draft ${draft.id}) falló — continúa con DM:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ---- Flujo normal: DM por campo + salesbot estándar ----
  // SIEMPRE corre, independientemente de si la parte pública falló.
  // Antes de disparar, tomamos una "foto" de los mensajes salientes que el lead YA
  // tenía, para poder detectar el NUEVO que (si todo va bien) genere el salesbot.
  // La foto se guarda con la marca write-ahead: si el worker muere, la recuperación
  // verifica contra ella en vez de reenviar.
  const baseline = verify.enabled ? await fetchOutgoingEventIds(leadId, kommoDomain, kommoToken) : null;

  // El texto que realmente sale es el editado a mano en el inbox si lo hay.
  // writeClientText lo verifica; si trae residuo interno lanza OutboundBlockedError
  // (el caller manda el draft a revisión) y NO se toca Kommo.
  await writeClientText({
    kind: "dm",
    kommoLeadId: leadId,
    fieldId: config.response_custom_field_id,
    text: draftText(draft),
    kommoDomain,
    kommoToken,
  });
  await markSending(baseline ? [...baseline] : null);
  await runSalesbot(config.salesbot_id, leadId, kommoDomain, kommoToken);

  // El 202 success:true de salesbot/run NO prueba la entrega (ver _shared/kommo.ts).
  // Verificamos que haya aparecido un outgoing_chat_message nuevo del lead.
  if (!verify.enabled || !baseline) return { delivered: true, verified: false, publicBlocked };
  const delivered = await verifyOutgoingDelivery(
    leadId,
    baseline,
    kommoDomain,
    kommoToken,
    verify.timeoutMs
  );
  return { delivered, verified: true, publicBlocked };
}

function leadLabel(msgs: { leads?: { display_name?: string | null; kommo_lead_id?: unknown } } | null): string {
  return msgs?.leads?.display_name ?? `lead ${msgs?.leads?.kommo_lead_id ?? "?"}`;
}

async function insertAlert(row: Record<string, unknown>, label: string): Promise<void> {
  const { error } = await supabase.from("alerts").insert(row);
  if (error) console.warn(`alert ${label}:`, error.message);
}

/** Escribe el resultado final, SOLO si la reserva sigue siendo nuestra. */
async function finalize(draftId: string, owner: string, outcome: DraftOutcome, baseMeta: Record<string, unknown>) {
  const patch = finalPatch(outcome, baseMeta, new Date().toISOString());
  if (!patch) return;
  const { data, error } = await supabase
    .from("drafts")
    .update(patch)
    .eq("id", draftId)
    .eq("status", "publishing")
    .eq("publish_owner", owner)
    .select("id");
  if (error) {
    // El lease vence y la recuperación lo resuelve (con la marca, verificando; nunca reenviando).
    console.error(`publish-to-kommo: no se pudo registrar el resultado del draft ${draftId} (${outcome.kind}):`, error.message);
  } else if (!data || data.length === 0) {
    console.warn(`publish-to-kommo: el draft ${draftId} ya no estaba reservado por este worker al registrar ${outcome.kind}`);
  }
}

/** Procesa un draft reservado por `owner`. Nunca lanza. */
async function processClaimed(
  draftId: string,
  owner: string,
  config: KommoConfig,
  kommoDomain: string,
  kommoToken: string,
  verify: Verify
): Promise<DraftOutcome> {
  let draft: ClaimedDraft;
  try {
    draft = await loadDraft(draftId);
  } catch (err) {
    const outcome: DraftOutcome = { kind: "released", reason: err instanceof Error ? err.message : String(err) };
    await finalize(draftId, owner, outcome, {});
    return outcome;
  }
  const baseMeta = draft.agent_metadata ?? {};

  if (isExpiredAutoApproved(draft, Math.max(0, Number(config.answer_max_age_hours ?? 1)))) {
    const outcome: DraftOutcome = { kind: "expired" };
    await finalize(draftId, owner, outcome, baseMeta);
    console.log(`publish-to-kommo: draft ${draftId} vencido tras pausa — no se publica`);
    return outcome;
  }

  const markSending = async (baseline: string[] | null) => {
    const { data, error } = await supabase.rpc("mark_draft_publish_sending", {
      p_id: draftId,
      p_owner: owner,
      p_baseline: baseline,
    });
    if (error || data !== true) {
      if (error) console.error(`publish-to-kommo: marca de envío del draft ${draftId} falló:`, error.message);
      throw new LeaseLostError(draftId);
    }
  };

  let outcome: DraftOutcome;
  try {
    const result = await publishOne(draft, config, kommoDomain, kommoToken, verify, markSending);
    outcome = result.delivered
      ? { kind: "delivered", verified: result.verified, publicBlocked: result.publicBlocked }
      : {
          kind: "undelivered",
          publicBlocked: result.publicBlocked,
          reason: "salesbot disparado pero sin entrega confirmada (no apareció outgoing_chat_message)",
        };
  } catch (err) {
    if (err instanceof LeaseLostError) {
      console.warn(`publish-to-kommo: ${err.message}`);
      return { kind: "lease_lost" };
    }
    // DM con residuo interno: NO se envía. Vuelve a revisión humana (el texto suele
    // ser recuperable con una edición) en vez de quedar failed.
    if (err instanceof OutboundBlockedError && err.kind === "dm") {
      console.error(`publish-to-kommo: draft ${draftId} bloqueado antes de publicar — ${err.reason}`);
      outcome = { kind: "blocked_dm", reason: err.reason };
    } else {
      outcome = { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  await finalize(draftId, owner, outcome, baseMeta);

  const msgs = draft.messages;
  const publicBlocked =
    outcome.kind === "delivered" || outcome.kind === "undelivered" ? outcome.publicBlocked : null;
  if (publicBlocked) {
    // Respuesta pública bloqueada por el verificador: la parte pública NO salió.
    await insertAlert(
      {
        kind: "outbound_blocked",
        severity: "warning",
        title: "Se bloqueó la respuesta pública a un comentario",
        description:
          `El texto de la respuesta pública traía residuo interno del agente (${publicBlocked}) y no se publicó. ` +
          "El mensaje privado (DM) siguió su curso. Revisá el comentario y respondé a mano si corresponde.",
        ref_table: "drafts",
        ref_id: draftId,
        metadata: { part: "public_reply", reason: publicBlocked },
      },
      "outbound_blocked"
    );
  }
  if (outcome.kind === "undelivered") {
    // El bot se disparó (Kommo respondió OK) pero NO apareció un mensaje
    // saliente en la ventana: el mensaje NO llegó al canal. No es un "enviado".
    await insertAlert(
      {
        kind: "salesbot_not_delivered",
        severity: "warning",
        title: `No se confirmó la entrega del mensaje a ${leadLabel(msgs)}`,
        description:
          "El salesbot se disparó y Kommo respondió OK, pero no apareció un mensaje saliente en el canal dentro de la ventana de verificación. " +
          "Causas probables: ventana de mensajería del canal vencida (p. ej. 24h en Instagram/WhatsApp Business), lead venido de un comentario sin DM abierto, o el bot con una condición que lo corta. " +
          "Revisá la conversación y, si corresponde, respondé manualmente.",
        ref_table: "drafts",
        ref_id: draftId,
        metadata: { kommo_lead_id: msgs?.leads?.kommo_lead_id ?? null, lead_id: msgs?.lead_id ?? null },
      },
      "salesbot_not_delivered"
    );
  }
  return outcome;
}

/**
 * Recupera reservas muertas (lease vencido). Las que no llegaron a marcar el envío
 * vuelven a `approved` dentro de la RPC; las que sí, se resuelven acá SIN reenviar.
 */
async function recoverDead(owner: string, kommoDomain: string, kommoToken: string): Promise<{ requeued: number; gave_up: number; resolved: number }> {
  const counts = { requeued: 0, gave_up: 0, resolved: 0 };
  const { data, error } = await supabase.rpc("recover_dead_draft_publishes", {
    p_owner: owner,
    p_lease_seconds: PUBLISH_LEASE_SECONDS,
    p_limit: 20,
    p_max_attempts: PUBLISH_MAX_ATTEMPTS,
  });
  if (error) {
    console.error("publish-to-kommo: recover_dead_draft_publishes falló:", error.message);
    return counts;
  }
  for (const row of (data ?? []) as Array<{ draft_id: string; action: string }>) {
    if (row.action === "requeued") {
      counts.requeued++;
      console.warn(`publish-to-kommo: draft ${row.draft_id} interrumpido antes de enviar — vuelve a la cola`);
      continue;
    }
    if (row.action === "gave_up") {
      counts.gave_up++;
      console.error(`publish-to-kommo: draft ${row.draft_id} interrumpido ${PUBLISH_MAX_ATTEMPTS} veces antes de enviar — failed`);
      continue;
    }
    if (row.action !== "resolve") continue;
    counts.resolved++;
    try {
      const draft = await loadDraft(row.draft_id);
      const kommoLeadId = Number(draft.messages?.leads?.kommo_lead_id);
      const current = Number.isFinite(kommoLeadId) && draft.publish_baseline
        ? await fetchOutgoingEventIds(kommoLeadId, kommoDomain, kommoToken)
        : new Set<string>();
      const decision = resolveInterrupted(draft.publish_baseline, current);
      const baseMeta = { ...(draft.agent_metadata ?? {}), publish_interrupted: true };
      if (decision.action === "mark_sent") {
        await finalize(row.draft_id, owner, { kind: "delivered", verified: true, publicBlocked: null, recovered: true }, baseMeta);
        console.warn(`publish-to-kommo: draft ${row.draft_id} interrumpido — ${decision.reason}: se registra como enviado`);
      } else {
        await finalize(row.draft_id, owner, { kind: "error", message: decision.reason }, baseMeta);
        await insertAlert(
          {
            kind: "salesbot_not_delivered",
            severity: "warning",
            title: `Revisá si le llegó la respuesta a ${leadLabel(draft.messages)}`,
            description:
              "La publicación de esta respuesta se cortó después de empezar el envío a Kommo y no se pudo confirmar si el mensaje salió. " +
              "Para no mandarle el mensaje dos veces al cliente NO se reenvió. Revisá la conversación en Kommo y, si no le llegó, respondé manualmente.",
            ref_table: "drafts",
            ref_id: row.draft_id,
            metadata: {
              reason: "publish_interrupted",
              kommo_lead_id: draft.messages?.leads?.kommo_lead_id ?? null,
              lead_id: draft.messages?.lead_id ?? null,
            },
          },
          "publish_interrupted"
        );
      }
    } catch (err) {
      // Sin poder leer el draft: el lease vence de nuevo y otro barrido lo retoma (sigue sin reenviarse).
      console.error(`publish-to-kommo: resolver draft interrumpido ${row.draft_id} falló:`, err instanceof Error ? err.message : String(err));
    }
  }
  return counts;
}

async function runPublication(
  owner: string,
  config: KommoConfig,
  kommoDomain: string,
  kommoToken: string,
  verify: Verify
): Promise<PublishTally & { recovered: { requeued: number; gave_up: number; resolved: number } }> {
  const recovered = await recoverDead(owner, kommoDomain, kommoToken);

  const tally = await runPublishLoop({
    claim: async () => {
      const { data, error } = await supabase.rpc("claim_draft_for_publish", {
        p_owner: owner,
        p_lease_seconds: PUBLISH_LEASE_SECONDS,
        p_publish_from: config.publish_from,
      });
      if (error) throw new Error(`claim_draft_for_publish: ${error.message}`);
      return (data as string | null) ?? null;
    },
    process: (id) => processClaimed(id, owner, config, kommoDomain, kommoToken, verify),
    // El apagado total o el modo sombra activados a mitad de corrida frenan lo que falta.
    canContinue: async () => {
      try {
        const c = await getConfig();
        return !!c && !isHaltedRow(c) && c.publishing_enabled;
      } catch {
        return false;
      }
    },
  });

  console.log(
    `publish-to-kommo run ${owner}: published=${tally.published} undelivered=${tally.undelivered} failed=${tally.failed} ` +
      `expired=${tally.expired} blocked=${tally.blocked} released=${tally.released} lease_lost=${tally.lease_lost} ` +
      `recovered(requeued=${recovered.requeued} gave_up=${recovered.gave_up} resolved=${recovered.resolved})`
  );

  // Después de publicar, evaluar outcomes (idempotente: evaluate-outcomes saltea los
  // graders ya puntuados, y el cron lo barre cada 5 min).
  if (tally.published > 0) {
    try {
      const res = await callInternal(supabase, "evaluate-outcomes", {});
      await res.body?.cancel();
    } catch (e) {
      console.warn("trigger evaluate-outcomes:", e);
    }
  }
  return { ...tally, recovered };
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    return new Response("publish-to-kommo OK", { status: 200 });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  // Gate interno: esta función NO es un webhook público (ver _shared/auth.ts).
  {
    const denied = await authorizeInternal(req, supabase);
    if (denied) return denied;
  }

  try {
    // Apagado total (0057): se lee kommo_publish_config PRIMERO —antes de
    // exigir credenciales de Kommo con runtimeCfg.require()— para no gastar
    // ni esa resolución cuando el operador cortó todo. Ningún draft
    // 'approved' se publica mientras esto esté en true, ni el que ya estaba
    // en cola antes del switch (ver el comentario al inicio del archivo).
    const config = await getConfig();
    if (config && isHaltedRow(config)) {
      logHalted("publish-to-kommo");
      return haltedResponse({ published: 0 });
    }

    // Resolve config at request time: DB-first, then env fallback. Todo lo que
    // puede fallar por configuración se resuelve ANTES del límite de waitUntil.
    const runtimeCfg = await loadConfig(supabase);
    const kommoDomain = runtimeCfg.require("KOMMO_API_DOMAIN");
    const kommoToken = runtimeCfg.require("KOMMO_ACCESS_TOKEN");

    if (!config) {
      return new Response(
        JSON.stringify({ ok: true, skipped: "no config" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (!config.publishing_enabled) {
      return new Response(
        JSON.stringify({ ok: true, skipped: "publishing disabled (shadow mode)" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    // Verificador de entrega (DB-first / env-fallback). El default es ON: el
    // salesbot/run devuelve 202 success aunque el bot no entregue, así que sin esto
    // marcaríamos "enviado" en falso. SALESBOT_VERIFY_ENABLED="false" lo apaga
    // (vuelve al comportamiento previo); SALESBOT_VERIFY_TIMEOUT_MS ajusta la ventana.
    const verify: Verify = {
      enabled: runtimeCfg.getOr("SALESBOT_VERIFY_ENABLED", "true") !== "false",
      timeoutMs: Math.max(
        3000,
        Number(runtimeCfg.getOr("SALESBOT_VERIFY_TIMEOUT_MS", "12000")) || 12000
      ),
    };

    // Identidad de esta invocación: dueño de las reservas que tome.
    const owner = crypto.randomUUID();
    const work = runPublication(owner, config, kommoDomain, kommoToken, verify);

    // @ts-ignore: EdgeRuntime existe en Supabase
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(
        work.catch((err) =>
          console.error(`publish-to-kommo run ${owner} error:`, err instanceof Error ? err.message : String(err))
        )
      );
      return new Response(JSON.stringify({ ok: true, accepted: true, run_id: owner }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }

    // Fallback sin EdgeRuntime (tests/local): síncrono, con los conteos en la respuesta.
    const result = await work;
    return new Response(JSON.stringify({ ok: true, run_id: owner, ...result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("publish-to-kommo error:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
