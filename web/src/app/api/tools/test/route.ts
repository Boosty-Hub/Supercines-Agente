import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

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
      return key in input ? input[key] : null;
    }
    // Embedded: replace each {{param}} with string representation
    return template.replace(/\{\{(\w+)\}\}/g, (_, k) =>
      k in input ? String(input[k]) : ""
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
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

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

  const { tool, sampleInputs = {} } = body;

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
    if (!(k in sampleInputs)) {
      return NextResponse.json(
        { error: `Falta el parámetro requerido: "${k}"` },
        { status: 400 }
      );
    }
  }

  // Resolve runtime_config keys for header substitution ({{CONFIG_KEY}}).
  // Use service client to read all keys; process.env as fallback.
  // NEVER return resolved secret values to the client.
  const serviceSupabase = createServiceClient();
  const { data: configRows } = await serviceSupabase
    .from("runtime_config")
    .select("key, value");
  const configMap: Record<string, string> = {};
  for (const row of (configRows ?? []) as Array<{ key: string; value: string | null }>) {
    if (row.value !== null && row.value !== "") configMap[row.key] = row.value;
  }
  const resolveConfigKey = (k: string): string =>
    configMap[k] ?? process.env[k] ?? "";

  // Substitute {{param}} in url_template (URL-encode values).
  const url = tool.url_template.replace(/\{\{(\w+)\}\}/g, (_, p) =>
    encodeURIComponent(String(sampleInputs[p] ?? ""))
  );

  // Resolve {{CONFIG_KEY}} in header values.
  const headers: Record<string, string> = {};
  for (const h of tool.headers ?? []) {
    headers[h.name] = h.value.replace(/\{\{(\w+)\}\}/g, (_, k) =>
      resolveConfigKey(k)
    );
  }

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
    });
    clearTimeout(timer);

    const text = await res.text();
    const capped =
      text.length > MAX_RESPONSE_CHARS
        ? text.slice(0, MAX_RESPONSE_CHARS) + "…[truncado]"
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
