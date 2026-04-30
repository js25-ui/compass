const VOYAGE_API = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3';
export const VOYAGE_DIMS = 1024;
const BATCH_SIZE = 128;
const MAX_RETRIES = 3;

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { total_tokens: number };
}

function key(): string {
  const k = process.env.VOYAGE_API_KEY;
  if (!k) throw new Error('VOYAGE_API_KEY is not set');
  return k;
}

/**
 * Embed `texts` via voyage-3 in batches of up to 128. Returns embeddings in
 * the same order. Retries on 429 with exponential backoff.
 */
export async function embedTexts(
  texts: string[],
  inputType: 'document' | 'query' = 'document',
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const apiKey = key();
  const out: number[][] = new Array(texts.length);

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);
    const embeddings = await embedBatch(batch, inputType, apiKey);
    for (let i = 0; i < embeddings.length; i++) out[start + i] = embeddings[i];
  }
  return out;
}

async function embedBatch(
  batch: string[],
  inputType: 'document' | 'query',
  apiKey: string,
): Promise<number[][]> {
  let attempt = 0;
  let lastError: unknown = null;
  while (attempt < MAX_RETRIES) {
    try {
      const res = await fetch(VOYAGE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ input: batch, model: MODEL, input_type: inputType }),
      });
      if (res.status === 429) {
        await sleep((attempt + 1) * 2000);
        attempt += 1;
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Voyage embedding failed (${res.status}): ${body.slice(0, 300)}`);
      }
      const json = (await res.json()) as VoyageResponse;
      return json.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
    } catch (err) {
      lastError = err;
      await sleep((attempt + 1) * 1000);
      attempt += 1;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Voyage embedding failed after retries');
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
