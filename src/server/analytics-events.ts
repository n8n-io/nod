import { z } from 'zod';
import { modelProviders } from '../shared/models.ts';

export const analyticsVersion = z
  .string()
  .max(80)
  .regex(/^(?:[a-f0-9]{7,64}|\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)$/);

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
  connection_method: z.enum(['managed_app', 'browser', 'http', 'mcp', 'cli', 'local']),
});
const duration = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const taskType = z.enum([
  'research',
  'communication',
  'content_creation',
  'data_analysis',
  'file_management',
  'scheduling',
  'monitoring',
  'app_setup',
  'translation',
  'software_development',
  'transaction',
  'advice',
  'other',
  'unknown',
]);
export const analyticsTool = z.enum([
  'apps',
  'ask_user',
  'browser',
  'browser_session',
  'create_audio',
  'delegate',
  'files',
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
  work_type: z.enum(['immediate', 'scheduled', 'background']),
  owner_requested: z.boolean(),
  provider: analyticsModelProvider.optional(),
  model: analyticsModel.optional(),
  task_taxonomy_version: z.literal(1).optional(),
});
export const analyticsEvent = z.discriminatedUnion('event', [
  z
    .object({
      event: z.literal('task_classified'),
      properties: z
        .object({
          task_type: taskType,
          classification_status: z.enum(['classified', 'unavailable', 'failed', 'not_applicable']),
          task_taxonomy_version: z.literal(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('onboarding_completed'),
      properties: z.object({ provider: analyticsModelProvider }).strict().optional(),
    })
    .strict(),
  z
    .object({
      event: z.literal('model_setup_completed'),
      properties: z.object({ provider: analyticsModelProvider, model: analyticsModel }).strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('owner_message_accepted'),
      properties: z.object({ channel: z.enum(['web', 'telegram', 'whatsapp', 'other']) }).strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('channel_connection_observed'),
      properties: z
        .object({
          channel: z.enum(['telegram', 'whatsapp']),
          state: z.enum(['disabled', 'setup_pending', 'connected', 'configured_unverified']),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('output_created'),
      properties: z.union([
        z
          .object({
            presentation_kind: z.enum([
              'image',
              'map',
              'flights',
              'seats',
              'booking',
              'chart',
              'apps',
              'diagram',
            ]),
            count: z.literal(1),
          })
          .strict(),
        z
          .object({
            artifact_kind: z.enum([
              'image',
              'sticker',
              'audio',
              'video',
              'pdf',
              'markdown',
              'html',
              'csv',
              'spreadsheet',
              'document',
              'presentation',
              'archive',
              'n8n-workflow',
              'text',
              'file',
            ]),
            count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      ]),
    })
    .strict(),
  z.object({ event: z.literal('conversation_reset') }).strict(),
  z.object({ event: z.literal('chat_stopped') }).strict(),
  z.object({ event: z.literal('task_stopped') }).strict(),
  z
    .object({
      event: z.literal('task_finished'),
      properties: z
        .object({ status: z.enum(['done', 'cancelled']), actor: z.enum(['owner', 'agent']) })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('prepared_work_saved'),
      properties: z.object({ outcome: z.enum(['prepared', 'notified']) }).strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('prepared_work_updated'),
      properties: z
        .object({ action: z.enum(['useful', 'not_useful', 'handled', 'dismiss', 'snooze']) })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('feedback_sent'),
      properties: z
        .object({
          category: z.enum(['bug', 'feature', 'other']).optional(),
          has_attachments: z.boolean(),
          has_report: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z.object({ event: z.literal('turn_started'), properties: turnProperties.strict() }).strict(),
  z
    .object({
      event: z.literal('turn_completed'),
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
          result: z
            .enum([
              'reply',
              'needs_owner',
              'no_reply',
              'failed',
              'cancelled',
              'interrupted',
              'skipped',
            ])
            .optional(),
          waiting_reason: z.enum(['question', 'approval', 'credentials']).optional(),
          failure_reason: z.enum(['spending_limit', 'model', 'unknown']).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('settings_updated'),
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
      event: z.literal('setting_changed'),
      properties: z
        .object({
          setting: z.enum([
            'theme',
            'conversation_traces',
            'usage_data',
            'speech_voice',
            'speech_reply',
            'notification_rule',
            'rules',
            'time_zone',
            'locale',
            'hour_cycle',
            'quiet_hours',
            'quiet_start',
            'quiet_end',
            'proactivity_paused',
            'memory_enabled',
            'memory_sensitive',
            'monthly_spending_limit',
            'task_spending_limit',
            'model_selection',
            'model_effort',
          ]),
          actor: z.enum(['owner', 'agent', 'system']),
          state: z
            .enum([
              'on',
              'off',
              'configured',
              'default',
              'cleared',
              'system',
              'light',
              'dark',
              'auto',
              'voice',
              'always',
              'never',
              'h12',
              'h23',
              'minimal',
              'low',
              'medium',
              'high',
              'xhigh',
              'max',
            ])
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('schedule_changed'),
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
      event: z.literal('connection_changed'),
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
      event: z.literal('source_read'),
      properties: z
        .object({
          source_type: z.enum(['connected_app', 'tasks', 'other']),
          operation: z.enum(['discovery', 'records']),
          outcome: z.enum(['succeeded', 'failed', 'cancelled']),
          duration_ms: duration,
          record_count: z.number().int().nonnegative().max(20).optional(),
          unavailable_count: z.number().int().nonnegative().max(20).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('service_used'),
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
      event: z.literal('connection_observed'),
      properties: connectionProperties.strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('connection_inventory_observed'),
      properties: z
        .object({
          connected_app_types: z.array(connectionProperties.shape.app).max(1000),
          connected_app_type_count: z.number().int().nonnegative().max(1000),
        })
        .strict()
        .refine(
          ({ connected_app_types, connected_app_type_count }) =>
            connected_app_type_count === connected_app_types.length &&
            new Set(connected_app_types).size === connected_app_types.length,
        ),
    })
    .strict(),
  z
    .object({
      event: z.literal('vault_imported'),
      properties: z
        .object({
          count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('vault_changed'),
      properties: z
        .object({
          item_type: z.enum(['login', 'card']),
          operation: z.enum(['create', 'update', 'delete']),
          source: z.enum(['user', 'agent']).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('memory_changed'),
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
      event: z.literal('tool_used'),
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
      event: z.literal('confirmation_changed'),
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
      event: z.literal('model_used'),
      properties: z
        .object({
          provider: analyticsModelProvider,
          model: analyticsModel.optional(),
          purpose: z.enum(['agent', 'memory', 'review', 'tasks', 'task_classification']),
          request_kind: z
            .enum([
              'chat',
              'task',
              'observer',
              'helper',
              'compaction',
              'cache_warm',
              'auxiliary',
              'memory',
              'review',
              'tasks',
              'task_classification',
              'unclassified',
            ])
            .optional(),
          attempt: z.number().int().min(1).max(4).optional(),
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
      event: z.literal('model_connection_changed'),
      properties: modelConnectionProperties
        .extend({ status: z.enum(['connected', 'disconnected', 'failed']) })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('model_connection_observed'),
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
      event: z.literal('link_opened'),
      properties: z
        .object({
          source: z.enum(['text', 'tooltip']),
          position: z.number().int().min(1).max(20).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('secure_entry_changed'),
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
        })
        .strict(),
    })
    .strict(),
]);

export type AnalyticsEvent = z.infer<typeof analyticsEvent>;
