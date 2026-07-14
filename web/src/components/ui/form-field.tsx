import React from "react";
import { labelCls, errorCls } from "./styles";

export type FormFieldProps = {
  label: string;
  /** id del input para asociar el label */
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: React.ReactNode;
};

/**
 * Contenedor de campo de formulario con label, hint y error unificados.
 * REQ-06-C: columna única; REQ-01 (sistema).
 * Importa labelCls y errorCls de styles.ts para consistencia visual.
 * Server-safe (sin directiva "use client").
 */
export function FormField({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
}: FormFieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className={labelCls}>
        {label}
        {required && (
          <span className="ml-0.5 text-red-500" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {hint && !error && (
        <p className="text-xs text-neutral-500">{hint}</p>
      )}
      {error && (
        <p className={errorCls}>{error}</p>
      )}
    </div>
  );
}
