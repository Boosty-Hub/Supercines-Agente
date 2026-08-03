// _shared/provider-errors.ts
// Detección de "sin crédito/cuota" en Anthropic y OpenAI, y alerta durable en
// la tabla `alerts` para que el Boosty Hub muestre "este proyecto se quedó
// sin crédito de Claude/GPT". Se auto-resuelve cuando las llamadas vuelven a
// funcionar.
//
// DEDUP: una sola alerta ABIERTA (acknowledged_at IS NULL) por proveedor —
// kind='provider_credit_exhausted' + metadata->>'provider'.
//
// IMPORTANTE (verificado contra 0011_alerts.sql): `alerts.acknowledged_by`
// es `uuid references auth.users(id)`, NO texto libre — lo usa el dashboard
// para guardar el id del usuario que reconoce la alerta (ver
// web/src/app/api/alerts/[id]/acknowledge/route.ts). Un resolve automático
// no tiene un auth.users.id real, así que NUNCA escribimos un marcador ahí
// (rompería el tipo/FK y el UPDATE fallaría siempre). El estado
// "resuelta" queda 100% representado por `acknowledged_at` — la columna
// generada `status` lo deriva de eso (0051_hub_agent_side_contract.sql) y es
// lo único que lee el collector del Hub.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export type Provider = "anthropic" | "openai";

const CREDIT_ALERT_KIND = "provider_credit_exhausted";

const TITLES: Record<Provider, string> = {
  anthropic: "Sin créditos de Claude (Anthropic)",
  openai: "Sin créditos de GPT (OpenAI)",
};

/**
 * ¿Este status + body de respuesta indica que la cuenta se quedó sin
 * crédito/cuota?
 *  - anthropic: 400 + "credit balance" en el mensaje. OJO: 429 es rate
 *    limit (otra cosa completamente distinta) — NUNCA debe disparar esto.
 *  - openai: 429 + "insufficient_quota" en el mensaje.
 */
export function isCreditError(provider: Provider, status: number, bodyText: string): boolean {
  if (provider === "anthropic") {
    return status === 400 && /credit balance/i.test(bodyText);
  }
  return status === 429 && /insufficient_quota/i.test(bodyText);
}

// Gate en memoria: resolveProviderCreditAlert() solo dispara el UPDATE si
// record() marcó que había (o pudo haber) una alerta abierta para ese
// proveedor en ESTA instancia de la función. Evita un write a la DB en cada
// llamada exitosa (hot path). Vive por invocación/isolate — el backstop de
// alerts-scan (resolveRecoveredProviderCredit) cubre el caso
// cold-start-after-recovery donde este Set arranca vacío.
const openAlertProviders = new Set<Provider>();

/**
 * Registra (o toca) la alerta durable de crédito/cuota agotada para
 * `provider`. NUNCA lanza — corre en el hot path de las llamadas al LLM.
 */
export async function recordProviderCreditAlert(
  supabase: SupabaseClient,
  provider: Provider,
  meta: { status?: number; component?: string; model?: string } = {},
): Promise<void> {
  try {
    openAlertProviders.add(provider);
    const nowIso = new Date().toISOString();

    // deno-lint-ignore no-explicit-any
    const { data: existing, error: selErr } = await (supabase as any)
      .from("alerts")
      .select("id, metadata")
      .eq("kind", CREDIT_ALERT_KIND)
      .is("acknowledged_at", null)
      .eq("metadata->>provider", provider)
      .limit(1)
      .maybeSingle();
    if (selErr) throw new Error(selErr.message);

    if (existing) {
      // Ya hay una alerta abierta para este proveedor — no duplicar; solo
      // tocamos last_seen_at (best-effort, no crítico si falla).
      const prevMeta = (existing.metadata ?? {}) as Record<string, unknown>;
      // deno-lint-ignore no-explicit-any
      await (supabase as any)
        .from("alerts")
        .update({ metadata: { ...prevMeta, ...meta, provider, last_seen_at: nowIso } })
        .eq("id", existing.id);
      return;
    }

    // deno-lint-ignore no-explicit-any
    const { error: insErr } = await (supabase as any).from("alerts").insert({
      kind: CREDIT_ALERT_KIND,
      severity: "critical",
      title: TITLES[provider],
      description:
        "El proveedor rechazó la llamada por saldo/cuota agotada. El agente no puede responder hasta recargar.",
      metadata: { provider, ...meta, last_seen_at: nowIso },
    });
    if (insErr) throw new Error(insErr.message);
  } catch (e) {
    console.error(
      `recordProviderCreditAlert(${provider}) failed (ignored):`,
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * Marca como resuelta la alerta abierta de crédito/cuota agotada para
 * `provider` (una llamada volvió a funcionar). Gateada por
 * `openAlertProviders` para no pegarle a la DB en cada request exitoso.
 * NUNCA lanza.
 */
export async function resolveProviderCreditAlert(
  supabase: SupabaseClient,
  provider: Provider,
): Promise<void> {
  if (!openAlertProviders.has(provider)) return;
  openAlertProviders.delete(provider);
  try {
    // No tocamos acknowledged_by (uuid → auth.users.id) — ver nota arriba.
    // deno-lint-ignore no-explicit-any
    const { error } = await (supabase as any)
      .from("alerts")
      .update({ acknowledged_at: new Date().toISOString() })
      .eq("kind", CREDIT_ALERT_KIND)
      .is("acknowledged_at", null)
      .eq("metadata->>provider", provider);
    if (error) throw new Error(error.message);
  } catch (e) {
    console.error(
      `resolveProviderCreditAlert(${provider}) failed (ignored):`,
      e instanceof Error ? e.message : String(e),
    );
  }
}
