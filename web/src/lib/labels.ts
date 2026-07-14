/**
 * Mapa de términos técnicos a texto legible en español para el operador.
 * Ningún término técnico de este mapa debe aparecer como texto visible en producción.
 * REQ-04: humanización de textos técnicos.
 */
export const LABELS: Record<string, string> = {
  // Configuración de publicación
  auto_reply: "Respuesta automática",
  requires_review: "Revisión humana",
  bypass_review: "Publicar sin revisión",
  publishing_enabled: "Publicación activa",
  agent_enabled: "Agente activo",

  // Estados del sistema (inglés técnico → español legible)
  ENABLED: "Activo",
  "SHADOW MODE": "Modo validación",

  // Campos de CRM
  kommo_lead_id: "ID de contacto",

  // Configuración del agente
  requires_human_review: "Requiere revisión",
  force_review: "Forzar revisión",

  // Columnas de verticales
  Slug: "Identificador",
  slug: "Identificador",
  ignorar: "No clasificar",
};

/**
 * Devuelve el texto legible para el operador dado un término técnico.
 * Si no existe en el mapa, devuelve el término original.
 */
export function label(key: string): string {
  return LABELS[key] ?? key;
}
