// Renombrar el Managed Agent SUBE su versión ("increments when the agent is modified").
// Si esa versión nueva no se registra en runtime_config.ANTHROPIC_AGENT_VERSION, la
// siguiente sincronización ve «versión viva > registrada» y da un FALSO conflicto.
//
// Este módulo es puro (sin I/O propio): el acceso al API entra por `io`, así se prueba
// sin red. El que renombra (sync-agent-tools.renameAgent) persiste lo que devuelve.

export type AgentRenameIO = {
  /** Lee el agente vivo (versión vigente). */
  retrieve: () => Promise<{ version?: number | null }>;
  /** POST update con `{ version, name }`; devuelve el agente actualizado. */
  update: (version: number) => Promise<{ version?: number | null }>;
  /** ¿El error es un 409 por concurrencia optimista? */
  isVersionConflict: (err: unknown) => boolean;
};

export type AgentRenameResult = {
  /** Versión del agente justo ANTES del rename (la que se leyó para el control optimista). */
  before: number | null;
  /** Versión VIGENTE tras el rename (la que devolvió el update, o releída si no vino). */
  after: number | null;
};

const asVersion = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/**
 * Renombra con concurrencia optimista (ante 409 relee la versión y reintenta una vez) y
 * devuelve la versión vigente tras el cambio. No asume si un rename sube o no la versión:
 * usa la que devuelve la respuesta y, si no vino, la RELEE del agente.
 */
export async function renameAgentVersioned(io: AgentRenameIO): Promise<AgentRenameResult> {
  const attempt = async (): Promise<AgentRenameResult> => {
    const current = await io.retrieve();
    const before = asVersion(current.version);
    if (before === null) throw new Error("El agente vivo no informó su versión: no se puede renombrar con control de concurrencia.");
    const updated = await io.update(before);
    const after = asVersion(updated.version) ?? asVersion((await io.retrieve()).version);
    return { before, after };
  };
  try {
    return await attempt();
  } catch (err) {
    if (io.isVersionConflict(err)) return await attempt();
    throw err;
  }
}

/**
 * ¿Qué versión registrar tras un rename? Solo si ANTES del rename el agente estaba en la
 * versión registrada (el rename es lo único que la movió). Si ya estaba por delante
 * (alguien lo editó por fuera) NO se registra: taparía ese conflicto real.
 */
export function versionToRecordAfterRename(input: {
  registered: number | null;
  result: AgentRenameResult;
}): number | null {
  const { registered, result } = input;
  if (registered === null || result.after === null) return null;
  return result.before === registered ? result.after : null;
}
