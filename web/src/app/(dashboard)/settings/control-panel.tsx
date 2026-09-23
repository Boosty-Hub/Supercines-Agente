"use client";

// Panel de control único: los interruptores críticos de kommo_publish_config,
// arriba de las pestañas de Ajustes — visible sin importar cuál esté abierta.
// Reemplaza los controles de "Encendido y publicación" que vivían dentro de
// la pestaña Agente (agent-publish-panel.tsx, borrado): esos switches ya NO
// existen en ningún otro lado del dashboard. Cada switch guarda al toque
// (fetch + optimistic UI + rollback), no hay botón "Guardar" ni recarga.
//
// Cuarto control: en vez de un switch crudo para `bypass_review` (como en el
// template), acá se reusa el tri-estado "Revisión humana" (todo/normal/sin)
// que ya existía en agent-publish-panel.tsx — es estrictamente más expresivo
// (cubre "todo a revisión", que un booleano no puede) y es la convención ya
// establecida de este repo para este mismo dato.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Switch, ConfirmDialog, type SwitchTone } from "@/components/ui";
import type { ReviewMode } from "@/lib/review-mode";

export type ControlPanelConfig = {
  systemHalted: boolean;
  /** false si la migración del apagado total todavía no se aplicó en este proyecto. */
  systemHaltedAvailable: boolean;
  agentEnabled: boolean;
  publishingEnabled: boolean;
  reviewMode: ReviewMode;
  salesbotId: number | null;
};

type BoolField = "system_halted" | "agent_enabled" | "publishing_enabled";
type Field = BoolField | "review_mode";

type Status = { tone: "green" | "amber" | "red"; text: string; href?: string; linkLabel?: string };

// Misma precedencia que agent-status.tsx (inbox), pero a nivel global de
// sistema en vez de por-lead: el switch más bloqueante gana.
function computeStatus(c: ControlPanelConfig): Status {
  if (c.systemHalted) {
    return { tone: "red", text: "Sistema apagado — cero consumo de IA." };
  }
  if (!c.agentEnabled) {
    return {
      tone: "amber",
      text: "El agente no está respondiendo — clasificación, Dreams y evaluadores siguen activos.",
    };
  }
  if (!c.publishingEnabled) {
    return { tone: "amber", text: "Modo validación: el agente genera respuestas pero no las publica." };
  }
  if (!c.salesbotId) {
    return {
      tone: "amber",
      text: "Falta el Salesbot: no se publica nada todavía.",
      href: "/settings?tab=conexiones",
      linkLabel: "Configurar Salesbot",
    };
  }
  if (c.reviewMode === "sin") {
    return { tone: "amber", text: "Publicando sin revisión humana." };
  }
  return { tone: "green", text: "Todo funcionando con normalidad." };
}

const STATUS_WRAP_CLS: Record<Status["tone"], string> = {
  green: "border-emerald-200 bg-emerald-50 text-emerald-700",
  amber: "border-amber-200 bg-amber-50 text-amber-800",
  red: "border-red-300 bg-red-50 text-red-700",
};
const STATUS_DOT_CLS: Record<Status["tone"], string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-600",
};

type RowTint = "none" | "danger" | "warning";
const ROW_TINT_CLS: Record<RowTint, string> = {
  none: "border-neutral-200 bg-white",
  danger: "border-red-300 bg-red-50",
  warning: "border-amber-300 bg-amber-50",
};

function SwitchRow({
  label,
  description,
  hint,
  checked,
  onChange,
  disabled,
  disabledNote,
  tint = "none",
  tone = "emerald",
  busy,
  error,
}: {
  label: string;
  description: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  disabledNote?: string;
  tint?: RowTint;
  tone?: SwitchTone;
  busy?: boolean;
  error?: string | null;
}) {
  const containerCls = disabled
    ? "border-neutral-200 bg-neutral-50 opacity-60"
    : checked
      ? ROW_TINT_CLS[tint]
      : ROW_TINT_CLS.none;

  return (
    <div className={`rounded-lg border p-4 transition-colors ${containerCls}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-neutral-900">{label}</p>
          <p className="mt-1 text-xs text-neutral-600">{description}</p>
          {hint && <p className="mt-1 text-[11px] text-neutral-400">{hint}</p>}
          {disabled && disabledNote && (
            <p className="mt-1 text-[11px] italic text-neutral-400">{disabledNote}</p>
          )}
          {error && <p className="mt-1 text-xs font-medium text-red-600">{error}</p>}
        </div>
        <Switch
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          busy={busy}
          tone={tone}
          aria-label={label}
        />
      </div>
    </div>
  );
}

const REVIEW_OPTS: { id: ReviewMode; label: string; hint: string }[] = [
  { id: "todo", label: "Todo a revisión", hint: "Cada respuesta espera aprobación humana antes de publicarse." },
  { id: "normal", label: "Normal", hint: "Publica directo, salvo lo que la clasificación mande a revisión." },
  { id: "sin", label: "Sin revisión", hint: "Publica SIEMPRE, aunque un mensaje entrara a revisión." },
];

/**
 * `initial` llega de un server component; después de un `router.refresh()`
 * Next vuelve a renderizar el padre y nos pasa un `initial` nuevo, pero
 * `useState(initial)` solo lee ese valor en el montaje inicial. Sin este
 * hook el panel se queda mostrando el último valor optimista para siempre,
 * aunque el guardado real haya fallado en otra pestaña/sesión. Se depende de
 * los primitivos, no del objeto (cambia de referencia en cada render).
 */
function useServerSyncedState(initial: ControlPanelConfig) {
  const [config, setConfig] = useState(initial);
  const [confirmed, setConfirmed] = useState(initial);
  useEffect(() => {
    setConfig(initial);
    setConfirmed(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    initial.systemHalted,
    initial.systemHaltedAvailable,
    initial.agentEnabled,
    initial.publishingEnabled,
    initial.reviewMode,
    initial.salesbotId,
  ]);
  return [config, setConfig, confirmed, setConfirmed] as const;
}

export function ControlPanel({ initial }: { initial: ControlPanelConfig }) {
  const router = useRouter();
  const [config, setConfig, confirmed, setConfirmed] = useServerSyncedState(initial);
  const [saving, setSaving] = useState<Partial<Record<Field, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [confirmHaltOpen, setConfirmHaltOpen] = useState(false);

  // Aplica el efecto de un campo sobre una config — usado tanto para el
  // update optimista como para el confirmado, y (con los valores previos) para
  // el rollback. Apagar publicación también apaga "sin revisión" (ver ruta):
  // reflejado acá de inmediato para que la UI no muestre un estado imposible
  // entre el click y la respuesta del servidor.
  function applyField(c: ControlPanelConfig, field: Field, value: boolean | ReviewMode): ControlPanelConfig {
    return {
      ...c,
      systemHalted: field === "system_halted" ? (value as boolean) : c.systemHalted,
      agentEnabled: field === "agent_enabled" ? (value as boolean) : c.agentEnabled,
      publishingEnabled: field === "publishing_enabled" ? (value as boolean) : c.publishingEnabled,
      reviewMode:
        field === "review_mode"
          ? (value as ReviewMode)
          : field === "publishing_enabled" && value === false && c.reviewMode === "sin"
            ? "normal"
            : c.reviewMode,
    };
  }

  async function persist(field: Field, value: boolean | ReviewMode) {
    // Valores previos de TODO lo que este campo podría llegar a tocar (él
    // mismo + reviewMode, que publishing_enabled=false también pisa) — el
    // rollback restaura solo esas claves, vía update funcional sobre el
    // estado MÁS RECIENTE, nunca pisando con un snapshot completo viejo. Con
    // un snapshot completo, dos switches guardándose en simultáneo y uno
    // fallando revertía también el que sí iba a salir bien.
    const previous = {
      systemHalted: config.systemHalted,
      agentEnabled: config.agentEnabled,
      publishingEnabled: config.publishingEnabled,
      reviewMode: config.reviewMode,
    };
    setConfig((c) => applyField(c, field, value));
    setErrors((e) => ({ ...e, [field]: undefined }));
    setSaving((s) => ({ ...s, [field]: true }));

    try {
      const res = await fetch("/api/settings/control-panel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field, value }),
      });

      // Sesión vencida: el middleware redirige /api/* a /login, y fetch (que
      // sigue redirects por default) termina con un 200 de HTML — sin este
      // chequeo el panel lo toma como guardado exitoso.
      const contentType = res.headers.get("content-type") ?? "";
      if (res.redirected || !contentType.includes("application/json")) {
        throw new Error("Tu sesión expiró. Volvé a iniciar sesión para seguir guardando cambios.");
      }

      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? "No se pudo guardar");
      }

      // Confirmado por el servidor: recién acá se puede confiar en el nuevo
      // estado para gatear otros switches (ver reviewDisabled más abajo).
      setConfirmed((c) => applyField(c, field, value));
      router.refresh();
    } catch (err) {
      // Rollback: SOLO lo que este campo pudo haber tocado vuelve a su valor
      // anterior — sobre el estado actual (funcional), no sobre un snapshot
      // que pudo quedar viejo si otro switch cambió mientras esto viajaba.
      setConfig((c) => ({
        ...c,
        systemHalted: field === "system_halted" ? previous.systemHalted : c.systemHalted,
        agentEnabled: field === "agent_enabled" ? previous.agentEnabled : c.agentEnabled,
        publishingEnabled: field === "publishing_enabled" ? previous.publishingEnabled : c.publishingEnabled,
        reviewMode: field === "publishing_enabled" || field === "review_mode" ? previous.reviewMode : c.reviewMode,
      }));
      setErrors((e) => ({ ...e, [field]: err instanceof Error ? err.message : "No se pudo guardar" }));
    } finally {
      setSaving((s) => ({ ...s, [field]: false }));
    }
  }

  function onToggleBool(field: BoolField, next: boolean) {
    // Encender el apagado total es la única acción con un paso de
    // confirmación — es la que corta todo, el resto (incluido apagarlo de
    // nuevo) se guarda directo.
    if (field === "system_halted" && next) {
      setConfirmHaltOpen(true);
      return;
    }
    void persist(field, next);
  }

  const status = computeStatus(config);
  const haltLocked = config.systemHalted || saving.system_halted === true;
  // Se deriva del estado CONFIRMADO (no del optimista): si publishing_enabled
  // todavía está guardándose, "sin revisión" sigue bloqueado hasta que el
  // servidor confirme — evitar la carrera de activarlo antes de que
  // publishing esté realmente prendido.
  const reviewDisabled = haltLocked || saving.publishing_enabled === true || !confirmed.publishingEnabled;

  return (
    <div
      id="panel-control"
      className="scroll-mt-24 space-y-4 rounded-xl border border-neutral-200 bg-white shadow-sm p-5 sm:p-6"
    >
      <div className="space-y-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-neutral-900">Panel de control</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            Los interruptores críticos del sistema, todos en un solo lugar. Cada uno se guarda al toque.
          </p>
        </div>
        <div
          className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium ${STATUS_WRAP_CLS[status.tone]}`}
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_CLS[status.tone]}`} aria-hidden />
          {status.text}
          {status.href && (
            <a href={status.href} className="underline underline-offset-2">
              {status.linkLabel}
            </a>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <SwitchRow
          label="Apagado total"
          description={
            !config.systemHaltedAvailable
              ? "Corta TODO el consumo de IA del sistema con un solo interruptor."
              : config.systemHalted
                ? "El sistema está apagado: nada llama a Anthropic ni a OpenAI (ni clasificación, ni respuestas, ni Dreams, ni Outcomes, ni seguimientos)."
                : "Corta TODO el consumo de IA del sistema con un solo interruptor — la opción más amplia que existe."
          }
          checked={config.systemHalted}
          onChange={(v) => onToggleBool("system_halted", v)}
          disabled={!config.systemHaltedAvailable}
          disabledNote={!config.systemHaltedAvailable ? "Pendiente de activar en este proyecto." : undefined}
          tint="danger"
          tone="red"
          busy={saving.system_halted}
          error={errors.system_halted}
        />

        <SwitchRow
          label="El agente responde"
          description={
            config.agentEnabled
              ? "Activo: el agente está generando respuestas para los leads."
              : "Pausado: el agente no genera ninguna respuesta nueva."
          }
          hint="Ojo: la clasificación de mensajes, los Dreams y los evaluadores de calidad siguen consumiendo IA aunque esto esté apagado. Para cero consumo real, usá Apagado total."
          checked={config.agentEnabled}
          onChange={(v) => onToggleBool("agent_enabled", v)}
          disabled={haltLocked}
          disabledNote={haltLocked ? "No aplica mientras el sistema está apagado." : undefined}
          busy={saving.agent_enabled}
          error={errors.agent_enabled}
        />

        <SwitchRow
          label="Publicar respuestas en Kommo"
          description={
            config.publishingEnabled
              ? "Activo: las respuestas generadas se envían a Kommo."
              : "Modo validación: el agente genera los borradores pero no los envía — quedan solo para revisar en la plataforma."
          }
          checked={config.publishingEnabled}
          onChange={(v) => onToggleBool("publishing_enabled", v)}
          disabled={haltLocked}
          disabledNote={haltLocked ? "No aplica mientras el sistema está apagado." : undefined}
          busy={saving.publishing_enabled}
          error={errors.publishing_enabled}
        />

        <div
          className={`rounded-lg border p-4 transition-colors ${
            reviewDisabled
              ? "border-neutral-200 bg-neutral-50 opacity-60"
              : config.reviewMode === "sin"
                ? ROW_TINT_CLS.warning
                : ROW_TINT_CLS.none
          }`}
        >
          <p className="text-sm font-medium text-neutral-900">Revisión humana</p>
          <div className="mt-2 inline-flex flex-wrap gap-1 rounded-lg bg-neutral-100 p-1">
            {REVIEW_OPTS.map((o) => {
              const disabled = reviewDisabled || saving.review_mode === true;
              return (
                <button
                  key={o.id}
                  type="button"
                  disabled={disabled}
                  aria-pressed={config.reviewMode === o.id}
                  onClick={() => persist("review_mode", o.id)}
                  className={
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 " +
                    (config.reviewMode === o.id
                      ? "bg-white text-neutral-900 shadow-sm"
                      : "text-neutral-600 hover:text-neutral-900")
                  }
                >
                  {o.label}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-neutral-600">
            {REVIEW_OPTS.find((o) => o.id === config.reviewMode)?.hint}
          </p>
          {reviewDisabled && (
            <p className="mt-1 text-[11px] italic text-neutral-400">
              {haltLocked
                ? "No aplica mientras el sistema está apagado."
                : "Activalo solo después de encender “Publicar respuestas en Kommo”."}
            </p>
          )}
          {errors.review_mode && <p className="mt-1 text-xs font-medium text-red-600">{errors.review_mode}</p>}
        </div>
      </div>

      <ConfirmDialog
        open={confirmHaltOpen}
        title="¿Apagar el sistema por completo?"
        description="Ninguna función va a consumir IA: ni la clasificación de mensajes entrantes, ni la generación de respuestas del agente, ni los aprendizajes nocturnos (Dreams), ni los evaluadores de calidad (Outcomes), ni los seguimientos automáticos. Los mensajes entrantes se siguen guardando, pero quedan sin clasificar hasta que lo reactivés."
        confirmLabel="Sí, apagar todo"
        cancelLabel="Cancelar"
        tone="danger"
        busy={saving.system_halted}
        onConfirm={() => {
          setConfirmHaltOpen(false);
          void persist("system_halted", true);
        }}
        onCancel={() => setConfirmHaltOpen(false)}
      />
    </div>
  );
}
