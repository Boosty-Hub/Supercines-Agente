-- 0093_agent_tools_tuteo.sql — las descripciones sembradas de las tools del agente iban en voseo
-- («Usala», «podés», «Indicá», «no vos») y contradecían al prompt del operador (tuteo). Se
-- reemplazan SOLO los fragmentos exactos del texto sembrado: una descripción que el operador ya
-- editó (y no los conserva) no se toca. Idempotente: sin el fragmento viejo no hace nada.
update agent_tools
set description = replace(replace(replace(replace(replace(description,
      'Usala ', 'Úsala '),
      'Podés pasarle', 'Puedes pasarle'),
      'Indicá siempre', 'Indica siempre'),
      'esta SÍ podés ejecutarla', 'esta SÍ puedes ejecutarla'),
      'define el operador, no vos:', 'define el operador, no tú:')
where description ~ '(Usala |Podés pasarle|Indicá siempre|esta SÍ podés ejecutarla|define el operador, no vos:)';
