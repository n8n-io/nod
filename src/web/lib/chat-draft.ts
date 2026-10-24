import type { Artifact, Message } from '../../shared/contracts';
import { classifyVerificationReply, securityCodeIn } from '../../shared/verification-code';
import { ownedArtifactUrl } from './attachment-url';

export type ChatDraft = {
  text: string;
  reply: Pick<Message, 'id' | 'role' | 'text'> | null;
  attachments: Artifact[];
  missing: string[];
};

export function readChatDraft(key: string): ChatDraft | null {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (
      !saved ||
      saved.version !== 1 ||
      typeof saved.text !== 'string' ||
      !Array.isArray(saved.attachments) ||
      !Array.isArray(saved.missing)
    )
      return null;
    return {
      text: saved.text,
      reply:
        saved.reply &&
        typeof saved.reply.id === 'string' &&
        ['assistant', 'user'].includes(saved.reply.role) &&
        typeof saved.reply.text === 'string'
          ? saved.reply
          : null,
      attachments: saved.attachments.filter(
        (item: Artifact) =>
          !!item &&
          typeof item === 'object' &&
          typeof item.id === 'string' &&
          typeof item.name === 'string' &&
          typeof item.mimeType === 'string' &&
          typeof item.size === 'number' &&
          ownedArtifactUrl(item.url),
      ),
      missing: saved.missing.filter((name: unknown) => typeof name === 'string'),
    };
  } catch {
    return null;
  }
}

export function writeChatDraft(key: string, draft: ChatDraft | null, privateReply = false) {
  try {
    if (
      !draft ||
      (!draft.text && !draft.reply && !draft.attachments.length && !draft.missing.length) ||
      (privateReply && classifyVerificationReply(draft.text).kind !== 'ordinary') ||
      /^\s*\d{4,8}\s*[.!]?\s*$/.test(draft.text) ||
      securityCodeIn(draft.text)
    )
      localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ ...draft, version: 1 }));
  } catch {
    return false;
  }
  return true;
}
