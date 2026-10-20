// _shared/zonas.ts
// Zonas de venta: qué sede/ciudad va a qué embudo (pipeline) de Kommo y a qué asesora.
// PURO: sin I/O. Lo usan la tool `derivar_a_zona` (_shared/derivar-zona.ts) y el ruteo
// automático (_shared/routing.ts), así que una sede se resuelve a la MISMA zona en los dos.
//
// POR QUÉ EXISTE. El agente tenía `mover_etapa` («ÚSALA SOLO con instrucción explícita») y
// tenía que adivinar el nombre del embudo y de la etapa: inventaba un embudo «Eventos» o
// mandaba el lead a «Ventas Super Cines», y la asesora de la zona nunca se enteraba. Ahora
// el mapa sede → embudo → asesora vive en `runtime_config.ZONAS_DERIVACION` (JSON público,
// sin ids: nombres que se resuelven contra el espejo de Kommo) y el modelo solo dice la sede.
//
// Formato de ZONAS_DERIVACION (arreglo):
//   { "zona": "CCS", "pipeline": "Ventas Zona CCS", "etapa": "Contacto inicial" (opcional),
//     "asesor": "Laura Frontado", "whatsapp": "+58 …" (opcional),
//     "sedes": ["La Cascada", "Puente Real"], "alias": ["Caracas", "Barcelona", …] }
// Sin "etapa" se usa la primera etapa de trabajo del embudo (la de menor orden que no sea
// la de entrada sin clasificar ni ganado/perdido).

import { containsTerm, normalizeLoose } from "./text.ts";

export type ZonaConfig = {
  zona: string;
  pipeline: string;
  etapa: string | null;
  asesor: string;
  whatsapp: string | null;
  /** Sedes y ciudades que identifican la zona (ya sin vacíos). */
  terminos: string[];
};

export type ParseZonas = { ok: true; zonas: ZonaConfig[] } | { ok: false; error: string };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str).filter((s) => s.length > 0) : [];
}

/** Valida ZONAS_DERIVACION. Vacío/ausente = sin zonas (ok con lista vacía). */
export function parseZonasConfig(raw: string | null | undefined): ParseZonas {
  const text = (raw ?? "").trim();
  if (!text) return { ok: true, zonas: [] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "ZONAS_DERIVACION no es JSON válido" };
  }
  if (!Array.isArray(data)) return { ok: false, error: "ZONAS_DERIVACION debe ser un arreglo" };
  const zonas: ZonaConfig[] = [];
  for (const [i, item] of data.entries()) {
    const o = (item ?? {}) as Record<string, unknown>;
    const zona = str(o.zona);
    const pipeline = str(o.pipeline);
    const asesor = str(o.asesor);
    const terminos = [...strList(o.sedes), ...strList(o.alias)];
    if (!zona || !pipeline || !asesor || terminos.length === 0) {
      return { ok: false, error: `ZONAS_DERIVACION[${i}]: faltan zona, pipeline, asesor o sedes` };
    }
    zonas.push({ zona, pipeline, etapa: str(o.etapa) || null, asesor, whatsapp: str(o.whatsapp) || null, terminos });
  }
  return { ok: true, zonas };
}

export type ZonaHit = { zona: ZonaConfig; termino: string };

/**
 * Zona que nombra `texto` (una sede o una ciudad). Sin acentos ni mayúsculas y por palabra
 * completa (containsTerm). Un término contenido en otro más largo que también aparece no
 * cuenta («Valencia» dentro de «Valencia Norte»). Si quedan términos de DOS zonas distintas
 * («Valencia o Maracay», «La Granja, vivo en Caracas») es ambiguo → null: el llamador pide
 * confirmar la sede en vez de elegir una por su cuenta.
 */
export function resolverZona(texto: string, zonas: ZonaConfig[]): ZonaHit | null {
  const norm = normalizeLoose(texto ?? "");
  if (!norm) return null;
  const hits: Array<ZonaHit & { nt: string }> = [];
  for (const z of zonas) {
    for (const t of z.terminos) {
      const nt = normalizeLoose(t);
      if (nt && containsTerm(norm, nt)) hits.push({ zona: z, termino: t, nt });
    }
  }
  const vigentes = hits.filter((h) => !hits.some((o) => o.nt.length > h.nt.length && containsTerm(o.nt, h.nt)));
  if (vigentes.length === 0) return null;
  if (new Set(vigentes.map((h) => h.zona.zona)).size > 1) return null;
  const best = vigentes.sort((a, b) => b.nt.length - a.nt.length)[0];
  return { zona: best.zona, termino: best.termino };
}

/** Todas las sedes/ciudades configuradas, para el mensaje de «no reconozco esa sede». */
export function terminosConocidos(zonas: ZonaConfig[]): string[] {
  return zonas.flatMap((z) => z.terminos);
}

// ---- Resolución contra el espejo de Kommo (kommo_pipelines / kommo_stages) ----------

export type EspejoEtapa = { pipeline_id: number; pipeline_name: string; id: number; name: string; type: number; sort: number };
export type Asignable = { kommo_user_id: number; display_name: string | null };

export type ZonaResuelta = {
  zona: string;
  pipelineId: number;
  pipelineName: string;
  stageId: number;
  stageName: string;
  asesorUserId: number;
  asesorNombre: string;
  whatsapp: string | null;
};

const KOMMO_WON = 142;
const KOMMO_LOST = 143;
/** type=1 en Kommo = etapa de entrada «sin clasificar»: la API no deja mover un lead ahí. */
const KOMMO_UNSORTED_TYPE = 1;

export function esEtapaCerrada(stageId: number | null | undefined): boolean {
  return stageId === KOMMO_WON || stageId === KOMMO_LOST;
}

/**
 * Resuelve una zona configurada a ids reales: embudo por nombre, etapa por nombre (o la
 * primera etapa de trabajo) y asesora por nombre entre los asignables del ruteo
 * (routing_assignees). Devuelve el motivo si algo no existe: un id adivinado escondería el
 * lead en un embudo donde nadie lo busca.
 */
export function resolverZonaEnEspejo(
  zona: ZonaConfig,
  etapas: EspejoEtapa[],
  asignables: Asignable[],
): { ok: true; zona: ZonaResuelta } | { ok: false; error: string } {
  const delPipeline = etapas.filter((e) => normalizeLoose(e.pipeline_name) === normalizeLoose(zona.pipeline));
  if (delPipeline.length === 0) return { ok: false, error: `no existe el embudo "${zona.pipeline}" en Kommo` };
  let etapa: EspejoEtapa | undefined;
  if (zona.etapa) {
    etapa = delPipeline.find((e) => normalizeLoose(e.name) === normalizeLoose(zona.etapa!));
    if (!etapa) return { ok: false, error: `no existe la etapa "${zona.etapa}" en el embudo "${zona.pipeline}"` };
  } else {
    etapa = delPipeline
      .filter((e) => e.type !== KOMMO_UNSORTED_TYPE && !esEtapaCerrada(e.id))
      .sort((a, b) => a.sort - b.sort)[0];
    if (!etapa) return { ok: false, error: `el embudo "${zona.pipeline}" no tiene una etapa de trabajo` };
  }
  const objetivo = normalizeLoose(zona.asesor);
  const asesora = asignables.find((a) => normalizeLoose(a.display_name ?? "") === objetivo);
  if (!asesora) return { ok: false, error: `la asesora "${zona.asesor}" no está entre los asignables del ruteo` };
  return {
    ok: true,
    zona: {
      zona: zona.zona,
      pipelineId: etapa.pipeline_id,
      pipelineName: etapa.pipeline_name,
      stageId: etapa.id,
      stageName: etapa.name,
      asesorUserId: Number(asesora.kommo_user_id),
      asesorNombre: asesora.display_name ?? zona.asesor,
      whatsapp: zona.whatsapp,
    },
  };
}

/**
 * ¿El lead está «sin dueño»? Kommo devuelve responsible_user_id = 0 cuando nadie lo tiene
 * (y null/ausente en algunos payloads). Tratar el 0 como un usuario real dejaba el lead
 * «ya asignado» para siempre: el ruteo no lo asignaba y lo marcaba ruteado (oct-2026).
 */
export function sinResponsable(responsibleUserId: number | null | undefined): boolean {
  return responsibleUserId == null || !Number.isFinite(responsibleUserId) || responsibleUserId <= 0;
}
