// Empuje guardado del system al agente vivo (puro: el I/O entra por `io`).
//
// Concurrencia optimista + sincronización segura: cada intento lee el agente vivo, decide
// si hay conflicto contra la LÍNEA BASE registrada (hash + versión) y recién entonces
// empuja con la versión leída. Ante un 409 (escritura concurrente: otro sync, un rename)
// se reintenta UNA vez RELEYENDO la línea base: la capturada antes del 409 puede ser
// vieja (el otro escritor movió hash y versión) y daría un falso conflicto.
import type { PromptConflict } from "./agent-prompt-sync.ts";

export type PushBaseline = { syncedHash: string | undefined; registeredVersion: number | null };

export type GuardedPushIO<Live extends { version?: unknown }> = {
  /** Línea base registrada, leída en el momento (no memoizada). */
  readBaseline: () => Promise<PushBaseline>;
  retrieve: () => Promise<Live>;
  detect: (live: Live, baseline: PushBaseline) => PromptConflict | null;
  /** Empuja con la versión leída; devuelve la versión nueva. */
  push: (version: Live["version"]) => Promise<number>;
  isVersionConflict: (err: unknown) => boolean;
};

export type GuardedPushResult =
  | { ok: true; version: number }
  | { ok: false; conflict: PromptConflict }
  | { ok: false; error: string };

export async function guardedPush<Live extends { version?: unknown }>(
  io: GuardedPushIO<Live>,
  opts: { overwrite: boolean; initialBaseline: PushBaseline }
): Promise<GuardedPushResult> {
  const attempt = async (baseline: PushBaseline): Promise<GuardedPushResult> => {
    const live = await io.retrieve();
    if (!opts.overwrite) {
      const conflict = io.detect(live, baseline);
      if (conflict) return { ok: false, conflict };
    }
    return { ok: true, version: await io.push(live.version) };
  };
  try {
    return await attempt(opts.initialBaseline);
  } catch (err) {
    if (!io.isVersionConflict(err)) return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    return await attempt(await io.readBaseline());
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
