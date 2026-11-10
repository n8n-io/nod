import type { Presentation } from '../shared/presentation.ts';
import type { AnswerChoices } from '../shared/answer-choices.ts';
import type { RuntimeContext } from '../ports/agent.ts';
import type { Computer } from '../ports/computer.ts';
import type { ExecutionScope } from '../shared/execution.ts';

export interface ReplyDelivery {
  delivered: boolean;
  presentation: 'none' | 'original';
}

export interface Turn {
  context: RuntimeContext;
  computer: Computer;
  execution: ExecutionScope;
  reply(
    text: string,
    id?: string,
    replyToMessageId?: string,
    presentation?: Presentation,
  ): Promise<ReplyDelivery>;
  pause(
    reason: 'question' | 'approval' | 'credentials' | 'browser',
    message?: string,
    answerChoices?: AnswerChoices,
  ): Promise<void>;
  confirm(result: unknown): Promise<unknown>;
  visited(browserId: string, url: string): void;
  delegate?(title: string, instruction: string): Promise<string>;
  setStatus?(text: string): Promise<string>;
}
