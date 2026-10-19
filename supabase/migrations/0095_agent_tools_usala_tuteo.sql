-- 0095_agent_tools_usala_tuteo.sql — las tools de CRM sembradas (0028/0067) dicen «USALA SOLO cuando…»
-- sin tilde: el imperativo voseante «usala». La 0093 cubrió «Usala » en minúscula inicial y no esta
-- variante en mayúsculas. Se reemplaza SOLO el fragmento exacto del texto sembrado (una descripción
-- que el operador ya editó y no lo conserva no se toca). Idempotente: sin el fragmento no hace nada.
update agent_tools
set description = replace(description, 'USALA SOLO', 'ÚSALA SOLO')
where description like '%USALA SOLO%';
