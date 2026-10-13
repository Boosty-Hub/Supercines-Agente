// _shared/crm-etapa.ts
// Resolución PURA de una etapa de Kommo por nombre — sin I/O, sin fetch. Vive
// acá (y no inline en generate-response/index.ts) porque DOS tools la
// necesitan con la MISMA regla y solo difieren en quién elige el nombre:
//
//   `mover_etapa`       → el nombre lo recibe del MODELO (el operador le
//                         escribió "cuando confirme la compra, muévelo a
//                         Ganado" en su voz/dreams).
//   `transferir_asesor` → el nombre sale de `runtime_config.HANDOFF_STAGE_NAME`
//                         (nunca del modelo — ver 0058_crm_tools_extra.sql).
//
// Lo que NO puede cambiar entre las dos es CÓMO se matchea un nombre contra
// las etapas reales de Kommo (normalización, ambigüedad entre pipelines): una
// segunda implementación que se corrija en un lado y no en el otro deja a las
// dos tools respondiendo distinto ante el mismo nombre.

import type { KommoStageLite } from "./kommo.ts";

/**
 * Normaliza texto para comparar nombres "tal como los escribe una persona"
 * contra los nombres reales de Kommo: minúsculas, sin acentos, sin espacios
 * en los extremos. Usada tanto para etapas como para campos custom.
 */
export function normalizarTexto(s: string): string {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

export type ResultadoEtapa =
  | { ok: true; etapa: KommoStageLite }
  | { ok: false; texto: string };

/**
 * Busca, entre `stages` (todas las etapas de todos los pipelines, ya
 * aplanadas), la que matchea `stageName` — opcionalmente acotando por
 * `pipelineName` cuando el nombre de etapa existe en más de un pipeline.
 *
 * Pura: no llama a Kommo ni a la base. El caller resuelve `stages` (con su
 * caché de 60s) y hace el PATCH + el registro en `lead_stage_events` si el
 * resultado es `ok:true`.
 */
export function resolverEtapa(
  stages: KommoStageLite[],
  stageName: string,
  pipelineName: string
): ResultadoEtapa {
  let matches = stages.filter((s) => normalizarTexto(s.name) === normalizarTexto(stageName));
  if (pipelineName) {
    matches = matches.filter((s) => normalizarTexto(s.pipelineName) === normalizarTexto(pipelineName));
  }
  if (matches.length === 0) {
    const opciones = stages.map((s) => `"${s.name}" (pipeline "${s.pipelineName}")`).join(", ");
    return {
      ok: false,
      texto: `No encontré una etapa llamada "${stageName}". Etapas disponibles: ${opciones || "(ninguna)"}.`,
    };
  }
  if (matches.length > 1) {
    const opciones = matches.map((s) => `pipeline "${s.pipelineName}"`).join(", ");
    return {
      ok: false,
      texto: `La etapa "${stageName}" existe en varios pipelines (${opciones}). Especificá 'pipeline_name' y reintentá.`,
    };
  }
  return { ok: true, etapa: matches[0] };
}
