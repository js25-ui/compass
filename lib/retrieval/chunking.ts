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

  // Capture each sentence WITH its position in the original collapsed text.
  // Inline-XBRL filings start with a 30-100KB run of XBRL metadata that has
  // no '. ' boundaries — the sentence regex skips it entirely. Tracking
  // m.index keeps chunk charStart values aligned to the original text so
  // section detection (which uses position offsets to find ITEM headings)
  // tags the right chunks. Force-splitting handles the giant first
  // sentence so each chunk stays ~targetChars wide.
  const rawSentences = splitSentencesWithIndex(text);
  const positionedSentences: Array<{ text: string; index: number }> = [];
  for (const s of rawSentences) {
    const pieces = forceSplit(s.text, targetChars);
    let offset = 0;
    for (const piece of pieces) {
      positionedSentences.push({ text: piece, index: s.index + offset });
      offset += piece.length;
    }
  }

  const chunks: Chunk[] = [];
  let buffer = '';
  let bufferStart = -1;

  for (const sent of positionedSentences) {
    const sentenceLen = sent.text.length;
    if (buffer.length + sentenceLen + 1 > targetChars && buffer.length > 0) {
      const flushedLen = buffer.length;
      chunks.push({
        index: chunks.length,
        content: buffer.trim(),
        charStart: bufferStart,
        charEnd: bufferStart + flushedLen,
      });
      const overlap = buffer.slice(Math.max(0, flushedLen - overlapChars));
      buffer = overlap;
      // The new buffer (overlap) represents the last overlapChars of the
      // flushed chunk — its starting position is the previous chunk's
      // end minus the overlap length.
      bufferStart = bufferStart + flushedLen - overlap.length;
    }
    if (buffer.length === 0) {
      bufferStart = sent.index;
    }
    buffer = buffer ? `${buffer} ${sent.text}` : sent.text;
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

function splitSentencesWithIndex(text: string): Array<{ text: string; index: number }> {
  const out: Array<{ text: string; index: number }> = [];
  const re = /[^.!?]+(?:[.!?]+(?=\s|$)|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Capture position BEFORE trim — trim only adjusts leading/trailing
    // whitespace, which is rare here since text is already collapsed.
    const matched = m[0];
    const trimmed = matched.trim();
    if (trimmed) {
      // Adjust index forward if trim removed leading whitespace.
      const leadingWs = matched.length - matched.trimStart().length;
      out.push({ text: trimmed, index: m.index + leadingWs });
    }
  }
  // If the regex returned ZERO matches, the whole text becomes one sentence
  // starting at index 0 (extreme edge case — periodless text).
  return out.length > 0 ? out : [{ text, index: 0 }];
}
