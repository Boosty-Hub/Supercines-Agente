// _shared/budget.test.ts
// Correr con: deno test supabase/functions/_shared/budget.test.ts
import { assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  budgetAlertLevel,
  budgetAlertStillApplies,
  BUDGET_ERROR_PREFIX,
  budgetSkipError,
  parseMarginPct,
  evaluateBudget,
  getBudgetGate,
  parseBudget,
  resetBudgetCacheForTests,
} from "./budget.ts";

Deno.test("parseBudget: solo números > 0; ausente, '0', negativo o basura = sin freno (null)", () => {
  assertEquals(parseBudget("50"), 50);
  assertEquals(parseBudget("12.5"), 12.5);
  for (const v of [undefined, "", "0", "-5", "abc", "NaN", "Infinity"]) assertEquals(parseBudget(v), null);
});

Deno.test("evaluateBudget: <100% libre; >=100% corta generar; >=110% corta también clasificar", () => {
  assertEquals(evaluateBudget(99.99, 100), { blockGenerate: false, blockClassify: false, pct: 99.99 });
  assertEquals(evaluateBudget(100, 100).blockGenerate, true);
  assertEquals(evaluateBudget(100, 100).blockClassify, false);
  assertEquals(evaluateBudget(109.99, 100).blockClassify, false);
  assertEquals(evaluateBudget(110, 100).blockClassify, true);
  assertEquals(evaluateBudget(0, 100).pct, 0);
});

Deno.test("budgetAlertLevel: el nivel que importa es el más alto alcanzado", () => {
  assertEquals(budgetAlertLevel(evaluateBudget(50, 100)), null);
  assertEquals(budgetAlertLevel(evaluateBudget(100, 100)), 100);
  assertEquals(budgetAlertLevel(evaluateBudget(115, 100)), 110);
});

const cfg = (v?: string) => ({ get: (k: string) => (k === "MONTHLY_BUDGET_USD" ? v : undefined) });
const sb = (rpc: () => Promise<{ data: unknown; error: { message: string } | null }>) => ({ rpc });

Deno.test("getBudgetGate: sin presupuesto => sin freno y NO consulta el gasto", async () => {
  resetBudgetCacheForTests();
  let calls = 0;
  const g = await getBudgetGate(sb(() => { calls++; return Promise.resolve({ data: 999, error: null }); }), cfg(undefined));
  assertEquals(g.blockGenerate, false);
  assertEquals(calls, 0);
});

Deno.test("getBudgetGate: consulta gasto_mes_actual y cachea (TTL) para no pegarle a la DB en cada inbound", async () => {
  resetBudgetCacheForTests();
  let calls = 0;
  const client = sb(() => { calls++; return Promise.resolve({ data: 120, error: null }); });
  const a = await getBudgetGate(client, cfg("100"));
  const b = await getBudgetGate(client, cfg("100"));
  assertEquals(a.blockGenerate, true);
  assertEquals(a.blockClassify, true);
  assertEquals(b, a);
  assertEquals(calls, 1);
});

Deno.test("getBudgetGate: FAIL-OPEN ante error del RPC (un freno que se vuelve apagón es peor que no tenerlo)", async () => {
  resetBudgetCacheForTests();
  const g = await getBudgetGate(sb(() => Promise.resolve({ data: null, error: { message: "boom" } })), cfg("100"));
  assertEquals(g, { blockGenerate: false, blockClassify: false, pct: 0 });
});

Deno.test("getBudgetGate: FAIL-OPEN ante excepción", async () => {
  resetBudgetCacheForTests();
  const g = await getBudgetGate(sb(() => Promise.reject(new Error("net"))), cfg("100"));
  assertEquals(g.blockGenerate, false);
});

Deno.test("getBudgetGate: cambiar el presupuesto invalida el cache (subirlo destraba en <1 request, no en 60s)", async () => {
  resetBudgetCacheForTests();
  const client = sb(() => Promise.resolve({ data: 120, error: null }));
  assertEquals((await getBudgetGate(client, cfg("100"))).blockGenerate, true);
  assertEquals((await getBudgetGate(client, cfg("500"))).blockGenerate, false);
});

Deno.test("margen de seguridad: frena ANTES del techo para compensar una valuación que es cota inferior", () => {
  // margen 10%: 90% del gasto estimado ya cuenta como 100% / 110% -> 99% y 99%+10
  assertEquals(evaluateBudget(89.99, 100, 10).blockGenerate, false);
  assertEquals(evaluateBudget(90, 100, 10).blockGenerate, true);
  assertEquals(evaluateBudget(99.99, 100, 10).blockClassify, false);
  assertEquals(evaluateBudget(100, 100, 10).blockClassify, true);
  // pct sigue siendo el gasto REAL estimado (no el inflado)
  assertEquals(evaluateBudget(90, 100, 10).pct, 90);
});

Deno.test("parseMarginPct: 0..50, basura => 0", () => {
  assertEquals(parseMarginPct("10"), 10);
  assertEquals(parseMarginPct("0"), 0);
  for (const v of [undefined, "", "-5", "abc", "51", "Infinity"]) assertEquals(parseMarginPct(v), 0);
});

Deno.test("budgetSkipError: texto estable con el prefijo 'budget:' (NO 'recover:', para que el recover lo reclasifique al reanudar)", () => {
  const e = budgetSkipError(112.4);
  assertEquals(e.startsWith(BUDGET_ERROR_PREFIX), true);
  assertEquals(e.startsWith("recover:"), false);
});

Deno.test("getBudgetGate: el cache se invalida al cambiar BUDGET_EXCLUDE_BEFORE o el margen, no solo el techo", async () => {
  resetBudgetCacheForTests();
  let spend = 120;
  const client = sb(() => Promise.resolve({ data: spend, error: null }));
  const mk = (b: string, ex?: string, m?: string) => ({
    get: (k: string) => ({ MONTHLY_BUDGET_USD: b, BUDGET_EXCLUDE_BEFORE: ex, BUDGET_SAFETY_MARGIN_PCT: m } as Record<string, string | undefined>)[k],
  });
  assertEquals((await getBudgetGate(client, mk("100"))).blockGenerate, true);
  spend = 10; // el gasto "baja" porque el operador excluyó lo anterior
  assertEquals((await getBudgetGate(client, mk("100", "2026-10-13T00:00:00Z"))).blockGenerate, false);
  spend = 95;
  assertEquals((await getBudgetGate(client, mk("100", "2026-10-13T00:00:00Z", "10"))).blockGenerate, true);
});

Deno.test("budgetAlertStillApplies: se resuelve al cambiar de mes, al subir el techo o al quitarlo", () => {
  const a100 = { month: "2026-10", nivel: 100 };
  const a110 = { month: "2026-10", nivel: 110 };
  assertEquals(budgetAlertStillApplies(a100, 100, "2026-10"), true);
  assertEquals(budgetAlertStillApplies(a100, 110, "2026-10"), true); // el 100 sigue siendo cierto en el 110
  assertEquals(budgetAlertStillApplies(a110, 100, "2026-10"), false); // bajó de 110 a 100
  assertEquals(budgetAlertStillApplies(a100, null, "2026-10"), false); // subió el techo / sin presupuesto
  assertEquals(budgetAlertStillApplies(a100, 100, "2026-11"), false); // otro mes
});
