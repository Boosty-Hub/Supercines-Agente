// _shared/draft-text.ts
// ÚNICA definición de «lo que realmente se envía» de un draft: el texto editado a
// mano en el inbox (`edited_body`) si lo hay, si no el del agente (`body`).
//
// Antes cada consumidor hacía lo suyo: publish-to-kommo y el guard leían SOLO
// `body`, así que lo que el operador corregía en el inbox NUNCA le llegaba al
// cliente; otros usaban `edited_body ?? body`, que ante un `edited_body` vacío ("")
// devuelve vacío en vez del texto del agente. Pura y sin dependencias para poder
// usarla desde cualquier función y para que web/src/lib/draft-text.ts sea una copia
// exacta (outbound.test.ts verifica la paridad).
export function draftText(d: { body: string; edited_body?: string | null }): string {
  const edited = typeof d.edited_body === "string" ? d.edited_body.trim() : "";
  return edited ? edited : d.body;
}
