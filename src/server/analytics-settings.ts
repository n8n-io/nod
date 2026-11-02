import type { AnalyticsEvent, CaptureAnalytics } from './analytics.ts';

type SettingChange = Extract<AnalyticsEvent, { event: 'setting_changed' }>['properties'];
export type SettingActor = SettingChange['actor'];

function state(setting: SettingChange['setting'], value: unknown): SettingChange['state'] {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (setting === 'monthly_spending_limit' || setting === 'task_spending_limit')
    return value === null ? 'off' : 'configured';
  if (value === null) return 'default';
  if (value === '') return 'cleared';
  if (setting === 'theme')
    return value === 'light' || value === 'dark' || value === 'system' ? value : undefined;
  if (setting === 'speech_reply')
    return value === 'auto' || value === 'voice' || value === 'always' || value === 'never'
      ? value
      : undefined;
  if (setting === 'hour_cycle')
    return value === 'auto' || value === 'h12' || value === 'h23' ? value : undefined;
  return 'configured';
}

export function captureSettingChanges<T extends object>(
  capture: CaptureAnalytics | undefined,
  actor: SettingActor,
  before: T,
  after: T,
  keys: Partial<Record<keyof T, SettingChange['setting']>>,
) {
  for (const property of Object.keys(keys) as Array<keyof T>) {
    const setting = keys[property];
    if (!setting || Object.is(before[property], after[property])) continue;
    capture?.({
      event: 'setting_changed',
      properties: { setting, actor, state: state(setting, after[property]) },
    });
  }
}
