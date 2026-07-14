// promo-utils.ts — tipos y helpers de promociones/eventos.
// CLIENT-SAFE: sin "use client", sin imports de servidor.

export type Promo = {
  id: string;
  name: string;
  content: string;
  kind: "promo" | "evento";
  starts_at: string | null;
  ends_at: string | null;
  weekdays: number[] | null;
  enabled: boolean;
};

export type PromoStatus = "activa" | "programada" | "finalizada" | "apagada";

// now: Date del cliente (no se computa TZ del negocio en UI; aproximación local del operador).
export function promoStatus(p: Promo, now: Date): PromoStatus {
  if (!p.enabled) return "apagada";
  const ymd = now.toISOString().slice(0, 10);
  if (p.ends_at && ymd > p.ends_at) return "finalizada";
  if (p.starts_at && ymd < p.starts_at) return "programada";
  return "activa"; // en rango, o sin rango (recurrente/siempre)
}

const DOW = ["", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
function fmt(d: string) {
  const [, m, dd] = d.split("-");
  return `${+dd} ${["", "ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"][+m]}`;
}

export function vigenciaLabel(p: Promo): string {
  if (p.weekdays?.length) {
    if (p.weekdays.length === 1) return `Todos los ${DOW[p.weekdays[0]]}`;
    return `Días ${p.weekdays.map((d) => DOW[d]).join(", ")}`;
  }
  if (p.starts_at && p.ends_at) return `${fmt(p.starts_at)}–${fmt(p.ends_at)}`;
  if (p.starts_at) return `Desde ${fmt(p.starts_at)}`;
  if (p.ends_at) return `Hasta ${fmt(p.ends_at)}`;
  return "Siempre";
}
