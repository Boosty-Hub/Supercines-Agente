// _shared/outbound.ts
//
// ÚNICO punto de salida de TEXTO AL CLIENTE hacia Kommo. Todo texto que un
// cliente real puede terminar leyendo (el DM del draft, la respuesta PÚBLICA a un
// comentario de Instagram, las variables de un seguimiento) se escribe al campo
// de Kommo con `writeClientText`, y esa función pasa SIEMPRE por el verificador
// de fuga interna (_shared/response-guard.ts) antes de tocar la API.
//
// POR QUÉ UN SOLO PUNTO. El guard original vivía en generate-response y, como
// backstop, solo sobre `draft.body` en publish-to-kommo: la respuesta pública
// (el canal más expuesto: un comentario de Instagram lo lee todo el mundo) y las
// variables del seguimiento salían sin verificar, y el texto EDITADO a mano en el
// inbox (`edited_body`) ni siquiera se publicaba. Validar en cada llamador es
// exactamente cómo uno se queda sin validar; acá se valida una vez, donde se
// escribe. `outbound.test.ts` falla si aparece otro camino que llame a
// `patchLeadField` o a `runSalesbot` sin pasar por acá.

import { detectInternalLeak } from "./response-guard.ts";
import { patchLeadField } from "./kommo.ts";

export type OutboundKind = "dm" | "public_reply" | "follow_up";

/** El texto contiene residuo interno: NO se escribió nada en Kommo. */
export class OutboundBlockedError extends Error {
  constructor(public kind: OutboundKind, public reason: string) {
    super(`texto saliente bloqueado (${kind}): ${reason}`);
    this.name = "OutboundBlockedError";
  }
}

/**
 * El texto que REALMENTE se publica de un draft: el editado a mano en el inbox
 * (edited_body) si lo hay, si no el del agente. publish-to-kommo usaba solo
 * `body`, así que la edición de la persona nunca llegaba al cliente.
 */
export function draftText(d: { body: string; edited_body?: string | null }): string {
  const edited = typeof d.edited_body === "string" ? d.edited_body.trim() : "";
  return edited ? d.edited_body!.trim() : d.body;
}

/** Devuelve el motivo si el texto no puede salir, o null si es apto. */
export function outboundLeak(text: string | null | undefined): string | null {
  if (!text || !text.trim()) return "texto vacío";
  return detectInternalLeak(text);
}

/**
 * Escribe un texto destinado al cliente en un campo de Kommo, tras verificarlo.
 * Lanza OutboundBlockedError (sin tocar la API) si trae residuo interno.
 */
export async function writeClientText(opts: {
  kind: OutboundKind;
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
