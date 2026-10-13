// _shared/dreams-digest-fingerprint.ts
//
// rebuildDigest (dreams-run) consolida TODOS los dreams activos en el digest
// rodante con una llamada al modelo. Corría en CADA ejecución, aunque el set de
// dreams activos y el digest previo fueran exactamente los mismos que en la
// corrida anterior (cron diario sin learnings nuevos, triggers del dashboard
// repetidos): gasto sin ningún cambio posible en el resultado.
//
// El fingerprint resume todo lo que determina la salida de esa llamada: cada
// dream activo (path + hash del contenido, así una EDICIÓN con el mismo path
// también cuenta), el digest previo (si alguien lo editó a mano, hay que
// reconstruir), el modelo, la versión del prompt y el tope de palabras. Se
// guarda en runtime_config.DREAMS_DIGEST_FINGERPRINT junto al digest que produjo;
// si en la corrida siguiente coincide, la llamada se salta.
//
// Cualquier mutación del dashboard (aprobar, borrar, importar) cambia el set y
// por lo tanto el fingerprint: el digest_only que disparan sigue reconstruyendo.

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type DigestContext = {
  model: string;
  /** Subir cuando cambia el prompt de consolidación: fuerza un rebuild al desplegar. */
  promptVersion: string;
  maxWords: number;
};

export async function digestFingerprint(
  dreams: ReadonlyArray<{ path: string; content: string }>,
  prevDigest: string,
  ctx: DigestContext,
): Promise<string> {
  const entries = await Promise.all(
    dreams.map(async (d) => [d.path, await sha256Hex(d.content)] as const),
  );
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // JSON (no concatenación): cada campo queda delimitado y no hay colisiones.
  return sha256Hex(JSON.stringify({ entries, prev: await sha256Hex(prevDigest), ...ctx }));
}

/**
 * ¿Se puede saltar la llamada al modelo? Solo si el fingerprint guardado
 * coincide Y no hay exceso de dreams por archivar: el archivado va por tandas
 * (ARCHIVE_BATCH) y necesita seguir corriendo aunque nada más cambie.
 */
export function canSkipDigestRebuild(p: {
  stored: string | undefined;
  current: string;
  activeCount: number;
  maxActive: number;
}): boolean {
  return Boolean(p.stored) && p.stored === p.current && p.activeCount <= p.maxActive;
}
