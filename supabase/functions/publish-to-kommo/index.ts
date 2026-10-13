// Edge Function: publish-to-kommo
//
// Toma drafts con status='approved' y los publica a Kommo:
//   1. PATCH /api/v4/leads/{kommo_lead_id} — actualiza el custom field con la respuesta
//   2. POST  /api/v2/salesbot/run — dispara el salesbot que lee el campo y envía al canal
//
// Si publishing_enabled=false en kommo_publish_config, no hace nada (shadow mode).
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
import { isSystemHalted, haltedResponse, logHalted } from "../_shared/halt.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

// Flags del guard de un bloqueo ANTERIOR (agent_metadata.guard_*): al volver a decidir
// sobre el texto actual se descartan, o un draft ya enviado seguiría mostrando
// «bloqueado» en el inbox.
function stripGuard(meta: Record<string, unknown>): Record<string, unknown> {
  const { guard_blocked: _a, guard_kind: _b, guard_reason: _c, guard_stage: _d, guard_part: _e, ...rest } = meta;
  return rest;
}

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
  // Ventana de frescura (0040): drafts auto-aprobados más viejos que esto no
  // se publican — ver el filtro de expiración más abajo.
  answer_max_age_hours: number | null;
};

async function getConfig(): Promise<KommoConfig | null> {
  const { data, error } = await supabase
    .from("kommo_publish_config")
    .select(
      "id, response_custom_field_id, salesbot_id, publishing_enabled, auto_reply_mode, publish_from, comment_reply_enabled, comment_salesbot_id, comment_field_id, answer_max_age_hours"
    )
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`config: ${error.message}`);
  return data;
}

// ---- Selecciona drafts approved no enviados, con info del lead ----
// publishFrom: línea de corte; si está, se ignoran los drafts anteriores
// (borradores de validación viejos que NO deben dispararse al ir a producción).
async function pickPending(publishFrom: string | null, limit = 10) {
  // El embed DEBE nombrar el FK: hay dos relaciones entre drafts y messages
  // (drafts.message_id y messages.answered_by_draft_id). Sin desambiguar,
  // PostgREST responde PGRST201 ("more than one relationship was found") y esta
  // query falla SIEMPRE — es decir, la publicación nunca llegaba a enviar nada.
  // Acá queremos el mensaje que ORIGINÓ el draft: drafts.message_id.
  let q = supabase
    .from("drafts")
    .select(
      "id, message_id, body, edited_body, status, agent_metadata, reviewer_id, created_at, messages!drafts_message_id_fkey(lead_id, leads(kommo_lead_id, display_name))"
    )
    .eq("status", "approved")
    .is("sent_at", null);
  if (publishFrom) q = q.gte("created_at", publishFrom);
  const { data, error } = await q.order("created_at", { ascending: true }).limit(limit);
  if (error) throw new Error(`pick drafts: ${error.message}`);
  return data ?? [];
}

// Filtra los drafts vencidos tras una pausa (agente apagado / system_halted
// por días) del lote a publicar. Un draft AUTO-aprobado (bypass_review o
// vertical.auto_reply — reviewer_id null, ningún humano lo tocó) más viejo
// que answer_max_age_hours ya no sirve: el lead puede haberse ido, haber
// sido atendido por un asesor, o el contexto quedó desactualizado. Se marca
// 'rejected' (no se publica) en vez de simplemente saltearlo, para que quede
// visible en el dashboard por qué no salió.
//
// Un draft aprobado A MANO por un humano (reviewer_id no-null, vía
// /api/drafts/[id]/approve) queda EXENTO: si un revisor lo aprobó, se
// publica sin importar la antigüedad — esa es una decisión humana explícita.
async function splitExpired<
  T extends {
    id: string;
    created_at: string;
    reviewer_id: string | null;
    agent_metadata: Record<string, unknown> | null;
  }
>(drafts: T[], maxAgeHours: number): Promise<{ toPublish: T[]; expired: number }> {
  if (!(maxAgeHours > 0)) return { toPublish: drafts, expired: 0 };

  const cutoffMs = Date.now() - maxAgeHours * 3600_000;
  const toPublish: T[] = [];
  let expired = 0;

  for (const d of drafts) {
    const createdMs = new Date(d.created_at).getTime();
    const isHumanApproved = d.reviewer_id != null;
    // Fail-open: created_at inválido no debe bloquear la publicación.
    if (!isHumanApproved && Number.isFinite(createdMs) && createdMs < cutoffMs) {
      const { error } = await supabase
        .from("drafts")
        .update({
          status: "rejected",
          agent_metadata: {
            ...(d.agent_metadata ?? {}),
            expired: true,
            expired_reason: "vencido tras pausa: más viejo que answer_max_age_hours",
          },
        })
        // Guarda de status: si mientras tanto un humano lo aprobó/rechazó o
        // ya se publicó, no lo pisamos.
        .eq("id", d.id)
        .eq("status", "approved");
      if (!error) expired++;
      continue;
    }
    toPublish.push(d);
  }

  return { toPublish, expired };
}

// Cap duro de seguridad en profundidad: 280 chars, cortando en el último espacio.
function capPublicReply(text: string): string {
  const sanitized = text.replace(/[\n\r\t]/g, " ").trim();
  return truncateGraphemes(sanitized, 280, { wordBoundary: true });
}

async function publishOne(
  draft: {
    id: string;
    body: string;
    edited_body: string | null;
    agent_metadata: Record<string, unknown> | null;
    // deno-lint-ignore no-explicit-any
    messages: any;
  },
  config: KommoConfig,
  kommoDomain: string,
  kommoToken: string,
  verify: { enabled: boolean; timeoutMs: number }
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
      await runSalesbot(config.comment_salesbot_id, leadId, kommoDomain, kommoToken);
    } catch (err) {
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

  // Antes de disparar, una "foto" de los mensajes salientes que el lead YA tenía,
  // para detectar el NUEVO que (si todo va bien) genere el salesbot.
  const baseline = verify.enabled
    ? await fetchOutgoingEventIds(leadId, kommoDomain, kommoToken)
    : new Set<string>();

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
  await runSalesbot(config.salesbot_id, leadId, kommoDomain, kommoToken);

  // El 202 success:true de salesbot/run NO prueba la entrega (ver _shared/kommo.ts).
  // Verificamos que haya aparecido un outgoing_chat_message nuevo del lead.
  if (!verify.enabled) return { delivered: true, verified: false, publicBlocked };
  const delivered = await verifyOutgoingDelivery(
    leadId,
    baseline,
    kommoDomain,
    kommoToken,
    verify.timeoutMs
  );
  return { delivered, verified: true, publicBlocked };
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
    // Apagado total: query aparte (isSystemHalted, cacheada 60s) — no se
    // suma al select de getConfig() para no romperlo si esta función se
    // despliega antes de aplicar la migración 0057 (fail-open, ver
    // _shared/halt.ts). Se chequea ANTES de exigir credenciales de Kommo con
    // runtimeCfg.require(): ningún draft 'approved' se publica mientras esto
    // esté en true, ni el que ya estaba en cola antes del switch.
    if (await isSystemHalted(supabase)) {
      logHalted("publish-to-kommo");
      return haltedResponse({ published: 0 });
    }

    // Resolve config at request time: DB-first, then env fallback.
    const runtimeCfg = await loadConfig(supabase);
    const kommoDomain = runtimeCfg.require("KOMMO_API_DOMAIN");
    const kommoToken = runtimeCfg.require("KOMMO_ACCESS_TOKEN");

    const config = await getConfig();
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

    // Verificador de entrega (DB-first / env-fallback). Default ON: salesbot/run
    // devuelve 202 success aunque el bot no entregue, y sin esto se marcaría
    // "enviado" en falso. SALESBOT_VERIFY_ENABLED="false" lo apaga;
    // SALESBOT_VERIFY_TIMEOUT_MS ajusta la ventana.
    const verify = {
      enabled: runtimeCfg.getOr("SALESBOT_VERIFY_ENABLED", "true") !== "false",
      timeoutMs: Math.max(3000, Number(runtimeCfg.getOr("SALESBOT_VERIFY_TIMEOUT_MS", "12000")) || 12000),
    };

    const pending = await pickPending(config.publish_from);
    const maxAgeHours = Math.max(0, Number(config.answer_max_age_hours ?? 1));
    const { toPublish, expired } = await splitExpired(pending, maxAgeHours);
    if (toPublish.length === 0) {
      return new Response(JSON.stringify({ ok: true, published: 0, expired }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    let published = 0;
    let undelivered = 0;
    let failed = 0;
    const errors: Array<{ draft_id: string; error: string }> = [];

    for (const d of toPublish) {
      const baseMeta = (d.agent_metadata as Record<string, unknown> | null) ?? {};
      // deno-lint-ignore no-explicit-any
      const msgs = d.messages as any;

      try {
        const result = await publishOne(d, config, kommoDomain, kommoToken, verify);
        // Respuesta pública bloqueada por el verificador: el DM salió (estaba limpio)
        // pero la parte pública NO. Se deja marcado y se alerta.
        const publicMeta = result.publicBlocked
          ? {
              guard_blocked: true,
              guard_kind: "internal_leak",
              guard_part: "public_reply",
              guard_reason: result.publicBlocked,
              guard_stage: "publish",
            }
          : {};
        if (result.publicBlocked) {
          const { error: blockAlertErr } = await supabase.from("alerts").insert({
            kind: "outbound_blocked",
            severity: "warning",
            title: "Se bloqueó la respuesta pública a un comentario",
            description:
              `El texto de la respuesta pública traía residuo interno del agente (${result.publicBlocked}) y no se publicó. ` +
              "El mensaje privado (DM) sí salió. Revisá el comentario y respondé a mano si corresponde.",
            ref_table: "drafts",
            ref_id: d.id,
            metadata: { part: "public_reply", reason: result.publicBlocked },
          });
          if (blockAlertErr) console.warn("alert outbound_blocked:", blockAlertErr.message);
        }

        if (result.delivered) {
          await supabase
            .from("drafts")
            .update({
              status: "auto_sent",
              sent_at: new Date().toISOString(),
              agent_metadata: { ...stripGuard(baseMeta), ...(result.verified ? { delivery_verified: true } : {}), ...publicMeta },
            })
            .eq("id", d.id);
          published++;
        } else {
          // El bot se disparó pero NO apareció un mensaje saliente en la ventana:
          // el mensaje NO llegó al canal. No es un "enviado".
          const publishError = "salesbot disparado pero sin entrega confirmada (no apareció outgoing_chat_message)";
          await supabase
            .from("drafts")
            .update({
              status: "failed",
              agent_metadata: { ...baseMeta, delivery_unverified: true, publish_error: publishError },
            })
            .eq("id", d.id);
          const leadName = msgs?.leads?.display_name ?? `lead ${msgs?.leads?.kommo_lead_id ?? "?"}`;
          const { error: alertErr } = await supabase.from("alerts").insert({
            kind: "salesbot_not_delivered",
            severity: "warning",
            title: `No se confirmó la entrega del mensaje a ${leadName}`,
            description:
              "El salesbot se disparó y Kommo respondió OK, pero no apareció un mensaje saliente en el canal dentro de la ventana de verificación. " +
              "Causas probables: ventana de mensajería del canal vencida (p. ej. 24h en Instagram/WhatsApp Business), lead venido de un comentario sin DM abierto, o el bot con una condición que lo corta. " +
              "Revisá la conversación y, si corresponde, respondé manualmente.",
            ref_table: "drafts",
            ref_id: d.id,
            metadata: { kommo_lead_id: msgs?.leads?.kommo_lead_id ?? null, lead_id: msgs?.lead_id ?? null },
          });
          if (alertErr) console.warn("alert salesbot_not_delivered:", alertErr.message);
          errors.push({ draft_id: d.id, error: publishError });
          undelivered++;
          failed++;
        }
      } catch (err) {
        // DM con residuo interno: NO se envía. Vuelve a revisión humana (el texto suele
        // ser recuperable con una edición) en vez de quedar failed. Los flags de un
        // bloqueo anterior se pisan: el guard vuelve a decidir sobre el texto actual.
        if (err instanceof OutboundBlockedError && err.kind === "dm") {
          await supabase
            .from("drafts")
            .update({
              status: "pending",
              agent_metadata: {
                ...stripGuard(baseMeta),
                guard_blocked: true,
                guard_kind: "internal_leak",
                guard_reason: err.reason,
                guard_stage: "publish",
              },
            })
            .eq("id", d.id)
            .eq("status", "approved");
          failed++;
          errors.push({ draft_id: d.id, error: `bloqueado por guard: ${err.reason}` });
          console.error(`publish-to-kommo: draft ${d.id} bloqueado antes de publicar — ${err.reason}`);
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        await supabase
          .from("drafts")
          .update({ status: "failed", agent_metadata: { ...baseMeta, publish_error: msg } })
          .eq("id", d.id);
        errors.push({ draft_id: d.id, error: msg });
        failed++;
      }
    }

    console.log(`publish-to-kommo: published=${published} undelivered=${undelivered} failed=${failed} expired=${expired}`);

    // Después de publicar, disparar evaluación de outcomes (fire-and-forget)
    if (published > 0) {
      const promise = callInternal(supabase, "evaluate-outcomes", {}).catch((e) =>
        console.warn("trigger evaluate-outcomes:", e)
      );
      // @ts-ignore EdgeRuntime de Supabase
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(promise);
      }
    }

    return new Response(
      JSON.stringify({ ok: true, published, undelivered, failed, expired, errors }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("publish-to-kommo error:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
