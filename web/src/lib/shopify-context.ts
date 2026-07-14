// server-only: bloque de contexto "el agente tiene una tienda Shopify conectada"
// que se inyecta en los generadores de IA (verticales, voz). Solo se incluye si
// Shopify está conectado; trae las categorías/colecciones en vivo para que la IA
// escriba verticales/instrucciones alineadas al catálogo real.
import { getShopifyAccessToken } from "@/lib/shopify";

type CollectionsResponse = {
  data?: { collections?: { edges?: Array<{ node?: { title?: string } }> } };
};

export async function buildShopifyContext(): Promise<string> {
  // Resuelve token estático legacy o client credentials (con cache de 24h).
  const creds = await getShopifyAccessToken();

  // Sin tienda conectada → no inyectamos nada (no tiene sentido mencionar Shopify).
  if (!creds) return "";
  const { domain, token, version } = creds;

  let categoriesLine = "";
  try {
    const res = await fetch(`https://${domain}/admin/api/${version}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        query: `{ collections(first: 40, sortKey: TITLE) { edges { node { title } } } }`,
      }),
    });
    if (res.ok) {
      const j = (await res.json()) as CollectionsResponse;
      const names = (j.data?.collections?.edges ?? [])
        .map((e) => e.node?.title)
        .filter((t): t is string => Boolean(t));
      if (names.length) {
        categoriesLine = `Categorías/colecciones de la tienda: ${names
          .slice(0, 40)
          .map((n) => `«${n}»`)
          .join(", ")}.`;
      }
    }
  } catch {
    // best-effort: si falla, igual describimos las capacidades sin categorías.
  }

  return [
    "CAPACIDAD DEL AGENTE — TIENDA SHOPIFY CONECTADA:",
    "El agente puede consultar y vender sobre la tienda Shopify del operador cuando una instrucción de este prompt (o de una vertical) se lo indique:",
    "- buscar productos en lenguaje natural (categoría, género, talla, color, «los más vendidos») devolviendo precio, stock, link y FOTO del producto (el agente puede pasarle al lead el link y la URL de la foto en su respuesta),",
    "- listar las categorías del catálogo para orientar al lead,",
    "- consultar el estado de un pedido (por número, email o teléfono),",
    "- crear un link de pago (checkout) para cerrar la venta dentro del chat.",
    "Cómo aprovecharlo al redactar:",
    "- Si el negocio implica responder por productos/stock/precios, por pedidos, o vender por chat, instruí al agente a usar esas capacidades (ej: «si preguntan por un producto, buscalo y pasá precio y disponibilidad»; «si quieren comprar, generales el link de pago»).",
    "- Estas acciones el operador las activa en «Agente → Acciones»; mientras estén apagadas el agente simplemente las ignora.",
    categoriesLine,
  ]
    .filter(Boolean)
    .join("\n");
}
