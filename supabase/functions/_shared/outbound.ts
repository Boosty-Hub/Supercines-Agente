// _shared/outbound.ts
//
// ÚNICO punto de salida de TEXTO hacia Kommo. Todo texto que un cliente real puede
// terminar leyendo (el DM del draft, la respuesta PÚBLICA a un comentario de
// Instagram, las variables de un seguimiento) se escribe al campo de Kommo con
// `writeClientText`, y esa función pasa SIEMPRE por el verificador de fuga interna
// (_shared/response-guard.ts) antes de tocar la API. Lo que el modelo escribe en
// campos del CRM (tools actualizar_lead / actualizar_contacto) pasa por
// `writeCrmField`, con el mismo verificador (no es texto al cliente, pero un residuo
// de tool-calling en un campo del CRM lo ensucia y puede terminar en un salesbot).
//
// POR QUÉ UN SOLO PUNTO. El guard original vivía en generate-response y, como
// backstop, solo sobre `draft.body` en publish-to-kommo: la respuesta pública (el
// canal más expuesto: un comentario de Instagram lo lee todo el mundo) y las
// variables del seguimiento salían sin verificar. Y el texto EDITADO a mano en el
// inbox (`edited_body`) ni siquiera se publicaba: publish-to-kommo mandaba
// `draft.body`, así que lo que el operador corregía NUNCA le llegaba al cliente.
// Validar en cada llamador es exactamente cómo uno se queda sin validar; acá se
// valida una vez, donde se escribe. `outbound.test.ts` falla si aparece otro camino
// que llame a `patchLeadField` / `patchContactField` / `runSalesbot` sin pasar por acá.

import { draftText } from "./draft-text.ts";
import { detectInternalLeak } from "./response-guard.ts";
import { patchContactField, patchLeadField } from "./kommo.ts";

export type OutboundKind = "dm" | "public_reply" | "follow_up" | "crm_field";

/** El texto contiene residuo interno: NO se escribió nada en Kommo. */
export class OutboundBlockedError extends Error {
  constructor(public kind: OutboundKind, public reason: string) {
    super(`texto saliente bloqueado (${kind}): ${reason}`);
    this.name = "OutboundBlockedError";
  }
}

// «Lo enviado» de un draft (edited_body ?? body): una sola definición, en draft-text.ts.
// publish-to-kommo, el guard, el historial, los graders, Dreams y el inbox la usan.
export { draftText };

/** Devuelve el motivo si el texto no puede salir, o null si es apto. */
export function outboundLeak(text: string | null | undefined): string | null {
  if (!text || !text.trim()) return "texto vacío";
  return detectInternalLeak(text);
}

/**
 * Motivo si el valor que el MODELO eligió para un campo del CRM trae residuo
 * interno, o null. Un valor vacío es legítimo (borrar el campo): solo se verifica
 * el residuo, no el vacío. Lo usan writeCrmField y el escritor tipado de campos
 * select/enum de generate-response (writeEntityField), que no puede pasar por
 * writeCrmField porque resuelve el enum_id de Kommo.
 */
export function crmValueLeak(value: string | null | undefined): string | null {
  return value && value.trim() ? detectInternalLeak(value) : null;
}

/**
 * Escribe un texto destinado al cliente en un campo de Kommo, tras verificarlo.
 * Lanza OutboundBlockedError (sin tocar la API) si trae residuo interno.
 */
export async function writeClientText(opts: {
  kind: Exclude<OutboundKind, "crm_field">;
  kommoLeadId: number;
  fieldId: number;
  text: string;
  kommoDomain: string;
  kommoToken: string;
}): Promise<void> {
  const reason = outboundLeak(opts.text);
  if (reason) throw new OutboundBlockedError(opts.kind, reason);
  await patchLeadField(opts.kommoLeadId, opts.fieldId, opts.text, opts.kommoDomain, opts.kommoToken);
}

/**
 * Escribe un valor que el MODELO eligió en un campo del lead o del contacto en el
 * CRM (tools actualizar_lead / actualizar_contacto), tras verificarlo. Un valor
 * vacío es legítimo (borrar el campo): solo se verifica el residuo, no el vacío.
 */
export async function writeCrmField(opts: {
  entity: "lead" | "contact";
  entityId: number;
  fieldId: number;
  value: string;
  kommoDomain: string;
  kommoToken: string;
}): Promise<void> {
  const reason = crmValueLeak(opts.value);
  if (reason) throw new OutboundBlockedError("crm_field", reason);
  if (opts.entity === "lead") {
    await patchLeadField(opts.entityId, opts.fieldId, opts.value, opts.kommoDomain, opts.kommoToken);
  } else {
    await patchContactField(opts.entityId, opts.fieldId, opts.value, opts.kommoDomain, opts.kommoToken);
  }
}
