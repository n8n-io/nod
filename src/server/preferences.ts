import { z } from 'zod';
import type { Pool } from 'pg';

const hourCycles = ['auto', 'h12', 'h23'] as const;
export const preferencesSchema = z
  .object({
    notificationRule: z.string().max(4000),
    rules: z.string().max(4000),
    timeZone: z.string().nullable(),
    locale: z.string().trim().min(2).nullable(),
    hourCycle: z.enum(hourCycles),
    quietHoursEnabled: z.boolean(),
    quietStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    quietEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  })
  .strict();
export type Preferences = z.infer<typeof preferencesSchema>;
export const defaultPreferences: Preferences = {
  notificationRule: '',
  rules: '',
  timeZone: null,
  locale: null,
  hourCycle: 'auto',
  quietHoursEnabled: true,
  quietStart: '22:00',
  quietEnd: '08:00',
};
export function isQuietTime(preferences: Preferences, now = new Date()) {
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
function canonicalLocale(value: string) {
  try {
    const [locale] = Intl.getCanonicalLocales(value);
    if (locale && Intl.DateTimeFormat.supportedLocalesOf(locale).length) return locale;
  } catch {}
  return null;
}
const columns =
  'notification_rule AS "notificationRule",rules,time_zone AS "timeZone",locale,hour_cycle AS "hourCycle",quiet_hours_enabled AS "quietHoursEnabled",quiet_start AS "quietStart",quiet_end AS "quietEnd"';
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
export function createPreferencesStore(pool: Pool, ownerId: string) {
  const validate = validatePreferences;
  return {
    validate,
    async get(): Promise<Preferences> {
      const result = await pool.query(`SELECT ${columns} FROM preferences WHERE owner_id=$1`, [
        ownerId,
      ]);
      return result.rows[0] ?? { ...defaultPreferences };
    },
    async update(raw: unknown): Promise<Preferences> {
      const patch = validate(raw);
      const result = await pool.query(
        `INSERT INTO preferences(owner_id,notification_rule,time_zone,quiet_start,quiet_end,quiet_hours_enabled,locale,hour_cycle,rules)
        VALUES($1,COALESCE($2,$7),$3,COALESCE($4,$8),COALESCE($5,$9),COALESCE($6::boolean,$10::boolean),$11,COALESCE($12,$13),COALESCE($16,''))
        ON CONFLICT(owner_id) DO UPDATE SET notification_rule=COALESCE($2,preferences.notification_rule),rules=COALESCE($16,preferences.rules),
        time_zone=CASE WHEN $15 THEN $3 ELSE preferences.time_zone END,quiet_start=COALESCE($4,preferences.quiet_start),quiet_end=COALESCE($5,preferences.quiet_end),
        quiet_hours_enabled=COALESCE($6,preferences.quiet_hours_enabled),locale=CASE WHEN $14 THEN $11 ELSE preferences.locale END,
        hour_cycle=COALESCE($12,preferences.hour_cycle)
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
        ],
      );
      return result.rows[0];
    },
  };
}
