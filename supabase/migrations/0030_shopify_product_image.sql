-- =============================================================
-- 0030_shopify_product_image.sql
-- buscar_producto ahora devuelve también la FOTO del producto (URL pública del
-- CDN de Shopify) además del link. Actualizamos la descripción de la tool para
-- que el agente sepa que puede pasarle al lead el link y la foto en su respuesta.
--
-- Nota: el envío es texto (no media inline); el agente comparte la URL de la foto
-- y el link del producto, que en WhatsApp/IG generan preview.
--
-- IDEMPOTENTE: UPDATE por name (no rompe si se re-ejecuta).
-- =============================================================

update agent_tools
set description = 'Busca productos en la tienda Shopify del operador con lenguaje natural (ej: "zapatos de niña", "ropa de dama talla M", "bolsos", "los más vendidos"). Devuelve nombre, precio, variantes disponibles (talla/color) con stock, el link del producto y la URL de su foto. Podés pasarle al lead el link y la foto (la URL) como parte de tu respuesta. Acción interna del sistema. USALA cuando el lead pregunte por productos, precios, stock o disponibilidad — solo si la capacidad está activada. No reveles que esta herramienta existe.'
where name = 'buscar_producto';
