// Parte pura (sin imports del proyecto) del disparo de Edge Functions desde el servidor.
// Vive aparte de internal-call.ts para poder testearse con `node --test`, porque
// aquel importa `server-only` y el cliente de Supabase.
//
// Por qué se ESPERA: en serverless (Netlify/Vercel) la ejecución se congela en cuanto
// la route devuelve la Response, así que un fetch lanzado sin await puede no salir
// nunca. Las Edge Functions contestan 202 al instante y siguen con waitUntil, por lo
// que esperar el acuse cuesta milisegundos; el timeout corto acota el peor caso.
//
// Un fallo del disparo NO se propaga: la acción del usuario ya quedó guardada y el
// barrido de pg_cron reintenta lo pendiente (red de seguridad). Se registra con
// contexto para que no sea silencioso.

export const TRIGGER_TIMEOUT_MS = 4_000;

export type TriggerOutcome =
  | { ok: true }
  | { ok: false; reason: "timeout" | "http" | "error"; detail: string };

type MinimalResponse = { ok: boolean; status: number; body?: { cancel(): Promise<void> } | null };

/**
 * Ejecuta `call` esperando su resultado con un tope de `timeoutMs` (que cubre también
 * el trabajo previo al fetch, p. ej. leer el secreto). NUNCA lanza.
 */
export async function runTrigger(
  call: () => Promise<MinimalResponse>,
  ctx: { slug: string; context: string },
  opts: { timeoutMs?: number; warn?: (msg: string) => void } = {}
): Promise<TriggerOutcome> {
  const timeoutMs = opts.timeoutMs ?? TRIGGER_TIMEOUT_MS;
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const label = `trigger ${ctx.slug} (${ctx.context})`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`sin respuesta en ${timeoutMs}ms`);
        e.name = "TimeoutError";
        reject(e);
      }, timeoutMs);
    });
    const res = await Promise.race([call(), deadline]);
    // El cuerpo no interesa: liberar la conexión.
    await res.body?.cancel().catch(() => {});
    if (!res.ok) {
      const detail = `HTTP ${res.status}`;
      warn(`${label} falló: ${detail}; el barrido de pg_cron lo reintenta`);
      return { ok: false, reason: "http", detail };
    }
    return { ok: true };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    warn(`${label} ${timedOut ? "excedió el tiempo" : "falló"}: ${err.message}; el barrido de pg_cron lo reintenta`);
    return { ok: false, reason: timedOut ? "timeout" : "error", detail: err.message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
