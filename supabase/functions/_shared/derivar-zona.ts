// _shared/derivar-zona.ts
// Tool `derivar_a_zona(sede, motivo)`: deja el lead en el embudo de ventas de su zona y con
// la asesora de esa zona como responsable. La zona la decide el CÓDIGO a partir de la sede
// (_shared/zonas.ts + runtime_config.ZONAS_DERIVACION), nunca el modelo: el modelo solo dice
// qué sede o ciudad nombró el cliente.
//
// Orden (el de todo movimiento): Kommo primero (mover → responsable → nota) y después el
// registro local (apply_lead_position, único camino que escribe etapa + pipeline y registra
// el evento; marca de ruteo + auditoría en lead_routing_events, para que el ruteo
// automático no vuelva a decidir sobre un lead ya derivado).
//
// Idempotente: si el lead ya está en el embudo de esa zona no se mueve (se conserva el
// avance que haya hecho la asesora); solo se corrige el responsable si hace falta.
//
// No le roba un lead a una persona: el responsable se cambia solo si el lead no tiene
// dueño (0/null), si lo tiene una cuenta genérica (routing_takeover_user_ids) o si lo tiene
// otra asesora del ruteo (una asignación nuestra, p. ej. round robin a la zona equivocada).
//
// Las dependencias de I/O se inyectan (DerivarDeps) para probar el comportamiento con
// fakes (derivar-zona.test.ts) sin Kommo ni base.

import { truncateGraphemes } from "./text-safe.ts";
import { normalizeLoose } from "./text.ts";
import {
  type Asignable,
  type EspejoEtapa,
  esEtapaCerrada,
  resolverZona,
  resolverZonaEnEspejo,
  sinResponsable,
  terminosConocidos,
  type ZonaConfig,
  type ZonaResuelta,
} from "./zonas.ts";

export const DERIVAR_A_ZONA = "derivar_a_zona";

export type LeadEnVivo = { statusId: number; pipelineId: number; responsibleUserId: number | null };

export type DerivarDeps = {
  /** Zonas configuradas (ZONAS_DERIVACION ya validado) o el motivo si la config es inválida. */
  zonas: () => Promise<{ ok: true; zonas: ZonaConfig[] } | { ok: false; error: string }>;
  espejo: () => Promise<EspejoEtapa[]>;
  asignables: () => Promise<Asignable[]>;
  cuentasGenericas: () => Promise<Set<number>>;
  leerLead: () => Promise<LeadEnVivo>;
  moverEnKommo: (stageId: number, pipelineId: number) => Promise<void>;
  asignarEnKommo: (userId: number) => Promise<void>;
  notaEnKommo: (texto: string) => Promise<void>;
  /** apply_lead_position (fail-open: el llamador traga el error). */
  registrarPosicion: (p: {
    stageId: number;
    pipelineId: number;
    stageName: string;
    pipelineName: string;
    fromStageName: string | null;
  }) => Promise<void>;
  /** leads.routed_* + lead_routing_events (fail-open). */
  registrarRuteo: (p: { userId: number | null; previousUserId: number | null; termino: string; ok: boolean; detalle: string }) => Promise<void>;
  log?: (msg: string) => void;
};

const MAX_MOTIVO = 500;

export function construirNotaZona(z: ZonaResuelta, termino: string, motivo: string): string {
  const m = truncateGraphemes(motivo.trim(), MAX_MOTIVO) || "sin detalle";
  return `[Agente] Derivó el lead a la zona ${z.zona} (sede indicada: ${termino}). Asesora: ${z.asesorNombre}.\n\nMotivo: ${m}`;
}

function contactoAsesora(z: ZonaResuelta): string {
  return z.whatsapp
    ? `La asesora de esa zona es ${z.asesorNombre}, WhatsApp corporativo ${z.whatsapp}.`
    : `La asesora de esa zona es ${z.asesorNombre}.`;
}

export async function derivarAZona(input: Record<string, unknown>, deps: DerivarDeps): Promise<string> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const sede = String(input.sede ?? "").trim();
  const motivo = String(input.motivo ?? "").trim();
  if (!sede) {
    return "ERROR_VALIDACION: falta 'sede'. Pasa la sede o la ciudad que nombró el cliente.";
  }

  const cfg = await deps.zonas();
  if (!cfg.ok || cfg.zonas.length === 0) {
    log(`derivar_a_zona: ${cfg.ok ? "ZONAS_DERIVACION vacío" : cfg.error}`);
    return "No pude derivar el lead: las zonas de venta no están configuradas. Comparte el contacto de la asesora de la sede (búscalo con search_kb) y no lo vuelvas a intentar.";
  }
  const hit = resolverZona(sede, cfg.zonas);
  if (!hit) {
    return `No reconozco "${sede}" como una sede o ciudad de nuestras zonas. Confirma con el cliente en cuál de estas le interesa: ${terminosConocidos(cfg.zonas).join(", ")}. No compartas ningún contacto de asesora hasta saberlo.`;
  }

  const [espejo, asignables] = await Promise.all([deps.espejo(), deps.asignables()]);
  const r = resolverZonaEnEspejo(hit.zona, espejo, asignables);
  if (!r.ok) {
    log(`derivar_a_zona: zona ${hit.zona.zona}: ${r.error}`);
    return "No pude derivar el lead por un problema de configuración de nuestro lado. Comparte igual el contacto de la asesora de esa sede (búscalo con search_kb) y no lo vuelvas a intentar.";
  }
  const z = r.zona;

  let lead: LeadEnVivo;
  try {
    lead = await deps.leerLead();
  } catch (e) {
    log(`derivar_a_zona: no se pudo leer el lead en Kommo: ${e instanceof Error ? e.message : String(e)}`);
    return `No pude derivar el lead en este momento. ${contactoAsesora(z)} Compártele ese contacto y no lo vuelvas a intentar.`;
  }

  const zonaPipelines = new Set<number>();
  for (const zc of cfg.zonas) {
    const p = espejo.find((e) => normalizeLoose(e.pipeline_name) === normalizeLoose(zc.pipeline));
    if (p) zonaPipelines.add(p.pipeline_id);
  }
  const yaEnZona = lead.pipelineId === z.pipelineId;
  // Cerrado (ganado/perdido) dentro de un embudo de ventas = lo cerró una asesora: no se
  // reabre desde la conversación. Cerrado en otro embudo (p. ej. el de redes) sí se deriva.
  const cerradoEnVentas = esEtapaCerrada(lead.statusId) && zonaPipelines.has(lead.pipelineId);

  // 1) Mover (Kommo primero).
  let movido = false;
  if (!yaEnZona && !cerradoEnVentas) {
    try {
      await deps.moverEnKommo(z.stageId, z.pipelineId);
      movido = true;
    } catch (e) {
      log(`derivar_a_zona: Kommo rechazó el movimiento: ${e instanceof Error ? e.message : String(e)}`);
      await deps.registrarRuteo({
        userId: null, previousUserId: lead.responsibleUserId, termino: hit.termino, ok: false,
        detalle: `derivar_a_zona ${z.zona}: falló el movimiento en Kommo`,
      }).catch(() => {});
      return `No pude derivar el lead en este momento. ${contactoAsesora(z)} Compártele ese contacto y no lo vuelvas a intentar.`;
    }
  }

  // 2) Responsable.
  const anterior = sinResponsable(lead.responsibleUserId) ? null : Number(lead.responsibleUserId);
  const genericas = await deps.cuentasGenericas();
  const esAsesoraDelRuteo = anterior != null && asignables.some((a) => Number(a.kommo_user_id) === anterior);
  const puedeAsignar = anterior == null || genericas.has(anterior) || esAsesoraDelRuteo;
  let asignada = anterior === z.asesorUserId;
  let asignacionFallo = false;
  if (!asignada && puedeAsignar && !cerradoEnVentas) {
    try {
      await deps.asignarEnKommo(z.asesorUserId);
      asignada = true;
    } catch (e) {
      asignacionFallo = true;
      log(`derivar_a_zona: Kommo rechazó el responsable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 3) Nota (solo si algo cambió o si quedó algo para que una persona revise).
  const huboCambio = movido || (asignada && anterior !== z.asesorUserId);
  if (huboCambio || asignacionFallo || (!puedeAsignar && !asignada)) {
    try {
      await deps.notaEnKommo(construirNotaZona(z, hit.termino, motivo));
    } catch (e) {
      log(`derivar_a_zona: no se pudo dejar la nota: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 4) Registro local (fail-open).
  if (movido) {
    const from = espejo.find((e) => e.id === lead.statusId && e.pipeline_id === lead.pipelineId);
    await deps.registrarPosicion({
      stageId: z.stageId, pipelineId: z.pipelineId, stageName: z.stageName, pipelineName: z.pipelineName,
      fromStageName: from?.name ?? null,
    }).catch((e) => log(`derivar_a_zona: apply_lead_position: ${e instanceof Error ? e.message : String(e)}`));
  }
  const detalle = [
    `derivar_a_zona ${z.zona}`,
    movido ? "movido" : yaEnZona ? "ya estaba en el embudo" : cerradoEnVentas ? "cerrado en ventas: no se movió" : "",
    asignada ? (anterior === z.asesorUserId ? "responsable ya correcto" : "responsable asignado") :
      asignacionFallo ? "falló asignar responsable" : cerradoEnVentas ? "responsable sin cambios" : "responsable de otra persona: no se tocó",
  ].filter(Boolean).join("; ");
  await deps.registrarRuteo({
    userId: asignada ? z.asesorUserId : null, previousUserId: anterior, termino: hit.termino,
    ok: asignada || (!asignacionFallo), detalle,
  }).catch((e) => log(`derivar_a_zona: registrar ruteo: ${e instanceof Error ? e.message : String(e)}`));

  if (cerradoEnVentas) {
    return `El lead ya fue atendido y cerrado por el equipo de ventas, así que se queda donde está. ${contactoAsesora(z)} Compártele ese contacto si lo pide.`;
  }
  return `Listo: el lead quedó en el embudo de ventas de la zona ${z.zona}${asignada ? ` con ${z.asesorNombre} como responsable` : ""}. ${contactoAsesora(z)} Compártele ese contacto al cliente; es el cliente quien le escribe a la asesora.`;
}
