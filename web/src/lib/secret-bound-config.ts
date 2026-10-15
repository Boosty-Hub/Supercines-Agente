// Pares DESTINO + SECRETO de runtime_config: un secreto queda atado al destino (URL/host) con el
// que se cargó. Si alguien cambia el destino sin volver a ingresar el secreto, el secreto viejo
// viajaría a un host que quien lo cargó nunca autorizó (p. ej. mover BCV_RATE_URL a un host
// propio y quedarse con BCV_RATE_APIKEY en el próximo fetch de la tasa).
//
// REGLA ÚNICA (para todos los pares): si una escritura agrega un destino que antes no estaba,
// cada secreto del par que seguiría vigente después de la escritura tiene que venir con un
// valor NUEVO en esa misma escritura. Borrarlo también vale (sin secreto no viaja nada). Quitar
// destinos o cambiar solo la ruta dentro del mismo host no exige nada.
//
// La aplica `setConfigValues` (lib/runtime-config.ts) en TODA escritura de runtime_config —el
// único camino de escritura del panel— y las rutas la usan antes para devolver un 400 claro.
// Módulo puro (sin imports de servidor): lo importan los tests de node.

import { normalizeHost } from "./http-tool-keys.ts";

export type SecretBoundPair = {
  /** Clave que define a dónde viaja el secreto. */
  readonly destinationKey: string;
  /** Secretos atados a ese destino. */
  readonly secretKeys: readonly string[];
  /** Destinos (hosts) que habilita un valor de `destinationKey`. Vacío = no viaja a ningún lado. */
  readonly destinations: (value: string | undefined) => readonly string[];
};

/** Un valor que no se puede interpretar es un destino desconocido: cualquier cambio cuenta. */
const opaque = (v: string) => `?${v.trim()}`;

/** Host de una clave tipo dominio (`cliente.kommo.com`, `tienda.myshopify.com`). */
function hostDestination(value: string | undefined): readonly string[] {
  const v = (value ?? "").trim();
  if (!v) return [];
  return [normalizeHost(v) ?? opaque(v)];
}

/** Host[:puerto] de una URL completa (BCV_RATE_URL). */
function urlDestination(value: string | undefined): readonly string[] {
  const v = (value ?? "").trim();
  if (!v) return [];
  try {
    const u = new URL(v);
    return [`${u.protocol}//${u.host}`.toLowerCase()];
  } catch {
    return [opaque(v)];
  }
}

/** Lista de hosts declarados (TOOL_<X>_HOSTS): los inválidos no habilitan nada (igual que el resolvedor). */
function hostListDestination(value: string | undefined): readonly string[] {
  return (value ?? "")
    .split(",")
    .map((x) => normalizeHost(x))
    .filter((x): x is string => x !== null);
}

/** Pares fijos. Los TOOL_<X>_HOSTS ↔ TOOL_<X> son dinámicos (ver `pairForDestinationKey`). */
export const SECRET_BOUND_PAIRS: readonly SecretBoundPair[] = [
  // Tasa BCV: la API key se manda como apikey + Authorization a BCV_RATE_URL.
  { destinationKey: "BCV_RATE_URL", secretKeys: ["BCV_RATE_APIKEY"], destinations: urlDestination },
  // Kommo: el token de larga duración va a KOMMO_API_DOMAIN (API, http tools, salesbot…).
  { destinationKey: "KOMMO_API_DOMAIN", secretKeys: ["KOMMO_ACCESS_TOKEN"], destinations: hostDestination },
  // Shopify: token estático o client credentials, siempre contra la tienda configurada.
  {
    destinationKey: "SHOPIFY_STORE_DOMAIN",
    secretKeys: ["SHOPIFY_ACCESS_TOKEN", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"],
    destinations: hostDestination,
  },
];

const TOOL_HOSTS_RE = /^(TOOL_[A-Z0-9_]{1,64})_HOSTS$/;

/** Par cuyo destino es `key` (fijo o TOOL_<X>_HOSTS → TOOL_<X>), o null. */
export function pairForDestinationKey(key: string): SecretBoundPair | null {
  const fixed = SECRET_BOUND_PAIRS.find((p) => p.destinationKey === key);
  if (fixed) return fixed;
  const m = TOOL_HOSTS_RE.exec(key);
  if (m) return { destinationKey: key, secretKeys: [m[1]], destinations: hostListDestination };
  return null;
}

/** Pares cuyo destino cambia en esta escritura. */
export function pairsTouchedBy(keys: readonly string[]): SecretBoundPair[] {
  return keys.map(pairForDestinationKey).filter((p): p is SecretBoundPair => p !== null);
}

/** Claves cuyo valor ACTUAL hace falta para decidir (destinos y secretos de los pares tocados). */
export function keysToCheck(keys: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of pairsTouchedBy(keys)) {
    out.add(p.destinationKey);
    for (const s of p.secretKeys) out.add(s);
  }
  return [...out];
}

export type SecretBindingViolation = {
  readonly destinationKey: string;
  readonly secretKeys: readonly string[];
  readonly message: string;
};

const filled = (v: string | null | undefined): v is string => typeof v === "string" && v.trim() !== "";

/**
 * Viola la regla si la escritura agrega un destino y deja vigente un secreto del par sin
 * reenviarlo. `write` tiene la semántica de setConfigValues: valor no vacío = setear;
 * "" / null / undefined = borrar (y entonces vuelve a regir el entorno). `current` es el valor
 * VIGENTE antes de escribir (base, o entorno si la base no tiene); `env`, el del entorno.
 */
export function checkSecretBindings(
  write: Readonly<Record<string, string | null | undefined>>,
  current: (key: string) => string | undefined,
  env: (key: string) => string | undefined
): SecretBindingViolation[] {
  const has = (k: string) => Object.hasOwn(write, k);
  const after = (k: string): string | undefined => {
    if (!has(k)) return current(k);
    const v = write[k];
    return filled(v) ? v : env(k);
  };
  const violations: SecretBindingViolation[] = [];
  for (const pair of pairsTouchedBy(Object.keys(write))) {
    const before = new Set(pair.destinations(current(pair.destinationKey)));
    const added = pair.destinations(after(pair.destinationKey)).filter((d) => !before.has(d));
    if (added.length === 0) continue;
    const stale = pair.secretKeys.filter((s) => {
      if (has(s) && filled(write[s])) return false; // reenviado en esta escritura
      return filled(after(s)); // seguiría vigente (sin reenviar) → viajaría al destino nuevo
    });
    if (stale.length === 0) continue;
    violations.push({
      destinationKey: pair.destinationKey,
      secretKeys: stale,
      message:
        `Cambiaste ${pair.destinationKey}: ${stale.join(", ")} quedó atado al destino anterior. ` +
        `Volvé a ingresarlo (o borralo) en el mismo guardado.`,
    });
  }
  return violations;
}
