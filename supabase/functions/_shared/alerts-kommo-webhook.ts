// _shared/alerts-kommo-webhook.ts
//
// Decide si la respuesta de `GET /api/v4/webhooks` de Kommo justifica la
// alerta `kommo_webhook_disabled`.
//
// `inbound_silence` (alerts-scan/index.ts) infiere el apagón por AUSENCIA de
// tráfico consultando la propia base — así que cuando la caída es total
// (Postgres abajo), el vigilante se apaga junto con lo vigilado. Esta alerta
// pregunta directamente a KOMMO, la fuente de verdad que vive FUERA de
// nuestra infraestructura: si el webhook que apunta a este despliegue figura
// `disabled`, el sistema está mudo AHORA MISMO — sin esperar la ventana de
// `inbound_silence` y sin depender de que la DB responda.
//
// Es lógica puramente mecánica sobre la lista de webhooks que devuelve Kommo
// — no depende de qué vende el operador. El manejo de fallos reales (red,
// token vencido, respuesta no-2xx) vive en el detector de alerts-scan/index.ts,
// que es lo único que necesita I/O: ese detector es fail-open a propósito —
// un timeout hacia Kommo NO es evidencia de un apagón nuestro, así que nunca
// debe traducirse en una alerta. Acá solo vive la decisión pura una vez que
// la respuesta de Kommo YA se obtuvo con éxito.
export interface KommoWebhookHook {
  destination?: string | null;
  disabled?: boolean | null;
}

// Filtra los webhooks de Kommo que apuntan a ESTE despliegue (coincide con el
// path del endpoint de kommo-webhook, ej. "/functions/v1/kommo-webhook").
// Kommo puede tener otras integraciones registradas que no nos incumben.
export function filterOurWebhooks(
  hooks: KommoWebhookHook[],
  destinationPath: string,
): KommoWebhookHook[] {
  return hooks.filter((h) => (h.destination ?? "").includes(destinationPath));
}

// true SOLO si encontramos al menos un webhook nuestro y TODOS los que
// encontramos están deshabilitados. Si no hay ninguno registrado con ese
// destino, no es este chequeo el que tiene que opinar — podría ser una
// instalación que todavía no conectó Kommo — así que devolvemos false, nunca
// true por ausencia de datos (fail-open también acá, aunque la data sí haya
// llegado: "no hay hook nuestro" no es lo mismo que "está deshabilitado").
export function shouldAlertKommoWebhookDisabled(
  hooks: KommoWebhookHook[],
  destinationPath: string,
): boolean {
  const ours = filterOurWebhooks(hooks, destinationPath);
  if (ours.length === 0) return false;
  return ours.every((h) => h.disabled === true);
}
