const VOYAGE_API = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3';
export const VOYAGE_DIMS = 1024;
const BATCH_SIZE = 96;
const MAX_RETRIES = 3;
const MIN_INTERVAL_MS = 21_000;       // free tier: 3 RPM, sliding window across all calls

// Module-level cursor — covers the case where back-to-back ingestions in the
// same Node process would each pass their own throttle but collectively
// exceed Voyage's per-minute window.
let lastCallAt = 0;

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
    await throttle();
    const batch = texts.slice(start, start + BATCH_SIZE);
    const embeddings = await embedBatch(batch, inputType, apiKey);
    for (let i = 0; i < embeddings.length; i++) out[start + i] = embeddings[i];
  }
  return out;
}

async function throttle(): Promise<void> {
  const elapsed = Date.now() - lastCallAt;
  if (elapsed < MIN_INTERVAL_MS) {
    await sleep(MIN_INTERVAL_MS - elapsed);
  }
  lastCallAt = Date.now();
}

async function embedBatch(
  batch: string[],
  inputType: 'document' | 'query',
  apiKey: string,
): Promise<number[][]> {
  let attempt = 0;
  let lastDetail = '';
  while (attempt < MAX_RETRIES) {
    try {
      const res = await fetch(VOYAGE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ input: batch, model: MODEL, input_type: inputType }),
      });
      if (res.status === 429) {
        // Voyage free tier: 3 RPM with a 60s window. Burning short
        // backoffs (2s/4s/6s) inside that window is pointless. Sleep
        // 22s then retry — clears one RPM slot. Only 1 retry to stay
        // inside Vercel's ingest function ceiling.
        if (attempt >= 1) {
          lastDetail = '429 rate limited (Voyage free-tier RPM exhausted)';
          break;
        }
        await sleep(22_000);
        attempt += 1;
        lastDetail = '429 rate limited';
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        // 4xx errors won't be fixed by retrying — fail fast.
        if (res.status >= 400 && res.status < 500) {
          throw new Error(`Voyage HTTP ${res.status}: ${body.slice(0, 500)}`);
        }
        lastDetail = `HTTP ${res.status}: ${body.slice(0, 200)}`;
        attempt += 1;
        await sleep((attempt + 1) * 1000);
        continue;
      }
      const json = (await res.json()) as VoyageResponse;
      return json.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
    } catch (err) {
      // Re-throw 4xx errors immediately; otherwise retry.
      if (err instanceof Error && /Voyage HTTP 4\d\d/.test(err.message)) throw err;
      lastDetail = err instanceof Error ? err.message : String(err);
      attempt += 1;
      await sleep(attempt * 1000);
    }
  }
  throw new Error(`Voyage embedding failed after ${MAX_RETRIES} retries: ${lastDetail}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
