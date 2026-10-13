"use client";

// Aviso de desfase entre el agente vivo en Anthropic y lo que espera este código
// (scaffold desactualizado) o la config (modelo distinto). Ver lib/agent-sync-status.ts
// para por qué la sincronización es un botón y no automática.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MODEL_NAMES } from "@/lib/model-config";

export function AgentSyncBanner({
  scaffoldStale,
  modelDrift,
  configModel,
  liveModel,
}: {
  scaffoldStale: boolean;
  modelDrift: boolean;
  configModel: string;
  liveModel: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!scaffoldStale && !modelDrift) return null;

  async function sync() {
    setBusy(true);
    setMsg(null);
    try {
      // 1) scaffold/tools (no toca el modelo)  2) modelo, si difiere
      const r1 = await fetch("/api/agent/sync", { method: "POST" });
      const j1 = await r1.json();
      if (!r1.ok || !j1.ok) throw new Error(j1.error ?? `HTTP ${r1.status}`);
      if (modelDrift) {
        const r2 = await fetch("/api/usage/models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ AGENT_MODEL: configModel }),
        });
        const j2 = await r2.json();
        if (!r2.ok || !j2.ok) throw new Error(j2.error ?? `HTTP ${r2.status}`);
      }
      setMsg({ ok: true, text: "Agente sincronizado con Anthropic." });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Error al sincronizar" });
    } finally {
      setBusy(false);
    }
  }

  const name = (m: string | null) => (m ? MODEL_NAMES[m] ?? m : "desconocido");
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <p className="font-semibold">El agente en Anthropic está desactualizado</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
        {scaffoldStale && (
          <li>
            Sus instrucciones internas (flujo de memoria, formato de salida) son de una versión anterior del sistema. No
            se toca el prompt del operador.
          </li>
        )}
        {modelDrift && (
          <li>
            Corre con {name(liveModel)} pero la configuración dice {name(configModel)}.
          </li>
        )}
      </ul>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={sync}
          disabled={busy}
          className="rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
        >
          {busy ? "Sincronizando…" : "Sincronizar"}
        </button>
        {msg && <span className={`text-xs ${msg.ok ? "text-emerald-700" : "text-red-600"}`}>{msg.text}</span>}
      </div>
    </div>
  );
}
