// Helpers del ruteo de leads compartidos por las rutas de /api/routing/*.
//
// Vive acá y no en un route.ts porque Next.js prohíbe exportar cualquier cosa
// que no sea un handler desde un archivo de ruta: el `next build` falla con
// «"parseTerms" is not a valid Route export field» (y `tsc --noEmit` NO lo
// detecta — solo lo ve el build).

/**
 * Normaliza los términos de match de un assignee: sin vacíos, sin duplicados.
 * Acepta un array o un string separado por comas (que es lo que manda el input
 * de texto del panel).
 */
export function parseTerms(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return Array.from(
      new Set(
        raw
          .filter((t: unknown): t is string => typeof t === "string")
          .map((t: string) => t.trim())
          .filter(Boolean)
      )
    );
  }
  if (typeof raw === "string") {
    return Array.from(
      new Set(
        raw
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      )
    );
  }
  return [];
}
