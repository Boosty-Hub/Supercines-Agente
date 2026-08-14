// _shared/routing.ts
// Ruteo automático de leads al equipo comercial (migración 0052).
//
// Se dispara cuando un mensaje se clasifica en una vertical con auto_assign=true.
// Decide QUIÉN atiende el lead y lo estampa en Kommo:
//
//   1. TERM MATCH — si el texto del lead contiene un término de una persona
//      (ej: su sede o ciudad), va directo a esa persona. Es lo que hoy hace el
//      operador a mano y lo que la voz del agente ya asume.
//   2. ROUND ROBIN — si no se detecta ningún término, gira la rueda atómica
//      (RPC next_round_robin_assignee) y reparte parejo.
//
// Invariantes que NO se rompen:
//   - Un lead se rutea UNA sola vez (leads.routed_at). Cada mensaje nuevo del
//     mismo lead no vuelve a girar la rueda ni pisa al responsable.
//   - NUNCA se le roba un lead a una persona que ya lo está trabajando: solo se
//     asigna si el responsable en vivo es NULL o está en la lista de "cuentas
//     genéricas" (routing_takeover_user_ids).
//   - Fail-open: cualquier error acá NO puede romper el pipeline de inbound. Se
//     audita en lead_routing_events y se sigue.

// deno-lint-ignore-file no-explicit-any
import {
  assignLeadResponsible,
  fetchEntityFieldDefs,
  fetchLeadStage,
  patchLeadFieldTyped,
  type KommoFieldDef,
} from "./kommo.ts";
import { containsTerm, normalizeLoose } from "./text.ts";

export type RoutingVertical = {
  slug: string;
  auto_assign: boolean;
  kommo_field_name: string | null;
  kommo_field_value: string | null;
};

type RoutingConfig = {
  enabled: boolean;
  takeoverUserIds: Set<number>;
  /** Confianza mínima de la clasificación para actuar. 0 = sin umbral. */
  minConfidence: number;
};

type Assignee = {
  kommo_user_id: number;
  display_name: string | null;
  match_terms: string[];
};

// ---- Caches de módulo (TTL 60s, mismo idiom que verticalsCache) ----------
let cfgCache: (RoutingConfig & { loadedAt: number }) | null = null;
let assigneesCache: { items: Assignee[]; loadedAt: number } | null = null;
// Definiciones de campos de lead de Kommo: cambian rarísimo, TTL más largo.
let fieldDefsCache: { items: KommoFieldDef[]; loadedAt: number } | null = null;

const CFG_TTL_MS = 60_000;
const FIELDS_TTL_MS = 10 * 60_000;

async function getRoutingConfig(supabase: any): Promise<RoutingConfig> {
  if (cfgCache && Date.now() - cfgCache.loadedAt < CFG_TTL_MS) return cfgCache;
  const { data, error } = await supabase
    .from("kommo_publish_config")
    .select("routing_enabled, routing_takeover_user_ids, routing_min_confidence")
    .eq("is_active", true)
    .maybeSingle();
  // Fail-closed a propósito: si la columna no existe todavía (función desplegada
  // antes de migrar) el ruteo queda APAGADO. Escribir en el CRM de un cliente
  // por un error de lectura de config es peor que no rutear.
  if (error) {
    console.warn("routing: getRoutingConfig —", error.message);
    cfgCache = { enabled: false, takeoverUserIds: new Set(), minConfidence: 1, loadedAt: Date.now() };
    return cfgCache;
  }
  const ids = (data?.routing_takeover_user_ids ?? []) as number[];
  // Columna ausente (pre-migración 0056) → 0.80, el mismo default de la
  // migración. Nunca 0: un ruteo sin umbral es el bug que 0056 vino a cerrar.
  const rawMin = Number(data?.routing_min_confidence);
  cfgCache = {
    enabled: data?.routing_enabled === true,
    takeoverUserIds: new Set(ids.map(Number).filter((n) => Number.isFinite(n))),
    minConfidence: Number.isFinite(rawMin) ? rawMin : 0.8,
    loadedAt: Date.now(),
  };
  return cfgCache;
}

async function getAssignees(supabase: any): Promise<Assignee[]> {
  if (assigneesCache && Date.now() - assigneesCache.loadedAt < CFG_TTL_MS) {
    return assigneesCache.items;
  }
  const { data, error } = await supabase
    .from("routing_assignees")
    .select("kommo_user_id, display_name, match_terms")
    .eq("enabled", true)
    .order("sort_order")
    .order("kommo_user_id");
  if (error) {
    console.warn("routing: getAssignees —", error.message);
    assigneesCache = { items: [], loadedAt: Date.now() };
    return assigneesCache.items;
  }
  const items: Assignee[] = ((data ?? []) as any[]).map((r) => ({
    kommo_user_id: Number(r.kommo_user_id),
    display_name: r.display_name ?? null,
    match_terms: ((r.match_terms ?? []) as string[]).filter((t) => t && t.trim()),
  }));
  assigneesCache = { items, loadedAt: Date.now() };
  return items;
}

async function getLeadFieldDefs(
  kommoDomain: string,
  kommoToken: string
): Promise<KommoFieldDef[]> {
  if (fieldDefsCache && Date.now() - fieldDefsCache.loadedAt < FIELDS_TTL_MS) {
    return fieldDefsCache.items;
  }
  const items = await fetchEntityFieldDefs("leads", kommoDomain, kommoToken);
  fieldDefsCache = { items, loadedAt: Date.now() };
  return items;
}

/**
 * Elige a quién le toca el lead por TÉRMINO. El término más largo gana: si una
 * persona matchea por "valencia" y otra por "valencia norte", queremos la
 * segunda — el término más específico describe mejor al lead.
 *
 * Exportada para tests (routing.test.ts): es la lógica donde un bug silencioso
 * manda el lead a la persona equivocada sin que nadie se entere.
 */
export function matchByTerm(
  text: string,
  assignees: Assignee[]
): { assignee: Assignee; term: string } | null {
  const norm = normalizeLoose(text);
  let best: { assignee: Assignee; term: string } | null = null;
  for (const a of assignees) {
    for (const raw of a.match_terms) {
      const term = normalizeLoose(raw);
      if (!containsTerm(norm, term)) continue;
      if (!best || term.length > normalizeLoose(best.term).length) {
        best = { assignee: a, term: raw };
      }
    }
  }
  return best;
}

type AuditRow = {
  lead_id: string | null;
  kommo_lead_id: number | null;
  message_id: string | null;
  vertical_slug: string;
  strategy: "term_match" | "round_robin" | "skipped" | "failed";
  matched_term?: string | null;
  assignee_user_id?: number | null;
  previous_user_id?: number | null;
  field_written?: string | null;
  ok: boolean;
  detail?: string | null;
};

async function audit(supabase: any, row: AuditRow): Promise<void> {
  const { error } = await supabase.from("lead_routing_events").insert(row);
  if (error) console.warn("routing: audit insert —", error.message);
}

export type RouteLeadArgs = {
  supabase: any;
  leadId: string;
  kommoLeadId: number | null;
  messageId: string | null;
  text: string;
  vertical: RoutingVertical;
  /** confidence de la clasificación (0-1). null = desconocida → no se rutea. */
  confidence: number | null;
  // `undefined` incluido a propósito: es lo que devuelve runtimeCfg.get() cuando
  // la credencial no está configurada.
  kommoDomain: string | null | undefined;
  kommoToken: string | null | undefined;
};

/**
 * Escribe la decisión de ruteo: reclama el lead en la DB, asigna el responsable
 * en Kommo, estampa el campo configurado y audita. Compartido por el ruteo
 * inicial y por la corrección posterior.
 *
 * `requirePreviousUserId` es el lock de la corrección: solo pisa el responsable
 * si en Kommo sigue siendo exactamente ese usuario. Si alguien lo tomó a mano en
 * el medio, se aborta — la corrección nunca le saca un lead a una persona.
 */
async function applyRouting(opts: {
  supabase: any;
  leadId: string;
  kommoLeadId: number;
  messageId: string | null;
  vertical: RoutingVertical;
  kommoDomain: string;
  kommoToken: string;
  userId: number;
  strategy: "term_match" | "round_robin";
  matchedTerm: string | null;
  previousUserId?: number | null;
  requirePreviousUserId?: number;
  isCorrection?: boolean;
}): Promise<number | null> {
  const {
    supabase, leadId, kommoLeadId, messageId, vertical, kommoDomain, kommoToken,
    userId, strategy, matchedTerm, requirePreviousUserId, isCorrection,
  } = opts;
  let previousUserId = opts.previousUserId ?? null;
  const now = new Date().toISOString();

  // ---- Reclamar el lead ANTES de escribir en Kommo ------------------------
  // El UPDATE condicional es el lock real contra dos mensajes simultáneos del
  // mismo lead: solo una de las dos ejecuciones toca 1 fila. La otra ve 0 y se
  // va sin escribir nada en el CRM.
  const claimQuery = supabase
    .from("leads")
    .update({ routed_at: now, routed_user_id: userId, routed_strategy: strategy })
    .eq("id", leadId);
  const { data: claimed, error: claimErr } = isCorrection
    ? // La corrección solo procede si nadie más movió la asignación mientras tanto.
      await claimQuery
        .eq("routed_user_id", requirePreviousUserId!)
        .eq("routed_strategy", "round_robin")
        .select("id")
    : await claimQuery.is("routed_at", null).select("id");
  if (claimErr) {
    console.warn("routing: claim —", claimErr.message);
    return null;
  }
  if (!claimed || claimed.length === 0) return null; // otra ejecución ganó

  // En una corrección, el responsable en vivo tiene que seguir siendo el nuestro.
  if (isCorrection) {
    try {
      const live = await fetchLeadStage(kommoLeadId, kommoDomain, kommoToken);
      previousUserId = live.responsibleUserId;
      if (previousUserId !== requirePreviousUserId) {
        await supabase
          .from("leads")
          .update({ routed_user_id: previousUserId, routed_strategy: "term_match" })
          .eq("id", leadId);
        await audit(supabase, {
          lead_id: leadId, kommo_lead_id: kommoLeadId, message_id: messageId,
          vertical_slug: vertical.slug, strategy: "skipped",
          previous_user_id: previousUserId, ok: true,
          detail: "corrección abortada: una persona tomó el lead en el medio",
        });
        return null;
      }
    } catch (e) {
      await audit(supabase, {
        lead_id: leadId, kommo_lead_id: kommoLeadId, message_id: messageId,
        vertical_slug: vertical.slug, strategy: "failed", ok: false,
        detail: `corrección: no se pudo leer el responsable actual: ${e instanceof Error ? e.message : String(e)}`,
      });
      return null;
    }
  }

  // ---- Asignar el responsable en Kommo ------------------------------------
  try {
    await assignLeadResponsible(kommoLeadId, userId, kommoDomain, kommoToken);
  } catch (e) {
    // Falló la escritura: liberamos la marca para que un mensaje posterior pueda
    // reintentar, en vez de dejar el lead "ruteado" sin responsable real.
    await supabase
      .from("leads")
      .update({ routed_at: null, routed_user_id: null, routed_strategy: null })
      .eq("id", leadId);
    await audit(supabase, {
      lead_id: leadId, kommo_lead_id: kommoLeadId, message_id: messageId,
      vertical_slug: vertical.slug, strategy: "failed", matched_term: matchedTerm,
      assignee_user_id: userId, previous_user_id: previousUserId, ok: false,
      detail: `asignar responsable: ${e instanceof Error ? e.message : String(e)}`,
    });
    return null;
  }

  // ---- Estampar el campo de Kommo (best-effort) ---------------------------
  // Si esto falla, el lead YA está asignado — que es lo que importa. Se audita
  // y se sigue; no revertimos la asignación por un campo descriptivo.
  let fieldWritten: string | null = null;
  let fieldError: string | null = null;
  if (vertical.kommo_field_name && vertical.kommo_field_value) {
    try {
      const defs = await getLeadFieldDefs(kommoDomain, kommoToken);
      const target = normalizeLoose(vertical.kommo_field_name);
      const def = defs.find((d) => normalizeLoose(d.name) === target);
      if (!def) {
        fieldError = `el campo "${vertical.kommo_field_name}" no existe en Kommo`;
      } else {
        fieldWritten = await patchLeadFieldTyped(
          kommoLeadId, def, vertical.kommo_field_value, kommoDomain, kommoToken
        );
      }
    } catch (e) {
      fieldError = e instanceof Error ? e.message : String(e);
    }
  }

  await audit(supabase, {
    lead_id: leadId, kommo_lead_id: kommoLeadId, message_id: messageId,
    vertical_slug: vertical.slug, strategy, matched_term: matchedTerm,
    assignee_user_id: userId, previous_user_id: previousUserId,
    field_written: fieldWritten, ok: fieldError === null,
    detail: fieldError ?? (isCorrection ? "corrección: el término del lead gana sobre el round robin" : null),
  });

  console.log(
    `routing: lead ${kommoLeadId} → usuario ${userId} (${strategy}${matchedTerm ? `: "${matchedTerm}"` : ""}${isCorrection ? ", corrección" : ""})`
  );
  return userId;
}

/**
 * Rutea un lead recién clasificado. Idempotente y fail-open: nunca lanza.
 * Devuelve el kommo_user_id asignado, o null si no se asignó nada.
 */
export async function routeLead(args: RouteLeadArgs): Promise<number | null> {
  const { supabase, leadId, kommoLeadId, messageId, text, vertical, confidence, kommoDomain, kommoToken } =
    args;
  try {
    if (!vertical.auto_assign) return null;
    if (!kommoLeadId || !kommoDomain || !kommoToken) return null;

    const cfg = await getRoutingConfig(supabase);
    if (!cfg.enabled) return null;

    // ---- Umbral de confianza (0056) ---------------------------------------
    // Clasificar con dudas es barato; escribir en el CRM de una persona real no.
    // NO se marca el lead como ruteado: si después llega un mensaje claro, se
    // rutea ahí. Se audita para que el operador vea qué se está dejando pasar y
    // pueda calibrar el umbral.
    if (cfg.minConfidence > 0 && (confidence == null || confidence < cfg.minConfidence)) {
      await audit(supabase, {
        lead_id: leadId,
        kommo_lead_id: kommoLeadId,
        message_id: messageId,
        vertical_slug: vertical.slug,
        strategy: "skipped",
        ok: true,
        detail: `confianza ${confidence ?? "desconocida"} < umbral ${cfg.minConfidence} — no se toca el CRM`,
      });
      return null;
    }

    // ---- ¿Ya fue ruteado? --------------------------------------------------
    // Guarda barata: el UPDATE condicional de applyRouting es el lock real. Esta
    // lectura solo evita el trabajo caro (llamadas a Kommo) en el 99% de los casos.
    const { data: leadRow, error: leadErr } = await supabase
      .from("leads")
      .select("routed_at, routed_user_id, routed_strategy")
      .eq("id", leadId)
      .maybeSingle();
    if (leadErr) {
      console.warn("routing: lead read —", leadErr.message);
      return null;
    }

    const assignees = await getAssignees(supabase);
    const termHit = matchByTerm(text, assignees);

    // ---- ¿Es una CORRECCIÓN de un ruteo a ciegas? --------------------------
    // El round robin se usa cuando el mensaje no nombra ninguna sede: es una
    // suposición razonable, pero suposición. Si el lead la nombra después, ese
    // DATO gana — si no, el CRM diría una cosa y el agente (que comparte el
    // contacto de la asesora de esa sede) diría otra. Un term_match previo ya se
    // decidió con dato y no se vuelve a tocar nunca.
    if (leadRow?.routed_at) {
      const corregible =
        leadRow.routed_strategy === "round_robin" &&
        termHit != null &&
        termHit.assignee.kommo_user_id !== Number(leadRow.routed_user_id);
      if (!corregible) return null;
      return await applyRouting({
        supabase, leadId, kommoLeadId, messageId, vertical, kommoDomain, kommoToken,
        userId: termHit!.assignee.kommo_user_id,
        strategy: "term_match",
        matchedTerm: termHit!.term,
        requirePreviousUserId: Number(leadRow.routed_user_id),
        isCorrection: true,
      });
    }

    if (assignees.length === 0) {
      await audit(supabase, {
        lead_id: leadId, kommo_lead_id: kommoLeadId, message_id: messageId,
        vertical_slug: vertical.slug, strategy: "skipped", ok: true,
        detail: "no hay asignables habilitados en routing_assignees",
      });
      return null;
    }

    // ---- No robar leads en curso -------------------------------------------
    // El estado en vivo de Kommo manda: el responsable puede haber cambiado a
    // mano hace 10 segundos y nuestra copia local no lo sabe.
    let previousUserId: number | null = null;
    try {
      const live = await fetchLeadStage(kommoLeadId, kommoDomain, kommoToken);
      previousUserId = live.responsibleUserId;
    } catch (e) {
      // Sin poder verificar quién es el dueño, NO asignamos: el riesgo de
      // pisarle el lead a una asesora supera el beneficio de rutear.
      await audit(supabase, {
        lead_id: leadId, kommo_lead_id: kommoLeadId, message_id: messageId,
        vertical_slug: vertical.slug, strategy: "failed", ok: false,
        detail: `no se pudo leer el responsable actual: ${e instanceof Error ? e.message : String(e)}`,
      });
      return null;
    }

    const libre = previousUserId === null || cfg.takeoverUserIds.has(previousUserId);
    if (!libre) {
      await audit(supabase, {
        lead_id: leadId, kommo_lead_id: kommoLeadId, message_id: messageId,
        vertical_slug: vertical.slug, strategy: "skipped",
        previous_user_id: previousUserId, ok: true,
        detail: "el lead ya tiene responsable asignado — no se toca",
      });
      // Se marca como ruteado igual: ya tiene dueño, no hay nada que decidir en
      // los próximos mensajes y así no volvemos a pegarle a Kommo. Estrategia
      // 'term_match' = definitivo (nadie lo corrige después).
      await supabase
        .from("leads")
        .update({ routed_at: new Date().toISOString(), routed_user_id: previousUserId, routed_strategy: "term_match" })
        .eq("id", leadId)
        .is("routed_at", null);
      return null;
    }

    // ---- Elegir responsable -------------------------------------------------
    let strategy: "term_match" | "round_robin";
    let userId: number | null;
    let matchedTerm: string | null = null;

    if (termHit) {
      strategy = "term_match";
      userId = termHit.assignee.kommo_user_id;
      matchedTerm = termHit.term;
    } else {
      strategy = "round_robin";
      const { data: rr, error: rrErr } = await supabase.rpc("next_round_robin_assignee", {
        p_key: vertical.slug,
      });
      if (rrErr) {
        await audit(supabase, {
          lead_id: leadId, kommo_lead_id: kommoLeadId, message_id: messageId,
          vertical_slug: vertical.slug, strategy: "failed",
          previous_user_id: previousUserId, ok: false,
          detail: `round robin: ${rrErr.message}`,
        });
        return null;
      }
      userId = rr == null ? null : Number(rr);
    }

    if (!userId || !Number.isFinite(userId)) {
      await audit(supabase, {
        lead_id: leadId, kommo_lead_id: kommoLeadId, message_id: messageId,
        vertical_slug: vertical.slug, strategy: "skipped",
        previous_user_id: previousUserId, ok: true,
        detail: "no se pudo determinar un responsable",
      });
      return null;
    }

    return await applyRouting({
      supabase, leadId, kommoLeadId, messageId, vertical, kommoDomain, kommoToken,
      userId, strategy, matchedTerm, previousUserId,
    });
  } catch (e) {
    // Red de seguridad final: el ruteo jamás rompe el procesamiento del inbound.
    console.warn("routing: fallo no controlado —", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Invalida los caches de config/equipo (para tests o cambios en caliente). */
export function resetRoutingCaches(): void {
  cfgCache = null;
  assigneesCache = null;
  fieldDefsCache = null;
}
