"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AgentTool } from "./page";
import { Modal, Button, ConfirmDialog, Badge } from "@/components/ui";

// Known runtime_config keys the operator might reference in headers.
// Extend this list as new secrets are added to runtime_config.
const CONFIG_KEY_OPTIONS = [
  "ANTHROPIC_API_KEY",
  "KOMMO_ACCESS_TOKEN",
  "KOMMO_API_DOMAIN",
  "KOMMO_SUBDOMAIN",
  "ANTHROPIC_AGENT_ID",
];

// Modal is imported from @/components/ui

// ---------------------------------------------------------------------------
// Param builder
// ---------------------------------------------------------------------------
type ParamRow = {
  id: string;
  name: string;
  type: "string" | "integer" | "number" | "boolean";
  required: boolean;
  description: string;
};

function ParamBuilder({
  params,
  onChange,
}: {
  params: ParamRow[];
  onChange: (rows: ParamRow[]) => void;
}) {
  function addRow() {
    onChange([
      ...params,
      { id: crypto.randomUUID(), name: "", type: "string", required: false, description: "" },
    ]);
  }
  function removeRow(id: string) {
    onChange(params.filter((r) => r.id !== id));
  }
  function updateRow(id: string, patch: Partial<ParamRow>) {
    onChange(params.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  return (
    <div className="space-y-2">
      {params.length === 0 && (
        <p className="text-xs text-neutral-400 italic">
          Sin parámetros. Añadí al menos uno si el agente necesita datos para llamar a esta tool.
        </p>
      )}
      {params.map((row) => (
        <div key={row.id} className="grid grid-cols-[1fr_100px_auto_1fr_auto] gap-2 items-start">
          <input
            value={row.name}
            onChange={(e) => updateRow(row.id, { name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })}
            placeholder="nombre_param"
            className="w-full rounded-lg border border-neutral-300 px-2 py-1.5 text-xs font-mono focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          />
          <select
            value={row.type}
            onChange={(e) => updateRow(row.id, { type: e.target.value as ParamRow["type"] })}
            className="w-full rounded-lg border border-neutral-300 px-2 py-1.5 text-xs focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          >
            <option value="string">string</option>
            <option value="integer">integer</option>
            <option value="number">number</option>
            <option value="boolean">boolean</option>
          </select>
          <label className="flex items-center gap-1 text-xs text-neutral-600 whitespace-nowrap pt-1.5">
            <input
              type="checkbox"
              checked={row.required}
              onChange={(e) => updateRow(row.id, { required: e.target.checked })}
              className="rounded border-neutral-300 text-neutral-900 focus:ring-neutral-900"
            />
            requerido
          </label>
          <input
            value={row.description}
            onChange={(e) => updateRow(row.id, { description: e.target.value })}
            placeholder="descripción para el agente"
            className="w-full rounded-lg border border-neutral-300 px-2 py-1.5 text-xs focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => removeRow(row.id)}
            className="text-neutral-400 hover:text-red-600 transition-colors pt-1.5 text-xs px-1"
            aria-label="Eliminar parámetro"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        className="text-xs font-medium text-neutral-600 hover:text-neutral-900 transition-colors"
      >
        + Añadir parámetro
      </button>
    </div>
  );
}

function buildInputSchema(
  params: ParamRow[]
): { type: "object"; properties: Record<string, unknown>; required: string[] } {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of params) {
    if (!p.name) continue;
    properties[p.name] = {
      type: p.type,
      ...(p.description ? { description: p.description } : {}),
    };
    if (p.required) required.push(p.name);
  }
  return { type: "object", properties, required };
}

function schemaToParams(schema: AgentTool["input_schema"]): ParamRow[] {
  if (!schema?.properties) return [];
  return Object.entries(schema.properties).map(([name, def]) => {
    const d = def as { type?: string; description?: string };
    return {
      id: crypto.randomUUID(),
      name,
      type: (d.type ?? "string") as ParamRow["type"],
      required: (schema.required ?? []).includes(name),
      description: d.description ?? "",
    };
  });
}

// ---------------------------------------------------------------------------
// Header builder
// ---------------------------------------------------------------------------
type HeaderRow = { id: string; name: string; value: string };

function HeaderBuilder({
  headers,
  onChange,
}: {
  headers: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
}) {
  function addRow() {
    onChange([...headers, { id: crypto.randomUUID(), name: "", value: "" }]);
  }
  function removeRow(id: string) {
    onChange(headers.filter((r) => r.id !== id));
  }
  function updateRow(id: string, patch: Partial<HeaderRow>) {
    onChange(headers.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function insertConfigKey(id: string, key: string) {
    const row = headers.find((r) => r.id === id);
    if (!row) return;
    updateRow(id, { value: row.value + `{{${key}}}` });
  }

  return (
    <div className="space-y-2">
      {headers.length === 0 && (
        <p className="text-xs text-neutral-400 italic">Sin headers adicionales.</p>
      )}
      {headers.map((row) => (
        <div key={row.id} className="flex gap-2 items-start">
          <input
            value={row.name}
            onChange={(e) => updateRow(row.id, { name: e.target.value })}
            placeholder="Authorization"
            className="w-40 shrink-0 rounded-lg border border-neutral-300 px-2 py-1.5 text-xs font-mono focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          />
          <input
            value={row.value}
            onChange={(e) => updateRow(row.id, { value: e.target.value })}
            placeholder="Bearer {{KOMMO_ACCESS_TOKEN}}"
            className="flex-1 rounded-lg border border-neutral-300 px-2 py-1.5 text-xs font-mono focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          />
          <select
            onChange={(e) => {
              if (e.target.value) insertConfigKey(row.id, e.target.value);
              e.target.value = "";
            }}
            defaultValue=""
            className="rounded-lg border border-neutral-300 px-2 py-1.5 text-xs text-neutral-600 focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
            title="Insertar clave de config"
          >
            <option value="">+ Config key</option>
            {CONFIG_KEY_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => removeRow(row.id)}
            className="text-neutral-400 hover:text-red-600 transition-colors text-xs px-1 pt-1.5"
            aria-label="Eliminar header"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        className="text-xs font-medium text-neutral-600 hover:text-neutral-900 transition-colors"
      >
        + Añadir header
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Probar (test) panel
// ---------------------------------------------------------------------------
// Minimal shape the test panel needs — the exact subset of AgentTool, so both a
// saved tool and the live create/edit form state satisfy it (test before save).
type TestableTool = Pick<
  AgentTool,
  "http_method" | "url_template" | "headers" | "body_template" | "input_schema" | "timeout_ms"
>;

function TestPanel({
  tool,
  onClose,
}: {
  tool: TestableTool;
  onClose: () => void;
}) {
  const params = schemaToParams(tool.input_schema);
  const [inputs, setInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(params.map((p) => [p.name, ""]))
  );
  const [result, setResult] = useState<{
    status?: number;
    body?: string;
    error?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingRun, setConfirmingRun] = useState(false);

  async function runRequest() {
    setBusy(true);
    setConfirmingRun(false);
    setResult(null);
    try {
      const res = await fetch("/api/tools/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool: {
            http_method: tool.http_method,
            url_template: tool.url_template,
            headers: tool.headers,
            body_template: tool.body_template,
            input_schema: tool.input_schema,
            timeout_ms: tool.timeout_ms,
          },
          sampleInputs: inputs,
        }),
      });
      const j = await res.json();
      setResult(j);
    } catch (e) {
      setResult({ error: String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 space-y-4 rounded-xl border border-neutral-200 bg-neutral-50 p-4">
      <p className="text-xs font-medium text-neutral-700">
        Probar — valores de ejemplo para los parámetros:
      </p>
      {params.length > 0 ? (
        <div className="space-y-2">
          {params.map((p) => (
            <div key={p.name} className="flex items-center gap-2">
              <label className="w-32 shrink-0 text-xs font-mono text-neutral-600">
                {p.name}
                {p.required && (
                  <span className="ml-1 text-red-500">*</span>
                )}
              </label>
              <input
                value={inputs[p.name] ?? ""}
                onChange={(e) =>
                  setInputs((prev) => ({ ...prev, [p.name]: e.target.value }))
                }
                placeholder={p.type}
                className="flex-1 rounded-lg border border-neutral-300 px-2 py-1.5 text-xs focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-neutral-400 italic">
          Esta tool no tiene parámetros.
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={() => {
            if (tool.http_method && tool.http_method !== "GET") {
              setConfirmingRun(true);
            } else {
              runRequest();
            }
          }}
          disabled={busy}
          busy={busy}
        >
          {busy ? "Ejecutando…" : "Ejecutar"}
        </Button>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-neutral-500 hover:text-neutral-700 transition-colors"
        >
          Cancelar
        </button>
      </div>
      {result && (
        <div className="rounded-lg border border-neutral-200 bg-white p-3 space-y-1">
          {result.error ? (
            <p className="text-xs text-red-600 font-mono">{result.error}</p>
          ) : (
            <>
              <p className="text-xs font-medium text-neutral-700">
                Estado HTTP:{" "}
                <span
                  className={
                    (result.status ?? 0) >= 200 && (result.status ?? 0) < 300
                      ? "text-emerald-700"
                      : "text-red-600"
                  }
                >
                  {result.status}
                </span>
              </p>
              <pre className="max-h-48 overflow-auto text-[10px] font-mono text-neutral-600 whitespace-pre-wrap">
                {result.body}
              </pre>
            </>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmingRun}
        title={`Ejecutar petición ${tool.http_method}`}
        description={`Esta petición real al servidor remoto puede tener efectos secundarios. ¿Continuar?`}
        confirmLabel="Ejecutar"
        tone="default"
        busy={busy}
        onConfirm={runRequest}
        onCancel={() => setConfirmingRun(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ToolForm (create / edit)
// ---------------------------------------------------------------------------
type ToolFormData = {
  name: string;
  description: string;
  http_method: string;
  url_template: string;
  headers: HeaderRow[];
  body_template: string;
  timeout_ms: number;
  params: ParamRow[];
};

function ToolForm({
  initial,
  isNew,
  onDone,
  toolId,
}: {
  initial: ToolFormData;
  isNew: boolean;
  onDone: () => void;
  toolId?: string;
}) {
  const [form, setForm] = useState<ToolFormData>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sync, setSync] = useState<{ synced?: boolean; version?: number | null } | null>(null);
  const [showTest, setShowTest] = useState(false);

  function update(patch: Partial<ToolFormData>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  // Detect {{param}} in url_template for helper text.
  const detectedParams = Array.from(
    new Set(
      Array.from(form.url_template.matchAll(/\{\{(\w+)\}\}/g)).map((m) => m[1])
    )
  );

  // Build a testable tool from the CURRENT form state so "Probar" works before
  // saving — same parsing the save() path uses for body_template.
  const liveTool: TestableTool = {
    http_method: form.http_method,
    url_template: form.url_template,
    headers: form.headers.map(({ name, value }) => ({ name, value })),
    body_template:
      form.http_method !== "GET" && form.body_template.trim()
        ? (() => {
            try {
              return JSON.parse(form.body_template);
            } catch {
              return null;
            }
          })()
        : null,
    input_schema: buildInputSchema(form.params),
    timeout_ms: form.timeout_ms,
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSync(null);

    const inputSchema = buildInputSchema(form.params);
    const payload: Record<string, unknown> = {
      name: form.name,
      description: form.description,
      http_method: form.http_method,
      url_template: form.url_template,
      headers: form.headers.map(({ name, value }) => ({ name, value })),
      body_template:
        form.http_method !== "GET" && form.body_template.trim()
          ? (() => {
              try {
                return JSON.parse(form.body_template);
              } catch {
                return null;
              }
            })()
          : null,
      input_schema: inputSchema,
      timeout_ms: form.timeout_ms,
    };

    const url = isNew ? "/api/tools" : `/api/tools/${toolId}`;
    const method = isNew ? "POST" : "PATCH";

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "Error al guardar");
      return;
    }
    const j = await res.json().catch(() => ({}));
    setSync(j.sync ?? null);
    onDone();
  }

  return (
    <form onSubmit={save} className="space-y-5 max-w-3xl">
      {/* Name */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-neutral-600">
            Nombre{" "}
            <span className="font-normal text-neutral-400">
              (snake_case, único)
            </span>
          </label>
          <input
            value={form.name}
            onChange={(e) =>
              update({ name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })
            }
            placeholder="consultar_stock"
            disabled={!isNew}
            required
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm font-mono focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none disabled:bg-neutral-50 disabled:text-neutral-400"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-neutral-600">Timeout (ms)</label>
          <input
            type="number"
            min={1000}
            max={30000}
            value={form.timeout_ms}
            onChange={(e) => update({ timeout_ms: Number(e.target.value) })}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          />
        </div>
      </div>

      {/* Description */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-neutral-600">
          Descripción{" "}
          <span className="font-normal text-neutral-400">
            (el agente usa esto para decidir cuándo llamar a la tool)
          </span>
        </label>
        <textarea
          value={form.description}
          onChange={(e) => update({ description: e.target.value })}
          rows={2}
          required
          placeholder="Consulta el stock disponible de un producto dado su SKU."
          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
        />
      </div>

      {/* Method + URL */}
      <div className="grid grid-cols-[120px_1fr] gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-neutral-600">Método</label>
          <select
            value={form.http_method}
            onChange={(e) => update({ http_method: e.target.value })}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          >
            {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-neutral-600">
            URL Template{" "}
            <span className="font-normal text-neutral-400">
              (https:// obligatorio, usa {`{{param}}`} para parámetros dinámicos)
            </span>
          </label>
          <input
            value={form.url_template}
            onChange={(e) => update({ url_template: e.target.value })}
            placeholder="https://api.example.com/stock?sku={{sku}}"
            required
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm font-mono focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          />
          {detectedParams.length > 0 && (
            <p className="text-xs text-neutral-400">
              Parámetros detectados en la URL:{" "}
              {detectedParams.map((p) => (
                <code
                  key={p}
                  className="rounded bg-neutral-100 px-1 py-0.5 text-neutral-700 mr-1"
                >
                  {p}
                </code>
              ))}
            </p>
          )}
        </div>
      </div>

      {/* Param builder */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-neutral-600">
          Parámetros de entrada{" "}
          <span className="font-normal text-neutral-400">
            (definen el input_schema que el agente recibe)
          </span>
        </label>
        <ParamBuilder
          params={form.params}
          onChange={(p) => update({ params: p })}
        />
      </div>

      {/* Headers */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-neutral-600">
          Headers{" "}
          <span className="font-normal text-neutral-400">
            (usa + Config key para insertar {`{{CLAVE}}`} que se resuelve en runtime)
          </span>
        </label>
        <HeaderBuilder
          headers={form.headers}
          onChange={(h) => update({ headers: h })}
        />
      </div>

      {/* Body template (non-GET only) */}
      {form.http_method !== "GET" && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-neutral-600">
            Body Template{" "}
            <span className="font-normal text-neutral-400">
              (JSON con {`{{param}}`} — los valores del agente se sustituyen en runtime)
            </span>
          </label>
          <textarea
            value={form.body_template}
            onChange={(e) => update({ body_template: e.target.value })}
            rows={5}
            placeholder={`{\n  "sku": "{{sku}}",\n  "quantity": {{qty}}\n}`}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm font-mono focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          />
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {sync && (
        <p className="text-xs text-neutral-500">
          {sync.synced
            ? `Agente sincronizado (v${sync.version ?? "?"})`
            : "Sync pendiente — el agente se actualizará en la próxima operación."}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
        >
          {busy ? "Guardando…" : isNew ? "Crear tool" : "Guardar cambios"}
        </button>
        <button
          type="button"
          onClick={() => setShowTest((v) => !v)}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
        >
          {showTest ? "Ocultar prueba" : "Probar"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
        >
          Cancelar
        </button>
      </div>

      {/* Test the tool with sample param values WITHOUT saving first. Keyed on
          the param schema so the input fields refresh when you edit params. */}
      {showTest && (
        <TestPanel
          key={JSON.stringify(liveTool.input_schema)}
          tool={liveTool}
          onClose={() => setShowTest(false)}
        />
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// ToolRow
// ---------------------------------------------------------------------------
function ToolRow({ tool }: { tool: AgentTool }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [showTest, setShowTest] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function toggleEnabled() {
    setToggling(true);
    await fetch(`/api/tools/${tool.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !tool.enabled }),
    });
    setToggling(false);
    router.refresh();
  }

  async function remove() {
    setDeleting(true);
    await fetch(`/api/tools/${tool.id}`, { method: "DELETE" });
    setDeleting(false);
    setConfirmingDelete(false);
    router.refresh();
  }

  const isSystem = tool.tool_type === "system";
  const initial: ToolFormData = {
    name: tool.name,
    description: tool.description,
    http_method: tool.http_method ?? "GET",
    url_template: tool.url_template ?? "",
    headers: (tool.headers ?? []).map((h) => ({
      id: crypto.randomUUID(),
      ...h,
    })),
    body_template: tool.body_template ? JSON.stringify(tool.body_template, null, 2) : "",
    timeout_ms: tool.timeout_ms,
    params: schemaToParams(tool.input_schema),
  };

  return (
    <>
      <tr className="transition-colors hover:bg-neutral-50">
        {/* Name */}
        <td className="px-4 py-3">
          <span className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium font-mono text-neutral-700">
            {tool.name}
          </span>
        </td>
        {/* Type badge */}
        <td className="px-4 py-3">
          {isSystem ? (
            <Badge color="blue">Sistema</Badge>
          ) : (
            <Badge color="neutral">HTTP {tool.http_method}</Badge>
          )}
        </td>
        {/* Description */}
        <td className="px-4 py-3 text-sm text-neutral-600 max-w-xs truncate">
          {tool.description}
        </td>
        {/* Enabled toggle */}
        <td className="px-4 py-3">
          {isSystem ? (
            <Badge color="green">Siempre activa</Badge>
          ) : (
            <button
              type="button"
              disabled={toggling}
              onClick={toggleEnabled}
              className={
                "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50 " +
                (tool.enabled
                  ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                  : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200")
              }
            >
              {tool.enabled ? "ON" : "OFF"}
            </button>
          )}
        </td>
        {/* Actions */}
        <td className="px-4 py-3 text-right">
          {isSystem ? (
            <span className="text-xs text-neutral-400 italic">Solo lectura</span>
          ) : (
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setShowTest(!showTest)}>
                Probar
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
                Editar
              </Button>
              <Button variant="danger" size="sm" onClick={() => setConfirmingDelete(true)}>
                Eliminar
              </Button>
            </div>
          )}
        </td>
      </tr>
      {/* Inline test panel */}
      {showTest && !isSystem && (
        <tr>
          <td colSpan={5} className="px-4 pb-4">
            <TestPanel tool={tool} onClose={() => setShowTest(false)} />
          </td>
        </tr>
      )}
      {/* Edit modal */}
      {open && (
        <Modal
          open={open}
          title={`Editar: ${tool.name}`}
          subtitle={tool.url_template ?? undefined}
          onClose={() => setOpen(false)}
        >
          <ToolForm
            initial={initial}
            isNew={false}
            toolId={tool.id}
            onDone={() => {
              setOpen(false);
              router.refresh();
            }}
          />
        </Modal>
      )}
      <ConfirmDialog
        open={confirmingDelete}
        title={`Eliminar tool "${tool.name}"`}
        description="Los flujos del agente que usen esta tool dejarán de funcionar. Esta acción no se puede deshacer."
        confirmLabel="Eliminar"
        tone="danger"
        busy={deleting}
        onConfirm={remove}
        onCancel={() => setConfirmingDelete(false)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// NewToolButton
// ---------------------------------------------------------------------------
function NewToolButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const initial: ToolFormData = {
    name: "",
    description: "",
    http_method: "GET",
    url_template: "",
    headers: [],
    body_template: "",
    timeout_ms: 8000,
    params: [],
  };

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        + Nueva tool
      </Button>
      {open && (
        <Modal open={open} title="Nueva tool HTTP" onClose={() => setOpen(false)}>
          <ToolForm
            initial={initial}
            isNew
            onDone={() => {
              setOpen(false);
              router.refresh();
            }}
          />
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// System tools (read-only) — presentación amigable por categoría
// ---------------------------------------------------------------------------
const CRM_TOOL_NAMES = new Set(["mover_etapa", "actualizar_lead", "actualizar_contacto"]);
const SHOPIFY_TOOL_NAMES = new Set([
  "buscar_producto",
  "ver_categorias",
  "consultar_pedido",
  "crear_link_pago",
]);

const FRIENDLY: Record<string, { icon: string; title: string }> = {
  search_kb: { icon: "🔎", title: "Búsqueda en la base de conocimiento" },
  agent_toolset_20260401: { icon: "🗂️", title: "Memoria y archivos del agente" },
  mover_etapa: { icon: "🔀", title: "Mover de etapa" },
  actualizar_lead: { icon: "✏️", title: "Actualizar datos del lead" },
  actualizar_contacto: { icon: "👤", title: "Actualizar datos del contacto" },
  buscar_producto: { icon: "🔎", title: "Buscar productos y stock" },
  ver_categorias: { icon: "🧭", title: "Ver categorías del catálogo" },
  consultar_pedido: { icon: "📦", title: "Consultar estado de pedidos" },
  crear_link_pago: { icon: "💳", title: "Crear link de pago" },
};

function SystemToolCard({ tool }: { tool: AgentTool }) {
  const meta = FRIENDLY[tool.name];
  const isManaged = CRM_TOOL_NAMES.has(tool.name) || SHOPIFY_TOOL_NAMES.has(tool.name);
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="text-xl leading-none">{meta?.icon ?? "⚙️"}</span>
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-neutral-900">{meta?.title ?? tool.name}</p>
            <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-mono text-neutral-500">
              {tool.name}
            </code>
          </div>
          <p className="text-xs text-neutral-500">{tool.description}</p>
        </div>
      </div>
      <div className="shrink-0">
        {isManaged ? (
          <a
            href="/agent?tab=acciones"
            className="inline-flex items-center rounded-full bg-violet-100 px-2.5 py-1 text-[11px] font-medium text-violet-700 transition-colors hover:bg-violet-200"
          >
            Configurar →
          </a>
        ) : (
          <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
            Siempre activa
          </span>
        )}
      </div>
    </div>
  );
}

function SystemToolsPanel({ tools }: { tools: AgentTool[] }) {
  const crm = tools.filter((t) => CRM_TOOL_NAMES.has(t.name));
  const shopify = tools.filter((t) => SHOPIFY_TOOL_NAMES.has(t.name));
  const builtins = tools.filter(
    (t) => !CRM_TOOL_NAMES.has(t.name) && !SHOPIFY_TOOL_NAMES.has(t.name)
  );

  return (
    <div className="space-y-6">
      <p className="text-sm text-neutral-600">
        Capacidades internas del agente. Vienen con el sistema en todos los proyectos: no se crean
        ni se editan acá — solo se muestran para que sepas qué puede hacer.
      </p>

      {builtins.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Built-in (siempre activas)
          </h3>
          <div className="space-y-2">
            {builtins.map((t) => (
              <SystemToolCard key={t.id} tool={t} />
            ))}
          </div>
        </div>
      )}

      {crm.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Acciones en el CRM
            </h3>
            <a
              href="/agent?tab=acciones"
              className="text-xs font-medium text-violet-700 hover:underline"
            >
              Activar / configurar →
            </a>
          </div>
          <p className="text-xs text-neutral-500">
            El agente puede operar Kommo (mover de etapa, completar datos) cuando una vertical o su
            voz se lo indica. El interruptor de seguridad está en{" "}
            <a href="/agent?tab=acciones" className="font-medium text-violet-700 underline">
              Agente → Acciones
            </a>
            .
          </p>
          <div className="space-y-2">
            {crm.map((t) => (
              <SystemToolCard key={t.id} tool={t} />
            ))}
          </div>
        </div>
      )}

      {shopify.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              Tienda Shopify
            </h3>
            <a
              href="/agent?tab=acciones"
              className="text-xs font-medium text-violet-700 hover:underline"
            >
              Activar / configurar →
            </a>
          </div>
          <p className="text-xs text-neutral-500">
            El agente consulta el catálogo y vende sobre Shopify cuando una vertical o su voz se lo
            indica. Conectá la tienda en{" "}
            <a href="/settings" className="font-medium text-violet-700 underline">
              Configuración
            </a>{" "}
            y activá las capacidades en{" "}
            <a href="/agent?tab=acciones" className="font-medium text-violet-700 underline">
              Agente → Acciones
            </a>
            .
          </p>
          <div className="space-y-2">
            {shopify.map((t) => (
              <SystemToolCard key={t.id} tool={t} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// HTTP tools (operator-defined, editable)
// ---------------------------------------------------------------------------
function HttpToolsPanel({
  tools,
  enabledHttpCount,
}: {
  tools: AgentTool[];
  enabledHttpCount: number;
}) {
  return (
    <div className="space-y-4">
      {enabledHttpCount > 8 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Tienes {enabledHttpCount} tools HTTP activas. Un número elevado puede aumentar el
          contexto del agente y ralentizar las respuestas. Considera deshabilitar las que no uses
          actualmente.
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-neutral-600">
          Herramientas HTTP que creás vos para que el agente consulte APIs externas (stock, precios,
          turnos, etc.). Se sincronizan con Anthropic al guardar.
        </p>
        <NewToolButton />
      </div>

      {tools.length === 0 ? (
        <div className="rounded-xl border border-neutral-200 bg-white p-8 text-center shadow-card">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-neutral-100">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-neutral-400" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
          </div>
          <p className="text-sm font-medium text-neutral-900">Sin herramientas creadas</p>
          <p className="mt-1 text-xs text-neutral-500">
            Usá <span className="font-medium text-neutral-700">+ Nueva tool</span> para conectar una API externa.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="sticky top-0 bg-neutral-50/60 text-left">
                <tr>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Nombre</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Tipo</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Descripción</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Estado</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {tools.map((t) => (
                  <ToolRow key={t.id} tool={t} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export — pestañas: Mis herramientas (HTTP) · Del sistema (internas)
// ---------------------------------------------------------------------------
function TabBtn({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-colors " +
        (active
          ? "bg-white text-neutral-900 shadow-sm"
          : "text-neutral-600 hover:text-neutral-900")
      }
    >
      {children}
      <span
        className={
          "inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold " +
          (active ? "bg-neutral-100 text-neutral-700" : "bg-neutral-200 text-neutral-500")
        }
      >
        {count}
      </span>
    </button>
  );
}

export function ToolEditor({
  tools,
  enabledHttpCount,
}: {
  tools: AgentTool[];
  enabledHttpCount: number;
}) {
  const [tab, setTab] = useState<"mias" | "sistema">("mias");
  const httpTools = tools.filter((t) => t.tool_type === "http");
  const systemTools = tools.filter((t) => t.tool_type === "system");

  return (
    <div className="space-y-6">
      {/* Segmented control tabs */}
      <div className="inline-flex gap-1 rounded-lg bg-neutral-100 p-1">
        <TabBtn active={tab === "mias"} count={httpTools.length} onClick={() => setTab("mias")}>
          Mis herramientas
        </TabBtn>
        <TabBtn
          active={tab === "sistema"}
          count={systemTools.length}
          onClick={() => setTab("sistema")}
        >
          Del sistema
        </TabBtn>
      </div>

      {tab === "mias" ? (
        <HttpToolsPanel tools={httpTools} enabledHttpCount={enabledHttpCount} />
      ) : (
        <SystemToolsPanel tools={systemTools} />
      )}
    </div>
  );
}
