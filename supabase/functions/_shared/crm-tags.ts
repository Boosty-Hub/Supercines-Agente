// _shared/crm-tags.ts
// Normalización PURA de etiquetas para `etiquetar_lead` — sin I/O. Separada de
// `addLeadTags` (_shared/kommo.ts, que sí hace el GET+PATCH contra Kommo) para
// poder probar la regla ADITIVA (nunca pisar ni duplicar) sin mockear fetch.

/** Forma mínima de un tag ya existente en Kommo (solo lo que hace falta acá). */
export type EtiquetaExistente = { id: number; name: string };

/**
 * El modelo puede mandar `etiquetas` como array (caso normal, según el
 * input_schema de la tool) o como string suelto si alucina el formato
 * ("vip, urgente"). Tolerante en la entrada, estricto en la salida: siempre
 * devuelve una lista de strings no vacíos.
 */
export function parseEtiquetas(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((t) => String(t).trim()).filter(Boolean);
  }
  return String(raw ?? "")
    .split(/[,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Calcula qué etiquetas de `candidatas` hay que AGREGAR sobre `existentes`:
 * de forma aditiva (nunca se quita ni se pisa una existente), sin duplicar
 * contra lo que el lead ya tiene ni entre sí — comparando sin mayúsculas ni
 * espacios, porque Kommo trata "VIP" y "vip" como el mismo tag para un humano
 * aunque para un `Set` de JS sean strings distintos.
 */
export function calcularEtiquetasNuevas(
  existentes: EtiquetaExistente[],
  candidatas: string[]
): string[] {
  const existentesNorm = new Set(existentes.map((t) => t.name.trim().toLowerCase()));
  const vistas = new Set<string>();
  const nuevas: string[] = [];
  for (const c of candidatas) {
    const key = c.trim().toLowerCase();
    if (!key || existentesNorm.has(key) || vistas.has(key)) continue;
    vistas.add(key);
    nuevas.push(c.trim());
  }
  return nuevas;
}
