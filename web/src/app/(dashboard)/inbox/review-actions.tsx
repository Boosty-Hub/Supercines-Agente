"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

// Acción para un mensaje marcado para revisión humana sin draft todavía.
// Dispara al agente (force_review): genera un draft pending que el humano
// aprueba/edita/envía con el DraftActions normal en la misma conversación.
export default function ReviewActions({ messageId }: { messageId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/messages/${messageId}/review-respond`, {
      method: "POST",
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "error");
      return;
    }
    router.refresh();
  }

  return (
    <div className="rounded-2xl rounded-tr-md border border-amber-200 bg-amber-50 px-4 py-3 shadow-sm">
      <p className="mb-2.5 text-xs text-amber-800">
        Marcado para revisión humana. Genera una respuesta del agente para
        revisarla/editarla antes de enviar, o respóndelo manualmente en Kommo.
      </p>
      <Button type="button" variant="primary" size="sm" busy={busy} onClick={generate}>
        {busy ? "Generando…" : "Generar respuesta del agente"}
      </Button>
      {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}
    </div>
  );
}
