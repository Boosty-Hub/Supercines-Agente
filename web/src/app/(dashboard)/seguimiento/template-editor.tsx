"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Modal, Button, ConfirmDialog, EmptyState } from "@/components/ui";

// Campo VIVO de Kommo (entidad leads). Ya no mantenemos una tabla de mapeo:
// las variables apuntan directo al id del campo en Kommo.
type KommoField = { id: number; name: string; type: string };

type Variable = {
  name: string;
  description: string;
  // id del campo custom de Kommo que esta variable rellena (directo, sin indirección).
  kommo_field_id: number | null;
  // nombre del campo para mostrar (y para que el agente sepa qué está completando).
  kommo_field_name: string | null;
};

type Template = {
  id: string;
  name: string;
  description: string | null;
  body: string;
  variables: Variable[];
  salesbot_id: number | null;
  enabled: boolean;
};

type CreateFieldResult = { field?: KommoField; error?: string };

const TYPE_LABEL: Record<string, string> = {
  text: "texto",
  textarea: "texto largo",
  numeric: "número",
  checkbox: "casilla (sí/no)",
  select: "lista",
  multiselect: "lista múltiple",
  date: "fecha",
  date_time: "fecha/hora",
  url: "url",
  radiobutton: "opción",
  multitext: "multi (tel/email)",
  birthday: "cumpleaños",
};

// Tipos que tiene sentido crear al vuelo para una variable de seguimiento.
const CREATABLE_TYPES: Array<{ value: string; label: string }> = [
  { value: "text", label: "Texto" },
  { value: "textarea", label: "Texto largo" },
  { value: "numeric", label: "Número" },
  { value: "date", label: "Fecha" },
  { value: "url", label: "URL" },
];

// Normaliza un nombre para matchear variables ↔ campos sin acentos/espacios/símbolos.
function normalize(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

// Busca el campo de Kommo que mejor matchea el nombre de una variable (auto-match).
function matchField(name: string, fields: KommoField[]): KommoField | null {
  const n = normalize(name);
  if (!n) return null;
  return (
    fields.find((f) => normalize(f.name) === n) ||
    fields.find((f) => {
      const fn = normalize(f.name);
      return fn.length >= 3 && (fn.includes(n) || n.includes(fn));
    }) ||
    null
  );
}

// Coacciona variables crudas de la DB (jsonb) al shape nuevo, tolerando datos viejos.
function coerceVariables(raw: unknown): Variable[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => {
    const o = (v ?? {}) as Record<string, unknown>;
    return {
      name: typeof o.name === "string" ? o.name : "",
      description: typeof o.description === "string" ? o.description : "",
      kommo_field_id: typeof o.kommo_field_id === "number" ? o.kommo_field_id : null,
      kommo_field_name: typeof o.kommo_field_name === "string" ? o.kommo_field_name : null,
    };
  });
}

// Modal is imported from @/components/ui

// Picker del campo de Kommo POR NOMBRE (campos vivos) con creación INLINE: si el
// campo no existe, lo creás acá mismo (nombre + tipo) y queda matcheado al instante.
function FieldPicker({
  value,
  valueName,
  fields,
  configured,
  defaultName,
  onChange,
  onCreateField,
}: {
  value: number | null;
  valueName: string | null;
  fields: KommoField[];
  configured: boolean;
  defaultName: string;
  onChange: (field: { id: number; name: string } | null) => void;
  onCreateField: (name: string, type: string) => Promise<CreateFieldResult>;
}) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("text");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function openCreate() {
    // El nombre del campo arranca con el de la variable (la IA ya lo sugiere).
    setNewName((defaultName || "").trim());
    setNewType("text");
    setErr(null);
    setCreating(true);
  }

  async function create() {
    const name = newName.trim();
    if (!name) return setErr("Poné un nombre para el campo.");
    setBusy(true);
    setErr(null);
    const { field, error } = await onCreateField(name, newType);
    setBusy(false);
    if (!field) return setErr(error ?? "No se pudo crear el campo.");
    onChange({ id: field.id, name: field.name });
    setCreating(false);
  }

  if (!configured) {
    return (
      <p className="w-56 text-[11px] text-neutral-500">
        Conectá Kommo en el{" "}
        <a href="/setup" className="font-medium text-neutral-700 underline">
          setup
        </a>{" "}
        para asignar campos.
      </p>
    );
  }

  if (creating) {
    return (
      <div className="w-60 space-y-1.5 rounded-lg border border-violet-200 bg-violet-50 p-2">
        <p className="text-[11px] font-medium text-neutral-600">Nuevo campo en Kommo</p>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Nombre del campo"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              create();
            }
          }}
          className="w-full rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
        />
        <select
          value={newType}
          onChange={(e) => setNewType(e.target.value)}
          className="w-full rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
        >
          {CREATABLE_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        {err && <p className="text-[11px] text-red-600">{err}</p>}
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={create}
            disabled={busy}
            className="rounded bg-neutral-900 px-2 py-1 text-[11px] font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            {busy ? "Creando…" : "Crear y usar"}
          </button>
          <button
            type="button"
            onClick={() => {
              setCreating(false);
              setErr(null);
            }}
            className="rounded px-2 py-1 text-[11px] text-neutral-500 hover:text-neutral-800"
          >
            cancelar
          </button>
        </div>
      </div>
    );
  }

  const known = value != null && fields.some((f) => f.id === value);

  return (
    <div className="flex items-center gap-1.5">
      <select
        value={value ?? ""}
        onChange={(e) => {
          const id = Number(e.target.value);
          const f = fields.find((x) => x.id === id);
          onChange(f ? { id: f.id, name: f.name } : null);
        }}
        className="w-44 rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
      >
        <option value="">— campo de Kommo —</option>
        {!known && value != null && (
          <option value={value}>{valueName ?? `#${value}`} (no encontrado)</option>
        )}
        {fields.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
            {TYPE_LABEL[f.type] ? ` · ${TYPE_LABEL[f.type]}` : ""}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={openCreate}
        title="Crear un campo nuevo en Kommo"
        className="rounded border border-neutral-300 px-2 py-1 text-[11px] font-medium text-neutral-600 hover:bg-neutral-100"
      >
        + nuevo
      </button>
    </div>
  );
}

// Editor de variables inline
function VariablesBuilder({
  variables,
  fields,
  configured,
  onChange,
  onCreateField,
}: {
  variables: Variable[];
  fields: KommoField[];
  configured: boolean;
  onChange: (vars: Variable[]) => void;
  onCreateField: (name: string, type: string) => Promise<CreateFieldResult>;
}) {
  function addVariable() {
    onChange([...variables, { name: "", description: "", kommo_field_id: null, kommo_field_name: null }]);
  }

  function removeVariable(i: number) {
    onChange(variables.filter((_, idx) => idx !== i));
  }

  function updateVariable(i: number, patch: Partial<Variable>) {
    onChange(variables.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-neutral-600">Variables</label>
        <button
          type="button"
          onClick={addVariable}
          className="text-xs font-medium text-neutral-500 hover:text-neutral-900"
        >
          + Agregar
        </button>
      </div>
      {variables.length === 0 && (
        <p className="text-xs text-neutral-400">Sin variables — la plantilla no tiene placeholders.</p>
      )}
      {variables.map((v, i) => {
        const unmapped = v.kommo_field_id == null;
        return (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3 sm:flex-row sm:items-start"
          >
            <div className="flex-1 space-y-1.5">
              <input
                value={v.name}
                onChange={(e) => updateVariable(i, { name: e.target.value })}
                placeholder="nombre_variable"
                className="w-full rounded border border-neutral-300 px-2 py-1 text-xs font-mono focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
              />
              <input
                value={v.description}
                onChange={(e) => updateVariable(i, { description: e.target.value })}
                placeholder="Descripción para el agente"
                className="w-full rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
              />
            </div>
            <div className="flex flex-col items-end gap-1">
              <div className="flex items-start gap-2">
                <FieldPicker
                  value={v.kommo_field_id}
                  valueName={v.kommo_field_name}
                  fields={fields}
                  configured={configured}
                  defaultName={v.name}
                  onChange={(f) =>
                    updateVariable(i, {
                      kommo_field_id: f?.id ?? null,
                      kommo_field_name: f?.name ?? null,
                    })
                  }
                  onCreateField={onCreateField}
                />
                <button
                  type="button"
                  onClick={() => removeVariable(i)}
                  aria-label="Eliminar variable"
                  className="pt-1 text-neutral-400 hover:text-red-500"
                >
                  ✕
                </button>
              </div>
              {configured && unmapped && (
                <span className="text-[10px] text-amber-600">sin campo asignado</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Formulario de edición de plantilla
function TemplateForm({
  template,
  fields,
  configured,
  onDone,
  onCreateField,
}: {
  template: Template;
  fields: KommoField[];
  configured: boolean;
  onDone: () => void;
  onCreateField: (name: string, type: string) => Promise<CreateFieldResult>;
}) {
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description ?? "");
  const [body, setBody] = useState(template.body);
  const [variables, setVariables] = useState<Variable[]>(coerceVariables(template.variables));
  const [salsbotId, setSalsbotId] = useState(template.salesbot_id ? String(template.salesbot_id) : "");
  const [enabled, setEnabled] = useState(template.enabled);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/follow-up/templates/${template.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        description: description.trim() || null,
        body,
        variables,
        salesbot_id: salsbotId ? Number(salsbotId) : null,
        enabled,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError((j as { error?: string }).error ?? "Error al guardar");
      return;
    }
    onDone();
  }

  async function remove() {
    setDeleting(true);
    await fetch(`/api/follow-up/templates/${template.id}`, { method: "DELETE" });
    setDeleting(false);
    setConfirmingDelete(false);
    onDone();
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-neutral-600">Nombre (único)</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-neutral-600">ID del Salesbot de Kommo</label>
          <input
            type="number"
            value={salsbotId}
            onChange={(e) => setSalsbotId(e.target.value)}
            placeholder="ID del salesbot"
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-neutral-600">Descripción (cuándo usar esta plantilla)</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-neutral-600">
          Cuerpo de la plantilla (usa {`{{nombre_variable}}`} para placeholders)
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm font-mono focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
        />
      </div>
      <VariablesBuilder
        variables={variables}
        fields={fields}
        configured={configured}
        onChange={setVariables}
        onCreateField={onCreateField}
      />
      <label className="flex items-center gap-2 text-sm text-neutral-700">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="rounded border-neutral-300 text-neutral-900 focus:ring-neutral-900"
        />
        Habilitada
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" busy={busy}>
          {busy ? "Guardando…" : "Guardar"}
        </Button>
        <Button type="button" variant="danger" onClick={() => setConfirmingDelete(true)}>
          Borrar
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancelar
        </Button>
      </div>
      <ConfirmDialog
        open={confirmingDelete}
        title="Borrar plantilla"
        description={`Se eliminará la plantilla "${template.name}" permanentemente. Esta acción no se puede deshacer.`}
        confirmLabel="Borrar"
        tone="danger"
        busy={deleting}
        onConfirm={remove}
        onCancel={() => setConfirmingDelete(false)}
      />
    </form>
  );
}

function TemplateRow({
  template,
  fields,
  configured,
  onCreateField,
}: {
  template: Template;
  fields: KommoField[];
  configured: boolean;
  onCreateField: (name: string, type: string) => Promise<CreateFieldResult>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const vars = coerceVariables(template.variables);
  const unmapped = vars.filter((v) => v.kommo_field_id == null).length;

  return (
    <>
      <tr
        className="cursor-pointer transition-colors hover:bg-neutral-50"
        onClick={() => setOpen(true)}
      >
        <td className="px-4 py-3 font-medium text-neutral-900">{template.name}</td>
        <td className="px-4 py-3 text-sm text-neutral-600 max-w-xs truncate">
          {template.description ?? "—"}
        </td>
        <td className="px-4 py-3">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
              unmapped > 0 ? "bg-amber-100 text-amber-800" : "bg-neutral-100 text-neutral-700"
            }`}
            title={unmapped > 0 ? `${unmapped} variable(s) sin campo asignado` : "Todas las variables asignadas"}
          >
            {vars.length} vars{unmapped > 0 ? ` · ${unmapped} sin campo` : ""}
          </span>
        </td>
        <td className="px-4 py-3">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
              template.salesbot_id
                ? "bg-emerald-100 text-emerald-700"
                : "bg-amber-100 text-amber-800"
            }`}
          >
            {template.salesbot_id ? `bot:${template.salesbot_id}` : "sin bot"}
          </span>
        </td>
        <td className="px-4 py-3">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
              template.enabled
                ? "bg-emerald-100 text-emerald-700"
                : "bg-neutral-100 text-neutral-600"
            }`}
          >
            {template.enabled ? "ON" : "OFF"}
          </span>
        </td>
        <td className="px-4 py-3 text-right">
          <span className="text-xs font-medium text-neutral-500">Ver / Editar →</span>
        </td>
      </tr>
      {open && (
        <Modal open={open} title={`Editar: ${template.name}`} onClose={() => setOpen(false)}>
          <TemplateForm
            template={template}
            fields={fields}
            configured={configured}
            onCreateField={onCreateField}
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

// Formulario de nueva plantilla con AI assist
function NewTemplateForm({
  fields,
  configured,
  onDone,
  onCreateField,
}: {
  fields: KommoField[];
  configured: boolean;
  onDone: () => void;
  onCreateField: (name: string, type: string) => Promise<CreateFieldResult>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [variables, setVariables] = useState<Variable[]>([]);
  const [salsbotId, setSalsbotId] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Secuencia: agregar esta plantilla como un paso (la IA sugiere la demora).
  const [addToSequence, setAddToSequence] = useState(true);
  const [delayHours, setDelayHours] = useState("24");

  // AI assist
  const [aiPrompt, setAiPrompt] = useState("");
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [autoMatched, setAutoMatched] = useState(0);

  async function generate() {
    if (!aiPrompt.trim()) {
      setGenError("Describí qué plantilla querés crear.");
      return;
    }
    setGenBusy(true);
    setGenError(null);
    setAutoMatched(0);
    try {
      const res = await fetch("/api/follow-up/templates/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Le pasamos los nombres de los campos vivos de Kommo para que la IA
        // reuse los que ya existen al nombrar las variables (mejor auto-match).
        body: JSON.stringify({ instruction: aiPrompt, fields: fields.map((f) => f.name) }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
      const t = j.template as {
        name?: string;
        description?: string;
        body?: string;
        variables?: Array<{ name: string; description: string }>;
        delay_hours?: number;
      };
      setName(t.name ?? "");
      setDescription(t.description ?? "");
      setBody(t.body ?? "");
      // La IA genera las variables con name+description; las matcheamos automáticamente
      // contra los campos vivos de Kommo. Lo que no matchea queda para asignar/crear.
      let matched = 0;
      setVariables(
        (t.variables ?? []).map((v) => {
          const m = matchField(v.name, fields);
          if (m) matched++;
          return {
            name: v.name,
            description: v.description,
            kommo_field_id: m?.id ?? null,
            kommo_field_name: m?.name ?? null,
          };
        })
      );
      setAutoMatched(matched);
      // La IA también sugiere la demora del paso de la secuencia.
      if (typeof t.delay_hours === "number" && t.delay_hours > 0) {
        setDelayHours(String(t.delay_hours));
        setAddToSequence(true);
      }
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenBusy(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/follow-up/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        description: description.trim() || null,
        body,
        variables,
        salesbot_id: salsbotId ? Number(salsbotId) : null,
        enabled,
        // Si está tildado, el backend agrega esta plantilla como un paso nuevo
        // de la secuencia con esta demora (pocos clicks: crear plantilla = crear paso).
        ...(addToSequence && Number(delayHours) > 0 ? { delay_hours: Number(delayHours) } : {}),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError((j as { error?: string }).error ?? "Error al crear");
      return;
    }
    onDone();
  }

  return (
    <form onSubmit={save} className="space-y-4">
      {/* AI assist block — violet, mirrors verticales */}
      <div className="space-y-2 rounded-xl border border-violet-200 bg-violet-50 p-4">
        <p className="text-xs font-medium text-neutral-700">✨ Crear con IA</p>
        <p className="text-xs text-neutral-500">
          Describí qué plantilla de seguimiento querés y la IA completa el cuerpo, las
          variables, el nombre y la demora del paso. Las variables se{" "}
          <span className="font-medium text-neutral-700">matchean solas</span> con tus campos de
          Kommo; lo que falte lo asignás o lo creás al vuelo abajo.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                generate();
              }
            }}
            placeholder="Ej: recordatorio amigable 24h después para leads que consultaron precios"
            className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          />
          <button
            type="button"
            onClick={generate}
            disabled={genBusy}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
          >
            {genBusy ? "Generando…" : "Generar"}
          </button>
        </div>
        {genError && <p className="text-xs text-red-600">{genError}</p>}
        {autoMatched > 0 && (
          <p className="text-xs text-emerald-700">
            ✓ {autoMatched} variable(s) matcheada(s) automáticamente con campos de Kommo.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-neutral-600">Nombre (único)</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="seguimiento_consulta_precio"
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-neutral-600">ID del Salesbot de Kommo</label>
          <input
            type="number"
            value={salsbotId}
            onChange={(e) => setSalsbotId(e.target.value)}
            placeholder="ID del salesbot"
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-neutral-600">Descripción (cuándo usar)</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-neutral-600">
          Cuerpo (usa {`{{nombre_variable}}`} para los placeholders)
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm font-mono focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
        />
      </div>
      <VariablesBuilder
        variables={variables}
        fields={fields}
        configured={configured}
        onChange={setVariables}
        onCreateField={onCreateField}
      />
      {/* Secuencia: la plantilla se agrega como un paso (la IA sugiere la demora) */}
      <div className="space-y-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
        <label className="flex items-center gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            checked={addToSequence}
            onChange={(e) => setAddToSequence(e.target.checked)}
            className="rounded border-neutral-300 text-neutral-900 focus:ring-neutral-900"
          />
          Agregar a la secuencia de seguimiento
        </label>
        {addToSequence && (
          <div className="flex flex-wrap items-center gap-2 pl-6">
            <span className="text-xs text-neutral-500">Enviar tras</span>
            <input
              type="number"
              min={1}
              value={delayHours}
              onChange={(e) => setDelayHours(e.target.value)}
              className="w-20 rounded border border-neutral-300 px-2 py-1 text-xs focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
            />
            <span className="text-xs text-neutral-500">
              horas de inactividad — se agrega como paso nuevo al final de la secuencia.
            </span>
          </div>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm text-neutral-700">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="rounded border-neutral-300 text-neutral-900 focus:ring-neutral-900"
        />
        Habilitada
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" busy={busy}>
          {busy ? "Creando…" : "Crear plantilla"}
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

export function TemplateEditor({ templates }: { templates: Template[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  // Campos VIVOS de Kommo (entidad leads). Se cargan una vez; los creados al vuelo
  // se agregan al estado local para que aparezcan en todos los pickers al instante.
  const [fields, setFields] = useState<KommoField[]>([]);
  const [configured, setConfigured] = useState(true);
  const [fieldsError, setFieldsError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/kommo/fields");
        const j = await res.json();
        if (!alive) return;
        if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
        setConfigured(j.configured);
        setFields(
          ((j.leads ?? []) as Array<{ id: number; name: string; type: string }>).map((f) => ({
            id: f.id,
            name: f.name,
            type: f.type,
          }))
        );
      } catch (e) {
        if (alive) setFieldsError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function createField(name: string, type: string): Promise<CreateFieldResult> {
    try {
      const res = await fetch("/api/kommo/fields", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity: "leads", name, type }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) return { error: (j as { error?: string }).error ?? `HTTP ${res.status}` };
      const field = j.field as KommoField;
      setFields((prev) =>
        prev.some((f) => f.id === field.id)
          ? prev
          : [...prev, { id: field.id, name: field.name, type: field.type }]
      );
      return { field };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white shadow-sm p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <h2 className="text-base font-semibold tracking-tight text-neutral-900">
            Plantillas de WhatsApp
          </h2>
          <p className="text-xs text-neutral-500">
            Cada variable se asigna directo a un campo de Kommo (lo elegís por nombre o lo creás
            acá mismo). Para enviarse, la plantilla necesita su salesbot_id y todas sus variables
            con un campo asignado.
          </p>
        </div>
        {!creating && (
          <Button type="button" variant="secondary" onClick={() => setCreating(true)}>
            + Nueva
          </Button>
        )}
      </div>

      {fieldsError && (
        <p className="text-xs text-amber-700">
          No se pudieron traer los campos de Kommo: {fieldsError}. Podés escribir la plantilla y
          asignar los campos más tarde.
        </p>
      )}

      {creating && (
        <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
          <NewTemplateForm
            fields={fields}
            configured={configured}
            onCreateField={createField}
            onDone={() => {
              setCreating(false);
              router.refresh();
            }}
          />
        </div>
      )}

      {templates.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="sticky top-0 bg-neutral-50/60 text-left">
                <tr>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Nombre</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Descripción</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Variables</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Salesbot</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Estado</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400 text-right"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {templates.map((t) => (
                  <TemplateRow
                    key={t.id}
                    template={t}
                    fields={fields}
                    configured={configured}
                    onCreateField={createField}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {templates.length === 0 && !creating && (
        <EmptyState
          title="Sin plantillas"
          description="Creá una plantilla para empezar la secuencia de seguimiento."
        />
      )}
    </div>
  );
}
