// Clave de montaje para formularios cuyo estado local se inicializa desde la config.
//
// POR QUÉ: un `useState(initial.x)` solo lee `initial` en el PRIMER montaje. Si la config
// cambia por otro camino (p. ej. «Importar el vivo» reescribe SYSTEM_PROMPT y la página se
// refresca), React conserva el estado viejo y el siguiente «Guardar y sincronizar» PISA lo
// importado sin ningún conflicto. Pasar `key={formKey(...)}` re-monta el formulario cuando
// cambia cualquiera de los valores iniciales, así que el estado vuelve a nacer de la config.
import { createHash } from "node:crypto";

/** Hash corto y estable de los valores iniciales (el orden y los límites entre valores cuentan). */
export function formKey(...parts: (string | null | undefined)[]): string {
  return createHash("sha256").update(JSON.stringify(parts.map((p) => p ?? ""))).digest("hex").slice(0, 16);
}
