import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  IntegrationProvider,
  IntegrationService,
  IntegrationSession,
} from '../../../src/ports/integrations.ts';
import type { ObservationQuery } from '../../../src/ports/proactivity.ts';
import {
  bool,
  id,
  iso,
  list,
  num,
  obj,
  readUploads,
  storeUpload,
  str,
  uploadable,
  type Args,
  type Tool,
  type WriteKind,
} from './app-kit.ts';
import type { docs, drive } from './drive.ts';
import { computeTab } from './formulas.ts';
import type { linear } from './linear.ts';
import { remoteMcp } from './mcp.ts';
import type { notion } from './notion.ts';
import type { Site } from './sites.ts';

export type { Tool, WriteKind } from './app-kit.ts';

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

export interface Mail {
  id?: string;
  threadId?: string;
  from: string;
  to?: string;
  cc?: string;
  subject: string;
  body: string;
  at: number;
  labels?: string[];
  automated?: boolean;
  attachments?: Array<{ filename: string; mimeType: string; size: number; bytes?: Buffer }>;
}

interface StoredMail extends Required<Omit<Mail, 'attachments' | 'automated'>> {
  automated?: boolean;
  attachments: Array<{
    filename: string;
    mimeType: string;
    size: number;
    attachmentId: string;
    bytes?: Buffer;
  }>;
}

const systemLabels = [
  'INBOX',
  'SENT',
  'DRAFT',
  'UNREAD',
  'STARRED',
  'IMPORTANT',
  'TRASH',
  'SPAM',
  'CATEGORY_PERSONAL',
  'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
];

function tokens(query: string) {
  return [...query.matchAll(/(-?[\w.]+:)?"([^"]*)"|\S+/g)].map((match) =>
    match[2] === undefined ? match[0] : `${match[1] ?? ''}${match[2]}`,
  );
}

function days(value: string) {
  const match = /^(\d+)([dmy])$/.exec(value);
  return match ? Number(match[1]) * { d: 1, m: 30, y: 365 }[match[2] as 'd'] * 86_400_000 : NaN;
}

const instant = (value: string) =>
  /^\d{9,11}$/.test(value) ? Number(value) * 1000 : Date.parse(value.replaceAll('/', '-'));

export const addresses = (header: string) =>
  (header.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) ?? []).map((address) => address.toLowerCase());

function mailMatches(
  mail: StoredMail,
  query: string,
  now: number,
  owner = '',
  labelNames: (id: string) => string[] = (value) => [value],
) {
  const groups: string[][] = [[]];
  for (const token of tokens(query.replace(/[()]/g, ' '))) {
    if (token === 'OR') groups.push([]);
    else groups.at(-1)!.push(token);
  }
  const text = `${mail.from} ${mail.to} ${mail.subject} ${mail.body}`.toLowerCase();
  const hasLabel = (value: string) =>
    mail.labels.some((label) =>
      labelNames(label).some(
        (name) => name.toLowerCase() === value || name.toLowerCase().replace(/\s+/g, '-') === value,
      ),
    );
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
      case 'cc':
        return mail.cc.toLowerCase().includes(value);
      case 'subject':
        return mail.subject.toLowerCase().includes(value);
      case 'label':
      case 'in':
        return (
          value === 'anywhere' ||
          hasLabel(value) ||
          (value === 'drafts' && mail.labels.includes('DRAFT'))
        );
      case 'is':
        return hasLabel(value) || (value === 'read' && !mail.labels.includes('UNREAD'));
      case 'has':
        return value === 'attachment' ? mail.attachments.length > 0 : true;
      case 'filename':
        return mail.attachments.some((file) => file.filename.toLowerCase().includes(value));
      case 'after':
      case 'newer':
        return mail.at >= instant(value);
      case 'before':
      case 'older':
        return mail.at < instant(value);
      case 'category':
        return (
          mail.labels.includes(
            value === 'primary' ? 'CATEGORY_PERSONAL' : `CATEGORY_${value.toUpperCase()}`,
          ) ||
          (value === 'primary' && !mail.labels.some((label) => label.startsWith('CATEGORY_')))
        );
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

export function sameSubject(a: string, b: string) {
  const bare = (subject: string) =>
    subject
      .replace(/^(\s*(re|fwd?)\s*:)+/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  return bare(a) === bare(b);
}

export function gmail(owner: Person, seed: Mail[], now: () => number) {
  const userLabels: Array<{ id: string; name: string }> = [];
  const labelId = (value: string) => {
    if (systemLabels.includes(value.toUpperCase())) return value.toUpperCase();
    const found = userLabels.find(
      (label) => label.id === value || label.name.toLowerCase() === value.toLowerCase(),
    );
    if (found) return found.id;
    const created = { id: `Label_${userLabels.length + 1}`, name: value };
    userLabels.push(created);
    return created.id;
  };
  const store = (mail: Mail) =>
    ({
      id: mail.id ?? id(),
      threadId: mail.threadId ?? mail.id ?? id(),
      to: mail.to ?? owner.email,
      cc: mail.cc ?? '',
      ...mail,
      labels: (mail.labels ?? ['INBOX']).map(labelId),
      attachments: (mail.attachments ?? []).map((file) => ({ ...file, attachmentId: id('att_') })),
    }) as StoredMail;
  const mails: StoredMail[] = seed.map(store);
  for (const mail of mails) mail.id ??= id();
  const drafts = new Map<string, StoredMail>(
    mails.filter((mail) => mail.labels.includes('DRAFT')).map((mail) => [id('r'), mail]),
  );
  const labelNames = (value: string) => [
    value,
    ...userLabels.filter((label) => label.id === value).map((label) => label.name),
  ];
  const knownLabel = (value: unknown) => {
    const key = String(value ?? '');
    if (systemLabels.includes(key.toUpperCase())) return key.toUpperCase();
    const found = userLabels.find(
      (label) => label.id === key || label.name.toLowerCase() === key.toLowerCase(),
    );
    if (!found) throw new Error(`Invalid label: ${key}`);
    return found.id;
  };
  const relabel = (mail: StoredMail, add: unknown, remove: unknown) => {
    const adding = ((add as unknown[] | undefined) ?? []).map(knownLabel);
    const removing = new Set(((remove as unknown[] | undefined) ?? []).map(knownLabel));
    mail.labels = [...new Set([...mail.labels.filter((label) => !removing.has(label)), ...adding])];
  };
  const message = (messageId: unknown) => {
    const mail = mails.find((item) => item.id === messageId);
    if (!mail) throw new Error('Requested entity was not found.');
    return mail;
  };
  const draftView = (draftId: string, mail: StoredMail) => ({
    id: draftId,
    message: {
      id: mail.id,
      threadId: mail.threadId,
      labelIds: mail.labels,
      to: mail.to,
      cc: mail.cc,
      subject: mail.subject,
      messageText: mail.body,
      attachmentList: mail.attachments.map(({ bytes: _bytes, ...file }) => file),
    },
  });
  const view = (mail: StoredMail) => ({
    messageId: mail.id,
    threadId: mail.threadId,
    messageTimestamp: iso(mail.at),
    sender: mail.from,
    to: mail.to,
    ...(mail.cc ? { cc: mail.cc } : {}),
    subject: mail.subject,
    messageText: mail.body,
    labelIds: mail.labels,
    preview: { subject: mail.subject, body: mail.body.slice(0, 200) },
    attachmentList: mail.attachments.map(({ bytes: _bytes, ...file }) => file),
  });
  const recipients = (args: Args) =>
    [args.recipient_email ?? args.to, ...((args.extra_recipients as string[] | undefined) ?? [])]
      .flat()
      .filter(Boolean)
      .join(', ');
  const compose = (args: Args, labels: string[]): StoredMail => ({
    id: id(),
    threadId: args.thread_id ?? id(),
    from: `${owner.name} <${owner.email}>`,
    to: recipients(args),
    cc: [args.cc ?? []].flat().filter(Boolean).join(', '),
    subject: args.subject ?? '',
    body: args.body ?? args.message_body ?? '',
    at: now(),
    labels,
    attachments: readUploads(args.attachment).map((file) => ({
      filename: file.name,
      mimeType: file.mimeType,
      size: file.bytes.byteLength,
      attachmentId: id('att_'),
      bytes: file.bytes,
    })),
  });
  const visible = (mail: StoredMail, args: Args) =>
    !mail.labels.includes('DRAFT') &&
    (args.include_spam_trash ||
      /\b(?:in|label):(?:trash|spam|anywhere)\b/i.test(String(args.query ?? '')) ||
      !mail.labels.some((label) => label === 'TRASH' || label === 'SPAM'));
  const composeSchema = {
    recipient_email: str('Recipient email address.'),
    extra_recipients: list({ type: 'string' }, 'More recipient email addresses.'),
    subject: str('Subject line.'),
    body: str('Email body.'),
    cc: list({ type: 'string' }, 'CC addresses.'),
    is_html: bool('Whether the body is HTML.'),
    attachment: uploadable('A file to attach.'),
  };
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
        const wanted = ((args.label_ids as string[] | undefined) ?? []).map((label) => {
          try {
            return knownLabel(label);
          } catch {
            return label;
          }
        });
        const found = mails
          .filter((mail) => visible(mail, args))
          .filter((mail) => wanted.every((label) => mail.labels.includes(label)))
          .filter(
            (mail) =>
              !args.query ||
              mailMatches(mail, String(args.query), now(), owner.email.toLowerCase(), labelNames),
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
      run: (args) => view(message(args.message_id)),
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
      slug: 'GMAIL_LIST_LABELS',
      description: 'List the system and user labels of the Gmail account with their IDs.',
      inputSchema: obj({ user_id: str('Use "me".') }),
      run: () => ({
        labels: [
          ...systemLabels.map((label) => ({ id: label, name: label, type: 'system' })),
          ...userLabels.map((label) => ({ ...label, type: 'user' })),
        ],
      }),
    },
    {
      slug: 'GMAIL_CREATE_LABEL',
      description: 'Create a new user label in Gmail.',
      inputSchema: obj({ label_name: str('Name of the label.'), user_id: str('Use "me".') }, [
        'label_name',
      ]),
      write: 'create',
      run(args) {
        const name = String(args.label_name ?? '').trim();
        if (!name) throw new Error('Invalid label name.');
        if (
          systemLabels.includes(name.toUpperCase()) ||
          userLabels.some((label) => label.name.toLowerCase() === name.toLowerCase())
        )
          throw new Error('Label name exists or conflicts.');
        const label = { id: `Label_${userLabels.length + 1}`, name };
        userLabels.push(label);
        return { ...label, type: 'user' };
      },
    },
    {
      slug: 'GMAIL_ADD_LABEL_TO_EMAIL',
      description:
        'Add or remove label IDs on one message. Remove INBOX to archive it, or UNREAD to mark it read.',
      inputSchema: obj(
        {
          message_id: str('The message ID.'),
          add_label_ids: list({ type: 'string' }, 'Label IDs to add.'),
          remove_label_ids: list({ type: 'string' }, 'Label IDs to remove.'),
          user_id: str('Use "me".'),
        },
        ['message_id'],
      ),
      write: 'update',
      run(args) {
        const mail = message(args.message_id);
        relabel(mail, args.add_label_ids, args.remove_label_ids);
        return { id: mail.id, threadId: mail.threadId, labelIds: mail.labels };
      },
    },
    {
      slug: 'GMAIL_BATCH_MODIFY_MESSAGES',
      description:
        'Add or remove label IDs on up to 1000 messages at once. Remove INBOX to archive, or UNREAD to mark read.',
      inputSchema: obj(
        {
          messageIds: list({ type: 'string' }, 'Message IDs.'),
          addLabelIds: list({ type: 'string' }, 'Label IDs to add.'),
          removeLabelIds: list({ type: 'string' }, 'Label IDs to remove.'),
          userId: str('Use "me".'),
        },
        ['messageIds'],
      ),
      write: 'update',
      run(args) {
        const targets = ((args.messageIds as unknown[] | undefined) ?? []).map(message);
        for (const mail of targets) relabel(mail, args.addLabelIds, args.removeLabelIds);
        return { modified: targets.length };
      },
    },
    {
      slug: 'GMAIL_MODIFY_THREAD_LABELS',
      description: 'Add or remove label IDs on every message in a thread.',
      inputSchema: obj(
        {
          thread_id: str('The thread ID.'),
          add_label_ids: list({ type: 'string' }, 'Label IDs to add.'),
          remove_label_ids: list({ type: 'string' }, 'Label IDs to remove.'),
          user_id: str('Use "me".'),
        },
        ['thread_id'],
      ),
      write: 'update',
      run(args) {
        const thread = mails.filter(
          (mail) => mail.threadId === args.thread_id && !mail.labels.includes('DRAFT'),
        );
        if (!thread.length) throw new Error('Requested entity was not found.');
        for (const mail of thread) relabel(mail, args.add_label_ids, args.remove_label_ids);
        return { id: args.thread_id, messages: thread.map(view) };
      },
    },
    {
      slug: 'GMAIL_MOVE_TO_TRASH',
      description: 'Move one message to the trash.',
      inputSchema: obj({ message_id: str('The message ID.'), user_id: str('Use "me".') }, [
        'message_id',
      ]),
      write: 'delete',
      run(args) {
        const mail = message(args.message_id);
        mail.labels = [...mail.labels.filter((label) => label !== 'INBOX'), 'TRASH'];
        return { id: mail.id, threadId: mail.threadId, labelIds: mail.labels };
      },
    },
    {
      slug: 'GMAIL_CREATE_EMAIL_DRAFT',
      description:
        'Create a draft email in Gmail. The draft is saved in the Drafts folder and is not sent.',
      inputSchema: obj(
        {
          ...composeSchema,
          thread_id: str('Thread to attach the draft to, to create a reply draft.'),
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
      slug: 'GMAIL_UPDATE_DRAFT',
      description: 'Replace the recipient, subject or body of an existing draft.',
      inputSchema: obj(
        {
          draft_id: str('The draft ID.'),
          ...composeSchema,
          user_id: str('Use "me".'),
        },
        ['draft_id'],
      ),
      write: 'draft',
      run(args) {
        const draft = drafts.get(String(args.draft_id));
        if (!draft) throw new Error('Requested entity was not found.');
        if (args.recipient_email !== undefined) draft.to = recipients(args);
        if (args.subject !== undefined) draft.subject = String(args.subject);
        if (args.body !== undefined) draft.body = String(args.body);
        if (args.cc !== undefined) draft.cc = [args.cc].flat().filter(Boolean).join(', ');
        if (args.attachment !== undefined) draft.attachments = compose(args, ['DRAFT']).attachments;
        draft.at = now();
        return draftView(String(args.draft_id), draft);
      },
    },
    {
      slug: 'GMAIL_SEND_EMAIL',
      description: 'Send an email through the authenticated Gmail account.',
      inputSchema: obj(composeSchema, ['recipient_email', 'body']),
      write: 'send',
      run(args) {
        const sent = compose(args, ['SENT']);
        if (!sent.to) throw new Error('A recipient is required.');
        mails.push(sent);
        return { id: sent.id, threadId: sent.threadId, labelIds: ['SENT'] };
      },
    },
    {
      slug: 'GMAIL_REPLY_TO_THREAD',
      description:
        "Send a reply in an existing Gmail thread using the original thread's subject; use GMAIL_SEND_EMAIL to set a different subject.",
      inputSchema: obj(
        {
          thread_id: str('The thread to reply in.'),
          message_body: str('Reply body.'),
          recipient_email: str('Recipient email address.'),
          extra_recipients: list({ type: 'string' }, 'More recipient email addresses.'),
          cc: list({ type: 'string' }, 'CC addresses.'),
          attachment: uploadable('A file to attach.'),
        },
        ['thread_id', 'message_body', 'recipient_email'],
      ),
      write: 'send',
      run(args) {
        const original = mails.find((mail) => mail.threadId === args.thread_id);
        if (!original) throw new Error('Gmail thread not found.');
        const sent = compose({ ...args, subject: original.subject }, ['SENT']);
        mails.push(sent);
        return { id: sent.id, threadId: sent.threadId, labelIds: ['SENT'] };
      },
    },
    {
      slug: 'GMAIL_FORWARD_MESSAGE',
      description: 'Forward an existing message, with its attachments, to one or more recipients.',
      inputSchema: obj(
        {
          message_id: str('The message ID to forward.'),
          recipients: list({ type: 'string' }, 'Recipient email addresses.'),
          additional_text: str('Text to add above the forwarded message.'),
          cc: list({ type: 'string' }, 'CC addresses.'),
          user_id: str('Use "me".'),
        },
        ['message_id', 'recipients'],
      ),
      write: 'send',
      run(args) {
        const original = message(args.message_id);
        const to = [args.recipients].flat().filter(Boolean).join(', ');
        if (!to) throw new Error('A recipient is required.');
        const sent: StoredMail = {
          ...compose({ recipient_email: to, cc: args.cc }, ['SENT']),
          subject: `Fwd: ${original.subject}`,
          body: `${args.additional_text ? `${args.additional_text}\n\n` : ''}---------- Forwarded message ---------\nFrom: ${original.from}\nSubject: ${original.subject}\n\n${original.body}`,
          attachments: original.attachments.map((file) => ({ ...file, attachmentId: id('att_') })),
        };
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
    {
      slug: 'GMAIL_SEND_DRAFT',
      description: 'Send an existing draft by its draft ID.',
      inputSchema: obj({ draft_id: str('The draft ID.'), user_id: str('Use "me".') }, ['draft_id']),
      write: 'send',
      run(args) {
        const draft = drafts.get(String(args.draft_id));
        if (!draft) throw new Error('Requested entity was not found.');
        if (!draft.to) throw new Error('The draft has no recipient.');
        drafts.delete(String(args.draft_id));
        draft.labels = ['SENT'];
        draft.at = now();
        return { id: draft.id, threadId: draft.threadId, labelIds: draft.labels };
      },
    },
    {
      slug: 'GMAIL_DELETE_DRAFT',
      description: 'Delete a draft permanently by its draft ID.',
      inputSchema: obj({ draft_id: str('The draft ID.'), user_id: str('Use "me".') }, ['draft_id']),
      write: 'delete',
      run(args) {
        const draft = drafts.get(String(args.draft_id));
        if (!draft) throw new Error('Requested entity was not found.');
        drafts.delete(String(args.draft_id));
        mails.splice(mails.indexOf(draft), 1);
        return { deleted: true };
      },
    },
  ];
  return {
    tools,
    mails,
    deliver(mail: Mail) {
      const stored = store(mail);
      mails.push(stored);
      return stored;
    },
    labels: () => [...userLabels],
    drafts: () => [...drafts.values()],
    sent: () => mails.filter((mail) => mail.labels.includes('SENT')),
    inbox: () => mails.filter((mail) => mail.labels.includes('INBOX')),
    trash: () => mails.filter((mail) => mail.labels.includes('TRASH')),
    labelled: (name: string) => {
      const label = userLabels.find((item) => item.name.toLowerCase() === name.toLowerCase());
      return label ? mails.filter((mail) => mail.labels.includes(label.id)) : [];
    },
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
  const read = (book: (typeof books)[number], range: string, computed = false) => {
    const bare =
      !book.tabs.some((item) => item.name === range.replace(/^'|'$/g, '')) &&
      /^[A-Za-z]{1,3}\d*:[A-Za-z]{1,3}\d*$|^[A-Za-z]{1,3}\d+$/.test(range);
    const [name, cells = ''] = range.includes('!')
      ? range.split(/!(.*)/s)
      : bare
        ? [book.tabs[0].name, range]
        : [range, ''];
    const tab = book.tabs.find((item) => item.name === name.replace(/^'|'$/g, '')) ?? book.tabs[0];
    const rows = computed ? computeTab(book.tabs, tab.name) : tab.rows;
    if (!cells)
      return {
        range: `${tab.name}!A1:${column(Math.max(0, ...tab.rows.map((r) => r.length - 1)))}${tab.rows.length}`,
        values: rows,
      };
    const [from, to = from] = cells.split(':');
    const start = /\d/.test(from) ? parse(from) : { col: parse(`${from}1`).col, row: 0 };
    const end = /\d/.test(to) ? parse(to) : { col: parse(`${to}1`).col, row: tab.rows.length - 1 };
    const values = rows
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
          valueRanges: ranges.map((range) => ({
            ...read(book, range, true),
            majorDimension: 'ROWS',
          })),
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
    {
      slug: 'GOOGLESHEETS_ADD_SHEET',
      description: 'Add a new tab to an existing spreadsheet.',
      inputSchema: obj(
        { spreadsheet_id: str('Spreadsheet ID.'), title: str('Name of the new tab.') },
        ['spreadsheet_id'],
      ),
      write: 'update',
      run(args) {
        const book = find(args.spreadsheet_id);
        const title = String(args.title ?? `Sheet${book.tabs.length + 1}`);
        if (book.tabs.some((tab) => tab.name === title))
          throw new Error(`A sheet with the name "${title}" already exists.`);
        book.tabs.push({ name: title, rows: [] });
        book.modified = now();
        return {
          spreadsheetId: book.id,
          replies: [{ addSheet: { properties: { sheetId: book.tabs.length - 1, title } } }],
        };
      },
    },
    {
      slug: 'GOOGLESHEETS_VALUES_UPDATE',
      description: 'Write a 2D array of values into one A1 range, such as "Tab!B2:D4".',
      inputSchema: obj(
        {
          spreadsheet_id: str('Spreadsheet ID.'),
          range: str('A1 range with the tab name, e.g. "Sheet1!A1:C3".'),
          values: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
          value_input_option: str('RAW or USER_ENTERED.'),
        },
        ['spreadsheet_id', 'range', 'values'],
      ),
      write: 'update',
      run(args) {
        const book = find(args.spreadsheet_id);
        const [name, cells = 'A1'] = String(args.range).includes('!')
          ? String(args.range).split(/!(.*)/s)
          : [book.tabs[0].name, String(args.range)];
        const tab = book.tabs.find((item) => item.name === name.replace(/^'|'$/g, ''));
        if (!tab) throw new Error(`Unable to parse range: ${args.range}`);
        return write(book, tab.name, cells.split(':')[0], args.values ?? []);
      },
    },
    {
      slug: 'GOOGLESHEETS_CLEAR_VALUES',
      description: 'Clear the values in one A1 range, keeping the tab.',
      inputSchema: obj(
        { spreadsheet_id: str('Spreadsheet ID.'), range: str('A1 range, e.g. "Sheet1!A2:D20".') },
        ['spreadsheet_id', 'range'],
      ),
      write: 'update',
      run(args) {
        const book = find(args.spreadsheet_id);
        const { range, values } = read(book, String(args.range));
        const [name, cells = ''] = range.split(/!(.*)/s);
        const first = cells.split(':')[0] || 'A1';
        write(
          book,
          name,
          /\d/.test(first) ? first : `${first}1`,
          values.map((row) => row.map(() => '')),
        );
        return { spreadsheetId: book.id, clearedRange: range };
      },
    },
  ];
  const computed = (title: string, tab: string) => {
    const book = books.find((item) => item.title === title || item.id === title);
    return book ? computeTab(book.tabs, tab) : [];
  };
  return { tools, books, computed };
}

export interface SlackMessage {
  ts?: string;
  user: string;
  text: string;
  at: number;
  threadTs?: string;
  replies?: SlackMessage[];
  reactions?: Array<{ name: string; users: string[] }>;
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
  users: Array<{ id: string; name: string; email?: string }>,
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
  const dm = (userId: string) => {
    const user = users.find((item) => item.id === userId);
    if (!user) throw new Error('user_not_found');
    let conversation = conversations.find((item) => item.kind === 'dm' && item.with === userId);
    if (!conversation) {
      conversation = {
        id: `D${id().slice(0, 8).toUpperCase()}`,
        name: user.name,
        kind: 'dm',
        with: userId,
        messages: [],
      };
      conversations.push(conversation);
    }
    return conversation;
  };
  const find = (channel: unknown) => {
    const key = String(channel ?? '');
    const conversation = conversations.find(
      (item) => item.id === key || item.name === key.replace(/^#/, ''),
    );
    if (conversation) return conversation;
    const user = users.find(
      (item) => item.id === key || item.name.toLowerCase() === key.replace(/^@/, '').toLowerCase(),
    );
    if (user) return dm(user.id);
    throw new Error('channel_not_found');
  };
  const message = (channel: unknown, ts: unknown) => {
    const found = find(channel)
      .messages.flatMap((item) => [item, ...(item.replies ?? [])])
      .find((item) => Number(item.ts) === Number(ts));
    if (!found) throw new Error('message_not_found');
    return found;
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
    ...(message.reactions?.length
      ? {
          reactions: message.reactions.map((item) => ({ ...item, count: item.users.length })),
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
          id: user.id,
          name: user.name,
          real_name: user.name,
          profile: { real_name: user.name, ...(user.email ? { email: user.email } : {}) },
        })),
      }),
    },
    {
      slug: 'SLACK_FIND_USER_BY_EMAIL_ADDRESS',
      description: 'Find a workspace user by their email address.',
      inputSchema: obj({ email: str('Email address.') }, ['email']),
      run(args) {
        const user = [owner, ...users].find(
          (item) => item.email?.toLowerCase() === String(args.email).toLowerCase(),
        );
        if (!user) throw new Error('users_not_found');
        return {
          ok: true,
          user: {
            id: user.id,
            name: user.name,
            real_name: user.name,
            profile: { email: user.email },
          },
        };
      },
    },
    {
      slug: 'SLACK_OPEN_DM',
      description: 'Open or resume a direct message with a user and return its channel ID.',
      inputSchema: obj({ users: str('User ID to message.') }, ['users']),
      run(args) {
        const conversation = dm(String(args.users).split(',')[0].trim());
        return { ok: true, channel: { id: conversation.id } };
      },
    },
    {
      slug: 'SLACK_ADD_REACTION_TO_AN_ITEM',
      description: 'Add an emoji reaction to a message.',
      inputSchema: obj(
        {
          name: str('Emoji name without colons, e.g. "thumbsup".'),
          channel: str('Channel ID of the message.'),
          timestamp: str('ts of the message.'),
        },
        ['name', 'channel', 'timestamp'],
      ),
      write: 'update',
      run(args) {
        const target = message(args.channel, args.timestamp);
        const name = String(args.name).replace(/:/g, '');
        const reactions = (target.reactions ??= []);
        const existing = reactions.find((item) => item.name === name);
        if (existing?.users.includes(owner.id)) throw new Error('already_reacted');
        if (existing) existing.users.push(owner.id);
        else reactions.push({ name, users: [owner.id] });
        return { ok: true };
      },
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
        const person = (value: string) => {
          const key = value.replace(/^<?@/, '').replace(/>$/, '').toLowerCase();
          return [owner, ...users].find(
            (user) =>
              user.id.toLowerCase() === key ||
              user.name.toLowerCase() === key ||
              user.name.toLowerCase().split(/\s+/)[0] === key,
          );
        };
        const from = terms.find((term) => term.startsWith('from:'))?.slice(5);
        const sender = from ? person(from) : undefined;
        const words = terms.filter((term) => term && !term.includes(':'));
        const has = (text: string, word: string) => {
          const mentioned = person(word);
          return (
            text.includes(word.replace(/^@/, '')) ||
            Boolean(mentioned && text.includes(`<@${mentioned.id.toLowerCase()}>`))
          );
        };
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
                  .filter(
                    (message) =>
                      (!from || message.user === sender?.id) &&
                      words.every((word) => has(message.text.toLowerCase(), word)),
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
  recurrence?: string[];
  allDay?: boolean;
}

function wallTime(value: unknown, timeZone: string) {
  const text = String(value ?? '').trim();
  if (!text) return NaN;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) || !/^\d{4}-\d{2}-\d{2}/.test(text))
    return Date.parse(text);
  const [date, time = '00:00:00'] = text.split(/[T ]/);
  const [year, month, day] = date.split('-').map(Number);
  const [hour = 0, minute = 0, second = 0] = time.split(':').map(Number);
  const wanted = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(wanted)
      .map((part) => [part.type, Number(part.value)]),
  );
  const seen = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return wanted - (seen - wanted);
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
    start: event.allDay
      ? { date: new Date(event.start).toISOString().slice(0, 10) }
      : { dateTime: iso(event.start), timeZone },
    end: event.allDay
      ? { date: new Date(event.end).toISOString().slice(0, 10) }
      : { dateTime: iso(event.end), timeZone },
    attendees: (event.attendees ?? []).map((email) => ({ email, responseStatus: 'needsAction' })),
    ...(event.recurrence?.length ? { recurrence: event.recurrence } : {}),
    htmlLink: `https://www.google.com/calendar/event?eid=${event.id}`,
  });
  const emails = (value: unknown) =>
    [value ?? []]
      .flat()
      .map((item) =>
        item && typeof item === 'object' ? String((item as Args).email ?? '') : String(item),
      )
      .filter(Boolean);
  const between = (args: Args) => {
    const min = wallTime(args.timeMin ?? args.time_min, timeZone);
    const max = wallTime(args.timeMax ?? args.time_max, timeZone);
    const text = String(args.q ?? args.query ?? '').toLowerCase();
    return events
      .filter(
        (event) =>
          (Number.isNaN(min) || event.end > min) && (Number.isNaN(max) || event.start < max),
      )
      .filter(
        (event) =>
          !text ||
          `${event.summary} ${event.description ?? ''} ${event.location ?? ''} ${(event.attendees ?? []).join(' ')}`
            .toLowerCase()
            .includes(text),
      )
      .sort((a, b) => a.start - b.start)
      .slice(0, Number(args.maxResults ?? args.max_results ?? 250));
  };
  const find = (eventId: unknown) => {
    const event = events.find((item) => item.id === eventId);
    if (!event) throw new Error('Requested event was not found.');
    return event;
  };
  const tools: Tool[] = [
    {
      slug: 'GOOGLECALENDAR_EVENTS_LIST',
      description: 'List events from a calendar between timeMin and timeMax (RFC3339).',
      inputSchema: obj({
        calendarId: str('Calendar ID, "primary" for the main calendar.'),
        timeMin: str('Lower bound (RFC3339).'),
        timeMax: str('Upper bound (RFC3339).'),
        q: str('Free text to match in the title, description, location or attendees.'),
        maxResults: num('Maximum events.'),
        singleEvents: { type: 'boolean' },
        orderBy: str('startTime or updated.'),
      }),
      run: (args) => ({ kind: 'calendar#events', timeZone, items: between(args).map(view) }),
    },
    {
      slug: 'GOOGLECALENDAR_FIND_EVENT',
      description: 'Find events by text in a time window.',
      inputSchema: obj({
        query: str('Text to find in the title, description, location or attendees.'),
        time_min: str('Lower bound (RFC3339).'),
        time_max: str('Upper bound (RFC3339).'),
        max_results: num('Maximum events.'),
        calendar_id: str('Calendar ID, primary by default.'),
      }),
      run: (args) => ({ event_data: { event_data: between(args).map(view) } }),
    },
    {
      slug: 'GOOGLECALENDAR_FIND_FREE_SLOTS',
      description:
        'Find busy and free periods of the primary calendar between time_min and time_max.',
      inputSchema: obj({
        time_min: str('Start of the window (RFC3339).'),
        time_max: str('End of the window (RFC3339).'),
        timezone: str('IANA time zone for the result.'),
        items: list({ type: 'string' }, 'Calendar IDs, primary by default.'),
      }),
      run(args) {
        const min = wallTime(args.time_min, timeZone);
        const max = wallTime(args.time_max, timeZone);
        if (Number.isNaN(min) || Number.isNaN(max) || max <= min)
          throw new Error('time_min and time_max must form a valid window.');
        const busy = events
          .filter((event) => !event.allDay && event.end > min && event.start < max)
          .map((event) => ({ start: Math.max(event.start, min), end: Math.min(event.end, max) }))
          .sort((a, b) => a.start - b.start);
        const merged: Array<{ start: number; end: number }> = [];
        for (const period of busy) {
          const last = merged.at(-1);
          if (last && period.start <= last.end) last.end = Math.max(last.end, period.end);
          else merged.push({ ...period });
        }
        const free: Array<{ start: number; end: number }> = [];
        let cursor = min;
        for (const period of merged) {
          if (period.start > cursor) free.push({ start: cursor, end: period.start });
          cursor = Math.max(cursor, period.end);
        }
        if (cursor < max) free.push({ start: cursor, end: max });
        const span = (item: { start: number; end: number }) => ({
          start: iso(item.start),
          end: iso(item.end),
        });
        return {
          calendars: { primary: { busy: merged.map(span), free: free.map(span) } },
          timezone: timeZone,
        };
      },
    },
    {
      slug: 'GOOGLECALENDAR_CREATE_EVENT',
      description:
        'Create a calendar event. Times without an offset are read in the timezone argument, or the calendar time zone.',
      inputSchema: obj(
        {
          summary: str('Event title.'),
          start_datetime: str('Start, e.g. 2026-10-20T15:00:00.'),
          end_datetime: str('End. Use this or the duration.'),
          event_duration_hour: num('Duration hours.'),
          event_duration_minutes: num('Duration in minutes.'),
          timezone: str('IANA time zone of the start and end, e.g. Europe/Madrid.'),
          attendees: { type: 'array', items: { type: 'string' } },
          location: str('Location.'),
          description: str('Description.'),
          recurrence: list({ type: 'string' }, 'RRULE lines, e.g. "RRULE:FREQ=WEEKLY;BYDAY=TU".'),
        },
        ['summary', 'start_datetime'],
      ),
      write: 'create',
      run(args) {
        const zone = String(args.timezone ?? timeZone);
        const start = wallTime(args.start_datetime, zone);
        const minutes =
          Number(args.event_duration_hour ?? 0) * 60 + Number(args.event_duration_minutes ?? 0);
        const end = args.end_datetime
          ? wallTime(args.end_datetime, zone)
          : start + (minutes || 60) * 60_000;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
          throw new Error('The event needs a valid start and end time.');
        const event = {
          id: id(),
          summary: String(args.summary),
          start,
          end,
          attendees: emails(args.attendees),
          location: args.location,
          description: args.description,
          recurrence: args.recurrence ? [args.recurrence].flat().map(String) : undefined,
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
          timezone: str('IANA time zone of times without an offset.'),
          summary: str('New title.'),
          location: str('New location.'),
          description: str('New description.'),
          attendees: list({ type: 'string' }, 'The full new attendee list.'),
        },
        ['event_id'],
      ),
      write: 'update',
      run(args) {
        const event = find(args.event_id);
        const zone = String(args.timezone ?? timeZone);
        const startValue = args.start_datetime ?? args.start_time;
        const endValue = args.end_datetime ?? args.end_time;
        const start = startValue === undefined ? event.start : wallTime(startValue, zone);
        const end =
          endValue === undefined
            ? startValue === undefined
              ? event.end
              : start + (event.end - event.start)
            : wallTime(endValue, zone);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
          throw new Error('The event needs a valid start and end time.');
        Object.assign(event, {
          start,
          end,
          ...(args.summary === undefined ? {} : { summary: String(args.summary) }),
          ...(args.location === undefined ? {} : { location: String(args.location) }),
          ...(args.description === undefined ? {} : { description: String(args.description) }),
          ...(args.attendees === undefined ? {} : { attendees: emails(args.attendees) }),
        });
        return view(event);
      },
    },
    {
      slug: 'GOOGLECALENDAR_DELETE_EVENT',
      description: 'Delete an event from the calendar by its ID.',
      inputSchema: obj(
        {
          event_id: str('Event ID.'),
          calendar_id: str('Calendar ID, primary by default.'),
          send_updates: str('all, externalOnly or none.'),
        },
        ['event_id'],
      ),
      write: 'delete',
      run(args) {
        const event = find(args.event_id);
        events.splice(events.indexOf(event), 1);
        return { deleted: true, event_id: event.id };
      },
    },
  ];
  return { tools, events, view };
}

const services: Record<string, { service: IntegrationService; name: string }> = {
  GMAIL: { service: 'gmail', name: 'Gmail' },
  GOOGLESHEETS: { service: 'googlesheets', name: 'Google Sheets' },
  SLACK: { service: 'slack', name: 'Slack' },
  GOOGLECALENDAR: { service: 'googlecalendar', name: 'Google Calendar' },
  GOOGLEDRIVE: { service: 'googledrive', name: 'Google Drive' },
  GOOGLEDOCS: { service: 'googledocs', name: 'Google Docs' },
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
  drive?: ReturnType<typeof drive>;
  docs?: ReturnType<typeof docs>;
  notion?: ReturnType<typeof notion>;
  linear?: ReturnType<typeof linear>;
  uploads: Array<{ at: number; action: string; name: string; mimeType: string; bytes: Buffer }>;
  remote: Array<{ service: IntegrationService; host: string; site: Site }>;
}

export function createApps(
  owner: Person,
  parts: Pick<
    AppsWorld,
    'gmail' | 'sheets' | 'slack' | 'calendar' | 'drive' | 'docs' | 'notion' | 'linear'
  >,
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
  add(parts.drive?.tools);
  add(parts.docs?.tools);
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
    uploads: [],
    remote: [],
    services: [...byService.keys()],
    provider: undefined as never,
  };
  for (const [service, host, name, tools] of [
    ['notion', 'mcp.notion.com', 'Notion', parts.notion?.tools],
    ['linear', 'mcp.linear.app', 'Linear', parts.linear?.tools],
  ] as const)
    if (tools)
      world.remote.push({ service, host, site: remoteMcp({ host, name, tools, recorder: world }) });
  world.provider = {
    id: 'eval-apps',
    configured: true,
    supportedServices: [...byService.keys()],
    webhooksConfigured: false,
    supportsSubscriptions: [],
    activity: Object.fromEntries(
      (['gmail', 'googlecalendar'] as const).map((service) => [
        service,
        {
          async read(
            accountId: string,
            input: Omit<ObservationQuery, 'revision'>,
            signal: AbortSignal,
          ) {
            signal.throwIfAborted();
            if (accounts.get(accountId)?.service !== service || !accounts.get(accountId)?.active)
              throw new Error('This synthetic account is unavailable.');
            const hash = (value: unknown) =>
              createHash('sha256').update(JSON.stringify(value)).digest('hex');
            const offset = input.cursor ? Number(input.cursor) : 0;
            if (!Number.isSafeInteger(offset) || offset < 0)
              throw new Error('Invalid fixture cursor.');
            const asOf = input.asOf ? Date.parse(input.asOf) : Date.now();
            const page = <T>(ids: T[]) => ({
              selected: input.ids ? ids : ids.slice(offset, offset + 20),
              more: !input.ids && ids.length > offset + 20,
            });
            if (service === 'gmail') {
              const mails = (world.gmail?.mails ?? []).filter(
                (mail) => !mail.labels.some((label) => ['DRAFT', 'TRASH', 'SPAM'].includes(label)),
              );
              const after = Math.max(
                asOf - 30 * 86400000,
                input.since ? Date.parse(input.since) : 0,
              );
              const latest = new Map<string, number>();
              for (const mail of mails)
                if (mail.at >= after && mail.at <= asOf)
                  latest.set(mail.threadId, Math.max(latest.get(mail.threadId) ?? 0, mail.at));
              const { selected, more } = page(
                input.ids ?? [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id),
              );
              return {
                records: selected.map((id) => {
                  const thread = mails
                    .filter((mail) => mail.threadId === id)
                    .sort((a, b) => a.at - b.at);
                  return {
                    id,
                    version: hash(thread),
                    available: thread.length > 0,
                    url: `https://mail.google.com/mail/u/0/#all/${id}`,
                    data: thread.length
                      ? {
                          truncated: !input.ids || thread.length > 8,
                          messages: thread.slice(input.ids ? -8 : -1).map((mail) => ({
                            id: mail.id,
                            from: mail.from,
                            to: mail.to,
                            subject: mail.subject,
                            receivedAt: new Date(mail.at).toISOString(),
                            sent: mail.labels.includes('SENT'),
                            text: input.ids ? mail.body.slice(0, 8000) : mail.body.slice(0, 200),
                            truncated: !input.ids || mail.body.length > 8000,
                          })),
                        }
                      : {},
                  };
                }),
                ...(more ? { nextCursor: String(offset + 20) } : {}),
              };
            }
            const day = Date.parse(new Date(asOf).toISOString().slice(0, 10));
            const events = world.calendar?.events ?? [];
            const { selected, more } = page(
              input.ids ??
                events
                  .filter(
                    (event) => event.end > day - 86400000 && event.start < day + 31 * 86400000,
                  )
                  .sort((a, b) => a.start - b.start)
                  .map((event) => event.id),
            );
            return {
              records: selected.map((id) => {
                const event = events.find((event) => event.id === id);
                const {
                  id: _,
                  status,
                  summary,
                  description,
                  location,
                  start,
                  end,
                  organizer,
                  attendees,
                } = event ? world.calendar!.view(event) : ({} as Record<string, never>);
                return {
                  id,
                  version: hash(event ?? null),
                  available: Boolean(event),
                  data: event
                    ? {
                        id,
                        status,
                        summary,
                        description,
                        location,
                        start,
                        end,
                        organizer,
                        attendees,
                      }
                    : {},
                };
              }),
              ...(more ? { nextCursor: String(offset + 20) } : {}),
            };
          },
        },
      ]),
    ),
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
        async upload(action, file) {
          const bytes = Buffer.from(file.bytes);
          if (!bytes.byteLength) throw new Error('The file size is unsupported.');
          world.uploads.push({
            at: Date.now(),
            action,
            name: file.name,
            mimeType: file.mimeType,
            bytes,
          });
          return storeUpload({ name: file.name, mimeType: file.mimeType, bytes });
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
    async sentEmails(accountId) {
      if (accounts.get(accountId)?.service !== 'gmail') return [];
      return (world.gmail?.mails ?? [])
        .filter(
          (mail) =>
            mail.labels.includes('SENT') &&
            !['DRAFT', 'TRASH', 'SPAM'].some((label) => mail.labels.includes(label)),
        )
        .sort((a, b) => b.at - a.at)
        .slice(0, 30)
        .map((mail) => ({
          from: addresses(mail.from)[0],
          to: [mail.to, mail.cc].filter(Boolean).flatMap(addresses),
          automated: mail.automated ?? false,
          text: mail.body,
        }));
    },
    async inboxSnippets(accountId) {
      if (accounts.get(accountId)?.service !== 'gmail') return [];
      return (world.gmail?.mails ?? [])
        .filter(
          (mail) =>
            mail.labels.includes('INBOX') &&
            !mail.labels.some((label) => /^CATEGORY_(PROMOTIONS|SOCIAL|FORUMS)$/.test(label)) &&
            Date.now() - mail.at < 14 * 86_400_000,
        )
        .sort((a, b) => b.at - a.at)
        .slice(0, 15)
        .map((mail) => ({ subject: mail.subject, snippet: mail.body.slice(0, 200) }));
    },
    async verificationEmails(accountId, query) {
      if (accounts.get(accountId)?.service !== 'gmail') return [];
      return (world.gmail?.mails ?? [])
        .filter(
          (mail) =>
            mail.labels.includes('INBOX') &&
            mail.at >= query.after &&
            mail.at <= query.before &&
            addresses(mail.to).includes(query.recipient),
        )
        .map((mail) => {
          const sender = addresses(mail.from)[0];
          return {
            id: mail.id,
            receivedAt: mail.at,
            sender,
            recipients: addresses(mail.to),
            authenticatedDomain: sender.split('@')[1] ?? '',
            text: mail.body,
          };
        })
        .filter((mail) => mail.authenticatedDomain.endsWith(query.senderDomain));
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
