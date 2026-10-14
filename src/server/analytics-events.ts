import { z } from 'zod';
import { taskTaxonomy } from './analytics-taxonomy.ts';

export const analyticsVersion = z
  .string()
  .max(80)
  .regex(/^(?:[a-f0-9]{7,64}|\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)$/);

export const taskType = z.enum(taskTaxonomy.types.map(({ id }) => id));
export const taskAction = z.enum(taskTaxonomy.actions.map(({ id }) => id));
export const taskSubject = z.enum(taskTaxonomy.subjects.map(({ id }) => id));
export const taskActivities = z
  .array(z.templateLiteral([taskAction, ':', taskSubject]))
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
const duration = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const turnProperties = z.object({
  source: z.enum(['user', 'schedule', 'event', 'resume']),
  channel: z.enum(['web', 'telegram', 'whatsapp', 'other']),
  background: z.boolean(),
});
const taskProperties = z.object({
  task_id: z.uuid(),
  task_type: taskType,
  task_action: taskAction,
  task_subject: taskSubject,
  task_activities: taskActivities,
  source: z.enum(['user', 'schedule', 'event', 'resume']),
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
          section: z.enum(['account', 'preferences', 'connections', 'channels', 'models']),
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
      properties: z
        .object({
          app: z.enum([
            'gmail',
            'googlecalendar',
            'googledrive',
            'googlesheets',
            'googledocs',
            'slack',
            'notion',
            'linear',
            'custom',
          ]),
          domain: z
            .string()
            .max(253)
            .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/)
            .optional(),
          connection_method: z.enum(['managed_app', 'browser', 'http', 'mcp', 'cli']),
          status: z.enum(['started', 'connected', 'failed', 'disconnected']),
          failure_reason: z
            .enum([
              'invalid_configuration',
              'authorization_failed',
              'verification_failed',
              'cancelled',
              'unavailable',
              'unknown',
            ])
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      event: z.literal('otto_service_used'),
      properties: z
        .object({
          app: z.enum([
            'gmail',
            'googlecalendar',
            'googledrive',
            'googlesheets',
            'googledocs',
            'slack',
            'notion',
            'linear',
            'custom',
          ]),
          domain: z
            .string()
            .max(253)
            .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/)
            .optional(),
          connection_method: z.enum(['managed_app', 'browser', 'http', 'mcp', 'cli']),
          outcome: z.enum(['succeeded', 'failed', 'cancelled']),
          duration_ms: duration,
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
          source: z.enum(['user', 'import', 'agent']).optional(),
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
          outcome: z.enum(['analyzed', 'unavailable', 'invalid', 'failed']),
          source: z.enum(['user', 'schedule', 'event', 'resume']),
          task_count: z.number().int().min(0).max(8).optional(),
        })
        .strict(),
    })
    .strict(),
]);

export type AnalyticsEvent = z.infer<typeof analyticsEvent>;
