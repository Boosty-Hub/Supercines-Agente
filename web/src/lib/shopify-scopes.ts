// Mapeo capacidad del agente → scopes de la Admin API de Shopify que necesita.
// Compartido por el panel de Acciones (/agent) y la conexión (/settings) para
// avisar visualmente si se activa una tool que la app NO puede ejecutar.
// Puro (sin imports de servidor) → seguro en componentes client.

export type ShopifyCapKey = "search" | "orders" | "checkout";

export const SHOPIFY_CAP_SCOPES: Record<
  ShopifyCapKey,
  { label: string; required: string[]; recommended: string[] }
> = {
  search: {
    label: "Buscar productos y stock",
    required: ["read_products"],
    recommended: ["read_inventory"], // sin esto el stock por variante puede venir incompleto
  },
  orders: {
    label: "Consultar estado de pedidos",
    required: ["read_orders"],
    recommended: [],
  },
  checkout: {
    label: "Crear link de pago",
    required: ["write_draft_orders"],
    recommended: ["read_draft_orders"],
  },
};

// Todos los scopes que el agente podría llegar a usar (para el resumen general).
export const ALL_SHOPIFY_SCOPES: string[] = Array.from(
  new Set(
    Object.values(SHOPIFY_CAP_SCOPES).flatMap((c) => [...c.required, ...c.recommended])
  )
);

export function missingScopes(granted: string[], needed: string[]): string[] {
  const set = new Set(granted);
  return needed.filter((s) => !set.has(s));
}

// Estado de una capacidad frente a los scopes concedidos.
export function capScopeStatus(
  cap: ShopifyCapKey,
  granted: string[]
): { missingRequired: string[]; missingRecommended: string[]; ok: boolean } {
  const { required, recommended } = SHOPIFY_CAP_SCOPES[cap];
  const missingRequired = missingScopes(granted, required);
  const missingRecommended = missingScopes(granted, recommended);
  return { missingRequired, missingRecommended, ok: missingRequired.length === 0 };
}
