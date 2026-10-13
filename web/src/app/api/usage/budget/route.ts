import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { setConfigValues } from "@/lib/runtime-config";
import { MAX_MONTHLY_BUDGET_USD } from "@/lib/budget";

export const runtime = "nodejs";

// POST /api/usage/budget — fija o quita el techo de gasto mensual.
//   { monthlyBudgetUsd: number | null, excludeSpentSoFar?: boolean, safetyMarginPct?: number }
// - monthlyBudgetUsd null (o 0) quita el freno y limpia BUDGET_EXCLUDE_BEFORE.
// - excludeSpentSoFar true escribe BUDGET_EXCLUDE_BEFORE = ahora: lo gastado
//   antes de este momento no cuenta (activar el techo a mitad de mes sin que lo
//   ya gastado lo dispare de entrada). false lo limpia. Ausente no lo toca.
// - safetyMarginPct (0..50) adelanta los cortes: el gasto es una ESTIMACIÓN (cota
//   inferior en sesiones CMA), el margen compensa. Ausente no lo toca.
// Las Edge Functions toman el cambio en <60s (cache de runtime_config).
export async function POST(request: Request) {
  const authClient = await createSupabaseServerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { monthlyBudgetUsd?: unknown; excludeSpentSoFar?: unknown; safetyMarginPct?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  const raw = body.monthlyBudgetUsd;
  if (raw === undefined) {
    return NextResponse.json({ ok: false, error: "Falta monthlyBudgetUsd (número o null)" }, { status: 400 });
  }
  const remove = raw === null || raw === 0;
  if (!remove && (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > MAX_MONTHLY_BUDGET_USD)) {
    return NextResponse.json(
      { ok: false, error: `El techo debe ser un número entre 0 y ${MAX_MONTHLY_BUDGET_USD} (0 o vacío = sin techo)` },
      { status: 400 }
    );
  }

  const margin = body.safetyMarginPct;
  if (margin !== undefined && (typeof margin !== "number" || !Number.isFinite(margin) || margin < 0 || margin > 50)) {
    return NextResponse.json({ ok: false, error: "El margen de seguridad debe estar entre 0 y 50 (%)" }, { status: 400 });
  }

  const values: Record<string, string | null> = {
    MONTHLY_BUDGET_USD: remove ? null : String(raw),
  };
  if (margin !== undefined) values.BUDGET_SAFETY_MARGIN_PCT = margin === 0 ? null : String(margin);
  if (remove) values.BUDGET_SAFETY_MARGIN_PCT = null;
  if (remove || body.excludeSpentSoFar === false) values.BUDGET_EXCLUDE_BEFORE = null;
  else if (body.excludeSpentSoFar === true) values.BUDGET_EXCLUDE_BEFORE = new Date().toISOString();

  await setConfigValues(values, user.email ?? "consumo-budget");
  return NextResponse.json({ ok: true, monthlyBudgetUsd: remove ? null : raw });
}
