// Modelos por componente del pipeline — editable desde /consumo.
// Cada key vive en runtime_config (DB-first); el default es el modelo con el
// que se diseñó cada componente. Los precios viven en lib/ai-pricing — agregar
// un modelo acá requiere también su fila de pricing.

export const ALLOWED_MODELS = ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-8"] as const;

export const MODEL_LABELS: Record<string, string> = {
  "claude-haiku-4-5": "Haiku 4.5 — el más barato ($1/$5 por MTok)",
  "claude-sonnet-4-6": "Sonnet 4.6 — equilibrio ($3/$15 por MTok)",
  "claude-opus-4-8": "Opus 4.8 — el más capaz ($5/$25 por MTok)",
};

// key de runtime_config → default actual del pipeline
export const MODEL_KEYS: Record<string, string> = {
  AGENT_MODEL: "claude-sonnet-4-6",
  CLASSIFY_MODEL: "claude-haiku-4-5",
  COMMENT_REPLY_MODEL: "claude-haiku-4-5",
  GRADER_MODEL: "claude-haiku-4-5",
  DREAMS_MODEL: "claude-sonnet-4-6",
};

// Descripción humana de qué gobierna cada key (para el panel de /consumo).
export const MODEL_KEY_INFO: Record<string, { label: string; detail: string }> = {
  AGENT_MODEL: {
    label: "Respuestas del agente",
    detail: "El modelo que redacta cada respuesta al cliente (sesión CMA). Es donde se va casi todo el gasto. Cambiarlo actualiza el agente en Anthropic.",
  },
  CLASSIFY_MODEL: {
    label: "Clasificación de mensajes",
    detail: "Precalifica cada mensaje entrante (vertical, urgencia, toxicidad). Corre una vez por mensaje.",
  },
  COMMENT_REPLY_MODEL: {
    label: "Respuesta pública a comentarios",
    detail: "Redacta el textito público cuando un comentario de Instagram tiene la respuesta pública activada.",
  },
  GRADER_MODEL: {
    label: "Evaluación de calidad",
    detail: "Los graders que puntúan cada respuesta del agente (outcomes). Corre por cada borrador × grader activo.",
  },
  DREAMS_MODEL: {
    label: "Dreams (aprendizaje nocturno)",
    detail: "Destila aprendizajes de las conversaciones del día/semana. Corre 1 vez por día + 1 por semana.",
  },
};
