// _shared/dreams-digest-fingerprint.ts
//
// rebuildDigest (dreams-run) arma el digest sin modelo (dreams-digest-render.ts), pero la
// reconstrucción igual puede llamar al modelo: el archivado (si hace falta) y las notas del
// operador. Correr eso en CADA ejecución sin ningún cambio (cron diario sin learnings nuevos,
// triggers del dashboard repetidos) es gasto sin efecto.
//
// El fingerprint resume todo lo que determina el resultado: cada dream activo (path + hash del
// contenido, así una EDICIÓN con el mismo path también cuenta), el resumen de lo archivado, el
// digest VIGENTE (si alguien lo editó o lo vació a mano hay que reconstruir), el modelo (notas
// y archivado), la versión del armado (DIGEST_RENDER_VERSION: subirla fuerza UNA
// reconstrucción al desplegar), el tope de palabras y el operador. Se guarda en
// runtime_config.DREAMS_DIGEST_FINGERPRINT junto al digest que produjo; si en la corrida
// siguiente coincide y no queda nada por archivar, se omite todo.
//
// Cualquier mutación del dashboard (aprobar, borrar, importar) cambia el set y por lo tanto el
// fingerprint: el digest_only que disparan sigue reconstruyendo.

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type DigestContext = {
  model: string;
  /** DIGEST_RENDER_VERSION: subirla fuerza un rebuild al desplegar. */
  renderVersion: string;
  maxWords: number;
  /** OPERATOR_NAME: se interpola en los prompts de archivado y de notas. */
  operator: string;
  /** DREAMS_ARCHIVE_DIGEST: entra al digest junto a los activos. */
  archived: string;
};

export async function digestFingerprint(
  dreams: ReadonlyArray<{ path: string; content: string }>,
  currentDigest: string,
  ctx: DigestContext,
): Promise<string> {
  const entries = await Promise.all(
    dreams.map(async (d) => [d.path, await sha256Hex(d.content)] as const),
  );
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // JSON (no concatenación): cada campo queda delimitado y no hay colisiones.
  return sha256Hex(JSON.stringify({
    entries,
    digest: await sha256Hex(currentDigest),
    ...ctx,
    archived: await sha256Hex(ctx.archived),
  }));
}

/**
 * ¿Se puede saltar la reconstrucción? Solo si el fingerprint guardado coincide Y no queda nada
 * por archivar (planArchive): el archivado va por tandas (ARCHIVE_BATCH) y necesita seguir
 * corriendo aunque nada más cambie.
 */
export function canSkipDigestRebuild(p: {
  stored: string | undefined;
  current: string;
  pendingArchive: number;
}): boolean {
  return Boolean(p.stored) && p.stored === p.current && p.pendingArchive === 0;
}
