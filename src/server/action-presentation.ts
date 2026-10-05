import type { TrustReason } from './trust.ts';

const labels: Record<string, string> = {
  OTTO_goal_create: 'Add this goal',
  OTTO_goal_update: 'Update this goal',
  OTTO_schedule_create: 'Add this schedule',
  OTTO_schedule_update: 'Update this schedule',
  OTTO_schedule_cancel: 'Pause this schedule',
  OTTO_profile_update: 'Save these preferences',
  OTTO_notification_preferences_update: 'Save these notification preferences',
  OTTO_memory_save: 'Remember this',
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
  injection:
    'something I read since your last message looked like instructions aimed at an AI assistant.',
};

function shown(value: unknown, limit: number): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.length > limit
      ? `${plain(trimmed.slice(0, limit))}… (${trimmed.length - limit} more characters)`
      : plain(trimmed);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    return shown(value.join(', '), limit);
  return value === undefined || value === null ? undefined : shown(JSON.stringify(value), 400);
}

export function appActionConfirmation(
  action: string,
  args: Record<string, unknown>,
  reason: TrustReason,
  account?: string,
) {
  const [app, ...words] = action.split('_');
  const title =
    action === 'CONNECTED_HTTP'
      ? `Call ${shown(args.method, 10) ?? 'POST'} ${shown(args.path, 200) ?? ''} on a connected API`
      : action === 'CONNECTED_MCP_CALL'
        ? `Run ${shown(args.tool, 100) ?? 'a tool'} on a connected app`
        : action === 'CONNECTED_CLI'
          ? `Run a connected command line tool`
          : `${apps[app!] ?? `${app![0]}${app!.slice(1).toLowerCase()}`}: ${words.join(' ').toLowerCase()}`;
  const details = Object.entries(args)
    .filter(([key]) => !['connectionId', 'pathId', 'method', 'path', 'tool'].includes(key))
    .flatMap(([key, value]) => {
      const text = shown(value, 1500);
      if (!text) return [];
      const label = key
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replaceAll('_', ' ')
        .toLowerCase();
      return [`${label[0]!.toUpperCase()}${label.slice(1)}: ${text}`];
    });
  let body = account ? `\n\nAccount: ${shown(account, 300)}` : '';
  for (const detail of details) {
    if (body.length + detail.length > 4800) {
      body += '\n\n…';
      break;
    }
    body += `\n\n${detail}`;
  }
  return `${title}?${body}\n\nWhy I'm asking: ${reasons[reason]}\n\nReply yes to go ahead, no to skip it, or tell me what to change.`;
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
  for (const key of ['text', 'prompt'])
    add(action === 'OTTO_memory_save' ? 'Note' : 'Instructions', text(args[key]));
  return `${label}?${details.length ? `\n\n${details.join('\n\n')}` : ''}\n\nReply yes to confirm, no to leave it unchanged, or tell me what to change.`;
}
