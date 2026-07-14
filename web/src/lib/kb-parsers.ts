// Parsers para documentos de KB: PDF, DOCX, TXT, MD, SRT, VTT.

import mammoth from "mammoth";

export type ParsedDocument = {
  text: string;
  format: "pdf" | "docx" | "txt" | "md" | "srt" | "vtt";
};

export async function parseDocument(
  buffer: ArrayBuffer,
  filename: string
): Promise<ParsedDocument> {
  const lower = filename.toLowerCase();

  if (lower.endsWith(".pdf")) {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: Buffer.from(buffer) });
    const result = await parser.getText();
    return { text: result.text, format: "pdf" };
  }

  if (lower.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
    return { text: result.value, format: "docx" };
  }

  // Texto plano: utf-8
  const raw = new TextDecoder("utf-8").decode(buffer);

  if (lower.endsWith(".srt")) {
    return { text: stripSrt(raw), format: "srt" };
  }
  if (lower.endsWith(".vtt")) {
    return { text: stripVtt(raw), format: "vtt" };
  }
  if (lower.endsWith(".md")) {
    return { text: raw, format: "md" };
  }
  return { text: raw, format: "txt" };
}

function stripSrt(raw: string): string {
  return raw
    .replace(/^\d+\s*$/gm, "") // números de subtítulo
    .replace(/^\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripVtt(raw: string): string {
  return raw
    .replace(/^WEBVTT.*$/m, "")
    .replace(/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Chunker simple para KB: por palabras, con overlap
export function chunkText(
  text: string,
  opts: { maxTokens?: number; overlapTokens?: number } = {}
): string[] {
  const maxTokens = opts.maxTokens ?? 400;
  const overlapTokens = opts.overlapTokens ?? 60;
  // 1 palabra ≈ 1.3 tokens
  const wordsPerChunk = Math.floor(maxTokens / 1.3);
  const overlapWords = Math.floor(overlapTokens / 1.3);

  // Primero partir por párrafos. Si un párrafo es demasiado grande, partir por oraciones.
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const sentences: string[] = [];
  for (const p of paragraphs) {
    if (countWords(p) <= wordsPerChunk) {
      sentences.push(p);
    } else {
      // Split por oraciones aproximadas
      const parts = p.split(/(?<=[.!?])\s+/);
      sentences.push(...parts);
    }
  }

  const chunks: string[] = [];
  let buffer: string[] = [];
  let bufferWords = 0;

  for (const s of sentences) {
    const w = countWords(s);
    if (bufferWords + w > wordsPerChunk && buffer.length > 0) {
      chunks.push(buffer.join(" "));
      // overlap
      const overlap: string[] = [];
      let used = 0;
      for (let i = buffer.length - 1; i >= 0 && used < overlapWords; i--) {
        overlap.unshift(buffer[i]);
        used += countWords(buffer[i]);
      }
      buffer = overlap;
      bufferWords = used;
    }
    buffer.push(s);
    bufferWords += w;
  }
  if (buffer.length > 0) chunks.push(buffer.join(" "));
  return chunks.filter((c) => c.trim().length > 20);
}

function countWords(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}
