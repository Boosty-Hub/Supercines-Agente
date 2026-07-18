"use client";

// Selector de custom field de Kommo — implementación única, dos modos.
//
// Antes esto eran dos componentes distintos con la misma lógica:
//   · components/kommo/field-select.tsx  → modo form (name/defaultValue)
//   · components/kommo-field-picker.tsx  → modo controlado (value/onChange)
// Ambos hacían su propio fetch a /api/kommo/fields y ambos repetían el truco de
// "si el valor guardado ya no existe en Kommo, mostralo igual para no perderlo".
// Ahora comparten `useKommoFields` (un solo fetch por página) y este archivo.

import { inputCls, selectCls } from "@/components/ui";
import { useKommoFields, KOMMO_TYPE_LABEL, type KommoFieldLite } from "./use-kommo-fields";

export type { KommoFieldLite };

type CommonProps = {
  /** Qué entidad listar. `both` concatena leads + contactos. */
  entity?: "leads" | "contacts" | "both";
  /** Si se pasa, solo muestra campos de estos tipos (ej. ['checkbox']). */
  typeFilter?: string[];
  className?: string;
};

/**
 * Modo FORM: se envía dentro de un `<form action=...>` por su `name`.
 * Si la API falla, degrada a un input numérico para no bloquear la config.
 */
export function KommoFieldSelect({
  name,
  defaultValue,
  entity = "leads",
  typeFilter,
  className,
}: CommonProps & { name: string; defaultValue: number | null }) {
  const { loading, failed, fields } = useFields(entity, typeFilter);

  if (failed) {
    return (
      <input
        type="number"
        name={name}
        defaultValue={defaultValue ?? ""}
        placeholder="123456"
        className={inputCls + " font-mono"}
      />
    );
  }

  if (loading) {
    // key distinta a la del select definitivo: si React los reconcilia como el
    // mismo nodo, el defaultValue del definitivo nunca aplica (los uncontrolled
    // conservan el valor del primer montaje).
    return (
      <select key="loading" className={selectCls} disabled>
        <option>Cargando campos de Kommo…</option>
      </select>
    );
  }

  const known = fields.some((f) => f.id === defaultValue);

  return (
    <select
      key="ready"
      name={name}
      defaultValue={defaultValue ?? ""}
      className={className ?? selectCls}
    >
      <option value="">— Sin configurar —</option>
      {defaultValue != null && !known && (
        <option value={defaultValue}>Campo #{defaultValue} (ya no existe en Kommo)</option>
      )}
      {fields.map((f) => (
        <option key={`${f.entity}-${f.id}`} value={f.id}>
          {optionLabel(f, entity)}
        </option>
      ))}
    </select>
  );
}

/**
 * Modo CONTROLADO: devuelve el campo completo (id + nombre + tipo) por onChange,
 * para guardarlo con su etiqueta legible.
 */
export function KommoFieldPicker({
  value,
  onChange,
  entity = "leads",
  typeFilter,
  allowNone = false,
  noneLabel = "— Ninguno —",
  className,
}: CommonProps & {
  value: number | null;
  onChange: (field: KommoFieldLite | null) => void;
  allowNone?: boolean;
  noneLabel?: string;
}) {
  const { loading, failed, configured, fields } = useFields(entity, typeFilter);

  if (loading) {
    return <div className={`${selectCls} text-neutral-400 ${className ?? ""}`}>Cargando campos…</div>;
  }
  if (failed) {
    return <p className="text-sm text-red-600">No se pudieron traer los campos de Kommo.</p>;
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

  const known = fields.some((f) => f.id === value);

  return (
    <select
      value={value ?? ""}
      onChange={(e) => {
        const id = Number(e.target.value);
        onChange(fields.find((x) => x.id === id) ?? null);
      }}
      className={`${selectCls} ${className ?? ""}`}
    >
      {allowNone && <option value="">{noneLabel}</option>}
      {!allowNone && value == null && <option value="">— Elegí un campo —</option>}
      {!known && value != null && <option value={value}>#{value} (campo no encontrado)</option>}
      {fields.map((f) => (
        <option key={`${f.entity}-${f.id}`} value={f.id}>
          {optionLabel(f, entity)}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------

function useFields(entity: "leads" | "contacts" | "both", typeFilter?: string[]) {
  const state = useKommoFields();
  let fields =
    entity === "leads"
      ? state.leads
      : entity === "contacts"
        ? state.contacts
        : [...state.leads, ...state.contacts];
  if (typeFilter && typeFilter.length > 0) {
    fields = fields.filter((f) => typeFilter.includes(f.type));
  }
  return { ...state, fields };
}

function optionLabel(f: KommoFieldLite, entity: "leads" | "contacts" | "both"): string {
  const type = KOMMO_TYPE_LABEL[f.type] ? ` · ${KOMMO_TYPE_LABEL[f.type]}` : "";
  const which = entity === "both" ? ` · ${f.entity === "leads" ? "lead" : "contacto"}` : "";
  return `${f.name}${type}${which}`;
}
