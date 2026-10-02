import { z } from 'zod';
import type { PoolClient } from 'pg';
import { parse } from 'tldts';
import type { VerificationEmail } from '../ports/integrations.ts';

export interface EmailCodeRequest {
  recipient: string;
  origin: string;
  after: number;
  before: number;
}

export interface PrivateEmailCode {
  code: string;
  current(database?: Pick<PoolClient, 'query'>): Promise<boolean>;
}

export function normalizedEmail(value: string) {
  const result = z.email().max(320).safeParse(value.trim().toLowerCase());
  return result.success ? result.data : undefined;
}

export function verificationRecipient(
  delivery: { recipient?: string; recipientHint?: string },
  selected?: string,
) {
  const recipient = normalizedEmail(delivery.recipient ?? '');
  if (delivery.recipient && (!recipient || (selected && recipient !== selected))) return;
  if (delivery.recipientHint) {
    const hint = delivery.recipientHint.trim().toLowerCase();
    if (
      !selected ||
      hint.length > 320 ||
      !/^[a-z0-9._%+*•-]+@[a-z0-9.*•-]+\.[a-z*•]{2,}$/.test(hint)
    )
      return;
    const pattern = hint
      .split(/[*•]+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.+');
    if (!new RegExp(`^${pattern}$`).test(selected)) return;
  }
  return recipient ?? selected;
}

export function verificationSenderDomain(origin: string) {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) return;
    const result = parse(url.hostname, { allowPrivateDomains: true });
    if (result.isIp || (!result.isIcann && !result.isPrivate)) return;
    return result.domain ?? undefined;
  } catch {
    return;
  }
}

export function verificationCode(messages: VerificationEmail[], input: EmailCodeRequest) {
  const domain = verificationSenderDomain(input.origin);
  if (!domain || messages.length > 5) return;
  const matches: string[] = [];
  for (const message of messages) {
    const authenticatedDomain = verificationSenderDomain(`https://${message.authenticatedDomain}`);
    const senderDomain = verificationSenderDomain(`https://${message.sender.split('@')[1]}`);
    if (
      message.receivedAt < input.after ||
      message.receivedAt > input.before ||
      !authenticatedDomain ||
      authenticatedDomain !== senderDomain ||
      authenticatedDomain !== domain ||
      !message.recipients.includes(input.recipient) ||
      message.text.length > 64_000
    )
      continue;
    const codes = new Set<string>();
    const phrase =
      /(?:verification|authentication|security|sign[ -]?in|login|one[ -]?time|verify|confirm|verifica[çc][aã]o|autentica[çc][aã]o|seguran[çc]a|acesso|c[oó]digo)/giu;
    for (const match of message.text.matchAll(phrase)) {
      const nearby = message.text.slice(
        Math.max(0, match.index - 30),
        match.index + match[0].length + 100,
      );
      for (const value of nearby.matchAll(/(?<![a-z0-9])\d{4,8}(?![a-z0-9])/gi))
        codes.add(value[0]);
    }
    if (codes.size !== 1) {
      if (codes.size > 1) return;
      continue;
    }
    matches.push([...codes][0]);
  }
  return matches.length === 1 ? matches[0] : undefined;
}
