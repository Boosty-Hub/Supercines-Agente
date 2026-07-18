"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog, Switch } from "@/components/ui";
import { CollapsibleSection } from "@/components/collapsible-section";
import {
  useKommoPipelines,
  type KommoPipeline,
  type KommoStage,
} from "@/components/kommo/use-kommo-pipelines";

// El Switch canónico vive en @/components/ui — acá estaba la copia original de
// la que se sacó aquel. Se eliminó para no mantener dos veces el mismo widget.

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------
export type MatchType = "contains" | "regex" | "mention_tag";

export type Rule = {
  id: string;
  pattern: string;
  match_type: MatchType;
  case_sensitive: boolean;
  enabled: boolean;
  description: string | null;
};

export type Limits = { cooldown: number; max: number; window: number };
export type VerticalLite = { id: string; slug: string; name: string; ignore: boolean };
export type ChannelsData = { seen: string[]; ignored: string[] };

const TYPE_OPTIONS: { value: MatchType; label: string; hint: string }[] = [
  { value: "contains", label: "Palabra o frase", hint: "ganatelo" },
  { value: "mention_tag", label: "Etiqueta @", hint: "vacío = cualquier @mención" },
  { value: "regex", label: "Regex", hint: "gana(te|telo)|sorteo" },
];

const CHANNEL_PRESETS: { value: string; label: string; note?: string }[] = [
  { value: "whatsapp", label: "WhatsApp", note: "waba" },
  { value: "instagram_dm", label: "Instagram", note: "instagram_business" },
  { value: "facebook", label: "Facebook" },
  { value: "telegram", label: "Telegram" },
  { value: "tiktok_kommo", label: "TikTok" },
  { value: "onlinechat", label: "Chat web", note: "onlinechat" },
];

function channelLabel(value: string): string {
  return CHANNEL_PRESETS.find((c) => c.value === value)?.label ?? value;
}

function describeRule(r: { pattern: string; match_type: MatchType; case_sensitive: boolean }): string {
  const cs = r.case_sensitive ? " · distingue may/min" : "";
  if (r.match_type === "mention_tag") {
    const h = r.pattern.trim().replace(/^@/, "");
    return h ? `Etiqueta a @${h}${cs}` : "Etiqueta a alguien (cualquier @mención)";
  }
  if (r.match_type === "regex") return `Coincide con /${r.pattern}/${cs}`;
  return `Contiene «${r.pattern}»${cs}`;
}

// ---------------------------------------------------------------------------
// Form de regla de texto (compartido entre crear y editar)
// ---------------------------------------------------------------------------
type RuleDraft = {
  pattern: string;
  match_type: MatchType;
  case_sensitive: boolean;
  enabled: boolean;
  description: string;
};

function RuleForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: RuleDraft;
  submitLabel: string;
  onSubmit: (d: RuleDraft) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<RuleDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = TYPE_OPTIONS.find((o) => o.value === draft.match_type)!;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err = await onSubmit(draft);
    setBusy(false);
    if (err) setError(err);
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-neutral-200 bg-neutral-50 p-4">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-neutral-600">Tipo de filtro</label>
        <div className="inline-flex rounded-lg border border-neutral-200 bg-white p-0.5">
          {TYPE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setDraft({ ...draft, match_type: o.value })}
              className={
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors " +
                (draft.match_type === o.value
                  ? "bg-neutral-900 text-white"
                  : "text-neutral-600 hover:bg-neutral-100")
              }
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-neutral-600">
          {draft.match_type === "mention_tag"
            ? "@handle específico (opcional)"
            : draft.match_type === "regex"
            ? "Expresión regular"
            : "Palabra o frase a detectar"}
        </label>
        <input
          value={draft.pattern}
          onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
          placeholder={active.hint}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm font-mono focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-neutral-600">Nota (opcional)</label>
        <input
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder="Para qué sirve esta regla"
          className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
        />
      </div>

      <label className="flex items-center gap-3 text-sm text-neutral-700">
        <Switch
          checked={draft.case_sensitive}
          onChange={(v) => setDraft({ ...draft, case_sensitive: v })}
        />
        Distinguir mayúsculas/minúsculas
      </label>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" busy={busy}>
          {busy ? "Guardando…" : submitLabel}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function RuleCard({ rule }: { rule: Rule }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function toggle(next: boolean) {
    setBusy(true);
    await fetch(`/api/skip-rules/${rule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    setBusy(false);
    router.refresh();
  }

  async function saveEdit(d: RuleDraft): Promise<string | null> {
    const res = await fetch(`/api/skip-rules/${rule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(d),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return j.error ?? "error";
    }
    setEditing(false);
    router.refresh();
    return null;
  }

  async function remove() {
    setDeleting(true);
    await fetch(`/api/skip-rules/${rule.id}`, { method: "DELETE" });
    setDeleting(false);
    setConfirmingDelete(false);
    router.refresh();
  }

  if (editing) {
    return (
      <RuleForm
        initial={{
          pattern: rule.pattern,
          match_type: rule.match_type,
          case_sensitive: rule.case_sensitive,
          enabled: rule.enabled,
          description: rule.description ?? "",
        }}
        submitLabel="Guardar"
        onSubmit={saveEdit}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div
      className={
        "flex items-center gap-4 rounded-xl border bg-white p-4 transition-colors " +
        (rule.enabled ? "border-neutral-200" : "border-neutral-200 opacity-60")
      }
    >
      <Switch checked={rule.enabled} onChange={toggle} busy={busy} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-neutral-900">{describeRule(rule)}</p>
        {rule.description && <p className="truncate text-xs text-neutral-400">{rule.description}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs font-medium text-neutral-500 hover:text-neutral-900"
        >
          Editar
        </button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setConfirmingDelete(true)}
          className="text-neutral-400 hover:text-red-600"
        >
          Borrar
        </Button>
      </div>
      <ConfirmDialog
        open={confirmingDelete}
        title="Borrar filtro"
        description={`Se eliminará el filtro "${rule.pattern}". Esta acción no se puede deshacer.`}
        confirmLabel="Borrar"
        tone="danger"
        busy={deleting}
        onConfirm={remove}
        onCancel={() => setConfirmingDelete(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Asistente IA general: texto + canales + etapas, de un solo pedido
// ---------------------------------------------------------------------------
type GenTextRule = {
  match_type: MatchType;
  pattern: string;
  case_sensitive: boolean;
  description: string;
};
type GenStage = { id: number; label: string };
type GenResult = {
  textRules: GenTextRule[];
  channels: string[];
  stages: GenStage[];
  summary: string;
};

function AiAssist({
  currentChannels,
  currentStageIds,
}: {
  currentChannels: string[];
  currentStageIds: number[];
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenResult | null>(null);

  async function generate() {
    if (!prompt.trim()) {
      setError("Describí qué no querés que responda el agente.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/filters/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: prompt }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      const r: GenResult = {
        textRules: j.textRules ?? [],
        channels: j.channels ?? [],
        stages: j.stages ?? [],
        summary: j.summary ?? "",
      };
      setResult(r);
      if (r.textRules.length === 0 && r.channels.length === 0 && r.stages.length === 0) {
        setError("La IA no propuso filtros. Probá reformular el pedido.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function applyAll() {
    if (!result) return;
    setCreating(true);
    setError(null);
    try {
      for (const s of result.textRules) {
        const res = await fetch("/api/skip-rules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...s, enabled: true }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || "error al crear una regla");
        }
      }
      if (result.channels.length > 0) {
        const merged = Array.from(new Set([...currentChannels, ...result.channels]));
        const res = await fetch("/api/filters/channels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channels: merged }),
        });
        if (!res.ok) throw new Error("error al guardar canales");
      }
      if (result.stages.length > 0) {
        const merged = Array.from(new Set([...currentStageIds, ...result.stages.map((s) => s.id)]));
        const res = await fetch("/api/filters/stages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stageIds: merged }),
        });
        if (!res.ok) throw new Error("error al guardar etapas");
      }
      setResult(null);
      setPrompt("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  const total = result
    ? result.textRules.length + result.channels.length + result.stages.length
    : 0;

  return (
    <div className="space-y-3 rounded-lg border border-violet-200 bg-violet-50/50 p-4">
      <div>
        <p className="text-sm font-medium text-neutral-800">✨ Configurar filtros con IA</p>
        <p className="text-xs text-neutral-500">
          Describí qué NO querés que el agente responda — palabras, canales o etapas — y la IA lo
          arma. Ej: «que no responda sorteos, ni por TikTok, ni leads en la etapa Cerrado».
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              generate();
            }
          }}
          placeholder="Ej: no respondas sorteos ni por Instagram ni en la etapa Cerrado"
          className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
        />
        <button
          type="button"
          onClick={generate}
          disabled={busy}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
        >
          {busy ? "Generando…" : "Generar"}
        </button>
      </div>

      {result && total > 0 && (
        <div className="space-y-2 rounded-lg border border-violet-200 bg-white p-3">
          {result.summary && <p className="text-xs text-neutral-500">{result.summary}</p>}
          <div className="space-y-1.5">
            {result.textRules.map((s, i) => (
              <PreviewItem key={`t${i}`} icon="✎" text={describeRule(s)} sub={s.description} />
            ))}
            {result.channels.map((c, i) => (
              <PreviewItem key={`c${i}`} icon="◉" text={`Canal: ${channelLabel(c)}`} />
            ))}
            {result.stages.map((s, i) => (
              <PreviewItem key={`s${i}`} icon="≡" text={`Etapa: ${s.label}`} />
            ))}
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={applyAll}
              disabled={creating}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
            >
              {creating ? "Aplicando…" : `Aplicar ${total} filtro${total > 1 ? "s" : ""}`}
            </button>
            <button
              type="button"
              onClick={() => setResult(null)}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
            >
              Descartar
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

function PreviewItem({ icon, text, sub }: { icon: string; text: string; sub?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-neutral-100 bg-neutral-50 px-3 py-2">
      <span className="text-neutral-400">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-neutral-800">
        {text}
        {sub ? <span className="text-neutral-400"> — {sub}</span> : null}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sección: reglas de texto / menciones
// ---------------------------------------------------------------------------
function SkipRulesSection({
  rules,
  currentChannels,
  currentStageIds,
}: {
  rules: Rule[];
  currentChannels: string[];
  currentStageIds: number[];
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);

  async function create(d: RuleDraft): Promise<string | null> {
    const res = await fetch("/api/skip-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(d),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return j.error ?? "error";
    }
    setAdding(false);
    router.refresh();
    return null;
  }

  return (
    <CollapsibleSection
      title="Menciones y palabras"
      summary={
        rules.length === 0
          ? "Sin filtros"
          : `${rules.filter((r) => r.enabled).length} activo${
              rules.filter((r) => r.enabled).length === 1 ? "" : "s"
            } de ${rules.length}`
      }
      description={
        <>
          Si un mensaje entrante coincide con un filtro activo, el agente
          <span className="font-medium text-neutral-700"> no responde</span> (se evalúa antes
          del clasificador). Ideal para etiquetas/sorteos tipo «@alguien ganatelo».
        </>
      }
    >
      <div className="space-y-4">
      <div className="flex justify-end">
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="shrink-0 inline-flex items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
          >
            + Agregar filtro
          </button>
        )}
      </div>

      <AiAssist currentChannels={currentChannels} currentStageIds={currentStageIds} />

      {adding && (
        <RuleForm
          initial={{
            pattern: "",
            match_type: "contains",
            case_sensitive: false,
            enabled: true,
            description: "",
          }}
          submitLabel="Crear"
          onSubmit={create}
          onCancel={() => setAdding(false)}
        />
      )}

      {rules.length === 0 && !adding ? (
        <div className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50 p-8 text-center">
          <p className="text-sm text-neutral-500">
            No hay filtros de texto. Agregá uno o pedíselo a la IA.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rules.map((r) => (
            <RuleCard key={r.id} rule={r} />
          ))}
        </div>
      )}
      </div>
    </CollapsibleSection>
  );
}

// ---------------------------------------------------------------------------
// Sección: canales
// ---------------------------------------------------------------------------
function ChannelsSection({ channels }: { channels: ChannelsData }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [custom, setCustom] = useState("");

  // Estado local optimista (mismo patrón que Etapas: evita pisar el array por
  // el lag del prop tras router.refresh).
  const [ignoredLocal, setIgnoredLocal] = useState<string[]>(channels.ignored);
  useEffect(() => {
    setIgnoredLocal(channels.ignored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels.ignored.join(",")]);

  const ignored = new Set(ignoredLocal);
  const map = new Map<string, { value: string; label: string; note?: string }>();
  for (const p of CHANNEL_PRESETS) map.set(p.value, p);
  for (const s of channels.seen) if (!map.has(s)) map.set(s, { value: s, label: s });
  for (const ig of ignoredLocal) if (!map.has(ig)) map.set(ig, { value: ig, label: ig });
  const items = Array.from(map.values());

  async function persist(next: string[]) {
    await fetch("/api/filters/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channels: next }),
    });
    router.refresh();
  }

  // ON = responde por ese canal. OFF = no responde (en ignored).
  async function toggle(value: string, responds: boolean) {
    setBusy(value);
    const next = Array.from(
      new Set(responds ? ignoredLocal.filter((c) => c !== value) : [...ignoredLocal, value])
    );
    setIgnoredLocal(next); // optimista
    await persist(next);
    setBusy(null);
  }

  // Agrega un canal nuevo ya apagado (no responde) — para silenciar uno que no
  // está en la lista.
  async function addCustom() {
    const v = custom.trim().toLowerCase();
    if (!v) return;
    setBusy(v);
    const next = Array.from(new Set([...ignoredLocal, v]));
    setIgnoredLocal(next); // optimista
    await persist(next);
    setCustom("");
    setBusy(null);
  }

  return (
    <CollapsibleSection
      title="Canales"
      summary={`Responde por ${items.filter((it) => !ignored.has(it.value)).length} de ${items.length} canales`}
      description={
        <>
          Encendido = el agente <span className="font-medium text-neutral-700">responde</span> por
          ese canal; apagado = no responde.
        </>
      }
    >
      <div className="space-y-4">
      <div className="divide-y divide-neutral-100">
        {items.map((it) => (
          <div key={it.value} className="flex items-center justify-between gap-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-neutral-900">{it.label}</p>
              <p className="truncate text-xs font-mono text-neutral-400">
                {it.note ?? it.value}
              </p>
            </div>
            <Switch
              checked={!ignored.has(it.value)}
              busy={busy === it.value}
              onChange={(next) => toggle(it.value, next)}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustom();
            }
          }}
          placeholder="Agregar otro canal (ej: viber, wechat)"
          className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm font-mono focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
        />
        <button
          type="button"
          onClick={addCustom}
          disabled={busy !== null}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:opacity-50"
        >
          Agregar apagado
        </button>
      </div>
      </div>
    </CollapsibleSection>
  );
}

// ---------------------------------------------------------------------------
// Sección: etapas de Kommo (selector visual, fetch en vivo)
// ---------------------------------------------------------------------------
function StagesSection({ ignoredStageIds }: { ignoredStageIds: number[] }) {
  const router = useRouter();
  // Embudos vía hook compartido: un solo fetch por página, tipos de lib/kommo.
  const { loading, error, configured, pipelines } = useKommoPipelines();
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // Fuente de verdad local optimista: el estado del server (prop) llega con
  // lag tras router.refresh; computar desde el prop causaba que un toggle pisara
  // el array entero. Acá aplicamos el cambio al instante y resync por valor.
  const [ignoredLocal, setIgnoredLocal] = useState<number[]>(ignoredStageIds);

  // Con un solo embudo, abrirlo de entrada (antes se hacía dentro del fetch).
  useEffect(() => {
    if (pipelines.length === 1) setExpanded(new Set([pipelines[0].id]));
  }, [pipelines]);

  // Resync local ← prop solo cuando cambia el VALOR (no en cada render), para
  // reflejar cambios externos (ej. la IA) sin pisar un toggle optimista en curso.
  useEffect(() => {
    setIgnoredLocal(ignoredStageIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ignoredStageIds.join(",")]);

  const ignored = new Set(ignoredLocal);

  const stageById = new Map<number, { pipeline: string; name: string; color: string | null }>();
  for (const p of pipelines)
    for (const s of p.statuses)
      stageById.set(s.id, { pipeline: p.name, name: s.name, color: s.color });

  // Kommo comparte los estados finales "Ganado" (142) y "Perdido" (143): el
  // MISMO status_id aparece en TODOS los pipelines. Por eso el master de un
  // pipeline los tocaba en todos. Los tratamos como GLOBALES (sección aparte) y
  // los excluimos del master de cada pipeline.
  const idCounts = new Map<number, number>();
  for (const p of pipelines)
    for (const s of p.statuses) idCounts.set(s.id, (idCounts.get(s.id) ?? 0) + 1);
  const sharedIds = new Set(
    Array.from(idCounts.entries())
      .filter(([, c]) => c > 1)
      .map(([id]) => id)
  );
  const globalStatuses: KommoStage[] = [];
  const seenGlobal = new Set<number>();
  for (const p of pipelines)
    for (const s of p.statuses) {
      if (sharedIds.has(s.id) && !seenGlobal.has(s.id)) {
        seenGlobal.add(s.id);
        globalStatuses.push(s);
      }
    }
  const uniqueOf = (statuses: KommoStage[]) => statuses.filter((s) => !sharedIds.has(s.id));

  // Semántica: ON = el agente RESPONDE (no está en ignored). OFF = no responde.
  async function persist(next: number[]) {
    await fetch("/api/filters/stages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stageIds: Array.from(new Set(next)) }),
    });
    router.refresh();
  }

  async function setStage(stageId: number, responds: boolean) {
    setBusy(`stage:${stageId}`);
    const next = responds
      ? ignoredLocal.filter((id) => id !== stageId) // responde → sacar de pausa
      : [...ignoredLocal, stageId]; // no responde → poner en pausa
    setIgnoredLocal(next); // optimista
    await persist(next);
    setBusy(null);
  }

  async function setPipeline(p: KommoPipeline, responds: boolean) {
    setBusy(`pipe:${p.id}`);
    // Solo etapas ÚNICAS del pipeline — nunca las compartidas (Ganado/Perdido),
    // que se controlan globalmente abajo.
    const ids = uniqueOf(p.statuses).map((s) => s.id);
    const next = responds
      ? ignoredLocal.filter((id) => !ids.includes(id)) // responde a todas
      : [...ignoredLocal, ...ids]; // pausa todas
    setIgnoredLocal(next); // optimista
    await persist(next);
    setBusy(null);
  }

  function toggleExpand(pid: number) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(pid)) n.delete(pid);
      else n.add(pid);
      return n;
    });
  }

  const q = query.trim().toLowerCase();
  const filtered = pipelines
    .map((p) => {
      const uniq = uniqueOf(p.statuses);
      return {
        p,
        uniq,
        matched: q ? uniq.filter((s) => s.name.toLowerCase().includes(q)) : uniq,
      };
    })
    .filter((x) => x.matched.length > 0);

  // Resumen agrupado de lo que está en pausa: un pipeline 100% apagado se
  // muestra como UN chip ("Pipeline · todo"); si está parcial, las etapas sueltas.
  type PauseChip = { key: string; label: string; onRemove: () => void; busyKey: string };
  const pauseChips: PauseChip[] = [];
  for (const p of pipelines) {
    const uniq = uniqueOf(p.statuses);
    const pausedInP = uniq.filter((s) => ignored.has(s.id));
    if (pausedInP.length === 0) continue;
    if (pausedInP.length === uniq.length) {
      pauseChips.push({
        key: `p${p.id}`,
        label: `${p.name} · todo`,
        onRemove: () => setPipeline(p, true),
        busyKey: `pipe:${p.id}`,
      });
    } else {
      for (const s of pausedInP) {
        pauseChips.push({
          key: `s${s.id}`,
          label: `${p.name} · ${s.name}`,
          onRemove: () => setStage(s.id, true),
          busyKey: `stage:${s.id}`,
        });
      }
    }
  }
  // Estados globales (Ganado/Perdido) en pausa.
  for (const s of globalStatuses) {
    if (ignored.has(s.id)) {
      pauseChips.push({
        key: `g${s.id}`,
        label: `Global · ${s.name}`,
        onRemove: () => setStage(s.id, true),
        busyKey: `stage:${s.id}`,
      });
    }
  }
  // IDs en pausa que ya no existen en ningún pipeline (etapas borradas en Kommo).
  for (const id of ignoredLocal) {
    if (!stageById.has(id)) {
      pauseChips.push({
        key: `o${id}`,
        label: `#${id}`,
        onRemove: () => setStage(id, true),
        busyKey: `stage:${id}`,
      });
    }
  }

  return (
    <CollapsibleSection
      title="Etapas de Kommo"
      summary={
        ignoredLocal.length === 0
          ? "Responde en todas las etapas"
          : `${ignoredLocal.length} etapa${ignoredLocal.length === 1 ? "" : "s"} en pausa`
      }
      description={
        <>
          Activada = el agente <span className="font-medium text-neutral-700">responde</span> a los
          leads en esa etapa; apagada = no responde. El interruptor del pipeline enciende o apaga
          todas sus etapas.
        </>
      }
    >
      {loading ? (
        <p className="text-sm text-neutral-400">Cargando pipelines de Kommo…</p>
      ) : error ? (
        <p className="text-sm text-red-600">No se pudieron traer las etapas: {error}</p>
      ) : !configured ? (
        <p className="text-sm text-neutral-500">
          Conectá Kommo en el{" "}
          <a href="/setup" className="font-medium text-neutral-700 underline">
            setup
          </a>{" "}
          para ver y seleccionar las etapas.
        </p>
      ) : pipelines.length === 0 ? (
        <p className="text-sm text-neutral-500">No hay pipelines en tu cuenta de Kommo.</p>
      ) : (
        <div className="space-y-3">
          {/* Resumen: lo que está en pausa (click en el chip = reactivar) */}
          {pauseChips.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-amber-100 bg-amber-50 p-2">
              <span className="px-1 text-xs font-medium text-amber-700">No responde:</span>
              {pauseChips.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={c.onRemove}
                  disabled={busy === c.busyKey}
                  title="Reactivar (que el agente responda)"
                  className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-white px-2 py-0.5 text-[11px] font-medium text-neutral-700 transition-colors hover:border-emerald-300 hover:text-emerald-700 disabled:opacity-50"
                >
                  <span className="max-w-[14rem] truncate">{c.label}</span>
                  <span aria-hidden>✕</span>
                </button>
              ))}
            </div>
          )}

          {/* Buscador */}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar etapa…"
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
          />

          {/* Acordeón por pipeline (colapsado por defecto) */}
          {filtered.length === 0 ? (
            <p className="text-sm text-neutral-400">Sin etapas que coincidan con «{query}».</p>
          ) : (
            <div className="space-y-2">
              {filtered.map(({ p, uniq, matched }) => {
                const open = q.length > 0 || expanded.has(p.id);
                const paused = uniq.filter((s) => ignored.has(s.id)).length;
                // El pipeline está ON salvo que TODAS sus etapas (únicas) estén en pausa.
                const pipelineResponds = paused < uniq.length;
                return (
                  <div key={p.id} className="overflow-hidden rounded-lg border border-neutral-200">
                    <div className="flex items-center justify-between gap-3 bg-neutral-50 px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => toggleExpand(p.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span className="text-neutral-400">{open ? "▾" : "▸"}</span>
                        <span className="truncate text-sm font-medium text-neutral-800">
                          {p.name}
                        </span>
                        <span className="shrink-0 text-xs text-neutral-400">
                          ({uniq.length})
                        </span>
                        {paused > 0 && (
                          <span className="shrink-0 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                            {paused} en pausa
                          </span>
                        )}
                      </button>
                      <Switch
                        checked={pipelineResponds}
                        busy={busy === `pipe:${p.id}`}
                        onChange={(next) => setPipeline(p, next)}
                      />
                    </div>
                    {open && (
                      <div className="divide-y divide-neutral-100">
                        {matched.map((s) => (
                          <div
                            key={s.id}
                            className="flex items-center justify-between gap-4 px-3 py-2.5"
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <span
                                className="inline-block h-3 w-3 shrink-0 rounded-full border border-neutral-200"
                                style={{ backgroundColor: s.color ?? "#e5e5e5" }}
                              />
                              <span className="truncate text-sm text-neutral-800">{s.name}</span>
                            </div>
                            <Switch
                              checked={!ignored.has(s.id)}
                              busy={busy === `stage:${s.id}`}
                              onChange={(next) => setStage(s.id, next)}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Estados finales compartidos por Kommo (Ganado/Perdido) — globales */}
          {globalStatuses.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-neutral-200">
              <div className="bg-neutral-50 px-3 py-2.5">
                <p className="text-sm font-medium text-neutral-800">
                  Estados finales (todos los pipelines)
                </p>
                <p className="text-xs text-neutral-400">
                  Kommo comparte estos estados entre todos los pipelines, así que aplican global.
                </p>
              </div>
              <div className="divide-y divide-neutral-100">
                {globalStatuses.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between gap-4 px-3 py-2.5"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="inline-block h-3 w-3 shrink-0 rounded-full border border-neutral-200"
                        style={{ backgroundColor: s.color ?? "#e5e5e5" }}
                      />
                      <span className="truncate text-sm text-neutral-800">{s.name}</span>
                    </div>
                    <Switch
                      checked={!ignored.has(s.id)}
                      busy={busy === `stage:${s.id}`}
                      onChange={(next) => setStage(s.id, next)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </CollapsibleSection>
  );
}

// ---------------------------------------------------------------------------
// Sección: agrupar mensajes seguidos (debounce)
// ---------------------------------------------------------------------------
const DEBOUNCE_PRESETS = [0, 15, 30, 45, 60, 90];

function BatchingSection({ debounce }: { debounce: number }) {
  const router = useRouter();
  const [secs, setSecs] = useState(debounce);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = secs !== debounce;

  async function save() {
    setBusy(true);
    setSaved(false);
    const res = await fetch("/api/response-debounce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seconds: secs }),
    });
    setBusy(false);
    if (res.ok) {
      setSaved(true);
      router.refresh();
    }
  }

  return (
    <CollapsibleSection
      title="Agrupar mensajes seguidos"
      summary={secs === 0 ? "Sin espera — responde al instante" : `Espera ${secs}s de silencio`}
      description={
        <>
          Si un lead manda varios mensajes cortados («hola», «quiero cotizar», …), el agente espera
          a que termine de escribir y responde <span className="font-medium text-neutral-700">una
          sola vez</span> con todo junto, en vez de contestar cada uno por separado.
        </>
      }
    >
      <div className="space-y-5">
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 space-y-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-neutral-500">Espera de silencio</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight text-neutral-900">
              {secs === 0 ? "Sin espera" : `${secs}s`}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            {DEBOUNCE_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setSecs(p)}
                className={
                  "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors " +
                  (secs === p
                    ? "bg-neutral-900 text-white"
                    : "bg-white border border-neutral-200 text-neutral-600 hover:bg-neutral-100")
                }
              >
                {p === 0 ? "0" : `${p}s`}
              </button>
            ))}
          </div>
        </div>
        <input
          type="range"
          min={0}
          max={120}
          step={5}
          value={secs}
          onChange={(e) => setSecs(Number(e.target.value))}
          className="w-full accent-neutral-900"
        />
        <p className="text-xs text-neutral-500">
          {secs === 0
            ? "Responde al instante, mensaje por mensaje (puede contestar varias veces sin contexto)."
            : `Espera ${secs}s desde el último mensaje del lead; si sigue escribiendo, sigue esperando, y responde todo junto cuando para.`}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
        >
          {busy ? "Guardando…" : "Guardar"}
        </button>
        {saved && !dirty && <span className="text-sm text-emerald-600">✓ Guardado</span>}
      </div>
      </div>
    </CollapsibleSection>
  );
}

// ---------------------------------------------------------------------------
// Sección: ventana de frescura (solo atender mensajes recientes)
// ---------------------------------------------------------------------------
const FRESHNESS_PRESETS = [0, 1, 3, 6, 12, 24];

function FreshnessSection({ freshness }: { freshness: number }) {
  const router = useRouter();
  const [hours, setHours] = useState(freshness);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = hours !== freshness;

  async function save() {
    setBusy(true);
    setSaved(false);
    const res = await fetch("/api/response-freshness", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hours }),
    });
    setBusy(false);
    if (res.ok) {
      setSaved(true);
      router.refresh();
    }
  }

  return (
    <CollapsibleSection
      title="Solo atender mensajes frescos"
      summary={hours === 0 ? "Sin límite — atiende todo el backlog" : `Solo las últimas ${hours}h`}
      description={
        <>
          El agente solo responde mensajes de las{" "}
          <span className="font-medium text-neutral-700">últimas horas</span>. Lo más viejo lo
          siguen atendiendo los asesores. Evita que, tras una caída o un pico, el agente arrastre un
          backlog enorme contestando mensajes de hace días mientras el cliente de ahora espera detrás.
        </>
      }
    >
      <div className="space-y-5">
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 space-y-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-neutral-500">Ventana de frescura</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight text-neutral-900">
              {hours === 0 ? "Sin límite" : `${hours}h`}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            {FRESHNESS_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setHours(p)}
                className={
                  "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors " +
                  (hours === p
                    ? "bg-neutral-900 text-white"
                    : "bg-white border border-neutral-200 text-neutral-600 hover:bg-neutral-100")
                }
              >
                {p === 0 ? "Sin límite" : `${p}h`}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-neutral-500">
          {hours === 0
            ? "Atiende TODO el backlog acumulado (puede contestar mensajes de hace días). No recomendado en cuentas con volumen."
            : `Solo responde mensajes de la última ${hours === 1 ? "hora" : hours + " horas"}. Lo anterior se ignora — lo manejan los asesores.`}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
        >
          {busy ? "Guardando…" : "Guardar"}
        </button>
        {saved && !dirty && <span className="text-sm text-emerald-600">✓ Guardado</span>}
      </div>
      </div>
    </CollapsibleSection>
  );
}

// ---------------------------------------------------------------------------
// Sección: límites de respuesta por lead
// ---------------------------------------------------------------------------
function LimitsSection({ limits }: { limits: Limits }) {
  const router = useRouter();
  const [cooldownOn, setCooldownOn] = useState(limits.cooldown > 0);
  const [cooldown, setCooldown] = useState(limits.cooldown > 0 ? limits.cooldown : 60);
  const [maxOn, setMaxOn] = useState(limits.max > 0);
  const [maxVal, setMaxVal] = useState(limits.max > 0 ? limits.max : 5);
  const [windowH, setWindowH] = useState(limits.window > 0 ? limits.window : 24);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setSaved(false);
    setError(null);
    const res = await fetch("/api/response-limits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cooldown: cooldownOn ? Math.max(0, Math.trunc(cooldown)) : 0,
        max: maxOn ? Math.max(0, Math.trunc(maxVal)) : 0,
        window: Math.max(1, Math.trunc(windowH)),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "error");
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <CollapsibleSection
      title="Límites de respuesta por lead"
      summary={
        !cooldownOn && !maxOn
          ? "Sin límites"
          : [
              cooldownOn ? `1 respuesta cada ${cooldown}s` : null,
              maxOn ? `máx ${maxVal} en ${windowH}h` : null,
            ]
              .filter(Boolean)
              .join(" · ")
      }
      description="Evitá que el agente conteste de más al mismo contacto."
    >
      <div className="space-y-5">
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
        <label className="flex items-center gap-3">
          <Switch checked={cooldownOn} onChange={setCooldownOn} />
          <span className="text-sm font-medium text-neutral-900">Esperar entre respuestas</span>
        </label>
        {cooldownOn && (
          <div className="mt-3 flex items-center gap-2 pl-14 text-sm text-neutral-600">
            <span>Mínimo</span>
            <input
              type="number"
              min={1}
              value={cooldown}
              onChange={(e) => setCooldown(Number(e.target.value))}
              className="w-24 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-mono focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
            />
            <span>segundos entre respuestas al mismo lead.</span>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
        <label className="flex items-center gap-3">
          <Switch checked={maxOn} onChange={setMaxOn} />
          <span className="text-sm font-medium text-neutral-900">Tope de respuestas por lead</span>
        </label>
        {maxOn && (
          <div className="mt-3 flex flex-wrap items-center gap-2 pl-14 text-sm text-neutral-600">
            <span>Máximo</span>
            <input
              type="number"
              min={1}
              value={maxVal}
              onChange={(e) => setMaxVal(Number(e.target.value))}
              className="w-20 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-mono focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
            />
            <span>respuestas cada</span>
            <input
              type="number"
              min={1}
              value={windowH}
              onChange={(e) => setWindowH(Number(e.target.value))}
              className="w-20 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-mono focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900 focus:outline-none"
            />
            <span>horas.</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
        >
          {busy ? "Guardando…" : "Guardar límites"}
        </button>
        {saved && <span className="text-sm text-emerald-600">✓ Guardado</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
      </div>
    </CollapsibleSection>
  );
}

// ---------------------------------------------------------------------------
// Sección: categorías (verticales) ignoradas
// ---------------------------------------------------------------------------
function IgnoredCategoriesSection({ verticals }: { verticals: VerticalLite[] }) {
  const active = verticals.filter((v) => !v.ignore).length;
  return (
    <CollapsibleSection
      title="Categorías"
      summary={verticals.length === 0 ? "Sin categorías" : `${active} de ${verticals.length} activas`}
      description="Qué categorías responde el agente. Se editan en Verticales, su único lugar."
    >
      <a
        href="/verticales"
        className="flex items-center justify-between gap-4 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 group hover:border-neutral-300"
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-neutral-900 group-hover:text-brand">
            Editar categorías en Verticales
          </p>
          <p className="text-xs text-neutral-500">
            Encendida = el agente responde esa categoría; apagada = la clasifica pero no responde.
          </p>
        </div>
        <span className="shrink-0 text-neutral-400 group-hover:text-brand">→</span>
      </a>
    </CollapsibleSection>
  );
}

// ---------------------------------------------------------------------------
// Sección: multimedia (responder fotos / documentos / audios)
// ---------------------------------------------------------------------------
export type MediaFlags = { images: boolean; documents: boolean; audio: boolean };

function MediaSection({ media, hasOpenaiKey }: { media: MediaFlags; hasOpenaiKey: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [askKey, setAskKey] = useState(false);
  const [openaiKey, setOpenaiKey] = useState("");
  const [audioError, setAudioError] = useState<string | null>(null);

  async function toggle(key: "images" | "documents", next: boolean) {
    setBusy(key);
    await fetch("/api/media-response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: next }),
    });
    setBusy(null);
    router.refresh();
  }

  async function toggleAudio(next: boolean, key?: string) {
    setAudioError(null);
    // Para activar sin key guardada, primero pedimos la key de OpenAI.
    if (next && !hasOpenaiKey && !key) {
      setAskKey(true);
      return;
    }
    setBusy("audio");
    const res = await fetch("/api/media-response", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(key ? { audio: next, openaiKey: key } : { audio: next }),
    });
    setBusy(null);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setAudioError(j.error ?? `HTTP ${res.status}`);
      return;
    }
    setAskKey(false);
    setOpenaiKey("");
    router.refresh();
  }

  return (
    <CollapsibleSection
      title="Multimedia"
      summary={
        [media.images && "Fotos", media.documents && "PDF", media.audio && "Audios"]
          .filter(Boolean)
          .join(" · ") || "Nada activado"
      }
      description={
        <>
          Permití que el agente <span className="font-medium text-neutral-700">responda</span> a lo
          que el lead envía. Las fotos y los PDF los entiende Claude de forma nativa.
        </>
      }
    >
      <div className="divide-y divide-neutral-100">
        <div className="flex items-center justify-between gap-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-neutral-900">Fotos</p>
            <p className="text-xs text-neutral-400">El agente ve la imagen y responde.</p>
          </div>
          <Switch
            checked={media.images}
            busy={busy === "images"}
            onChange={(next) => toggle("images", next)}
          />
        </div>

        <div className="flex items-center justify-between gap-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-neutral-900">Documentos (PDF)</p>
            <p className="text-xs text-neutral-400">El agente lee el PDF y responde.</p>
          </div>
          <Switch
            checked={media.documents}
            busy={busy === "documents"}
            onChange={(next) => toggle("documents", next)}
          />
        </div>

        <div className="py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium text-neutral-900">
                Audios (notas de voz)
                {media.audio && (
                  <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                    Whisper activo
                  </span>
                )}
              </p>
              <p className="text-xs text-neutral-400">
                Se transcriben con OpenAI Whisper y el agente responde el texto.
                {!hasOpenaiKey && " Requiere tu API key de OpenAI."}
              </p>
            </div>
            <Switch
              checked={media.audio}
              busy={busy === "audio"}
              onChange={(next) => toggleAudio(next)}
            />
          </div>

          {askKey && !media.audio && (
            <div className="mt-3 space-y-2 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
              <p className="text-xs text-neutral-600">
                Pegá tu API key de OpenAI (se guarda en la configuración del proyecto y solo se
                usa para transcribir audios):
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="password"
                  value={openaiKey}
                  onChange={(e) => setOpenaiKey(e.target.value)}
                  placeholder="sk-..."
                  className="w-full flex-1 rounded-lg border border-neutral-300 px-3 py-1.5 font-mono text-sm focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900"
                />
                <button
                  type="button"
                  disabled={busy === "audio" || !openaiKey.trim()}
                  onClick={() => toggleAudio(true, openaiKey.trim())}
                  className="rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
                >
                  {busy === "audio" ? "Activando…" : "Activar"}
                </button>
              </div>
            </div>
          )}
          {audioError && <p className="mt-2 text-xs text-red-600">{audioError}</p>}
        </div>
      </div>
    </CollapsibleSection>
  );
}

// ---------------------------------------------------------------------------
// Panel completo
// ---------------------------------------------------------------------------
export type AgentOff = { fieldId: number | null; fieldName: string | null };

export function FiltersPanel({
  rules,
  limits,
  verticals,
  channels,
  ignoredStageIds,
  debounce,
  freshness,
  media,
  hasOpenaiKey = false,
}: {
  rules: Rule[];
  limits: Limits;
  verticals: VerticalLite[];
  channels: ChannelsData;
  ignoredStageIds: number[];
  debounce: number;
  freshness: number;
  media: MediaFlags;
  hasOpenaiKey?: boolean;
}) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-neutral-600">
        Cómo y cuándo responde el agente: agrupado de mensajes, multimedia, límites, y todo lo que
        hace que <span className="font-medium">no responda</span> (por lead, menciones, canales,
        etapas, categorías). Pedíselo a la IA o configuralo a mano.
      </p>
      <BatchingSection debounce={debounce} />
      <FreshnessSection freshness={freshness} />
      <MediaSection media={media} hasOpenaiKey={hasOpenaiKey} />
      <SkipRulesSection
        rules={rules}
        currentChannels={channels.ignored}
        currentStageIds={ignoredStageIds}
      />
      <ChannelsSection channels={channels} />
      <StagesSection ignoredStageIds={ignoredStageIds} />
      <LimitsSection limits={limits} />
      <IgnoredCategoriesSection verticals={verticals} />
    </div>
  );
}
