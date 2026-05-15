/**
 * Token-aware text chunker. Uses a coarse 1-token ≈ 4-character heuristic
 * (matches OpenAI/Anthropic tokenizer ratios closely enough for chunk sizing).
 *
 * Default: ~512 tokens per chunk with 50-token overlap, splitting on sentence
 * boundaries when possible. Tuned for the same chunking strategy as the telco
 * capstone: prefer paragraphs → fall back to sentences → fall back to hard
 * char-window splits.
 */

import { tagChunksBySection, type SectionTag } from './sections';

export interface ChunkOptions {
  targetTokens?: number;
  overlapTokens?: number;
  /** SEC form type (10-Q, 10-K, 8-K, etc.) or document doc_type. Drives
   *  section detection — when set, every returned chunk includes its
   *  section tag so retrieval can re-rank by intent × section. */
  docType?: string;
}

const CHARS_PER_TOKEN = 4;

export interface Chunk {
  index: number;
  content: string;
  charStart: number;
  charEnd: number;
  /** Filled when docType is passed to chunkText. Unknown otherwise. */
  section?: SectionTag;
}

/**
 * Hard upper bound enforced regardless of sentence detection: filings often
 * contain long XBRL preambles or numeric tables with no period punctuation,
 * which makes sentence-based splitting return a single mega-"sentence". We
 * cap each chunk to MAX_CHARS so Voyage's 32K-token-per-input limit is never
 * breached even when the input is messy.
 */
const MAX_CHARS = 4 * 4 * 1024; // ~4K tokens at 4 chars/token

export function chunkText(input: string, opts: ChunkOptions = {}): Chunk[] {
  const targetTokens = opts.targetTokens ?? 512;
  const overlapTokens = opts.overlapTokens ?? 50;
  const targetChars = targetTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;

  const text = input.replace(/\s+/g, ' ').trim();
  if (!text) return [];

  if (text.length <= targetChars) {
    return [{ index: 0, content: text, charStart: 0, charEnd: text.length }];
  }

  const sentences = splitSentences(text).flatMap(forceSplit);
  const chunks: Chunk[] = [];
  let buffer = '';
  let bufferStart = 0;
  let cursor = 0;

  for (const sentence of sentences) {
    const sentenceLen = sentence.length;
    if (buffer.length + sentenceLen + 1 > targetChars && buffer.length > 0) {
      chunks.push({
        index: chunks.length,
        content: buffer.trim(),
        charStart: bufferStart,
        charEnd: bufferStart + buffer.length,
      });
      const overlap = buffer.slice(Math.max(0, buffer.length - overlapChars));
      buffer = overlap;
      bufferStart = bufferStart + (buffer.length - overlap.length);
    }
    if (buffer.length === 0) {
      bufferStart = cursor;
    }
    buffer = buffer ? `${buffer} ${sentence}` : sentence;
    cursor += sentenceLen + 1;
  }

  if (buffer.trim().length > 0) {
    chunks.push({
      index: chunks.length,
      content: buffer.trim(),
      charStart: bufferStart,
      charEnd: bufferStart + buffer.length,
    });
  }

  if (opts.docType) {
    const sections = tagChunksBySection(text, chunks, opts.docType);
    for (let i = 0; i < chunks.length; i++) chunks[i].section = sections[i];
  }

  return chunks;
}

/** Hard-split a "sentence" that's too long into MAX_CHARS-sized windows. */
function forceSplit(sentence: string): string[] {
  if (sentence.length <= MAX_CHARS) return [sentence];
  const out: string[] = [];
  for (let i = 0; i < sentence.length; i += MAX_CHARS) {
    out.push(sentence.slice(i, i + MAX_CHARS));
  }
  return out;
}

function splitSentences(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?]+(?:[.!?]+(?=\s|$)|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  return out.length > 0 ? out : [text];
}
