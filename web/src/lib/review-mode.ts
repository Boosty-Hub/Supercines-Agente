// Modo de revisión: un tri-estado en la UI, dos columnas en la base.
//
// El mapeo estaba escrito dos veces —en la página que lo lee y en la ruta que lo
// guarda— y el propio comentario de la página admitía que debían coincidir
// ("mismo mapeo que /api/agent/publish"). Acá vive una sola vez, en las dos
// direcciones.
//
//   "todo"   → cada respuesta pasa por revisión humana (auto_reply_mode=review_only)
//   "normal" → revisión según la vertical
//   "sin"    → publica directo, sin revisión (solo válido con publishing on)

export type ReviewMode = "todo" | "normal" | "sin";

export type ReviewColumns = {
  publishing_enabled: boolean;
  bypass_review: boolean;
  auto_reply_mode: string | null;
};

/** Columnas de la base → tri-estado de la UI. */
export function toReviewMode(c: ReviewColumns): ReviewMode {
  if (c.bypass_review && c.publishing_enabled) return "sin";
  if (c.auto_reply_mode === "review_only") return "todo";
  return "normal";
}

/** Tri-estado de la UI → columnas de la base. */
export function fromReviewMode(
  mode: ReviewMode,
  publishing: boolean
): Pick<ReviewColumns, "auto_reply_mode" | "bypass_review"> {
  return {
    auto_reply_mode: mode === "todo" ? "review_only" : "auto",
    // bypass solo puede quedar true con publishing on.
    bypass_review: mode === "sin" && publishing,
  };
}

/** Normaliza un valor arbitrario (body de request) a un ReviewMode válido. */
export function asReviewMode(v: unknown, fallback: ReviewMode = "normal"): ReviewMode {
  return v === "todo" || v === "sin" || v === "normal" ? v : fallback;
}
