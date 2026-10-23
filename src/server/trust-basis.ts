import type { TrustBecause } from '../shared/trust.ts';

export type TrustBasis =
  | { kind: 'read' }
  | { kind: 'message'; messageId: string; quote: string }
  | { kind: 'schedule' | 'standing' | 'rule'; quote: string }
  | { kind: 'approved' };

export interface TrustWords {
  userMessages?: Array<{ at: string; text: string }>;
  assistantMessageBeforeLatestUserMessage?: string;
  scheduledTaskInstruction?: string;
  scheduledFor?: string;
  timeZone?: string;
  standingInstruction?: string;
  userRules?: string;
}

const plain = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[“”«»„]/g, '"')
    .replace(/[‘’‚]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

export function trustBasis(
  answer: unknown,
  words: TrustWords,
  messageIds: readonly string[],
): TrustBasis | undefined {
  if (!answer || typeof answer !== 'object') return undefined;
  const { run, because } = answer as { run?: unknown; because?: unknown };
  if (run !== true || typeof because !== 'string') return undefined;
  if (because === 'read') return { kind: 'read' };
  const quote = because
    .trim()
    .replace(/^["'“”«»„‘’‚]+|["'“”«»„‘’‚.!?…]+$/gu, '')
    .trim();
  const needle = plain(quote);
  if (!needle) return undefined;
  const said = (text: string | undefined) => text !== undefined && plain(text).includes(needle);
  const index = words.userMessages?.findIndex((message) => said(message.text)) ?? -1;
  const kept = quote.slice(0, 300);
  if (index >= 0)
    return messageIds[index]
      ? { kind: 'message', messageId: messageIds[index], quote: kept }
      : undefined;
  if (said(words.scheduledTaskInstruction)) return { kind: 'schedule', quote: kept };
  if (said(words.standingInstruction)) return { kind: 'standing', quote: kept };
  if (said(words.userRules)) return { kind: 'rule', quote: kept };
  return undefined;
}

export function becauseOf(
  basis: TrustBasis | null | undefined,
  said: boolean | null,
): TrustBecause | undefined {
  if (!basis || basis.kind === 'read') return undefined;
  if (basis.kind === 'approved') return { kind: 'approved' };
  if (basis.kind === 'message' && !said) return undefined;
  return { kind: basis.kind, text: basis.quote };
}
