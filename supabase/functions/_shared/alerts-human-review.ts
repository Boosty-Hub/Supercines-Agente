// _shared/alerts-human-review.ts
//
// Decide si un mensaje inbound con `requires_human_review=true` debe disparar
// la alerta `human_review_needed`.
//
// El pipeline marca `messages.ignored=true` (con `ignored_reason`) cuando
// decidió NO responder por una razón LEGÍTIMA: el canal está silenciado
// (`ignored_channels`), el agente está apagado globalmente (`agent_off`), el
// lead está en una etapa fuera de alcance (`ignored_stage_ids`), coincidió una
// regla de silencio, o los comentarios están apagados (`comments_off`) — ver
// `process-inbound/index.ts`. Ninguno de esos casos significa "un humano
// tiene que mirar esto": significa "el pipeline decidió, a propósito, no
// meterse". Sin este filtro, cualquier conversación que el pipeline ignora a
// propósito (soporte interno, canal apagado) llenaba el panel de alertas del
// equipo — y una alerta que salta por algo que ya se manejó bien entrena a la
// gente a ignorar TODAS las alertas, incluidas las que sí importan.
export interface HumanReviewCandidate {
  requires_human_review?: boolean | null;
  ignored?: boolean | null;
}

export function shouldAlertHumanReview(message: HumanReviewCandidate): boolean {
  return message.requires_human_review === true && message.ignored !== true;
}
