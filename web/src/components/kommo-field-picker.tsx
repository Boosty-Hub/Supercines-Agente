"use client";

import { useEffect, useState } from "react";

export type KommoFieldLite = {
  id: number;
  name: string;
  type: string;
  entity: "leads" | "contacts";
};

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

/**
 * Selector de campos de Kommo POR NOMBRE (en vez de pegar el id numérico).
 * Trae los campos de /api/kommo/fields y deja elegir uno. Devuelve id + nombre.
 */
export function KommoFieldPicker({
  entity = "leads",
  value,
  onChange,
  allowNone = false,
  noneLabel = "— Ninguno —",
  typeFilter,
  className,
}: {
  entity?: "leads" | "contacts" | "both";
  value: number | null;
  onChange: (field: KommoFieldLite | null) => void;
  allowNone?: boolean;
  noneLabel?: string;
  /** Si se pasa, solo muestra campos de estos tipos (ej: ['checkbox']). */
  typeFilter?: string[];
  className?: string;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const [fields, setFields] = useState<KommoFieldLite[]>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/kommo/fields");
        const j = await res.json();
        if (!alive) return;
        if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
        setConfigured(j.configured);
        const leads = (j.leads ?? []) as KommoFieldLite[];
        const contacts = (j.contacts ?? []) as KommoFieldLite[];
        let merged =
          entity === "leads" ? leads : entity === "contacts" ? contacts : [...leads, ...contacts];
        if (typeFilter && typeFilter.length > 0)
          merged = merged.filter((f) => typeFilter.includes(f.type));
        setFields(merged);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity, (typeFilter ?? []).join(",")]);

  const base =
    "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none";

  if (loading) {
    return <div className={`${base} text-neutral-400 ${className ?? ""}`}>Cargando campos…</div>;
  }
  if (error) {
    return <p className="text-sm text-red-600">No se pudieron traer los campos: {error}</p>;
  }
  if (!configured) {
    return (
      <p className="text-sm text-neutral-500">
        Conectá Kommo en el{" "}
        <a href="/setup" className="font-medium text-neutral-700 underline">
          setup
        </a>{" "}
        para elegir campos por nombre.
      </p>
    );
  }

  // Si el value guardado no está en la lista (campo viejo/borrado), lo mostramos igual.
  const known = fields.some((f) => f.id === value);

  return (
    <select
      value={value ?? ""}
      onChange={(e) => {
        const id = Number(e.target.value);
        const f = fields.find((x) => x.id === id) ?? null;
        onChange(f);
      }}
      className={`${base} ${className ?? ""}`}
    >
      {allowNone && <option value="">{noneLabel}</option>}
      {!allowNone && value == null && <option value="">— Elegí un campo —</option>}
      {!known && value != null && <option value={value}>#{value} (campo no encontrado)</option>}
      {fields.map((f) => (
        <option key={`${f.entity}-${f.id}`} value={f.id}>
          {f.name}
          {TYPE_LABEL[f.type] ? ` · ${TYPE_LABEL[f.type]}` : ""}
          {entity === "both" ? ` · ${f.entity === "leads" ? "lead" : "contacto"}` : ""}
        </option>
      ))}
    </select>
  );
}
