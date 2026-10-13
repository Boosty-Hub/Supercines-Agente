// _shared/webhook-mask.ts
// El destino del webhook de Kommo lleva el secreto en la URL (?token=). Nada que se
// PERSISTA (alerts, system_incidents —legibles por cualquier usuario con sesión—), se
// LOGUEE o se DEVUELVA fuera del panel de Configuración puede llevarlo completo.
// Copia exacta de maskDestination en web/src/lib/kommo-webhook.ts (paridad en
// supabase/tests/web-parity.test.ts).

/** Reemplaza el valor de token=/secret= por ***. Sirve para URLs y para texto libre (errores de Kommo). */
export function maskDestination(destination: string): string {
  return destination.replace(/(token|secret)=[^&#\s"'<>]+/gi, "$1=***");
}
