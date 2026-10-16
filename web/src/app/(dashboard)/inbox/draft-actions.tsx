"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, inputCls } from "@/components/ui";

export default function DraftActions({
  draftId,
  body,
  status,
}: {
  draftId: string;
  body: string;
  status: string;
}) {
  const router = useRouter();
  // Sin texto (el agente decidió no responder: `skipped`, o un «no responder» que quedó
  // en revisión): el operador escribe la respuesta («responder igual») o lo da por
  // revisado (rechazar = no se responde).
  const noText = !body.trim();
  const [editing, setEditing] = useState(noText);
  const [draftBody, setDraftBody] = useState(body);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "approve" | "reject", payload?: object) {
    setBusy(action);
    setError(null);
    const res = await fetch(`/api/drafts/${draftId}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
    setBusy(null);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "error");
      return;
    }
    setEditing(false);
    router.refresh();
  }

  if (status === "sent" || status === "auto_sent") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
        ✓ Enviado al canal
      </span>
    );
  }
  if (status === "publishing") {
    // Reservado por publish-to-kommo (0074): el servidor y la base rechazan cualquier acción.
    return <span className="text-xs font-medium text-sky-700">Enviando…</span>;
  }
  if (status === "rejected") {
    return <span className="text-xs text-neutral-500">Rechazado</span>;
  }
  if (status === "failed") {
    return <span className="text-xs font-medium text-red-600">Falló publicación</span>;
  }
  // El draft vacío que crea generate-response como lock no llega acá (la página no
  // monta las acciones mientras se redacta); un vacío «skipped» o «no responder» en
  // revisión exige texto para responder (el botón y la ruta lo verifican).

  return (
    <div className="space-y-2.5">
      {editing ? (
        <textarea
          value={draftBody}
          onChange={(e) => setDraftBody(e.target.value)}
          rows={4}
          className={`w-full ${inputCls}`}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {!editing && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
            Editar
          </Button>
        )}
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={busy !== null || (noText && !draftBody.trim())}
          busy={busy === "approve"}
          onClick={() => act("approve", editing ? { body: draftBody } : undefined)}
        >
          {busy === "approve" ? "Enviando…" : noText ? "Responder igual" : editing ? "Aprobar editado" : "Aprobar y enviar"}
        </Button>
        <Button
          type="button"
          variant="danger"
          size="sm"
          disabled={busy !== null}
          onClick={() => act("reject")}
        >
          {noText ? "Marcar revisado (no responder)" : "Rechazar"}
        </Button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
