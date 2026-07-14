"use client";

import { useState } from "react";
import { Badge, Button, Switch } from "@/components/ui";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Edit, Trash } from "@/components/ui/icons";
import { type Promo, type PromoStatus, promoStatus, vigenciaLabel } from "./promo-utils";

type PromoCardProps = {
  promo: Promo;
  onToggle: (id: string, next: boolean) => void;
  onEdit: (promo: Promo) => void;
  onDelete: (id: string) => void;
};

const statusBadge: Record<PromoStatus, { color: "green" | "blue" | "neutral" | "amber"; label: string }> = {
  activa:     { color: "green",   label: "Activa" },
  programada: { color: "blue",    label: "Programada" },
  finalizada: { color: "neutral", label: "Finalizada" },
  apagada:    { color: "amber",   label: "Apagada" },
};

export default function PromoCard({ promo, onToggle, onEdit, onDelete }: PromoCardProps) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const status = promoStatus(promo, new Date());
  const { color, label } = statusBadge[status];
  const vigencia = vigenciaLabel(promo);

  return (
    <>
      <div className="rounded-xl border border-neutral-200 bg-white shadow-card flex flex-col gap-3 p-4">
        {/* Header: badges + actions */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge color={color}>{label}</Badge>
            <Badge color={promo.kind === "evento" ? "violet" : "neutral"}>
              {promo.kind === "evento" ? "Evento" : "Promo"}
            </Badge>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              aria-label="Editar"
              onClick={() => onEdit(promo)}
              className="p-1.5"
            >
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

        {/* Name */}
        <p className="text-sm font-semibold text-neutral-900 leading-snug">{promo.name}</p>

        {/* Vigencia */}
        <p className="text-xs text-neutral-500">{vigencia}</p>

        {/* Footer: content preview + toggle */}
        <div className="flex items-end justify-between gap-2">
          <p className="text-xs text-neutral-600 line-clamp-2 flex-1">{promo.content}</p>
          <Switch
            checked={promo.enabled}
            onChange={(next) => onToggle(promo.id, next)}
            tone="emerald"
            aria-label={promo.enabled ? "Desactivar promoción" : "Activar promoción"}
          />
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Borrar promo"
        description="Esta acción es irreversible. La promo dejará de estar disponible para el agente."
        confirmLabel="Borrar"
        cancelLabel="Cancelar"
        tone="danger"
        busy={deleting}
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          setDeleting(true);
          await onDelete(promo.id);
          setDeleting(false);
          setConfirming(false);
        }}
      />
    </>
  );
}
