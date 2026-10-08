import { randomBytes, randomUUID } from 'node:crypto';
import type {
  IntegrationProvider,
  IntegrationService,
  IntegrationSession,
} from '../../../src/ports/integrations.ts';

export type WriteKind = 'draft' | 'send' | 'create' | 'update' | 'post' | 'delete';
type Args = Record<string, any>;

export interface Tool {
  slug: string;
  description: string;
  inputSchema: Record<string, unknown>;
  write?: WriteKind;
  run(args: Args): unknown;
}

export interface Write {
  at: number;
  slug: string;
  kind: WriteKind;
  args: Args;
}

export interface Person {
  name: string;
  email: string;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
});
const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'integer', description });
const id = (prefix = '') => prefix + randomBytes(8).toString('hex');
const iso = (at: number) => new Date(at).toISOString();

export interface Mail {
  id?: string;
  threadId?: string;
  from: string;
  to?: string;
  subject: string;
  body: string;
  at: number;
  labels?: string[];
  attachments?: Array<{ filename: string; mimeType: string; size: number; bytes?: Buffer }>;
}

interface StoredMail extends Required<Omit<Mail, 'attachments'>> {
  attachments: Array<{
    filename: string;
    mimeType: string;
    size: number;
    attachmentId: string;
    bytes?: Buffer;
  }>;
}

function tokens(query: string) {
  return [...query.matchAll(/(-?[\w.]+:)?"([^"]*)"|\S+/g)].map((match) =>
    match[2] === undefined ? match[0] : `${match[1] ?? ''}${match[2]}`,
  );
}

function days(value: string) {
  const match = /^(\d+)([dmy])$/.exec(value);
  return match ? Number(match[1]) * { d: 1, m: 30, y: 365 }[match[2] as 'd'] * 86_400_000 : NaN;
}

const addresses = (header: string) =>
  header.split(',').map((part) => (/<([^>]+)>/.exec(part)?.[1] ?? part).trim().toLowerCase());

function mailMatches(mail: StoredMail, query: string, now: number, owner = '') {
  const groups: string[][] = [[]];
  for (const token of tokens(query.replace(/[()]/g, ' '))) {
    if (token === 'OR') groups.push([]);
    else groups.at(-1)!.push(token);
  }
  const text = `${mail.from} ${mail.to} ${mail.subject} ${mail.body}`.toLowerCase();
  const test = (token: string) => {
    const [key, ...rest] = token.split(':');
    const value = rest.join(':').toLowerCase();
    if (!rest.length) return text.includes(token.toLowerCase());
    switch (key.toLowerCase()) {
      case 'from':
        return value === 'me' && owner
          ? addresses(mail.from).includes(owner.toLowerCase())
          : mail.from.toLowerCase().includes(value);
      case 'to':
        return value === 'me' && owner
          ? addresses(mail.to).includes(owner.toLowerCase())
          : mail.to.toLowerCase().includes(value);
      case 'subject':
        return mail.subject.toLowerCase().includes(value);
      case 'label':
      case 'in':
        return (
          value === 'anywhere' ||
          mail.labels.some((label) => label.toLowerCase() === value) ||
          (value === 'drafts' && mail.labels.includes('DRAFT'))
        );
      case 'is':
        return mail.labels.some((label) => label.toLowerCase() === value);
      case 'has':
        return value === 'attachment' ? mail.attachments.length > 0 : true;
      case 'after':
        return mail.at >= Date.parse(value.replaceAll('/', '-'));
      case 'before':
        return mail.at < Date.parse(value.replaceAll('/', '-'));
      case 'newer_than':
        return now - mail.at <= days(value);
      case 'older_than':
        return now - mail.at > days(value);
      default:
        return text.includes(token.toLowerCase());
    }
  };
  return groups.some(
    (group) =>
      group.length > 0 &&
      group.every((token) => (token.startsWith('-') ? !test(token.slice(1)) : test(token))),
  );
}

export function gmail(owner: Person, seed: Mail[], now: () => number) {
  const mails: StoredMail[] = seed.map((mail) => ({
    id: mail.id ?? id(),
    threadId: mail.threadId ?? mail.id ?? id(),
    to: mail.to ?? owner.email,
    labels: mail.labels ?? ['INBOX'],
    ...mail,
    attachments: (mail.attachments ?? []).map((file) => ({ ...file, attachmentId: id('att_') })),
  })) as StoredMail[];
  for (const mail of mails) mail.id ??= id();
  const drafts = new Map<string, StoredMail>();
  const draftView = (draftId: string, mail: StoredMail) => ({
    id: draftId,
    message: {
      id: mail.id,
      threadId: mail.threadId,
      labelIds: mail.labels,
      to: mail.to,
      subject: mail.subject,
      messageText: mail.body,
    },
  });
  const view = (mail: StoredMail) => ({
    messageId: mail.id,
    threadId: mail.threadId,
    messageTimestamp: iso(mail.at),
    sender: mail.from,
    to: mail.to,
    subject: mail.subject,
    messageText: mail.body,
    labelIds: mail.labels,
    preview: { subject: mail.subject, body: mail.body.slice(0, 200) },
    attachmentList: mail.attachments.map(({ bytes: _bytes, ...file }) => file),
  });
  const compose = (args: Args, labels: string[]): StoredMail => ({
    id: id(),
    threadId: args.thread_id ?? id(),
    from: `${owner.name} <${owner.email}>`,
    to: args.recipient_email ?? args.to ?? '',
    subject: args.subject ?? '',
    body: args.body ?? args.message_body ?? '',
    at: now(),
    labels,
    attachments: [],
  });
  const tools: Tool[] = [
    {
      slug: 'GMAIL_FETCH_EMAILS',
      description:
        'Fetch a list of email messages from a Gmail account, with optional search by Gmail query operators such as from:, subject:, newer_than:, is:unread and label:.',
      inputSchema: obj({
        query: str('Gmail search query, for example "from:billing newer_than:30d".'),
        max_results: num('Maximum number of messages to return (1-500).'),
        page_token: str('Token for the next page of results.'),
        label_ids: { type: 'array', items: { type: 'string' } },
        include_spam_trash: { type: 'boolean' },
        user_id: str('Use "me" for the authenticated user.'),
      }),
      run(args) {
        const found = mails
          .filter((mail) => !mail.labels.includes('DRAFT'))
          .filter(
            (mail) =>
              (args.label_ids as string[] | undefined)?.every((l) => mail.labels.includes(l)) ??
              true,
          )
          .filter(
            (mail) =>
              !args.query ||
              mailMatches(mail, String(args.query), now(), owner.email.toLowerCase()),
          )
          .sort((a, b) => b.at - a.at);
        const offset = Number(args.page_token ?? 0) || 0;
        const limit = Math.min(Math.max(Number(args.max_results ?? 10), 1), 500);
        const page = found.slice(offset, offset + limit);
        return {
          messages: page.map(view),
          nextPageToken: offset + limit < found.length ? String(offset + limit) : null,
          resultSizeEstimate: found.length,
        };
      },
    },
    {
      slug: 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID',
      description: 'Retrieve all messages in a Gmail thread by thread ID.',
      inputSchema: obj({ thread_id: str('The thread ID.'), user_id: str('Use "me".') }, [
        'thread_id',
      ]),
      run(args) {
        const thread = mails
          .filter((mail) => mail.threadId === args.thread_id)
          .sort((a, b) => a.at - b.at);
        if (!thread.length) throw new Error('Requested entity was not found.');
        return { messages: thread.map(view), thread_id: args.thread_id };
      },
    },
    {
      slug: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
      description: 'Fetch one Gmail message by its message ID.',
      inputSchema: obj({ message_id: str('The message ID.'), user_id: str('Use "me".') }, [
        'message_id',
      ]),
      run(args) {
        const mail = mails.find((item) => item.id === args.message_id);
        if (!mail) throw new Error('Requested entity was not found.');
        return view(mail);
      },
    },
    {
      slug: 'GMAIL_GET_ATTACHMENT',
      description: 'Download a Gmail attachment by message ID and attachment ID.',
      inputSchema: obj(
        {
          message_id: str('The message ID.'),
          attachment_id: str('The attachment ID.'),
          file_name: str('The attachment file name.'),
          user_id: str('Use "me".'),
        },
        ['message_id', 'attachment_id', 'file_name'],
      ),
      run(args) {
        const mail = mails.find((item) => item.id === args.message_id);
        const file = mail?.attachments.find((item) => item.attachmentId === args.attachment_id);
        if (!file?.bytes) throw new Error('Requested entity was not found.');
        return {
          data: {
            file: {
              name: file.filename,
              mimeType: file.mimeType,
              bytes: new Uint8Array(file.bytes),
            },
          },
        };
      },
    },
    {
      slug: 'GMAIL_GET_PROFILE',
      description: 'Get the Gmail profile of the authenticated user.',
      inputSchema: obj({ user_id: str('Use "me".') }),
      run: () => ({
        emailAddress: owner.email,
        messagesTotal: mails.length,
        threadsTotal: new Set(mails.map((mail) => mail.threadId)).size,
      }),
    },
    {
      slug: 'GMAIL_CREATE_EMAIL_DRAFT',
      description:
        'Create a draft email in Gmail. The draft is saved in the Drafts folder and is not sent.',
      inputSchema: obj(
        {
          recipient_email: str('Recipient email address.'),
          subject: str('Subject line.'),
          body: str('Email body.'),
          thread_id: str('Thread to attach the draft to, to create a reply draft.'),
          cc: { type: 'array', items: { type: 'string' } },
          is_html: { type: 'boolean' },
        },
        ['recipient_email', 'subject', 'body'],
      ),
      write: 'draft',
      run(args) {
        const draft = compose(args, ['DRAFT']);
        const draftId = id('r');
        drafts.set(draftId, draft);
        mails.push(draft);
        return {
          id: draftId,
          message: { id: draft.id, threadId: draft.threadId, labelIds: ['DRAFT'] },
        };
      },
    },
    {
      slug: 'GMAIL_SEND_EMAIL',
      description: 'Send an email through the authenticated Gmail account.',
      inputSchema: obj(
        {
          recipient_email: str('Recipient email address.'),
          subject: str('Subject line.'),
          body: str('Email body.'),
          cc: { type: 'array', items: { type: 'string' } },
        },
        ['recipient_email', 'body'],
      ),
      write: 'send',
      run(args) {
        const sent = compose(args, ['SENT']);
        mails.push(sent);
        return { id: sent.id, threadId: sent.threadId, labelIds: ['SENT'] };
      },
    },
    {
      slug: 'GMAIL_REPLY_TO_THREAD',
      description: 'Send a reply in an existing Gmail thread.',
      inputSchema: obj(
        {
          thread_id: str('The thread to reply in.'),
          message_body: str('Reply body.'),
          recipient_email: str('Recipient email address.'),
        },
        ['thread_id', 'message_body', 'recipient_email'],
      ),
      write: 'send',
      run(args) {
        const sent = compose(args, ['SENT']);
        mails.push(sent);
        return { id: sent.id, threadId: sent.threadId, labelIds: ['SENT'] };
      },
    },
    {
      slug: 'GMAIL_LIST_DRAFTS',
      description:
        'List draft emails in the Gmail account. Set verbose to include each draft subject, recipient and body.',
      inputSchema: obj({
        max_results: num('Maximum drafts to return.'),
        verbose: { type: 'boolean' },
        user_id: str('Use "me".'),
      }),
      run: (args) => ({
        drafts: [...drafts.entries()].map(([draftId, mail]) =>
          args.verbose
            ? draftView(draftId, mail)
            : { id: draftId, message: { id: mail.id, threadId: mail.threadId } },
        ),
      }),
    },
    {
      slug: 'GMAIL_GET_DRAFT',
      description: 'Get one draft email by its draft ID, including recipient, subject and body.',
      inputSchema: obj(
        {
          draft_id: str('The draft ID returned when the draft was created.'),
          user_id: str('Use "me".'),
        },
        ['draft_id'],
      ),
      run(args) {
        const mail = drafts.get(String(args.draft_id));
        if (!mail) throw new Error('Requested entity was not found.');
        return draftView(String(args.draft_id), mail);
      },
    },
  ];
  return {
    tools,
    mails,
    drafts: () => [...drafts.values()],
    sent: () => mails.filter((mail) => mail.labels.includes('SENT')),
  };
}

export interface Sheet {
  id?: string;
  title: string;
  tabs: Array<{ name: string; rows: string[][] }>;
}

export function sheets(seed: Sheet[], now: () => number) {
  const books = seed.map((book) => ({
    ...book,
    id: book.id ?? randomBytes(22).toString('base64url'),
    modified: now(),
  }));
  const find = (spreadsheetId: unknown) => {
    const key = String(spreadsheetId ?? '');
    const book = books.find((item) => key === item.id || key.includes(item.id));
    if (!book) throw new Error('Requested entity was not found.');
    return book;
  };
  const column = (index: number) => {
    let name = '';
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
      name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
    return name;
  };
  const parse = (cell: string) => {
    const match = /^([A-Za-z]+)(\d+)$/.exec(cell);
    if (!match) throw new Error('Invalid cell location.');
    const col = [...match[1].toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
    return { col, row: Number(match[2]) - 1 };
  };
  const read = (book: (typeof books)[number], range: string) => {
    const [name, cells = ''] = range.includes('!') ? range.split(/!(.*)/s) : [range, ''];
    const tab = book.tabs.find((item) => item.name === name.replace(/^'|'$/g, '')) ?? book.tabs[0];
    if (!cells)
      return {
        range: `${tab.name}!A1:${column(Math.max(0, ...tab.rows.map((r) => r.length - 1)))}${tab.rows.length}`,
        values: tab.rows,
      };
    const [from, to = from] = cells.split(':');
    const start = /\d/.test(from) ? parse(from) : { col: parse(`${from}1`).col, row: 0 };
    const end = /\d/.test(to) ? parse(to) : { col: parse(`${to}1`).col, row: tab.rows.length - 1 };
    const values = tab.rows
      .slice(start.row, end.row + 1)
      .map((row) => row.slice(start.col, end.col + 1));
    return { range: `${tab.name}!${cells}`, values };
  };
  const write = (
    book: (typeof books)[number],
    tabName: string,
    first: string,
    values: unknown[][],
  ) => {
    let tab = book.tabs.find((item) => item.name === tabName);
    if (!tab) book.tabs.push((tab = { name: tabName, rows: [] }));
    const origin = parse(first);
    values.forEach((row, r) =>
      row.forEach((cell, c) => {
        const target = (tab.rows[origin.row + r] ??= []);
        for (let i = target.length; i < origin.col + c; i++) target[i] = '';
        target[origin.col + c] = String(cell ?? '');
      }),
    );
    book.modified = now();
    return {
      updatedRange: `${tabName}!${first}`,
      updatedRows: values.length,
      updatedColumns: Math.max(0, ...values.map((row) => row.length)),
      updatedCells: values.reduce((n, row) => n + row.length, 0),
    };
  };
  const tools: Tool[] = [
    {
      slug: 'GOOGLESHEETS_SEARCH_SPREADSHEETS',
      description: 'Search for Google Spreadsheets by name.',
      inputSchema: obj({
        query: str('Name text to search for.'),
        max_results: num('Maximum results.'),
      }),
      run: (args) => ({
        spreadsheets: books
          .filter(
            (book) =>
              !args.query || book.title.toLowerCase().includes(String(args.query).toLowerCase()),
          )
          .map((book) => ({
            id: book.id,
            name: book.title,
            modifiedTime: iso(book.modified),
            webViewLink: `https://docs.google.com/spreadsheets/d/${book.id}/edit`,
          })),
      }),
    },
    {
      slug: 'GOOGLESHEETS_GET_SPREADSHEET_INFO',
      description: 'Get spreadsheet metadata: title and the names of every tab.',
      inputSchema: obj({ spreadsheet_id: str('Spreadsheet ID.') }, ['spreadsheet_id']),
      run(args) {
        const book = find(args.spreadsheet_id);
        return {
          spreadsheetId: book.id,
          properties: { title: book.title },
          spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${book.id}/edit`,
          sheets: book.tabs.map((tab, index) => ({
            properties: {
              sheetId: index,
              title: tab.name,
              gridProperties: {
                rowCount: Math.max(1000, tab.rows.length),
                columnCount: Math.max(26, ...tab.rows.map((row) => row.length)),
              },
            },
          })),
        };
      },
    },
    {
      slug: 'GOOGLESHEETS_BATCH_GET',
      description: 'Read one or more A1 ranges from a spreadsheet.',
      inputSchema: obj(
        {
          spreadsheet_id: str('Spreadsheet ID.'),
          ranges: {
            type: 'array',
            items: { type: 'string' },
            description: 'A1 ranges, e.g. "Sheet1!A1:D20".',
          },
        },
        ['spreadsheet_id'],
      ),
      run(args) {
        const book = find(args.spreadsheet_id);
        const ranges: string[] = args.ranges?.length
          ? args.ranges
          : book.tabs.map((tab) => tab.name);
        return {
          spreadsheetId: book.id,
          valueRanges: ranges.map((range) => ({ ...read(book, range), majorDimension: 'ROWS' })),
        };
      },
    },
    {
      slug: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1',
      description: 'Create a new Google Sheets spreadsheet with a title.',
      inputSchema: obj({ title: str('Spreadsheet title.') }, ['title']),
      write: 'create',
      run(args) {
        const book = {
          id: randomBytes(22).toString('base64url'),
          title: String(args.title ?? 'Untitled spreadsheet'),
          tabs: [{ name: 'Sheet1', rows: [] as string[][] }],
          modified: now(),
        };
        books.push(book);
        return {
          spreadsheetId: book.id,
          spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${book.id}/edit`,
          properties: { title: book.title },
          sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }],
        };
      },
    },
    {
      slug: 'GOOGLESHEETS_BATCH_UPDATE',
      description:
        'Write a 2D array of values into a spreadsheet tab starting at a cell. Overwrites existing cells.',
      inputSchema: obj(
        {
          spreadsheet_id: str('Spreadsheet ID.'),
          sheet_name: str('Tab name.'),
          first_cell_location: str('Top-left cell, e.g. "A1".'),
          values: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        },
        ['spreadsheet_id', 'sheet_name', 'values'],
      ),
      write: 'update',
      run: (args) =>
        write(
          find(args.spreadsheet_id),
          String(args.sheet_name),
          String(args.first_cell_location ?? 'A1'),
          args.values ?? [],
        ),
    },
    {
      slug: 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND',
      description: 'Append rows after the last row that has data in a range.',
      inputSchema: obj(
        {
          spreadsheetId: str('Spreadsheet ID.'),
          range: str('A1 range of the tab, e.g. "Sheet1!A1".'),
          values: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        },
        ['spreadsheetId', 'range', 'values'],
      ),
      write: 'update',
      run(args) {
        const book = find(args.spreadsheetId);
        const name = String(args.range).split('!')[0].replace(/^'|'$/g, '');
        const tab = book.tabs.find((item) => item.name === name) ?? book.tabs[0];
        return write(book, tab.name, `A${tab.rows.length + 1}`, args.values ?? []);
      },
    },
  ];
  return { tools, books };
}

export interface SlackMessage {
  ts?: string;
  user: string;
  text: string;
  at: number;
  threadTs?: string;
  replies?: SlackMessage[];
  files?: Array<{ id?: string; name: string; mimeType: string; bytes: Buffer }>;
}

export interface SlackConversation {
  id?: string;
  name: string;
  kind: 'channel' | 'dm';
  with?: string;
  messages: SlackMessage[];
}

export function slack(
  owner: Person & { id: string },
  users: Array<{ id: string; name: string }>,
  seed: SlackConversation[],
  now: () => number,
) {
  const stamp = (at: number, seq: number) =>
    `${Math.floor(at / 1000)}.${String(seq).padStart(6, '0')}`;
  let sequence = 1;
  const withFiles = (message: SlackMessage): SlackMessage => ({
    ...message,
    files: message.files?.map((file) => ({
      ...file,
      id: file.id ?? `F${id().slice(0, 10).toUpperCase()}`,
    })),
    replies: message.replies?.map(withFiles),
  });
  const conversations = seed.map((conversation) => {
    const messages = conversation.messages.map((message) => ({
      ...withFiles(message),
      ts: message.ts ?? stamp(message.at, sequence++),
    }));
    for (const message of messages)
      for (const reply of message.replies ?? []) reply.ts ??= stamp(reply.at, sequence++);
    return {
      ...conversation,
      id:
        conversation.id ??
        `${conversation.kind === 'dm' ? 'D' : 'C'}${id().slice(0, 8).toUpperCase()}`,
      messages,
    };
  });
  const find = (channel: unknown) => {
    const conversation = conversations.find(
      (item) => item.id === channel || item.name === String(channel).replace(/^#/, ''),
    );
    if (!conversation) throw new Error('channel_not_found');
    return conversation;
  };
  const view = (message: SlackMessage, withReplies = true) => ({
    type: 'message',
    user: message.user,
    text: message.text,
    ts: message.ts,
    ...(message.replies?.length && withReplies
      ? {
          thread_ts: message.ts,
          reply_count: message.replies.length,
          latest_reply: message.replies.at(-1)!.ts,
        }
      : {}),
    ...(message.threadTs ? { thread_ts: message.threadTs } : {}),
    ...(message.files?.length
      ? {
          files: message.files.map((file) => ({
            id: file.id,
            name: file.name,
            mimetype: file.mimeType,
            size: file.bytes.byteLength,
            url_private_download: `https://files.slack.example/files-pri/${file.id}/download`,
          })),
        }
      : {}),
  });
  const channelView = (conversation: (typeof conversations)[number]) =>
    conversation.kind === 'dm'
      ? { id: conversation.id, is_im: true, user: conversation.with, created: 0 }
      : {
          id: conversation.id,
          name: conversation.name,
          is_channel: true,
          is_member: true,
          num_members: users.length,
        };
  const listChannels = (args: Args) => ({
    ok: true,
    channels: conversations
      .filter(
        (item) =>
          !args.types ||
          String(args.types)
            .split(',')
            .some((type) => (type.trim() === 'im' ? item.kind === 'dm' : item.kind === 'channel')),
      )
      .map(channelView),
  });
  const tools: Tool[] = [
    {
      slug: 'SLACK_AUTH_TEST',
      description: 'Check authentication and return the identity of the authenticated Slack user.',
      inputSchema: obj({}),
      run: () => ({ ok: true, user: owner.name, user_id: owner.id, team: 'Workspace' }),
    },
    {
      slug: 'SLACK_LIST_ALL_CHANNELS',
      description:
        'List conversations in the workspace. Use types "public_channel,im" to include direct messages.',
      inputSchema: obj({
        types: str('Comma-separated conversation types.'),
        limit: num('Maximum results.'),
      }),
      run: listChannels,
    },
    {
      slug: 'SLACK_LIST_ALL_USERS',
      description: 'List all users in the workspace.',
      inputSchema: obj({ limit: num('Maximum results.') }),
      run: () => ({
        ok: true,
        members: [owner, ...users].map((user) => ({
          id: 'id' in user ? user.id : '',
          name: user.name,
          real_name: user.name,
        })),
      }),
    },
    {
      slug: 'SLACK_FETCH_CONVERSATION_HISTORY',
      description:
        'Fetch messages from a channel or direct message, newest first. Supports oldest and latest unix timestamps.',
      inputSchema: obj(
        {
          channel: str('Channel or DM ID.'),
          oldest: str('Only messages after this unix timestamp.'),
          latest: str('Only messages before this unix timestamp.'),
          limit: num('Maximum messages.'),
        },
        ['channel'],
      ),
      run(args) {
        const conversation = find(args.channel);
        const oldest = Number(args.oldest ?? 0);
        const latest = Number(args.latest ?? Infinity);
        const messages = conversation.messages
          .filter((message) => Number(message.ts) >= oldest && Number(message.ts) <= latest)
          .sort((a, b) => Number(b.ts) - Number(a.ts))
          .slice(0, Number(args.limit ?? 100));
        return { ok: true, messages: messages.map((message) => view(message)), has_more: false };
      },
    },
    {
      slug: 'SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION',
      description: 'Fetch all replies in a thread given the channel and the parent message ts.',
      inputSchema: obj({ channel: str('Channel or DM ID.'), ts: str('Parent message ts.') }, [
        'channel',
        'ts',
      ]),
      run(args) {
        const parent = find(args.channel).messages.find(
          (message) => Number(message.ts) === Number(args.ts),
        );
        if (!parent) throw new Error('thread_not_found');
        return {
          ok: true,
          messages: [
            view(parent),
            ...(parent.replies ?? []).map((reply) => ({
              ...view(reply, false),
              thread_ts: parent.ts,
            })),
          ],
        };
      },
    },
    {
      slug: 'SLACK_SEARCH_MESSAGES',
      description: 'Search messages across the workspace.',
      inputSchema: obj({ query: str('Search query.'), count: num('Maximum results.') }, ['query']),
      run: (args) => {
        const terms = String(args.query).toLowerCase().replaceAll('"', '').split(/\s+/);
        const channel = terms
          .find((term) => term.startsWith('in:'))
          ?.slice(3)
          .replace(/^#/, '');
        const words = terms.filter((term) => term && !term.includes(':'));
        return {
          ok: true,
          messages: {
            matches: conversations
              .filter(
                (conversation) =>
                  !channel || [conversation.id, conversation.name].includes(channel),
              )
              .flatMap((conversation) =>
                conversation.messages
                  .flatMap((message) => [
                    message,
                    ...(message.replies ?? []).map((reply) => ({
                      ...reply,
                      ts: reply.ts ?? message.ts,
                      threadTs: message.ts,
                    })),
                  ])
                  .filter((message) =>
                    words.every((word) => message.text.toLowerCase().includes(word)),
                  )
                  .map((message) => ({
                    ...view(message),
                    channel: { id: conversation.id, name: conversation.name },
                  })),
              ),
          },
        };
      },
    },
    {
      slug: 'SLACK_DOWNLOAD_SLACK_FILE',
      description: 'Download a file shared in Slack by its file ID.',
      inputSchema: obj({ file: str('Slack file ID.') }, ['file']),
      run(args) {
        const file = conversations
          .flatMap((conversation) => conversation.messages)
          .flatMap((message) => [message, ...(message.replies ?? [])])
          .flatMap((message) => message.files ?? [])
          .find((item) => item.id === args.file);
        if (!file) throw new Error('file_not_found');
        return {
          data: {
            file_content: {
              name: file.name,
              mimeType: file.mimeType,
              bytes: new Uint8Array(file.bytes),
            },
          },
        };
      },
    },
    {
      slug: 'SLACK_SEND_MESSAGE',
      description: 'Post a message to a Slack channel or direct message.',
      inputSchema: obj(
        {
          channel: str('Channel or DM ID.'),
          text: str('Message text.'),
          thread_ts: str('Reply in this thread.'),
        },
        ['channel', 'text'],
      ),
      write: 'post',
      run(args) {
        const conversation = find(args.channel);
        const parent = args.thread_ts
          ? conversation.messages.find((item) => Number(item.ts) === Number(args.thread_ts))
          : undefined;
        if (args.thread_ts && !parent) throw new Error('thread_not_found');
        const message = {
          user: owner.id,
          text: String(args.text),
          at: now(),
          ts: stamp(now(), sequence++),
          ...(parent ? { threadTs: parent.ts } : {}),
        };
        if (parent) (parent.replies ??= []).push(message);
        else conversation.messages.push(message);
        return { ok: true, channel: conversation.id, ts: message.ts, message: view(message) };
      },
    },
  ];
  const post = (channel: string, message: SlackMessage) => {
    find(channel).messages.push({ ...withFiles(message), ts: stamp(message.at, sequence++) });
  };
  return { tools, conversations, post };
}

export interface CalendarEvent {
  id?: string;
  summary: string;
  start: number;
  end: number;
  attendees?: string[];
  location?: string;
  description?: string;
}

export function calendar(owner: Person, seed: CalendarEvent[], timeZone: string) {
  const events = seed.map((event) => ({ ...event, id: event.id ?? id() }));
  const view = (event: (typeof events)[number]) => ({
    id: event.id,
    status: 'confirmed',
    summary: event.summary,
    location: event.location,
    description: event.description,
    creator: { email: owner.email },
    organizer: { email: owner.email },
    start: { dateTime: iso(event.start), timeZone },
    end: { dateTime: iso(event.end), timeZone },
    attendees: (event.attendees ?? []).map((email) => ({ email, responseStatus: 'needsAction' })),
    htmlLink: `https://www.google.com/calendar/event?eid=${event.id}`,
  });
  const tools: Tool[] = [
    {
      slug: 'GOOGLECALENDAR_EVENTS_LIST',
      description: 'List events from a calendar between timeMin and timeMax (RFC3339).',
      inputSchema: obj({
        calendarId: str('Calendar ID, "primary" for the main calendar.'),
        timeMin: str('Lower bound (RFC3339).'),
        timeMax: str('Upper bound (RFC3339).'),
        maxResults: num('Maximum events.'),
        singleEvents: { type: 'boolean' },
        orderBy: str('startTime or updated.'),
      }),
      run(args) {
        const min = args.timeMin ? Date.parse(args.timeMin) : -Infinity;
        const max = args.timeMax ? Date.parse(args.timeMax) : Infinity;
        return {
          kind: 'calendar#events',
          timeZone,
          items: events
            .filter((event) => event.end > min && event.start < max)
            .sort((a, b) => a.start - b.start)
            .slice(0, Number(args.maxResults ?? 250))
            .map(view),
        };
      },
    },
    {
      slug: 'GOOGLECALENDAR_CREATE_EVENT',
      description: 'Create a calendar event.',
      inputSchema: obj(
        {
          summary: str('Event title.'),
          start_datetime: str('Start (RFC3339).'),
          event_duration_minutes: num('Duration in minutes.'),
          attendees: { type: 'array', items: { type: 'string' } },
          location: str('Location.'),
          description: str('Description.'),
        },
        ['summary', 'start_datetime'],
      ),
      write: 'create',
      run(args) {
        const start = Date.parse(args.start_datetime);
        const event = {
          id: id(),
          summary: String(args.summary),
          start,
          end: start + Number(args.event_duration_minutes ?? 60) * 60_000,
          attendees: args.attendees ?? [],
          location: args.location,
          description: args.description,
        };
        events.push(event);
        return view(event);
      },
    },
    {
      slug: 'GOOGLECALENDAR_PATCH_EVENT',
      description:
        'Update selected fields of an existing calendar event. Omitted fields remain unchanged.',
      inputSchema: obj(
        {
          calendar_id: str('Calendar ID, primary for the main calendar.'),
          event_id: str('Existing event ID.'),
          start_datetime: str('New start (RFC3339).'),
          end_datetime: str('New end (RFC3339).'),
          summary: str('New title.'),
        },
        ['event_id'],
      ),
      write: 'update',
      run(args) {
        const event = events.find((item) => item.id === args.event_id);
        if (!event) throw new Error('Requested event was not found.');
        const start =
          args.start_datetime === undefined ? event.start : Date.parse(args.start_datetime);
        const end = args.end_datetime === undefined ? event.end : Date.parse(args.end_datetime);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
          throw new Error('The event needs a valid start and end time.');
        Object.assign(event, {
          start,
          end,
          ...(args.summary === undefined ? {} : { summary: String(args.summary) }),
        });
        return view(event);
      },
    },
  ];
  return { tools, events };
}

const services: Record<string, { service: IntegrationService; name: string }> = {
  GMAIL: { service: 'gmail', name: 'Gmail' },
  GOOGLESHEETS: { service: 'googlesheets', name: 'Google Sheets' },
  SLACK: { service: 'slack', name: 'Slack' },
  GOOGLECALENDAR: { service: 'googlecalendar', name: 'Google Calendar' },
};

export interface AppsWorld {
  provider: IntegrationProvider;
  writes: Write[];
  calls: Array<{ at: number; slug: string; args: Args; error?: string }>;
  callbacks: Map<string, string>;
  connected: Set<IntegrationService>;
  services: IntegrationService[];
  gmail?: ReturnType<typeof gmail>;
  sheets?: ReturnType<typeof sheets>;
  slack?: ReturnType<typeof slack>;
  calendar?: ReturnType<typeof calendar>;
}

export function createApps(
  owner: Person,
  parts: Pick<AppsWorld, 'gmail' | 'sheets' | 'slack' | 'calendar'>,
): AppsWorld {
  const byService = new Map<IntegrationService, Tool[]>();
  const add = (tools?: Tool[]) => {
    for (const tool of tools ?? []) {
      const service = services[tool.slug.split('_')[0]].service;
      byService.set(service, [...(byService.get(service) ?? []), tool]);
    }
  };
  add(parts.gmail?.tools);
  add(parts.sheets?.tools);
  add(parts.slack?.tools);
  add(parts.calendar?.tools);
  const accounts = new Map<
    string,
    { service: IntegrationService; ownerId: string; active: boolean }
  >();
  const world: AppsWorld = {
    ...parts,
    writes: [],
    calls: [],
    callbacks: new Map(),
    connected: new Set(),
    services: [...byService.keys()],
    provider: undefined as never,
  };
  world.provider = {
    id: 'eval-apps',
    configured: true,
    supportedServices: [...byService.keys()],
    webhooksConfigured: false,
    supportsSubscriptions: [],
    async createSession(ownerId): Promise<IntegrationSession> {
      return {
        id: randomUUID(),
        async authorize(service, callbackUrl) {
          const accountId = randomUUID();
          accounts.set(accountId, { service, ownerId, active: true });
          world.callbacks.set(accountId, callbackUrl);
          world.connected.add(service);
          return { accountId, url: `https://accounts.example.net/connect/${accountId}` };
        },
        async search(query) {
          const tools = Object.fromEntries(
            [...byService.entries()].flatMap(([service, list]) =>
              list.map((tool) => [
                tool.slug,
                {
                  toolSlug: tool.slug,
                  toolkit: service,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                  hasFullSchema: true,
                },
              ]),
            ),
          );
          return {
            tools,
            suggestions: [{ useCase: query, primaryToolSlugs: Object.keys(tools).slice(0, 4) }],
          };
        },
        async execute(action, args, accountId) {
          const account = accountId ? accounts.get(accountId) : undefined;
          const tool = byService
            .get(account?.service as IntegrationService)
            ?.find((item) => item.slug === action);
          const call = {
            at: Date.now(),
            slug: action,
            args: structuredClone(args),
          } as AppsWorld['calls'][number];
          world.calls.push(call);
          try {
            if (!account?.active || account.ownerId !== ownerId)
              throw new Error('No active connected account was found for this request.');
            if (!tool) throw new Error(`Tool ${action} was not found.`);
            const result = tool.run(args);
            if (tool.write)
              world.writes.push({
                at: Date.now(),
                slug: action,
                kind: tool.write,
                args: structuredClone(args),
              });
            return result;
          } catch (error) {
            call.error = error instanceof Error ? error.message : String(error);
            throw error;
          }
        },
      };
    },
    async restoreSession() {
      return world.provider.createSession('local-development', {});
    },
    async deleteSession() {},
    async inspectAccount(accountId) {
      const account = accounts.get(accountId);
      return {
        active: Boolean(account?.active),
        service: account?.service ?? '',
        accountName: owner.name,
        accountEmail: owner.email,
      };
    },
    async deleteAccount(accountId) {
      accounts.delete(accountId);
    },
    parseCallback(query) {
      const value = query as Record<string, string>;
      return {
        state: value.state || '',
        accountId: value.account_ref || '',
        success: value.outcome === 'success',
      };
    },
    async subscribe() {
      throw new Error('Triggers are not configured.');
    },
    async unsubscribe() {},
    async verifyWebhook() {
      throw new Error('Webhooks are not configured.');
    },
    matchesSubscription: () => false,
  };
  return world;
}
