"use client";

// Calculadora para cotizar clientes: dado un volumen de mensajes/día,
// proyecta el costo mensual. Separa DOS cosas:
//   - el PERFIL DE TOKENS por evento (medido en este deployment — cuántos
//     tokens de input/output/caché/runtime usa cada componente), y
//   - el PRECIO por token, que depende del MODELO asignado a cada componente.
// Así, cambiar el modelo (acá o en el panel de arriba) recalcula al instante.
// Cambiar de modelo NO cambia cuántos tokens usa el agente — solo su precio.

import { useState } from "react";
import { AI_PRICING, CMA_RUNTIME_USD_PER_HOUR } from "@/lib/ai-pricing";
import { ALLOWED_MODELS } from "@/lib/model-config";

export type TokenProfile = {
  inTok: number;
  outTok: number;
  crTok: number;      // cache read por evento
  cwTok: number;      // cache write por evento
  runtimeMs: number;  // solo sesiones CMA
};

export type CalculatorData = {
  profiles: {
    classify: TokenProfile;
    response: TokenProfile;
    grader: TokenProfile | null;
    dreams: TokenProfile | null;
  };
  models: {
    classify: string;
    response: string;
    grader: string;
    dreams: string;
  };
  sessionsPerMsg: number;    // respuestas / mensajes (el debounce agrupa)
  gradersPerSession: number; // evaluaciones por respuesta
  dreamsRunsPerDay: number;  // corridas de dreams por día
};

const SHORT_MODEL: Record<string, string> = {
  "claude-haiku-4-5": "Haiku",
  "claude-sonnet-4-6": "Sonnet",
  "claude-opus-4-8": "Opus",
};

function costPerEvent(model: string, p: TokenProfile | null): number {
  if (!p) return 0;
  const pr = AI_PRICING[model];
  if (!pr) return 0;
  const M = 1_000_000;
  return (
    (p.inTok / M) * pr.input +
    (p.outTok / M) * pr.output +
    (p.crTok / M) * pr.cacheRead +
    (p.cwTok / M) * pr.cacheWrite5m +
    (p.runtimeMs / 3_600_000) * CMA_RUNTIME_USD_PER_HOUR
  );
}

function usd(n: number, digits = 2): string {
  return `$${n.toFixed(digits)}`;
}

export function CostCalculator({ data }: { data: CalculatorData }) {
  const [msgs, setMsgs] = useState(100);
  // Inicializa con los modelos ASIGNADOS (el panel de arriba); el operador
  // puede simular otros acá sin guardar nada.
  const [models, setModels] = useState(data.models);

  const sessions = msgs * data.sessionsPerMsg;
  const dClassify = msgs * costPerEvent(models.classify, data.profiles.classify);
  const dResp = sessions * costPerEvent(models.response, data.profiles.response);
  const dGrader = sessions * data.gradersPerSession * costPerEvent(models.grader, data.profiles.grader);
  const dDreams = data.dreamsRunsPerDay * costPerEvent(models.dreams, data.profiles.dreams);
  const daily = dClassify + dResp + dGrader + dDreams;
  const monthly = daily * 30;

  const simulating =
    models.classify !== data.models.classify ||
    models.response !== data.models.response ||
    models.grader !== data.models.grader ||
    models.dreams !== data.models.dreams;

  const modelRows: { key: keyof CalculatorData["models"]; label: string }[] = [
    { key: "response", label: "Respuestas" },
    { key: "classify", label: "Clasificación" },
    { key: "grader", label: "Evaluación" },
    { key: "dreams", label: "Dreams" },
  ];

  const rows = [
    { label: "Respuestas del agente", value: dResp * 30, hint: `≈ ${Math.round(sessions)} respuestas/día · ${SHORT_MODEL[models.response] ?? models.response}` },
    { label: "Clasificación", value: dClassify * 30, hint: `${msgs} mensajes/día · ${SHORT_MODEL[models.classify] ?? models.classify}` },
    { label: "Evaluación de calidad", value: dGrader * 30, hint: `${SHORT_MODEL[models.grader] ?? models.grader}` },
    { label: "Dreams (aprendizaje)", value: dDreams * 30, hint: `fijo · ${SHORT_MODEL[models.dreams] ?? models.dreams}` },
  ].sort((a, b) => b.value - a.value);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-4">
        <label className="block">
          <span className="text-xs font-medium text-neutral-600">Mensajes entrantes por día</span>
          <input
            type="number"
            min={1}
            max={100000}
            value={msgs}
            onChange={(e) => setMsgs(Math.max(1, parseInt(e.target.value || "1", 10)))}
            className="mt-1 block w-40 rounded-lg border border-neutral-300 px-3 py-2 text-sm font-mono focus:border-neutral-900 focus:outline-none"
          />
        </label>
        <input
          type="range"
          min={10}
          max={2000}
          step={10}
          value={Math.min(msgs, 2000)}
          onChange={(e) => setMsgs(parseInt(e.target.value, 10))}
          className="w-full accent-neutral-900 sm:flex-1"
        />
      </div>

      {/* Modelos del escenario — arrancan en los asignados, se pueden simular */}
      <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-xs font-medium text-neutral-600">Escenario:</span>
          {modelRows.map(({ key, label }) => (
            <label key={key} className="flex items-center gap-1.5 text-xs text-neutral-600">
              {label}
              <select
                value={models[key]}
                onChange={(e) => setModels((m) => ({ ...m, [key]: e.target.value }))}
                className="rounded-lg border border-neutral-300 bg-white px-2 py-1 text-xs font-medium focus:border-neutral-900 focus:outline-none"
              >
                {ALLOWED_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {SHORT_MODEL[m] ?? m}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {simulating ? (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
              simulación — distinto a lo asignado
            </span>
          ) : (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
              modelos asignados
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-indigo-600">Costo mensual estimado</p>
          <p className="mt-1 text-2xl font-bold text-indigo-900">{usd(monthly)}</p>
          <p className="mt-0.5 text-xs text-indigo-700">≈ {usd(daily)} por día</p>
        </div>
        <div className="rounded-xl border border-neutral-200 bg-white p-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">Por mensaje atendido</p>
          <p className="mt-1 text-2xl font-bold text-neutral-900">{usd(msgs > 0 ? daily / msgs : 0, 4)}</p>
          <p className="mt-0.5 text-xs text-neutral-500">todo incluido</p>
        </div>
        <div className="rounded-xl border border-neutral-200 bg-white p-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">Respuestas por día</p>
          <p className="mt-1 text-2xl font-bold text-neutral-900">{Math.round(sessions)}</p>
          <p className="mt-0.5 text-xs text-neutral-500">el agrupado de mensajes ahorra sesiones</p>
        </div>
      </div>

      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between rounded-lg bg-neutral-50 px-3 py-2 text-sm">
            <span className="text-neutral-700">
              {r.label} <span className="ml-1 text-xs text-neutral-400">{r.hint}</span>
            </span>
            <span className="font-mono font-semibold text-neutral-900">{usd(r.value)}/mes</span>
          </div>
        ))}
      </div>

      <p className="text-xs text-neutral-400">
        El perfil de tokens (cuánto consume cada evento) sale de los datos reales de este deployment; el precio se
        calcula con el modelo elegido arriba. Cambiar de modelo cambia el precio por token, no la cantidad de tokens.
      </p>
    </div>
  );
}
