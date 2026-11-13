import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

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
  ['NOD_model_select', 'Change the model'],
  ['NOD_notification_preferences_update', 'Change notifications'],
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
  browser: 'Used the browser',
  'sign in': 'Signed in',
  pay: 'Entered a card',
  'browser session': 'Opened a saved session',
  apps: 'Used a connected app',
  files: 'Handled local files',
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

export function toolTitle(summary: string) {
  if (tools[summary]) return tools[summary];
  const browser = /^browser ([a-z_]+)$/.exec(summary)?.[1];
  if (browser) return `Browser: ${browser.replaceAll('_', ' ')}`;
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

export function recordedTitle(action: string) {
  if (action === 'NOD_browser') return 'Browser';
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
    if (action === 'NOD_model_select')
      return words((details?.targetModel as { model?: unknown } | undefined)?.model)[0];
    if (action === 'NOD_limits_update')
      return [
        'monthlyUsd' in args && dollarsOrNone(args.monthlyUsd, 'monthly limit'),
        'taskUsd' in args && dollarsOrNone(args.taskUsd, 'task check-in'),
      ]
        .filter(Boolean)
        .join(', ');
    if (action === 'NOD_notification_preferences_update')
      return [...new Set(Object.keys(args).map((key) => settingNames[key] ?? key))].join(', ');
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
