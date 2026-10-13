// _shared/budget.test.ts
// Correr con: deno test supabase/functions/_shared/budget.test.ts
import { assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  budgetAlertLevel,
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
