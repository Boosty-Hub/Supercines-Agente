// ¿El master Memory Store tiene archivos de voz (/voice/)? Sin imports `@/`: lo usan la web
// (sync-agent-tools) y la CLI scripts/sync-agent.mjs, y la respuesta decide cómo se COMPONE el
// system (agent-prompt.composeSystem {hasVoice}); si difirieran, la CLI empujaría otro texto.
import { listMemories } from "./anthropic-managed.ts";

/**
 * Con la carpeta vacía, el paso de voz del scaffold era un turno muerto en CADA sesión del
 * agente. Fail-open: ante cualquier error devuelve true (mantener el paso = comportamiento
 * previo, nunca se pierde una voz real).
 */
export async function detectVoiceFiles(apiKey: string, masterStoreId: string | undefined): Promise<boolean> {
  if (!masterStoreId) return true;
  try {
    const items = await listMemories(apiKey, masterStoreId, "/voice/");
    return items.length > 0;
  } catch {
    return true;
  }
}
