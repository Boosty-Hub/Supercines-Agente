"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KommoFieldPicker, type KommoFieldLite } from "@/components/kommo-field-picker";
import { CollapsibleSection } from "@/components/collapsible-section";

// Apagar el agente para un lead puntual desde la ficha de Kommo. Vive en
// Agente → Filtros porque es otra forma de que el agente NO responda (por lead),
// junto a menciones, canales, etapas y categorías.
export function AgentOffConfig({
  fieldId,
  fieldName,
}: {
  fieldId: number | null;
  fieldName: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(field: KommoFieldLite | null) {
    setBusy(true);
    setSaved(false);
    setError(null);
    const res = await fetch("/api/agent-off", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fieldId: field?.id ?? null, fieldName: field?.name ?? null }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError((j as { error?: string }).error ?? "error");
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <CollapsibleSection
      title="Apagar agente (por lead)"
      summary={fieldName ? `Activo · campo "${fieldName}"` : "Desactivado"}
      description={
        <>
          Elegí un campo de Kommo del lead (recomendado: tipo <span className="font-medium">casilla
          sí/no</span>). Cuando una asesora lo encienda en la ficha de un lead, el agente{" "}
          <span className="font-medium text-neutral-700">deja de responderle</span> a ese lead — sin
          tocar nada técnico, directo desde la ficha en Kommo.
        </>
      }
    >
      <div className="max-w-md space-y-2">
        <KommoFieldPicker
          entity="leads"
          value={fieldId}
          allowNone
          noneLabel="— Desactivado —"
          onChange={save}
        />
        <div className="flex items-center gap-3 text-xs">
          {busy && <span className="text-neutral-400">Guardando…</span>}
          {saved && !busy && <span className="text-emerald-600">✓ Guardado</span>}
          {error && <span className="text-red-600">{error}</span>}
          {!busy && !saved && fieldName && (
            <span className="text-neutral-500">
              Activo: <span className="font-medium text-neutral-700">{fieldName}</span>
            </span>
          )}
        </div>
      </div>
    </CollapsibleSection>
  );
}
