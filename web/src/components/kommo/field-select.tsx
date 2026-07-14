"use client";

// Selector de custom field de Kommo: lista los campos reales de la cuenta
// (vía /api/kommo/fields) para elegir por NOMBRE en vez de tipear un ID a mano.
// Compartido por la sección Kommo, los comentarios de IG y (a futuro) cualquier
// picker de campos. Si la API falla, degrada al input numérico de siempre para
// no bloquear la configuración.

import { useEffect, useState } from "react";
import { inputCls, selectCls } from "@/components/ui";

type FieldLite = { id: number; name: string };

export function KommoFieldSelect({
  name,
  defaultValue,
}: {
  name: string;
  defaultValue: number | null;
}) {
  const [fields, setFields] = useState<FieldLite[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/kommo/fields");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as { ok: boolean; leads?: FieldLite[] };
        if (!j.ok || !Array.isArray(j.leads)) throw new Error("respuesta inválida");
        if (!cancelled) setFields(j.leads);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Sin lista (API caída o sin credenciales): input numérico clásico.
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

  if (fields === null) {
    return (
      // key distinta a la del select definitivo: si React los reconcilia como
      // el mismo nodo, el defaultValue del definitivo nunca aplica (los
      // uncontrolled conservan el valor del primer montaje).
      <select key="loading" className={selectCls} disabled>
        <option>Cargando campos de Kommo…</option>
      </select>
    );
  }

  // El valor guardado puede ser un campo que ya no existe: lo mostramos igual
  // para no "perderlo" silenciosamente al guardar otra cosa.
  const known = fields.some((f) => f.id === defaultValue);

  return (
    <select key="ready" name={name} defaultValue={defaultValue ?? ""} className={selectCls}>
      <option value="">— Sin configurar —</option>
      {defaultValue != null && !known && (
        <option value={defaultValue}>Campo #{defaultValue} (ya no existe en Kommo)</option>
      )}
      {fields.map((f) => (
        <option key={f.id} value={f.id}>
          {f.name}
        </option>
      ))}
    </select>
  );
}
