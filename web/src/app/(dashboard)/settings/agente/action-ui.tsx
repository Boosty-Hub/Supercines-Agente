"use client";

// Switches estilo iOS + tarjeta de capacidad. Compartidos por los paneles de
// Acciones (CRM y Shopify) en /agent → Acciones.

export function Switch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:ring-offset-2 " +
        (disabled ? "cursor-not-allowed opacity-40 " : "") +
        (checked ? "bg-neutral-900" : "bg-neutral-300")
      }
    >
      <span
        className={
          "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform " +
          (checked ? "translate-x-5" : "translate-x-0.5")
        }
      />
    </button>
  );
}

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
      <Switch checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  );
}
