"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PromptConflict } from "@/lib/agent-prompt-sync";

// El prompt del agente en Anthropic fue modificado FUERA del dashboard. Sincronizar
// lo pisaría sin avisar, así que no se sincronizó: el usuario decide, de forma
// explícita, qué versión queda (importar la viva a la base, o sobrescribirla con la
// de la base). Ver lib/agent-prompt-sync.ts.
const TITLES: Record<PromptConflict["kind"], string> = {
  prompt_changed: "El prompt del agente fue modificado fuera del dashboard",
  version_ahead: "El agente en Anthropic tiene una versión más nueva que la sincronizada",
  first_sync_differs: "El prompt del agente en Anthropic difiere del de la plataforma",
};

export function AgentPromptConflict({
  conflict,
  onResolved,
}: {
  conflict: PromptConflict;
  /** Se llama tras resolver con éxito (antes del refresh), p. ej. para cerrar un panel embebido. */
  onResolved?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"overwrite" | "import_live" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const hasDiff = conflict.diff.some((l) => l.type !== "same");
  const canImport = conflict.live.operatorPrompt !== null;

  async function resolve(kind: "overwrite" | "import_live") {
    const aviso =
      kind === "overwrite"
        ? "Esto REEMPLAZA el prompt vivo en Anthropic por el de la plataforma. Lo editado por fuera se pierde. ¿Continuar?"
        : "Esto REEMPLAZA el prompt del operador guardado en la plataforma por el que está vivo en Anthropic. ¿Continuar?";
    if (!window.confirm(aviso)) return;
    setBusy(kind);
    setErr(null);
    try {
      const res = await fetch("/api/agent/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolve: kind }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      onResolved?.();
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No se pudo resolver");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900" role="alert">
      <p className="font-semibold">{TITLES[conflict.kind]}</p>
      <p className="mt-1 text-xs">
        No se sincronizó nada para no pisar esos cambios. Elegí qué versión queda:
      </p>
      {hasDiff ? (
        <div className="mt-3 max-h-72 overflow-auto rounded-lg border border-red-200 bg-white p-2 font-mono text-[11px] leading-snug">
          <p className="mb-1 font-sans text-[10px] text-neutral-500">
            <span className="mr-2 rounded bg-red-100 px-1 text-red-700">− en Anthropic (vivo)</span>
            <span className="rounded bg-emerald-100 px-1 text-emerald-700">+ en la plataforma (se enviaría)</span>
          </p>
          {conflict.diff.map((l, i) => (
            <div
              key={i}
              className={
                "whitespace-pre-wrap break-words px-1 " +
                (l.type === "del" ? "bg-red-50 text-red-800" : l.type === "add" ? "bg-emerald-50 text-emerald-800" : "text-neutral-500")
              }
            >
              {l.type === "del" ? "− " : l.type === "add" ? "+ " : "  "}
              {l.text || " "}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs">
          El texto del prompt es el mismo, pero la versión viva ({conflict.live.version ?? "?"}) es más nueva que la última
          sincronizada desde acá: alguien cambió el agente por fuera (herramientas, modelo u otra opción).
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => resolve("import_live")}
          disabled={busy !== null || !canImport}
          title={canImport ? undefined : "No se pudo separar el prompt del operador del agente vivo"}
          className="rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-800 disabled:opacity-40"
        >
          {busy === "import_live" ? "Importando…" : "Importar el vivo a la plataforma"}
        </button>
        <button
          type="button"
          onClick={() => resolve("overwrite")}
          disabled={busy !== null}
          className="rounded-lg bg-red-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
        >
          {busy === "overwrite" ? "Sobrescribiendo…" : "Sobrescribir con el de la plataforma"}
        </button>
        {err && <span className="text-xs text-red-700">{err}</span>}
      </div>
    </div>
  );
}
