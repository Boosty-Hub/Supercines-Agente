// _shared/budget.ts
// Techo de gasto mensual: segunda red de seguridad, independiente de los frenos
// por lead (response_cooldown_seconds / max_responses_per_lead), que cubren a UN
// lead escribiendo demasiado pero no un gasto agregado disparado por otra vía
// (ráfaga de leads distintos, cambio de precio o de modelo, un bug propio).
//
// Config (runtime_config, DB-first/env-fallback; se edita desde /consumo):
//   MONTHLY_BUDGET_USD    techo en USD del mes en curso (UTC). Ausente, vacío o
//                         "0" = SIN freno — nunca cambia el comportamiento por defecto.
//   BUDGET_SAFETY_MARGIN_PCT  margen de seguridad en % (0..50, default 0).
//   BUDGET_EXCLUDE_BEFORE ISO opcional: no cuenta el gasto anterior a esa fecha
//                         (para activar el techo a mitad de mes sin que el gasto
//                         previo lo dispare de entrada).
// El gasto sale de gasto_mes_actual() (migración 0066): suma
// usage_events.estimated_cost_usd, que ya valúa cada llamada (ai-pricing.ts).
//
// El freno corta SOLO las llamadas al modelo; la INGESTA nunca se detiene
// (leads, mensajes, etapas y pipelines se siguen guardando, el inbox sigue vivo y
// los detectores de salud no ven un falso "ingesta detenida"). Dos niveles:
//   >= 100% → dejan de GENERAR: generate-response y follow-up-scan (no se
//             reclama ningún mensaje: quedan para responderse al reanudar), y
//             también evaluate-outcomes (graders LLM) y dreams-run. Un borrador
//             pedido a mano desde el inbox (force_review) no se bloquea: es una
//             decisión humana puntual.
//   >= 110% → además deja de CLASIFICAR: process-inbound guarda el mensaje igual
//             pero lo marca con classification.error "budget: …" (sin el prefijo
//             "recover:") y sin vertical; recoverFailedClassifications lo
//             reclasifica solo al subir el techo o cambiar de mes, y
//             answer_max_age_hours evita contestar mensajes viejos al reanudar.
// El aviso (alerta budget_exceeded + webhook) lo emite alerts-scan, no esta
// ruta caliente, y se resuelve solo cuando el nivel deja de aplicar.
//
// ES UNA ESTIMACIÓN: el gasto sale de usage_events.estimated_cost_usd. Las
// sesiones CMA se valúan a tarifa base (cota inferior: una request interna de
// >100K tokens de Haiku 5.5 paga la tarifa larga y no se distingue en el total
// de la sesión). BUDGET_SAFETY_MARGIN_PCT (0..50, default 0) adelanta ambos
// cortes para compensarlo.
//
// Cache en module scope (TTL 60s): esto corre en el hot path de CADA
// inbound/respuesta; no tiene sentido pegarle a la DB cada vez.
//
// Fail-open ABSOLUTO: un error leyendo el gasto NUNCA frena el sistema — un
// freno que por un bug propio se convierte en apagón sería peor que no tenerlo.
//
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

/**
 * `marginPct` adelanta los dos cortes: con margen 10, el gasto estimado al 90%
 * ya cuenta como 100%. Compensa que la valuación de sesiones CMA es una COTA
 * INFERIOR (ver ai-pricing.ts, `aggregated`). `pct` queda como el gasto
 * estimado REAL, sin inflar.
 */
export function evaluateBudget(spendUsd: number, budgetUsd: number, marginPct = 0): BudgetGate {
  const pct = (spendUsd / budgetUsd) * 100;
  const eff = pct + marginPct;
  return {
    blockGenerate: eff >= GENERATE_THRESHOLD_PCT,
    blockClassify: eff >= CLASSIFY_THRESHOLD_PCT,
    pct,
  };
}

/** Margen de seguridad en % (0..50). Ausente o inválido = 0. */
export function parseMarginPct(raw: string | undefined | null): number {
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 50 ? n : 0;
}

// Marca de un mensaje que se ingestó pero NO se clasificó por el techo. Es
// "budget:" y NO "recover:" a propósito: recoverFailedClassifications lo
// reclasifica solo cuando el gate se abre (el prefijo "recover:" lo sacaría de
// la cola de reintentos para siempre).
export const BUDGET_ERROR_PREFIX = "budget:";
export function budgetSkipError(pct: number): string {
  return `${BUDGET_ERROR_PREFIX} techo mensual alcanzado (${pct.toFixed(0)}% del presupuesto estimado): se clasifica al reanudar`;
}

/** Nivel de alerta que corresponde (el más alto alcanzado), o null. */
export function budgetAlertLevel(g: BudgetGate): 100 | 110 | null {
  return g.blockClassify ? 110 : g.blockGenerate ? 100 : null;
}

/**
 * ¿La alerta abierta sigue vigente? No si cambió el mes (el gasto se reinició) ni
 * si el nivel actual ya no la alcanza (se subió el techo, se quitó, o el gasto
 * bajó). Una alerta de nivel 100 sigue vigente estando en 110.
 */
export function budgetAlertStillApplies(
  alert: { month: string; nivel: number },
  currentLevel: 100 | 110 | null,
  currentMonth: string,
): boolean {
  return alert.month === currentMonth && currentLevel !== null && currentLevel >= alert.nivel;
}

// Estructural: acepta el SupabaseClient real sin importarlo (módulo testeable).
type RpcClient = {
  rpc(fn: string): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};
type CfgGet = { get(key: string): string | undefined };

let cache: { value: BudgetGate; key: string; loadedAt: number } | null = null;

export function resetBudgetCacheForTests(): void {
  cache = null;
}

export async function getBudgetGate(supabase: RpcClient, cfg: CfgGet): Promise<BudgetGate> {
  const raw = cfg.get("MONTHLY_BUDGET_USD");
  const marginRaw = cfg.get("BUDGET_SAFETY_MARGIN_PCT");
  // TODO lo que cambia el resultado invalida el cache (techo, margen y el corte
  // BUDGET_EXCLUDE_BEFORE): subir el techo o excluir gasto tiene que destrabar
  // enseguida, no esperar el TTL.
  const key = `${raw ?? ""}|${marginRaw ?? ""}|${cfg.get("BUDGET_EXCLUDE_BEFORE") ?? ""}`;
  if (cache && cache.key === key && Date.now() - cache.loadedAt < TTL_MS) return cache.value;

  const budgetUsd = parseBudget(raw);
  if (budgetUsd === null) {
    cache = { value: NO_GATE, key, loadedAt: Date.now() };
    return NO_GATE;
  }

  try {
    const { data, error } = await supabase.rpc("gasto_mes_actual");
    if (error) throw new Error(error.message);
    const value = evaluateBudget(Number(data) || 0, budgetUsd, parseMarginPct(marginRaw));
    cache = { value, key, loadedAt: Date.now() };
    return value;
  } catch (e) {
    console.warn("getBudgetGate error — fail-open:", e instanceof Error ? e.message : String(e));
    cache = { value: NO_GATE, key, loadedAt: Date.now() };
    return NO_GATE;
  }
}
