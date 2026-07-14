// Parsers de archivos de voz. Cada parser devuelve "bloques" — fragmentos
// semánticamente coherentes que después chunkeamos por largo.

export type Block = {
  speaker?: string;        // "operator" | "lead" | "narrator" | etc
  text: string;
  metadata?: Record<string, unknown>;  // timestamps, message_id, etc
};

const WHATSAPP_LINE = /^\[?(\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}),?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?\s*m\.?)?\]?\s*[-–]?\s*([^:]+):\s*(.+)$/i;

export function parseWhatsApp(raw: string, operatorName?: string): Block[] {
  const lines = raw.split(/\r?\n/);
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (const line of lines) {
    const m = line.match(WHATSAPP_LINE);
    if (m) {
      if (current) blocks.push(current);
      const sender = m[2].trim();
      const text = m[3].trim();
      const isOperator = operatorName ? sender.toLowerCase().includes(operatorName.toLowerCase()) : false;
      current = { speaker: isOperator ? "operator" : sender, text };
    } else if (current && line.trim()) {
      // Continuación de mensaje multilinea
      current.text += "\n" + line.trim();
    }
  }
  if (current) blocks.push(current);
  return blocks.filter((b) => b.text && !/^<[^>]+>$/.test(b.text)); // descarta "<Media omitted>"
}

const SRT_BLOCK = /^\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}\s*\n([\s\S]+?)(?=\n\n|\n*$)/gm;

export function parseSrt(raw: string): Block[] {
  const blocks: Block[] = [];
  let m: RegExpExecArray | null;
  while ((m = SRT_BLOCK.exec(raw)) !== null) {
    const text = m[1].replace(/\r?\n/g, " ").trim();
    if (text) blocks.push({ speaker: "narrator", text });
  }
  return blocks;
}

const VTT_BLOCK = /(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}\s*\n([\s\S]+?)(?=\n\n|\n*$)/gm;

export function parseVtt(raw: string): Block[] {
  const blocks: Block[] = [];
  let m: RegExpExecArray | null;
  while ((m = VTT_BLOCK.exec(raw)) !== null) {
    const text = m[2].replace(/\r?\n/g, " ").trim();
    if (text) blocks.push({ speaker: "narrator", text });
  }
  return blocks;
}

export function parsePlainText(raw: string): Block[] {
  // Para reglas/markdown: cada párrafo es un bloque
  return raw
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((text) => ({ text }));
}

export function autoParse(filename: string, content: string, operatorName?: string): Block[] {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".srt")) return parseSrt(content);
  if (lower.endsWith(".vtt")) return parseVtt(content);
  // Heurística: si tiene formato WhatsApp en las primeras 20 líneas, asumir WhatsApp
  const head = content.split(/\r?\n/).slice(0, 20).join("\n");
  if (WHATSAPP_LINE.test(head)) return parseWhatsApp(content, operatorName);
  return parsePlainText(content);
}
