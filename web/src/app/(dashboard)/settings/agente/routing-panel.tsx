"use client";

// Ruteo de leads al equipo comercial (migración 0052).
//
// Dos decisiones que el operador controla acá:
//   1. Quiénes reciben leads y con qué términos (sede/ciudad) se los queda cada
//      persona directamente. Sin término detectado → round robin equitativo.
//   2. Qué cuentas de Kommo NO cuentan como "dueño real": un lead que las tenga
//      como responsable se puede reasignar; cualquier otra persona se respeta.
//
// El disparador NO está acá: se prende por vertical (Verticales → Asignar
// responsable automáticamente). Este panel define el equipo y las reglas.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Switch, inputCls } from "@/components/ui";
import { CollapsibleSection } from "@/components/collapsible-section";
import { useKommoUsers } from "@/components/kommo/use-kommo-users";

export type Assignee = {
  id: string;
  kommo_user_id: number;
  display_name: string | null;
  match_terms: string[];
  enabled: boolean;
  sort_order: number;
};

export type RoutingConfig = {
  enabled: boolean;
  takeoverUserIds: number[];
  minConfidence: number;
};

export function RoutingPanel({
  initialConfig,
  initialAssignees,
}: {
  initialConfig: RoutingConfig;
  initialAssignees: Assignee[];
}) {
  const router = useRouter();
  const { loading, error: usersError, configured, users } = useKommoUsers();

  const [enabled, setEnabled] = useState(initialConfig.enabled);
  const [takeover, setTakeover] = useState<number[]>(initialConfig.takeoverUserIds);
  const [minConf, setMinConf] = useState(initialConfig.minConfidence);
  const [assignees, setAssignees] = useState<Assignee[]>(initialAssignees);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newUserId, setNewUserId] = useState("");

  // Resync ← server tras router.refresh (por valor, no por identidad).
  useEffect(() => {
    setAssignees(initialAssignees);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initialAssignees)]);

  const userName = (id: number) =>
    users.find((u) => u.id === id)?.name ?? `Usuario ${id}`;

  const yaEnLista = new Set(assignees.map((a) => a.kommo_user_id));
  const disponibles = users.filter((u) => !yaEnLista.has(u.id));

  async function call(url: string, method: string, body?: unknown): Promise<boolean> {
    setError(null);
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError((j as { error?: string }).error ?? `HTTP ${res.status}`);
      return false;
    }
    return true;
  }

  async function toggleEnabled(next: boolean) {
    const prev = enabled;
    setEnabled(next); // optimista
    setBusy("config");
    const ok = await call("/api/routing/config", "POST", { routing_enabled: next });
    if (!ok) setEnabled(prev);
    setBusy(null);
    router.refresh();
  }

  async function saveMinConfidence(v: number) {
    const prev = minConf;
    setMinConf(v); // optimista
    setBusy("minconf");
    const ok = await call("/api/routing/config", "POST", { routing_min_confidence: v });
    if (!ok) setMinConf(prev);
    setBusy(null);
  }

  async function toggleTakeover(userId: number, on: boolean) {
    const prev = takeover;
    const next = on ? [...takeover, userId] : takeover.filter((id) => id !== userId);
    setTakeover(next); // optimista
    setBusy(`takeover-${userId}`);
    const ok = await call("/api/routing/config", "POST", { routing_takeover_user_ids: next });
    if (!ok) setTakeover(prev);
    setBusy(null);
  }

  async function addAssignee() {
    const id = Number(newUserId);
    if (!Number.isFinite(id) || id <= 0) return;
    setBusy("add");
    const ok = await call("/api/routing/assignees", "POST", {
      kommo_user_id: id,
      display_name: users.find((u) => u.id === id)?.name ?? null,
    });
    setBusy(null);
    if (ok) {
      setNewUserId("");
      router.refresh();
    }
  }

  async function patchAssignee(a: Assignee, patch: Partial<Assignee>) {
    setBusy(a.id);
    setAssignees((list) => list.map((x) => (x.id === a.id ? { ...x, ...patch } : x)));
    const ok = await call(`/api/routing/assignees/${a.id}`, "PATCH", patch);
    setBusy(null);
    if (!ok) setAssignees(initialAssignees);
    else router.refresh();
  }

  async function removeAssignee(a: Assignee) {
    setBusy(a.id);
    const ok = await call(`/api/routing/assignees/${a.id}`, "DELETE");
    setBusy(null);
    if (ok) router.refresh();
  }

  const activos = assignees.filter((a) => a.enabled).length;

  return (
    <CollapsibleSection
      title="Ruteo de leads al equipo"
      summary={
        enabled
          ? `${activos} ${activos === 1 ? "persona recibe" : "personas reciben"} leads`
          : "Apagado"
      }
      description={
        <>
          Reparte los leads de las verticales marcadas como{" "}
          <span className="font-medium text-neutral-700">Asigna responsable</span>: si el mensaje
          nombra un término de alguien (su sede, su ciudad), va directo a esa persona; si no,
          rota en round robin. Nunca le saca un lead a quien ya lo está atendiendo.
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex items-start justify-between gap-4 rounded-xl border border-neutral-200 bg-white p-4">
          <div>
            <p className="text-sm font-medium text-neutral-900">Ruteo automático</p>
            <p className="text-xs text-neutral-500">
              Interruptor maestro. Apagado, el agente no toca el responsable de ningún lead.
            </p>
          </div>
          <Switch
            checked={enabled}
            busy={busy === "config"}
            onChange={toggleEnabled}
            tone="brand"
            aria-label="Ruteo automático de leads"
          />
        </div>

        <div className="rounded-xl border border-neutral-200 bg-white p-4 space-y-2">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-neutral-900">
                Confianza mínima para asignar
              </p>
              <p className="text-xs text-neutral-500">
                El clasificador siempre elige una vertical, incluso dudando. Escribir en el CRM de
                una persona real pide más certeza que categorizar un mensaje: por debajo de este
                valor el lead se clasifica igual, pero no se asigna ni se toca Kommo.
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-neutral-100 px-2.5 py-1 text-sm font-medium tabular-nums text-neutral-700">
              {minConf.toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={minConf}
            disabled={busy === "minconf"}
            onChange={(e) => setMinConf(Number(e.target.value))}
            onMouseUp={(e) => saveMinConfidence(Number((e.target as HTMLInputElement).value))}
            onTouchEnd={(e) => saveMinConfidence(Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => saveMinConfidence(Number((e.target as HTMLInputElement).value))}
            className="w-full accent-neutral-900"
            aria-label="Confianza mínima para asignar responsable"
          />
          <p className="text-[11px] text-neutral-400">
            0 = sin umbral (asigna siempre). Recomendado 0.80. Lo que queda por debajo se registra
            en el historial de ruteo con el motivo, para que puedas calibrarlo con datos.
          </p>
        </div>

        {usersError && (
          <p className="text-xs text-red-600">No se pudo leer el equipo de Kommo: {usersError}</p>
        )}
        {!configured && (
          <p className="text-xs text-amber-700">
            Kommo todavía no está conectado: conectalo en Ajustes → Conexiones para elegir personas.
          </p>
        )}

        {/* ---- Equipo ---- */}
        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">
            Quiénes reciben leads
          </p>

          {assignees.length === 0 ? (
            <p className="rounded-lg bg-neutral-50 px-3 py-3 text-xs text-neutral-500">
              Todavía no hay nadie en la rueda. Sin personas acá, el ruteo no asigna nada.
            </p>
          ) : (
            <div className="space-y-2">
              {assignees.map((a) => (
                <div
                  key={a.id}
                  className="rounded-xl border border-neutral-200 bg-white p-3 space-y-2"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-neutral-900">
                        {a.display_name ?? userName(a.kommo_user_id)}
                      </p>
                      <p className="truncate text-[11px] font-mono text-neutral-400">
                        id {a.kommo_user_id}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Switch
                        checked={a.enabled}
                        busy={busy === a.id}
                        onChange={(v) => patchAssignee(a, { enabled: v })}
                        aria-label={`Activar ${a.display_name ?? a.kommo_user_id}`}
                      />
                      <button
                        type="button"
                        onClick={() => removeAssignee(a)}
                        disabled={busy !== null}
                        className="rounded-lg px-2 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
                      >
                        Quitar
                      </button>
                    </div>
                  </div>
                  <TermsEditor
                    value={a.match_terms}
                    busy={busy === a.id}
                    onSave={(terms) => patchAssignee(a, { match_terms: terms })}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2 sm:flex-row">
            <select
              value={newUserId}
              onChange={(e) => setNewUserId(e.target.value)}
              disabled={loading || disponibles.length === 0}
              className={`${inputCls} flex-1`}
            >
              <option value="">
                {loading
                  ? "Cargando equipo de Kommo…"
                  : disponibles.length === 0
                    ? "Ya agregaste a todo el equipo"
                    : "Agregar persona…"}
              </option>
              {disponibles.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} {u.email ? `· ${u.email}` : ""}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="secondary"
              onClick={addAssignee}
              disabled={!newUserId || busy !== null}
              busy={busy === "add"}
            >
              Agregar
            </Button>
          </div>
        </div>

        {/* ---- Cuentas genéricas ---- */}
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">
            Cuentas que no cuentan como dueño
          </p>
          <p className="text-xs text-neutral-500">
            Marcá la cuenta genérica con la que entran los leads. Un lead con esa cuenta como
            responsable se considera libre y se puede repartir; cualquier otra persona se respeta
            y el lead no se toca.
          </p>
          <div className="divide-y divide-neutral-100 rounded-xl border border-neutral-200 bg-white">
            {users.map((u) => (
              <div key={u.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-neutral-900">{u.name}</p>
                  <p className="truncate text-[11px] text-neutral-400">{u.email ?? `id ${u.id}`}</p>
                </div>
                <Switch
                  checked={takeover.includes(u.id)}
                  busy={busy === `takeover-${u.id}`}
                  tone="sky"
                  onChange={(v) => toggleTakeover(u.id, v)}
                  aria-label={`${u.name} no cuenta como dueño`}
                />
              </div>
            ))}
            {users.length === 0 && !loading && (
              <p className="px-3 py-3 text-xs text-neutral-500">Sin usuarios de Kommo.</p>
            )}
          </div>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </CollapsibleSection>
  );
}

/**
 * Editor de términos como chips. Se guarda al salir del input (blur) o con
 * Enter — no en cada tecla, para no pegarle a la API por letra.
 */
function TermsEditor({
  value,
  busy,
  onSave,
}: {
  value: string[];
  busy: boolean;
  onSave: (terms: string[]) => void;
}) {
  const [text, setText] = useState(value.join(", "));
  useEffect(() => {
    setText(value.join(", "));
  }, [value.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  function commit() {
    const next = text
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (next.join("|") !== value.join("|")) onSave(next);
  }

  return (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-neutral-500">
        Términos que le mandan el lead directo (separados por coma)
      </label>
      <input
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder="Ej: La Granja, Playa Mar, Valencia"
        className={`${inputCls} text-xs`}
      />
      <p className="text-[11px] text-neutral-400">
        Vacío = esta persona solo recibe leads por round robin. No importan mayúsculas ni acentos.
      </p>
    </div>
  );
}
