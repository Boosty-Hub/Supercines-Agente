// _shared/business-hours.ts
// Horario laboral del operador — un solo lugar para interpretarlo.
//
// Modelo (follow_up_config):
//   business_hours jsonb: { "1": {start:"09:00", end:"21:00"}, ... } por ISODOW
//   (1=Lun..7=Dom; día ausente = cerrado). Si es null → legacy:
//   business_hours_start/end (horas enteras) + active_days int[].
//
// El rango es [start, end) en la hora local del timezone configurado.

export type DayRange = { start: string; end: string };
export type BusinessHoursConfig = {
  timezone: string;
  business_hours: Record<string, DayRange> | null;
  business_hours_start: number;
  business_hours_end: number;
  active_days: number[];
};

const DAY_LABELS = ["", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

// "09:30" → 570. Tolerante: "9" → 540, inválido → null.
// "24:00" se acepta SOLO como fin (= fin del día, 1440); "24:30" no es válido.
function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec((hhmm || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (h > 24 || (h === 24 && min > 0) || min > 59) return null;
  return h * 60 + min;
}

// Hora local actual en el timezone: { isodow, minutes desde medianoche }.
function localNow(timezone: string): { isodow: number; minutes: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const isodow =
      { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[get("weekday")] ?? 0;
    // % 24: algunas variantes ICU (ciclo h24) devuelven "24" para medianoche.
    const hour = Number(get("hour")) % 24;
    const minute = Number(get("minute"));
    if (!isodow || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { isodow, minutes: hour * 60 + minute };
  } catch {
    return null;
  }
}

/** ¿Estamos dentro del horario laboral? Ante config rota → true (no bloquear). */
export function isBusinessHours(cfg: BusinessHoursConfig): boolean {
  const now = localNow(cfg.timezone);
  if (!now) return true;

  if (cfg.business_hours && typeof cfg.business_hours === "object") {
    const range = cfg.business_hours[String(now.isodow)];
    if (!range) return false; // día sin entrada = cerrado
    const start = toMinutes(range.start);
    const end = toMinutes(range.end);
    if (start === null || end === null) return true;
    return now.minutes >= start && now.minutes < end;
  }

  // Legacy: rango único + días activos.
  return (
    cfg.active_days.includes(now.isodow) &&
    now.minutes >= cfg.business_hours_start * 60 &&
    now.minutes < cfg.business_hours_end * 60
  );
}

/** Etiqueta legible del horario, agrupando días consecutivos con el mismo rango:
 *  "Lun a Vie 09:00–21:00; Sáb 09:00–13:00". Para el contexto del agente. */
export function businessHoursLabel(cfg: BusinessHoursConfig): string {
  let ranges: Array<{ day: number; text: string }>;
  if (cfg.business_hours && typeof cfg.business_hours === "object") {
    ranges = [];
    for (let d = 1; d <= 7; d++) {
      const r = cfg.business_hours[String(d)];
      if (r) ranges.push({ day: d, text: `${r.start}–${r.end}` });
    }
  } else {
    const text = `${String(cfg.business_hours_start).padStart(2, "0")}:00–${String(cfg.business_hours_end).padStart(2, "0")}:00`;
    ranges = [...cfg.active_days].sort((a, b) => a - b).map((day) => ({ day, text }));
  }
  if (ranges.length === 0) return "sin horario configurado";

  const groups: Array<{ from: number; to: number; text: string }> = [];
  for (const r of ranges) {
    const last = groups[groups.length - 1];
    if (last && last.text === r.text && r.day === last.to + 1) last.to = r.day;
    else groups.push({ from: r.day, to: r.day, text: r.text });
  }
  return groups
    .map((g) =>
      g.from === g.to
        ? `${DAY_LABELS[g.from]} ${g.text}`
        : `${DAY_LABELS[g.from]} a ${DAY_LABELS[g.to]} ${g.text}`
    )
    .join("; ");
}
