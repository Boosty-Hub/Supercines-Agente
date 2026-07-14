"use client";

// Reusable assistant that proposes domain-specific verticals from the agent
// already created (its saved system prompt + operator name). The user reviews,
// edits, toggles "responde sola / a revisión", deselects what they don't want,
// and saves. The three generic verticals (General, Engagement social, Hate/
// sarcasmo) are seeded by the DB, so we only surface the domain ones here.
// Used in the /setup wizard (Verticales step); drop-in for /verticales too.

import { useState } from "react";

type Suggested = {
  slug: string;
  name: string;
  description: string;
  system_prompt: string;
  auto_reply: boolean;
  requires_review: boolean;
  _include: boolean;
};

const BASELINE = ["General", "Engagement social", "Hate / sarcasmo"];

export function VerticalsAssistant({
  description,
  onSaved,
}: {
  description?: string;
  onSaved?: (count: number) => void;
}) {
  const [items, setItems] = useState<Suggested[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState<number | null>(null);

  async function suggest() {
    setLoading(true);
    setError(null);
    setSavedCount(null);
    try {
      const res = await fetch("/api/setup/suggest-verticals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: description ?? "" }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const list = (data.verticals as Omit<Suggested, "_include">[]) ?? [];
      setItems(list.map((v) => ({ ...v, _include: true })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    const chosen = items.filter((i) => i._include);
    if (chosen.length === 0) {
      setError("Seleccioná al menos una vertical, o continuá sin agregar de dominio.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/setup/verticals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verticals: chosen }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const n = data.saved ?? chosen.length;
      setSavedCount(n);
      onSaved?.(n);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function patch(idx: number, p: Partial<Suggested>) {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...p } : it)));
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm space-y-4 text-sm">
      <div>
        <h3 className="text-sm font-semibold tracking-tight text-neutral-900">
          Verticales — cómo clasifica los mensajes
        </h3>
        <p className="mt-1 text-xs text-neutral-500">
          Una vertical es un tipo de mensaje que tu agente reconoce, y define si
          lo responde solo o lo manda a revisión humana. Ya dejamos 3 genéricas
          listas; la IA te propone las propias de tu negocio a partir del agente
          que acabás de crear.
        </p>
      </div>

      {/* Baseline (seeded) */}
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
        <p className="text-xs font-medium text-neutral-600">Ya incluidas</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {BASELINE.map((b) => (
            <span
              key={b}
              className="rounded-full bg-white border border-neutral-200 px-2.5 py-1 text-[11px] text-neutral-700"
            >
              {b}
            </span>
          ))}
        </div>
      </div>

      {/* Suggest button */}
      {items.length === 0 && (
        <button
          type="button"
          onClick={suggest}
          disabled={loading}
          className="w-full rounded-lg bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {loading ? "Pensando en tus verticales…" : "✨ Sugerir verticales de mi negocio"}
        </button>
      )}

      {/* Suggestions list */}
      {items.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-neutral-600">
              Propuestas ({items.filter((i) => i._include).length}/{items.length} seleccionadas)
            </p>
            <button
              type="button"
              onClick={suggest}
              disabled={loading}
              className="text-xs text-violet-600 underline disabled:opacity-50"
            >
              {loading ? "…" : "Volver a sugerir"}
            </button>
          </div>

          {items.map((it, idx) => (
            <div
              key={idx}
              className={`rounded-lg border p-3 transition-colors ${
                it._include ? "border-neutral-300 bg-white" : "border-neutral-200 bg-neutral-50 opacity-60"
              }`}
            >
              <div className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={it._include}
                  onChange={(e) => patch(idx, { _include: e.target.checked })}
                  className="mt-1 h-4 w-4 flex-shrink-0 rounded border-neutral-300"
                />
                <div className="min-w-0 flex-1 space-y-2">
                  <input
                    value={it.name}
                    onChange={(e) => patch(idx, { name: e.target.value })}
                    className="w-full rounded-md border border-neutral-200 px-2 py-1 text-sm font-medium text-neutral-900 focus:border-neutral-400 focus:outline-none"
                  />
                  <p className="text-xs text-neutral-500">{it.description}</p>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => patch(idx, { auto_reply: true, requires_review: false })}
                      className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                        it.auto_reply
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-neutral-100 text-neutral-500"
                      }`}
                    >
                      Responde sola
                    </button>
                    <button
                      type="button"
                      onClick={() => patch(idx, { auto_reply: false, requires_review: true })}
                      className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                        !it.auto_reply
                          ? "bg-amber-100 text-amber-700"
                          : "bg-neutral-100 text-neutral-500"
                      }`}
                    >
                      A revisión
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="w-full rounded-lg bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Guardando…" : "Guardar verticales seleccionadas"}
          </button>
        </div>
      )}

      {savedCount !== null && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          ✓ {savedCount} {savedCount === 1 ? "vertical guardada" : "verticales guardadas"}. Podés
          editarlas o agregar más desde <span className="font-medium">/verticales</span> cuando quieras.
        </p>
      )}
      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
      )}
    </div>
  );
}
