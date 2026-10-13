// Edge Function: cartelera
// Proxy + compactador de la cartelera oficial de Supercines para la tool
// `consultar_cartelera` del agente. Reemplaza el subworkflow n8n original:
// consulta el API real, filtra a los próximos 5 días y compacta los campos
// para que la respuesta quepa bajo el tope de 8 KB del executor http.
//
// Uso: POST /functions/v1/cartelera  body {"sede_name":"La Granja"}
//      (también acepta ?nombre= o ?sede_name= en la query)
// verify_jwt=false (la llama el agente por URL directa, sin JWT de usuario) pero con
// GATE: exige x-internal-secret (_shared/auth.ts). Aunque la cartelera es información
// pública, sin gate cualquiera con la URL usaba esta función como proxy abierto contra
// el API de Supercines. El executor de tools http de generate-response adjunta el
// secreto automáticamente cuando la tool apunta a /functions/v1/ propio.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { authorizeInternal } from "../_shared/auth.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const API = "https://supercines.com.ve/api/bot/cartelera";
const MAX_DIAS = 6;
const MAX_PELIS_POR_DIA = 12;

const SEDES = ["La Granja", "Unicentro", "Los Aviadores", "La Cascada", "Puente Real", "Playa Mar"];

function norm(s: string): string {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

// Resuelve el nombre exacto de sede a partir de lo que mande el agente
function resolverSede(input: string): string | null {
  const n = norm(input);
  if (!n) return null;
  const exacta = SEDES.find((s) => norm(s) === n);
  if (exacta) return exacta;
  const parcial = SEDES.find((s) => norm(s).includes(n) || n.includes(norm(s)));
  return parcial ?? null;
}

Deno.serve(async (req) => {
  const denied = await authorizeInternal(req, supabase);
  if (denied) return denied;

  let sedeInput = "";
  try {
    const url = new URL(req.url);
    sedeInput = url.searchParams.get("nombre") || url.searchParams.get("sede_name") || "";
    if (!sedeInput && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      sedeInput = body.sede_name || body.nombre || body.sede || "";
    }
  } catch {
    // ignore
  }

  const sede = resolverSede(sedeInput);
  if (!sede) {
    return Response.json({
      error: `Sede no reconocida: "${sedeInput}". Sedes válidas: ${SEDES.join(", ")}.`,
    }, { status: 200 });
  }

  let raw: Record<string, unknown>;
  try {
    const res = await fetch(`${API}?nombre=${encodeURIComponent(sede)}`, {
      method: "POST",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return Response.json({ sede, error: `El servicio de cartelera respondió ${res.status}.` }, { status: 200 });
    }
    raw = await res.json();
  } catch (_e) {
    return Response.json({ sede, error: "No se pudo consultar la cartelera en este momento." }, { status: 200 });
  }

  const dias = Array.isArray(raw?.cartelera_por_dia) ? (raw.cartelera_por_dia as Record<string, unknown>[]) : [];
  if (dias.length === 0) {
    return Response.json({ sede, cartelera: [], nota: "No hay funciones publicadas para esta sede." }, { status: 200 });
  }

  // El API ya devuelve los días próximos en orden; tomamos los primeros
  // (cubre tanto sedes activas hoy como sedes en preventa/reapertura).
  const cartelera = dias
    .slice(0, MAX_DIAS)
    .map((d) => ({
      fecha: d.fecha,
      dia_semana: d.dia_semana,
      peliculas: (Array.isArray(d.peliculas) ? d.peliculas : [])
        .slice(0, MAX_PELIS_POR_DIA)
        .map((p: Record<string, unknown>) => ({
          nombre: p.nombre,
          idioma: p.idioma,
          censura: p.censura,
          preventa: p.es_preventa === 1 || p.es_preventa === true,
          horarios: (Array.isArray(p.horarios) ? p.horarios : [])
            .map((h: Record<string, unknown>) => String(h.hora ?? "").trim())
            .filter(Boolean),
        })),
    }));

  return Response.json({ sede, cartelera }, { status: 200 });
});
