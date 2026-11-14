import { z } from 'zod';
import { presentationSchema } from './presentation';
import { answerChoicesSchema, questionAnswerSchema, type QuestionAnswer } from './answer-choices';
import type { SessionResponse } from './account';
import type {
  Activity,
  AppState,
  Artifact,
  Configuration,
  Message,
  MessageHistoryPage,
  SubmitMessageResponse,
  Turn,
} from './contracts';

export type ClientSession = Pick<SessionResponse, 'user' | 'settings'> & {
  capabilities: Pick<SessionResponse['capabilities'], 'developer' | 'traces'>;
};
export type ClientMessage = Pick<
  Message,
  | 'id'
  | 'role'
  | 'text'
  | 'audioCaption'
  | 'turnId'
  | 'createdAt'
  | 'attachments'
  | 'streamId'
  | 'reaction'
  | 'replyToMessageId'
  | 'answerChoices'
  | 'answerChoicesPending'
  | 'reactions'
  | 'presentation'
>;
export type ClientState = Omit<
  Pick<
    AppState,
    | 'threadId'
    | 'hasEarlierMessages'
    | 'pendingAnswerChoiceMessageIds'
    | 'verificationRequests'
    | 'planningTasks'
    | 'messages'
    | 'turns'
    | 'activity'
    | 'configuration'
  >,
  'messages' | 'activity'
> & { messages: ClientMessage[]; activity?: ClientActivity[] };
export type ClientHistory = Omit<MessageHistoryPage, 'messages'> & { messages: ClientMessage[] };
export type ClientSendResponse = SubmitMessageResponse;
export type ClientActivity = Pick<
  Activity,
  'turnId' | 'taskId' | 'title' | 'step' | 'site' | 'since'
>;
export type ClientSseEvent =
  | { type: 'refresh' }
  | {
      type: 'delta';
      threadId: string;
      turnId: string;
      text: string;
      streamId?: string;
      done?: boolean;
    }
  | { type: 'activity'; items: ClientActivity[] };
export interface ClientSendRequest {
  attachmentIds?: string[];
  text: string;
  clientMessageId: string;
  threadId: string;
  replyToMessageId?: string;
  questionAnswer?: QuestionAnswer;
}
export interface ClientStopResponse {
  ok: true;
}

const artifactSchema: z.ZodType<Artifact> = z.object({
  id: z.uuid(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  url: z.string(),
  source: z
    .enum(['browser_screenshot', 'sticker', 'sticker-preview', 'location', 'contact'])
    .optional(),
});

export const clientMessageSchema: z.ZodType<ClientMessage> = z.looseObject({
  id: z.uuid(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  audioCaption: z.string().optional(),
  turnId: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  attachments: z.array(artifactSchema),
  streamId: z.string().nullable().optional(),
  reaction: z.string().nullable().optional(),
  replyToMessageId: z.uuid().nullable().optional(),
  presentation: presentationSchema.optional(),
  answerChoices: answerChoicesSchema.optional(),
  answerChoicesPending: z.boolean().optional(),
  reactions: z
    .array(z.object({ actor: z.enum(['user', 'assistant']), reaction: z.string() }))
    .optional(),
});

export const clientTurnSchema: z.ZodType<Turn> = z.looseObject({
  id: z.uuid(),
  handoffMessageId: z.uuid().nullable().optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'waiting', 'failed', 'cancelled']),
  source: z.enum(['user', 'schedule', 'event', 'resume', 'task']),
  createdAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  error: z.string().nullable().optional(),
});

const activitySchema: z.ZodType<ClientActivity> = z.looseObject({
  turnId: z.uuid(),
  taskId: z.uuid().nullable(),
  title: z.string().nullable(),
  step: z.string().nullable(),
  site: z.string().nullable(),
  since: z.iso.datetime({ offset: true }),
});

const configurationSchema: z.ZodType<Configuration> = z.object({
  provider: z.string(),
  model: z.string(),
  llmReady: z.boolean(),
  modelReconnect: z.boolean(),
  integrationsReady: z.boolean(),
  conversationResetEnabled: z.boolean(),
});

export const clientSessionSchema: z.ZodType<ClientSession> = z.looseObject({
  user: z
    .object({
      id: z.string(),
      name: z.string(),
      email: z.string().nullable(),
      avatarUrl: z.string().nullable(),
    })
    .nullable(),
  settings: z
    .object({
      theme: z.enum(['system', 'light', 'dark']),
      onboardingCompleted: z.boolean(),
      usageData: z.boolean(),
      traces: z.boolean(),
    })
    .nullable(),
  capabilities: z.object({ developer: z.boolean(), traces: z.boolean() }),
});

export const clientStateSchema: z.ZodType<ClientState> = z.looseObject({
  threadId: z.uuid(),
  hasEarlierMessages: z.boolean().optional(),
  pendingAnswerChoiceMessageIds: z.array(z.uuid()).optional(),
  verificationRequests: z
    .array(
      z.object({
        id: z.uuid(),
        turnId: z.uuid(),
        kind: z.enum(['otp', 'payment']),
      }),
    )
    .optional(),
  planningTasks: z.boolean().optional(),
  messages: z.array(clientMessageSchema),
  turns: z.array(clientTurnSchema),
  activity: z.array(activitySchema).optional(),
  configuration: configurationSchema,
});

export const clientHistorySchema: z.ZodType<ClientHistory> = z.object({
  messages: z.array(clientMessageSchema),
  hasMore: z.boolean(),
});

export const clientSseEventSchema: z.ZodType<ClientSseEvent> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('refresh') }),
  z.object({
    type: z.literal('delta'),
    threadId: z.uuid(),
    turnId: z.uuid(),
    text: z.string(),
    streamId: z.string().optional(),
    done: z.boolean().optional(),
  }),
  z.object({ type: z.literal('activity'), items: z.array(activitySchema) }),
]);

export const clientHistoryQuerySchema = z
  .object({
    before: z.iso.datetime({ offset: true }).optional(),
    beforeId: z.uuid().optional(),
    threadId: z.uuid(),
  })
  .strict();

export const clientSendRequestSchema: z.ZodType<ClientSendRequest> = z
  .object({
    text: z.string().trim().max(100_000),
    attachmentIds: z.array(z.uuid()).optional(),
    clientMessageId: z.uuid(),
    threadId: z.uuid(),
    replyToMessageId: z.uuid().optional(),
    questionAnswer: questionAnswerSchema.optional(),
  })
  .strict()
  .refine((value) => value.text.length > 0 || (value.attachmentIds?.length ?? 0) > 0)
  .refine((value) => !value.questionAnswer || Boolean(value.replyToMessageId));

export const clientSendResponseSchema: z.ZodType<ClientSendResponse> = z.looseObject({
  threadId: z.uuid(),
  turnId: z.uuid(),
  messageId: z.uuid(),
  messageText: z.string().optional(),
  audioCaption: z.string().optional(),
  verificationStatus: z.enum(['pending', 'submitted', 'unavailable']).optional(),
});

export const clientStopResponseSchema: z.ZodType<ClientStopResponse> = z.object({
  ok: z.literal(true),
});

const endpointSchema = z.object({
  method: z.enum(['GET', 'POST']),
  path: z.string().startsWith('/api/'),
  response: z.enum(['json', 'sse']),
  query: z.array(z.string()).optional(),
  body: z.array(z.string()).optional(),
  events: z.array(z.enum(['refresh', 'delta', 'activity'])).optional(),
});

export const clientCapabilitiesSchema = z.object({
  features: z.object({ attachments: z.boolean() }).optional(),
  contractVersion: z.literal(1),
  authentication: z.object({ mode: z.literal('bearer') }),
  endpoints: z.object({
    session: endpointSchema,
    state: endpointSchema,
    history: endpointSchema,
    events: endpointSchema,
    send: endpointSchema,
    stop: endpointSchema,
  }),
  errors: z.object({
    '401': z.object({ meaning: z.literal('token_rejected'), recovery: z.literal('replace_token') }),
    '403': z.object({
      meaning: z.literal('host_or_origin_rejected'),
      recovery: z.literal('fix_server_origin'),
    }),
    '409': z.object({
      meaning: z.literal('conversation_conflict_or_reset'),
      recovery: z.literal('reload_state'),
    }),
    '503': z.object({
      meaning: z.literal('service_unavailable'),
      recovery: z.literal('retry_later'),
    }),
  }),
});

export type ClientCapabilities = z.infer<typeof clientCapabilitiesSchema>;

export const clientCapabilities: ClientCapabilities = {
  features: { attachments: true },
  contractVersion: 1,
  authentication: { mode: 'bearer' },
  endpoints: {
    session: { method: 'GET', path: '/api/session', response: 'json' },
    state: { method: 'GET', path: '/api/state', response: 'json' },
    history: {
      method: 'GET',
      path: '/api/messages',
      response: 'json',
      query: ['before', 'beforeId', 'threadId'],
    },
    events: {
      method: 'GET',
      path: '/api/events',
      response: 'sse',
      events: ['refresh', 'delta', 'activity'],
    },
    send: {
      method: 'POST',
      path: '/api/messages',
      response: 'json',
      body: [
        'text',
        'attachmentIds',
        'clientMessageId',
        'threadId',
        'replyToMessageId',
        'questionAnswer',
      ],
    },
    stop: { method: 'POST', path: '/api/thread/stop', response: 'json' },
  },
  errors: {
    '401': { meaning: 'token_rejected', recovery: 'replace_token' },
    '403': { meaning: 'host_or_origin_rejected', recovery: 'fix_server_origin' },
    '409': { meaning: 'conversation_conflict_or_reset', recovery: 'reload_state' },
    '503': { meaning: 'service_unavailable', recovery: 'retry_later' },
  },
};
