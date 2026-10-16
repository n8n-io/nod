import type { RuntimeContext } from '../ports/agent.ts';
import type { Computer } from '../ports/computer.ts';
import type { ExecutionScope } from '../shared/execution.ts';

export interface Turn {
  context: RuntimeContext;
  computer: Computer;
  execution: ExecutionScope;
  reply(text: string, id?: string, replyToMessageId?: string): Promise<unknown>;
  invite(text: string): Promise<unknown>;
  pause(
    reason: 'question' | 'approval' | 'credentials',
    text?: string,
    options?: { post?: boolean },
  ): Promise<void>;
  confirm(result: unknown): Promise<unknown>;
  delegate?(title: string, instruction: string): Promise<string>;
  followUp?(text: string): string;
}
