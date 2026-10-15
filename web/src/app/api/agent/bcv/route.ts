import { NextResponse } from "next/server";
import { z } from "zod";
import { requireScope } from "@/lib/auth/require-scope";
import { SecretBindingError, setConfigValues } from "@/lib/runtime-config";
import { parseToolUrl } from "@/lib/http-tool-keys";
import { syncAgentTools } from "@/lib/sync-agent-tools";
import { readJson } from "@/lib/api/body";

const BcvBody = z.object({
  enabled: z.boolean().optional(),
  url: z.string().optional(),
  apiKey: z.string().optional(),
});

// nodejs runtime — syncAgentTools llama a Anthropic.
export const runtime = "nodejs";

// Gate + fuente de la tool interna tasa_bcv (Módulo 5).
//   - enabled → kommo_publish_config.bcv_rate_enabled (runtime, TTL 60s en edge)
//   - url/apiKey → runtime_config BCV_RATE_URL / BCV_RATE_APIKEY (fuente custom;
//     vacío = usar el fallback público sin credenciales)
export async function POST(request: Request) {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;
  const { supabase } = auth;

  const input = await readJson(request, BcvBody);
  if (!input.ok) return input.response;
  const body = input.data;

  if (body.enabled !== undefined) {
    const { error } = await supabase
      .from("kommo_publish_config")
      .update({ bcv_rate_enabled: body.enabled })
      .eq("is_active", true);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // La URL de la fuente propia se valida con las MISMAS reglas que la URL de una http tool que
  // lleva un secreto (lib/http-tool-keys.ts#parseToolUrl): https, puerto 443, un dominio (no IP
  // ni localhost) y sin caracteres que dos parsers lean distinto. Se guarda la href normalizada,
  // que es la que después usa el fetch de la tasa.
  let url: string | undefined;
  if (body.url !== undefined) {
    const raw = body.url.trim();
    if (raw !== "") {
      const parsed = parseToolUrl(raw, { strict: true });
      if (!parsed.ok) {
        return NextResponse.json({ error: `URL inválida: ${parsed.error}.` }, { status: 400 });
      }
      url = parsed.url.href;
    } else {
      url = "";
    }
  }
  const apiKey = body.apiKey?.trim();

  if (url !== undefined || apiKey !== undefined) {
    try {
      // setConfigValues aplica la regla de pares destino + secreto (lib/secret-bound-config.ts):
      // cambiar el host de BCV_RATE_URL sin reenviar (o borrar) BCV_RATE_APIKEY se rechaza.
      await setConfigValues(
        {
          ...(url !== undefined ? { BCV_RATE_URL: url } : {}),
          ...(apiKey !== undefined ? { BCV_RATE_APIKEY: apiKey } : {}),
        },
        auth.writer
      );
    } catch (e) {
      if (e instanceof SecretBindingError) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      throw e;
    }
  }

  // Registra la tool en Anthropic la primera vez que se activa (idempotente).
  const sync = await syncAgentTools(auth.writer).catch((e) => ({
    synced: false,
    version: null,
    error: String(e),
  }));

  return NextResponse.json({ ok: true, sync });
}
