import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { isSpeechVoiceId } from '../shared/speech.ts';
import { snapshotAnalytics, type CaptureAnalytics } from './analytics.ts';
import { captureSettingChanges, type SettingActor } from './analytics-settings.ts';
import { afterCommit, transaction } from './transaction.ts';

const hourCycles = ['auto', 'h12', 'h23'] as const;
const preferencesSchema = z
  .object({
    speechVoice: z.string().max(128).refine(isSpeechVoiceId).nullable(),
    speechReply: z.enum(['auto', 'voice', 'always', 'never']),
    notificationRule: z.string().max(4000),
    rules: z.string().max(4000),
    timeZone: z.string().nullable(),
    locale: z.string().trim().min(2).nullable(),
    hourCycle: z.enum(hourCycles),
    quietHoursEnabled: z.boolean(),
    quietStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    quietEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    proactivePaused: z.boolean(),
  })
  .strict();
type Preferences = z.infer<typeof preferencesSchema>;
export const defaultPreferences: Preferences = {
  speechVoice: null,
  speechReply: 'auto',
  notificationRule: '',
  rules: '',
  timeZone: null,
  locale: null,
  hourCycle: 'auto',
  quietHoursEnabled: true,
  quietStart: '22:00',
  quietEnd: '08:00',
  proactivePaused: false,
};
type QuietHours = Pick<Preferences, 'quietHoursEnabled' | 'quietStart' | 'quietEnd' | 'timeZone'>;
export function isQuietTime(preferences: QuietHours, now = new Date()) {
  if (!preferences.quietHoursEnabled) return false;
  const current = new Intl.DateTimeFormat('en-GB', {
    timeZone: preferences.timeZone ?? 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  const { quietStart, quietEnd } = preferences;
  return (
    quietStart !== quietEnd &&
    (quietStart < quietEnd
      ? current >= quietStart && current < quietEnd
      : current >= quietStart || current < quietEnd)
  );
}
export function deliveryTime(preferences: QuietHours, now: number) {
  const minute = 60000;
  for (let time = now - (now % minute); time < now + 2880 * minute; time += minute)
    if (!isQuietTime(preferences, new Date(time))) return new Date(Math.max(time, now));
  return null;
}
function canonicalLocale(value: string) {
  try {
    const [locale] = Intl.getCanonicalLocales(value);
    if (locale && Intl.DateTimeFormat.supportedLocalesOf(locale).length) return locale;
  } catch {}
  return null;
}
const columns =
  'speech_voice AS "speechVoice",speech_reply AS "speechReply",notification_rule AS "notificationRule",rules,time_zone AS "timeZone",locale,hour_cycle AS "hourCycle",quiet_hours_enabled AS "quietHoursEnabled",quiet_start AS "quietStart",quiet_end AS "quietEnd",proactive_paused AS "proactivePaused"';
function ianaTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return !/^[+-]/.test(value);
  } catch {
    return false;
  }
}
export function validatePreferences(raw: unknown) {
  const patch = preferencesSchema.partial().parse(raw);
  if (typeof patch.timeZone === 'string' && !ianaTimeZone(patch.timeZone))
    throw Object.assign(new Error('Choose a valid time zone.'), { statusCode: 400 });
  if (patch.locale !== undefined && patch.locale !== null) {
    const locale = canonicalLocale(patch.locale);
    if (!locale) throw Object.assign(new Error('Choose a valid region.'), { statusCode: 400 });
    patch.locale = locale;
  }
  return patch;
}
export function createPreferencesStore(pool: Pool, ownerId: string, analytics?: CaptureAnalytics) {
  const validate = validatePreferences;
  return {
    validate,
    async get(): Promise<Preferences> {
      const result = await pool.query(`SELECT ${columns} FROM preferences WHERE owner_id=$1`, [
        ownerId,
      ]);
      return result.rows[0] ?? { ...defaultPreferences };
    },
    async update(
      raw: unknown,
      actor: SettingActor = 'owner',
      expectedRules?: string,
      shared?: PoolClient,
    ): Promise<Preferences> {
      const patch = validate(raw);
      const capture = snapshotAnalytics(analytics);
      const save = async (connection: Pick<Pool, 'query'>) => {
        const result = await connection.query(
          `INSERT INTO preferences(owner_id,notification_rule,time_zone,quiet_start,quiet_end,quiet_hours_enabled,locale,hour_cycle,rules,speech_voice,speech_reply,proactive_paused)
        VALUES($1,COALESCE($2,$7),$3,COALESCE($4,$8),COALESCE($5,$9),COALESCE($6::boolean,$10::boolean),$11,COALESCE($12,$13),COALESCE($16,''),$17,COALESCE($18,'auto'),COALESCE($20::boolean,$21::boolean))
        ON CONFLICT(owner_id) DO UPDATE SET notification_rule=COALESCE($2,preferences.notification_rule),rules=COALESCE($16,preferences.rules),
        time_zone=CASE WHEN $15 THEN $3 ELSE preferences.time_zone END,quiet_start=COALESCE($4,preferences.quiet_start),quiet_end=COALESCE($5,preferences.quiet_end),
        quiet_hours_enabled=COALESCE($6,preferences.quiet_hours_enabled),locale=CASE WHEN $14 THEN $11 ELSE preferences.locale END,
        hour_cycle=COALESCE($12,preferences.hour_cycle),speech_reply=COALESCE($18,preferences.speech_reply),
        speech_voice=CASE WHEN $19 THEN $17 ELSE preferences.speech_voice END,
        proactive_paused=COALESCE($20,preferences.proactive_paused)
        WHERE $22::text IS NULL OR preferences.rules=$22
        RETURNING ${columns}`,
          [
            ownerId,
            patch.notificationRule ?? null,
            patch.timeZone ?? null,
            patch.quietStart ?? null,
            patch.quietEnd ?? null,
            patch.quietHoursEnabled ?? null,
            defaultPreferences.notificationRule,
            defaultPreferences.quietStart,
            defaultPreferences.quietEnd,
            defaultPreferences.quietHoursEnabled,
            patch.locale ?? null,
            patch.hourCycle ?? null,
            defaultPreferences.hourCycle,
            patch.locale !== undefined,
            patch.timeZone !== undefined,
            patch.rules ?? null,
            patch.speechVoice ?? null,
            patch.speechReply ?? null,
            patch.speechVoice !== undefined,
            patch.proactivePaused ?? null,
            defaultPreferences.proactivePaused,
            expectedRules ?? null,
          ],
        );
        if (!result.rows[0])
          throw Object.assign(new Error('Your rules changed. Review them before asking again.'), {
            statusCode: 409,
          });
        return result.rows[0] as Preferences;
      };
      if (!analytics) return save(shared ?? pool);
      const run = async (client: PoolClient) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `preferences:${ownerId}`,
        ]);
        const previous = await client.query(
          `SELECT ${columns} FROM preferences WHERE owner_id=$1`,
          [ownerId],
        );
        const before: Preferences = previous.rows[0] ?? { ...defaultPreferences };
        const after = await save(client);
        afterCommit(client, () =>
          captureSettingChanges(capture, actor, before, after, {
            speechVoice: 'speech_voice',
            speechReply: 'speech_reply',
            notificationRule: 'notification_rule',
            rules: 'rules',
            timeZone: 'time_zone',
            locale: 'locale',
            hourCycle: 'hour_cycle',
            quietHoursEnabled: 'quiet_hours',
            quietStart: 'quiet_start',
            quietEnd: 'quiet_end',
            proactivePaused: 'proactivity_paused',
          }),
        );
        return after;
      };
      return shared ? run(shared) : transaction(run, pool);
    },
  };
}
