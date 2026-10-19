// _shared/keyset-pages.ts
// Lectura COMPLETA de una consulta de PostgREST, por páginas con keyset (created_at, id).
//
// PostgREST corta cada respuesta en `max_rows` (1000 en Supabase) SIN error ni aviso: un
// select sin paginar «funciona» y devuelve solo las primeras 1000 filas. Así el corpus de
// Dreams analizaba los primeros 1000 mensajes de la ventana y la regresión de outcomes
// comparaba una muestra arbitraria (KIA: ~14.000 outcomes en 7 días).
//
// Keyset y no OFFSET (`.range`): las páginas se piden «después de la última fila vista»
// por (created_at, id), así una fila insertada mientras se lee no corre las páginas (con
// OFFSET se repetía o se saltaba una fila, y con un orden por uuid aleatorio el desorden
// era total). Una fila que entra a mitad de la lectura con un created_at ya pasado puede
// quedar afuera: es la foto de ese instante, no un error.
//
// Sin I/O propio: `fetchPage` arma la consulta (los filtros los pone el llamador) y aplica
// el cursor con `keysetFilter`. Tope duro `maxRows` con `truncated` para avisar.

export type KeysetCursor = { createdAt: string; id: string | number };

export type KeysetResult<T> = { rows: T[]; truncated: boolean };

/** Página de PostgREST tal como la devuelve supabase-js. */
export type PageResponse<T> = { data: T[] | null; error: { message: string } | null };

/**
 * Filtro `or` de PostgREST para «después de `c`» en orden (created_at, id), ascendente o
 * descendente (el mismo orden que use la consulta). Los
 * valores van entre comillas dobles: un timestamp trae `:` `+` `.`, que sin comillas rompen
 * la gramática de `or=(…)`.
 */
export function keysetFilter(c: KeysetCursor, order: "asc" | "desc" = "asc"): string {
  const t = JSON.stringify(c.createdAt);
  const id = JSON.stringify(String(c.id));
  const op = order === "asc" ? "gt" : "lt";
  return `created_at.${op}.${t},and(created_at.eq.${t},id.${op}.${id})`;
}

/**
 * Lee todas las páginas. `fetchPage(cursor, limit)` debe ordenar por (created_at, id) en UN
 * sentido (asc o desc, el mismo en las dos columnas), limitar a `limit` y, con cursor,
 * filtrar con `.or(keysetFilter(cursor, sentido))`. En desc el tope `maxRows` conserva lo
 * más reciente. Cada fila debe
 * traer `created_at` e `id`. Un error de cualquier página LANZA (no se decide con datos a
 * medias).
 */
export async function collectKeyset<T extends { created_at: string; id: string | number }>(
  fetchPage: (cursor: KeysetCursor | null, limit: number) => PromiseLike<PageResponse<T>>,
  opts: { pageSize?: number; maxRows: number; label: string },
): Promise<KeysetResult<T>> {
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? 1000, 1000));
  const rows: T[] = [];
  let cursor: KeysetCursor | null = null;
  while (rows.length < opts.maxRows) {
    const limit = Math.min(pageSize, opts.maxRows - rows.length);
    const { data, error } = await fetchPage(cursor, limit);
    if (error) throw new Error(`${opts.label}: ${error.message}`);
    const page = data ?? [];
    rows.push(...page);
    // Página corta = no hay más. (Si PostgREST tuviera un max_rows MENOR que pageSize, una
    // página «corta» no lo sería: por eso pageSize no supera 1000, el max_rows de Supabase.)
    if (page.length < limit) return { rows, truncated: false };
    const last = page[page.length - 1];
    cursor = { createdAt: last.created_at, id: last.id };
  }
  // Se llegó justo al tope: una fila más dice si de verdad quedó algo afuera.
  const probe = await fetchPage(cursor, 1);
  if (probe.error) throw new Error(`${opts.label}: ${probe.error.message}`);
  return { rows, truncated: (probe.data ?? []).length > 0 };
}
