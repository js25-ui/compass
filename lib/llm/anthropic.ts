import Anthropic from '@anthropic-ai/sdk';

export const SONNET_MODEL = 'claude-sonnet-4-5';
export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

/**
 * Run a one-shot Haiku completion. Used for entity extraction, intent
 * classification, and other low-latency router tasks.
 */
export async function haikuComplete(opts: {
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
}): Promise<string> {
  const client = getAnthropic();
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: opts.maxTokens ?? 512,
    system: [
      {
        type: 'text',
        text: opts.systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: opts.userMessage }],
  });
  const block = response.content[0];
  if (block.type === 'text') return block.text;
  return '';
}

/**
 * Stream a Sonnet completion. Yields text chunks as they arrive.
 * Caller is responsible for shaping these into NDJSON or SSE.
 */
export async function* streamSonnet(opts: {
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
}): AsyncGenerator<{ type: 'token'; text: string } | { type: 'done'; usage: { input: number; output: number } }> {
  const client = getAnthropic();
  const stream = client.messages.stream({
    model: SONNET_MODEL,
    max_tokens: opts.maxTokens ?? 1500,
    system: [
      {
        type: 'text',
        text: opts.systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: opts.userMessage }],
  });

  let inputTokens = 0;
  let outputTokens = 0;

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield { type: 'token', text: event.delta.text };
    }
    if (event.type === 'message_start') {
      inputTokens = event.message.usage.input_tokens;
    }
    if (event.type === 'message_delta') {
      outputTokens = event.usage.output_tokens;
    }
  }

  yield { type: 'done', usage: { input: inputTokens, output: outputTokens } };
}
