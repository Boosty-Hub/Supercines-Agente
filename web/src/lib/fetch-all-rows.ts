// PostgREST corta cualquier `.select()` sin `.range()` en `max_rows` (1000 por
// defecto en Supabase) SIN avisar: no hay error, no hay warning — la fila 1001
// en adelante simplemente no viene. Cualquier conteo, agregado o "traer todo
// para calcular en JS" sobre una tabla que puede superar esa cifra (mensajes,
// drafts, leads, eventos de uso...) queda calculado sobre una muestra parcial
// sin que nadie lo note, salvo que el número ya "se vea raro".
//
// Este helper pagina con `.range()` hasta agotar el resultado. Se le pasa un
// builder (no la query resuelta) porque `.range()` tiene que aplicarse sobre
// la MISMA cadena de filtros en cada vuelta — no se puede "seguir" una query
// ya ejecutada.
//
// @example
//   const rows = await fetchAllRows<{ status: string }>(() =>
//     supabase.from("drafts").select("status").gte("created_at", cutoffIso)
//   );
export type RangeableQuery<T> = {
  range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>;
};

const DEFAULT_PAGE_SIZE = 1000;

export async function fetchAllRows<T>(
  buildQuery: () => RangeableQuery<T>,
  pageSize: number = DEFAULT_PAGE_SIZE
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await buildQuery().range(offset, offset + pageSize - 1);
    if (error) throw error;
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}
