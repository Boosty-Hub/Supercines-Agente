// Techo de gasto mensual — lado web. La lógica de frenado vive en
// supabase/functions/_shared/budget.ts (Edge); esto solo lee/valida la config
// que edita /consumo. parseBudget debe comportarse IGUAL que la de Edge
// (supabase/tests/web-parity.test.ts lo verifica).

/** Presupuesto en USD, o null si no hay freno (ausente, vacío, "0", negativo, no numérico). */
export function parseBudget(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Tope razonable para rechazar typos (un cero de más) antes de guardar. */
export const MAX_MONTHLY_BUDGET_USD = 1_000_000;
