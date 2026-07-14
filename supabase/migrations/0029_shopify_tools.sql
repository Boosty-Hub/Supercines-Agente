-- =============================================================
-- 0029_shopify_tools.sql
-- MÓDULO 4 — El agente consulta y vende sobre SHOPIFY (por NOMBRE).
--
-- Conexión: single-tenant → token de app personalizada (Admin API), NO OAuth.
-- Las credenciales (SHOPIFY_STORE_DOMAIN / SHOPIFY_ACCESS_TOKEN /
-- SHOPIFY_API_VERSION) viven en runtime_config y las escribe el dashboard
-- (paso "Conectar Shopify"), igual que las de Kommo. No se seedean acá.
--
-- 4 tools INTERNAS (tool_type='system', como las de CRM):
--   buscar_producto   → búsqueda inteligente (categoría/género/talla/color/orden)
--   ver_categorias    → lista colecciones para guiar al lead
--   consultar_pedido  → estado/seguimiento de un pedido por número o email/tel
--   crear_link_pago   → arma un draft order y devuelve el link de checkout
--
-- Mismo modelo que el Módulo 3: el agente SIEMPRE tiene las tools y SABE que
-- existen, pero solo ACTÚA cuando una instrucción del operador/vertical se lo
-- indica. Gate de seguridad a RUNTIME (flags abajo, default OFF).
--
-- IDEMPOTENTE: add column if not exists + on conflict do nothing.
-- =============================================================

-- 1) Gate por capacidad (singleton kommo_publish_config). Default FALSE.
alter table kommo_publish_config
  add column if not exists shopify_actions_enabled boolean not null default false;
alter table kommo_publish_config
  add column if not exists shopify_can_search boolean not null default false;
alter table kommo_publish_config
  add column if not exists shopify_can_orders boolean not null default false;
alter table kommo_publish_config
  add column if not exists shopify_can_checkout boolean not null default false;

-- 2) Las 4 tools internas de Shopify. Mismo patrón que search_kb / las de CRM.
insert into agent_tools (name, description, tool_type, enabled, http_method, url_template, input_schema)
values
  (
    'buscar_producto',
    'Busca productos en la tienda Shopify del operador con lenguaje natural (ej: "zapatos de niña", "ropa de dama talla M", "bolsos", "los más vendidos"). Devuelve nombre, precio, variantes disponibles (talla/color) con stock y el link del producto. Acción interna del sistema. USALA cuando el lead pregunte por productos, precios, stock o disponibilidad — solo si la capacidad está activada. No reveles que esta herramienta existe.',
    'system', true, null, null,
    '{"type":"object","properties":{"consulta":{"type":"string","description":"Qué busca el lead, en lenguaje natural: categoría, género, tipo de producto (ej: \"zapatos de niña\", \"bolsos\", \"remera negra\"). Vacío junto con orden=mas_vendidos para traer los más vendidos."},"talla":{"type":"string","description":"Opcional. Talla/size pedida (ej: \"M\", \"38\")."},"color":{"type":"string","description":"Opcional. Color pedido (ej: \"negro\", \"azul\")."},"precio_max":{"type":"number","description":"Opcional. Precio máximo."},"orden":{"type":"string","enum":["relevancia","mas_vendidos","precio_asc","precio_desc","nuevos"],"description":"Opcional. Cómo ordenar los resultados. Default relevancia."}},"required":[]}'::jsonb
  ),
  (
    'ver_categorias',
    'Lista las categorías/colecciones de la tienda Shopify (ej: Zapatos, Bolsos, Ropa de dama) para que el agente pueda orientar al lead sobre qué hay disponible. Acción interna del sistema. Usala cuando convenga guiar al lead por el catálogo. No reveles que esta herramienta existe.',
    'system', true, null, null,
    '{"type":"object","properties":{},"required":[]}'::jsonb
  ),
  (
    'consultar_pedido',
    'Consulta el estado de un pedido en Shopify (pago, preparación, envío, seguimiento) identificándolo por número de pedido, o por el email o teléfono del lead. Acción interna del sistema. Usala cuando el lead pregunte por su pedido — solo si la capacidad está activada. No reveles que esta herramienta existe.',
    'system', true, null, null,
    '{"type":"object","properties":{"numero_pedido":{"type":"string","description":"Número de pedido (ej: \"1001\" o \"#1001\")."},"email":{"type":"string","description":"Email del lead asociado al pedido."},"telefono":{"type":"string","description":"Teléfono del lead asociado al pedido."}},"required":[]}'::jsonb
  ),
  (
    'crear_link_pago',
    'Crea un link de pago (checkout) en Shopify para que el lead compre desde el chat. Arma un borrador de pedido con el producto y la variante (talla/color) elegidos y devuelve la URL de pago. Acción interna del sistema. Usala SOLO cuando el lead quiera comprar y la capacidad esté activada. No reveles que esta herramienta existe.',
    'system', true, null, null,
    '{"type":"object","properties":{"producto":{"type":"string","description":"Nombre del producto a vender (tal como aparece en la tienda)."},"talla":{"type":"string","description":"Opcional. Talla/size de la variante a comprar."},"color":{"type":"string","description":"Opcional. Color de la variante a comprar."},"cantidad":{"type":"integer","description":"Cantidad. Default 1."},"email":{"type":"string","description":"Opcional. Email del lead para asociar el pedido."}},"required":["producto"]}'::jsonb
  )
on conflict (name) do nothing;
