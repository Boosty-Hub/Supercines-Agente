import React from "react";

export type BadgeColor =
  | "neutral"
  | "green"
  | "amber"
  | "red"
  | "blue"
  | "violet";

export type BadgeSize = "sm" | "md";

/** solid = rounded-full (default); ring = rounded-md con anillo moderno */
export type BadgeVariant = "solid" | "ring";

export type BadgeProps = {
  children: React.ReactNode;
  color?: BadgeColor;
  size?: BadgeSize;
  variant?: BadgeVariant;
  className?: string;
};

const solidColorCls: Record<BadgeColor, string> = {
  neutral: "bg-neutral-100 text-neutral-700",
  green:   "bg-emerald-100 text-emerald-700",
  amber:   "bg-amber-100 text-amber-800",
  red:     "bg-red-100 text-red-700",
  blue:    "bg-blue-100 text-blue-700",
  violet:  "bg-violet-100 text-violet-700",
};

const ringColorCls: Record<BadgeColor, string> = {
  neutral: "bg-neutral-50 text-neutral-700 ring-1 ring-neutral-200",
  green:   "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20",
  amber:   "bg-amber-50 text-amber-700 ring-1 ring-amber-500/20",
  red:     "bg-red-50 text-red-700 ring-1 ring-red-500/20",
  blue:    "bg-blue-50 text-blue-700 ring-1 ring-blue-500/20",
  violet:  "bg-violet-50 text-violet-700 ring-1 ring-violet-500/20",
};

const sizeCls: Record<BadgeSize, string> = {
  sm: "text-[11px]",
  md: "text-xs",
};

/**
 * Badge presentacional con 6 colores semánticos y 2 variantes.
 * REQ-03-C: un solo set de badges en todo el dashboard.
 * variant="solid" (default): rounded-full — para estados en la UI principal.
 * variant="ring": rounded-md con anillo — para tablas y contextos densos.
 * Server-safe (sin directiva "use client").
 */
export function Badge({
  children,
  color = "neutral",
  size = "sm",
  variant = "solid",
  className = "",
}: BadgeProps) {
  const colorCls = variant === "ring" ? ringColorCls[color] : solidColorCls[color];
  const shapeCls = variant === "ring" ? "rounded-md" : "rounded-full";

  return (
    <span
      className={[
        "inline-flex items-center px-2 py-0.5 font-medium",
        shapeCls,
        colorCls,
        sizeCls[size],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </span>
  );
}
