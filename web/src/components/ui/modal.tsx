"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "./icons";

export type ModalSize = "md" | "lg" | "xl";

export type ModalProps = {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  size?: ModalSize;
  /** Zona de acciones inferior opcional */
  footer?: React.ReactNode;
};

const maxWidthCls: Record<ModalSize, string> = {
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-3xl",
};

/**
 * Modal con portal a document.body.
 * REQ-01 (sistema), REQ-06-D (full-height en móvil con scroll interno).
 * Cierra con Escape. Soporta `open` prop o render condicional externo.
 */
export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  size = "lg",
  footer,
}: ModalProps) {
  // Guard de hidratación: no renderizar el portal en SSR
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Manejador de tecla Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-neutral-900/50 backdrop-blur-sm p-4 sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={[
          "relative my-8 w-full rounded-2xl border border-neutral-200 bg-white shadow-modal overflow-hidden",
          maxWidthCls[size],
        ].join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        {/* Cabecera */}
        <div className="flex items-start justify-between gap-4 border-b border-neutral-100 px-6 py-4">
          <div>
            <h2
              id="modal-title"
              className="text-base font-semibold tracking-tight text-neutral-900"
            >
              {title}
            </h2>
            {subtitle && (
              <p className="mt-0.5 text-xs font-mono text-neutral-500">
                {subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-lg p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <X size={18} />
          </button>
        </div>

        {/* Contenido */}
        <div className="p-6">{children}</div>

        {/* Pie opcional */}
        {footer && (
          <div className="flex flex-col-reverse gap-2 border-t border-neutral-100 px-6 py-4 sm:flex-row sm:justify-end">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
