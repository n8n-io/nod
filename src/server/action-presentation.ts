import { actionPayload, sentPath } from '../shared/action-effect.ts';
import type { TrustReason } from './trust.ts';

const labels: Record<string, string> = {
  OTTO_schedule_create: 'Add this schedule',
  OTTO_schedule_update: 'Update this schedule',
  OTTO_schedule_cancel: 'Pause this schedule',
  OTTO_profile_update: 'Save these preferences',
  OTTO_notification_preferences_update: 'Save these notification preferences',
};

function plain(value: string) {
  const escape = (text: string) => text.replace(/[\\`*_{}\[\]<>()#!|]/g, '\\$&');
  return value
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .split(/(https?:\/\/[^\s<>"'\\`]+)/gi)
    .map((part, index) => {
      if (index % 2) {
        try {
          const parsed = new URL(part);
          if (!parsed.username && !parsed.password) return `<${part}>`;
        } catch {}
      }
      return escape(part);
    })
    .join('');
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? plain(value.trim()) : undefined;
}

const apps: Record<string, string> = {
  GMAIL: 'Gmail',
  GOOGLECALENDAR: 'Google Calendar',
  GOOGLESHEETS: 'Google Sheets',
  GOOGLEDOCS: 'Google Docs',
  GOOGLEDRIVE: 'Google Drive',
  SLACK: 'Slack',
  NOTION: 'Notion',
  LINEAR: 'Linear',
};
const reasons: Record<TrustReason, string> = {
  background: 'this came up in background work, not from a message of yours.',
  schedule: 'your scheduled task does not clearly ask for this.',
  unrequested: 'I could not confirm that you asked for exactly this.',
};

function abbreviated(value: string, limit: number) {
  return value.length > limit
    ? `${value.slice(0, limit)}… (${value.length - limit} more characters)`
    : value;
}

function label(key: string) {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .toLowerCase();
}

function leaves(value: unknown, path: string, found: Array<[string, string]>) {
  if (typeof value === 'string') found.push([path, value.trim() || '""']);
  else if (typeof value === 'number' || typeof value === 'boolean')
    found.push([path, String(value)]);
  else if (value === null) found.push([path, 'null']);
  else if (Array.isArray(value)) {
    if (value.every((item) => ['string', 'number', 'boolean'].includes(typeof item)))
      found.push([path, value.length ? value.join(', ') : '[]']);
    else value.forEach((item, index) => leaves(item, `${path} ${index + 1}`, found));
  } else if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value))
      leaves(item, path ? `${path} › ${label(key)}` : label(key), found);
  return found;
}

function argument(value: string) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function actionDetails(action: string, args: Record<string, unknown>, limit: number) {
  const payload = actionPayload(action, args);
  const fields = leaves(
    payload === args
      ? Object.fromEntries(
          Object.entries(args).filter(([key]) => !['connectionId', 'pathId'].includes(key)),
        )
      : payload,
    payload === args ? '' : action === 'CONNECTED_HTTP' ? 'body' : 'input',
    [],
  );
  const target: Array<[string, string]> =
    action === 'CONNECTED_HTTP'
      ? [
          [
            'request',
            `${String(args.method ?? 'GET').toUpperCase()} ${sentPath(String(args.path ?? ''))}`,
          ],
        ]
      : action === 'CONNECTED_MCP_CALL'
        ? [['tool', String(args.tool ?? '')]]
        : action === 'CONNECTED_CLI'
          ? [
              [
                'command',
                (Array.isArray(args.argv) ? args.argv : [])
                  .map((item) => argument(abbreviated(String(item), limit)))
                  .join(' '),
              ],
            ]
          : [];
  return [
    ...target,
    ...[
      ...fields.filter(([, value]) => value.length <= 200),
      ...fields.filter(([, value]) => value.length > 200),
    ].map(([name, value]): [string, string] => [name, abbreviated(value, limit)]),
  ].map(([name, value]): [string, string] => [`${name[0]!.toUpperCase()}${name.slice(1)}`, value]);
}

function fitted(render: (limit: number) => string[], limits: number[], budget: number) {
  const size = (lines: string[]) => lines.join('\n\n').length;
  const lines = render(limits.find((limit) => size(render(limit)) <= budget) ?? limits.at(-1)!);
  let total = -2;
  const shown = lines.filter((line, index) => (total += line.length + 2) <= budget || !index);
  return shown.length < lines.length
    ? [...shown, `…and ${lines.length - shown.length} more fields`]
    : shown;
}

export function actionTitle(action: string) {
  if (action === 'CONNECTED_HTTP') return { app: '', label: 'Call a connected API' };
  if (action === 'CONNECTED_MCP_CALL') return { app: '', label: 'Run a tool on a connected app' };
  if (action === 'CONNECTED_CLI') return { app: '', label: 'Run a connected command line tool' };
  const [app, ...words] = action.split('_');
  return {
    app: apps[app!] ?? `${app![0]}${app!.slice(1).toLowerCase()}`,
    label: words.join(' ').toLowerCase(),
  };
}

export function appActionConfirmation(
  action: string,
  args: Record<string, unknown>,
  reason: TrustReason,
  account?: string,
) {
  const { app, label } = actionTitle(action);
  const title = app ? `${app}: ${label}` : label;
  const details = fitted(
    (limit) =>
      actionDetails(action, args, limit).map(([name, value]) => `${plain(name)}: ${plain(value)}`),
    [1500, 600, 200, 60],
    4800,
  );
  const body = [
    ...(account ? [`Account: ${plain(abbreviated(account, 300))}`] : []),
    ...details,
  ].join('\n\n');
  return `${title}?${body ? `\n\n${body}` : ''}\n\nWhy I'm asking: ${reasons[reason]}\n\nReply yes to go ahead, no to skip it, or tell me what to change.`;
}

export function actionConfirmation(
  action: string,
  args: Record<string, unknown>,
  targetTitle?: string,
) {
  const label = labels[action] ?? 'Make this change';
  const details: string[] = [];
  const seen = new Set<string>();
  const add = (label: string, value: string | undefined) => {
    if (!value || seen.has(label)) return;
    seen.add(label);
    details.push(`${label}: ${value}`);
  };
  add('For', text(targetTitle));
  for (const [key, label] of [
    ['title', 'Title'],
    ['name', 'Name'],
    ['nextAction', 'Next step'],
    ['description', 'Description'],
    ['preferences', 'Preferences'],
    ['location', 'Location'],
    ['phone', 'Phone'],
    ['notificationRule', 'Notify me'],
    ['quietStart', 'Quiet hours start'],
    ['quietEnd', 'Quiet hours end'],
    ['timeZone', 'Time zone'],
    ['locale', 'Region'],
  ])
    add(label!, text(args[key!]));
  if (typeof args.progress === 'number' && Number.isFinite(args.progress))
    add('Progress', `${args.progress}%`);
  if (['active', 'paused', 'completed'].includes(String(args.status)))
    add('Status', String(args.status));
  const clock = ({ auto: 'Automatic', h12: '12-hour', h23: '24-hour' } as Record<string, string>)[
    String(args.hourCycle)
  ];
  if (clock) add('Clock', clock);
  if (typeof args.enabled === 'boolean') add('Schedule', args.enabled ? 'Active' : 'Paused');
  if (typeof args.targetDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.targetDate))
    add('Target date', args.targetDate);
  else if (args.targetDate === null) add('Target date', 'None');
  if (typeof args.runAt === 'string' && Number.isFinite(Date.parse(args.runAt))) {
    try {
      add(
        'When',
        new Intl.DateTimeFormat('en-GB', {
          dateStyle: 'long',
          timeStyle: 'short',
          timeZone: typeof args.timeZone === 'string' ? args.timeZone : 'UTC',
        }).format(new Date(args.runAt)),
      );
    } catch {}
  }
  if (typeof args.cron === 'string') {
    const everyMinute = /^\*\/([1-9]\d*) \* \* \* \*$/.exec(args.cron);
    const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(args.cron);
    const hours = /^\*\/([1-9]\d*) (\d{1,2})-(\d{1,2}) \* \* \*$/.exec(args.cron);
    add(
      'Repeats',
      args.cron === '* * * * *'
        ? 'Every minute'
        : everyMinute
          ? `Every ${everyMinute[1]} minutes`
          : daily
            ? `Daily at ${daily[2]!.padStart(2, '0')}:${daily[1]!.padStart(2, '0')}`
            : hours
              ? `Every ${hours[1]} minutes from ${hours[2]!.padStart(2, '0')}:00 to ${hours[3]!.padStart(2, '0')}:59`
              : `Custom timing (${plain(args.cron)})`,
    );
  }
  for (const key of ['text', 'prompt']) add('Instructions', text(args[key]));
  return `${label}?${details.length ? `\n\n${details.join('\n\n')}` : ''}\n\nReply yes to confirm, no to leave it unchanged, or tell me what to change.`;
}
