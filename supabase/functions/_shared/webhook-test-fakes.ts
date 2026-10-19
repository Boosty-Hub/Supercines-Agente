// _shared/webhook-test-fakes.ts
// SOLO para tests (webhook-auth.test.ts, kommo-webhook-handler.test.ts): cliente de
// Supabase falso con el estado de autenticación controlable, y un reloj virtual.
// deno-lint-ignore-file no-explicit-any

export type Tables = Record<string, unknown>;
export type FakeMode =
  | { kind: "ok"; tables: Tables; delayMs?: number; insertError?: (table: string, row: any) => unknown }
  | { kind: "fail" }
  | { kind: "missing" }
  | { kind: "hang" };

export function tablesWith(current: string, mode = "strict", previous?: string, prevExp?: string): Tables {
  return {
    _app_secrets: [
      { clave: "KOMMO_WEBHOOK_SECRET", valor: current },
      ...(previous ? [{ clave: "KOMMO_WEBHOOK_SECRET_PREVIOUS", valor: previous }] : []),
    ],
    kommo_webhook_auth: { mode, previous_expires_at: prevExp ?? null },
  };
}

export function fakeClient(initial: FakeMode) {
  let mode = initial;
  let n = 0;
  const inserts: Array<{ table: string; row: any }> = [];
  const rpcs: Array<{ fn: string; args: any }> = [];
  const answer = (t: string): Promise<any> => {
    const m = mode;
    if (m.kind === "hang") return new Promise(() => {}); // nunca resuelve
    if (m.kind === "fail") return Promise.resolve({ data: null, error: { message: "connection refused" } });
    if (m.kind === "missing") {
      return Promise.resolve({ data: null, error: { code: "42P01", message: `relation "${t}" does not exist` } });
    }
    const v = { data: m.tables[t], error: null };
    return m.delayMs ? new Promise((r) => setTimeout(() => r(v), m.delayMs)) : Promise.resolve(v);
  };
  const sb: any = {
    from(t: string) {
      if (t === "kommo_webhook_auth") n++; // una "carga" = un par de consultas
      const q: any = {
        select: () => q,
        in: () => q,
        eq: () => q,
        maybeSingle: () => answer(t),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => answer(t).then(res, rej),
        insert: (row: any) => {
          const err = mode.kind === "ok" && mode.insertError ? mode.insertError(t, row) : null;
          if (err) return Promise.resolve({ error: err });
          inserts.push({ table: t, row });
          return Promise.resolve({ error: null });
        },
      };
      return q;
    },
    rpc: (fn: string, args: any) => {
      rpcs.push({ fn, args });
      if (fn === "insert_alert_aggregated") {
        // los tipos de origen externo se insertan agregados (0076): se registra como alerta
        inserts.push({ table: "alerts", row: { kind: args.p_kind, severity: args.p_severity, title: args.p_title, metadata: args.p_metadata } });
        return Promise.resolve({ data: "alert-id", error: null });
      }
      return Promise.resolve({ data: "strict", error: null });
    },
  };
  return {
    sb,
    set: (m: FakeMode) => (mode = m),
    queries: () => n,
    inserts: (table: string) => inserts.filter((i) => i.table === table).map((i) => i.row),
    rpcs: () => rpcs,
  };
}

/**
 * Reloj virtual + colector de trabajo de fondo. `sleep` avanza el reloj hasta el instante
 * de despertar (los que duermen a la vez comparten el mismo instante) y resuelve enseguida.
 */
export function harness(start = 1_000_000) {
  let t = start;
  const bg: Promise<unknown>[] = [];
  let hook: (() => void) | null = null;
  return {
    opts: {
      now: () => t,
      sleep: (ms: number) => {
        const wake = t + ms;
        return Promise.resolve().then(() => {
          if (wake > t) t = wake;
          hook?.();
        });
      },
      background: (p: Promise<unknown>) => void bg.push(p),
    },
    advance: (ms: number) => (t += ms),
    onSleep: (f: () => void) => (hook = f),
    drain: () => Promise.allSettled(bg),
  };
}
