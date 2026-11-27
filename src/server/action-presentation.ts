import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const apps: Record<string, string> = {
  GMAIL: 'Gmail',
  GOOGLECALENDAR: 'Google Calendar',
  GOOGLESHEETS: 'Google Sheets',
  GOOGLEDOCS: 'Google Docs',
  GOOGLEDRIVE: 'Google Drive',
  SLACK: 'Slack',
  NOTION: 'Notion',
  LINEAR: 'Linear',
  COMPUTER: 'Computer use',
};

export function actionTitle(action: string) {
  if (action === 'NOD_read_source') return { app: '', label: 'Read source observations' };
  if (action === 'CONNECTED_HTTP') return { app: '', label: 'Call a connected API' };
  if (action === 'CONNECTED_MCP_CALL') return { app: '', label: 'Run a tool on a connected app' };
  if (action === 'CONNECTED_CLI') return { app: '', label: 'Run a connected command line tool' };
  if (action.startsWith('LOCAL_FILES_'))
    return {
      app: 'Local files',
      label: action.slice('LOCAL_FILES_'.length).replaceAll('_', ' ').toLowerCase(),
    };
  const [app, ...words] = action.split('_');
  return {
    app: apps[app!] ?? `${app![0]}${app!.slice(1).toLowerCase()}`,
    label: words.join(' ').toLowerCase(),
  };
}

const nodActions: Array<[string, string]> = [
  ['NOD_browser', 'Continue in the browser'],
  ['NOD_vault_allow', 'Use a saved sign-in'],
  ['NOD_limits_update', 'Change spending limits'],
  ['NOD_bug_report_send', 'Send a bug report to the Nod team'],
  ['NOD_model_select', 'Change the model'],
  ['NOD_notification_preferences_update', 'Change Nod settings'],
  ['NOD_schedule_pause', 'Pause a schedule'],
  ['NOD_schedule_cancel', 'Pause a schedule'],
  ['NOD_schedule_create', 'Create a schedule'],
  ['NOD_schedule_', 'Change a schedule'],
  ['NOD_memory_', 'Change memory'],
  ['NOD_rules', 'Change your rules'],
  ['NOD_', 'Change a Nod setting'],
];

export function approvalTitle(action: string) {
  if (action === 'GMAIL_DELETE_MESSAGE')
    return { title: 'Delete an email permanently', app: 'Gmail', slug: 'gmail' };
  if (action === 'GMAIL_DELETE_DRAFT')
    return { title: 'Delete an unsent draft permanently', app: 'Gmail', slug: 'gmail' };
  const nod = nodActions.find(([prefix]) => action.startsWith(prefix));
  if (nod) return { title: nod[1], app: '', slug: '' };
  const mcp = action.startsWith('mcp__');
  const { app, label } = mcp
    ? {
        app: '',
        label: action
          .split('__')
          .slice(2)
          .join(' ')
          .replace(/[_\s]+/g, ' ')
          .trim(),
      }
    : actionTitle(action);
  const title = label ? `${label[0]!.toUpperCase()}${label.slice(1)}` : 'Run an action';
  if (mcp || action.startsWith('CONNECTED_')) return { title, app: '', slug: '' };
  return { title, app, slug: action.split('_')[0]!.toLowerCase() };
}

export function gmailMessageTarget(result: unknown, expectedId: string) {
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const outer = object(result);
  if (!outer || outer.successful === false) return;
  const data = object(outer.data) ?? outer;
  const message = object(data.message) ?? data;
  const id = message.id ?? message.messageId ?? message.emailId ?? message.message_id;
  if (id !== expectedId) return;
  const payload = object(message.payload);
  const headers = Array.isArray(payload?.headers)
    ? payload.headers
    : Array.isArray(message.headers)
      ? message.headers
      : [];
  const header = (name: string) =>
    headers
      .map(object)
      .find((item) => typeof item?.name === 'string' && item.name.toLowerCase() === name)?.value;
  const field = (limit: number, ...values: unknown[]) => {
    const text = (
      values.find((value) => typeof value === 'string' && value.trim()) as string | undefined
    )?.trim();
    if (!text) return;
    const marker = ' [truncated]';
    if (text.length <= limit) return text;
    const prefix = text.slice(0, limit - marker.length).replace(/[\uD800-\uDBFF]$/, '');
    return `${prefix}${marker}`;
  };
  const subject = field(300, message.subject, header('subject'));
  const from = field(320, message.from, message.sender, header('from'));
  const to = field(320, message.to, message.recipient, header('to'));
  const cc = field(320, message.cc, header('cc'));
  const bcc = field(320, message.bcc, header('bcc'));
  if (!subject && !from && !to && !cc && !bcc) return;
  return {
    messageId: expectedId,
    ...(subject ? { subject } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
  };
}

export function gmailDraftTarget(result: unknown, expectedId: string) {
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const outer = object(result);
  if (!outer || outer.successful === false) return;
  const data = object(outer.data) ?? outer;
  const draft = object(data.draft) ?? data;
  if (draft.id !== expectedId) return;
  const message = object(draft.message);
  const messageId = message?.id ?? message?.messageId;
  if (typeof messageId !== 'string' || !messageId.trim()) return;
  const target = gmailMessageTarget(message, messageId);
  return target && (target.subject || target.to || target.cc || target.bcc)
    ? { draftId: expectedId, ...target }
    : undefined;
}

export function isCalendarEventChange(action: string) {
  return [
    'GOOGLECALENDAR_PATCH_EVENT',
    'GOOGLECALENDAR_UPDATE_EVENT',
    'GOOGLECALENDAR_DELETE_EVENT',
    'GOOGLECALENDAR_REMOVE_ATTENDEE',
    'GOOGLECALENDAR_EVENTS_MOVE',
  ].includes(action);
}

export function calendarEventTarget(result: unknown, expectedId: string) {
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const outer = object(result);
  if (!outer || outer.successful === false || !expectedId.trim() || expectedId.length > 1024)
    return;
  const event = object(outer.data) ?? outer;
  if (event.id !== expectedId || event.status === 'cancelled') return;
  if (typeof event.etag !== 'string' || !event.etag.trim() || event.etag.length > 1024) return;
  if (event.endTimeUnspecified !== undefined && event.endTimeUnspecified !== false) return;
  if (event.summary != null && typeof event.summary !== 'string') return;
  const start = object(event.start);
  const allDay = start?.dateTime === undefined;
  const when = (part: Record<string, unknown> | undefined) => {
    if (allDay) {
      const date = z.iso.date().safeParse(part?.date);
      return date.success && part?.dateTime === undefined ? { value: date.data } : undefined;
    }
    if (part?.date !== undefined) return;
    const date = z.iso.datetime({ offset: true, local: true }).max(64).safeParse(part?.dateTime);
    if (!date.success) return;
    const timeZone = part?.timeZone;
    if (
      timeZone !== undefined &&
      (typeof timeZone !== 'string' || !timeZone || timeZone.length > 100)
    )
      return;
    let format: Intl.DateTimeFormat | undefined;
    if (typeof timeZone === 'string') {
      try {
        format = new Intl.DateTimeFormat('en-GB', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hourCycle: 'h23',
        });
      } catch {
        return;
      }
    }
    if (z.iso.datetime({ offset: true }).safeParse(date.data).success)
      return { value: date.data, ...(typeof timeZone === 'string' ? { timeZone } : {}) };
    if (!format) return;
    const wall = Date.parse(`${date.data}Z`);
    const localAt = (instant: number) => {
      const parts = Object.fromEntries(
        format.formatToParts(instant).map(({ type, value }) => [type, value]),
      );
      return Date.parse(
        `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`,
      );
    };
    const second = (instant: number) => Math.floor(instant / 1000) * 1000;
    const offsets = new Set(
      [-86_400_000, 0, 86_400_000].map((delta) => localAt(wall + delta) - second(wall + delta)),
    );
    const matches = [...offsets]
      .map((offset) => wall - offset)
      .filter((instant) => localAt(instant) === second(wall));
    return matches.length === 1
      ? { value: new Date(matches[0]!).toISOString(), timeZone: timeZone as string }
      : undefined;
  };
  const startsAt = when(start);
  const end = object(event.end);
  const endsAt = when(end);
  if (
    !startsAt ||
    !endsAt ||
    Date.parse(endsAt.value) < Date.parse(startsAt.value) ||
    (allDay && startsAt.value === endsAt.value)
  )
    return;
  if (
    (event.recurringEventId !== undefined &&
      (typeof event.recurringEventId !== 'string' ||
        !event.recurringEventId.trim() ||
        event.recurringEventId.length > 1024)) ||
    (event.recurrence !== undefined &&
      (!Array.isArray(event.recurrence) ||
        event.recurrence.some((rule) => typeof rule !== 'string' || !rule.trim())))
  )
    return;
  const occurrence = typeof event.recurringEventId === 'string';
  const series = Array.isArray(event.recurrence) && event.recurrence.length > 0;
  const originalStartsAt = when(object(event.originalStartTime));
  if (
    (occurrence && (series || !originalStartsAt)) ||
    (!occurrence && event.originalStartTime !== undefined)
  )
    return;
  const title = typeof event.summary === 'string' ? event.summary.trim() : '';
  const self = Array.isArray(event.attendees)
    ? event.attendees.map(object).find((attendee) => attendee?.self === true)
    : undefined;
  const response = z
    .enum(['accepted', 'declined', 'tentative', 'needsAction'])
    .safeParse(self?.responseStatus);
  const target = {
    eventId: expectedId,
    title:
      title.length > 300
        ? `${title.slice(0, 288).replace(/[\uD800-\uDBFF]$/, '')} [truncated]`
        : title || 'Untitled event',
    startsAt: startsAt.value,
    endsAt: endsAt.value,
    endExclusive: true,
    allDay,
    ...(startsAt.timeZone ? { timeZone: startsAt.timeZone } : {}),
    ...(endsAt.timeZone ? { endTimeZone: endsAt.timeZone } : {}),
    scope: occurrence ? 'occurrence' : series ? 'series' : 'event',
    ...(occurrence && originalStartsAt
      ? {
          seriesId: event.recurringEventId,
          originalStartsAt: originalStartsAt.value,
          ...(originalStartsAt.timeZone ? { originalTimeZone: originalStartsAt.timeZone } : {}),
        }
      : {}),
    ...(response.success ? { currentResponse: response.data } : {}),
  };
  return {
    target,
    revision: createHash('sha256')
      .update(JSON.stringify([event.etag, event.summary ?? null, event.recurrence ?? []]))
      .digest('hex'),
  };
}

const fieldKeys: Array<[string, string[]]> = [
  ['To', ['recipient_email', 'to', 'extra_recipients']],
  ['Cc', ['cc']],
  ['Bcc', ['bcc']],
  ['Channel', ['channel']],
  ['Subject', ['subject']],
];
const bodyKeys = ['body', 'message_body', 'text', 'markdown_text'];

function words(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  return Array.isArray(value) ? value.flatMap(words) : [];
}

function listed(values: string[]) {
  const kept: string[] = [];
  let length = 0;
  for (const value of values) {
    if (kept.length && length + value.length > 500) break;
    kept.push(value);
    length += value.length + 2;
  }
  const rest = values.length - kept.length;
  const text = kept.join(', ');
  return rest ? `${text} and ${rest} more` : text;
}

function plainText(html: string) {
  const bounded = html.length > 20_000;
  let cut = bounded;
  const document = parseFragment(html.slice(0, 20_000), {
    sourceCodeLocationInfo: true,
    scriptingEnabled: false,
  });
  function read(nodes: DefaultTreeAdapterMap['node'][], links: boolean): string {
    const pending: Array<DefaultTreeAdapterMap['node'] | string> = [...nodes].reverse();
    let text = '';
    while (pending.length) {
      const node = pending.pop()!;
      if (typeof node === 'string') text += node;
      else if ('value' in node) text += node.value;
      else if (
        'tagName' in node &&
        ['style', 'script', 'head', 'title', 'template'].includes(node.tagName)
      )
        continue;
      else if ('tagName' in node && node.tagName === 'a' && links) {
        if (bounded && !node.sourceCodeLocation?.endTag) continue;
        const address = node.attrs.find((attribute) => attribute.name === 'href')?.value.trim();
        const shown = read(node.childNodes, false).trim();
        const link =
          !address || shown === address ? shown || address || '' : `${shown} (${address})`;
        if (text.length + link.length > 4000) {
          cut = true;
          break;
        }
        text += link;
      } else if ('childNodes' in node) {
        if ('tagName' in node && /^(br|p|div|li|tr|h[1-6])$/.test(node.tagName)) pending.push('\n');
        for (let index = node.childNodes.length - 1; index >= 0; index--)
          pending.push(node.childNodes[index]!);
      }
      if (links && text.length > 4000) {
        cut = true;
        break;
      }
    }
    return text;
  }
  return { text: read(document.childNodes, true).replace(/\n{3,}/g, '\n\n'), cut };
}

export function approvalContent(
  action: string,
  args: unknown,
): { fields?: Array<{ label: string; value: string }>; body?: string; bodyCut?: true } {
  if (
    /^(NOD_|CONNECTED_|mcp__)/.test(action) ||
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args)
  )
    return {};
  const input = args as Record<string, unknown>;
  const fields = fieldKeys.flatMap(([label, keys]) => {
    const value = listed(keys.flatMap((key) => words(input[key])));
    return value ? [{ label, value }] : [];
  });
  if (!fields.length) return {};
  const raw = bodyKeys
    .map((key) => input[key])
    .find((value) => typeof value === 'string' && value.trim());
  if (typeof raw !== 'string') return { fields };
  const html = input.is_html === true;
  const preview = html ? plainText(raw) : { text: raw, cut: false };
  const text = preview.text.trim();
  const cut = preview.cut || text.length > 4000;
  return {
    fields,
    ...(text ? { body: text.slice(0, 4000) } : {}),
    ...(cut ? { bodyCut: true as const } : {}),
  };
}

const tools: Record<string, string> = {
  codemode: 'Ran code',
  bash: 'Ran a command',
  read: 'Read a file',
  write: 'Wrote a file',
  edit: 'Edited a file',
  find: 'Looked for files',
  ls: 'Listed files',
  'web search': 'Searched the web',
  'fetch content': 'Read a web page',
  'get search content': 'Read search results',
  'source check': 'Checked a source',
  'read source': 'Read a source',
  flights: 'Searched flights',
  browser: 'Used the browser',
  'browser run': 'Used the browser',
  'sign in': 'Signed in',
  pay: 'Entered a card',
  'browser session': 'Opened a saved session',
  apps: 'Used a connected app',
  files: 'Handled local files',
  computer: 'Used an app',
  'manage apps': 'Checked connected apps',
  'manage personal context': 'Checked schedules or memory',
  skills: 'Used a skill',
  'send message': 'Sent you a message',
  'follow up': 'Queued a follow-up',
  delegate: 'Started a helper',
  'ask user': 'Asked you',
  'react to message': 'Reacted to a message',
  task: 'Updated the task',
  'share file': 'Shared a file',
  'create audio': 'Made audio',
};

const computerSteps: Record<string, string> = {
  apps: 'Checked open apps',
  open: 'Opened the app',
  snapshot: 'Read the window',
  find: 'Looked for a control',
  screenshot: 'Looked at the window',
  press: 'Pressed a control',
  set_value: 'Filled in a field',
  type: 'Typed text',
  select: 'Chose an option',
  focus: 'Selected a field',
  key: 'Used a shortcut',
  keep_out: 'Kept an app out',
};

export function toolTitle(summary: string) {
  if (tools[summary]) return tools[summary];
  const browser = /^browser ([a-z_]+)$/.exec(summary)?.[1];
  if (browser) return `Browser: ${browser.replaceAll('_', ' ')}`;
  const computer = /^computer ([a-z_]+)$/.exec(summary)?.[1];
  if (computer) return computerSteps[computer] ?? 'Used an app';
  const server = /^mcp {2}(.+?) {2}.+$/.exec(summary)?.[1];
  return server ? `Used ${server}` : (tools[summary] ?? summary);
}

const browserVerbs: Record<string, string> = {
  accept_dialog: 'accept a dialog',
  evaluate: 'run a page script',
  type: 'type and press Enter',
};

const settingNames: Record<string, string> = {
  notificationRule: 'notifications',
  rules: 'your rules',
  speechReply: 'voice replies',
  speechVoice: 'voice',
  timeZone: 'time zone',
  locale: 'region',
  hourCycle: 'clock',
  quietHoursEnabled: 'quiet hours',
  quietStart: 'quiet hours',
  quietEnd: 'quiet hours',
  proactivePaused: 'preparation',
};

const host = (origin: unknown) => {
  try {
    return new URL(String(origin)).host.replace(/^www\./, '');
  } catch {
    return '';
  }
};

const quoted = (text: string) => `“${text.length > 80 ? `${text.slice(0, 79)}…` : text}”`;

const dollarsOrNone = (value: unknown, label: string) =>
  value === null ? `no ${label}` : `${label} $${String(value)}`;

export function objectIds(value: unknown, key = 'id') {
  const ids = new Set<string>();
  const pending: Array<[unknown, number]> = [[value, 0]];
  for (let visited = 0; pending.length && visited < 500 && ids.size < 20; visited++) {
    const [item, depth] = pending.pop()!;
    if (!item || typeof item !== 'object' || depth > 4) continue;
    for (const [name, child] of Object.entries(item)) {
      const text = typeof child === 'string' || typeof child === 'number' ? String(child) : '';
      if ((!key || name === key) && /^[^\s]{4,200}$/.test(text)) ids.add(text);
      else if (child && typeof child === 'object') pending.push([child, depth + 1]);
    }
  }
  return [...ids];
}

export function recordedTitle(action: string) {
  if (action === 'NOD_browser') return 'Browser';
  if (action === 'NOD_workspace_command') return 'Run a workspace command';
  if (action === 'NOD_notification_preferences_update') return 'Change settings';
  if (action.startsWith('NOD_') && action !== 'NOD_read_source') return approvalTitle(action).title;
  const { app, label } = actionTitle(action);
  return app ? `${app}: ${label}` : label;
}

export function recordedAction(action: string, target?: string | null) {
  if (action === 'NOD_browser' && target) return { label: `Browser: ${target}` };
  return { label: recordedTitle(action), ...(target ? { target } : {}) };
}

export function actionTarget(
  action: string,
  args: Record<string, unknown>,
  details?: Record<string, unknown>,
) {
  const target = (() => {
    if (action === 'NOD_bug_report_send')
      return args.includeReport === true ? 'with a diagnostic report' : 'summary only';
    if (action === 'NOD_browser') {
      const step = String(args.step ?? '');
      const control = Array.isArray(args.control)
        ? (args.control as Array<{ name?: unknown }>).find(
            (item) => typeof item.name === 'string' && item.name.trim(),
          )?.name
        : undefined;
      const what =
        step === 'upload'
          ? String(args.file ?? '')
          : step === 'accept_dialog' && typeof args.dialog === 'string' && args.dialog.trim()
            ? quoted(args.dialog.trim())
            : typeof control === 'string'
              ? quoted(control.trim())
              : '';
      const site = host(args.website);
      return [browserVerbs[step] ?? step, what, site && `on ${site}`].filter(Boolean).join(' ');
    }
    if (action.startsWith('NOD_schedule_'))
      return words(args.title ?? (details?.schedule as { title?: unknown } | undefined)?.title)[0];
    if (action === 'NOD_model_select') {
      const target = details?.targetModel as { model?: unknown; for?: unknown } | undefined;
      const model = words(target?.model)[0];
      const work = words(target?.for)[0];
      return model && work && work !== 'when the owner talks to Nod'
        ? `${model} for ${work}`
        : model;
    }
    if (action === 'NOD_limits_update')
      return [
        'monthlyUsd' in args && dollarsOrNone(args.monthlyUsd, 'monthly limit'),
        'taskUsd' in args && dollarsOrNone(args.taskUsd, 'task check-in'),
      ]
        .filter(Boolean)
        .join(', ');
    if (action === 'NOD_notification_preferences_update')
      return [...new Set(Object.keys(args).map((key) => settingNames[key] ?? key))].join(', ');
    if (action.startsWith('COMPUTER_')) {
      const app = (args.app as { name?: unknown } | undefined)?.name;
      const control = args.control as { role?: unknown; name?: unknown } | undefined;
      const what =
        typeof args.keys === 'string'
          ? args.keys
          : typeof control?.name === 'string' && control.name
            ? quoted(control.name)
            : typeof control?.role === 'string'
              ? control.role
              : '';
      return [
        what,
        typeof args.option === 'string' && `→ ${quoted(args.option)}`,
        typeof app === 'string' && `in ${app}`,
      ]
        .filter(Boolean)
        .join(' ');
    }
    if (action.startsWith('LOCAL_FILES_'))
      return listed([
        ...words(args.path),
        ...words(args.paths),
        ...(Array.isArray(args.moves)
          ? (args.moves as Array<{ from?: unknown; to?: unknown }>).map(
              (move) => `${String(move.from)} → ${String(move.to)}`,
            )
          : []),
      ]);
    return approvalContent(action, args)
      .fields?.map((field) => field.value)
      .join(' · ');
  })()?.trim();
  return target ? target.slice(0, 300) : undefined;
}
