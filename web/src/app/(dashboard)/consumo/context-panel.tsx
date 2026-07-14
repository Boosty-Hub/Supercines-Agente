"use client";

// "¿Qué pesa adentro de una sesión?" — mide en vivo la composición del
// contexto: system prompt + master store (voz/kb/dreams) + memoria por lead,
// y lo contrasta con lo que cada sesión escribe/relee de caché. Dinámico:
// funciona para cualquier cliente montado con este template.

import { useState } from "react";

type ContextData = {
  promptTokens: number;
  master: { prefix: string; files: number; tokens: number; readByAgent: boolean }[];
  leads: { count: number; avgTokens: number; maxTokens: number };
};

const PREFIX_LABELS: Record<string, string> = {
  "/voice": "Voz del operador",
  "/kb": "Knowledge base destilada",
  "/dreams": "Dreams activos (el agente los lee SIEMPRE)",
  "/dreams-pending": "Dreams pendientes (el agente NO los lee)",
};

function tok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

export function ContextPanel({
  avgCacheWriteTok,
  avgCacheReadTok,
}: {
  avgCacheWriteTok: number;
  avgCacheReadTok: number;
}) {
  const [data, setData] = useState<ContextData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function analyze() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/usage/context");
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al medir");
    } finally {
      setLoading(false);
    }
  }

  if (!data) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-neutral-600">
          Mide en vivo cuánto pesa cada pieza del material que el agente lee antes de responder (reglas, voz, KB,
          dreams, memoria por lead) y lo compara con todo lo que cada sesión termina leyendo — para saber si
          conviene recortar contenido o reducir los pasos de la sesión.
        </p>
        <button
          type="button"
          onClick={analyze}
          disabled={loading}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {loading ? "Midiendo stores…" : "Medir composición del contexto"}
        </button>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    );
  }

  const knowledge =
    data.promptTokens +
    data.master.filter((m) => m.readByAgent).reduce((s, m) => s + m.tokens, 0) +
    data.leads.avgTokens;
  const machinery = Math.max(0, avgCacheWriteTok - knowledge);
  const knowledgeShare = avgCacheWriteTok > 0 ? Math.min(100, (knowledge / avgCacheWriteTok) * 100) : 0;

  const rows: { label: string; tokens: number; muted?: boolean }[] = [
    { label: "System prompt (voz + reglas + scaffold)", tokens: data.promptTokens },
    ...data.master.map((m) => ({
      label: PREFIX_LABELS[m.prefix] ?? m.prefix,
      tokens: m.tokens,
      muted: !m.readByAgent,
    })),
    { label: `Memoria del lead (promedio de ${data.leads.count} leads)`, tokens: data.leads.avgTokens },
  ];
  const maxTok = Math.max(...rows.map((r) => r.tokens), 1);

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2">
            <span className={`w-72 shrink-0 truncate text-xs ${r.muted ? "text-neutral-400 line-through" : "text-neutral-700"}`} title={r.label}>
              {r.label}
            </span>
            <span
              className={`h-2.5 rounded-full ${r.muted ? "bg-neutral-200" : "bg-emerald-400"}`}
              style={{ width: `${Math.max(2, (r.tokens / maxTok) * 100 * 0.45)}%` }}
            />
            <span className="shrink-0 font-mono text-xs font-semibold text-neutral-800">≈{tok(r.tokens)} tok</span>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-900">
        <p className="font-semibold">Lectura del resultado</p>
        <p className="mt-1 text-xs text-indigo-800">
          Todo el &quot;conocimiento&quot; junto (reglas + dreams + voz + KB + memoria del lead) suma ≈{tok(knowledge)} tokens
          — solo el {knowledgeShare.toFixed(0)}% de lo que cada sesión lee por primera vez (≈{tok(avgCacheWriteTok)} tok).
          El resto (≈{tok(machinery)} tok), más los ≈{tok(avgCacheReadTok)} tok que repasa durante la sesión, es la
          maquinaria: la conversación, el razonamiento y cada acción del agente que vuelve a repasar todo su material.
          {knowledgeShare < 40
            ? " → Recortar dreams o memorias mueve poco; la palanca es que el agente haga menos vueltas por respuesta."
            : " → El contenido pesa: recortar memoria por lead y reglas sí mueve la aguja."}
        </p>
      </div>

      <p className="text-[11px] text-neutral-400">
        Tokens estimados a 4 letras/token. Memoria del lead más pesada: ≈{tok(data.leads.maxTokens)} tok.
        Medido en vivo contra la memoria real de este agente.
      </p>
    </div>
  );
}
