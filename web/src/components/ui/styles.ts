/**
 * Constantes de clases Tailwind reutilizables.
 * Centraliza combinaciones que no pueden vivir en theme.extend (foco, disabled, placeholder).
 * Importar desde aquí; no redefinir inline en las páginas.
 */

/** Estilo base para campos de texto */
export const inputCls =
  "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm transition-colors " +
  "placeholder:text-neutral-400 focus:border-brand focus:outline-none " +
  "focus:ring-1 focus:ring-brand disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:opacity-60";

/** Estilo para select — mismo box que input */
export const selectCls = inputCls + " bg-white";

/** Estilo para textarea */
export const textareaCls = inputCls + " min-h-[6rem] resize-y";

/** Estilo para etiquetas de campo — unifica los xs/sm divergentes del código actual */
export const labelCls = "block text-sm font-medium text-neutral-700";

/** Estilo para mensajes de error — unifica xs/sm divergentes */
export const errorCls = "text-sm text-red-600";

/**
 * Anillo de foco accesible para elementos interactivos (botones, switches, etc.).
 * Usa el token --ring para que un clon pueda personalizar el color del foco.
 */
export const focusRing =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

/** Tarjeta estándar del dashboard */
export const cardCls =
  "rounded-xl border border-neutral-200 bg-white shadow-card";

/** Tarjeta clickeable con hover-lift */
export const hoverCardCls =
  cardCls + " hover:shadow-pop hover:-translate-y-0.5 transition-all duration-200 cursor-pointer";

/** Contenedor de página estándar */
export const pageCls =
  "mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 space-y-6";
