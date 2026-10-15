import { z } from 'zod';

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

export const taskType = z.enum([
  'research',
  'communication',
  'document_creation',
  'data_analysis',
  'file_management',
  'scheduling',
  'monitoring',
  'app_setup',
  'translation',
  'software_development',
  'transaction',
  'unknown',
]);
export const taskAction = z.enum([
  'find',
  'read',
  'summarize',
  'compare',
  'analyze',
  'draft',
  'create',
  'edit',
  'send',
  'organize',
  'delete',
  'schedule',
  'monitor',
  'connect',
  'disconnect',
  'translate',
  'extract',
  'convert',
  'run',
  'purchase',
  'book',
  'unknown',
]);
export const taskSubject = z.enum([
  'web',
  'email',
  'message',
  'document',
  'spreadsheet',
  'file',
  'calendar',
  'contact',
  'task',
  'automation',
  'app',
  'code',
  'image',
  'audio',
  'video',
  'product',
  'unknown',
]);
export const taskActivities = z
  .array(
    z.string().refine((value) => {
      const parts = value.split(':');
      return (
        parts.length === 2 &&
        taskAction.safeParse(parts[0]).success &&
        taskSubject.safeParse(parts[1]).success
      );
    }),
  )
  .min(1)
  .max(8)
  .refine((values) => new Set(values).size === values.length);
export const taskOutcome = z.enum(['active', 'waiting', 'completed', 'failed', 'cancelled']);
export const frustrationSignal = z.enum([
  'explicit_complaint',
  'repeated_correction',
  'repeated_request',
]);
export const frictionReason = z.enum([
  'output_quality',
  'ignored_instruction',
  'too_slow',
  'connection_problem',
  'execution_failure',
  'unclear',
]);
export const serviceFailureReason = z.enum([
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
const turnProperties = z.object({
  source: z.enum(['user', 'schedule', 'event', 'resume', 'task']),
  channel: z.enum(['web', 'telegram', 'whatsapp', 'other']),
  background: z.boolean(),
});
const taskProperties = z.object({
  task_id: z.uuid(),
  task_type: taskType,
  task_action: taskAction,
  task_subject: taskSubject,
  task_activities: taskActivities,
  source: z.enum(['user', 'schedule', 'event', 'resume', 'task']),
  channel: z.enum(['web', 'telegram', 'whatsapp', 'other']),
});
export const analyticsEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('otto_onboarding_completed') }).strict(),
  z.object({ event: z.literal('otto_conversation_reset') }).strict(),
  z.object({ event: z.literal('otto_chat_stopped') }).strict(),
  z.object({ event: z.literal('otto_turn_started'), properties: turnProperties.strict() }).strict(),
  z
    .object({
      event: z.literal('otto_turn_completed'),
      properties: turnProperties
        .extend({
          outcome: z.enum([
            'succeeded',
            'waiting_credentials',
            'waiting_user',
            'failed',
            'cancelled',
            'interrupted',
          ]),
          duration_ms: duration,
          queue_duration_ms: duration.optional(),
          waiting_reason: z.enum(['question', 'approval', 'credentials']).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('otto_settings_updated'),
      properties: z
        .object({
          section: z.enum(['account', 'preferences', 'channels', 'models']),
          operation: z.enum(['update', 'connect_started', 'disconnect']),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('otto_schedule_changed'),
      properties: z
        .object({
          operation: z.enum(['create', 'update', 'delete']),
          schedule_kind: z.enum(['once', 'recurring']).optional(),
          cadence: z.enum(['once', 'hourly', 'daily', 'weekly', 'monthly', 'custom']).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('otto_connection_changed'),
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
      event: z.literal('otto_service_used'),
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
      event: z.literal('otto_connection_observed'),
      properties: connectionProperties.strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('otto_vault_imported'),
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
      event: z.literal('otto_vault_changed'),
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
  z.object({ event: z.literal('otto_task_started'), properties: taskProperties.strict() }).strict(),
  z
    .object({
      event: z.literal('otto_task_linked'),
      properties: taskProperties.strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('otto_task_updated'),
      properties: taskProperties
        .extend({
          outcome: taskOutcome,
          completion_evidence: z.enum(['inferred', 'none']),
          elapsed_ms: duration,
          turn_count: z.number().int().positive(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('otto_frustration_signal'),
      properties: z
        .object({
          signal: frustrationSignal,
          reason: frictionReason,
          task_type: taskType,
          channel: z.enum(['web', 'telegram', 'whatsapp', 'other']),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('otto_task_analysis'),
      properties: z
        .object({
          outcome: z.enum(['analyzed', 'unavailable', 'invalid', 'failed', 'queue_full']),
          source: z.enum(['user', 'schedule', 'event', 'resume', 'task']),
          task_count: z.number().int().min(0).max(8).optional(),
          unknown_label_count: z.number().int().min(0).max(200).optional(),
        })
        .strict(),
    })
    .strict(),
]);

export type AnalyticsEvent = z.infer<typeof analyticsEvent>;
