// Cliente del Edge Function /functions/v1/embed.
// Usa el modelo Supabase.ai gte-small (384 dims).

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const BATCH_SIZE = 1;
const MAX_RETRIES = 5;
const INTER_BATCH_DELAY_MS = 350;

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function embedBatch(batch: string[], attempt = 1): Promise<number[][]> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/embed`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ inputs: batch }),
    });
    if (res.ok) {
      const { embeddings } = (await res.json()) as { embeddings: number[][] };
      return embeddings;
    }
    const text = await res.text();
    // Retryable: 5xx (incluye 502/503/504/546) y throttling
    const isRetryable =
      res.status >= 500 ||
      res.status === 429 ||
      text.includes("WORKER_RESOURCE_LIMIT") ||
      text.includes("BOOT_ERROR");
    if (isRetryable && attempt < MAX_RETRIES) {
      const backoff = Math.min(5000, 500 * Math.pow(2, attempt - 1));
      await sleep(backoff);
      return embedBatch(batch, attempt + 1);
    }
    throw new Error(`embed function: ${res.status} ${text}`);
  } catch (err) {
    // Errores de red: retry también
    if (attempt < MAX_RETRIES && err instanceof Error && err.message.includes("fetch failed")) {
      await sleep(500 * attempt);
      return embedBatch(batch, attempt + 1);
    }
    throw err;
  }
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const embeddings = await embedBatch(batch);
    out.push(...embeddings);
    // Pequeño respiro para que la función no acumule presión
    if (i + BATCH_SIZE < texts.length) await sleep(INTER_BATCH_DELAY_MS);
  }
  return out;
}

export async function embedOne(text: string): Promise<number[]> {
  const [emb] = await embedTexts([text]);
  return emb;
}
