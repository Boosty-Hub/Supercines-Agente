// situacion-utils.ts — tipos y helpers de situaciones (contexto situacional).
// CLIENT-SAFE: sin "use client", sin imports de servidor.

export type Situacion = {
  id: string;
  title: string;
  content: string;
  starts_at: string | null;
  ends_at: string | null;
  enabled: boolean;
};

export type SituacionStatus = "activa" | "programada" | "finalizada" | "apagada";

export function situacionStatus(s: Situacion, now: Date): SituacionStatus {
  if (!s.enabled) return "apagada";
  const ymd = now.toISOString().slice(0, 10);
  if (s.ends_at && ymd > s.ends_at) return "finalizada";
  if (s.starts_at && ymd < s.starts_at) return "programada";
  return "activa"; // en rango, o sin rango (vigente hasta que se apague)
}

function fmt(d: string) {
  const [, m, dd] = d.split("-");
  return `${+dd} ${["", "ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"][+m]}`;
}

export function vigenciaLabel(s: Situacion): string {
  if (s.starts_at && s.ends_at) return `${fmt(s.starts_at)}–${fmt(s.ends_at)}`;
  if (s.starts_at) return `Desde ${fmt(s.starts_at)}`;
  if (s.ends_at) return `Hasta ${fmt(s.ends_at)}`;
  return "Vigente";
}
