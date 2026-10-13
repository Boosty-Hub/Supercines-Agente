"use client";

// Aviso de desfase entre el agente vivo en Anthropic y lo que espera este código
// (scaffold desactualizado) o la config (modelo distinto). Ver lib/agent-sync-status.ts
// para por qué la sincronización es un botón y no automática.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MODEL_NAMES } from "@/lib/model-config";
import type { PromptConflict } from "@/lib/agent-prompt-sync";
import { interpretSyncResponse } from "@/lib/sync-response";
import { AgentPromptConflict } from "@/components/agent-prompt-conflict";

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
  // 409 de /api/agent/sync: el prompt vivo se editó fuera del dashboard. No es un error
  // para mostrar crudo: se muestra el panel de resolución con el diff que trajo el 409.
  const [conflict, setConflict] = useState<PromptConflict | null>(null);
  if (conflict) return <AgentPromptConflict conflict={conflict} onResolved={() => setConflict(null)} />;
  if (!scaffoldStale && !modelDrift) return null;

  async function sync() {
    setBusy(true);
    setMsg(null);
    try {
      // 1) scaffold/tools (no toca el modelo)  2) modelo, si difiere
      const r1 = await fetch("/api/agent/sync", { method: "POST" });
      const o1 = interpretSyncResponse(r1.status, await r1.json().catch(() => null));
      if (o1.kind === "conflict") {
        setConflict(o1.conflict);
        return;
      }
      if (o1.kind === "error") throw new Error(o1.message);
      if (modelDrift) {
        const r2 = await fetch("/api/usage/models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ AGENT_MODEL: configModel }),
        });
        const o2 = interpretSyncResponse(r2.status, await r2.json().catch(() => null));
        if (o2.kind === "conflict") {
          setConflict(o2.conflict);
          return;
        }
        if (o2.kind === "error") throw new Error(o2.message);
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
