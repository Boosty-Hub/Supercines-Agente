// _shared/budget.ts
// Techo de gasto mensual: segunda red de seguridad, independiente de los frenos
// por lead (response_cooldown_seconds / max_responses_per_lead), que cubren a UN
// lead escribiendo demasiado pero no un gasto agregado disparado por otra vía
// (ráfaga de leads distintos, cambio de precio o de modelo, un bug propio).
//
// Config (runtime_config, DB-first/env-fallback; se edita desde /consumo):
//   MONTHLY_BUDGET_USD    techo en USD del mes en curso (UTC). Ausente, vacío o
//                         "0" = SIN freno — nunca cambia el comportamiento por defecto.
//   BUDGET_EXCLUDE_BEFORE ISO opcional: no cuenta el gasto anterior a esa fecha
//                         (para activar el techo a mitad de mes sin que el gasto
//                         previo lo dispare de entrada).
// El gasto sale de gasto_mes_actual() (migración 0066): suma
// usage_events.estimated_cost_usd, que ya valúa cada llamada (ai-pricing.ts).
//
// Dos niveles, como el resto de los gates (system_halted):
//   >= 100% → generate-response y follow-up-scan dejan de GENERAR respuestas
//             (process-inbound sigue clasificando: no se pierde la señal de
//             vertical). Un borrador pedido a mano desde el inbox (force_review)
//             no se bloquea: es una decisión humana puntual.
//   >= 110% → process-inbound también deja de CLASIFICAR. Los mensajes quedan
//             'pending' en inbound_queue (mismo mecanismo que system_halted): nada
//             se pierde, el sweep los retoma al subir el techo o cambiar de mes —
//             y el filtro de antigüedad (answer_max_age_hours) evita contestar
//             mensajes viejos al reanudar.
// El aviso (alerta budget_exceeded + webhook) lo emite alerts-scan, no esta
// ruta caliente: así pasa por el mismo camino de dedupe/webhook que el resto.
//
// Cache en module scope (TTL 60s): esto corre en el hot path de CADA
// inbound/respuesta; no tiene sentido pegarle a la DB cada vez.
//
// Fail-open ABSOLUTO: un error leyendo el gasto NUNCA frena el sistema — un
// freno que por un bug propio se convierte en apagón sería peor que no tenerlo.
//
// Alcance: frena el agente (respuestas, seguimientos) y la clasificación. No
// frena graders ni Dreams (jobs chicos y acotados), que igual suman al gasto.

export type BudgetGate = {
  blockGenerate: boolean;
  blockClassify: boolean;
  pct: number; // gasto/presupuesto * 100; 0 si no hay presupuesto configurado
};

export const GENERATE_THRESHOLD_PCT = 100;
export const CLASSIFY_THRESHOLD_PCT = 110;
const TTL_MS = 60_000;

const NO_GATE: BudgetGate = { blockGenerate: false, blockClassify: false, pct: 0 };

/** Presupuesto en USD, o null si no hay freno (ausente, vacío, "0", negativo, no numérico). */
export function parseBudget(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function evaluateBudget(spendUsd: number, budgetUsd: number): BudgetGate {
  const pct = (spendUsd / budgetUsd) * 100;
  return {
    blockGenerate: pct >= GENERATE_THRESHOLD_PCT,
    blockClassify: pct >= CLASSIFY_THRESHOLD_PCT,
    pct,
  };
}

/** Nivel de alerta que corresponde (el más alto alcanzado), o null. */
export function budgetAlertLevel(g: BudgetGate): 100 | 110 | null {
  return g.blockClassify ? 110 : g.blockGenerate ? 100 : null;
}

// Estructural: acepta el SupabaseClient real sin importarlo (módulo testeable).
type RpcClient = {
  rpc(fn: string): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};
type CfgGet = { get(key: string): string | undefined };

let cache: { value: BudgetGate; budget: string | undefined; loadedAt: number } | null = null;

export function resetBudgetCacheForTests(): void {
  cache = null;
}

export async function getBudgetGate(supabase: RpcClient, cfg: CfgGet): Promise<BudgetGate> {
  const raw = cfg.get("MONTHLY_BUDGET_USD");
  // Cambiar el techo invalida el cache: subirlo tiene que destrabar enseguida.
  if (cache && cache.budget === raw && Date.now() - cache.loadedAt < TTL_MS) return cache.value;

  const budgetUsd = parseBudget(raw);
  if (budgetUsd === null) {
    cache = { value: NO_GATE, budget: raw, loadedAt: Date.now() };
    return NO_GATE;
  }

  try {
    const { data, error } = await supabase.rpc("gasto_mes_actual");
    if (error) throw new Error(error.message);
    const value = evaluateBudget(Number(data) || 0, budgetUsd);
    cache = { value, budget: raw, loadedAt: Date.now() };
    return value;
  } catch (e) {
    console.warn("getBudgetGate error — fail-open:", e instanceof Error ? e.message : String(e));
    cache = { value: NO_GATE, budget: raw, loadedAt: Date.now() };
    return NO_GATE;
  }
}
