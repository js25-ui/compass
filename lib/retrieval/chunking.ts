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

  // When a "sentence" has no period (inline-XBRL filings have a 200KB+ run
  // of XBRL metadata with no sentence terminators), forceSplit windows it
  // into targetChars-sized pieces so we end up with properly-sized chunks
  // (~2KB each) instead of one 200KB mega-chunk.
  const sentences = splitSentences(text).flatMap(s => forceSplit(s, targetChars));
  const chunks: Chunk[] = [];
  let buffer = '';
  let bufferStart = 0;
  let cursor = 0;

  for (const sentence of sentences) {
    const sentenceLen = sentence.length;
    if (buffer.length + sentenceLen + 1 > targetChars && buffer.length > 0) {
      // Capture buffer length BEFORE reassigning buffer to overlap —
      // otherwise the advance math below uses the post-reassign length
      // (== overlap.length) and bufferStart never advances past 0,
      // breaking every position-based downstream consumer (section
      // tagger, citation locator, etc.).
      const flushedLen = buffer.length;
      chunks.push({
        index: chunks.length,
        content: buffer.trim(),
        charStart: bufferStart,
        charEnd: bufferStart + flushedLen,
      });
      const overlap = buffer.slice(Math.max(0, flushedLen - overlapChars));
      buffer = overlap;
      bufferStart = bufferStart + (flushedLen - overlap.length);
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

/** Hard-split a "sentence" that's too long into windowed pieces. The window
 *  size is the same targetChars the packer is aiming for — so a sentence-
 *  free run of text yields the same chunk count it would if sentence
 *  boundaries had been present. */
function forceSplit(sentence: string, windowChars: number): string[] {
  if (sentence.length <= windowChars) return [sentence];
  const out: string[] = [];
  for (let i = 0; i < sentence.length; i += windowChars) {
    out.push(sentence.slice(i, i + windowChars));
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
