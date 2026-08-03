// _shared/anthropic-client.ts
// Fábrica compartida para el cliente Anthropic. Envuelve `fetch` como único
// choke point para detectar "sin crédito" (400 + "credit balance") y
// auto-resolver la alerta cuando las llamadas vuelven a funcionar — ver
// _shared/provider-errors.ts. TODAS las construcciones `new Anthropic(...)`
// del repo deben pasar por acá.
//
// Hot-path safety: el wrapper SIEMPRE devuelve la `res` original sin
// alterarla, y nunca espera (`await`) el resultado de
// recordProviderCreditAlert/resolveProviderCreditAlert — corren en segundo
// plano (fire-and-forget, con .catch() defensivo) para no sumar latencia ni
// cambiar el comportamiento/throwing del SDK.

import Anthropic from "npm:@anthropic-ai/sdk@0.95.1";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { isCreditError, recordProviderCreditAlert, resolveProviderCreditAlert } from "./provider-errors.ts";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url; // Request
}

export function createAnthropicClient(apiKey: string, supabase: SupabaseClient): Anthropic {
  const wrappedFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);

    if (!res.ok) {
      // CLONE: el SDK todavía necesita leer el body original para parsear
      // el error y construir su excepción tipada. No await → no bloquea el
      // return de `res`.
      res
        .clone()
        .text()
        .then((text) => {
          if (isCreditError("anthropic", res.status, text)) {
            recordProviderCreditAlert(supabase, "anthropic", { status: res.status }).catch(() => {});
          }
        })
        .catch((e) => {
          console.error(
            "anthropic-client: no se pudo leer el body del error (ignorado):",
            e instanceof Error ? e.message : String(e),
          );
        });
    } else if (requestUrl(input).includes("api.anthropic.com")) {
      resolveProviderCreditAlert(supabase, "anthropic").catch(() => {});
    }

    return res;
  };

  return new Anthropic({ apiKey, fetch: wrappedFetch });
}
