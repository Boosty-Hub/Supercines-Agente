-- =============================================================
-- 0002_seed.sql — datos iniciales genéricos: 3 verticales base + 6 graders
-- =============================================================
-- Las verticales y graders se editan después desde el dashboard
-- (/verticales, /outcomes). Acá dejamos 3 verticales genéricas que sirven
-- para cualquier agente y los 6 graders estándar para arrancar listo.

-- Verticales base (genéricas, sirven para cualquier agente). El operador agrega
-- las de su dominio desde /verticales o con el asistente IA del wizard.
insert into verticals (slug, name, description, system_prompt, auto_reply, requires_review)
values
  (
    'general',
    'General',
    'Mensajes que no encajan en otras verticales — escalar para revisión humana hasta que el operador defina verticales propias.',
    'Esta es una consulta general. Responde con cortesía y haz una pregunta abierta para entender mejor lo que el lead busca. Marcar para revisión humana antes de enviar.',
    false,
    true
  ),
  (
    'engagement_social',
    'Engagement social',
    'Reacciones positivas, agradecimientos, saludos y fans casuales — interacción liviana que se puede responder sola.',
    'El lead está saludando, agradeciendo o reaccionando de forma positiva. Responde breve, cálido y directo, en la voz del operador. Si hay una pregunta concreta dentro del mensaje, respóndela; si no, agradece y deja la puerta abierta sin sonar robótico.',
    true,
    false
  ),
  (
    'hate_sarcasmo',
    'Hate / sarcasmo',
    'Mensajes hostiles, ofensivos, sarcásticos o trolling — NUNCA responder automáticamente, siempre a revisión humana.',
    'NO RESPONDER AUTOMÁTICAMENTE. El mensaje es hostil, ofensivo, sarcástico o de trolling. Marcar para revisión humana: una persona decide si conviene responder, ignorar o bloquear. No improvises una respuesta.',
    false,
    true
  )
on conflict (slug) do nothing;

-- Graders estándar (universales — sirven para cualquier agente conversacional)
insert into graders (slug, name, description, prompt, scale, weight, enabled, source)
values
  (
    'voice_match',
    'Voice Match',
    'Mide qué tan parecida es la respuesta a la voz auténtica del operador (definida en el system prompt y los samples de /voz).',
    'Eres un evaluador imparcial. Tu única tarea es decidir cuánto suena el siguiente texto a la voz del operador definida en el system prompt del agente y los samples de voz, y no a un asistente IA genérico. Si dudas, baja el score. Devuelve solo un JSON: {"score": 0.0-1.0, "reasoning": "..."}',
    'numeric_0_1',
    1.5,
    true,
    'llm_judge'
  ),
  (
    'task_completion',
    'Task Completion',
    'Mide si la respuesta resolvió lo que el lead preguntó o si quedó vaga.',
    'Evalúa si la respuesta resuelve concretamente la consulta del lead. 1.0 = resolvió de forma específica y accionable. 0.5 = respondió pero quedó genérico. 0.0 = no respondió o se fue por las ramas. Devuelve JSON: {"score": 0.0-1.0, "reasoning": "..."}',
    'numeric_0_1',
    1.5,
    true,
    'llm_judge'
  ),
  (
    'lead_replied',
    'Lead Replied',
    'Señal automática: el lead respondió en menos de 24h tras nuestra respuesta.',
    'AUTOMATIC: este grader se calcula en código (no LLM). Pass si hay un mensaje inbound del mismo lead dentro de 24h después del draft enviado.',
    'pass_fail',
    1.0,
    true,
    'automatic'
  ),
  (
    'lead_converted',
    'Lead Converted',
    'Señal automática: el lead cambió a etapa de pipeline "ganado" / "agendado" en Kommo.',
    'AUTOMATIC: se calcula por cambio de pipeline_status_id en Kommo a un estado de conversión configurado.',
    'pass_fail',
    2.0,
    true,
    'automatic'
  ),
  (
    'no_hallucination',
    'No Hallucination',
    'Mide si la respuesta inventó precios, fechas, condiciones o features no documentados en la KB.',
    'Evalúa si la respuesta menciona hechos específicos (precios, fechas, módulos, features, garantías) que no estén respaldados por la KB proporcionada como contexto. 1.0 = todo lo que afirma está respaldado o es opinión. 0.0 = invento claro. Devuelve JSON: {"score": 0.0-1.0, "reasoning": "..."}',
    'numeric_0_1',
    2.0,
    true,
    'llm_judge'
  ),
  (
    'length_appropriate',
    'Length Appropriate',
    'Mide si el largo de la respuesta es razonable para el canal (IG DM corto, web largo).',
    'AUTOMATIC: heurística sobre largo. IG DM/Instagram comment: ideal 20-80 palabras. WhatsApp: 20-150. Web form: 40-300. Penaliza el doble del rango.',
    'numeric_0_1',
    0.5,
    true,
    'automatic'
  )
on conflict (slug) do nothing;
