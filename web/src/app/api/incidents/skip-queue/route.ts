import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { createServiceClient } from "@/lib/supabase/service";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

// Sin cuerpo = umbral por defecto. Fuera de rango [5, 20160] también cae al default.
const SkipQueueBody = z.object({ minutes: z.union([z.number(), z.string()]).optional() });

export const runtime = "nodejs";
// Puede tocar miles de filas: no cortar antes de que termine el UPDATE.
export const maxDuration = 120;

// Omitir los items ATASCADOS de inbound_queue.
//
// Qué es un atascado: un item que `process-inbound` marcó como 'processing' y
// que nunca terminó, porque la función murió a mitad del run (crédito
// agotado, cuota del proveedor, clasificación en bucle). Los barridos solo
// toman 'pending', así que un 'processing' viejo no se reintenta NUNCA — se
// queda ahí y el detector de health-scan lo cuenta (kind `cola_atascada`).
//
// Omitir = darlos por perdidos: pasan a 'failed' con el motivo, dejan de
// contar y el incidente se cierra solo en el próximo barrido de health-scan.
// NO se borran: el payload queda para poder auditar qué se descartó.
//
// Alcance `configuracion` — lo exige el middleware sobre el prefijo `/api/incidents`
// (ver `PATH_SCOPES` en `lib/auth/roles.ts`) y lo vuelve a comprobar esta ruta:
// descartar mensajes de clientes sin procesar no es algo que deba poder hacer
// cualquiera con acceso al dashboard. El UPDATE va con el cliente de SERVICIO:
// inbound_queue es solo del servidor (la sesión no tiene privilegio sobre ella).
export async function POST(request: Request) {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  // Antigüedad mínima para considerarlo atascado. El default coincide con el
  // umbral del detector; así el botón omite exactamente lo que la franja
  // reporta y no se lleva items que están procesándose ahora mismo de verdad.
  const input = await readJson(request, SkipQueueBody, { optional: true });
  if (!input.ok) return input.response;
  let minutos = 30;
  const n = Number(input.data.minutes);
  if (Number.isFinite(n) && n >= 5 && n <= 20160) minutos = n;
  const corte = new Date(Date.now() - minutos * 60_000).toISOString();

  const { data, error } = await createServiceClient()
    .from("inbound_queue")
    .update({
      status: "failed",
      processed_at: new Date().toISOString(),
      last_error: `omitido manualmente por ${user.email ?? "admin"} (atascado en processing)`,
    })
    .eq("status", "processing")
    .lt("created_at", corte)
    .select("id");

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const omitidos = data?.length ?? 0;
  return NextResponse.json({
    ok: true,
    omitidos,
    // El incidente lo cierra health-scan cuando el conteo baja del umbral,
    // no este endpoint: cerrarlo a mano dejaría la franja apagada con el
    // sistema todavía roto.
    nota: "El incidente se cierra solo en el próximo barrido de health-scan (cada minuto).",
  });
}
