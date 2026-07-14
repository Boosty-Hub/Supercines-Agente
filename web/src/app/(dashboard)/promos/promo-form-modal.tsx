"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { type Promo } from "./promo-utils";

type PromoFormModalProps = {
  open: boolean;
  initial: Promo | null;
  onClose: () => void;
  onSaved: () => void;
};

const DOW_LABELS = [
  { isodow: 1, label: "Lun" },
  { isodow: 2, label: "Mar" },
  { isodow: 3, label: "Mié" },
  { isodow: 4, label: "Jue" },
  { isodow: 5, label: "Vie" },
  { isodow: 6, label: "Sáb" },
  { isodow: 7, label: "Dom" },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default function PromoFormModal({ open, initial, onClose, onSaved }: PromoFormModalProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [content, setContent] = useState(initial?.content ?? "");
  const [kind, setKind] = useState<"promo" | "evento">(initial?.kind ?? "promo");
  const [startsAt, setStartsAt] = useState(initial?.starts_at ?? "");
  const [endsAt, setEndsAt] = useState(initial?.ends_at ?? "");
  const [weekdays, setWeekdays] = useState<number[]>(initial?.weekdays ?? []);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset state when modal opens with new initial value
  // (simple approach — reset when component mounts with `initial` prop change)

  function toggleWeekday(dow: number) {
    setWeekdays((prev) =>
      prev.includes(dow) ? prev.filter((d) => d !== dow) : [...prev, dow].sort((a, b) => a - b)
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Validaciones frontend
    const trimmedName = name.trim();
    if (!trimmedName) { setError("El nombre es requerido"); return; }
    const trimmedContent = content.trim();
    if (!trimmedContent) { setError("El contenido es requerido"); return; }

    const sa = startsAt || null;
    const ea = endsAt || null;
    if (sa && !DATE_RE.test(sa)) { setError("Formato de fecha inválido para 'Desde' (YYYY-MM-DD)"); return; }
    if (ea && !DATE_RE.test(ea)) { setError("Formato de fecha inválido para 'Hasta' (YYYY-MM-DD)"); return; }
    if (sa && ea && sa > ea) { setError("La fecha de inicio no puede ser posterior a la fecha de fin"); return; }

    setBusy(true);
    try {
      const body = {
        name: trimmedName,
        content: trimmedContent,
        kind,
        starts_at: sa,
        ends_at: ea,
        weekdays: weekdays.length > 0 ? weekdays : null,
        enabled,
      };

      const url = initial ? `/api/promotions/${initial.id}` : "/api/promotions";
      const method = initial ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Error al guardar");
        return;
      }
      onSaved();
      onClose();
    } catch {
      setError("Error de red al guardar");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={initial ? "Editar promo o evento" : "Nueva promo o evento"}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" busy={busy} onClick={handleSubmit}>
            Guardar
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 border border-red-200">
            {error}
          </p>
        )}

        {/* Nombre */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-neutral-700" htmlFor="promo-name">
            Nombre <span className="text-red-500">*</span>
          </label>
          <input
            id="promo-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ej: Los Remartes, Estreno de verano…"
            className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400"
            required
          />
        </div>

        {/* Tipo */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-neutral-700">Tipo</label>
          <div className="flex gap-2">
            {(["promo", "evento"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={[
                  "px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors",
                  kind === k
                    ? "border-neutral-900 bg-neutral-900 text-white"
                    : "border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50",
                ].join(" ")}
              >
                {k === "promo" ? "Promo" : "Evento"}
              </button>
            ))}
          </div>
        </div>

        {/* Contenido */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-neutral-700" htmlFor="promo-content">
            Texto para el agente <span className="text-red-500">*</span>
          </label>
          <textarea
            id="promo-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={3}
            placeholder="Lo que el agente debe saber y mencionar sobre esta promo…"
            className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 resize-y"
            required
          />
        </div>

        {/* Rango de fechas */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-neutral-700" htmlFor="promo-starts">
              Desde (opcional)
            </label>
            <input
              id="promo-starts"
              type="date"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-neutral-700" htmlFor="promo-ends">
              Hasta (opcional, inclusivo)
            </label>
            <input
              id="promo-ends"
              type="date"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400"
            />
          </div>
        </div>

        {/* Días de la semana */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-neutral-700">
            Días de la semana (opcional)
          </label>
          <div className="flex flex-wrap gap-1.5">
            {DOW_LABELS.map(({ isodow, label }) => (
              <button
                key={isodow}
                type="button"
                onClick={() => toggleWeekday(isodow)}
                className={[
                  "px-2.5 py-1 text-xs font-medium rounded-md border transition-colors",
                  weekdays.includes(isodow)
                    ? "border-neutral-900 bg-neutral-900 text-white"
                    : "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50",
                ].join(" ")}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Enabled */}
        <div className="flex items-center gap-3">
          <Switch
            checked={enabled}
            onChange={setEnabled}
            tone="emerald"
            aria-label="Activar promo"
          />
          <span className="text-sm text-neutral-700">{enabled ? "Activa" : "Desactivada"}</span>
        </div>
      </form>
    </Modal>
  );
}
