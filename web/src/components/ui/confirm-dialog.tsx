"use client";

import React from "react";
import { Modal } from "./modal";
import { Button } from "./button";

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  /** Texto del botón de confirmación (default: "Confirmar") */
  confirmLabel?: string;
  /** Texto del botón de cancelación (default: "Cancelar") */
  cancelLabel?: string;
  /** danger → botón rojo; default → botón primario */
  tone?: "danger" | "default";
  /** Deshabilita los botones mientras corre onConfirm */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Diálogo de confirmación que reemplaza window.confirm().
 * REQ-02: eliminación de confirm() nativos.
 * El llamador controla el estado `open` y provee el mismo handler que antes
 * disparaba el confirm().
 *
 * @example
 *   const [confirming, setConfirming] = useState(false);
 *   const [deleting, setDeleting] = useState(false);
 *   <Button variant="danger" onClick={() => setConfirming(true)}>Borrar</Button>
 *   <ConfirmDialog
 *     open={confirming}
 *     title="Borrar vertical"
 *     description="Esta acción no se puede deshacer."
 *     confirmLabel="Borrar"
 *     tone="danger"
 *     busy={deleting}
 *     onCancel={() => setConfirming(false)}
 *     onConfirm={async () => { setDeleting(true); await del(); setDeleting(false); setConfirming(false); }}
 *   />
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            busy={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description && (
        <p className="text-sm text-neutral-600">{description}</p>
      )}
    </Modal>
  );
}
