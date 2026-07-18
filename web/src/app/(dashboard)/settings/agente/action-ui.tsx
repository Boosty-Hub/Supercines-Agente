"use client";

// Tarjeta de capacidad de los paneles de Acciones (CRM y Shopify).
//
// El Switch vive en @/components/ui (fuente canónica, con prop `tone`). Acá
// había una tercera copia del mismo componente — se eliminó; `tone="brand"`
// reproduce el look que tenía (activo = neutral-900).

import { Switch } from "@/components/ui";

export function CapabilityCard({
  icon,
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  icon: string;
  title: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      className={
        "flex items-start justify-between gap-4 rounded-xl border p-4 transition-colors " +
        (disabled ? "border-neutral-200 bg-neutral-50" : "border-neutral-200 bg-white")
      }
    >
      <div className="flex items-start gap-3">
        <span className="text-xl leading-none">{icon}</span>
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-neutral-900">{title}</p>
          <p className="text-xs text-neutral-500">{description}</p>
        </div>
      </div>
      <Switch checked={checked} disabled={disabled} onChange={onChange} tone="brand" />
    </div>
  );
}
