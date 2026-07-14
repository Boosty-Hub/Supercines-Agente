import React from "react";
import { focusRing } from "./styles";
import { Spinner } from "./icons";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";
export type ButtonSize = "sm" | "md";

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Muestra un spinner y deshabilita el botón mientras está activo */
  busy?: boolean;
  /** Ícono opcional a la izquierda del texto */
  leftIcon?: React.ReactNode;
};

const variantCls: Record<ButtonVariant, string> = {
  primary:
    "bg-brand text-brand-foreground hover:bg-brand-strong shadow-sm active:scale-[0.98]",
  secondary:
    "border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 shadow-sm active:scale-[0.98]",
  ghost:
    "text-neutral-700 hover:bg-neutral-100",
  danger:
    "bg-red-600 text-white hover:bg-red-700 shadow-sm active:scale-[0.98]",
  link:
    "text-neutral-600 hover:text-neutral-900 hover:underline px-0 py-0",
};

const sizeCls: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
};

/**
 * Botón presentacional con variantes y tamaños.
 * REQ-01-B: variantes primary/secondary/ghost/danger/link.
 * REQ-07-A: focus-visible ring accesible.
 * REQ-08-A: transition-colors en todos los estados.
 */
export function Button({
  variant = "primary",
  size = "md",
  busy = false,
  leftIcon,
  className = "",
  disabled,
  children,
  ...props
}: ButtonProps) {
  const isLink = variant === "link";
  const base = [
    "inline-flex items-center justify-center gap-2 font-medium rounded-lg",
    "transition duration-150",
    "disabled:opacity-50 disabled:cursor-not-allowed",
    focusRing,
    isLink ? "" : sizeCls[size],
    variantCls[variant],
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button {...props} disabled={disabled ?? busy} className={base}>
      {busy ? (
        <Spinner size={14} className="animate-spin" aria-hidden />
      ) : leftIcon ? (
        leftIcon
      ) : null}
      {children}
    </button>
  );
}
