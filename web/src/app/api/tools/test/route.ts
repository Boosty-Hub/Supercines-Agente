import { NextResponse } from "next/server";
import { internalHeadersForUrl } from "@/lib/internal-call";
import { requireScope } from "@/lib/auth/require-scope";
import { getRuntimeConfig } from "@/lib/runtime-config";
import { truncateGraphemes } from "@/lib/text-safe";
import { isToolConfigKey, resolveToolHeaders } from "@/lib/http-tool-keys";

// nodejs runtime — runs the HTTP tool executor server-side (resolves secrets
// from runtime_config, never exposes resolved values back to the client).
export const runtime = "nodejs";

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

/** POST /api/tools/test — dry-run an http tool with sample inputs. */
export async function POST(request: Request) {
  const auth = await requireScope("configuracion");
  // El probador ejecuta un fetch con secretos resueltos: solo alcance `configuracion`
  // (el middleware ya lo exige para /api/tools; requireScope lo repite como defensa en profundidad).
  if (!auth.ok) return auth.response;

  let body: {
    tool: {
      http_method: string;
      url_template: string;
      headers: Array<{ name: string; value: string }>;
      body_template: unknown;
      input_schema: {
        type: string;
        properties: Record<string, unknown>;
        required?: string[];
      };
      timeout_ms: number;
    };
    sampleInputs: Record<string, unknown>;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { tool } = body;
  // Datos del cliente: se leen solo como propiedades PROPIAS (nada heredado de Object.prototype).
  const sampleInputs: Record<string, unknown> =
    body.sampleInputs && typeof body.sampleInputs === "object" && !Array.isArray(body.sampleInputs)
      ? body.sampleInputs
      : {};

  if (!tool?.url_template) {
    return NextResponse.json({ error: "tool.url_template es requerido" }, { status: 400 });
  }

  // HTTPS-only assert.
  if (!tool.url_template.startsWith("https://")) {
    return NextResponse.json(
      { error: "url_template debe ser https://" },
      { status: 400 }
    );
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

  // Claves para los headers ({{CLAVE}}): SOLO de runtime_config, SOLO las permitidas y cada
  // secreto ATADO a sus hosts (lib/http-tool-keys.ts). Nunca process.env. Los valores
  // resueltos jamás se devuelven al cliente.
  // getRuntimeConfig = mapa SOLO de la DB (sin fallback a env), leído con service_role.
  const dbConfig = await getRuntimeConfig();
  const resolveConfigKey = (k: string): string | undefined =>
    isToolConfigKey(k) && Object.hasOwn(dbConfig, k) ? dbConfig[k] : undefined;

  // Substitute {{param}} in url_template (URL-encode values).
  const url = tool.url_template.replace(/\{\{(\w+)\}\}/g, (_, p) =>
    encodeURIComponent(String(Object.hasOwn(sampleInputs, p) ? sampleInputs[p] ?? "" : ""))
  );

  // Resolve {{CLAVE}} en los headers con la URL FINAL (ya interpolada) y los secretos atados a sus hosts.
  const resolved = resolveToolHeaders({
    headers: tool.headers,
    urlTemplate: tool.url_template,
    finalUrl: url,
    lookup: resolveConfigKey,
  });
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
  const headers = resolved.headers;

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
