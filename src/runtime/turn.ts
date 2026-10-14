import type { RuntimeContext } from '../ports/agent.ts';
import type { Computer } from '../ports/computer.ts';

export interface Turn {
  context: RuntimeContext;
  computer: Computer;
  browserId: string;
  reply(text: string, id?: string, replyToMessageId?: string): Promise<unknown>;
  invite(text: string): Promise<unknown>;
  pause(
    reason: 'question' | 'approval' | 'credentials',
    text?: string,
    options?: { post?: boolean },
  ): Promise<void>;
  confirm(result: unknown): Promise<unknown>;
  delegate?(title: string, instruction: string): Promise<string>;
}
