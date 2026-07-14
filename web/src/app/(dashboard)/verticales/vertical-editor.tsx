"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Button, ConfirmDialog, Switch, inputCls } from "@/components/ui";

type Vertical = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  system_prompt: string;
  auto_reply: boolean;
  requires_review: boolean;
  ignore: boolean;
};

export function VerticalRow({ vertical }: { vertical: Vertical }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function toggle(field: "auto_reply" | "requires_review" | "ignore") {
    await fetch(`/api/verticales/${vertical.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: !vertical[field] }),
    });
    router.refresh();
  }

  return (
    <>
      <tr
        className="cursor-pointer transition-colors hover:bg-neutral-50"
        onClick={() => setOpen(true)}
      >
        <td className="px-4 py-3">
          <span className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700">
            {vertical.slug}
          </span>
        </td>
        <td className="px-4 py-3 font-medium text-neutral-900">{vertical.name}</td>
        <td className="px-4 py-3">
          {vertical.ignore ? (
            <span
              title="El agente ignora esta vertical: auto_reply no aplica"
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-neutral-50 text-neutral-300"
            >
              —
            </span>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggle("auto_reply");
              }}
              className={
                "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors " +
                (vertical.auto_reply
                  ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                  : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200")
              }
            >
              {vertical.auto_reply ? "ON" : "OFF"}
            </button>
          )}
        </td>
        <td className="px-4 py-3">
          {vertical.ignore ? (
            <span
              title="El agente ignora esta vertical: requires_review no aplica"
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-neutral-50 text-neutral-300"
            >
              —
            </span>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggle("requires_review");
              }}
              className={
                "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors " +
                (vertical.requires_review
                  ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
                  : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200")
              }
            >
              {vertical.requires_review ? "ON" : "OFF"}
            </button>
          )}
        </td>
        <td className="px-4 py-3">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggle("ignore");
            }}
            title="Si está ON, el agente no responde esta vertical (ni va a revisión)"
            className={
              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors " +
              (vertical.ignore
                ? "bg-red-100 text-red-700 hover:bg-red-200"
                : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200")
            }
          >
            {vertical.ignore ? "ON" : "OFF"}
          </button>
        </td>
        <td className="px-4 py-3 text-right">
          <span className="text-xs font-medium text-neutral-500">Ver / Editar →</span>
        </td>
      </tr>
      {open && (
        <Modal
          open={open}
          title={vertical.name}
          subtitle={vertical.slug}
          onClose={() => setOpen(false)}
        >
          <VerticalForm
            vertical={vertical}
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

type VerticalGen = {
  slug?: string;
  name?: string;
  description?: string;
  system_prompt?: string;
  auto_reply?: boolean;
  requires_review?: boolean;
  ignore?: boolean;
};

// Reusable AI assist: describe the vertical you want (or how to tweak an
// existing one) and the model fills/refines the fields using the saved agent
// context. Used by both the new-vertical form and the edit form.
function VerticalAiAssist({
  current,
  placeholder,
  onResult,
}: {
  current?: { name: string; description: string; system_prompt: string };
  placeholder?: string;
  onResult: (v: VerticalGen) => void;
}) {
  const [aiPrompt, setAiPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function generate() {
    if (!aiPrompt.trim()) {
      setErr("Describí qué querés.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/verticales/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: aiPrompt, current }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      onResult(j.vertical as VerticalGen);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-violet-200 bg-violet-50/50 p-3">
      <label className="text-xs font-medium text-neutral-700">
        ✨ {current ? "Mejorar con IA" : "Crear con IA"}
      </label>
      <p className="text-xs text-neutral-500">
        {current
          ? "Describí el ajuste que querés y la IA reescribe la vertical. Después editás lo que quieras."
          : "Describí en una frase qué vertical querés y la IA completa los campos usando el contexto de tu agente."}
      </p>
      <p className="text-[11px] text-neutral-400">
        💡 Si tu negocio lo pide, la IA puede incluir acciones en el CRM (mover de etapa, guardar
        datos) usando los nombres reales de Kommo. Activá esas acciones en{" "}
        <a href="/agent?tab=acciones" className="font-medium text-violet-700 underline">
          Agente → Acciones
        </a>
        .
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
          placeholder={placeholder ?? "Ej: consultas sobre la cartelera y horarios de las películas"}
          className={`flex-1 ${inputCls}`}
        />
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={generate}
          disabled={busy}
          busy={busy}
          className="shrink-0"
        >
          {busy ? "Generando…" : "Generar"}
        </Button>
      </div>
      {err && <p className="text-xs text-red-600">{err}</p>}
    </div>
  );
}

function VerticalForm({ vertical, onDone }: { vertical: Vertical; onDone: () => void }) {
  const [name, setName] = useState(vertical.name);
  const [description, setDescription] = useState(vertical.description ?? "");
  const [system_prompt, setSystemPrompt] = useState(vertical.system_prompt);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/verticales/${vertical.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, system_prompt }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "error");
      return;
    }
    onDone();
  }

  async function remove() {
    setDeleting(true);
    await fetch(`/api/verticales/${vertical.id}`, { method: "DELETE" });
    setDeleting(false);
    setConfirmingDelete(false);
    onDone();
  }

  return (
    <form onSubmit={save} className="space-y-4 max-w-3xl">
      <VerticalAiAssist
        current={{ name, description, system_prompt }}
        placeholder="Ej: que sea más estricto, o agregá manejo de reclamos"
        onResult={(v) => {
          if (v.name) setName(v.name);
          if (v.description != null) setDescription(v.description);
          if (v.system_prompt) setSystemPrompt(v.system_prompt);
        }}
      />
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-neutral-600">Nombre</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputCls}
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-neutral-600">Descripción (la usa el clasificador)</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className={`${inputCls} min-h-[4rem] resize-y`}
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-neutral-600">Prompt del agente (instrucciones específicas para esta vertical)</label>
        <textarea
          value={system_prompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={10}
          className={`${inputCls} min-h-[6rem] resize-y font-mono`}
        />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" busy={busy} disabled={busy}>
          Guardar
        </Button>
        <Button
          type="button"
          variant="danger"
          onClick={() => setConfirmingDelete(true)}
        >
          Borrar
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancelar
        </Button>
      </div>
      <ConfirmDialog
        open={confirmingDelete}
        title={`Borrar vertical "${vertical.slug}"`}
        description="Los mensajes ya clasificados quedarán sin vertical asignada. Esta acción no se puede deshacer."
        confirmLabel="Borrar"
        tone="danger"
        busy={deleting}
        onConfirm={remove}
        onCancel={() => setConfirmingDelete(false)}
      />
    </form>
  );
}

export function NewVerticalForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [system_prompt, setSystemPrompt] = useState("");
  const [auto_reply, setAutoReply] = useState(true);
  const [requires_review, setRequiresReview] = useState(false);
  const [ignore, setIgnore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetState() {
    setSlug(""); setName(""); setDescription(""); setSystemPrompt("");
    setAutoReply(true); setRequiresReview(false); setIgnore(false);
    setError(null);
  }

  function close() {
    setOpen(false);
    resetState();
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/verticales", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, name, description, system_prompt, auto_reply, requires_review, ignore }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "error");
      return;
    }
    close();
    router.refresh();
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        + Nueva vertical
      </Button>

      <Modal
        open={open}
        title="Nueva vertical"
        onClose={close}
        size="xl"
        footer={
          <>
            <Button type="button" variant="secondary" onClick={close}>
              Cancelar
            </Button>
            <Button type="submit" form="new-vertical-form" variant="primary" busy={busy} disabled={busy}>
              Crear
            </Button>
          </>
        }
      >
        <form id="new-vertical-form" onSubmit={save} className="space-y-4">
          <VerticalAiAssist
            onResult={(v) => {
              setSlug(v.slug ?? "");
              setName(v.name ?? "");
              setDescription(v.description ?? "");
              setSystemPrompt(v.system_prompt ?? "");
              setAutoReply(v.auto_reply === true);
              setRequiresReview(v.requires_review === true);
              setIgnore(v.ignore === true);
            }}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-neutral-600">Identificador</label>
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="consultoria_estrategia"
                className={`${inputCls} font-mono`}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-neutral-600">Nombre</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Consultoría estratégica"
                className={inputCls}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-neutral-600">Descripción (la usa el clasificador)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className={`${inputCls} min-h-[4rem] resize-y`}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-neutral-600">Prompt del agente (instrucciones específicas para esta vertical)</label>
            <textarea
              value={system_prompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={8}
              className={`${inputCls} min-h-[6rem] resize-y font-mono`}
            />
          </div>

          {/* Switches en lugar de checkboxes */}
          <div className="space-y-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-neutral-900">Respuesta automática</p>
                <p className="text-xs text-neutral-500">El agente responde sin revisión humana.</p>
              </div>
              <Switch checked={auto_reply} onChange={setAutoReply} tone="emerald" aria-label="Respuesta automática" />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-neutral-900">Revisión humana</p>
                <p className="text-xs text-neutral-500">Los mensajes de esta vertical van primero a revisión.</p>
              </div>
              <Switch checked={requires_review} onChange={setRequiresReview} tone="emerald" aria-label="Revisión humana" />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-neutral-900">No clasificar</p>
                <p className="text-xs text-neutral-500">El agente ignora esta vertical; no responde ni envía a revisión.</p>
              </div>
              <Switch checked={ignore} onChange={setIgnore} tone="brand" aria-label="No clasificar" />
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </form>
      </Modal>
    </>
  );
}
