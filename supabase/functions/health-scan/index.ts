// Edge Function: health-scan
//
// Barrido de SALUD DE PLATAFORMA, cada minuto (migración 0062). Detecta las
// fallas que dejan al agente MUDO sin producir una excepción en nuestro
// código — las que el sistema no puede notar desde adentro:
//
//   kommo_webhook_caido  Kommo deshabilitó la suscripción del webhook (o
//                        nunca hubo una). Es la defensa de Kommo ante
//                        entregas fallidas repetidas y produce un apagón
//                        TOTAL de ingesta: cero leads, cero mensajes. La
//                        Edge Function responde 200 y el token es válido,
//                        así que nada más lo delata. Kommo NO reenvía lo
//                        perdido.
//   kommo_token          El long-lived token dejó de servir (revocado o
//                        expirado): 401/403 al consultar los webhooks.
//   ingesta_detenida     Hace N minutos que no entra NADA a `messages`.
//                        Red de contención: cubre cualquier causa de apagón
//                        que no sea el webhook (DNS, red, Kommo caído).
//   cola_atascada        Muchos items viejos en 'processing' en
//                        inbound_queue = runs que se cortan a mitad. Síntoma
//                        clásico de que el agente está fallando aguas arriba.
//   registro_abierto     Supabase Auth acepta altas públicas (disable_signup
//                        = false): cualquiera con la anon key se crea una
//                        cuenta. Se lee de GoTrue `GET /auth/v1/settings`,
//                        que es público: no hace falta el token de Management.
//
// También CIERRA los incidentes cuando la salud vuelve. Sin este cierre, la
// franja roja quedaría prendida para siempre.
//
// Este barrido complementa —no reemplaza— a `alerts-scan` (`inbound_silence`
// / `kommo_webhook_disabled`, migración 0057): esas son un LOG (una fila,
// consultable en /alerts o vía el webhook de Slack/Discord); `system_incidents`
// es un ESTADO vivo con `remedy` y acción de recuperación de un clic, que se
// muestra en la franja de TODAS las páginas del dashboard (`system-banner.tsx`).
//
// Cada chequeo está aislado en su propio try/catch: que falle uno no puede
// impedir que corran los demás. Sin gate interno propio — mismo criterio de
// confianza que `alerts-scan` (cron-only, invocado por `net.http_post` sin
// Authorization; ver el invariante `verify_jwt=false` del CLAUDE.md de este
// repo): endurecer solo esta función sería inconsistente con el resto de los
// barridos periódicos.

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { authorizeInternal } from "../_shared/auth.ts";
import { loadConfig } from "../_shared/config.ts";
import { buildWebhookPayload } from "../_shared/alert-webhook.ts";
import {
  decidirColaAtascada,
  decidirIngestaDetenida,
  decidirRegistroAbierto,
  decidirTokenKommo,
  decidirWebhookKommo,
} from "../_shared/health-detectores.ts";
import {
  type IncidentInput,
  type IncidentKind,
  reportIncident,
  resolveIncident,
} from "../_shared/health-incidentes.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// El gateway de Supabase exige `apikey` también en /auth/v1/settings; la anon alcanza (es pública).
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? SERVICE_ROLE;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

const KOMMO_WEBHOOK_PATH = "/functions/v1/kommo-webhook";

type HealthConfig = {
  health_scan_enabled: boolean;
  ingesta_stale_minutes: number;
  cola_atascada_minutes: number;
  cola_atascada_threshold: number;
  webhook_url: string | null;
  webhook_enabled: boolean;
  webhook_kinds: string[];
};

async function getConfig(): Promise<HealthConfig | null> {
  const { data } = await supabase
    .from("alert_config")
    .select(
      "health_scan_enabled, ingesta_stale_minutes, cola_atascada_minutes, cola_atascada_threshold, webhook_url, webhook_enabled, webhook_kinds",
    )
    .eq("is_active", true)
    .maybeSingle();
  return data as HealthConfig | null;
}

/** Kinds que ya estaban abiertos ANTES de este barrido. */
async function abiertosPrevios(): Promise<Set<string>> {
  const { data } = await supabase
    .from("system_incidents")
    .select("kind")
    .is("resolved_at", null);
  return new Set((data ?? []).map((r: any) => r.kind as string));
}

// ---------------- I/O: webhook + token de Kommo ----------------
// El fetch y la clasificación por status HTTP viven acá porque necesitan la
// respuesta real; la decisión de QUÉ incidente corresponde vive en
// `_shared/health-detectores.ts` (pura, con test). Un status que no es 2xx ni
// 401/403 se trata como transitorio (5xx de Kommo) y se descarta lanzando —
// el try/catch del llamador lo absorbe sin marcar nada como sano ni como roto.
async function chequearKommo(
  dominio: string,
  token: string,
): Promise<IncidentInput | null> {
  const res = await fetch(`https://${dominio}/api/v4/webhooks`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const tokenInc = decidirTokenKommo(res.status);
  if (tokenInc) return tokenInc;

  if (!res.ok) {
    // 5xx de Kommo: transitorio, no es un incidente nuestro.
    throw new Error(`webhooks ${res.status}`);
  }

  const json = (await res.json()) as any;
  const webhooks = (json?._embedded?.webhooks ?? []) as Array<
    { destination?: string | null; disabled?: boolean | null }
  >;
  return decidirWebhookKommo(webhooks, KOMMO_WEBHOOK_PATH);
}

// ---------------- I/O: ingesta viva ----------------
async function chequearIngesta(minutos: number): Promise<IncidentInput | null> {
  // Se lee la fila MÁS NUEVA de `messages`, no un count sobre `inbound_queue`.
  // Dos razones:
  //   1. Un `count: exact` sobre inbound_queue (potencialmente cientos de
  //      miles de filas) puede dar statement timeout — justo durante un
  //      apagón, que es cuando la cola está más inflada.
  //   2. `messages` es lo que de verdad importa: un mensaje ENCOLADO que
  //      nunca se procesa no es ingesta viva. Preguntar por el mensaje
  //      persistido cubre también el caso de la cola que recibe pero no drena.
  // Va contra messages_inbound_recientes_idx (migración 0062): índice parcial
  // sobre created_at desc where direction='inbound'. Sin él esto expira.
  const { data: ultimo, error } = await supabase
    .from("messages")
    .select("created_at")
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`messages: ${error.message || error.code || "sin detalle"}`);

  if (!ultimo?.created_at) {
    return decidirIngestaDetenida(null, minutos, null);
  }

  const minutosMudos = Math.round(
    (Date.now() - new Date(ultimo.created_at as string).getTime()) / 60_000,
  );
  return decidirIngestaDetenida(minutosMudos, minutos, ultimo.created_at as string);
}

// ---------------- I/O: cola atascada ----------------
async function chequearCola(
  minutos: number,
  umbral: number,
): Promise<IncidentInput | null> {
  const desde = new Date(Date.now() - minutos * 60_000).toISOString();
  const { count, error } = await supabase
    .from("inbound_queue")
    .select("id", { count: "exact", head: true })
    .eq("status", "processing")
    .lt("created_at", desde);
  // Este count sí se banca la tabla inflada (filtra por status, que está
  // indexado) y el número exacto es lo que hace útil el mensaje. Si algún día
  // también expira, el try/catch del llamador deja pasar el resto del barrido.
  if (error) {
    throw new Error(`inbound_queue processing: ${error.message || error.code || "sin detalle"}`);
  }

  return decidirColaAtascada(count ?? 0, umbral, minutos);
}

// ---------------- I/O: registro público de Auth ----------------
// `GET /auth/v1/settings` de GoTrue expone `disable_signup` sin credenciales de usuario. Una
// respuesta sin ese booleano no prueba nada: se lanza y el barrido no abre ni cierra el incidente.
async function chequearRegistro(): Promise<IncidentInput | null> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {
    headers: { apikey: ANON_KEY },
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`auth settings ${res.status}`);
  }
  const json = (await res.json()) as { disable_signup?: unknown };
  if (typeof json?.disable_signup !== "boolean") throw new Error("auth settings sin disable_signup");
  return decidirRegistroAbierto(json.disable_signup);
}

// ---------------- Webhook externo (Slack/Discord) ----------------
// Mismo cuerpo que alerts-scan (_shared/alert-webhook.ts): el detalle puede traer texto de
// terceros (p. ej. el cuerpo de un error de Kommo), así que se neutralizan menciones y links.
async function postWebhook(cfg: HealthConfig, inc: IncidentInput) {
  if (!cfg.webhook_enabled || !cfg.webhook_url) return;
  if (!cfg.webhook_kinds.includes(inc.kind)) return;
  const description = [inc.description ?? "", inc.remedy ? `→ ${inc.remedy}` : ""].filter(Boolean).join("\n\n");
  try {
    const res = await fetch(cfg.webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildWebhookPayload({ severity: inc.severity ?? "critical", title: inc.title, description })),
    });
    await res.body?.cancel();
  } catch (e) {
    console.warn("health-scan webhook post failed:", e);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") return new Response("health-scan OK", { status: 200 });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  // Gate interno: esta función NO es un webhook público (ver _shared/auth.ts).
  {
    const denied = await authorizeInternal(req, supabase);
    if (denied) return denied;
  }

  try {
    const cfg = await getConfig();
    if (cfg && cfg.health_scan_enabled === false) {
      return new Response(JSON.stringify({ ok: true, skipped: "disabled" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const previos = await abiertosPrevios();
    const encontrados: IncidentInput[] = [];
    // Kinds que este barrido puede afirmar que están SANOS. Solo se cierran
    // estos: un chequeo que tiró excepción no sabe nada, y cerrar por
    // ignorancia apagaría la franja durante un apagón real.
    const sanos = new Set<IncidentKind>();

    // --- Kommo (webhook + token) ---
    try {
      const runtime = await loadConfig(supabase);
      const dominio = runtime.get("KOMMO_API_DOMAIN");
      const token = runtime.get("KOMMO_ACCESS_TOKEN");
      if (dominio && token) {
        const inc = await chequearKommo(dominio, token);
        if (inc) {
          encontrados.push(inc);
          // Si el problema es el token, no podemos afirmar nada del webhook
          // (no llegamos a leerlo con éxito), y viceversa.
          if (inc.kind === "kommo_token") sanos.add("kommo_webhook_caido");
          else sanos.add("kommo_token");
        } else {
          sanos.add("kommo_webhook_caido");
          sanos.add("kommo_token");
        }
      }
    } catch (e) {
      console.warn("health-scan kommo:", e instanceof Error ? e.message : String(e));
    }

    // --- Ingesta ---
    try {
      const inc = await chequearIngesta(cfg?.ingesta_stale_minutes ?? 45);
      if (inc) encontrados.push(inc);
      else sanos.add("ingesta_detenida");
    } catch (e) {
      console.warn("health-scan ingesta:", e instanceof Error ? e.message : String(e));
    }

    // --- Cola ---
    try {
      const inc = await chequearCola(
        cfg?.cola_atascada_minutes ?? 15,
        cfg?.cola_atascada_threshold ?? 50,
      );
      if (inc) encontrados.push(inc);
      else sanos.add("cola_atascada");
    } catch (e) {
      console.warn("health-scan cola:", e instanceof Error ? e.message : String(e));
    }

    // --- Registro público de Auth ---
    try {
      const inc = await chequearRegistro();
      if (inc) encontrados.push(inc);
      else sanos.add("registro_abierto");
    } catch (e) {
      console.warn("health-scan registro:", e instanceof Error ? e.message : String(e));
    }

    for (const inc of encontrados) {
      await reportIncident(supabase, inc);
      // Solo notificar al abrir, no en cada refresco: el barrido corre cada
      // minuto y avisar 60 veces por hora del mismo problema es ruido que
      // termina en un canal silenciado.
      if (cfg && !previos.has(inc.kind)) await postWebhook(cfg, inc);
    }
    const cerrados: IncidentKind[] = [];
    for (const kind of sanos) {
      if (previos.has(kind)) {
        await resolveIncident(supabase, kind);
        cerrados.push(kind);
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        abiertos: encontrados.map((i) => i.kind),
        cerrados,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("health-scan:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
