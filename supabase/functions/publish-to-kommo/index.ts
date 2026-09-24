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
import { loadConfig } from "../_shared/config.ts";
import { patchLeadField, runSalesbot } from "../_shared/kommo.ts";
import { isSystemHalted, haltedResponse, logHalted } from "../_shared/halt.ts";

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
      "id, message_id, body, status, created_at, reviewer_id, agent_metadata, messages!drafts_message_id_fkey(lead_id, leads(kommo_lead_id, display_name))"
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
  if (sanitized.length <= 280) return sanitized;
  const sub = sanitized.slice(0, 280);
  const lastSpace = sub.lastIndexOf(" ");
  return lastSpace > 0 ? sub.slice(0, lastSpace) : sub;
}

async function publishOne(
  draft: {
    id: string;
    body: string;
    agent_metadata: Record<string, unknown> | null;
    // deno-lint-ignore no-explicit-any
    messages: any;
  },
  config: KommoConfig,
  kommoDomain: string,
  kommoToken: string
) {
  const kommoLeadId = draft.messages?.leads?.kommo_lead_id;
  if (!kommoLeadId) throw new Error("kommo_lead_id missing");
  if (!config.response_custom_field_id) throw new Error("response_custom_field_id no configurado");
  if (!config.salesbot_id) throw new Error("salesbot_id no configurado");

  const leadId = Number(kommoLeadId);
  const meta = draft.agent_metadata ?? {};

  // ---- Respuesta pública IA (comentario de Instagram) — fail-open ----
  // Usa meta.public_reply generado por Haiku en generate-response.
  // Corre ANTES del flujo normal; si falla, el DM normal sigue igual.
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
      await patchLeadField(leadId, config.comment_field_id, publicText, kommoDomain, kommoToken);
      await runSalesbot(config.comment_salesbot_id, leadId, kommoDomain, kommoToken);
    } catch (err) {
      console.warn(
        `publish-to-kommo: respuesta pública comentario (draft ${draft.id}) falló — continúa con DM:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ---- Flujo normal: DM por campo + salesbot estándar ----
  // SIEMPRE corre, independientemente de si la parte pública falló.
  await patchLeadField(leadId, config.response_custom_field_id, draft.body, kommoDomain, kommoToken);
  await runSalesbot(config.salesbot_id, leadId, kommoDomain, kommoToken);
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    return new Response("publish-to-kommo OK", { status: 200 });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
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
    let failed = 0;
    const errors: Array<{ draft_id: string; error: string }> = [];

    for (const d of toPublish) {
      try {
        await publishOne(d, config, kommoDomain, kommoToken);
        await supabase
          .from("drafts")
          .update({ status: "auto_sent", sent_at: new Date().toISOString() })
          .eq("id", d.id);
        published++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await supabase
          .from("drafts")
          .update({
            status: "failed",
            agent_metadata: { publish_error: msg },
          })
          .eq("id", d.id);
        errors.push({ draft_id: d.id, error: msg });
        failed++;
      }
    }

    // Después de publicar, disparar evaluación de outcomes (fire-and-forget)
    if (published > 0) {
      const promise = fetch(`${SUPABASE_URL}/functions/v1/evaluate-outcomes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).catch((e) => console.warn("trigger evaluate-outcomes:", e));
      // @ts-ignore EdgeRuntime de Supabase
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(promise);
      }
    }

    return new Response(
      JSON.stringify({ ok: true, published, failed, expired, errors }),
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
