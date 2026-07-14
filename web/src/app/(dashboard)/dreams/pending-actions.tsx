"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog } from "@/components/ui";

// Aprobar mueve el dream a /dreams/ (el agente lo adopta al instante).
// Descartar lo borra definitivamente.
export default function PendingDreamActions({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "discard" | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function approve() {
    setBusy("approve");
    setActionError(null);
    const res = await fetch(`/api/dreams/${encodeURIComponent(id)}/approve`, {
      method: "POST",
    });
    setBusy(null);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setActionError(`No se pudo aprobar: ${j.error ?? res.status}`);
      return;
    }
    router.refresh();
  }

  async function discard() {
    setBusy("discard");
    setActionError(null);
    const res = await fetch(`/api/dreams/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    setBusy(null);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setActionError(`No se pudo descartar: ${j.error ?? res.status}`);
      setConfirmingDiscard(false);
      return;
    }
    setConfirmingDiscard(false);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-end gap-3">
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={approve}
          disabled={busy !== null}
          busy={busy === "approve"}
        >
          {busy === "approve" ? "Aprobando…" : "Aprobar"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setConfirmingDiscard(true)}
          disabled={busy !== null}
          className="text-red-600 hover:text-red-700"
        >
          Descartar
        </Button>
      </div>
      {actionError && <p className="text-xs text-red-600 text-right">{actionError}</p>}
      <ConfirmDialog
        open={confirmingDiscard}
        title="Descartar aprendizaje"
        description="Este aprendizaje no se aplicará nunca y no se puede recuperar."
        confirmLabel="Descartar"
        tone="danger"
        busy={busy === "discard"}
        onConfirm={discard}
        onCancel={() => setConfirmingDiscard(false)}
      />
    </div>
  );
}
