"use client";

// Reusable panel that shows the ready-to-paste Kommo webhook URL + the exact
// steps to add it in Kommo. Used in the /setup wizard (Kommo step) and /settings.
// The URL is the kommo-webhook Edge Function: <SUPABASE_URL>/functions/v1/kommo-webhook

import { useState } from "react";

const STEPS = [
  "En Kommo, andá a Configuración → Integraciones.",
  "Buscá «Webhooks» y abrilo → «Añadir webhook».",
  "Pegá la URL de arriba en el campo de la URL del webhook.",
  "Tildá los eventos: «Mensaje entrante» (chat), «Lead añadido» y «Lead modificado».",
  "Guardá. Listo: los mensajes de tus leads ya llegan a tu agente.",
];

export function KommoWebhookPanel() {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const url = base ? `${base}/functions/v1/kommo-webhook` : "";
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm space-y-4 text-sm">
      <div>
        <h3 className="text-sm font-semibold tracking-tight text-neutral-900">
          Conectá el webhook de Kommo
        </h3>
        <p className="mt-1 text-xs text-neutral-500">
          Para que los mensajes de tus leads lleguen al agente, Kommo tiene que
          avisarle a esta dirección cada vez que pasa algo. Pegala como webhook
          en Kommo (una sola vez).
        </p>
      </div>

      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 space-y-2">
        <p className="text-xs font-medium text-neutral-600">URL del webhook</p>
        <div className="flex items-start justify-between gap-2">
          <code className="break-all text-xs text-neutral-900">
            {url || "Configurá Supabase primero (paso 1)."}
          </code>
          <button
            type="button"
            onClick={copy}
            disabled={!url}
            className="flex-shrink-0 rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:opacity-40"
          >
            {copied ? "¡Copiado!" : "Copiar"}
          </button>
        </div>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-xs text-violet-600 underline"
          >
            Probar (abre en otra pestaña — debe decir «kommo-webhook OK»)
          </a>
        )}
      </div>

      <details className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
        <summary className="cursor-pointer text-xs font-medium text-neutral-600 select-none hover:text-neutral-900">
          ¿Cómo conectarlo en Kommo? (5 pasos)
        </summary>
        <ol className="mt-3 space-y-2">
          {STEPS.map((s, i) => (
            <li key={i} className="flex gap-3 text-xs text-neutral-600">
              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-neutral-100 text-[10px] font-semibold text-neutral-700">
                {i + 1}
              </span>
              <span className="leading-relaxed">{s}</span>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
