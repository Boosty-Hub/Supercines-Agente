"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { DiffLine, PromptConflict } from "@/lib/agent-prompt-sync";
import { interpretSyncResponse } from "@/lib/sync-response";

// El prompt del agente en Anthropic fue modificado FUERA del dashboard. Sincronizar
// lo pisaría sin avisar, así que no se sincronizó: el usuario decide, de forma
// explícita, qué versión queda (importar la viva a la base, o sobrescribirla con la
// de la base). Ver lib/agent-prompt-sync.ts.
//
// El panel dice EXACTAMENTE qué difiere: el prompt del OPERADOR (lo que se edita en
// /agent) y las instrucciones del SISTEMA (scaffold / acciones de herramientas, que
// pertenecen al código) se muestran en bloques separados, nunca mezclados.
const TITLES: Record<PromptConflict["kind"], string> = {
  prompt_changed: "El prompt del agente fue modificado fuera del dashboard",
  version_ahead: "El agente en Anthropic tiene una versión más nueva que la sincronizada",
  first_sync_differs: "El prompt del operador en Anthropic difiere del de la plataforma",
};

const REASONS = {
  short: "valor demasiado corto",
  common_word: "palabra común",
  shared_value: "mismo valor en dos placeholders",
} as const;

function DiffBlock({ title, lines }: { title: string; lines: DiffLine[] }) {
  return (
    <div className="mt-3 max-h-72 overflow-auto rounded-lg border border-red-200 bg-white p-2 font-mono text-[11px] leading-snug">
      <p className="mb-1 font-sans text-[10px] text-neutral-500">
        <span className="mr-2 font-semibold text-neutral-700">{title}</span>
        <span className="mr-2 rounded bg-red-100 px-1 text-red-700">− en Anthropic (vivo)</span>
        <span className="rounded bg-emerald-100 px-1 text-emerald-700">+ en la plataforma (se enviaría)</span>
      </p>
      {lines.map((l, i) => (
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
  );
}

export function AgentPromptConflict({
  conflict,
  onResolved,
  onStale,
}: {
  conflict: PromptConflict;
  /** El vivo cambió mientras se revisaba: recibe el conflicto actualizado (null si ya no hay nada que decidir). */
  onStale?: (fresh: PromptConflict | null) => void;
  /** Se llama tras resolver con éxito (antes del refresh), p. ej. para cerrar un panel embebido. */
  onResolved?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"overwrite" | "import_live" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const hasDiff = conflict.diff.some((l) => l.type !== "same");
  const operatorIdentical = conflict.scope === "scaffold";
  // Importar un prompt de operador idéntico no aporta nada: lo que difiere es el scaffold, que manda el código.
  const canImport = conflict.importPreview !== null && !operatorIdentical;
  const preview = conflict.importPreview;

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
        // expectedLiveHash: el vivo que se le MOSTRÓ al operador. Si cambió, el servidor aborta (409 stale).
        body: JSON.stringify({ resolve: kind, expectedLiveHash: conflict.liveHash }),
      });
      const outcome = interpretSyncResponse(res.status, await res.json().catch(() => null));
      if (outcome.kind === "stale") {
        setErr(`${outcome.message} Se actualizó el diff.`);
        onStale?.(outcome.conflict);
        router.refresh();
        return;
      }
      if (outcome.kind === "error") throw new Error(outcome.message);
      if (outcome.kind === "conflict") throw new Error("El servidor devolvió un conflicto inesperado. Recargá la página.");
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
      <p className="mt-1 text-xs">{conflict.message}</p>
      <p className="mt-1 text-xs">No se sincronizó nada para no pisar esos cambios. Elegí qué versión queda:</p>

      {hasDiff ? (
        <DiffBlock
          title={conflict.scope === "unknown" ? "System completo" : "Prompt del operador"}
          lines={conflict.diff}
        />
      ) : conflict.scope === "none" ? (
        <p className="mt-2 text-xs">
          El texto del prompt es el mismo, pero la versión viva ({conflict.live.version ?? "?"}) es más nueva que la última
          sincronizada desde acá: alguien cambió el agente por fuera (herramientas, modelo u otra opción).
        </p>
      ) : null}

      {conflict.scaffoldDiff && (
        <details className="mt-2" open={operatorIdentical}>
          <summary className="cursor-pointer text-xs font-medium">
            Instrucciones del sistema (scaffold / acciones de herramientas) {operatorIdentical ? "— lo único que difiere" : "— también difieren"}
          </summary>
          <p className="mt-1 text-[11px] text-neutral-600">
            Esta parte la define el código de la plataforma: al sincronizar se reemplaza por la vigente.
          </p>
          <DiffBlock title="Scaffold" lines={conflict.scaffoldDiff} />
        </details>
      )}

      {canImport && preview && (preview.replaced.length > 0 || preview.ambiguous.length > 0) && (
        <div className="mt-3 rounded-lg border border-red-200 bg-white p-2 text-xs text-neutral-800">
          <p className="font-semibold">Si importás el vivo, los valores conocidos vuelven a ser placeholders</p>
          {preview.replaced.length > 0 && (
            <ul className="mt-1 list-disc pl-4">
              {preview.replaced.map((r) => (
                <li key={r.placeholder}>
                  <code>{r.value}</code> → <code>{r.placeholder}</code> ({r.count})
                </li>
              ))}
            </ul>
          )}
          {preview.ambiguous.length > 0 && (
            <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-amber-900">
              <p className="font-semibold">Ambiguos: se importan tal cual (NO se convierten en placeholder)</p>
              <ul className="mt-1 list-disc pl-4">
                {preview.ambiguous.map((a) => (
                  <li key={a.placeholder}>
                    <code>{a.value}</code> ({a.count} {a.count === 1 ? "aparición" : "apariciones"}; {REASONS[a.reason]}) no se
                    convierte en <code>{a.placeholder}</code>. Si querés que siga al nombre del operador o del store,
                    reemplazalo a mano después.
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => resolve("import_live")}
          disabled={busy !== null || !canImport}
          title={
            operatorIdentical
              ? "El prompt del operador ya es el mismo: no hay nada que importar"
              : canImport
                ? undefined
                : "No se pudo separar el prompt del operador del agente vivo"
          }
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
