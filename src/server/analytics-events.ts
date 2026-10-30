import { z } from 'zod';
import { modelProviders } from '../shared/models.ts';

export const analyticsVersion = z
  .string()
  .max(80)
  .regex(/^(?:[a-f0-9]{7,64}|\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)$/);

const domain = z
  .string()
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?)$/,
  );

const serviceFailureReason = z.enum([
  'authentication',
  'permission',
  'rate_limited',
  'timeout',
  'unavailable',
  'invalid_request',
  'cancelled',
  'unknown',
]);
const connectionProperties = z.object({
  app: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),
  domain: domain.optional(),
  connection_method: z.enum(['managed_app', 'browser', 'http', 'mcp', 'cli']),
});
const duration = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const analyticsTool = z.enum([
  'apps',
  'ask_user',
  'browser',
  'browser_session',
  'create_audio',
  'delegate',
  'follow_up',
  'manage_apps',
  'manage_personal_context',
  'pay',
  'react_to_message',
  'send_message',
  'share_file',
  'sign_in',
  'skills',
  'task',
  'workspace',
  'web',
  'other',
]);
export const analyticsModelProvider = z.enum([...modelProviders, 'typesafe', 'other']);
const analyticsModel = z.string().regex(/^[a-z0-9][a-z0-9._:/-]{0,119}$/);
const modelConnectionProperties = z.object({
  provider: z.enum(modelProviders),
  method: z.enum(['api_key', 'subscription', 'oauth']),
});
const turnProperties = z.object({
  source: z.enum(['user', 'schedule', 'event', 'resume', 'task']),
  channel: z.enum(['web', 'telegram', 'whatsapp', 'other']),
  background: z.boolean(),
  model_provider: analyticsModelProvider.optional(),
  model: analyticsModel.optional(),
});
export const analyticsEvent = z.discriminatedUnion('event', [
  z
    .object({
      event: z.literal('nod_onboarding_completed'),
      properties: z.object({ model_provider: analyticsModelProvider }).strict().optional(),
    })
    .strict(),
  z.object({ event: z.literal('nod_conversation_reset') }).strict(),
  z.object({ event: z.literal('nod_chat_stopped') }).strict(),
  z.object({ event: z.literal('nod_task_stopped') }).strict(),
  z
    .object({
      event: z.literal('nod_feedback_sent'),
      properties: z
        .object({
          category: z.enum(['bug', 'feature', 'other']).optional(),
          has_attachments: z.boolean(),
          has_report: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z.object({ event: z.literal('nod_turn_started'), properties: turnProperties.strict() }).strict(),
  z
    .object({
      event: z.literal('nod_turn_completed'),
      properties: turnProperties
        .extend({
          outcome: z.enum([
            'succeeded',
            'waiting_credentials',
            'waiting_user',
            'failed',
            'cancelled',
            'interrupted',
            'skipped',
          ]),
          duration_ms: duration,
          queue_duration_ms: duration.optional(),
          waiting_reason: z.enum(['question', 'approval', 'credentials']).optional(),
          failure_reason: z.enum(['spending_limit', 'model', 'unknown']).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('nod_settings_updated'),
      properties: z
        .object({
          section: z.enum(['account', 'preferences', 'channels', 'models', 'trust', 'memory']),
          operation: z.enum(['update', 'connect_started', 'disconnect']),
          channel: z.enum(['telegram', 'whatsapp']).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('nod_schedule_changed'),
      properties: z
        .object({
          operation: z.enum(['create', 'update', 'delete']),
          schedule_kind: z.enum(['once', 'recurring']).optional(),
          cadence: z.enum(['once', 'hourly', 'daily', 'weekly', 'monthly', 'custom']).optional(),
          actor: z.enum(['user', 'agent']).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('nod_connection_changed'),
      properties: connectionProperties
        .extend({
          status: z.enum(['started', 'connected', 'failed', 'disconnected']),
          failure_reason: z
            .union([
              serviceFailureReason,
              z.enum(['invalid_configuration', 'authorization_failed', 'verification_failed']),
            ])
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('nod_service_used'),
      properties: connectionProperties
        .extend({
          operation_phase: z.literal('preparation').optional(),
          outcome: z.enum(['succeeded', 'failed', 'cancelled']),
          duration_ms: duration,
          failure_reason: serviceFailureReason.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('nod_connection_observed'),
      properties: connectionProperties.strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('nod_vault_imported'),
      properties: z
        .object({
          domains: z
            .array(z.union([domain, z.literal('unavailable')]))
            .min(1)
            .max(100),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('nod_vault_changed'),
      properties: z
        .object({
          item_type: z.enum(['login', 'card']),
          operation: z.enum(['create', 'update', 'delete']),
          source: z.enum(['user', 'agent']).optional(),
          domain: domain.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('nod_memory_changed'),
      properties: z
        .object({
          kind: z.enum(['note', 'skill']),
          operation: z.enum(['save', 'forget', 'archive', 'clear']),
          actor: z.enum(['owner', 'agent', 'background']),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('nod_tool_used'),
      properties: z
        .object({
          tool: analyticsTool,
          outcome: z.enum(['succeeded', 'failed', 'cancelled']),
          duration_ms: duration,
          subagent: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('nod_confirmation_changed'),
      properties: z
        .object({
          status: z.enum(['asked', 'approved', 'declined', 'executed', 'expired', 'uncertain']),
          action_kind: z.enum(['app', 'browser', 'sign_in', 'settings', 'memory']),
          source: z.enum(['user', 'schedule', 'event', 'resume', 'task']),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('nod_model_used'),
      properties: z
        .object({
          provider: analyticsModelProvider,
          model: analyticsModel.optional(),
          purpose: z.enum(['agent', 'memory', 'review', 'tasks', 'analytics']),
          outcome: z.enum(['succeeded', 'failed', 'cancelled']),
          input_tokens: duration,
          output_tokens: duration,
          cached_input_tokens: duration.optional(),
          cost_usd: z.number().nonnegative().max(1_000_000).optional(),
          pricing: z.enum(['api', 'plan_estimate', 'unavailable']),
          duration_ms: duration.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('nod_model_connection_changed'),
      properties: modelConnectionProperties
        .extend({ status: z.enum(['connected', 'disconnected', 'failed']) })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('nod_model_connection_observed'),
      properties: modelConnectionProperties
        .extend({
          selected: z.boolean(),
          model: analyticsModel.optional(),
          effort: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('nod_link_opened'),
      properties: z
        .object({
          domain,
          source: z.enum(['text', 'preview', 'tooltip', 'player']),
          position: z.number().int().min(1).max(20).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('nod_website_visited'),
      properties: z
        .object({ domain, via: z.enum(['browser', 'fetch']), subagent: z.boolean() })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('nod_secure_entry_changed'),
      properties: z
        .object({
          kind: z.enum(['sign_in', 'payment', 'code']),
          status: z.enum([
            'requested',
            'superseded',
            'approved',
            'submitted',
            'failed',
            'uncertain',
          ]),
          domain: domain.optional(),
          currency: z
            .string()
            .regex(/^[A-Z]{3}$/)
            .optional(),
          amount: z.number().nonnegative().max(1_000_000).optional(),
        })
        .strict(),
    })
    .strict(),
]);

export type AnalyticsEvent = z.infer<typeof analyticsEvent>;
