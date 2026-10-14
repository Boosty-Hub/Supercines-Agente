// _shared/followup-variables.ts
// Variables de la plantilla de seguimiento que completa el agente (bloque
// <variables>{…}</variables> de su salida). Puro, sin red.
//
// La salida del modelo es texto NO confiable: puede traer claves como "__proto__",
// "constructor" o "toString". Leerlas con `obj[k]` sobre un objeto común devuelve lo
// HEREDADO de Object.prototype (una función, truthy): una variable de la plantilla
// llamada "constructor" pasaba el chequeo de «completa» con un valor que el modelo
// nunca escribió. Por eso: solo propiedades PROPIAS (Object.hasOwn) y el mapa
// resultante sin prototipo (Object.create(null)).

export type TemplateVariablesResult =
  /** Todas las variables de la plantilla, con su texto (solo esas claves). */
  | { ok: true; values: Record<string, string> }
  /** El bloque no es JSON legible. */
  | { ok: false; reason: "invalid_json" }
  /** Falta (o está vacía / no es texto) la variable `name`. */
  | { ok: false; reason: "missing"; name: string };

/**
 * @param raw   contenido del bloque <variables> (undefined si el agente no lo mandó).
 * @param names nombres de las variables de la plantilla, en orden.
 */
export function resolveTemplateVariables(raw: string | undefined, names: readonly string[]): TemplateVariablesResult {
  let parsed: unknown = null;
  if (raw !== undefined && raw.trim() !== "") {
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      return { ok: false, reason: "invalid_json" };
    }
  }
  const source =
    parsed != null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;

  const values: Record<string, string> = Object.create(null);
  for (const name of names) {
    const value = source && Object.hasOwn(source, name) ? textOf(source[name]) : null;
    if (value == null) return { ok: false, reason: "missing", name };
    values[name] = value;
  }
  return { ok: true, values };
}

/** Texto de una variable: string no vacío o número finito; cualquier otra cosa no cuenta. */
function textOf(v: unknown): string | null {
  if (typeof v === "string") return v.trim() ? v : null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}
