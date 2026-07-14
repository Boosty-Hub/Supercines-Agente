"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog, Modal, inputCls } from "@/components/ui";

type Grader = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  prompt: string;
  scale: "numeric_0_1" | "pass_fail";
  weight: number;
  enabled: boolean;
  source: "llm_judge" | "automatic" | "manual";
};

// Reusable AI assist: describe what to measure (or how to tweak an existing
// grader) and the model fills/refines the fields. Used by both the new-grader
// form and the edit form.
function GraderAiAssist({
  current,
  placeholder,
  onResult,
}: {
  current?: { name: string; description: string; prompt: string; scale: string };
  placeholder?: string;
  onResult: (g: {
    slug?: string;
    name?: string;
    description?: string;
    prompt?: string;
    scale?: string;
    weight?: number;
  }) => void;
}) {
  const [aiPrompt, setAiPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function generate() {
    if (!aiPrompt.trim()) {
      setErr("Describí qué querés medir.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/graders/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: aiPrompt, current }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      onResult(j.grader);
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
          ? "Describí el ajuste que querés y la IA reescribe el grader. Después editás lo que quieras."
          : "Describí qué querés medir y la IA arma el grader completo usando el contexto de tu agente."}
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
          placeholder={placeholder ?? "Ej: mide si la respuesta ofrece un próximo paso concreto"}
          className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
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

export function GraderRow({ grader }: { grader: Grader }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(grader.enabled);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    const newVal = !enabled;
    setEnabled(newVal);
    await fetch(`/api/graders/${grader.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: newVal }),
    });
    setBusy(false);
    router.refresh();
  }

  return (
    <>
      <tr className="hover:bg-neutral-50">
        <td className="px-4 py-3 font-mono text-xs text-neutral-700">{grader.slug}</td>
        <td className="px-4 py-3 text-neutral-900">{grader.name}</td>
        <td className="px-4 py-3 text-xs text-neutral-600">{grader.scale}</td>
        <td className="px-4 py-3 text-xs text-neutral-600">{grader.weight}</td>
        <td className="px-4 py-3 text-xs text-neutral-600">{grader.source}</td>
        <td className="px-4 py-3">
          <button
            type="button"
            disabled={busy}
            onClick={toggle}
            className={
              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium disabled:opacity-50 " +
              (enabled
                ? "bg-emerald-100 text-emerald-700"
                : "bg-neutral-100 text-neutral-600")
            }
          >
            {enabled ? "ON" : "OFF"}
          </button>
        </td>
        <td className="px-4 py-3 text-right">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="text-xs font-medium text-neutral-700 hover:underline"
          >
            {open ? "Cerrar" : "Editar"}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} className="bg-neutral-50 px-4 py-4">
            <GraderForm grader={grader} onDone={() => { setOpen(false); router.refresh(); }} />
          </td>
        </tr>
      )}
    </>
  );
}

function GraderForm({ grader, onDone }: { grader: Grader; onDone: () => void }) {
  const [name, setName] = useState(grader.name);
  const [description, setDescription] = useState(grader.description ?? "");
  const [prompt, setPrompt] = useState(grader.prompt);
  const [scale, setScale] = useState(grader.scale);
  const [weight, setWeight] = useState(grader.weight);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/graders/${grader.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, prompt, scale, weight }),
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
    await fetch(`/api/graders/${grader.id}`, { method: "DELETE" });
    setDeleting(false);
    setConfirmingDelete(false);
    onDone();
  }

  return (
    <form onSubmit={save} className="space-y-4 max-w-3xl">
      {grader.source === "llm_judge" && (
        <GraderAiAssist
          current={{ name, description, prompt, scale }}
          placeholder="Ej: que penalice respuestas vagas o sin próximo paso"
          onResult={(g) => {
            if (g.name) setName(g.name);
            if (g.description != null) setDescription(g.description);
            if (g.prompt) setPrompt(g.prompt);
            if (g.scale) setScale(g.scale === "pass_fail" ? "pass_fail" : "numeric_0_1");
            if (typeof g.weight === "number") setWeight(g.weight);
          }}
        />
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="text-xs font-medium text-neutral-600">Nombre</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={`mt-1 ${inputCls}`}
          />
        </div>
        <div>
          <label className="text-xs font-medium text-neutral-600">Peso</label>
          <input
            type="number"
            step="0.1"
            value={weight}
            onChange={(e) => setWeight(Number(e.target.value))}
            className={`mt-1 ${inputCls}`}
          />
        </div>
      </div>
      <div>
        <label className="text-xs font-medium text-neutral-600">Descripción</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={`mt-1 ${inputCls}`}
        />
      </div>
      <div>
        <label className="text-xs font-medium text-neutral-600">Prompt</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={8}
          className={`mt-1 ${inputCls} min-h-[6rem] resize-y font-mono`}
        />
      </div>
      <div>
        <label className="text-xs font-medium text-neutral-600">Escala</label>
        <select
          value={scale}
          onChange={(e) => setScale(e.target.value as "numeric_0_1" | "pass_fail")}
          className={`mt-1 block ${inputCls} bg-white`}
          disabled={grader.source === "automatic"}
        >
          <option value="numeric_0_1">numeric_0_1</option>
          <option value="pass_fail">pass_fail</option>
        </select>
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
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancelar
        </Button>
      </div>
      <ConfirmDialog
        open={confirmingDelete}
        title={`Borrar grader "${grader.slug}"`}
        description="Esta acción no se puede deshacer."
        confirmLabel="Borrar"
        tone="danger"
        busy={deleting}
        onConfirm={remove}
        onCancel={() => setConfirmingDelete(false)}
      />
    </form>
  );
}

export function NewGraderForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [scale, setScale] = useState<"numeric_0_1" | "pass_fail">("numeric_0_1");
  const [weight, setWeight] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/graders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug, name, description, prompt, scale, weight,
        source: "llm_judge", enabled: true,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "error");
      return;
    }
    setOpen(false);
    setSlug(""); setName(""); setDescription(""); setPrompt(""); setWeight(1);
    router.refresh();
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        + Agregar evaluación
      </Button>
      <Modal
        open={open}
        title="Nueva evaluación"
        subtitle="Un criterio con el que se califica cada respuesta que envía el agente."
        onClose={() => setOpen(false)}
        size="lg"
      >
        <form onSubmit={save} className="space-y-4">
      <GraderAiAssist
        onResult={(g) => {
          if (g.slug) setSlug(g.slug);
          if (g.name) setName(g.name);
          if (g.description != null) setDescription(g.description);
          if (g.prompt) setPrompt(g.prompt);
          if (g.scale) setScale(g.scale === "pass_fail" ? "pass_fail" : "numeric_0_1");
          if (typeof g.weight === "number") setWeight(g.weight);
        }}
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="text-xs font-medium text-neutral-600">Identificador</label>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="follows_instructions"
            className={`mt-1 ${inputCls} font-mono`}
          />
        </div>
        <div>
          <label className="text-xs font-medium text-neutral-600">Nombre</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sigue instrucciones"
            className={`mt-1 ${inputCls}`}
          />
        </div>
      </div>
      <div>
        <label className="text-xs font-medium text-neutral-600">Descripción</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={`mt-1 ${inputCls}`}
        />
      </div>
      <div>
        <label className="text-xs font-medium text-neutral-600">Prompt (system para Haiku)</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
          placeholder="Eres un evaluador imparcial. Tu única tarea es decidir si la respuesta del agente cumple con X. Devolvé JSON: {score: 0.0-1.0, reasoning: '...'}"
          className={`mt-1 ${inputCls} min-h-[6rem] resize-y font-mono`}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="text-xs font-medium text-neutral-600">Escala</label>
          <select
            value={scale}
            onChange={(e) => setScale(e.target.value as "numeric_0_1" | "pass_fail")}
            className={`mt-1 block ${inputCls} bg-white`}
          >
            <option value="numeric_0_1">Puntaje de 0 a 1</option>
            <option value="pass_fail">Pasa / No pasa</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-neutral-600">Peso</label>
          <input
            type="number"
            step="0.1"
            value={weight}
            onChange={(e) => setWeight(Number(e.target.value))}
            className={`mt-1 ${inputCls}`}
          />
        </div>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" busy={busy} disabled={busy}>
          Crear
        </Button>
      </div>
        </form>
      </Modal>
    </>
  );
}
