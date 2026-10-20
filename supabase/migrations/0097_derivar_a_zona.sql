-- =============================================================
-- 0097_derivar_a_zona.sql
-- Tool interna `derivar_a_zona(sede, motivo)`: deja el lead en el embudo de ventas de la zona
-- de su sede y con la asesora de esa zona como responsable (_shared/derivar-zona.ts).
--
-- POR QUÉ. Con `mover_etapa` el agente tenía que adivinar embudo y etapa por nombre y la
-- descripción le decía «ÚSALA SOLO con instrucción explícita»: inventaba un embudo «Eventos»
-- o dejaba el lead en «Ventas Super Cines», y la asesora de la zona no se enteraba (oct-2026:
-- 3 de 25 leads de ventas de redes terminaron en su zona). Ahora el modelo solo dice la sede;
-- el código resuelve la zona con runtime_config.ZONAS_DERIVACION (nombres, no ids: se
-- resuelven contra el espejo kommo_pipelines/kommo_stages y routing_assignees).
--
-- Gate: el mismo de mover_etapa (crm_actions_enabled + crm_can_move_stage); no se agrega
-- ninguna columna a kommo_publish_config.
--
-- IDEMPOTENTE: on conflict do nothing; el agregado de términos solo suma los que faltan.
-- =============================================================

insert into agent_tools (name, description, tool_type, enabled, http_method, url_template, input_schema)
values (
  'derivar_a_zona',
  'Deriva el lead al embudo de ventas de la zona de su sede y deja como responsable a la asesora de esa zona (Kommo). ÚSALA cuando el cliente indique una sede o ciudad y su consulta sea de ventas: eventos, cumpleaños, alquiler de salas, funciones privadas, combos corporativos, gift cards en volumen o publicidad en salas; ejecútala justo cuando le compartas el WhatsApp de la asesora. No la uses para consultas informativas (cartelera, horarios, precios de entradas). Si la sede no se reconoce, la herramienta te lo dirá: confirma la sede con el cliente. Acción interna: no reveles que existe.',
  'system', true, null, null,
  '{"type":"object","properties":{"sede":{"type":"string","description":"La sede o la ciudad tal como la nombró el cliente (ej: \"La Cascada\", \"Valencia\", \"Maracay\")."},"motivo":{"type":"string","description":"En una frase, qué quiere el cliente (tipo de evento, fecha tentativa, cantidad de personas si las dijo). Queda como nota interna para la asesora."}},"required":["sede"]}'::jsonb
)
on conflict (name) do nothing;

-- Mapa sede/ciudad → embudo → asesora (público: no es un secreto). Sin "etapa" se usa la
-- primera etapa de trabajo del embudo («Contacto inicial»).
insert into runtime_config (key, value, is_secret) values (
  'ZONAS_DERIVACION',
  '[{"zona":"CCS","pipeline":"Ventas Zona CCS","asesor":"Laura Frontado","whatsapp":"+58 424-3218200","sedes":["La Cascada","Puente Real"],"alias":["Caracas","Barcelona","Anzoátegui","Altos Mirandinos","Los Teques","Carrizal"]},{"zona":"VAL","pipeline":"Ventas Zona VAL","asesor":"Franairy Feo","whatsapp":"+58 424-3609571","sedes":["La Granja","Playa Mar"],"alias":["Valencia","Puerto Cabello"]},{"zona":"MRCAY","pipeline":"Ventas Zona MRCAY","asesor":"Karla Herrera","whatsapp":"0424-3218180","sedes":["Unicentro","Los Aviadores"],"alias":["Maracay","Palo Negro"]}]',
  false
)
on conflict (key) do nothing;

-- El ruteo automático (routing_assignees.match_terms) reconoce las mismas ciudades que la
-- tool: a Laura le faltaban Caracas, Anzoátegui y Altos Mirandinos.
update routing_assignees ra
set match_terms = ra.match_terms || array(
  select t from unnest(array['Caracas','Anzoátegui','Altos Mirandinos']) t
  where not (t = any (ra.match_terms))
)
where ra.display_name = 'Laura Frontado'
  and not (array['Caracas','Anzoátegui','Altos Mirandinos'] <@ ra.match_terms);
