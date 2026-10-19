// Paginación del listado de un Memory Store (GET /v1/memory_stores/{id}/memories).
//
// La API pagina por CURSOR: cada respuesta trae `data` y `next_page` (string o null) y la
// siguiente página se pide con `page=<next_page>` (PageCursor del SDK oficial). Antes se
// pedía con `after_id` y se leían `has_more`/`last_id`, que esta API no devuelve: el listado
// se cortaba en la primera página (100 archivos) sin avisar.
//
// Sin I/O: la página entra por `fetchPage`, así se testea sin red.

export type MemoryPage<T> = { data: T[]; nextPage: string | null };

export type CollectResult<T> = {
  items: T[];
  /** Quedaron páginas sin leer (se alcanzó `max` o el tope de páginas). */
  truncated: boolean;
};

/** Lee `body` de la API como página: data (array) + next_page (string no vacío o null). */
export function parseMemoryPage<T>(body: unknown): MemoryPage<T> {
  const b = (body ?? {}) as { data?: unknown; next_page?: unknown };
  return {
    data: Array.isArray(b.data) ? (b.data as T[]) : [],
    nextPage: typeof b.next_page === "string" && b.next_page !== "" ? b.next_page : null,
  };
}

/**
 * Recorre las páginas hasta que no haya `next_page`, se junten `max` ítems o se lean
 * `maxPages` páginas. Un cursor que se repite corta (no hay bucle infinito).
 */
export async function collectMemoryPages<T>(
  fetchPage: (cursor: string | null) => Promise<MemoryPage<T>>,
  opts: { max: number; maxPages: number; keep?: (item: T) => boolean },
): Promise<CollectResult<T>> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < opts.maxPages; page++) {
    const { data, nextPage } = await fetchPage(cursor);
    for (const it of data) {
      if (opts.keep && !opts.keep(it)) continue;
      if (items.length >= opts.max) return { items, truncated: true };
      items.push(it);
    }
    if (!nextPage || seen.has(nextPage)) return { items, truncated: false };
    seen.add(nextPage);
    cursor = nextPage;
  }
  return { items, truncated: true };
}
