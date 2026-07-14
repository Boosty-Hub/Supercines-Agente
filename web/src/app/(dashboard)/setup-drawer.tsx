"use client";

// Panel lateral derecho de configuración (onboarding no bloqueante).
//
// Reemplaza la vieja página full-screen /setup: el wizard vive ahora como un
// drawer que se desliza desde la derecha SOBRE el dashboard, para que el usuario
// entre a la plataforma de inmediato y complete los pasos cuando quiera.
//
//   - Se auto-abre una vez por sesión si falta configuración (sin molestar en
//     cada navegación: la descartada se guarda en sessionStorage).
//   - Se puede cerrar y reabrir con el launcher flotante (abajo a la derecha).
//   - ?setup=open en la URL lo fuerza abierto (lo usan /setup y los links
//     "corré /setup" dispersos por la app).
//   - Solo se monta para admins y fuera del modo embed (ver layout).

import { useEffect, useState } from "react";
import { AgentPromptAssistant } from "@/components/agent-prompt-assistant";
import { KommoWebhookPanel } from "@/components/kommo-webhook-panel";
import { VerticalsAssistant } from "@/components/verticals-assistant";
import { Button } from "@/components/ui/button";
import { inputCls, labelCls } from "@/components/ui/styles";
import type { SetupState, SetupProvisioned } from "@/lib/setup-state";

type StepStatus = "idle" | "running" | "done" | "error";

const DISMISS_KEY = "setup-drawer-dismissed";

// ─── Definición de pasos (compacta para el drawer) ───────────────────────────
// Se omite el paso "Base de datos" (siempre hecho) y se colapsa "Done" en un
// estado de éxito. Verticales es opcional (sin flag persistido).
const STEPS = [
  { key: "anthropic", label: "Conectá Anthropic" },
  { key: "agente", label: "Creá tu agente" },
  { key: "verticales", label: "Verticales", optional: true },
  { key: "memoria", label: "Memoria y aprendizaje" },
  { key: "kommo", label: "Conectá Kommo" },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

// ─── Helpers de nombres técnicos ─────────────────────────────────────────────

function toSlug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function deriveNames(slug: string) {
  const base = slug || "agente";
  return {
    agentName: `${base}-agent`,
    agentEnvironmentName: `${base}-env`,
    masterStoreName: `${base}-master`,
    leadsStoreName: `${base}-leads`,
  };
}

function parseKommoSubdomain(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .replace(/\.(kommo\.com|amocrm\.(com|ru))$/i, "")
    .replace(/\.(kommo\.com|amocrm\.(com|ru))(?=[:/])/i, "")
    .trim();
}

const hintCls = "text-xs text-neutral-500";

// ─── Sub-componentes ─────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: StepStatus }) {
  const map: Record<StepStatus, [string, string]> = {
    idle: ["bg-neutral-200 text-neutral-600", "Pendiente"],
    running: ["bg-blue-100 text-blue-700", "Corriendo…"],
    done: ["bg-emerald-100 text-emerald-700", "Listo"],
    error: ["bg-red-100 text-red-700", "Error"],
  };
  const [cls, text] = map[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}
    >
      {text}
    </span>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
      {message}
    </p>
  );
}

// Lista numerada de instrucciones (guía no técnica).
function InstructionList({ items }: { items: string[] }) {
  return (
    <ol className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3 text-xs text-neutral-600">
          <span className="flex-shrink-0 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-100 text-[10px] font-semibold text-neutral-700">
            {i + 1}
          </span>
          <span className="leading-relaxed">{item}</span>
        </li>
      ))}
    </ol>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function SetupDrawer({ state }: { state: SetupState }) {
  const anthropicDone = state.credentialsDone;
  const agenteDone = state.agentDone;
  const memoriaDone = state.memoryDone;
  const kommoDone = state.kommoDone;

  // Abrir el primer paso incompleto (mismo criterio que el wizard previo).
  const [step, setStep] = useState<number>(() => {
    if (!anthropicDone) return 0;
    if (!agenteDone) return 1;
    if (!memoriaDone) return 2; // → Verticales, luego continúa a Memoria
    if (!kommoDone) return 4;
    return 4;
  });

  const [statuses, setStatuses] = useState<Record<StepKey, StepStatus>>({
    anthropic: anthropicDone ? "done" : "idle",
    agente: agenteDone ? "done" : "idle",
    verticales: "idle",
    memoria: memoriaDone ? "done" : "idle",
    kommo: kommoDone ? "done" : "idle",
  });

  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [provisioned, setProvisioned] = useState<SetupProvisioned>(state.provisioned);

  // ── Apertura / cierre del drawer ──
  const [open, setOpen] = useState(false);
  // Cuando el onboarding está completo, el drawer muestra el panel de éxito. Si
  // el usuario hace click en un paso del riel para reconfigurarlo, marcamos
  // "revisitando" para volver a mostrar el formulario de ese paso.
  const [revisiting, setRevisiting] = useState(false);

  // Los 4 pasos requeridos (verticales es opcional).
  const requiredDone =
    statuses.anthropic === "done" &&
    statuses.agente === "done" &&
    statuses.memoria === "done" &&
    statuses.kommo === "done";

  useEffect(() => {
    // ?setup=open fuerza la apertura (deep-link /setup y links dispersos).
    const forced =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("setup") === "open";
    if (forced) {
      setOpen(true);
      return;
    }
    // Completo → no auto-abrir.
    if (requiredDone) return;
    // Incompleto: auto-abrir una vez por sesión (respeta el descarte).
    const dismissed = sessionStorage.getItem(DISMISS_KEY) === "1";
    if (!dismissed) setOpen(true);
    // Solo al montar: apertura inicial. El estado en vivo se maneja aparte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function closeDrawer() {
    sessionStorage.setItem(DISMISS_KEY, "1");
    setOpen(false);
  }

  // ── Formularios ──
  const [anthropicApiKey, setAnthropicApiKey] = useState("");

  const initialSlug = (() => {
    if (state.prefill.agentLabel) return toSlug(state.prefill.agentLabel);
    if (state.prefill.operatorName) return toSlug(state.prefill.operatorName);
    return "";
  })();

  const [operatorName, setOperatorName] = useState(state.prefill.operatorName);
  const [agentLabel, setAgentLabel] = useState(state.prefill.agentLabel);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const existingDerived = deriveNames(initialSlug);
  const [agentName, setAgentName] = useState(state.prefill.agentName || existingDerived.agentName);
  const [agentEnvironmentName, setAgentEnvironmentName] = useState(
    state.prefill.agentEnvironmentName || existingDerived.agentEnvironmentName
  );
  const [agentModel, setAgentModel] = useState(state.prefill.agentModel || "claude-sonnet-4-6");
  const [masterStoreName, setMasterStoreName] = useState(
    state.prefill.masterStoreName || existingDerived.masterStoreName
  );
  const [leadsStoreName, setLeadsStoreName] = useState(
    state.prefill.leadsStoreName || existingDerived.leadsStoreName
  );
  const [advancedTouched, setAdvancedTouched] = useState(Boolean(state.prefill.agentName));

  function handleAgentLabelChange(val: string) {
    setAgentLabel(val);
    if (!advancedTouched) {
      const derived = deriveNames(toSlug(val || operatorName));
      setAgentName(derived.agentName);
      setAgentEnvironmentName(derived.agentEnvironmentName);
      setMasterStoreName(derived.masterStoreName);
      setLeadsStoreName(derived.leadsStoreName);
    }
  }

  function handleOperatorNameChange(val: string) {
    setOperatorName(val);
    if (!advancedTouched && !agentLabel) {
      const derived = deriveNames(toSlug(val));
      setAgentName(derived.agentName);
      setAgentEnvironmentName(derived.agentEnvironmentName);
      setMasterStoreName(derived.masterStoreName);
      setLeadsStoreName(derived.leadsStoreName);
    }
  }

  const [subdomain, setSubdomain] = useState(state.prefill.subdomain);
  const [accessToken, setAccessToken] = useState("");

  // ── Helpers de red ──
  const setStatus = (key: StepKey, s: StepStatus) =>
    setStatuses((prev) => ({ ...prev, [key]: s }));
  const setError = (key: string, e: string | null) =>
    setErrors((prev) => ({ ...prev, [key]: e }));

  async function callStep(
    key: StepKey,
    url: string,
    body: unknown | null,
    onOk?: (data: Record<string, unknown>) => void
  ): Promise<boolean> {
    setStatus(key, "running");
    setError(key, null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.ok === false) {
        const msg = (data.error as string) || `HTTP ${res.status}`;
        setStatus(key, "error");
        setError(key, msg);
        return false;
      }
      setStatus(key, "done");
      onOk?.(data);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(key, "error");
      setError(key, msg);
      return false;
    }
  }

  // ── Handlers de paso ──
  async function submitAnthropicKey(e: React.FormEvent) {
    e.preventDefault();
    const ok = await callStep("anthropic", "/api/setup/credentials", { anthropicApiKey });
    if (ok) setStep(1);
  }

  async function submitAgente(e: React.FormEvent) {
    e.preventDefault();
    const identitySaved = await callStep("agente", "/api/setup/credentials", {
      operatorName,
      agentName,
      agentLabel,
      agentEnvironmentName,
      agentModel,
      masterStoreName,
      leadsStoreName,
      ...(systemPrompt ? { systemPrompt } : {}),
    });
    if (!identitySaved) return;

    const agentProvisioned = await callStep("agente", "/api/setup/agent", null, (data) => {
      const env = data.environment as { id?: string } | undefined;
      const agent = data.agent as { id?: string; version?: number } | undefined;
      setProvisioned((p) => ({
        ...p,
        environmentId: env?.id ?? p.environmentId,
        agentId: agent?.id ?? p.agentId,
        agentVersion: agent?.version != null ? String(agent.version) : p.agentVersion,
      }));
    });
    if (agentProvisioned) setStep(2);
  }

  async function runMemoria() {
    const ok = await callStep("memoria", "/api/setup/memory", null, (data) => {
      const master = data.master as { id?: string } | undefined;
      const leads = data.leads as { id?: string } | undefined;
      setProvisioned((p) => ({
        ...p,
        masterId: master?.id ?? p.masterId,
        leadsId: leads?.id ?? p.leadsId,
      }));
    });
    if (ok) setStep(4);
  }

  async function submitKommo(e: React.FormEvent) {
    e.preventDefault();
    await callStep("kommo", "/api/setup/kommo", {
      subdomain: parseKommoSubdomain(subdomain),
      accessToken,
    });
    // Al terminar Kommo el onboarding queda completo; el panel muestra el éxito.
  }

  // Completo y sin revisitar → mostramos el éxito; si no, el paso activo.
  const showingSuccess = requiredDone && !revisiting;
  const activeStep: StepKey | null = showingSuccess ? null : STEPS[step].key;
  const doneCount = STEPS.filter((s) => statuses[s.key] === "done").length;

  // ─── Launcher flotante (cuando el drawer está cerrado) ─────────────────────
  // Se muestra solo si falta configuración; cuando está completo, el dashboard
  // queda limpio (se puede reabrir vía /setup o Ajustes).
  const launcher =
    !open && !requiredDone ? (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-30 flex items-center gap-2.5 rounded-full border border-brand/20 bg-white px-4 py-2.5 text-sm font-medium text-neutral-800 shadow-pop transition-transform hover:-translate-y-0.5"
      >
        <span className="text-brand">✦</span>
        <span>Configurá tu agente</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-neutral-200">
            <span
              className="block h-full rounded-full bg-brand transition-all"
              style={{ width: `${(doneCount / STEPS.length) * 100}%` }}
            />
          </span>
          <span className="text-xs tabular-nums text-neutral-500">
            {doneCount}/{STEPS.length}
          </span>
        </span>
      </button>
    ) : null;

  if (!open) return launcher;

  // ─── Drawer abierto ─────────────────────────────────────────────────────────
  return (
    <>
      {/* Backdrop sutil: cierra al click, deja ver el dashboard detrás. */}
      <div
        className="fixed inset-0 z-40 bg-neutral-900/20"
        onClick={closeDrawer}
        aria-hidden
      />

      <aside
        role="dialog"
        aria-label="Configuración del agente"
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-neutral-200 bg-white shadow-modal"
      >
        {/* Header + progreso (sticky) */}
        <div className="shrink-0 border-b border-neutral-200 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-neutral-900">
                <span className="text-brand">✦</span> Configurá tu agente
              </h2>
              <p className="mt-0.5 text-xs text-neutral-500">
                Podés cerrar y seguir usando la plataforma. Retomás cuando quieras.
              </p>
            </div>
            <button
              type="button"
              onClick={closeDrawer}
              aria-label="Cerrar"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          {/* Barra de progreso */}
          <div className="mt-3 flex items-center gap-2">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-200">
              <span
                className="block h-full rounded-full bg-brand transition-all"
                style={{ width: `${(doneCount / STEPS.length) * 100}%` }}
              />
            </span>
            <span className="text-xs tabular-nums text-neutral-500">
              {doneCount} de {STEPS.length}
            </span>
          </div>
        </div>

        {/* Cuerpo scrolleable: riel de pasos + panel activo */}
        <div className="flex-1 overflow-y-auto">
          {/* Riel de pasos (vertical, clickeable) */}
          <ol className="border-b border-neutral-100 px-3 py-3">
            {STEPS.map((s, i) => {
              const isActive = i === step && !showingSuccess;
              const st = statuses[s.key];
              return (
                <li key={s.key}>
                  <button
                    type="button"
                    onClick={() => {
                      setStep(i);
                      setRevisiting(true);
                    }}
                    className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                      isActive ? "bg-brand-soft" : "hover:bg-neutral-50"
                    }`}
                  >
                    <span
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                        st === "done"
                          ? "bg-emerald-100 text-emerald-700"
                          : isActive
                          ? "bg-brand text-brand-foreground"
                          : "bg-neutral-100 text-neutral-500"
                      }`}
                    >
                      {st === "done" ? "✓" : i + 1}
                    </span>
                    <span
                      className={`flex-1 truncate ${
                        isActive ? "font-medium text-brand-strong" : "text-neutral-700"
                      }`}
                    >
                      {s.label}
                      {"optional" in s && s.optional && (
                        <span className="ml-1 text-[10px] font-normal text-neutral-400">
                          (opcional)
                        </span>
                      )}
                    </span>
                    {st !== "idle" && <StatusBadge status={st} />}
                  </button>
                </li>
              );
            })}
          </ol>

          {/* Panel del paso activo */}
          <div className="px-5 py-5">
            {/* ── Anthropic ── */}
            {activeStep === "anthropic" && (
              <form onSubmit={submitAnthropicKey} className="space-y-5">
                <div>
                  <h3 className="text-sm font-semibold tracking-tight text-neutral-900">
                    Conectá Anthropic
                  </h3>
                  <p className="mt-1 text-xs text-neutral-400">
                    Necesitamos tu API key de Anthropic para que el agente pueda funcionar.
                  </p>
                </div>

                <InstructionList
                  items={[
                    "Abrí console.anthropic.com e iniciá sesión con el correo que usás para la API de Claude.",
                    "Creá un espacio de trabajo (workspace) NUEVO con el nombre de tu cliente o empresa — así la facturación y los datos quedan separados.",
                    "Dentro de ese workspace, andá a Settings → API keys → Create key, copiala y pegala acá abajo.",
                  ]}
                />

                <div className="space-y-2">
                  <label className={labelCls}>API key de Anthropic</label>
                  <input
                    type="password"
                    value={anthropicApiKey}
                    onChange={(e) => setAnthropicApiKey(e.target.value)}
                    placeholder={
                      anthropicDone
                        ? "•••••• (ya configurada — dejá vacío para conservar)"
                        : "sk-ant-..."
                    }
                    className={inputCls + " font-mono"}
                  />
                  <p className={hintCls}>
                    {anthropicDone
                      ? "Ya hay una key guardada. Dejá el campo vacío para conservarla, o escribí una nueva para reemplazarla."
                      : "La clave empieza con sk-ant-. Se guarda de forma segura en tu base de datos."}
                  </p>
                </div>

                {errors.anthropic && <ErrorBox message={errors.anthropic} />}

                <Button type="submit" busy={statuses.anthropic === "running"}>
                  {statuses.anthropic === "running" ? "Validando…" : "Guardar y continuar"}
                </Button>
              </form>
            )}

            {/* ── Agente ── */}
            {activeStep === "agente" && (
              <form onSubmit={submitAgente} className="space-y-5">
                <div>
                  <h3 className="text-sm font-semibold tracking-tight text-neutral-900">
                    Creá tu agente
                  </h3>
                  <p className="mt-1 text-xs text-neutral-400">
                    Acá le das nombre y personalidad a tu agente — cómo se va a llamar, qué
                    voz va a usar, y de qué manera se va a presentar ante tus leads.
                  </p>
                </div>

                <AgentPromptAssistant
                  value={systemPrompt}
                  onChange={setSystemPrompt}
                  onIdentity={(op, lb) => {
                    if (op && !operatorName.trim()) handleOperatorNameChange(op);
                    if (lb && !agentLabel.trim()) handleAgentLabelChange(lb);
                  }}
                />

                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className={labelCls}>Operador (tu marca o nombre)</label>
                    <input
                      value={operatorName}
                      onChange={(e) => handleOperatorNameChange(e.target.value)}
                      placeholder="Ej: SUPERCINES"
                      className={inputCls}
                    />
                    <p className={hintCls}>
                      El nombre con el que el agente se presenta: tu empresa o el vendedor
                      real. Habla en su nombre. (El asistente de arriba puede completarlo por
                      vos.)
                    </p>
                  </div>
                  <div className="space-y-2">
                    <label className={labelCls}>Nombre para el panel</label>
                    <input
                      value={agentLabel}
                      onChange={(e) => handleAgentLabelChange(e.target.value)}
                      placeholder="Ej: Agente SUPERCINES"
                      className={inputCls}
                    />
                    <p className={hintCls}>
                      Solo para identificar a este agente dentro del dashboard. No lo ve el
                      lead. (El asistente puede completarlo.)
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className={labelCls}>Personalidad / voz del agente</label>
                  <textarea
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    rows={8}
                    placeholder={
                      state.hasSystemPrompt
                        ? "Ya hay una personalidad guardada — dejá vacío para conservarla, o escribí una nueva para reemplazarla."
                        : "Describí cómo habla el agente, qué puede y no puede decir, cómo saluda, cómo cierra ventas…\n\nPodés completar esto ahora o más tarde desde el panel /agent."
                    }
                    className={inputCls + " leading-relaxed"}
                  />
                  <p className={hintCls}>
                    Podés editarlo en detalle desde{" "}
                    <a className="underline" href="/agent">
                      /agent
                    </a>{" "}
                    en cualquier momento.
                  </p>
                </div>

                {/* Opciones avanzadas */}
                <div className="rounded-lg border border-neutral-200">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAdvanced((v) => !v);
                      if (!showAdvanced) setAdvancedTouched(true);
                    }}
                    className="flex w-full items-center justify-between rounded-lg px-4 py-3 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
                  >
                    <span>Opciones avanzadas</span>
                    <svg
                      className={`h-4 w-4 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
                      viewBox="0 0 16 16"
                      fill="none"
                      aria-hidden
                    >
                      <path
                        d="M4 6l4 4 4-4"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  {showAdvanced && (
                    <div className="space-y-4 border-t border-neutral-200 px-4 pb-4 pt-3">
                      <p className="text-xs text-neutral-500">
                        Estos nombres se generan automáticamente. Solo cambialos si sabés lo
                        que hacés.
                      </p>
                      <div className="space-y-3">
                        <div className="space-y-1">
                          <label className={labelCls + " text-xs"}>Nombre del agente</label>
                          <input
                            value={agentName}
                            onChange={(e) => setAgentName(e.target.value)}
                            className={inputCls + " font-mono text-xs"}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className={labelCls + " text-xs"}>Environment</label>
                          <input
                            value={agentEnvironmentName}
                            onChange={(e) => setAgentEnvironmentName(e.target.value)}
                            className={inputCls + " font-mono text-xs"}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className={labelCls + " text-xs"}>Memory Store master</label>
                          <input
                            value={masterStoreName}
                            onChange={(e) => setMasterStoreName(e.target.value)}
                            className={inputCls + " font-mono text-xs"}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className={labelCls + " text-xs"}>Memory Store leads</label>
                          <input
                            value={leadsStoreName}
                            onChange={(e) => setLeadsStoreName(e.target.value)}
                            className={inputCls + " font-mono text-xs"}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className={labelCls + " text-xs"}>Modelo</label>
                          <select
                            value={agentModel}
                            onChange={(e) => setAgentModel(e.target.value)}
                            className={inputCls + " text-xs"}
                          >
                            <option value="claude-sonnet-4-6">
                              Sonnet 4.6 — Recomendado (equilibrio calidad/costo)
                            </option>
                            <option value="claude-opus-4-8">
                              Opus 4.8 — Máxima capacidad (más caro)
                            </option>
                            <option value="claude-haiku-4-5">
                              Haiku 4.5 — Rápido y económico
                            </option>
                          </select>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {errors.agente && <ErrorBox message={errors.agente} />}

                <div className="flex flex-wrap gap-2">
                  <Button type="submit" busy={statuses.agente === "running"}>
                    {statuses.agente === "running"
                      ? "Creando agente…"
                      : statuses.agente === "done"
                      ? "Volver a crear"
                      : "Crear agente"}
                  </Button>
                  {statuses.agente === "done" && (
                    <Button type="button" variant="secondary" onClick={() => setStep(2)}>
                      Continuar
                    </Button>
                  )}
                </div>
              </form>
            )}

            {/* ── Verticales ── */}
            {activeStep === "verticales" && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-semibold tracking-tight text-neutral-900">
                    Verticales
                  </h3>
                  <p className="mt-1 text-xs text-neutral-400">
                    Las verticales son los tipos de mensaje que tu agente reconoce. Cada una
                    define si el agente responde sola o manda el mensaje a revisión humana. Ya
                    dejamos 3 genéricas listas; la IA te propone las propias de tu negocio a
                    partir del agente que creaste.
                  </p>
                </div>

                <VerticalsAssistant onSaved={() => setStatus("verticales", "done")} />

                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="secondary" onClick={() => setStep(1)}>
                    Atrás
                  </Button>
                  <Button type="button" onClick={() => setStep(3)}>
                    {statuses.verticales === "done" ? "Continuar" : "Continuar sin agregar"}
                  </Button>
                </div>
              </div>
            )}

            {/* ── Memoria ── */}
            {activeStep === "memoria" && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-semibold tracking-tight text-neutral-900">
                    Memoria y aprendizaje
                  </h3>
                  <p className="mt-1 text-xs text-neutral-400">
                    Con este paso, el agente recuerda cada conversación con cada lead y activa
                    el aprendizaje automático nocturno (Dreams), que mejora sus respuestas solo
                    con el tiempo.
                  </p>
                </div>

                <div className="space-y-3 rounded-lg border border-neutral-100 bg-neutral-50 px-4 py-4">
                  <div className="flex items-start gap-3 text-xs text-neutral-700">
                    <span className="mt-0.5 text-base leading-none">🧠</span>
                    <div>
                      <p className="font-medium">Memoria por lead</p>
                      <p className="mt-0.5 text-neutral-500">
                        El agente recuerda el historial de cada contacto para dar respuestas
                        contextualizadas.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 text-xs text-neutral-700">
                    <span className="mt-0.5 text-base leading-none">✨</span>
                    <div>
                      <p className="font-medium">Aprendizaje nocturno (Dreams)</p>
                      <p className="mt-0.5 text-neutral-500">
                        Cada noche analiza las conversaciones del día y destila aprendizajes que
                        el agente aplica desde el día siguiente.
                      </p>
                    </div>
                  </div>
                </div>

                {(provisioned.masterId || provisioned.leadsId) && (
                  <div className="space-y-3 text-xs">
                    {provisioned.masterId && (
                      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                        <p className="font-medium uppercase tracking-wide text-emerald-600">
                          Memoria global
                        </p>
                        <p className="mt-1 break-all font-mono text-[11px] text-neutral-700">
                          {provisioned.masterId}
                        </p>
                      </div>
                    )}
                    {provisioned.leadsId && (
                      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                        <p className="font-medium uppercase tracking-wide text-emerald-600">
                          Memoria por lead
                        </p>
                        <p className="mt-1 break-all font-mono text-[11px] text-neutral-700">
                          {provisioned.leadsId}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {errors.memoria && <ErrorBox message={errors.memoria} />}

                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="secondary" onClick={() => setStep(2)}>
                    Atrás
                  </Button>
                  <Button type="button" onClick={runMemoria} busy={statuses.memoria === "running"}>
                    {statuses.memoria === "running"
                      ? "Activando…"
                      : statuses.memoria === "done"
                      ? "Re-activar"
                      : "Activar memoria"}
                  </Button>
                  {statuses.memoria === "done" && (
                    <Button type="button" variant="secondary" onClick={() => setStep(4)}>
                      Continuar
                    </Button>
                  )}
                </div>
              </div>
            )}

            {/* ── Kommo ── */}
            {activeStep === "kommo" && (
              <form onSubmit={submitKommo} className="space-y-5">
                <div>
                  <h3 className="text-sm font-semibold tracking-tight text-neutral-900">
                    Conectá Kommo
                  </h3>
                  <p className="mt-1 text-xs text-neutral-400">
                    Conectamos tu cuenta de Kommo para que el agente pueda recibir y responder
                    mensajes desde el CRM.
                  </p>
                </div>

                <InstructionList
                  items={[
                    "En Kommo, andá a Configuración → Integraciones → Crear integración privada.",
                    "En la integración creada, copiá el Token de larga duración (long-lived token). Empieza por eyJ…",
                    "Completá los campos de abajo con el token y tu subdominio de Kommo.",
                  ]}
                />

                <div className="space-y-2">
                  <label className={labelCls}>Tu cuenta de Kommo</label>
                  <input
                    value={subdomain}
                    onChange={(e) => setSubdomain(e.target.value)}
                    placeholder="miempresa"
                    className={inputCls + " font-mono"}
                  />
                  <p className={hintCls}>
                    El subdominio de tu Kommo, o pegá la URL completa (ej: <code>miempresa</code>{" "}
                    o <code>https://miempresa.kommo.com</code>).
                  </p>
                </div>

                <div className="space-y-2">
                  <label className={labelCls}>Token de larga duración</label>
                  <textarea
                    value={accessToken}
                    onChange={(e) => setAccessToken(e.target.value)}
                    rows={3}
                    placeholder={
                      kommoDone
                        ? "•••••• (ya configurado — pegá uno nuevo para reemplazar)"
                        : "eyJ0eXAiOiJKV1Qi..."
                    }
                    className={inputCls + " break-all font-mono"}
                  />
                </div>

                <KommoWebhookPanel />

                <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-5">
                  <h4 className="text-sm font-semibold tracking-tight text-neutral-900">
                    Cómo responde el agente
                  </h4>
                  <p className="mt-1 text-xs text-neutral-500">
                    El campo de Kommo donde el agente escribe y el salesbot que envía la
                    respuesta se configuran después, en{" "}
                    <a className="underline" href="/config/kommo">
                      Config → Kommo
                    </a>
                    . Acá alcanza con conectar la cuenta.
                  </p>
                </div>

                {errors.kommo && <ErrorBox message={errors.kommo} />}

                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="secondary" onClick={() => setStep(3)}>
                    Atrás
                  </Button>
                  <Button type="submit" busy={statuses.kommo === "running"}>
                    {statuses.kommo === "running" ? "Verificando…" : "Verificar y guardar"}
                  </Button>
                </div>
              </form>
            )}

            {/* ── Éxito (todos los requeridos listos) ── */}
            {showingSuccess && (
              <div className="space-y-4 rounded-xl border border-emerald-200 bg-emerald-50 p-5">
                <div>
                  <h3 className="text-base font-semibold tracking-tight text-emerald-900">
                    ¡Tu agente está listo!
                  </h3>
                  <p className="mt-1 text-xs text-emerald-800">
                    Todo está configurado. A partir de ahora, el agente puede recibir mensajes
                    de Kommo y responder automáticamente.
                  </p>
                </div>
                <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800">
                  <p className="mb-1 font-medium">Próximo paso recomendado</p>
                  <p>
                    Andá a{" "}
                    <a className="font-medium underline" href="/settings">
                      Configuración
                    </a>{" "}
                    y activá el modo de validación (
                    <span className="font-medium">Agente ON + Publicar OFF</span>) para revisar
                    las respuestas antes de que lleguen a tus leads.
                  </p>
                </div>
                <Button type="button" onClick={closeDrawer}>
                  Ir al dashboard
                </Button>
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
