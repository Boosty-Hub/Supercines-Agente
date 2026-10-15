import { NextResponse } from "next/server";
import { internalHeadersForUrl } from "@/lib/internal-call";
import { requireScope } from "@/lib/auth/require-scope";
import { publicConfigValues } from "@/lib/runtime-config";
import { truncateGraphemes } from "@/lib/text-safe";
import {
  isToolSecretKey,
  publicKeysForHeaders,
  resolveToolHeaders,
  secretKeysInHeaders,
} from "@/lib/http-tool-keys";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

// nodejs runtime — ejecuta la tool de prueba del lado del servidor.
//
// SEGURIDAD: el probador NO resuelve NINGÚN secreto guardado. Lee de runtime_config solo
// claves PÚBLICAS (KOMMO_API_DOMAIN, KOMMO_SUBDOMAIN y los TOOL_<X>_HOSTS que atan cada
// secreto a su host) y los {{KOMMO_ACCESS_TOKEN}} / {{TOOL_<X>}} se sustituyen por los
// valores de prueba que el operador TECLEA en el propio probador (`testSecrets` del body):
// no se persisten, no se loguean y nunca se devuelven. Sin valor tecleado, la prueba falla
// con un mensaje claro. El único que resuelve secretos guardados es el runtime
// (generate-response), con el mismo `resolveToolHeaders` y el mismo atado a hosts.
export const runtime = "nodejs";

const MAX_TEST_SECRET_LENGTH = 8192;

const MAX_RESPONSE_CHARS = 8192;

/**
 * Recursively walks a JSON value and substitutes {{param}} placeholders.
 * - String leaf matching EXACTLY "{{param}}" → replaced with the typed
 *   input value (preserves number/boolean types).
 * - String leaf containing embedded "{{param}}" → string interpolation.
 * - Non-string values and structures are recursed/returned as-is.
 */
function substituteBody(
  template: unknown,
  input: Record<string, unknown>
): unknown {
  if (typeof template === "string") {
    // Exact match: "{{param}}" → preserve original type
    const exactMatch = template.match(/^\{\{(\w+)\}\}$/);
    if (exactMatch) {
      const key = exactMatch[1];
      return Object.hasOwn(input, key) ? input[key] : null;
    }
    // Embedded: replace each {{param}} with string representation
    return template.replace(/\{\{(\w+)\}\}/g, (_, k) =>
      Object.hasOwn(input, k) ? String(input[k]) : ""
    );
  }
  if (Array.isArray(template)) {
    return template.map((item) => substituteBody(item, input));
  }
  if (template !== null && typeof template === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template as Record<string, unknown>)) {
      out[k] = substituteBody(v, input);
    }
    return out;
  }
  return template;
}

// La tool tal como está en el editor (puede venir de la fila: campos en null). sampleInputs y
// testSecrets son datos del cliente: la ruta los lee solo como propiedades PROPIAS (abajo), y
// los valores de prueba de secretos nunca aparecen en un mensaje de error.
const ToolTestBody = z.object({
  tool: z.object({
    http_method: z.string().nullish(),
    url_template: z.string().nullish(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).nullish(),
    body_template: z.unknown().optional(),
    input_schema: z.object({ required: z.array(z.string()).optional() }).passthrough().nullish(),
    timeout_ms: z.number().nullish(),
  }),
  // z.record descarta una clave "__proto__" (sin contaminación de prototipo).
  sampleInputs: z.record(z.unknown()).optional(),
  testSecrets: z.record(z.unknown()).optional(),
});

/** POST /api/tools/test — dry-run an http tool with sample inputs. */
export async function POST(request: Request) {
  const auth = await requireScope("configuracion");
  // El probador ejecuta un fetch saliente desde el servidor: solo alcance `configuracion`
  // (el middleware ya lo exige para /api/tools; requireScope lo repite como defensa en profundidad).
  if (!auth.ok) return auth.response;

  const input = await readJson(request, ToolTestBody);
  if (!input.ok) return input.response;
  const body = input.data;

  const { tool } = body;
  // Datos del cliente: se leen solo como propiedades PROPIAS (nada heredado de Object.prototype).
  const sampleInputs: Record<string, unknown> = body.sampleInputs ?? {};

  if (!tool?.url_template) {
    return NextResponse.json({ error: "tool.url_template es requerido" }, { status: 400 });
  }

  // Validate required input fields.
  for (const k of tool.input_schema?.required ?? []) {
    if (!Object.hasOwn(sampleInputs, k)) {
      return NextResponse.json(
        { error: `Falta el parámetro requerido: "${k}"` },
        { status: 400 }
      );
    }
  }

  // Valores de prueba de los secretos: solo strings PROPIOS del body y solo para los secretos
  // que estos headers usan. Viven en memoria durante esta request y nada más.
  const neededSecrets = secretKeysInHeaders(tool.headers);
  const rawSecrets = body.testSecrets ?? {};
  const testSecrets: Record<string, string> = Object.create(null);
  for (const k of neededSecrets) {
    const v = Object.hasOwn(rawSecrets, k) ? rawSecrets[k] : undefined;
    if (typeof v === "string" && v.trim() !== "" && v.length <= MAX_TEST_SECRET_LENGTH) testSecrets[k] = v.trim();
  }

  // Claves públicas (dominio de Kommo, hosts declarados de cada TOOL_<X>): SOLO de la tabla,
  // sin process.env y sin traer ningún secreto (publicConfigValues lanza si se le pide uno).
  const publicValues: Record<string, string | undefined> = await publicConfigValues(publicKeysForHeaders(tool.headers));
  const lookup = (k: string): string | undefined =>
    isToolSecretKey(k)
      ? Object.hasOwn(testSecrets, k) ? testSecrets[k] : undefined
      : Object.hasOwn(publicValues, k) ? publicValues[k] : undefined;

  // Substitute {{param}} in url_template (URL-encode values).
  const interpolatedUrl = tool.url_template.replace(/\{\{(\w+)\}\}/g, (_, p) =>
    encodeURIComponent(String(Object.hasOwn(sampleInputs, p) ? sampleInputs[p] ?? "" : ""))
  );

  // Resolve {{CLAVE}} en los headers con la URL FINAL (ya interpolada) y los secretos atados a
  // sus hosts: la misma validación que el runtime, pero con los valores de prueba tecleados.
  const resolved = resolveToolHeaders({
    headers: tool.headers,
    urlTemplate: tool.url_template,
    finalUrl: interpolatedUrl,
    lookup,
    missingSecret: (k) =>
      `En el probador pegá el valor de prueba de {{${k}}}: la prueba nunca usa el secreto guardado (no se guarda ni se registra).`,
  });
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
  const headers = resolved.headers;
  // El fetch va a la URL que se VALIDÓ (parseada una vez), nunca a la cadena original.
  const url = resolved.url;

  // Tool que apunta a una Edge Function propia: se llama con el secreto interno
  // (nunca se devuelve al cliente), igual que hace el agente.
  // Con el secreto interno adjunto (solo a nuestro propio /functions/v1/) tampoco se siguen
  // redirects: no puede viajar a otro host.
  const internal = await internalHeadersForUrl(url);
  const attachedInternal = Object.keys(internal).length > 0;
  Object.assign(headers, internal);

  // Build body (non-GET only).
  let bodyStr: string | undefined;
  const method = (tool.http_method ?? "GET").toUpperCase();
  if (method !== "GET" && tool.body_template != null) {
    const substituted = substituteBody(tool.body_template, sampleInputs);
    bodyStr = JSON.stringify(substituted);
    headers["content-type"] ??= "application/json";
  }

  // Execute with timeout.
  const ctrl = new AbortController();
  const timeoutMs = tool.timeout_ms ?? 8000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: bodyStr,
      signal: ctrl.signal,
      // Con un secreto en los headers, un 302 NO puede llevarlo a otro host.
      ...(resolved.hasSecret || attachedInternal ? { redirect: "manual" as const } : {}),
    });
    clearTimeout(timer);

    const text = await res.text();
    const capped =
      text.length > MAX_RESPONSE_CHARS
        ? truncateGraphemes(text, MAX_RESPONSE_CHARS) + "…[truncado]"
        : text;

    // IMPORTANT: never echo resolved header values in the response.
    return NextResponse.json({
      status: res.status,
      body: capped,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes("abort") || msg.includes("timed out");
    return NextResponse.json({
      status: 0,
      body: "",
      error: isTimeout
        ? `Timeout después de ${timeoutMs}ms`
        : `Error de red: ${msg}`,
    });
  }
}
