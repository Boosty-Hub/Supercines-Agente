"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog } from "@/components/ui";

export function AcknowledgeButton({ alertId }: { alertId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function ack() {
    setBusy(true);
    await fetch(`/api/alerts/${alertId}/acknowledge`, { method: "POST" });
    setBusy(false);
    router.refresh();
  }
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={ack}
      disabled={busy}
      busy={busy}
    >
      Marcar como visto
    </Button>
  );
}

export function AcknowledgeAllButton({ count }: { count: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function ack() {
    setBusy(true);
    await fetch("/api/alerts/acknowledge-all", { method: "POST" });
    setBusy(false);
    setConfirming(false);
    router.refresh();
  }

  return (
    <>
      <Button
        variant="primary"
        onClick={() => setConfirming(true)}
        disabled={count === 0}
      >
        Marcar todo como visto ({count})
      </Button>
      <ConfirmDialog
        open={confirming}
        title={`Marcar ${count} alertas como vistas`}
        description="Todas las alertas pendientes quedarán marcadas como vistas."
        confirmLabel="Confirmar"
        tone="default"
        busy={busy}
        onConfirm={ack}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
