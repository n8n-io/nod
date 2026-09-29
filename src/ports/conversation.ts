import type { TaskStatus } from '../shared/contracts.ts';

export const defaultConversationRoutingTimeoutMs = 5000;

export const conversationRoutingFailureCodes = [
  'initialization',
  'model_unavailable',
  'completion_setup',
  'transport',
  'response_processing',
  'output_limit',
  'unexpected_tool',
  'text_limit',
  'invalid_json',
  'invalid_decision',
  'unknown_outcome',
  'cancelled',
] as const;

export type ConversationRoutingFailureCode = (typeof conversationRoutingFailureCodes)[number];

export interface ConversationRoutingContext {
  text: string;
  hasAttachments: boolean;
  channel: string;
  conversationRevision: number;
  recentConversation?: Array<{
    role: 'user' | 'assistant';
    text: string;
    outcomeId: string | null;
  }>;
  candidates: Array<{
    outcomeId: string;
    title: string;
    objective: string;
    taskId: string;
    status: TaskStatus;
    waitingReason: string | null;
    recency?: number;
    recentMessages: Array<{ role: 'user' | 'assistant'; text: string }>;
  }>;
  blockedCandidates?: ConversationRoutingContext['candidates'];
  signal: AbortSignal;
}

export type ConversationRouteDecision =
  | { kind: 'conversation' }
  | { kind: 'new_outcome'; title: string; objective: string }
  | { kind: 'continue'; outcomeId: string };

export type ConversationRouter = (
  context: ConversationRoutingContext,
) => Promise<ConversationRouteDecision>;
