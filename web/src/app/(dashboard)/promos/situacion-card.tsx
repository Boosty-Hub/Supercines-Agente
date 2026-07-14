"use client";

import { useState } from "react";
import { Badge, Button, Switch } from "@/components/ui";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Edit, Trash } from "@/components/ui/icons";
import { type Situacion, type SituacionStatus, situacionStatus, vigenciaLabel } from "./situacion-utils";

type SituacionCardProps = {
  situacion: Situacion;
  onToggle: (id: string, next: boolean) => void;
  onEdit: (situacion: Situacion) => void;
  onDelete: (id: string) => void;
};

const statusBadge: Record<SituacionStatus, { color: "green" | "blue" | "neutral" | "amber"; label: string }> = {
  activa:     { color: "green",   label: "Activa" },
  programada: { color: "blue",    label: "Programada" },
  finalizada: { color: "neutral", label: "Finalizada" },
  apagada:    { color: "amber",   label: "Apagada" },
};

export default function SituacionCard({ situacion, onToggle, onEdit, onDelete }: SituacionCardProps) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const status = situacionStatus(situacion, new Date());
  const { color, label } = statusBadge[status];
  const vigencia = vigenciaLabel(situacion);

  return (
    <>
      <div className="rounded-xl border border-neutral-200 bg-white shadow-card flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <Badge color={color}>{label}</Badge>
          <div className="flex items-center gap-1 shrink-0">
            <Button variant="ghost" size="sm" aria-label="Editar" onClick={() => onEdit(situacion)} className="p-1.5">
              <Edit size={15} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Borrar"
              onClick={() => setConfirming(true)}
              className="p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50"
            >
              <Trash size={15} />
            </Button>
          </div>
        </div>

        <p className="text-sm font-semibold text-neutral-900 leading-snug">{situacion.title}</p>
        <p className="text-xs text-neutral-500">{vigencia}</p>

        <div className="flex items-end justify-between gap-2">
          <p className="text-xs text-neutral-600 line-clamp-2 flex-1">{situacion.content}</p>
          <Switch
            checked={situacion.enabled}
            onChange={(next) => onToggle(situacion.id, next)}
            tone="emerald"
            aria-label={situacion.enabled ? "Desactivar situación" : "Activar situación"}
          />
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Borrar situación"
        description="Esta acción es irreversible. El agente dejará de tener en cuenta esta situación."
        confirmLabel="Borrar"
        cancelLabel="Cancelar"
        tone="danger"
        busy={deleting}
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          setDeleting(true);
          await onDelete(situacion.id);
          setDeleting(false);
          setConfirming(false);
        }}
      />
    </>
  );
}
