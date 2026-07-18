-- Elimina Shopify del sistema.
--
-- SUPERCINES es una cadena de cines: no vende productos, no tiene catálogo ni
-- pedidos ni links de pago. Las cuatro tools de tienda estaban en la base pero
-- desactivadas, y las columnas del gate siempre en false, ocupando espacio en
-- la UI y en cada SELECT de configuración.
--
-- Las migraciones 0029/0030 (que crearon todo esto) NO se tocan: ya están
-- aplicadas y son el historial. Esta migración deshace lo que aquellas hicieron.
--
-- OJO: esto separa la instancia del template Boosty-Hub/Template-Agent-kommo.
-- Si el template actualiza algo de Shopify, acá ya no existe.

-- 1) Tools de tienda: fuera del registro (el agente ya no las declara).
delete from agent_tools
 where name in ('buscar_producto', 'ver_categorias', 'consultar_pedido', 'crear_link_pago');

-- 2) Gate de capacidades: las cuatro columnas del panel de Acciones.
alter table kommo_publish_config
  drop column if exists shopify_actions_enabled,
  drop column if exists shopify_can_search,
  drop column if exists shopify_can_orders,
  drop column if exists shopify_can_checkout;

-- 3) Credenciales de la tienda en runtime_config, si quedó alguna.
delete from runtime_config
 where key in (
   'SHOPIFY_STORE_DOMAIN',
   'SHOPIFY_ACCESS_TOKEN',
   'SHOPIFY_CLIENT_ID',
   'SHOPIFY_CLIENT_SECRET',
   'SHOPIFY_API_VERSION'
 );
