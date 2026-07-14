/**
 * Formatea una fecha en texto relativo en español.
 * Reemplaza las implementaciones inline dispersas en las páginas del dashboard.
 *
 * @example
 *   timeAgo(new Date(Date.now() - 60_000)) // "hace 1 min"
 *   timeAgo("2024-01-01T00:00:00Z")        // "hace X días"
 */
export function timeAgo(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  const diffSec = Math.floor(diffMs / 1_000);

  if (diffSec < 60) return "hace un momento";
  if (diffSec < 3_600) {
    const min = Math.floor(diffSec / 60);
    return `hace ${min} min`;
  }
  if (diffSec < 86_400) {
    const h = Math.floor(diffSec / 3_600);
    return `hace ${h} h`;
  }
  if (diffSec < 86_400 * 30) {
    const d = Math.floor(diffSec / 86_400);
    return `hace ${d} ${d === 1 ? "día" : "días"}`;
  }
  if (diffSec < 86_400 * 365) {
    const m = Math.floor(diffSec / (86_400 * 30));
    return `hace ${m} ${m === 1 ? "mes" : "meses"}`;
  }
  const y = Math.floor(diffSec / (86_400 * 365));
  return `hace ${y} ${y === 1 ? "año" : "años"}`;
}
