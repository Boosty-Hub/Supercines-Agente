"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { type Situacion } from "./situacion-utils";

type SituacionFormModalProps = {
  open: boolean;
  initial: Situacion | null;
  onClose: () => void;
  onSaved: () => void;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default function SituacionFormModal({ open, initial, onClose, onSaved }: SituacionFormModalProps) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [content, setContent] = useState(initial?.content ?? "");
  const [startsAt, setStartsAt] = useState(initial?.starts_at ?? "");
  const [endsAt, setEndsAt] = useState(initial?.ends_at ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmedTitle = title.trim();
    if (!trimmedTitle) { setError("El título es requerido"); return; }
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
        title: trimmedTitle,
        content: trimmedContent,
        starts_at: sa,
        ends_at: ea,
        enabled,
      };

      const url = initial ? `/api/situations/${initial.id}` : "/api/situations";
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
      title={initial ? "Editar situación" : "Nueva situación"}
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

        <div className="space-y-1">
          <label className="text-xs font-medium text-neutral-700" htmlFor="sit-title">
            Título <span className="text-red-500">*</span>
          </label>
          <input
            id="sit-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ej: Feriado nacional, Corte de luz en la zona…"
            className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400"
            required
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-neutral-700" htmlFor="sit-content">
            Contexto que el agente debe tener en cuenta <span className="text-red-500">*</span>
          </label>
          <textarea
            id="sit-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={3}
            placeholder="Ej: Hoy es feriado, la atención se retoma mañana. No prometas envíos hoy."
            className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400 resize-y"
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-neutral-700" htmlFor="sit-starts">
              Desde (opcional)
            </label>
            <input
              id="sit-starts"
              type="date"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-neutral-700" htmlFor="sit-ends">
              Hasta (opcional, inclusivo)
            </label>
            <input
              id="sit-ends"
              type="date"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-400"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Switch checked={enabled} onChange={setEnabled} tone="emerald" aria-label="Activar situación" />
          <span className="text-sm text-neutral-700">{enabled ? "Activa" : "Desactivada"}</span>
        </div>
      </form>
    </Modal>
  );
}
