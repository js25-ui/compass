/**
 * Conversational clarification — the LBO-only path that replaces the form card.
 *
 * Instead of rendering a structured "scope card" with dropdowns, we stream a
 * Sonnet-written message into the chat that:
 *   - Acknowledges what's already known (target + extracted params)
 *   - Lists the missing parameters as a short numbered list with typical ranges
 *   - Tells the user they can answer in any order, in natural language
 *
 * The user's reply comes back through the chat input. The route handler runs
 * the parameter extractor on it, merges with the partial scope from the prior
 * turn, and either re-asks (still missing) or routes to the LBO pipeline.
 */
import { streamSonnet } from '@/lib/llm/anthropic';
import type { TaskManifest, ParamSpec } from '@/lib/manifests/types';
import type { AcknowledgementPill } from './parameter_extractor';

export interface ConversationalAskArgs {
  manifest: TaskManifest;
  detectedTarget: { name: string; ticker?: string } | null;
  /** Pills for params Compass already has — passed in from the same builder
   *  used by the form card so wording stays consistent. */
  acknowledgedPills: AcknowledgementPill[];
  /** Manifest params that still need values (required + recommended). */
  missingParams: ParamSpec[];
  /** True on the second-or-later ask — Compass should sound a bit terser
   *  and reference that the user just answered partially. */
  isContinuation: boolean;
}

const SYSTEM_PROMPT = `You are Compass — an AI capital markets analyst. You're scoping an LBO model with a colleague.

Write a SHORT, CONVERSATIONAL message asking for the missing inputs. Voice: senior banker confirming inputs with an associate. Direct, not obsequious. No "I'd be happy to" or "Sure!"

Format:
1. ONE-LINE acknowledgement: "Got it — <Target> LBO." or similar. If you already have parameters from the prompt, name them inline.
2. ONE blank line.
3. NUMBERED list of the missing parameters, ONE per line. For each: param name + ONE parenthetical hint (typical range or options). Don't paraphrase the hint heavily — keep it to ~10 words.
4. ONE blank line.
5. ONE closing line telling the user they can answer in any order in natural language.

If this is a CONTINUATION ask (user already answered partially), skip the acknowledgement of original params, just say something like "Still need:" then list, then close.

Output PLAIN TEXT only — no markdown headers, no bold, no code fences. Newlines OK.

Length: 6-12 lines total. Strict.`;

function pillsToInline(pills: AcknowledgementPill[]): string {
  if (pills.length === 0) return '';
  if (pills.length === 1) return pills[0].label;
  if (pills.length === 2) return `${pills[0].label} and ${pills[1].label}`;
  return pills.slice(0, -1).map(p => p.label).join(', ') + ', and ' + pills[pills.length - 1].label;
}

function paramHintLine(p: ParamSpec): string {
  if (p.kind === 'select' && p.options) {
    const opts = p.options.map(o => o.label).join(', ');
    return `${p.label} (${opts})`;
  }
  if (p.hint) {
    // Trim the hint; the system prompt asks for short parentheticals.
    const trimmed = p.hint.replace(/\.$/, '').slice(0, 80);
    return `${p.label} (${trimmed})`;
  }
  if (p.unit) return `${p.label} (${p.unit})`;
  return p.label;
}

function buildUserMessage(args: ConversationalAskArgs): string {
  const target = args.detectedTarget
    ? `${args.detectedTarget.name}${args.detectedTarget.ticker ? ` (${args.detectedTarget.ticker})` : ''}`
    : '<unspecified target>';
  const ackInline = pillsToInline(args.acknowledgedPills);
  const missingLines = args.missingParams.map((p, i) => `${i + 1}. ${paramHintLine(p)}`).join('\n');

  const lines: string[] = [
    `Target: ${target}`,
    `Task: ${args.manifest.label}`,
    args.isContinuation ? `Mode: continuation (user answered partially; do not re-acknowledge previously-stated params)` : `Mode: initial`,
    args.acknowledgedPills.length > 0
      ? `Already captured from the prompt: ${ackInline}`
      : `Already captured: nothing — first contact.`,
    '',
    `Still missing (${args.missingParams.length}):`,
    missingLines,
    '',
    `Write the conversational ask now.`,
  ];
  return lines.join('\n');
}

/**
 * Stream the conversational ask. Yields token events the route can relay
 * straight to the NDJSON stream.
 */
export async function* streamConversationalAsk(
  args: ConversationalAskArgs,
): AsyncGenerator<{ type: 'token'; text: string }> {
  const userMessage = buildUserMessage(args);
  const stream = streamSonnet({
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    maxTokens: 400,
  });
  for await (const event of stream) {
    if (event.type === 'token') yield event;
  }
}

/**
 * One-line confirmation rendered just before the LBO pipeline kicks off, so
 * the user sees Compass acknowledge the full scope before computation starts.
 */
export function buildLockedInLine(args: {
  manifest: TaskManifest;
  detectedTarget: { name: string; ticker?: string } | null;
  scope: Record<string, string | number | boolean | string[]>;
}): string {
  const target = args.detectedTarget?.name ?? args.manifest.label;
  const parts: string[] = [];
  const ev = args.scope.entry_ev;
  if (typeof ev === 'number') {
    parts.push(ev >= 1000 ? `$${(ev / 1000).toFixed(ev % 1000 === 0 ? 0 : 1)}B EV` : `$${ev}M EV`);
  }
  const lev = args.scope.leverage_multiple;
  if (typeof lev === 'number') parts.push(`${lev}x leverage`);
  const hold = args.scope.hold_period;
  if (typeof hold === 'number') parts.push(`${hold}y hold`);
  const exitMult = args.scope.exit_multiple;
  if (typeof exitMult === 'number') parts.push(`${exitMult}x exit`);
  const exitRoute = args.scope.exit_route;
  if (typeof exitRoute === 'string') parts.push(`${exitRoute.replace(/_/g, ' ')} exit`);
  const cagr = args.scope.revenue_cagr;
  if (typeof cagr === 'number') parts.push(`${cagr}% CAGR`);
  return `Locked in — ${target} LBO at ${parts.join(', ')}. Building now.\n\n`;
}
