// ÚNICA definición de «lo que realmente se envía» de un draft: el texto editado a
// mano en el inbox (`edited_body`) si lo hay, si no el del agente (`body`).
// COPIA EXACTA de supabase/functions/_shared/draft-text.ts (outbound.test.ts verifica
// la paridad): el inbox muestra lo mismo que publish-to-kommo publica.
export function draftText(d: { body: string; edited_body?: string | null }): string {
  const edited = typeof d.edited_body === "string" ? d.edited_body.trim() : "";
  return edited ? edited : d.body;
}
