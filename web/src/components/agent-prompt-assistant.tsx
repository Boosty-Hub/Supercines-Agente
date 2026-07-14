"use client";

// Reusable AI assistant that builds and refines an agent system prompt.
// Used both in /setup (Creá tu agente) and /agent (edit later). It edits the
// prompt passed via `value` and reports changes via `onChange`. When `value` is
// empty it CREATES a base prompt (and, if `onIdentity` is given, suggests the
// operator + label); when `value` already has content each message either edits
// the right section or inserts a new one at the right place — preserving every
// other section verbatim. Long generations auto-continue past truncation.
//
// INVARIANT: this component never imports runtime-config/service — it only
// talks to the /api/setup/* routes.

import { useState } from "react";

const END = "<!--FIN-->";
const stripEnd = (s: string) => s.replace(END, "").trimEnd();
const cleanCont = (s: string) =>
  s.replace(/^\s*(continuaci[oó]n|continuation)\s*:?\s*\n+/i, "");

type Section = { title: string; body: string };

function parseSections(md: string): { preamble: string; sections: Section[] } {
  const lines = md.split("\n");
  const sections: { title: string; lines: string[] }[] = [];
  const preamble: string[] = [];
  let cur: { title: string; lines: string[] } | null = null;
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (cur) sections.push(cur);
      cur = { title: m[1].trim(), lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (cur) sections.push(cur);
  const clean = (s: string) => s.replace(/\n*---\s*$/, "").trimEnd();
  return {
    preamble: preamble.join("\n").replace(/\n*---\s*$/, "").trim(),
    sections: sections.map((s) => ({ title: s.title, body: clean(s.lines.join("\n")) })),
  };
}

function reassemble(preamble: string, sections: Section[]): string {
  const joined = sections.map((s) => s.body.trim()).join("\n\n---\n\n");
  return (preamble ? preamble.trim() + "\n\n---\n\n" : "") + joined;
}

function findIdx(sections: Section[], title: string): number {
  const t = title.trim().toLowerCase();
  if (!t) return -1;
  return sections.findIndex((s) => s.title.toLowerCase() === t);
}

const inputCls =
  "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none";
const primaryBtn =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50";

export function AgentPromptAssistant({
  value,
  onChange,
  onIdentity,
}: {
  value: string;
  onChange: (next: string) => void;
  onIdentity?: (operatorName: string, agentLabel: string) => void;
}) {
  const [aiInput, setAiInput] = useState("");
  const [aiMessages, setAiMessages] = useState<{ content: string }[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiPlan, setAiPlan] = useState<string | null>(null);
  const [histOpen, setHistOpen] = useState<Record<number, boolean>>({});

  async function streamCall(
    body: Record<string, unknown>,
    onSoFar: (s: string) => void
  ): Promise<string> {
    const res = await fetch("/api/setup/generate-agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      throw new Error((await res.text().catch(() => "")) || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let acc = "";
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      if (chunk.value) {
        acc += decoder.decode(chunk.value, { stream: true });
        onSoFar(acc);
      }
    }
    return acc;
  }

  // Stream a unit (base prompt or one section) with auto-continuation.
  async function streamComplete(
    initialBody: Record<string, unknown>,
    onUnit: (unit: string) => void
  ): Promise<string> {
    let assembled = await streamCall(initialBody, (acc) => onUnit(acc));
    let guard = 0;
    while (!assembled.includes(END) && guard < 6) {
      guard++;
      const more = await streamCall(
        { mode: "continue", partial: assembled },
        (acc) => onUnit(assembled + cleanCont(acc))
      );
      const c = cleanCont(more);
      if (!c.trim()) break;
      assembled += c;
    }
    return stripEnd(assembled);
  }

  async function suggestIdentity(description: string) {
    if (!onIdentity) return;
    try {
      const res = await fetch("/api/setup/suggest-identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok && data.ok !== false) {
        const op = typeof data.operatorName === "string" ? data.operatorName : "";
        const lb = typeof data.agentLabel === "string" ? data.agentLabel : "";
        if (op || lb) onIdentity(op, lb);
      }
    } catch {
      /* non-critical */
    }
  }

  async function send() {
    const text = aiInput.trim();
    if (!text || aiLoading) return;
    setAiError(null);
    setAiPlan(null);
    setAiLoading(true);
    const isCreate = value.trim() === "";
    setAiMessages((prev) => [...prev, { content: text }]);
    setAiInput("");
    try {
      if (isCreate) {
        const full = await streamComplete(
          { mode: "create", instruction: text },
          (unit) => onChange(stripEnd(unit))
        );
        onChange(full);
        void suggestIdentity(text);
        return;
      }

      const { preamble, sections } = parseSections(stripEnd(value));
      const titles = sections.map((s) => s.title);

      const planRes = await fetch("/api/setup/plan-edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction: text, sections: titles }),
      });
      const plan = (await planRes.json().catch(() => ({}))) as {
        ok?: boolean;
        action?: "edit" | "new";
        targetTitle?: string;
        newTitle?: string;
        afterTitle?: string;
        error?: string;
      };
      if (!planRes.ok || plan.ok === false) {
        setAiError(plan.error || `No se pudo planificar (HTTP ${planRes.status})`);
        return;
      }

      const editIdx = plan.action === "edit" ? findIdx(sections, plan.targetTitle || "") : -1;

      if (editIdx >= 0) {
        const target = sections[editIdx];
        setAiPlan(`✏️ Editando la sección «${target.title}»`);
        const apply = (bodyText: string) => {
          const draft = sections.slice();
          draft[editIdx] = { ...target, body: bodyText };
          onChange(reassemble(preamble, draft));
        };
        const newBody = await streamComplete(
          { mode: "edit", instruction: text, currentSection: target.body },
          (unit) => apply(stripEnd(unit))
        );
        apply(newBody);
      } else {
        const afterIdx = findIdx(sections, plan.afterTitle || "");
        const pos = afterIdx >= 0 ? afterIdx + 1 : sections.length;
        const newTitle = plan.newTitle || "Nueva sección";
        setAiPlan(
          `➕ Nueva sección «${newTitle}»${
            afterIdx >= 0 ? ` (después de «${sections[afterIdx].title}»)` : " (al final)"
          }`
        );
        const apply = (bodyText: string) => {
          const draft = sections.slice();
          draft.splice(pos, 0, { title: newTitle, body: bodyText });
          onChange(reassemble(preamble, draft));
        };
        const newSectionBody = await streamComplete(
          { mode: "section", instruction: text, title: newTitle, existingSections: titles },
          (unit) => apply(stripEnd(unit))
        );
        apply(newSectionBody);
      }
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiLoading(false);
    }
  }

  const isCreate = value.trim() === "";

  return (
    <div className="rounded-xl border border-violet-200 bg-gradient-to-br from-violet-50 to-indigo-50 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-base leading-none">✨</span>
        <h3 className="text-sm font-semibold text-violet-900">
          Asistente: {isCreate ? "construí tu agente con IA" : "editá el prompt con IA"}
        </h3>
      </div>
      <p className="text-xs text-violet-700">
        {isCreate
          ? "Contanos sobre tu negocio y armamos la base del prompt (lo ves aparecer al lado)."
          : "Pedile cambios o pegale info: detecto si editar una sección existente o crear una nueva, y la ubico donde corresponde — sin tocar el resto. Ej: «las sedes…», «hacé el tono más formal», «sumá la promo 2x1»."}
      </p>

      {aiMessages.length > 0 && (
        <ul className="space-y-1">
          {aiMessages.map((m, i) => (
            <li key={i} className="flex gap-2 text-xs text-violet-800">
              <span className="select-none text-violet-400">›</span>
              <button
                type="button"
                onClick={() => setHistOpen((p) => ({ ...p, [i]: !p[i] }))}
                className={`flex-1 text-left leading-relaxed hover:text-violet-900 ${
                  histOpen[i] ? "whitespace-pre-wrap" : "line-clamp-2"
                }`}
                title={histOpen[i] ? "Contraer" : "Ver completo"}
              >
                {m.content}
              </button>
            </li>
          ))}
        </ul>
      )}

      <textarea
        value={aiInput}
        onChange={(e) => setAiInput(e.target.value)}
        rows={3}
        placeholder={
          isCreate
            ? "Ej: Atención al cliente de SUPERCINES, la cadena de cines. El agente se llama MUVITO, atiende por WhatsApp e Instagram, con tono alegre y cercano."
            : "Ej: agregá nuestras redes (Instagram @supercines) y que ofrezca la promo 2x1 de los martes."
        }
        className={inputCls + " leading-relaxed bg-white/70"}
        disabled={aiLoading}
      />

      {aiError && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {aiError}
        </p>
      )}
      {aiPlan && (
        <p className="rounded-lg bg-violet-100 px-3 py-2 text-xs text-violet-800">{aiPlan}</p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={send}
          disabled={aiLoading || !aiInput.trim()}
          className={primaryBtn}
        >
          {aiLoading ? "Trabajando…" : isCreate ? "Generar con IA" : "Aplicar cambio"}
        </button>
        {!isCreate && !aiLoading && !aiPlan && (
          <span className="text-xs text-violet-600">
            Detecto si editar una sección o crear una nueva ✨
          </span>
        )}
      </div>
    </div>
  );
}
