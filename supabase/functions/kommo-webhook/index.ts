// Edge Function: kommo-webhook
// Recibe webhooks de Kommo (mensajes, leads, etc), valida un secreto
// opcional, y encola el payload completo en `inbound_queue` para que
// un worker lo procese asincrónicamente. Responde 200 lo más rápido
// posible para que Kommo no reintente.
//
// URL pública (una vez deployada):
//   https://<project-ref>.supabase.co/functions/v1/kommo-webhook
//   (Kommo permite agregar ?secret=XXX como query param — si la env
//    KOMMO_WEBHOOK_SECRET está configurada, exigimos que coincida.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("KOMMO_WEBHOOK_SECRET") ?? "";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

// Parse application/x-www-form-urlencoded con notación de brackets de Kommo
// ("leads[add][0][id]=123" → { leads: { add: [{ id: "123" }] } })
function parseFormBracketed(body: string): Record<string, unknown> {
  const params = new URLSearchParams(body);
  const result: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) {
    const path = key.replace(/\]/g, "").split("[");
    // deno-lint-ignore no-explicit-any
    let cursor: any = result;
    for (let i = 0; i < path.length; i++) {
      const seg = path[i];
      const last = i === path.length - 1;
      if (last) {
        cursor[seg] = value;
      } else {
        const nextIsArray = /^\d+$/.test(path[i + 1]);
        if (cursor[seg] == null) {
          cursor[seg] = nextIsArray ? [] : {};
        }
        cursor = cursor[seg];
      }
    }
  }
  return result;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  const raw = await req.text();
  if (!raw) return {};
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(raw);
    } catch {
      return { _raw: raw };
    }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return parseFormBracketed(raw);
  }
  // Best-effort: probar JSON, si falla devolver raw
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

Deno.serve(async (req: Request) => {
  // Healthcheck / GET → 200
  if (req.method === "GET") {
    return new Response("kommo-webhook OK", { status: 200 });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Validar secreto si está configurado
  if (WEBHOOK_SECRET) {
    const url = new URL(req.url);
    const provided = url.searchParams.get("secret") ?? req.headers.get("x-webhook-secret");
    if (provided !== WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
  }

  try {
    const payload = await readBody(req);

    const { error } = await supabase
      .from("inbound_queue")
      .insert({
        source: "kommo_webhook",
        payload,
        status: "pending",
      });

    if (error) {
      console.error("inbound_queue insert error:", error);
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Disparar process-inbound. Usamos waitUntil para garantizar que el fetch
    // se completa aunque la función ya devolvió respuesta a Kommo.
    const processPromise = fetch(`${SUPABASE_URL}/functions/v1/process-inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch((e) => console.warn("trigger process-inbound failed:", e));
    // @ts-ignore: EdgeRuntime existe en Supabase
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(processPromise);
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("kommo-webhook error:", err);
    return new Response(JSON.stringify({ ok: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
});
