// _shared/shopify.ts
// Helpers para la Admin GraphQL API de Shopify, usados por las tools internas del
// agente (buscar_producto, ver_categorias, consultar_pedido, crear_link_pago).
//
// Conexión single-tenant. Credenciales en runtime_config, dos modos:
//   - SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (apps del Dev Dashboard 2026+):
//     se canjean por un access token de 24h vía client credentials grant, con
//     cache en module scope (mismo idioma que configCache).
//   - SHOPIFY_ACCESS_TOKEN estático (shpat_ de custom apps legacy).
// Siempre con SHOPIFY_STORE_DOMAIN (xxx.myshopify.com) y SHOPIFY_API_VERSION.

import type { ConfigReader } from "./config.ts";

export const DEFAULT_SHOPIFY_API_VERSION = "2025-10";

export type ShopifyCreds = { domain: string; token: string; version: string };

// Cache del token canjeado — sobrevive invocaciones warm; renueva con 5 min de margen.
let shopifyTokenCache: { key: string; token: string; expiresAt: number } | null = null;

async function exchangeToken(domain: string, clientId: string, clientSecret: string): Promise<{ token: string; expiresAt: number }> {
  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    throw new Error(`Shopify token exchange ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("Shopify no devolvió un access token.");
  const expiresIn = typeof j.expires_in === "number" ? j.expires_in : 86399;
  return { token: j.access_token, expiresAt: Date.now() + expiresIn * 1000 };
}

/**
 * Resuelve las credenciales vigentes desde la config: token estático legacy si
 * existe, si no client credentials grant (cacheado). Devuelve null si Shopify
 * no está conectado.
 */
export async function resolveShopifyCreds(cfg: ConfigReader): Promise<ShopifyCreds | null> {
  const domain = cfg.get("SHOPIFY_STORE_DOMAIN");
  if (!domain) return null;
  const version = cfg.getOr("SHOPIFY_API_VERSION", DEFAULT_SHOPIFY_API_VERSION);

  const staticToken = cfg.get("SHOPIFY_ACCESS_TOKEN");
  if (staticToken) return { domain, token: staticToken, version };

  const clientId = cfg.get("SHOPIFY_CLIENT_ID");
  const clientSecret = cfg.get("SHOPIFY_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;

  // La key incluye un sufijo del secret: si el operador rota el secret, el
  // token viejo cacheado deja de servirse apenas la config se refresca.
  const key = `${domain}:${clientId}:${clientSecret.slice(-8)}`;
  if (shopifyTokenCache && shopifyTokenCache.key === key && shopifyTokenCache.expiresAt - 300_000 > Date.now()) {
    return { domain, token: shopifyTokenCache.token, version };
  }
  try {
    const { token, expiresAt } = await exchangeToken(domain, clientId, clientSecret);
    shopifyTokenCache = { key, token, expiresAt };
    return { domain, token, version };
  } catch (err) {
    // El detalle crudo (status + body de Shopify) va al log, NO al agente:
    // el mensaje del throw termina como tool result y el agente podría
    // relayarlo textual al cliente final.
    console.error("Shopify token exchange failed:", err instanceof Error ? err.message : err);
    throw new Error(
      "No pude renovar el acceso a Shopify. El operador debe revisar las credenciales en Configuración."
    );
  }
}

type GraphQLResult<T> = { data?: T; errors?: Array<{ message: string }> };

// POST a la Admin GraphQL API. Devuelve { data, errors } sin tirar por errores
// GraphQL (sí tira por errores de transporte/HTTP).
export async function shopifyGraphQL<T = unknown>(
  creds: ShopifyCreds,
  query: string,
  variables?: Record<string, unknown>
): Promise<GraphQLResult<T>> {
  const url = `https://${creds.domain}/admin/api/${creds.version}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": creds.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });
  if (!res.ok) {
    throw new Error(`Shopify ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as GraphQLResult<T>;
}

// Valida la conexión (lo usa el web vía su propio fetch; acá para el edge si hace falta).
export async function shopifyShopName(creds: ShopifyCreds): Promise<string> {
  const r = await shopifyGraphQL<{ shop: { name: string } }>(creds, `{ shop { name } }`);
  if (r.errors?.length) throw new Error(r.errors[0].message);
  return r.data?.shop?.name ?? "";
}

// ---- Productos ----

export type ShopifyVariant = {
  id: string;
  title: string;
  available: boolean;
  qty: number | null;
  price: string;
  options: Array<{ name: string; value: string }>;
};
export type ShopifyProduct = {
  title: string;
  url: string | null;
  imageUrl: string | null;
  productType: string;
  priceMin: string;
  priceMax: string;
  currency: string;
  variants: ShopifyVariant[];
};

const ORDER_MAP: Record<string, { sortKey: string | null; reverse: boolean }> = {
  relevancia: { sortKey: null, reverse: false },
  mas_vendidos: { sortKey: "BEST_SELLING", reverse: false },
  precio_asc: { sortKey: "PRICE", reverse: false },
  precio_desc: { sortKey: "PRICE", reverse: true },
  nuevos: { sortKey: "CREATED_AT", reverse: true },
};

const PRODUCTS_QUERY = `
query Buscar($q: String!, $n: Int!, $sortKey: ProductSortKeys, $reverse: Boolean) {
  products(first: $n, query: $q, sortKey: $sortKey, reverse: $reverse) {
    edges { node {
      title
      onlineStoreUrl
      featuredImage { url }
      productType
      priceRangeV2 {
        minVariantPrice { amount currencyCode }
        maxVariantPrice { amount currencyCode }
      }
      variants(first: 30) { edges { node {
        id
        title
        availableForSale
        inventoryQuantity
        price
        selectedOptions { name value }
      } } }
    } }
  }
}`;

function norm(s: string): string {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

// deno-lint-ignore no-explicit-any
function mapProduct(node: any): ShopifyProduct {
  const variants: ShopifyVariant[] = (node.variants?.edges ?? []).map((e: any) => ({
    id: e.node.id,
    title: e.node.title,
    available: e.node.availableForSale === true,
    qty: typeof e.node.inventoryQuantity === "number" ? e.node.inventoryQuantity : null,
    price: e.node.price,
    options: e.node.selectedOptions ?? [],
  }));
  return {
    title: node.title,
    url: node.onlineStoreUrl ?? null,
    imageUrl: node.featuredImage?.url ?? null,
    productType: node.productType ?? "",
    priceMin: node.priceRangeV2?.minVariantPrice?.amount ?? "",
    priceMax: node.priceRangeV2?.maxVariantPrice?.amount ?? "",
    currency: node.priceRangeV2?.minVariantPrice?.currencyCode ?? "",
    variants,
  };
}

/**
 * Búsqueda inteligente de productos. `consulta` es lenguaje natural; talla/color
 * filtran variantes; orden mapea a sortKey. Si el sortKey falla (BEST_SELLING es
 * históricamente inestable), reintenta sin orden.
 */
export async function searchProducts(
  creds: ShopifyCreds,
  opts: {
    consulta?: string;
    talla?: string;
    color?: string;
    precioMax?: number;
    orden?: string;
    limit?: number;
  }
): Promise<ShopifyProduct[]> {
  const terms = (opts.consulta ?? "").trim();
  const q = [terms, "status:active"].filter(Boolean).join(" ");
  const n = Math.min(opts.limit ?? 8, 20);
  const ord = ORDER_MAP[opts.orden ?? "relevancia"] ?? ORDER_MAP.relevancia;

  async function run(sortKey: string | null) {
    const r = await shopifyGraphQL<{ products: { edges: Array<{ node: unknown }> } }>(
      creds,
      PRODUCTS_QUERY,
      { q, n, sortKey, reverse: ord.reverse }
    );
    return r;
  }

  let r = await run(ord.sortKey);
  if (r.errors?.length && ord.sortKey) {
    // sortKey inválido/inestable → reintentar sin orden (relevancia).
    r = await run(null);
  }
  if (r.errors?.length) throw new Error(r.errors[0].message);

  let products = (r.data?.products?.edges ?? []).map((e) => mapProduct(e.node));

  // Filtro por precio máximo (post-query, sobre el precio mínimo del producto).
  if (typeof opts.precioMax === "number") {
    products = products.filter((p) => Number(p.priceMin) <= opts.precioMax!);
  }

  // Filtro por talla/color: deja solo variantes que matcheen, y descarta productos
  // sin ninguna variante que matchee.
  const wantTalla = norm(opts.talla ?? "");
  const wantColor = norm(opts.color ?? "");
  if (wantTalla || wantColor) {
    products = products
      .map((p) => {
        const variants = p.variants.filter((v) => {
          const opts2 = v.options.map((o) => norm(o.value));
          const okTalla = !wantTalla || opts2.some((val) => val === wantTalla || val.includes(wantTalla));
          const okColor = !wantColor || opts2.some((val) => val === wantColor || val.includes(wantColor));
          return okTalla && okColor;
        });
        return { ...p, variants };
      })
      .filter((p) => p.variants.length > 0);
  }

  return products;
}

// ---- Colecciones (categorías) ----

export async function listCollections(creds: ShopifyCreds, limit = 50): Promise<string[]> {
  const r = await shopifyGraphQL<{ collections: { edges: Array<{ node: { title: string } }> } }>(
    creds,
    `query($n: Int!) { collections(first: $n, sortKey: TITLE) { edges { node { title } } } }`,
    { n: Math.min(limit, 100) }
  );
  if (r.errors?.length) throw new Error(r.errors[0].message);
  return (r.data?.collections?.edges ?? []).map((e) => e.node.title);
}

// ---- Pedidos ----

export type ShopifyOrder = {
  name: string;
  createdAt: string;
  financialStatus: string;
  fulfillmentStatus: string;
  total: string;
  currency: string;
  tracking: Array<{ number: string | null; url: string | null; company: string | null }>;
};

const ORDERS_QUERY = `
query Pedidos($q: String!) {
  orders(first: 5, query: $q, sortKey: CREATED_AT, reverse: true) {
    edges { node {
      name
      createdAt
      displayFinancialStatus
      displayFulfillmentStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      fulfillments(first: 5) { trackingInfo { number url company } }
    } }
  }
}`;

/**
 * Busca pedidos por número, email o teléfono. Devuelve hasta 5 (más reciente
 * primero). Al menos uno de los criterios debe venir.
 */
export async function findOrders(
  creds: ShopifyCreds,
  opts: { numeroPedido?: string; email?: string; telefono?: string }
): Promise<ShopifyOrder[]> {
  let q = "";
  if (opts.numeroPedido) {
    const num = String(opts.numeroPedido).replace(/^#/, "").trim();
    q = `name:#${num}`;
  } else if (opts.email) {
    q = `email:${opts.email.trim()}`;
  } else if (opts.telefono) {
    // Shopify no indexa bien teléfono en orders; búsqueda best-effort.
    q = opts.telefono.trim();
  } else {
    return [];
  }

  const r = await shopifyGraphQL<{ orders: { edges: Array<{ node: any }> } }>(creds, ORDERS_QUERY, { q });
  if (r.errors?.length) throw new Error(r.errors[0].message);
  // deno-lint-ignore no-explicit-any
  return (r.data?.orders?.edges ?? []).map((e: any) => {
    const n = e.node;
    const tracking = (n.fulfillments ?? []).flatMap((f: any) =>
      (f.trackingInfo ?? []).map((t: any) => ({
        number: t.number ?? null,
        url: t.url ?? null,
        company: t.company ?? null,
      }))
    );
    return {
      name: n.name,
      createdAt: n.createdAt,
      financialStatus: n.displayFinancialStatus ?? "",
      fulfillmentStatus: n.displayFulfillmentStatus ?? "",
      total: n.totalPriceSet?.shopMoney?.amount ?? "",
      currency: n.totalPriceSet?.shopMoney?.currencyCode ?? "",
      tracking,
    };
  });
}

// ---- Checkout (draft order) ----

const DRAFT_ORDER_MUTATION = `
mutation Checkout($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder { invoiceUrl }
    userErrors { field message }
  }
}`;

/**
 * Crea un link de pago (draft order) para un producto/variante elegido por nombre.
 * Devuelve { invoiceUrl } o lanza con un mensaje claro si no encuentra la variante.
 */
export async function createCheckoutLink(
  creds: ShopifyCreds,
  opts: { producto: string; talla?: string; color?: string; cantidad?: number; email?: string }
): Promise<{ invoiceUrl: string; variantTitle: string; productTitle: string }> {
  // 1) Resolver la variante por nombre + talla/color.
  const products = await searchProducts(creds, {
    consulta: opts.producto,
    talla: opts.talla,
    color: opts.color,
    limit: 5,
  });
  if (products.length === 0) {
    throw new Error(`No encontré el producto "${opts.producto}" para armar el pago.`);
  }
  // Mejor match: el producto cuyo título normalizado coincide más; primera variante disponible.
  const want = norm(opts.producto);
  const product =
    products.find((p) => norm(p.title) === want) ||
    products.find((p) => norm(p.title).includes(want)) ||
    products[0];
  const variant =
    product.variants.find((v) => v.available) || product.variants[0];
  if (!variant) {
    throw new Error(`"${product.title}" no tiene una variante disponible para vender.`);
  }

  // 2) Crear el draft order.
  const input: Record<string, unknown> = {
    lineItems: [{ variantId: variant.id, quantity: Math.max(1, opts.cantidad ?? 1) }],
  };
  if (opts.email) input.email = opts.email;

  const r = await shopifyGraphQL<{
    draftOrderCreate: { draftOrder: { invoiceUrl: string } | null; userErrors: Array<{ message: string }> };
  }>(creds, DRAFT_ORDER_MUTATION, { input });
  if (r.errors?.length) throw new Error(r.errors[0].message);
  const ue = r.data?.draftOrderCreate?.userErrors ?? [];
  if (ue.length) throw new Error(ue[0].message);
  const invoiceUrl = r.data?.draftOrderCreate?.draftOrder?.invoiceUrl;
  if (!invoiceUrl) throw new Error("Shopify no devolvió el link de pago.");

  return { invoiceUrl, variantTitle: variant.title, productTitle: product.title };
}
