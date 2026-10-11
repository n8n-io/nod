import type { RuntimeContext } from '../ports/agent.ts';
import type { Computer } from '../ports/computer.ts';

export const privateInputNotice =
  'Not sent: never ask for passwords, sign-in codes, card details or API keys in chat. Use sign_in for website sign-in and pay for checkouts. Configure API keys outside chat.';

export interface Turn {
  context: RuntimeContext;
  computer: Computer;
  reply(text: string, id?: string, replyToMessageId?: string): Promise<unknown>;
  invite(text: string): Promise<unknown>;
  pause(
    reason: 'question' | 'approval' | 'credentials',
    text?: string,
    options?: { hold?: boolean; post?: boolean },
  ): Promise<void>;
  confirm(result: unknown): Promise<unknown>;
}
