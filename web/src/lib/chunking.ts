// Chunker simple basado en palabras (1 palabra ≈ 1.3 tokens).
// Mantiene contexto: para chats agrupa por turnos consecutivos.

import type { Block } from "@/lib/parsers";

const APPROX_TOKENS_PER_WORD = 1.3;

function tokenCount(text: string): number {
  return Math.ceil(text.split(/\s+/).filter(Boolean).length * APPROX_TOKENS_PER_WORD);
}

export type Chunk = {
  content: string;
  metadata: Record<string, unknown>;
};

export function chunkBlocks(
  blocks: Block[],
  opts: { maxTokens?: number; overlapTokens?: number } = {}
): Chunk[] {
  const maxTokens = opts.maxTokens ?? 400;
  const overlapTokens = opts.overlapTokens ?? 50;
  const chunks: Chunk[] = [];

  let buffer: Block[] = [];
  let bufferTokens = 0;

  function flush() {
    if (buffer.length === 0) return;
    const content = buffer
      .map((b) => (b.speaker ? `${b.speaker}: ${b.text}` : b.text))
      .join("\n");
    const speakers = Array.from(new Set(buffer.map((b) => b.speaker).filter(Boolean)));
    chunks.push({
      content,
      metadata: {
        block_count: buffer.length,
        speakers,
        approx_tokens: bufferTokens,
      },
    });
  }

  for (const block of blocks) {
    const t = tokenCount(block.text);
    if (bufferTokens + t > maxTokens && buffer.length > 0) {
      flush();
      // Overlap: mantener los últimos bloques que sumen ~overlapTokens
      const overlap: Block[] = [];
      let used = 0;
      for (let i = buffer.length - 1; i >= 0 && used < overlapTokens; i--) {
        overlap.unshift(buffer[i]);
        used += tokenCount(buffer[i].text);
      }
      buffer = overlap;
      bufferTokens = used;
    }
    buffer.push(block);
    bufferTokens += t;
  }
  flush();
  return chunks;
}
