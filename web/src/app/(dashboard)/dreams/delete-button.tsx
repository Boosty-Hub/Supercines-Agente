"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog } from "@/components/ui";

// Borra un aprendizaje del Memory Store. Tras borrarlo el agente deja
// de leerlo y no lo adopta en próximas respuestas.
export default function DeleteDreamButton({
  id,
  redirectAfter = false,
}: {
  id: string;
  redirectAfter?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function del() {
    setBusy(true);
    setDeleteError(null);
    const res = await fetch(`/api/dreams/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setDeleteError(`No se pudo borrar: ${j.error ?? res.status}`);
      setConfirming(false);
      return;
    }
    setConfirming(false);
    if (redirectAfter) router.push("/dreams");
    router.refresh();
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setConfirming(true)}
        disabled={busy}
        className="text-red-600 hover:text-red-700"
      >
        Borrar
      </Button>
      {deleteError && <p className="text-xs text-red-600">{deleteError}</p>}
      <ConfirmDialog
        open={confirming}
        title="Borrar aprendizaje"
        description="El agente dejará de usar este aprendizaje en futuras respuestas. Esta acción no se puede deshacer."
        confirmLabel="Borrar"
        tone="danger"
        busy={busy}
        onConfirm={del}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
