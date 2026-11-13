import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import pg from 'pg';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { ProductAnalytics } from '../src/ports/analytics.ts';
import type { MemoryCurator } from '../src/ports/memory-curator.ts';
import { createAnalytics, snapshotAnalytics } from '../src/server/analytics.ts';
import {
  accessCookie,
  accessKey,
  credentialRequestKey,
  registerLocalAccess,
} from '../src/server/access.ts';
import { appConfirmation } from '../src/ports/agent.ts';
import type { ApprovalDescription, ApprovalExecutionContext } from '../src/server/approvals.ts';
import { serverNetwork } from '../src/server/network.ts';
import {
  approvalContent,
  approvalTitle,
  gmailDraftTarget,
  gmailMessageTarget,
} from '../src/server/action-presentation.ts';
import { createCommunication } from '../src/server/communication.ts';
import { ApprovalCard, ApprovalChoiceCard } from '../src/web/components/action-card.tsx';
import { createE2eCurators } from '../scripts/e2e-curators.ts';
import { createPiMemoryCurator } from '../src/providers/pi/memory-curator.ts';

function markdownNodes(markdown: string) {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const nodes: Array<{ type: string; children?: unknown[]; value?: string }> = [];
  const collect = (node: (typeof nodes)[number]) => {
    nodes.push(node);
    for (const child of node.children ?? []) collect(child as (typeof nodes)[number]);
  };
  collect(tree);
  return nodes;
}

function visibleMarkdownText(markdown: string) {
  return markdownNodes(markdown)
    .filter((node) => node.type === 'text' || node.type === 'inlineCode')
    .map((node) => node.value)
    .join('');
}

test('cancellation approval shows distinct approval and refusal controls', () => {
  type Node = DefaultTreeAdapterMap['node'];
  const label = (node: Node): string => {
    if ('attrs' in node && node.attrs.some((attribute) => attribute.name === 'aria-hidden'))
      return '';
    if ('value' in node) return node.value;
    return 'childNodes' in node ? node.childNodes.map(label).join('') : '';
  };
  for (const title of ['Cancel', 'Cancel booking']) {
    const approval = {
      id: 'synthetic-approval',
      state: 'pending' as const,
      title,
      app: '',
      slug: '',
    };
    for (const Component of [ApprovalChoiceCard, ApprovalCard]) {
      const html = renderToStaticMarkup(
        createElement(Component, {
          approval,
          children: createElement('span', null, `${title}?`),
        }),
      );
      const buttons: string[] = [];
      const visit = (node: Node) => {
        if ('tagName' in node && node.tagName === 'button') buttons.push(label(node).trim());
        if ('childNodes' in node) node.childNodes.forEach(visit);
      };
      visit(parseFragment(html));
      assert.equal(buttons.length, 2);
      assert.equal(new Set(buttons).size, 2);
      assert.ok(buttons.includes('No'));
    }
  }
});

test('confirmation repairs rejected wording against the unchanged saved action', async () => {
  const proposal: ApprovalDescription = {
    turn: { threadId: 'synthetic-thread', turnId: 'synthetic-turn' },
    action: 'GMAIL_FETCH_EMAILS',
    args: { query: 'Synthetic receipts' },
  };
  for (const mode of [
    'wrong_action',
    'wrong_label',
    'format',
    'invalid_review',
    'rejected',
  ] as const) {
    let drafts = 0;
    let checks = 0;
    const expected = { question: 'Search Gmail for Synthetic receipts?', action: 'Search Gmail' };
    const communication = createCommunication({
      pool: { query: async () => ({ rows: [] }) } as unknown as pg.Pool,
      ownerId: 'synthetic-owner',
      review: async (_instructions, input) => {
        const request = input as Record<string, any>;
        assert.deepEqual(request.data.args, proposal.args);
        assert.equal(request.data.action, proposal.action);
        if (request.purpose === 'confirmation_review') {
          checks++;
          assert.equal(request.repair, undefined);
          if (mode === 'invalid_review' && checks === 1) return { valid: 'true' };
          return request.text === expected.question &&
            request.action === expected.action &&
            mode !== 'rejected'
            ? { valid: true }
            : {
                valid: false,
                reason: 'The question or label describes sending instead of searching.',
              };
        }
        drafts++;
        request.data.args.query = 'A mutated draft must not change the saved action';
        if (drafts === 1) {
          if (mode === 'format') return { text: expected.question };
          if (mode === 'wrong_action' || mode === 'rejected')
            return { text: 'Send the receipts?', action: 'Send email' };
          if (mode === 'wrong_label') return { text: expected.question, action: 'Send email' };
          return { text: expected.question, action: expected.action };
        }
        assert.ok(request.repair.issue);
        return { text: expected.question, action: expected.action };
      },
    });
    if (mode === 'rejected')
      await assert.rejects(communication.describe(proposal), /sending instead of searching/);
    else assert.deepEqual(await communication.describe(proposal), expected);
    assert.equal(drafts, 2);
    assert.equal(checks, mode === 'format' ? 1 : 2);
    assert.deepEqual(proposal.args, { query: 'Synthetic receipts' });
  }
});

test('browser confirmation uses the page as context without displaying its action data', async () => {
  const question =
    'Can I submit order SYNTHETIC-42 to the ticket shop to check whether these tickets can be cancelled?';
  let calls = 0;
  const communication = createCommunication({
    pool: { query: async () => ({ rows: [] }) } as unknown as pg.Pool,
    ownerId: 'synthetic-owner',
    review: async (_instructions, input) => {
      calls++;
      const request = input as Record<string, any>;
      assert.equal(
        request.data.details.pageText,
        'Enter your order number to check ticket cancellation.',
      );
      assert.deepEqual(request.data.args.typedOnPage, ['SYNTHETIC-42']);
      assert.equal(request.data.args.connectionId, undefined);
      assert.equal(request.data.details.verifiedBinding, undefined);
      assert.equal(request.data.args.api_key, '[redacted]');
      assert.ok(request.withheld.includes('args.api_key'));
      if (request.purpose === 'confirmation_review') {
        assert.equal(
          visibleMarkdownText(request.text),
          question + ' Some details are hidden. This description is incomplete.',
        );
        assert.equal(request.action, 'Submit to the ticket shop');
        return { valid: true };
      }
      return {
        text: question + ' Some details are hidden. This description is incomplete.',
        action: 'Submit to the ticket shop',
      };
    },
  });
  const result = await communication.describe({
    turn: { threadId: 'synthetic-thread', turnId: 'synthetic-turn' },
    action: 'NOD_browser',
    args: {
      website: 'https://tickets.example.test',
      step: 'click',
      control: [{ role: 'button', name: 'Submit' }],
      typedOnPage: ['SYNTHETIC-42'],
      command: { action: 'click', selector: '@e17' },
      connectionId: 'synthetic-private-connection',
      api_key: 'synthetic-secret',
    },
    details: {
      pageText: 'Enter your order number to check ticket cancellation.',
      verifiedBinding: 'synthetic-private-binding',
    },
  });
  assert.equal(calls, 2);
  assert.doesNotMatch(
    result.question,
    /NOD_browser|@e17|Entered values|synthetic-secret|private-binding/,
  );
});

test('browser upload wording omits the private workspace path', async () => {
  const command = {
    action: 'upload',
    selector: '@e3',
    path: '/workspace/private/report.pdf',
  };
  const proposal: ApprovalDescription = {
    turn: { threadId: 'synthetic-thread', turnId: 'synthetic-turn' },
    action: 'NOD_browser',
    args: {
      website: 'https://files.example.test',
      page: 'https://files.example.test/upload',
      target: 'synthetic-opaque-page-id',
      step: 'upload',
      file: 'report.pdf',
      command,
    },
    details: { pageText: 'Choose a file to upload.' },
  };
  let calls = 0;
  const communication = createCommunication({
    pool: { query: async () => ({ rows: [] }) } as unknown as pg.Pool,
    ownerId: 'synthetic-owner',
    review: async (_instructions, input) => {
      calls++;
      const request = input as Record<string, any>;
      assert.equal(request.data.args.file, 'report.pdf');
      assert.equal(request.data.args.target, undefined);
      assert.equal(request.data.args.command.path, undefined);
      assert.equal(request.data.args.command.selector, undefined);
      assert.equal(request.data.args.command.action, 'upload');
      if (request.purpose === 'confirmation_review') return { valid: true };
      return { text: 'Can I upload report.pdf to files.example.test?', action: 'Upload report' };
    },
  });
  const result = await communication.describe(proposal);
  assert.equal(calls, 2);
  assert.match(visibleMarkdownText(result.question), /upload report\.pdf to files\.example\.test/);
  assert.doesNotMatch(result.question, /\/workspace\/private/);
  assert.equal(proposal.args.target, 'synthetic-opaque-page-id');
  assert.deepEqual(proposal.args.command, command);
});

test('confirmation stops on cancellation and refuses an unverified question', async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController();
    const communication = createCommunication({
      pool: { query: async () => ({ rows: [] }) } as unknown as pg.Pool,
      ownerId: 'synthetic-owner',
      review: async (_instructions, input) => {
        if ((input as { purpose: string }).purpose === 'confirmation_review') {
          if (cancel) controller.abort(new Error('Synthetic stop'));
          return { valid: 'true' };
        }
        return { text: 'Submit the synthetic request?', action: 'Submit request' };
      },
    });
    await assert.rejects(
      communication.describe(
        {
          turn: { threadId: 'synthetic-thread', turnId: 'synthetic-turn' },
          action: 'SYNTHETIC_ACTION',
          args: {},
        },
        controller.signal,
      ),
      cancel ? /Synthetic stop/ : /did not return a valid verdict/,
    );
    assert.throws(
      () => communication.present(null, { kind: 'confirmation' }),
      /saved action description/,
    );
  }
});

test('confirmation reviews the text after private links and direction controls are removed', async () => {
  const marker = String.fromCharCode(0x202e);
  const joiner = String.fromCharCode(0x200d);
  const nonJoiner = String.fromCharCode(0x200c);
  const communication = createCommunication({
    pool: { query: async () => ({ rows: [] }) } as unknown as pg.Pool,
    ownerId: 'synthetic-owner',
    review: async (_instructions, input) => {
      const request = input as Record<string, any>;
      if (request.purpose === 'confirmation_review') {
        assert.equal(request.text.includes(marker), false);
        assert.equal(request.text.includes('/vault/synthetic-private'), false);
        assert.ok(visibleMarkdownText(request.text).includes('\\u{202e}'));
        assert.ok(request.text.includes(joiner));
        assert.ok(request.text.includes(nonJoiner));
        return { valid: true };
      }
      return {
        text: `Submit the synthetic request ${marker} ${joiner}joined ${nonJoiner}Persian /vault/synthetic-private?`,
        action: 'Submit request',
      };
    },
  });
  const result = await communication.describe({
    turn: { threadId: 'synthetic-thread', turnId: 'synthetic-turn' },
    action: 'SYNTHETIC_ACTION',
    args: {},
  });
  assert.doesNotMatch(result.question, /(?![\u200c\u200d])\p{Cf}/u);
  assert.ok(result.question.includes(joiner));
  assert.ok(result.question.includes(nonJoiner));
  assert.doesNotMatch(result.question, /synthetic-private/);
});

test('confirmation keeps copied page links visible without making them active', async () => {
  const pageText =
    'Authorize payment [review](https://outside.example.test), https://outside.example.test, and www.outside.example.test';
  let reviewedText = '';
  const communication = createCommunication({
    pool: { query: async () => ({ rows: [] }) } as unknown as pg.Pool,
    ownerId: 'synthetic-owner',
    review: async (_instructions, input) => {
      if ((input as { purpose: string }).purpose === 'confirmation_review') {
        reviewedText = (input as { text: string }).text;
        return { valid: true };
      }
      return {
        text: `Can I click “Authorize payment” at bank.example.test? The page says ${pageText}.`,
        action: 'Click “Authorize payment”',
      };
    },
  });
  const result = await communication.describe({
    turn: { threadId: 'synthetic-thread', turnId: 'synthetic-turn' },
    action: 'NOD_browser',
    args: {
      website: 'https://bank.example.test',
      step: 'click',
      control: [{ role: 'button', name: 'Authorize payment' }],
    },
    details: { pageText },
  });
  assert.equal(reviewedText, result.question);
  const nodes = markdownNodes(result.question);
  const visibleText = visibleMarkdownText(result.question);
  assert.match(visibleText, /Authorize payment/);
  assert.match(visibleText, /bank\.example\.test/);
  assert.match(visibleText, /outside\.example\.test/);
  assert.equal(
    nodes.some((node) => node.type === 'link' || node.type === 'html'),
    false,
  );
});

test('Gmail deletion names verified identity without model wording', async () => {
  const communication = createCommunication({
    pool: { query: async () => ({ rows: [] }) } as unknown as pg.Pool,
    ownerId: 'synthetic-owner',
    review: async () => {
      throw new Error('Permanent Gmail deletion must not depend on model wording.');
    },
  });
  const subject = 'Synthetic [review](https://outside.example.test) <b>today</b>';
  for (const proposal of [
    {
      turn: { threadId: 'synthetic-thread', turnId: 'synthetic-turn' },
      action: 'GMAIL_DELETE_MESSAGE',
      args: { message_id: 'synthetic-message-id' },
      details: {
        account: { name: 'Gmail', identity: 'owner@example.test' },
        target: { subject, from: 'alex@example.test' },
      },
      work: { kind: 'task' as const, title: 'Synthetic account cleanup /vault/synthetic-private' },
    },
    {
      turn: { threadId: 'synthetic-thread', turnId: 'synthetic-turn' },
      action: 'GMAIL_DELETE_DRAFT',
      args: { draft_id: 'synthetic-draft-id' },
      details: {
        account: { name: 'Gmail', identity: 'owner@example.test' },
        target: { subject, to: 'cleanup@example.test' },
      },
      work: {
        kind: 'schedule' as const,
        title: 'Synthetic draft cleanup [review](https://outside.example.test)',
        waitsForAnswer: true as const,
      },
    },
  ]) {
    const result = await communication.describe(proposal);
    assert.match(result.question, /permanently delete/i);
    assert.match(result.question, /owner@example\.test/);
    assert.match(result.question, /Synthetic \[review\]/);
    const visibleText = visibleMarkdownText(result.question);
    assert.match(visibleText, /Synthetic (account|draft) cleanup/);
    assert.doesNotMatch(result.question, /synthetic-private/);
    if (proposal.action === 'GMAIL_DELETE_MESSAGE')
      assert.match(visibleText, /description is incomplete/i);
    if (proposal.action === 'GMAIL_DELETE_DRAFT')
      assert.match(visibleText, /schedule skips its runs until you answer/i);
    assert.match(
      result.question,
      proposal.action === 'GMAIL_DELETE_MESSAGE' ? /alex@example\.test/ : /cleanup@example\.test/,
    );
    assert.doesNotMatch(result.question, /synthetic-message-id|synthetic-draft-id/);
    assert.equal(result.action, approvalTitle(proposal.action).title);
    assert.match(result.action, /^Delete\b/);
    const nodes = markdownNodes(result.question);
    assert.ok(nodes.some((node) => node.type === 'inlineCode' && node.value === subject));
    assert.equal(
      nodes.some((node) => node.type === 'link' || node.type === 'html'),
      false,
    );
  }
  await assert.rejects(
    communication.describe({
      turn: { threadId: 'synthetic-thread', turnId: 'synthetic-turn' },
      action: 'GMAIL_DELETE_MESSAGE',
      args: {},
      details: { account: { name: 'Gmail', identity: 'owner@example.test' } },
    }),
    /identify the Gmail deletion target/,
  );
});

test('payment presentation repairs a missing action label', async () => {
  let calls = 0;
  const communication = createCommunication({
    pool: {} as pg.Pool,
    ownerId: 'synthetic-owner',
    review: async (_instructions, input) => {
      assert.equal((input as { purpose: string }).purpose, 'payment');
      calls++;
      return calls === 1
        ? { text: 'Synthetic payment details.' }
        : { text: 'Synthetic payment details.', action: 'Approve payment' };
    },
  });
  assert.deepEqual(await communication.presentPayment(null, { kind: 'payment' }), {
    question: 'Synthetic payment details.',
    action: 'Approve payment',
  });
  assert.equal(calls, 2);
});

test('Gmail delete target metadata must match the bound message ID', () => {
  const target = gmailMessageTarget(
    {
      successful: true,
      data: {
        id: 'synthetic-message',
        payload: {
          headers: [
            { name: 'Subject', value: 'Northstar review' },
            { name: 'From', value: 'alex@example.test' },
          ],
        },
      },
    },
    'synthetic-message',
  );
  assert.deepEqual(target, {
    messageId: 'synthetic-message',
    subject: 'Northstar review',
    from: 'alex@example.test',
  });
  assert.equal(
    gmailMessageTarget(
      { message: { id: 'another-message', subject: 'Northstar review' } },
      'synthetic-message',
    ),
    undefined,
  );
  assert.equal(
    gmailMessageTarget({ message: { id: 'synthetic-message' } }, 'synthetic-message'),
    undefined,
  );
  const long = gmailMessageTarget(
    {
      message: {
        id: 'synthetic-message',
        subject: 'S'.repeat(350),
        from: 'F'.repeat(360),
        to: 'T'.repeat(360),
      },
    },
    'synthetic-message',
  );
  assert.match(long?.subject ?? '', / \[truncated\]$/);
  assert.match(long?.from ?? '', / \[truncated\]$/);
  assert.match(long?.to ?? '', / \[truncated\]$/);
  assert.ok((long?.subject?.length ?? 0) <= 300);
});

test('Gmail draft target requires the bound draft and its current message', () => {
  const observed = {
    successful: true,
    data: {
      id: 'synthetic-draft',
      message: {
        id: 'synthetic-draft-message',
        payload: {
          headers: [
            { name: 'Subject', value: 'Synthetic team summary' },
            { name: 'To', value: 'cleanup@example.test' },
          ],
        },
      },
    },
  };
  assert.deepEqual(gmailDraftTarget(observed, 'synthetic-draft'), {
    draftId: 'synthetic-draft',
    messageId: 'synthetic-draft-message',
    subject: 'Synthetic team summary',
    to: 'cleanup@example.test',
  });
  assert.deepEqual(
    gmailDraftTarget(
      {
        id: 'synthetic-draft',
        message: {
          id: 'synthetic-draft-message',
          payload: {
            headers: [
              { name: 'Cc', value: 'cc@example.test' },
              { name: 'Bcc', value: 'bcc@example.test' },
            ],
          },
        },
      },
      'synthetic-draft',
    ),
    {
      draftId: 'synthetic-draft',
      messageId: 'synthetic-draft-message',
      cc: 'cc@example.test',
      bcc: 'bcc@example.test',
    },
  );
  assert.equal(gmailDraftTarget(observed, 'another-draft'), undefined);
  assert.equal(
    gmailDraftTarget(
      { data: { id: 'synthetic-draft', message: { subject: 'Synthetic team summary' } } },
      'synthetic-draft',
    ),
    undefined,
  );
  assert.equal(
    gmailDraftTarget(
      {
        id: 'synthetic-draft',
        message: { id: 'synthetic-draft-message', from: 'sender@example.test' },
      },
      'synthetic-draft',
    ),
    undefined,
  );
});

test('server configuration refuses remote exposure without a valid token and an exact secure public origin', () => {
  const key = randomBytes(32).toString('base64url');
  for (const environment of [
    { NOD_HOST: '0.0.0.0' },
    { NOD_HOST: '::' },
    { NOD_HOST: '192.0.2.1' },
    { NOD_PUBLIC_URL: 'https://nod.example' },
    { NOD_AUTH_TOKEN: '' },
    { NOD_AUTH_TOKEN: key.slice(1) },
    { NOD_AUTH_TOKEN: `${key}\n` },
    { NOD_HOST: 'attacker.example', NOD_AUTH_TOKEN: key },
    ...['0', '-1', '65536', '4310.5', 'not-a-port', ''].map((PORT) => ({ PORT })),
  ])
    assert.throws(() => serverNetwork(environment));
  for (const NOD_PUBLIC_URL of [
    '',
    'http://nod.example',
    'http://192.0.2.1:4310',
    'http://127.0.0.2:4310',
    'https://user:password@nod.example',
    'https://nod.example/assistant',
    'https://nod.example?token=secret',
    'https://nod.example#token',
    'https://nod.example/../',
    ' https://nod.example',
    'https://nod.example\n',
    'file:///tmp/nod',
  ])
    assert.throws(() => serverNetwork({ NOD_PUBLIC_URL, NOD_AUTH_TOKEN: key }));
  const remote = serverNetwork({
    PORT: '8080',
    NOD_HOST: '0.0.0.0',
    NOD_PUBLIC_URL: 'https://nod.example:8443/',
    NOD_AUTH_TOKEN: key,
  });
  assert.equal(remote.host, '0.0.0.0');
  assert.equal(remote.port, 8080);
  assert.equal(remote.publicOrigin, 'https://nod.example:8443');
  assert.equal(remote.accessOrigin, remote.publicOrigin);
  assert.equal(remote.authToken, key);
  for (const NOD_PUBLIC_URL of [
    'http://localhost:4310',
    'http://127.0.0.1:4310',
    'http://[::1]:4310',
  ])
    assert.equal(serverNetwork({ NOD_PUBLIC_URL }).publicOrigin, NOD_PUBLIC_URL);
  assert.equal(serverNetwork({}).accessOrigin, undefined);
  assert.equal(serverNetwork({ NOD_DESKTOP: 'true', NOD_AUTH_TOKEN: '' }).authToken, undefined);
});

test('remote access authenticates cookies and bearer clients only on the configured origin and host', async (t) => {
  const key = randomBytes(32).toString('base64url');
  const app = Fastify({ trustProxy: false });
  t.after(() => app.close());
  registerLocalAccess(app, 4310, { key, origin: 'https://nod.example', bearer: true });
  app.get('/api/fixture', async () => ({ private: true }));
  app.post('/api/fixture', async () => ({ private: true }));
  app.post('/api/webhooks/telegram', async () => ({ ok: true }));
  const authorized = { host: 'nod.example', authorization: `Bearer ${key}` };
  for (const method of ['GET', 'POST'] as const) {
    assert.equal(
      (await app.inject({ method, url: '/api/fixture', headers: { host: 'nod.example' } }))
        .statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ method, url: '/api/fixture', headers: authorized })).statusCode,
      200,
    );
  }
  for (const headers of [
    { ...authorized, host: 'localhost:4310' },
    { ...authorized, host: 'attacker.example', 'x-forwarded-host': 'nod.example' },
    { ...authorized, origin: 'http://nod.example' },
    { ...authorized, origin: 'https://attacker.example' },
    { ...authorized, origin: 'https://nod.example/path' },
    { ...authorized, origin: 'https://nod.example/' },
    { ...authorized, origin: 'null' },
    { ...authorized, 'sec-fetch-site': 'cross-site' },
  ])
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/fixture', headers })).statusCode,
      403,
    );
  for (const authorization of ['Bearer wrong', `Basic ${key}`, `Bearer ${key} trailing`])
    assert.equal(
      (
        await app.inject({
          url: '/api/fixture',
          headers: { ...authorized, authorization, cookie: `${accessCookie(4310)}=${key}` },
        })
      ).statusCode,
      401,
    );
  const signedIn = await app.inject({
    method: 'POST',
    url: '/api/access',
    headers: { host: 'nod.example', origin: 'https://nod.example' },
    payload: { key },
  });
  assert.equal(signedIn.statusCode, 204);
  assert.equal(signedIn.body, '');
  const cookie = String(signedIn.headers['set-cookie']);
  assert.match(cookie, /; Secure(?:;|$)/);
  assert.match(cookie, /; HttpOnly(?:;|$)/);
  assert.match(cookie, /; SameSite=Strict(?:;|$)/);
  assert.equal(
    (
      await app.inject({
        url: '/api/fixture',
        headers: { host: 'nod.example', cookie: cookie.split(';')[0]! },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/access',
        headers: { host: 'nod.example', origin: 'https://attacker.example' },
        payload: { key },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/webhooks/telegram',
        headers: { host: 'nod.example' },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/webhooks/telegram',
        headers: { host: 'attacker.example', 'x-forwarded-host': 'nod.example' },
      })
    ).statusCode,
    403,
  );
  const rotated = Fastify();
  t.after(() => rotated.close());
  registerLocalAccess(rotated, 4310, {
    key: randomBytes(32).toString('base64url'),
    origin: 'https://nod.example',
    bearer: true,
  });
  rotated.get('/api/fixture', async () => ({ private: true }));
  for (const headers of [authorized, { host: 'nod.example', cookie: cookie.split(';')[0]! }])
    assert.equal((await rotated.inject({ url: '/api/fixture', headers })).statusCode, 401);
});

test('localhost access requires the owner key and rejects foreign Host, Origin and cross-site requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nod-access-'));
  const app = Fastify();
  try {
    const key = await accessKey(root);
    assert.equal(await accessKey(root), key);
    assert.equal((await stat(join(root, 'access-key'))).mode & 0o777, 0o600);
    await chmod(join(root, 'access-key'), 0o644);
    assert.equal(await accessKey(root), key);
    assert.equal((await stat(join(root, 'access-key'))).mode & 0o777, 0o600);
    const requestKeys = await Promise.all(
      Array.from({ length: 4 }, () => credentialRequestKey(root)),
    );
    assert.equal(new Set(requestKeys).size, 1);
    assert.equal(requestKeys[0] === key, false);
    assert.equal((await stat(join(root, 'credential-request-key'))).mode & 0o777, 0o600);
    registerLocalAccess(app, 4310, { key });
    app.post('/api/fixture', async () => ({ ok: true }));
    app.get('/api/privacy', async () => ({ content: null }));
    const settingsPages = ['/settings', '/settings/models', '/settings/apps', '/settings/memory'];
    for (const path of settingsPages) app.get(path, async () => 'nod');
    app.get('/api/settings', async () => ({ private: true }));
    const navigation = {
      host: 'localhost:4310',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    };
    for (const path of settingsPages) {
      assert.equal((await app.inject({ url: path, headers: navigation })).statusCode, 200);
      assert.equal(
        (await app.inject({ url: path, headers: { ...navigation, 'sec-fetch-mode': 'cors' } }))
          .statusCode,
        403,
      );
    }
    for (const path of ['/settings/unknown', '/settings-typo'])
      assert.equal((await app.inject({ url: path, headers: navigation })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/settings', headers: navigation })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          url: '/api/settings',
          headers: { ...navigation, cookie: `nod-access-4310=${key}` },
        })
      ).statusCode,
      403,
    );
    const cookie = `nod-access-4310=${key}`;
    for (const headers of [
      { host: 'attacker.example:4310', cookie },
      { host: 'localhost:4311', cookie },
      { host: 'localhost:4310', cookie, origin: 'https://attacker.example' },
      { host: 'localhost:4310', cookie, origin: 'null' },
      { host: 'localhost:4310', cookie, origin: 'https://localhost:4310' },
      { host: 'localhost:4310', cookie, 'sec-fetch-site': 'cross-site' },
    ])
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/fixture', headers })).statusCode,
        403,
      );
    for (const headers of [
      { host: 'localhost:4310' },
      { host: 'localhost:4310', origin: 'http://localhost:4310' },
      {
        host: 'localhost:4310',
        cookie: `nod-access-4310=${randomBytes(32).toString('base64url')}`,
      },
      { host: 'localhost:4310', cookie: `nod-access-4311=${key}` },
      { host: 'localhost:4310', cookie: `nod-access-4310=${requestKeys[0]}` },
      { host: 'localhost:4310', 'x-nod-desktop-token': key },
    ])
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/fixture', headers })).statusCode,
        401,
      );
    assert.equal(
      (await app.inject({ url: '/api/privacy', headers: { host: 'localhost:4310' } })).statusCode,
      200,
    );
    const exchange = (candidate: string, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/api/access',
        headers: { host: 'localhost:4310', origin: 'http://localhost:4310', ...headers },
        payload: { key: candidate },
      });
    for (const rejected of [
      await exchange(key.slice(1)),
      await exchange(randomBytes(32).toString('base64url')),
    ]) {
      assert.equal(rejected.statusCode, 401);
      assert.equal(rejected.headers['set-cookie'], undefined);
    }
    assert.equal((await exchange(key, { origin: 'https://attacker.example' })).statusCode, 403);
    const accepted = await exchange(key);
    assert.equal(accepted.statusCode, 204);
    const issued = String(accepted.headers['set-cookie']);
    assert.match(issued, /HttpOnly/);
    assert.match(issued, /SameSite=Strict/);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/fixture',
          headers: { host: 'localhost:4310', cookie: issued.split(';')[0]! },
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('approval cards shorten long recipients and bodies, skip blank bodies and title MCP tools', () => {
  const many = Array.from({ length: 40 }, (_, index) => `person${index}@example.test`);
  const long = approvalContent('GMAIL_SEND_EMAIL', {
    to: many,
    subject: 'Synthetic',
    is_html: true,
    body: `<style>p{color:red}</style><p>Tom &amp; Ann&#39;s <a href="https://example.test/pay">invoice</a></p>${'x'.repeat(5000)}`,
  });
  const shownTo = long.fields![0]!.value;
  const kept = shownTo.split(' and ')[0]!.split(', ');
  assert.deepEqual(kept, many.slice(0, kept.length));
  assert.ok(shownTo.endsWith(` and ${many.length - kept.length} more`));
  assert.ok(long.body!.startsWith("Tom & Ann's invoice (https://example.test/pay)\n"));
  assert.equal(long.bodyCut, true);
  assert.deepEqual(approvalContent('GMAIL_SEND_EMAIL', { to: 'a@example.test', body: 'Hi' }), {
    fields: [{ label: 'To', value: 'a@example.test' }],
    body: 'Hi',
  });
  assert.deepEqual(
    approvalContent('GMAIL_SEND_EMAIL', { to: 'a@example.test', body: '  ', text: 'Hi' }),
    { fields: [{ label: 'To', value: 'a@example.test' }], body: 'Hi' },
  );
  assert.equal(
    approvalContent('GMAIL_SEND_EMAIL', {
      to: 'a@example.test',
      is_html: true,
      body: '<scr<script>x</script>ipt>y</script>Hi there',
    }).body,
    'xipt>yHi there',
  );
  const started = performance.now();
  const nested = approvalContent('GMAIL_SEND_EMAIL', {
    to: 'a@example.test',
    is_html: true,
    body: `Hi${'<scr'.repeat(100_000)}<script></script>${'ipt></script>'.repeat(100_000)}`,
  });
  assert.ok(performance.now() - started < 2000);
  assert.ok(nested.body!.startsWith('Hi'));
  assert.equal(nested.bodyCut, true);
  const filler = '<i></i>'.repeat(2850);
  for (const tail of [
    '<a href="https://example.test/hidden">Pay here now and more words to cross</a>',
    '<style>p{color:red;background:blue;margin:0;padding:0;border:0}</style>',
    '<img alt="synthetic" src="https://example.test/a-long-image-address.png">',
  ]) {
    const crossing = approvalContent('GMAIL_SEND_EMAIL', {
      to: 'a@example.test',
      is_html: true,
      body: `<p>Hi</p>${filler}${tail}`,
    });
    assert.equal(crossing.body, 'Hi');
    assert.equal(crossing.bodyCut, true);
  }
  assert.equal(approvalTitle('mcp__synthetic_server__create_page').title, 'Create page');
  assert.equal(approvalTitle('mcp__synthetic__').title, 'Run an action');
});

test('HTML approval previews show the actual link destination', () => {
  assert.equal(
    approvalContent('GMAIL_SEND_EMAIL', {
      to: 'recipient@example.test',
      is_html: true,
      body: '<noscript><p>Hi</p><a href="https://actual.example.test">Pay here</a></noscript>',
    }).body,
    'Hi\nPay here (https://actual.example.test)',
  );
  for (const [attributes, address] of [
    [
      'data-href="https://safe.example.test" href="https://actual.example.test"',
      'https://actual.example.test',
    ],
    [
      'title=" href=\'https://safe.example.test\' " href="https://actual.example.test"',
      'https://actual.example.test',
    ],
    ['href="https://actual.example.test?a=1&copy=2"', 'https://actual.example.test?a=1&copy=2'],
    ['href="https://actual.example.test?a=1&amp;b=2"', 'https://actual.example.test?a=1&b=2'],
  ]) {
    const preview = approvalContent('GMAIL_SEND_EMAIL', {
      to: 'recipient@example.test',
      is_html: true,
      body: `<p>Hi</p><a ${attributes}>Pay here</a>`,
    });
    assert.equal(preview.body, `Hi\nPay here (${address})`);
  }
  const preview = approvalContent('GMAIL_SEND_EMAIL', {
    to: 'recipient@example.test',
    is_html: true,
    body: `<p>${'x'.repeat(3985)}</p><a href="https://actual.example.test">Pay here</a>`,
  });
  assert.equal(preview.body, 'x'.repeat(3985));
  assert.equal(preview.bodyCut, true);
});

test(
  'approvals preserve explicit-request authority, execute confirmed snapshots once and fence owners',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60_000 },
  async (t) => {
    const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'nod-approvals-')));
    const previousDirectory = process.cwd();
    process.chdir(fixtureRoot);
    t.after(async () => {
      process.chdir(previousDirectory);
      await rm(fixtureRoot, { recursive: true, force: true });
    });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_approvals_${suffix}`;
    const bossSchema = `test_approvals_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = databaseUrl.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const { transaction } = await import('../src/server/transaction.ts');
    const thread = await import('../src/server/thread.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const { createTasks } = await import('../src/server/tasks.ts');
    const artifacts = (await import('../src/server/artifacts.ts')).localArtifacts;
    const { createApp } = await import('../src/server/app.ts');
    const { createApprovals } = await import('../src/server/approvals.ts');
    const { dataRoot, ownerId, port, configuration } = await import('../src/server/config.ts');
    assert.equal(dataRoot, join(fixtureRoot, '.local'));
    let messages: ReturnType<typeof thread.createUserMessageService>;
    const app = await createApp({
      submitMessage: (text, attachments, options) => messages.submit(text, attachments, options),
      configuration: () => configuration({ llmReady: true }),
    });
    const personal = createPersonalService({
      pool: db.pool,
      ownerId,
      scheduler: thread.boss,
      enqueueTurn: thread.enqueueTurn,
      refresh() {},
    });
    const calls: Array<{
      action: string;
      args: Record<string, unknown>;
      context: ApprovalExecutionContext;
    }> = [];
    let failExecution = false;
    let rejectPreflight = false;
    let executionGate: Promise<void> | undefined;
    let executionResult: (() => unknown) | undefined;
    let descriptionFailure = false;
    const defaultDescription = async () => 'Synthetic approval question.';
    let describe: (proposal: ApprovalDescription, signal?: AbortSignal) => Promise<string> =
      defaultDescription;
    const directories: string[] = [];
    let approvals: Awaited<ReturnType<typeof createApprovals>>;
    const headers = {
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
      cookie: `${accessCookie(port)}=${await accessKey(dataRoot)}`,
    };
    const request = (
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: string,
      payload?: unknown,
    ) =>
      app.inject({
        method,
        url,
        headers,
        ...(payload === undefined
          ? {}
          : {
              payload: JSON.stringify(payload),
              headers: { ...headers, 'content-type': 'application/json' },
            }),
      });

    const row = async (turnId: string) =>
      (await db.pool.query('SELECT * FROM turns WHERE id=$1', [turnId])).rows[0];
    const turnStatus = async (turnId: string) => (await row(turnId)).status;
    const running = async (turnId: string) => {
      await db.pool.query("UPDATE turns SET status='running',started_at=now() WHERE id=$1", [
        turnId,
      ]);
      return { threadId: (await thread.activeThread()).id, turnId };
    };
    const begin = async (
      prompt: string,
      options: { channel?: string; source?: 'event' | 'schedule' } = {},
    ) => {
      if (options.source)
        return running(await thread.enqueueTurn(prompt, { source: options.source }));
      const submitted = await thread.submitUserMessage(prompt, [], { channel: options.channel });
      return running(submitted.turnId);
    };
    const finish = (turnId: string, status = 'waiting') =>
      db.pool.query('UPDATE turns SET status=$2,finished_at=now() WHERE id=$1', [turnId, status]);
    const proposal = async (turnId: string) =>
      (await db.pool.query('SELECT * FROM approvals WHERE turn_id=$1', [turnId])).rows[0];
    const assistantMessages = async (turnId: string) =>
      (
        await db.pool.query("SELECT id FROM messages WHERE turn_id=$1 AND role='assistant'", [
          turnId,
        ])
      ).rowCount;
    const confirmTurn = async (turnId: string, text = 'Yes.') => {
      await finish(turnId);
      return messages.submit(text, [], {
        replyToMessageId: (await proposal(turnId)).confirmation_message_id,
      });
    };

    const newTurn = async (status = 'running', text = 'Synthetic boundary fixture') => {
      const submitted = await thread.submitUserMessage(text);
      await db.pool.query('UPDATE turns SET status=$2 WHERE id=$1', [submitted.turnId, status]);
      return submitted;
    };
    const stored = async (id: string) =>
      (await db.pool.query('SELECT * FROM approvals WHERE id=$1', [id])).rows[0];
    async function propose(
      turn: { threadId: string; turnId: string },
      action: string,
      args: Record<string, unknown>,
    ) {
      const result = await approvals.request(turn, action, args);
      assert.ok(result && typeof result === 'object' && appConfirmation in result);
      assert.equal('url' in result, false);
      const record = (
        await db.pool.query(
          'SELECT * FROM approvals WHERE turn_id=$1 AND action=$2 AND args=$3::jsonb',
          [turn.turnId, action, JSON.parse(JSON.stringify(args))],
        )
      ).rows[0];
      assert.ok(record.confirmation_message_id);
      return record.id as string;
    }
    async function confirm(id: string, approved: boolean, extra: Record<string, unknown> = {}) {
      const record = await stored(id);
      const input = {
        text: approved ? 'Yes' : 'No',
        channel: 'web',
        threadId: record.thread_id,
        replyToMessageId: record.confirmation_message_id,
        clientMessageId: randomUUID(),
        ...extra,
      };
      const answer = await approvals.chat.answer(input);
      const result = await transaction(
        (client) => approvals.chat.accept(client, { ...input, answer }),
        db.pool,
      );
      return result;
    }
    async function execute(id: string, signal = new AbortController().signal) {
      const record = await stored(id);
      await db.pool.query("UPDATE turns SET status='running' WHERE id=$1 AND status='queued'", [
        record.execution_turn_id,
      ]);
      return approvals.executeConfirmed(record.execution_turn_id, signal);
    }
    try {
      await db.initializeDatabase();
      await thread.initializeThreads();
      await personal.initialize({ workers: false });
      let answerReply = (reply: string) => trust.answer(reply);
      const approved = await createApprovals(
        async (action, args, context) => {
          calls.push({ action, args, context });
          if (executionGate) await executionGate;
          if (failExecution) throw new Error('Fixture provider detail must not be exposed.');
          if (executionResult) return executionResult();
          return { successful: true, id: 'fixture-provider-result' };
        },
        async () => {
          if (rejectPreflight)
            throw Object.assign(new Error('Fixture account disconnected.'), { statusCode: 409 });
        },
        (reply) => answerReply(reply),
        async (proposal, signal) => {
          if (descriptionFailure) throw new Error('Synthetic confirmation model failure.');
          return describe(proposal, signal);
        },
      );
      const checked = (base: typeof approved): typeof approved => ({
        ...base,
        request: async (turn, action, args, options = {}) =>
          base.request(turn, action, args, {
            ...options,
            allowed: options.allowed ?? !(await trust.check(turn, action, args)).confirm,
          }),
      });
      approvals = checked(approved);
      messages = thread.createUserMessageService({
        confirmAction: approvals.chat,
        taskReply: (client, threadId, messageId) => tasks.resolveReply(client, threadId, messageId),
      });
      personal.registerRoutes(app);
      const tasks = createTasks({ pool: db.pool, ownerId });
      await tasks.initialize();
      tasks.registerRoutes(app);
      app.get('/api/fixture-error', async () => {
        throw new Error('fixture-private-key');
      });

      const { createTrust } = await import('../src/server/trust.ts');
      const reviews: Array<Record<string, any>> = [];
      const prompts: string[] = [];
      let duringReview: () => Promise<void> = async () => {};
      let duringReply: () => Promise<void> = async () => {};
      let aligned:
        | boolean
        | string
        | null
        | ((input: Record<string, any>) => boolean | Record<string, unknown>) = false;
      let ruled = false;
      const cite = (input: Record<string, any>) =>
        input.userMessages?.at(-1)?.text ??
        input.scheduledTaskInstruction ??
        input.standingInstruction ??
        input.userRules ??
        'read';
      t.beforeEach(() => {
        aligned = false;
        ruled = false;
        duringReview = async () => {};
      });
      const replies: object[] = [];
      const replyAnswers: Record<string, string> = {
        yes: 'yes',
        'yes please': 'yes',
        sim: 'yes',
        no: 'no',
        cancel: 'no',
      };
      const trust = createTrust({
        pool: db.pool,
        ownerId,
        review: async (instructions, input) => {
          if ('expiredConfirmation' in input && 'reply' in input)
            return {
              retiredReply:
                input.reply === 'Send the revised synthetic report to Bob at bob@example.test.' ||
                input.reply === 'Maybe.'
                  ? 'new'
                  : 'stale',
              probability: input.reply === 'Maybe.' ? 0.5 : 1,
            };
          if ('reply' in input) {
            replies.push(input);
            await duringReply();
            const reply = String(input.reply)
              .replace(/[.!]+$/, '')
              .toLowerCase();
            if (replyAnswers[reply] === 'fail') throw new Error('Synthetic reader outage.');
            return { answer: replyAnswers[reply] ?? 'other' };
          }
          reviews.push(input as Record<string, any>);
          prompts.push(instructions);
          await duringReview();
          const yes =
            typeof aligned === 'function' ? aligned(input as Record<string, any>) : aligned;
          if (yes === null) return null;
          if (yes && typeof yes === 'object') return yes;
          return {
            run: yes,
            ...(yes === true ? { because: cite(input) } : {}),
            ...(ruled ? { rule: true } : {}),
          };
        },
      });
      await t.test(
        'e2e curators classify typed approval replies without a live model',
        async (t) => {
          const original = answerReply;
          t.after(() => {
            answerReply = original;
          });
          const keyless = createPiMemoryCurator({ provider: 'openai' });
          assert.equal(keyless.configured, false);
          const harness = createE2eCurators(
            { provider: 'openai', model: 'gpt-6.1-sol', apiKey: 'synthetic-e2e-key' },
            (options) => ({
              id: options.model ?? 'synthetic-helper',
              configured: true,
              curate: async ({ task, input }) => {
                assert.equal(task, 'review');
                if (options.model !== 'gpt-6.1-sol' || options.lightest !== true) return undefined;
                const reply = (input as { reply?: unknown }).reply;
                return { answer: reply === 'Yes' ? 'yes' : reply === 'No' ? 'no' : 'other' };
              },
            }),
          );
          const reviewer = (curator: MemoryCurator) =>
            createTrust({
              pool: db.pool,
              ownerId,
              review: (instructions, input, signal) =>
                curator.configured
                  ? curator.curate({ task: 'review', instructions, input }, signal)
                  : Promise.resolve(undefined),
            });
          const pending = async (label: string) => {
            const turn = await begin(`Synthetic e2e ${label} confirmation`);
            const id = await propose(turn, 'NOD_notification_preferences_update', {
              notificationRule: `Synthetic e2e ${label}`,
            });
            await finish(turn.turnId);
            return id;
          };
          const keylessTrust = reviewer(keyless);
          const helperTrust = reviewer(harness.classificationCurator);
          const harnessTrust = reviewer(harness.onboardingCurator);
          const callsBefore = calls.length;
          answerReply = (reply) => keylessTrust.answer(reply);
          const beforeYes = await pending('keyless Yes');
          await confirm(beforeYes, true);
          const beforeNo = await pending('keyless No');
          await confirm(beforeNo, false);
          assert.equal((await stored(beforeYes)).status, 'expired');
          assert.equal((await stored(beforeNo)).status, 'expired');
          answerReply = (reply) => helperTrust.answer(reply);
          const wrongModel = await pending('helper Yes');
          await confirm(wrongModel, true);
          assert.equal((await stored(wrongModel)).status, 'expired');
          assert.equal(calls.length, callsBefore);
          answerReply = (reply) => harnessTrust.answer(reply);
          const afterYes = await pending('selected Yes');
          await confirm(afterYes, true);
          assert.equal((await stored(afterYes)).status, 'confirmed');
          await execute(afterYes);
          assert.equal((await stored(afterYes)).status, 'completed');
          assert.equal(calls.length, callsBefore + 1);
          await finish((await stored(afterYes)).execution_turn_id, 'succeeded');
          const afterNo = await pending('selected No');
          await confirm(afterNo, false);
          assert.equal((await stored(afterNo)).status, 'declined');
          assert.equal(calls.length, callsBefore + 1);
          await finish((await stored(afterNo)).execution_turn_id, 'succeeded');
          const afterOther = await pending('selected Maybe');
          await confirm(afterOther, true, { text: 'Maybe' });
          assert.equal((await stored(afterOther)).status, 'expired');
        },
      );
      const compareVerdict = (
        verdict: Awaited<ReturnType<typeof trust.check>>,
        expected: Record<string, unknown>,
      ) => {
        const { chatRevision, ...result } = verdict;
        assert.deepEqual(result, expected);
      };
      const email = (to: string) => ({
        recipient_email: to,
        subject: 'Synthetic update',
        body: 'Synthetic body.',
      });
      const deferred = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => {
          resolve = done;
        });
        return { promise, resolve };
      };
      await t.test(
        'one authorization review preserves the original instructions and executed arguments',
        async () => {
          const turn = await begin(
            'Email Ana at ana@example.test: EUR 1,200, due at the end of November 2026.',
          );
          const args = {
            ...email('ana@example.test'),
            connectionId: randomUUID(),
            body: '1.200,00 EUR, a finales de noviembre de 2026.',
          };
          const original = structuredClone(args);
          const before = calls.length;
          const primary = reviews.length;
          aligned = true;
          try {
            await approvals.request(turn, 'GMAIL_SEND_EMAIL', args);
            assert.equal(reviews.length, primary + 1);
            assert.deepEqual(reviews.at(-1)!.action, {
              name: 'GMAIL_SEND_EMAIL',
              arguments: original,
            });
            assert.equal(calls.length, before + 1);
            assert.deepEqual(calls.at(-1)!.args, original);
            assert.deepEqual(args, original);
            assert.equal(await proposal(turn.turnId), undefined);
          } finally {
            await finish(turn.turnId, 'succeeded');
          }
        },
      );

      await t.test('a quoted permission cannot override a reported term mismatch', async () => {
        const turn = await begin('Email Ana the invoice for EUR 1200.');
        try {
          for (const terms of [
            null,
            {},
            [false],
            [{ user: 'EUR 1200', action: 'EUR 1300', same: false }],
            [{ user: 'EUR 1200', action: 'EUR 1200', same: 'true' }],
          ]) {
            aligned = (input) => ({ run: true, because: cite(input), terms });
            assert.equal(
              (
                await trust.check(turn, 'GMAIL_SEND_EMAIL', {
                  ...email('ana@example.test'),
                  body: 'Invoice EUR 1300.',
                })
              ).confirm,
              true,
            );
          }
          aligned = (input) => ({
            run: true,
            because: cite(input),
            terms: [{ user: 'EUR 1200', action: 'EUR 1200', same: true }],
          });
          assert.equal(
            (
              await trust.check(turn, 'GMAIL_SEND_EMAIL', {
                ...email('ana@example.test'),
                body: 'Invoice EUR 1200.',
              })
            ).confirm,
            false,
          );
        } finally {
          await finish(turn.turnId, 'cancelled');
        }
      });

      await t.test('a stopped turn cannot use an awaited authorization result', async () => {
        for (const status of ['cancelled', 'succeeded']) {
          for (const action of ['GMAIL_SEND_EMAIL', 'GMAIL_FETCH_EMAILS']) {
            const turn = await begin('Send the agreed invoice to ana@example.test.');
            const entered = deferred();
            const release = deferred();
            aligned =
              action === 'GMAIL_FETCH_EMAILS' ? () => ({ run: true, because: 'read' }) : true;
            duringReview = async () => {
              entered.resolve();
              await release.promise;
            };
            const before = calls.length;
            const outcome = approvals.request(turn, action, email('ana@example.test')).then(
              () => undefined,
              (error: unknown) => error,
            );
            await entered.promise;
            await finish(turn.turnId, status);
            release.resolve();
            assert.ok((await outcome) instanceof Error);
            assert.equal(calls.length, before);
            assert.equal(await proposal(turn.turnId), undefined);
          }
        }
      });

      await t.test(
        'owner corrections and changed rules reject stale proposals without asking for them',
        async () => {
          aligned = true;
          const preferences = (
            await db.pool.query(
              'SELECT notification_rule,rules FROM preferences WHERE owner_id=$1',
              [ownerId],
            )
          ).rows[0];
          try {
            for (const change of ['owner', 'rule', 'standing'] as const) {
              await db.pool.query(
                'INSERT INTO preferences(owner_id,notification_rule,rules) VALUES($1,$2,$3) ON CONFLICT(owner_id) DO UPDATE SET notification_rule=EXCLUDED.notification_rule,rules=EXCLUDED.rules',
                [ownerId, 'Email Ana when a synthetic invoice arrives.', ''],
              );
              const turn = await begin(
                'Email Ana the EUR 1,200 invoice.',
                change === 'standing' ? { source: 'event' } : {},
              );
              const entered = deferred();
              const release = deferred();
              duringReview = async () => {
                entered.resolve();
                await release.promise;
              };
              const before = calls.length;
              const outcome = approvals
                .request(turn, 'GMAIL_SEND_EMAIL', email('ana@example.test'))
                .then(
                  () => undefined,
                  (error: unknown) => error,
                );
              await entered.promise;
              if (change === 'owner') {
                const correction = await thread.submitUserMessage(
                  'Correction: do not send that invoice.',
                );
                await finish(correction.turnId, 'cancelled');
              } else {
                await db.pool.query(
                  `UPDATE preferences SET ${change === 'rule' ? 'rules' : 'notification_rule'}=$2 WHERE owner_id=$1`,
                  [ownerId, 'Ask me before sending any invoice.'],
                );
              }
              release.resolve();
              assert.ok((await outcome) instanceof Error);
              assert.equal(calls.length, before);
              assert.equal(await proposal(turn.turnId), undefined);
              await finish(turn.turnId, 'cancelled');
            }
          } finally {
            await db.pool.query(
              'UPDATE preferences SET notification_rule=$2,rules=$3 WHERE owner_id=$1',
              [ownerId, preferences?.notification_rule ?? '', preferences?.rules ?? ''],
            );
          }
          const requestText = 'Email Ana the synthetic invoice.';
          const superseded = await begin(requestText);
          const correction = await thread.submitUserMessage(
            'Correction: do not send that invoice.',
          );
          await finish(correction.turnId, 'cancelled');
          aligned = () => ({ run: true, because: requestText });
          compareVerdict(
            await trust.check(superseded, 'GMAIL_SEND_EMAIL', email('ana@example.test')),
            { confirm: true, reason: 'unrequested' },
          );
          await finish(superseded.turnId, 'cancelled');
        },
      );

      await t.test('an unusable trust check answer is logged with its cause', async () => {
        const { withFailureLog } = await import('../src/server/failure-log.ts');
        const logged: Array<{ event: string; error: unknown }> = [];
        const sink = (event: string, error: unknown) => {
          logged.push({ event, error });
        };
        const unusable = () =>
          logged.filter(({ event }) => event === 'trust_check_unusable').map(({ error }) => error);
        const checkWith = async (turn: Awaited<ReturnType<typeof begin>>) => {
          logged.length = 0;
          const verdict = await withFailureLog(sink, () =>
            trust.check(turn, 'GMAIL_SEND_EMAIL', email('ana@example.test')),
          );
          assert.deepEqual(
            { confirm: verdict.confirm, reason: (verdict as any).reason },
            {
              confirm: true,
              reason: 'unrequested',
            },
          );
        };

        const empty = await begin('Email Ana the synthetic invoice.');
        aligned = null;
        await checkWith(empty);
        assert.deepEqual(unusable(), [{ name: 'TrustCheckUnusable', code: 'no_answer' }]);
        await finish(empty.turnId, 'cancelled');

        const invented = await begin('Email Ana the synthetic invoice.');
        aligned = () => ({ run: true, because: 'Send it to everyone.' });
        await checkWith(invented);
        assert.deepEqual(unusable(), [{ name: 'TrustCheckUnusable', code: 'basis_rejected' }]);
        await finish(invented.turnId, 'cancelled');

        const requestText = 'Email Ana the synthetic invoice.';
        const stale = await begin(requestText);
        const correction = await thread.submitUserMessage('Correction: do not send that invoice.');
        await finish(correction.turnId, 'cancelled');
        aligned = () => ({ run: true, because: requestText });
        await checkWith(stale);
        assert.deepEqual(unusable(), [{ name: 'TrustCheckUnusable', code: 'superseded' }]);
        await finish(stale.turnId, 'cancelled');

        const declined = await begin('Email Ana the synthetic invoice.');
        aligned = false;
        await checkWith(declined);
        assert.deepEqual(unusable(), []);
        await finish(declined.turnId, 'cancelled');
      });

      await t.test('a newer chat correction before action handoff prevents the write', async () => {
        aligned = true;
        const action = 'GMAIL_SEND_EMAIL';
        const args = email('ana@example.test');
        const turn = await begin('Email Ana the synthetic report.');
        const verdict = await trust.check(turn, action, args);
        assert.equal(verdict.confirm, false);
        assert.ok(verdict.chatRevision);
        const correction = await thread.submitUserMessage('Correction: do not email Ana.');
        await finish(correction.turnId, 'cancelled');
        const before = calls.length;
        await assert.rejects(
          approved.request(turn, action, args, {
            allowed: true,
            expectedChatRevision: verdict.chatRevision,
          }),
        );
        assert.equal(calls.length, before);
        assert.equal(await proposal(turn.turnId), undefined);
        await finish(turn.turnId, 'cancelled');

        const fresh = await begin('Email Bob the synthetic report.');
        const freshArgs = email('bob@example.test');
        const freshVerdict = await trust.check(fresh, action, freshArgs);
        assert.equal(freshVerdict.confirm, false);
        assert.ok(freshVerdict.chatRevision);
        await approved.request(fresh, action, freshArgs, {
          allowed: true,
          expectedChatRevision: freshVerdict.chatRevision,
        });
        assert.equal(calls.length, before + 1);
        assert.equal(await proposal(fresh.turnId), undefined);
        await finish(fresh.turnId, 'succeeded');
      });

      await t.test(
        'authorization ignores unrelated task messages and detects replies to its own task',
        async (t) => {
          const parent = await begin('Email Ana the fixture invoice for EUR 1,200.');
          const task = (await tasks.execute(
            parent,
            {
              action: 'start',
              title: 'Invoice delivery',
              message: 'Preparing the fixture invoice.',
              doneWhen: 'Invoice sent',
              now: 'Preparing',
            },
            (await row(parent.turnId)).message_id,
          )) as { id: string; messageId: string };
          t.after(async () => {
            await db.pool.query(
              "UPDATE turns SET task_id=NULL,status='cancelled',finished_at=now() WHERE task_id=$1",
              [task.id],
            );
            await db.pool.query('DELETE FROM tasks WHERE id=$1', [task.id]);
          });
          await finish(parent.turnId, 'succeeded');
          const turn = await running(
            (
              await db.pool.query("SELECT id FROM turns WHERE task_id=$1 AND source='task'", [
                task.id,
              ])
            ).rows[0].id,
          );
          await tasks.inherit(turn);
          aligned = true;
          for (const own of [false, true]) {
            const entered = deferred();
            const release = deferred();
            duringReview = async () => {
              entered.resolve();
              await release.promise;
            };
            const before = calls.length;
            const outcome = approvals
              .request(turn, 'GMAIL_SEND_EMAIL', email('ana@example.test'))
              .then(
                (result) => ({ result }),
                (error: unknown) => ({ error }),
              );
            await entered.promise;
            const update = await messages.submit(
              own
                ? 'Correction: do not send this invoice.'
                : 'Send a separate hotel request to hotel@example.test.',
              [],
              own ? { replyToMessageId: task.messageId } : {},
            );
            release.resolve();
            const result = await outcome;
            if (own) {
              assert.ok('error' in result && result.error instanceof Error);
              assert.equal(calls.length, before);
              assert.equal(await proposal(turn.turnId), undefined);
            } else {
              assert.ok('result' in result);
              assert.equal(calls.length, before + 1);
              assert.equal(
                reviews
                  .at(-1)!
                  .userMessages.some((message: { text: string }) =>
                    message.text.includes('hotel@example.test'),
                  ),
                false,
              );
            }
            await finish(update.turnId, 'cancelled');
          }
          aligned = false;
          let described: ApprovalDescription | undefined;
          describe = async (proposal) => {
            described = proposal;
            return defaultDescription();
          };
          await approvals.request(turn, 'GMAIL_SEND_EMAIL', email('ana@example.test'));
          describe = defaultDescription;
          assert.deepEqual(described?.work, {
            kind: 'task',
            title: 'Invoice delivery',
            ownerRequest: 'Email Ana the fixture invoice for EUR 1,200.',
          });
        },
      );

      await t.test(
        'caller mutation during the final context read cannot change the reviewed action',
        async () => {
          const turn = await begin('Email Ana the unchanged fixture invoice.');
          const entered = deferred();
          const release = deferred();
          let preferenceReads = 0;
          const pool = new Proxy(db.pool, {
            get(target, property) {
              if (property === 'query')
                return async (...args: Parameters<typeof db.pool.query>) => {
                  if (
                    typeof args[0] === 'string' &&
                    args[0].includes('SELECT notification_rule,rules') &&
                    ++preferenceReads === 2
                  ) {
                    entered.resolve();
                    await release.promise;
                  }
                  return target.query(...args);
                };
              const value = Reflect.get(target, property);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          const checking = createTrust({
            pool,
            ownerId,
            review: async (_instructions, input) => ({ run: true, because: cite(input) }),
          });
          const args = email('ana@example.test');
          const before = calls.length;
          const outcome = checking
            .check(turn, 'GMAIL_SEND_EMAIL', args)
            .then((verdict) =>
              approved.request(turn, 'GMAIL_SEND_EMAIL', args, { allowed: !verdict.confirm }),
            )
            .then(
              () => undefined,
              (error: unknown) => error,
            );
          await entered.promise;
          args.recipient_email = 'unreviewed@example.test';
          release.resolve();
          assert.ok((await outcome) instanceof Error);
          assert.equal(calls.length, before);
          assert.equal(await proposal(turn.turnId), undefined);
          await finish(turn.turnId, 'cancelled');
        },
      );
      await t.test(
        'onboarding reads require a strict decision and retain owner rules without message authority',
        async () => {
          await db.pool.query(
            'INSERT INTO preferences(owner_id,rules) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET rules=EXCLUDED.rules',
            [ownerId, 'Ask before reading private project documents.'],
          );
          const schema = { description: 'Read existing records', inputSchema: { type: 'object' } };
          const args = { connectionId: randomUUID(), tool: 'records_list', input: { limit: 5 } };
          aligned = () => ({ run: true, because: 'read' });
          assert.equal(
            await trust.readOnly('CONNECTED_MCP_CALL', args, schema, AbortSignal.timeout(1000)),
            false,
          );
          assert.deepEqual(reviews.at(-1), {
            action: { name: 'CONNECTED_MCP_CALL', arguments: args, schema },
            userRules: 'Ask before reading private project documents.',
          });
          for (const decision of [{ readOnly: false }, { readOnly: 'true' }, { run: true }, {}]) {
            aligned = () => decision;
            assert.equal(
              await trust.readOnly('CONNECTED_MCP_CALL', args, schema, AbortSignal.timeout(1000)),
              false,
            );
          }
          aligned = () => ({ readOnly: true });
          assert.equal(
            await trust.readOnly('CONNECTED_MCP_CALL', args, schema, AbortSignal.timeout(1000)),
            true,
          );
          const before = reviews.length;
          await assert.rejects(
            trust.readOnly('CONNECTED_MCP_CALL', args, schema, AbortSignal.abort()),
          );
          assert.equal(reviews.length, before);
          await db.pool.query("UPDATE preferences SET rules='' WHERE owner_id=$1", [ownerId]);
        },
      );
      await t.test(
        'decision action checks retain owner evidence, confirmation and action locks',
        async () => {
          const text = 'Email Ana the synthetic report.';
          const turn = await begin(text);
          let output: unknown;
          let mutate = false;
          const args = email('ana@example.test');
          const checking = createTrust({
            pool: db.pool,
            ownerId,
            review: async () => assert.fail('A decision check must not switch to an LLM.'),
            decisions: {
              check: async ({ instructions, input, question, additionalQuestions }) => {
                assert.equal(question.name, 'trust');
                assert.equal(
                  additionalQuestions?.find(({ name }) => name === 'permission')?.minProbability,
                  0.99,
                );
                assert.doesNotMatch(instructions, /Reply with only JSON/);
                const messages = (input as { userMessages: Array<{ text: string }> }).userMessages;
                const index = messages.findIndex((message) => message.text === text);
                assert.ok(index >= 0);
                assert.ok(question.choices.some(({ value }) => value === `message:${index}`));
                assert.deepEqual((input as { action: unknown }).action, {
                  name: 'GMAIL_SEND_EMAIL',
                  arguments: { ...args },
                });
                if (mutate) args.recipient_email = 'other@example.test';
                if (output instanceof Error) throw output;
                const answer = output ?? { trust: `message:${index}` };
                return {
                  ...(answer as object),
                  probability: 1,
                  additional: {
                    ...Object.fromEntries(
                      (additionalQuestions ?? [])
                        .filter(({ name }) => !['permission', 'preparation'].includes(name))
                        .map(({ name }) => [name, { choice: name === 'scope', probability: 1 }]),
                    ),
                    permission: {
                      permission: (answer as { trust?: unknown }).trust !== 'ask',
                      choice: (answer as { trust?: unknown }).trust !== 'ask',
                      probability: 1,
                    },
                    preparation: { preparation: false, probability: 1 },
                  },
                };
              },
            },
          });
          const allowed = await checking.check(turn, 'GMAIL_SEND_EMAIL', args);
          assert.equal(allowed.confirm, false);
          if (!allowed.confirm) {
            assert.equal(allowed.basis.kind, 'message');
            if (allowed.basis.kind === 'message')
              assert.equal(allowed.basis.quote, text.slice(0, -1));
          }
          for (const value of [
            { trust: 'ask' },
            { trust: 'message:999' },
            { trust: 'assistant' },
            { run: true, because: text },
            new Error('Synthetic outage.'),
          ]) {
            output = value;
            assert.equal((await checking.check(turn, 'GMAIL_SEND_EMAIL', args)).confirm, true);
          }
          output = undefined;
          mutate = true;
          await assert.rejects(checking.check(turn, 'GMAIL_SEND_EMAIL', args), /action changed/);
          await finish(turn.turnId, 'cancelled');
        },
      );
      const askFor = async (turn: { threadId: string; turnId: string }, args: object) => {
        const verdict = await trust.check(turn, 'GMAIL_SEND_EMAIL', { ...args });
        assert.equal(verdict.confirm, true);
        return approvals.request(
          turn,
          'GMAIL_SEND_EMAIL',
          { ...args },
          { allowed: false, details: { reason: verdict.confirm ? verdict.reason : 'unrequested' } },
        );
      };
      await t.test(
        'the checker sees only the owner words and the action, fails closed, and a past confirmation never skips it',
        async () => {
          const turn = await begin('Summarise my inbox.');
          await trust.check(turn, 'GMAIL_FETCH_EMAILS', {});
          assert.deepEqual(
            Object.keys(reviews.at(-1)!).filter(
              (key) =>
                ![
                  'userMessages',
                  'assistantMessageBeforeLatestUserMessage',
                  'action',
                  'timeZone',
                ].includes(key),
            ),
            [],
          );
          assert.equal(reviews.at(-1)?.userMessages.at(-1).text, 'Summarise my inbox.');
          assert.equal(reviews.at(-1)?.timeZone, 'UTC');
          await db.pool.query(
            "UPDATE preferences SET time_zone='Europe/Madrid' WHERE owner_id=$1",
            [ownerId],
          );
          await trust.check(turn, 'GMAIL_FETCH_EMAILS', {});
          assert.equal(reviews.at(-1)?.timeZone, 'Europe/Madrid');
          await db.pool.query('UPDATE preferences SET time_zone=NULL WHERE owner_id=$1', [ownerId]);
          await trust.check(turn, 'GMAIL_SEND_EMAIL', email('stranger@example.test'));
          assert.match(JSON.stringify(reviews.at(-1)?.action), /stranger@example\.test/);
          aligned = () => {
            throw new Error('Synthetic checker failure.');
          };
          compareVerdict(await trust.check(turn, 'GMAIL_FETCH_EMAILS', {}), {
            confirm: true,
            reason: 'unrequested',
          });
          for (const loose of ['read', 'requested', 'true', 'yes']) {
            aligned = loose;
            assert.equal((await trust.check(turn, 'GMAIL_FETCH_EMAILS', {})).confirm, true);
          }
          aligned = false;
          await askFor(turn, email('stranger@example.test'));
          await confirmTurn(turn.turnId);
          await execute((await proposal(turn.turnId)).id);
          const reviewed = reviews.length;
          const later = await begin('Summarise my inbox again.');
          compareVerdict(
            await trust.check(later, 'GMAIL_SEND_EMAIL', email('stranger@example.test')),
            { confirm: true, reason: 'unrequested' },
          );
          assert.equal(reviews.length, reviewed + 1);
        },
      );

      await t.test('replies do not borrow authority from other assistant messages', async (t) => {
        const turnIds: string[] = [];
        const approvalIds: string[] = [];
        t.after(async () => {
          await db.pool.query('DELETE FROM approvals WHERE id=ANY($1::uuid[])', [approvalIds]);
          await db.pool.query('DELETE FROM messages WHERE turn_id=ANY($1::uuid[])', [turnIds]);
          await db.pool.query('DELETE FROM turns WHERE id=ANY($1::uuid[])', [turnIds]);
        });
        const proposalMessage = async (request: string, text: string) => {
          const turn = await begin(request);
          turnIds.push(turn.turnId);
          const id = randomUUID();
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,'assistant',$5)",
            [id, ownerId, turn.threadId, turn.turnId, text],
          );
          await finish(turn.turnId, 'succeeded');
          return { id, text };
        };
        const older = await proposalMessage(
          'Check the synthetic draft.',
          'I can send the synthetic draft to Ana.',
        );
        const newer = await proposalMessage(
          'Check the synthetic report.',
          'I can send the synthetic report to Bob.',
        );
        const reaction = await thread.submitUserMessage('👍', [], {
          replyToMessageId: older.id,
          sourceId: `reaction-reply:${randomUUID()}`,
        });
        turnIds.push(reaction.turnId);
        const reacted = await running(reaction.turnId);
        await trust.check(reacted, 'GMAIL_SEND_EMAIL', email('bob@example.test'));
        assert.equal(reviews.at(-1)?.assistantMessageBeforeLatestUserMessage, older.text);
        assert.ok(
          reviews.at(-1)?.userMessages.some((message: { text: string }) => message.text === '👍'),
        );
        aligned = (input) => input.assistantMessageBeforeLatestUserMessage === older.text;
        assert.equal(
          (await trust.check(reacted, 'GMAIL_SEND_EMAIL', email('ana@example.test'))).confirm,
          true,
        );
        aligned = false;
        await db.pool.query('UPDATE messages SET hidden_at=now() WHERE id=$1', [older.id]);
        await trust.check(reacted, 'GMAIL_SEND_EMAIL', email('bob@example.test'));
        assert.equal('assistantMessageBeforeLatestUserMessage' in reviews.at(-1)!, false);
        const typedText = 'I approve the synthetic report to Bob.';
        const typed = await thread.submitUserMessage(typedText, [], {
          replyToMessageId: newer.id,
        });
        turnIds.push(typed.turnId);
        const typedTurn = await running(typed.turnId);
        await trust.check(typedTurn, 'GMAIL_SEND_EMAIL', email('bob@example.test'));
        assert.equal(reviews.at(-1)?.assistantMessageBeforeLatestUserMessage, newer.text);
        assert.ok(
          reviews
            .at(-1)
            ?.userMessages.some((message: { text: string }) => message.text === typedText),
        );
        const accepted = await thread.submitUserMessage('Yes.');
        turnIds.push(accepted.turnId);
        const acceptedTurn = await running(accepted.turnId);
        aligned = (input) => input.assistantMessageBeforeLatestUserMessage === newer.text;
        const acceptedVerdict = await trust.check(
          acceptedTurn,
          'GMAIL_SEND_EMAIL',
          email('bob@example.test'),
        );
        compareVerdict(acceptedVerdict, {
          confirm: true,
          reason: 'unrequested',
        });
        assert.equal(acceptedVerdict.chatRevision, accepted.messageId);
        aligned = false;
        const bare = await begin('What time is it?');
        turnIds.push(bare.turnId);
        await trust.check(bare, 'GMAIL_SEND_EMAIL', email('bob@example.test'));
        assert.equal(reviews.at(-1)?.assistantMessageBeforeLatestUserMessage, newer.text);
        assert.ok(
          !reviews.at(-1)?.userMessages.some((message: { text: string }) => message.text === '👍'),
        );
        assert.equal(
          reviews
            .at(-1)
            ?.userMessages.find((message: { text: string }) => message.text === typedText)
            ?.canAuthorize,
          false,
        );
        const active = await begin('Continue the synthetic task.');
        turnIds.push(active.turnId);
        const steered = await thread.submitUserMessage('🙏', [], {
          replyToMessageId: newer.id,
          sourceId: `reaction-reply:${randomUUID()}`,
        });
        turnIds.push(steered.turnId);
        await db.pool.query('UPDATE messages SET turn_id=$2 WHERE id=$1', [
          steered.messageId,
          active.turnId,
        ]);
        await db.pool.query("UPDATE turns SET status='succeeded',finished_at=now() WHERE id=$1", [
          steered.turnId,
        ]);
        await trust.check(active, 'GMAIL_SEND_EMAIL', email('bob@example.test'));
        assert.ok(
          reviews.at(-1)?.userMessages.some((message: { text: string }) => message.text === '🙏'),
        );
        const expiring = await begin('Prepare a synthetic account update.');
        turnIds.push(expiring.turnId);
        const expired = await propose(expiring, 'GMAIL_SEND_EMAIL', email('fixture@example.test'));
        approvalIds.push(expired);
        await finish(expiring.turnId, 'waiting');
        await db.pool.query("UPDATE approvals SET status='expired' WHERE id=$1", [expired]);
        const confirmation = (await stored(expired)).confirmation_message_id as string;
        const stale = await thread.submitUserMessage('👍', [], {
          replyToMessageId: confirmation,
          sourceId: `reaction-reply:${randomUUID()}`,
        });
        turnIds.push(stale.turnId);
        const staleTurn = await running(stale.turnId);
        await trust.check(staleTurn, 'GMAIL_SEND_EMAIL', email('fixture@example.test'));
        assert.equal(reviews.at(-1)?.assistantMessageBeforeLatestUserMessage, undefined);
        const untargeted = await thread.submitUserMessage('👍');
        turnIds.push(untargeted.turnId);
        const untargetedTurn = await running(untargeted.turnId);
        aligned = (input) => input.assistantMessageBeforeLatestUserMessage === newer.text;
        compareVerdict(
          await trust.check(untargetedTurn, 'GMAIL_SEND_EMAIL', email('fixture@example.test')),
          { confirm: true, reason: 'unrequested' },
        );
        assert.equal(reviews.at(-1)?.assistantMessageBeforeLatestUserMessage, undefined);
        const otherChannel = await begin('Check the synthetic channel note.', {
          channel: 'telegram',
        });
        turnIds.push(otherChannel.turnId);
        const otherMessageId = randomUUID();
        const otherMessage = 'I can send the synthetic channel note to Carol.';
        await db.pool.query(
          "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,'assistant',$5)",
          [otherMessageId, ownerId, otherChannel.threadId, otherChannel.turnId, otherMessage],
        );
        await finish(otherChannel.turnId, 'succeeded');
        const webBare = await thread.submitUserMessage('Yes.', [], { channel: 'web' });
        turnIds.push(webBare.turnId);
        const webBareTurn = await running(webBare.turnId);
        aligned = (input) => input.assistantMessageBeforeLatestUserMessage === otherMessage;
        compareVerdict(
          await trust.check(webBareTurn, 'GMAIL_SEND_EMAIL', email('carol@example.test')),
          { confirm: true, reason: 'unrequested' },
        );
        assert.notEqual(reviews.at(-1)?.assistantMessageBeforeLatestUserMessage, otherMessage);
        const crossChannelReply = await thread.submitUserMessage('Yes.', [], {
          channel: 'web',
          replyToMessageId: otherMessageId,
        });
        turnIds.push(crossChannelReply.turnId);
        const crossChannelTurn = await running(crossChannelReply.turnId);
        compareVerdict(
          await trust.check(crossChannelTurn, 'GMAIL_SEND_EMAIL', email('carol@example.test')),
          {
            confirm: true,
            reason: 'unrequested',
          },
        );
        assert.equal(reviews.at(-1)?.assistantMessageBeforeLatestUserMessage, otherMessage);
        const proposalReaction = await thread.submitUserMessage('👍', [], {
          channel: 'web',
          replyToMessageId: otherMessageId,
          sourceId: `reaction-reply:${randomUUID()}`,
        });
        turnIds.push(proposalReaction.turnId);
        const proposalReactionTurn = await running(proposalReaction.turnId);
        const verdict = await trust.check(
          proposalReactionTurn,
          'GMAIL_SEND_EMAIL',
          email('carol@example.test'),
        );
        assert.equal(verdict.confirm, true);
        assert.equal(verdict.chatRevision, proposalReaction.messageId);
        assert.equal(reviews.at(-1)?.assistantMessageBeforeLatestUserMessage, otherMessage);
        const sent = calls.length;
        const newApproval = await approvals.request(
          proposalReactionTurn,
          'GMAIL_SEND_EMAIL',
          email('carol@example.test'),
          { allowed: !verdict.confirm },
        );
        assert.ok(newApproval && typeof newApproval === 'object' && appConfirmation in newApproval);
        approvalIds.push((await proposal(proposalReaction.turnId)).id);
        assert.equal(calls.length, sent);
      });

      await t.test('a retired confirmation reply cannot reuse the original request', async (t) => {
        const turnIds: string[] = [];
        t.after(async () => {
          await db.pool.query(
            'DELETE FROM approvals WHERE turn_id=ANY($1::uuid[]) OR execution_turn_id=ANY($1::uuid[])',
            [turnIds],
          );
          await db.pool.query('DELETE FROM messages WHERE turn_id=ANY($1::uuid[])', [turnIds]);
          await db.pool.query('DELETE FROM turn_events WHERE turn_id=ANY($1::uuid[])', [turnIds]);
          await db.pool.query('DELETE FROM turns WHERE id=ANY($1::uuid[])', [turnIds]);
        });
        const requestText = 'Send the synthetic report to Ana at ana@example.test.';
        const args = email('ana@example.test');
        const original = await begin(requestText);
        turnIds.push(original.turnId);
        const approvalId = await propose(original, 'GMAIL_SEND_EMAIL', args);
        const confirmationId = (await stored(approvalId)).confirmation_message_id as string;
        const confirmed = await confirm(approvalId, true);
        assert.ok(confirmed && 'turnId' in confirmed);
        turnIds.push(confirmed.turnId);
        await execute(approvalId);
        assert.equal((await stored(approvalId)).status, 'completed');
        const sent = calls.length;
        const reaction = await messages.submit('👍', [], {
          replyToMessageId: confirmationId,
          sourceId: `reaction-reply:${randomUUID()}`,
        });
        turnIds.push(reaction.turnId);
        const reacted = await running(reaction.turnId);
        assert.equal((await row(reaction.turnId)).source, 'user');
        aligned = () => ({ run: true, because: requestText });
        compareVerdict(await trust.check(reacted, 'GMAIL_SEND_EMAIL', args), {
          confirm: true,
          reason: 'unrequested',
        });
        assert.equal(reviews.at(-1)?.userMessages.at(-1)?.text, '👍');
        assert.equal(reviews.at(-1)?.userMessages.at(-1)?.canAuthorize, true);
        const typed = await messages.submit('Yes.');
        turnIds.push(typed.turnId);
        const typedTurn = await running(typed.turnId);
        assert.equal((await row(typed.turnId)).source, 'user');
        aligned = () => ({ run: true, because: 'Yes.' });
        compareVerdict(await trust.check(typedTurn, 'GMAIL_SEND_EMAIL', args), {
          confirm: true,
          reason: 'unrequested',
        });
        assert.equal(reviews.at(-1)?.userMessages.at(-1)?.text, 'Yes.');
        assert.equal(reviews.at(-1)?.userMessages.at(-1)?.canAuthorize, true);
        const uncertain = await messages.submit('Maybe.', [], {
          replyToMessageId: confirmationId,
        });
        turnIds.push(uncertain.turnId);
        const uncertainTurn = await running(uncertain.turnId);
        aligned = () => ({ run: true, because: 'Maybe.' });
        compareVerdict(await trust.check(uncertainTurn, 'GMAIL_SEND_EMAIL', args), {
          confirm: true,
          reason: 'unrequested',
        });
        for (const turn of [reacted, typedTurn, uncertainTurn]) {
          const proposed = await approvals.request(turn, 'GMAIL_SEND_EMAIL', args);
          assert.ok(proposed && typeof proposed === 'object' && appConfirmation in proposed);
        }
        assert.equal(calls.length, sent);
        const replacementText = 'Send the revised synthetic report to Bob at bob@example.test.';
        const replacement = await messages.submit(replacementText, [], {
          replyToMessageId: confirmationId,
        });
        turnIds.push(replacement.turnId);
        const replacementTurn = await running(replacement.turnId);
        aligned = () => ({ run: true, because: replacementText });
        compareVerdict(
          await trust.check(replacementTurn, 'GMAIL_SEND_EMAIL', email('bob@example.test')),
          {
            confirm: false,
            basis: {
              kind: 'message',
              messageId: replacement.messageId,
              quote: replacementText.slice(0, -1),
            },
          },
        );
        assert.equal(reviews.at(-1)?.userMessages.at(-1)?.text, replacementText);
        assert.equal(reviews.at(-1)?.userMessages.at(-1)?.canAuthorize, true);
        await approvals.request(replacementTurn, 'GMAIL_SEND_EMAIL', email('bob@example.test'));
        assert.equal(calls.length, sent + 1);
        assert.equal(calls.at(-1)?.args.recipient_email, 'bob@example.test');
        const expiredRequestText = 'Send the synthetic invoice to Carol at carol@example.test.';
        const expiredArgs = email('carol@example.test');
        aligned = false;
        const expiring = await begin(expiredRequestText);
        turnIds.push(expiring.turnId);
        const expiredId = await propose(expiring, 'GMAIL_SEND_EMAIL', expiredArgs);
        const expiredConfirmationId = (await stored(expiredId)).confirmation_message_id as string;
        await finish(expiring.turnId, 'waiting');
        await db.pool.query("UPDATE approvals SET status='expired' WHERE id=$1", [expiredId]);
        const stale = await messages.submit('👍', [], {
          replyToMessageId: expiredConfirmationId,
          sourceId: `reaction-reply:${randomUUID()}`,
        });
        turnIds.push(stale.turnId);
        const staleTurn = await running(stale.turnId);
        aligned = () => ({ run: true, because: expiredRequestText });
        compareVerdict(await trust.check(staleTurn, 'GMAIL_SEND_EMAIL', expiredArgs), {
          confirm: true,
          reason: 'unrequested',
        });
        const expiredProposal = await approvals.request(staleTurn, 'GMAIL_SEND_EMAIL', expiredArgs);
        assert.ok(
          expiredProposal &&
            typeof expiredProposal === 'object' &&
            appConfirmation in expiredProposal,
        );
        assert.equal(calls.length, sent + 1);
        aligned = () => ({ run: true, because: 'read' });
        compareVerdict(await trust.check(staleTurn, 'GMAIL_FETCH_EMAILS', {}), {
          confirm: false,
          basis: { kind: 'read' },
        });
      });

      await t.test('current short replies cannot reuse an earlier send request', async (t) => {
        const turnIds: string[] = [];
        t.after(async () => {
          await db.pool.query(
            'DELETE FROM approvals WHERE turn_id=ANY($1::uuid[]) OR execution_turn_id=ANY($1::uuid[])',
            [turnIds],
          );
          await db.pool.query('DELETE FROM messages WHERE turn_id=ANY($1::uuid[])', [turnIds]);
          await db.pool.query('DELETE FROM turn_events WHERE turn_id=ANY($1::uuid[])', [turnIds]);
          await db.pool.query('DELETE FROM turns WHERE id=ANY($1::uuid[])', [turnIds]);
        });
        const originalText = 'Send the synthetic report to Ana at ana@example.test.';
        const args = email('ana@example.test');
        const original = await begin(originalText);
        turnIds.push(original.turnId);
        const approvalId = await propose(original, 'GMAIL_SEND_EMAIL', args);
        const confirmed = await confirm(approvalId, true);
        assert.ok(confirmed && 'turnId' in confirmed);
        turnIds.push(confirmed.turnId);
        await execute(approvalId);
        const sent = calls.length;
        const resultId = '00000000-0000-4000-8000-000000000926';
        const resultText = 'Sent the synthetic report to Ana.';
        await db.pool.query(
          "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,'assistant',$5)",
          [resultId, ownerId, original.threadId, confirmed.turnId, resultText],
        );
        const reaction = await messages.submit('👍', [], {
          replyToMessageId: resultId,
          sourceId: `reaction-reply:${randomUUID()}`,
        });
        turnIds.push(reaction.turnId);
        const reacted = await running(reaction.turnId);
        aligned = () => ({ run: true, because: originalText });
        compareVerdict(await trust.check(reacted, 'GMAIL_SEND_EMAIL', args), {
          confirm: true,
          reason: 'unrequested',
        });
        assert.equal(
          reviews.at(-1)?.userMessages.find((item: { text: string }) => item.text === originalText)
            ?.canAuthorize,
          false,
        );
        assert.equal(reviews.at(-1)?.assistantMessageBeforeLatestUserMessage, resultText);
        aligned = () => ({ run: true, because: '👍' });
        assert.equal((await trust.check(reacted, 'GMAIL_SEND_EMAIL', args)).confirm, true);
        const bare = await messages.submit('Yes.', [], {
          clientMessageId: '00000000-0000-4000-8000-000000000927',
        });
        await db.pool.query(
          `WITH boundary AS (SELECT date_trunc('milliseconds',created_at) AS at FROM messages WHERE id=$2)
           UPDATE messages m SET created_at=boundary.at + CASE WHEN m.id=$1 THEN interval '500 microseconds' ELSE interval '800 microseconds' END
           FROM boundary WHERE m.id IN ($1,$2)`,
          [resultId, bare.messageId],
        );
        turnIds.push(bare.turnId);
        const bareTurn = await running(bare.turnId);
        aligned = () => ({ run: true, because: originalText });
        compareVerdict(await trust.check(bareTurn, 'GMAIL_SEND_EMAIL', args), {
          confirm: true,
          reason: 'unrequested',
        });
        assert.equal(reviews.at(-1)?.userMessages.at(-1)?.text, 'Yes.');
        assert.equal(reviews.at(-1)?.userMessages.at(-1)?.canAuthorize, true);
        assert.equal(reviews.at(-1)?.assistantMessageBeforeLatestUserMessage, resultText);
        aligned = () => ({ run: true, because: 'Yes.' });
        assert.equal((await trust.check(bareTurn, 'GMAIL_SEND_EMAIL', args)).confirm, true);
        for (const turn of [reacted, bareTurn]) {
          const proposed = await approvals.request(turn, 'GMAIL_SEND_EMAIL', args);
          assert.ok(proposed && typeof proposed === 'object' && appConfirmation in proposed);
        }
        assert.equal(calls.length, sent);
        aligned = false;
        const pendingText = 'Send the synthetic invoice to Bob at bob@example.test.';
        const pendingArgs = email('bob@example.test');
        const pending = await begin(pendingText);
        turnIds.push(pending.turnId);
        await propose(pending, 'GMAIL_SEND_EMAIL', pendingArgs);
        await finish(pending.turnId, 'waiting');
        const question = await messages.submit('What time is it?');
        turnIds.push(question.turnId);
        const questionTurn = await running(question.turnId);
        assert.equal((await row(question.turnId)).source, 'user');
        aligned = () => ({ run: true, because: pendingText });
        compareVerdict(await trust.check(questionTurn, 'GMAIL_SEND_EMAIL', pendingArgs), {
          confirm: true,
          reason: 'unrequested',
        });
        assert.equal(reviews.at(-1)?.userMessages.at(-1)?.text, 'What time is it?');
        assert.equal(reviews.at(-1)?.userMessages.at(-1)?.canAuthorize, true);
        const proposed = await approvals.request(questionTurn, 'GMAIL_SEND_EMAIL', pendingArgs);
        assert.ok(proposed && typeof proposed === 'object' && appConfirmation in proposed);
        assert.equal(calls.length, sent);
      });

      await t.test(
        'a confirmation resume retains the request without granting its Yes',
        async (t) => {
          const turnIds: string[] = [];
          t.after(async () => {
            await db.pool.query(
              'DELETE FROM approvals WHERE turn_id=ANY($1::uuid[]) OR execution_turn_id=ANY($1::uuid[])',
              [turnIds],
            );
            await db.pool.query('DELETE FROM messages WHERE turn_id=ANY($1::uuid[])', [turnIds]);
            await db.pool.query('DELETE FROM turn_events WHERE turn_id=ANY($1::uuid[])', [turnIds]);
            await db.pool.query('DELETE FROM turns WHERE id=ANY($1::uuid[])', [turnIds]);
          });
          const requestText =
            'Send the synthetic report to Ana at ana@example.test, then send the synthetic receipt to Bob at bob@example.test.';
          const original = await begin(requestText);
          turnIds.push(original.turnId);
          const originalMessageId = (await row(original.turnId)).message_id as string;
          const approvalId = await propose(original, 'GMAIL_SEND_EMAIL', email('ana@example.test'));
          const confirmed = await confirm(approvalId, true);
          assert.ok(confirmed && 'turnId' in confirmed);
          turnIds.push(confirmed.turnId);
          await execute(approvalId);
          const resumed = await running(confirmed.turnId);
          aligned = () => ({ run: true, because: 'Yes' });
          const unrelated = await trust.check(
            resumed,
            'GMAIL_SEND_EMAIL',
            email('carol@example.test'),
          );
          compareVerdict(unrelated, { confirm: true, reason: 'unrequested' });
          assert.equal(unrelated.chatRevision, originalMessageId);
          aligned = () => ({ run: true, because: requestText });
          const followOn = await trust.check(
            resumed,
            'GMAIL_SEND_EMAIL',
            email('bob@example.test'),
          );
          compareVerdict(followOn, {
            confirm: false,
            basis: {
              kind: 'message',
              messageId: originalMessageId,
              quote: requestText.slice(0, -1),
            },
          });
          assert.equal(followOn.chatRevision, originalMessageId);
          const words = reviews.at(-1)?.userMessages as Array<{
            text: string;
            canAuthorize: boolean;
          }>;
          assert.equal(words.find((item) => item.text === 'Yes')?.canAuthorize, false);
          assert.equal(words.find((item) => item.text === requestText)?.canAuthorize, true);
          const sent = calls.length;
          await approved.request(resumed, 'GMAIL_SEND_EMAIL', email('bob@example.test'), {
            allowed: true,
            expectedChatRevision: followOn.chatRevision,
          });
          assert.equal(calls.length, sent + 1);
          const correctionText = 'Do not send the synthetic receipt to Bob again.';
          const correction = await thread.submitUserMessage(correctionText);
          turnIds.push(correction.turnId);
          await db.pool.query('UPDATE messages SET turn_id=$2 WHERE turn_id=$1 AND owner_id=$3', [
            correction.turnId,
            resumed.turnId,
            ownerId,
          ]);
          await db.pool.query("UPDATE turns SET status='succeeded',finished_at=now() WHERE id=$1", [
            correction.turnId,
          ]);
          aligned = () => ({ run: true, because: requestText });
          const corrected = await trust.check(
            resumed,
            'GMAIL_SEND_EMAIL',
            email('bob@example.test'),
          );
          compareVerdict(corrected, { confirm: true, reason: 'unrequested' });
          assert.equal(corrected.chatRevision, correction.messageId);
          const correctedWords = reviews.at(-1)?.userMessages as Array<{
            text: string;
            canAuthorize: boolean;
          }>;
          assert.equal(correctedWords.find((item) => item.text === 'Yes')?.canAuthorize, false);
          assert.equal(
            correctedWords.find((item) => item.text === requestText)?.canAuthorize,
            false,
          );
          assert.equal(
            correctedWords.find((item) => item.text === correctionText)?.canAuthorize,
            true,
          );
        },
      );

      await t.test(
        'a task resume cannot use its confirmation reply for another write',
        async (t) => {
          for (const reply of ['Yes', '👍']) {
            const requestText = `Send the synthetic ${reply === '👍' ? 'reaction' : 'typed'} task report to Ana at ana@example.test.`;
            const parent = await begin(requestText);
            const task = (await tasks.execute(
              parent,
              {
                action: 'start',
                title: `Synthetic ${reply === '👍' ? 'reaction' : 'typed'} task report`,
                message: 'Preparing the synthetic task report.',
                doneWhen: 'The report is sent',
                now: 'Preparing',
              },
              (await row(parent.turnId)).message_id,
            )) as { id: string; messageId: string };
            t.after(async () => {
              await db.pool.query(
                "UPDATE turns SET task_id=NULL,status='cancelled',finished_at=now() WHERE task_id=$1",
                [task.id],
              );
              await db.pool.query('DELETE FROM tasks WHERE id=$1', [task.id]);
            });
            await finish(parent.turnId, 'succeeded');
            const worker = await running(
              (
                await db.pool.query("SELECT id FROM turns WHERE task_id=$1 AND source='task'", [
                  task.id,
                ])
              ).rows[0].id,
            );
            await tasks.inherit(worker);
            const approvalId = await propose(worker, 'GMAIL_SEND_EMAIL', email('ana@example.test'));
            const accepted = await confirm(
              approvalId,
              true,
              reply === '👍' ? { text: reply, sourceId: `reaction-reply:${randomUUID()}` } : {},
            );
            assert.ok(accepted && 'turnId' in accepted);
            await execute(approvalId);
            const resumed = await running(accepted.turnId);
            await tasks.inherit(resumed);
            assert.equal((await row(resumed.turnId)).task_id, task.id);
            const sent = calls.length;
            aligned = () => ({ run: true, because: reply });
            const verdict = await trust.check(
              resumed,
              'GMAIL_SEND_EMAIL',
              email('carol@example.test'),
            );
            compareVerdict(verdict, { confirm: true, reason: 'unrequested' });
            assert.equal(calls.length, sent);
            const words = reviews.at(-1)?.userMessages as Array<{
              text: string;
              canAuthorize: boolean;
            }>;
            assert.equal(words.find((item) => item.text === reply)?.canAuthorize, false);
            assert.equal(words.find((item) => item.text === requestText)?.canAuthorize, true);
          }
        },
      );

      await t.test(
        'prior chat constraints remain visible without granting a new write',
        async () => {
          const priorText = 'Only send the synthetic report to Ana after Friday.';
          const prior = await begin(priorText);
          await finish(prior.turnId, 'succeeded');
          const current = await begin('What time is it?');
          aligned = () => ({ run: true, because: priorText });
          const verdict = await trust.check(current, 'GMAIL_SEND_EMAIL', email('ana@example.test'));
          const messages = reviews.at(-1)?.userMessages as Array<{
            at: string;
            text: string;
            canAuthorize?: boolean;
          }>;
          assert.equal(messages.find((message) => message.text === priorText)?.canAuthorize, false);
          assert.equal(
            messages.find((message) => message.text === 'What time is it?')?.canAuthorize,
            true,
          );
          assert.equal(verdict.confirm, true);
          assert.equal(verdict.chatRevision, (await row(current.turnId)).message_id);
          const { trustDecision } = await import('../src/server/trust-basis.ts');
          const priorIndex = messages.findIndex((message) => message.text === priorText);
          assert.ok(priorIndex >= 0);
          assert.equal(
            trustDecision({ userMessages: messages }).question.choices.some(
              ({ value }) => value === `message:${priorIndex}`,
            ),
            false,
          );
          aligned = () => ({ run: true, because: priorText, source: `message:${priorIndex}` });
          assert.equal(
            (await trust.check(current, 'GMAIL_SEND_EMAIL', email('ana@example.test'))).confirm,
            true,
          );
          await finish(current.turnId, 'cancelled');
        },
      );

      await t.test('an absorbed correction removes the earlier request as authority', async (t) => {
        const requestText = 'Send the synthetic report to Ana at ana@example.test.';
        const correctionText = 'Do not send the synthetic report to Ana.';
        const original = await begin(requestText);
        const correction = await thread.submitUserMessage(correctionText);
        const ids = [original.turnId, correction.turnId];
        t.after(async () => {
          await db.pool.query('DELETE FROM turn_events WHERE turn_id=ANY($1::uuid[])', [ids]);
          await db.pool.query('DELETE FROM messages WHERE turn_id=ANY($1::uuid[])', [ids]);
          await db.pool.query('DELETE FROM turns WHERE id=ANY($1::uuid[])', [ids]);
        });
        await db.pool.query('UPDATE messages SET turn_id=$2 WHERE turn_id=$1 AND owner_id=$3', [
          correction.turnId,
          original.turnId,
          ownerId,
        ]);
        await db.pool.query("UPDATE turns SET status='succeeded',finished_at=now() WHERE id=$1", [
          correction.turnId,
        ]);
        aligned = () => ({ run: true, because: requestText });
        const verdict = await trust.check(original, 'GMAIL_SEND_EMAIL', email('ana@example.test'));
        const words = reviews.at(-1)?.userMessages as Array<{
          text: string;
          canAuthorize: boolean;
        }>;
        assert.equal(words.find((message) => message.text === requestText)?.canAuthorize, false);
        assert.equal(words.find((message) => message.text === correctionText)?.canAuthorize, true);
        assert.equal(verdict.confirm, true);
        assert.equal(verdict.chatRevision, correction.messageId);
      });

      await t.test(
        'a request the owner stopped, or whose continuation the owner stopped, is never owner words or a proposal for a later reply',
        async () => {
          const answered = await begin('Email Ana the answered invoice.');
          await finish(answered.turnId);
          await finish((await begin('Thanks, that is all.')).turnId, 'succeeded');
          const continued = await begin('Email Carol the continued invoice.');
          await finish(continued.turnId);
          await thread.resumeTurn(
            continued.turnId,
            `synthetic-resume:${continued.turnId}`,
            'The synthetic sign-in finished. Continue the request.',
          );
          const stopped = await begin('Email Bob the stopped invoice.');
          await thread.reply(stopped, 'Should I send Bob the stopped invoice now?');
          await thread.stopThread();
          const later = await begin('Yes, go ahead.');
          aligned = (input) =>
            input.userMessages.some((message: { text: string }) =>
              /continued invoice|stopped invoice/.test(message.text),
            ) || /stopped invoice/.test(input.assistantMessageBeforeLatestUserMessage ?? '');
          try {
            const verdict = await trust.check(later, 'GMAIL_SEND_EMAIL', email('bob@example.test'));
            compareVerdict(verdict, { confirm: true, reason: 'unrequested' });
            assert.equal(verdict.chatRevision, (await row(later.turnId)).message_id);
            const seen = reviews
              .at(-1)!
              .userMessages.map((message: { text: string }) => message.text);
            assert.deepEqual(seen.slice(-3), [
              'Email Ana the answered invoice.',
              'Thanks, that is all.',
              'Yes, go ahead.',
            ]);
            assert.equal(reviews.at(-1)!.assistantMessageBeforeLatestUserMessage, undefined);
            assert.ok(!seen.some((text: string) => /continued invoice|stopped invoice/.test(text)));
          } finally {
            await finish(later.turnId, 'cancelled');
          }
        },
      );

      await t.test(
        'background work shows the checker only the standing instruction, and a scheduled run only its instruction',
        async () => {
          const setRule = (rule: string) =>
            db.pool.query(
              `INSERT INTO preferences(owner_id,notification_rule) VALUES($1,$2)
               ON CONFLICT(owner_id) DO UPDATE SET notification_rule=EXCLUDED.notification_rule`,
              [ownerId, rule],
            );
          await setRule('');
          aligned = false;
          const event = await begin('Synthetic event', { source: 'event' });
          compareVerdict(
            await trust.check(event, 'GMAIL_SEND_EMAIL', email('ana.named@example.test')),
            { confirm: true, reason: 'background' },
          );
          assert.equal(reviews.at(-1)?.userMessages, undefined);
          assert.equal(reviews.at(-1)?.scheduledTaskInstruction, undefined);
          assert.equal(reviews.at(-1)?.standingInstruction, undefined);
          const standing = 'Whenever Ana sends an invoice, forward it to accounting@example.test.';
          await setRule(standing);
          aligned = (input) => input.standingInstruction === standing;
          compareVerdict(
            await trust.check(event, 'GMAIL_FORWARD_MESSAGE', {
              message_id: 'synthetic-invoice',
              recipient_email: 'accounting@example.test',
            }),
            { confirm: false, basis: { kind: 'standing', quote: standing.slice(0, -1) } },
          );
          assert.equal(reviews.at(-1)?.userMessages, undefined);
          await trust.check(await begin('Check my inbox.'), 'GMAIL_FETCH_EMAILS', {});
          assert.equal(reviews.at(-1)?.standingInstruction, undefined);
          const scheduled = await begin('Synthetic scheduled work', { source: 'schedule' });
          compareVerdict(
            await trust.check(scheduled, 'GOOGLECALENDAR_PATCH_EVENT', {
              event_id: 'synthetic-shared',
              start_time: '10:00',
            }),
            { confirm: true, reason: 'schedule' },
          );
          const instruction = 'Every Monday, move the synthetic standup to 10:00.';
          const authorized = await begin('Synthetic scheduled work', { source: 'schedule' });
          const scheduleId = randomUUID();
          await db.pool.query(
            `INSERT INTO schedules(id,owner_id,title,prompt,cron,time_zone,kind)
             VALUES($1,$2,'Synthetic standup','Move the synthetic standup.','0 7 * * 1','Europe/Madrid','recurring')`,
            [scheduleId, ownerId],
          );
          await db.pool.query(
            `INSERT INTO schedule_runs(id,owner_id,schedule_id,schedule_revision,job_id,title,turn_id,scheduled_for,time_zone,authority_instruction)
             VALUES($1,$2,$3,1,$4,'Synthetic standup',$5,'2026-10-19T07:00:00Z','Europe/Madrid',$6)`,
            [randomUUID(), ownerId, scheduleId, randomUUID(), authorized.turnId, instruction],
          );
          aligned = (input) =>
            input.scheduledTaskInstruction === instruction &&
            input.scheduledFor === '2026-10-19T09:00:00+02:00' &&
            input.timeZone === 'Europe/Madrid';
          compareVerdict(
            await trust.check(authorized, 'GOOGLECALENDAR_PATCH_EVENT', {
              event_id: 'synthetic-standup',
              start_time: '10:00',
            }),
            { confirm: false, basis: { kind: 'schedule', quote: instruction.slice(0, -1) } },
          );
          assert.equal(reviews.at(-1)?.userMessages, undefined);
          assert.equal(reviews.at(-1)?.standingInstruction, undefined);
          for (const undecided of [
            () => {
              throw new Error('Synthetic checker failure.');
            },
            () => ({ run: true, because: 'Words the owner never wrote.' }),
          ]) {
            aligned = undecided;
            for (const turn of [event, authorized])
              await assert.rejects(
                trust.check(turn, 'GOOGLECALENDAR_EVENTS_LIST', { calendarId: 'primary' }),
              );
          }
          aligned = false;
          let described: ApprovalDescription | undefined;
          describe = async (proposal) => {
            described = proposal;
            return defaultDescription();
          };
          await approvals.request(authorized, 'GOOGLECALENDAR_PATCH_EVENT', {
            event_id: 'synthetic-standup',
            start_time: '11:00',
          });
          describe = defaultDescription;
          assert.deepEqual(described?.work, {
            kind: 'schedule',
            title: 'Synthetic standup',
            ownerRequest: instruction,
            waitsForAnswer: true,
          });
          await finish(authorized.turnId, 'cancelled');
          await setRule('');
        },
      );

      await t.test(
        'owner rules reach the checker in chat, scheduled and background work, only owners with rules get the rules prompt, and only a real rule is named as the reason to ask',
        async () => {
          const setRules = (rules: string) =>
            db.pool.query(
              `INSERT INTO preferences(owner_id,rules) VALUES($1,$2)
               ON CONFLICT(owner_id) DO UPDATE SET rules=EXCLUDED.rules`,
              [ownerId, rules],
            );
          const send = email('ana.named@example.test');
          await setRules('');
          aligned = true;
          const chat = await begin('Send Ana the synthetic update.');
          assert.equal((await trust.check(chat, 'GMAIL_SEND_EMAIL', send)).confirm, false);
          assert.equal(reviews.at(-1)?.userRules, undefined);
          const plain = prompts.at(-1)!;
          assert.doesNotMatch(plain, /userRules/);
          aligned = false;
          ruled = true;
          compareVerdict(await trust.check(chat, 'GMAIL_SEND_EMAIL', { ...send }), {
            confirm: true,
            reason: 'unrequested',
          });
          const rules = 'Always ask me before sending any email.';
          await setRules(`  ${rules}\n`);
          aligned = (input) => input.userRules === undefined;
          for (const turn of [
            chat,
            await begin('Synthetic event', { source: 'event' }),
            await begin('Synthetic scheduled work', { source: 'schedule' }),
          ]) {
            compareVerdict(await trust.check(turn, 'GMAIL_SEND_EMAIL', send), {
              confirm: true,
              reason: 'rule',
            });
            assert.equal(reviews.at(-1)?.userRules, rules);
            assert.ok(prompts.at(-1)!.startsWith(plain));
            assert.match(prompts.at(-1)!, /userRules/);
          }
          ruled = false;
          compareVerdict(
            await trust.check(
              await begin('Synthetic event', { source: 'event' }),
              'GMAIL_SEND_EMAIL',
              send,
            ),
            { confirm: true, reason: 'background' },
          );
          await setRules('');
          await trust.check(chat, 'NOD_notification_preferences_update', {
            rules,
            currentRules: '',
          });
          assert.equal(reviews.at(-1)?.userRules, undefined);
          assert.match(prompts.at(-1)!, /currentRules/);
        },
      );

      await t.test(
        'sign-in authority comes from the checker or an owned yes bound to the exact site and item',
        async () => {
          const { createVaultAccess } = await import('../src/server/vault-access.ts');
          const site = 'https://bank.example.test';
          const first = randomUUID();
          const second = randomUUID();
          const access = await createVaultAccess(db.pool, { ownerId, check: trust.check });
          const confirmAccess = async (
            turn: { threadId: string; turnId: string },
            args: Record<string, unknown>,
          ) => {
            const id = await propose(turn, 'NOD_vault_allow', args);
            await finish(turn.turnId);
            await confirm(id, true);
            await execute(id);
            const record = await stored(id);
            assert.equal(record.status, 'completed');
            return { threadId: turn.threadId, turnId: record.execution_turn_id as string };
          };
          const group = await begin('Open my work dashboard.');
          const target = {
            origin: 'https://workspace.example.test',
            kind: 'session' as const,
            itemId: first,
          };
          const session = await access.authorize(group, target);
          assert.ok('details' in session);
          assert.deepEqual(reviews.at(-1)?.action.name, 'NOD_browser_session');
          const groupResumed = await confirmAccess(group, session.args);
          const afterGroup = reviews.length;
          assert.deepEqual(await access.authorize(groupResumed, target), {
            ok: true,
            reason: 'allowed',
            basis: { kind: 'approved' },
          });
          assert.equal(reviews.length, afterGroup);
          const task = await begin('Download my bank statement.');
          const signIn = await access.authorize(task, {
            origin: site,
            kind: 'sign_in',
            itemId: first,
          });
          assert.ok('details' in signIn);
          const resumed = await confirmAccess(task, signIn.args);
          assert.deepEqual(
            await access.authorize(resumed, { origin: site, kind: 'sign_in', itemId: first }),
            { ok: true, reason: 'allowed', basis: { kind: 'approved' } },
          );
          for (const other of [
            { origin: site, kind: 'sign_in' as const, itemId: second },
            { origin: site, kind: 'session' as const, itemId: first },
            { origin: 'https://other.example.test', kind: 'sign_in' as const, itemId: first },
          ])
            assert.ok('details' in (await access.authorize(resumed, other)));
          assert.ok(
            'details' in
              (await access.authorize(await begin('Check what is due.'), {
                origin: site,
                kind: 'sign_in',
                itemId: first,
              })),
          );
          aligned = (input) =>
            input.action?.name === 'NOD_sign_in' &&
            input.action.arguments.website === site &&
            input.userMessages?.at(-1)?.text === 'Download my bank statement now.';
          const requested = await begin('Download my bank statement now.');
          const download = (
            await db.pool.query(
              "SELECT id FROM messages WHERE owner_id=$1 AND role='user' AND text=$2",
              [ownerId, 'Download my bank statement now.'],
            )
          ).rows[0].id;
          assert.deepEqual(
            await access.authorize(requested, { origin: site, kind: 'sign_in', itemId: first }),
            {
              ok: true,
              reason: 'asked',
              basis: {
                kind: 'message',
                messageId: download,
                quote: 'Download my bank statement now',
              },
            },
          );
          aligned = false;
          const background = await begin('Synthetic background work', { source: 'event' });
          const verdict = await access.authorize(background, {
            origin: site,
            kind: 'session',
            itemId: first,
          });
          assert.ok('details' in verdict);
          assert.equal(reviews.at(-1)?.userMessages, undefined);
          await access.record(requested, {
            action: 'sign_in',
            origin: site,
            reason: 'asked',
            itemId: first,
            itemKind: 'login',
            basis: { kind: 'message', messageId: download, quote: 'Download my bank statement' },
          });
          await access.record(requested, {
            action: 'sign_in',
            origin: site,
            reason: 'asked',
            itemId: second,
            itemKind: 'login',
            basis: {
              kind: 'message',
              messageId: randomUUID(),
              quote: 'Download my bank statement',
            },
          });
          const listed = (await access.activity({ origin: site })).entries;
          assert.deepEqual(listed.find((entry) => entry.itemId === first)?.because, {
            kind: 'message',
            text: 'Download my bank statement',
          });
          assert.equal(listed.find((entry) => entry.itemId === second)?.because, undefined);
        },
      );

      await t.test('payments from a chat app are approved outside it', async () => {
        assert.equal(await trust.inNod(await begin('Buy hinges at shop.example.test.')), true);
        assert.equal(
          await trust.inNod(
            await begin('Buy hinges at shop.example.test.', { channel: 'telegram:synthetic' }),
          ),
          false,
        );
        assert.equal(
          await trust.inNod(
            await begin('Buy hinges at shop.example.test.', { channel: 'whatsapp:synthetic' }),
          ),
          false,
        );
        assert.equal(await trust.inNod(await begin('Synthetic event', { source: 'event' })), true);
      });

      await t.test(
        'saved task authority excludes owner instructions addressed to other work',
        async (t) => {
          const parent = await begin('Read my fixture flight dates.');
          const preTaskQuestion = randomUUID();
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,'assistant','Should I include the fixture taxes?')",
            [preTaskQuestion, ownerId, parent.threadId, parent.turnId],
          );
          const preTaskReply = await messages.submit('Include the fixture taxes.', [], {
            replyToMessageId: preTaskQuestion,
          });
          await finish(preTaskReply.turnId, 'succeeded');
          const oldStatus = randomUUID();
          t.after(() => finish(parent.turnId, 'cancelled'));
          const source = (await row(parent.turnId)).message_id;
          const assigned = await tasks.execute(
            parent,
            {
              action: 'start',
              title: 'Flight dates',
              message: 'Checking flight dates.',
              doneWhen: 'Dates checked',
              now: 'Reading',
            },
            source,
          );
          assert.ok('id' in assigned);
          const task = assigned as { id: string; messageId: string };
          assert.equal(
            (await db.pool.query('SELECT text FROM messages WHERE id=$1', [task.messageId])).rows[0]
              .text,
            'Checking flight dates.',
          );
          t.after(async () => {
            await db.pool.query('DELETE FROM messages WHERE id=$1', [oldStatus]);
            await db.pool.query(
              "UPDATE turns SET task_id=NULL,status='cancelled',finished_at=now() WHERE task_id=$1",
              [task.id],
            );
            await db.pool.query('DELETE FROM tasks WHERE id=$1', [task.id]);
          });
          await finish(parent.turnId, 'succeeded');
          const worker = (
            await db.pool.query("SELECT id FROM turns WHERE task_id=$1 AND source='task'", [
              task.id,
            ])
          ).rows[0].id;
          const turn = await running(worker);
          await tasks.inherit(turn);
          const hotel = await begin('Send the separate hotel request to hotel@example.test.');
          t.after(() => finish(hotel.turnId, 'cancelled'));
          const summaryMessageId = randomUUID();
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,'assistant','Do you want the fixture summary?')",
            [summaryMessageId, ownerId, hotel.threadId, hotel.turnId],
          );
          await finish(hotel.turnId, 'succeeded');
          await trust.check(turn, 'GMAIL_SEND_EMAIL', { to: 'hotel@example.test' });
          const started = reviews.at(-1)!.userMessages.map((item: { text: string }) => item.text);
          assert.deepEqual(started.slice(-2), [
            'Read my fixture flight dates.',
            'Include the fixture taxes.',
          ]);
          assert.equal(
            started.includes('Send the separate hotel request to hotel@example.test.'),
            false,
          );
          const oldApproval = await propose(turn, 'GMAIL_SEND_EMAIL', { to: 'hotel@example.test' });
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,thread_id,role,text,reply_to_message_id) SELECT $1,$2,thread_id,'assistant','Saved task question',confirmation_message_id FROM approvals WHERE id=$3",
            [oldStatus, ownerId, oldApproval],
          );
          const mainReplySubmission = await messages.submit('Yes.', [], {
            replyToMessageId: summaryMessageId,
          });
          const mainReply = await running(mainReplySubmission.turnId);
          t.after(() => finish(mainReply.turnId, 'cancelled'));
          await trust.check(mainReply, 'GMAIL_SEND_EMAIL', { to: 'hotel@example.test' });
          assert.equal(
            reviews.at(-1)!.assistantMessageBeforeLatestUserMessage,
            'Do you want the fixture summary?',
          );
          await finish(mainReply.turnId, 'succeeded');
          const update = await messages.submit('Use the new fixture flight dates.', [], {
            replyToMessageId: task.messageId,
          });
          await finish(worker);
          assert.equal(await confirm(oldApproval, true), undefined);
          assert.equal(
            await confirm(oldApproval, true, { replyToMessageId: oldStatus }),
            undefined,
          );
          const continued = await running(update.turnId);
          await tasks.inherit(continued);
          assert.equal(await confirm(oldApproval, true), undefined);
          const freshApproval = await propose(continued, 'GMAIL_SEND_EMAIL', {
            to: 'hotel@example.test',
          });
          assert.notEqual(freshApproval, oldApproval);
          assert.equal((await stored(oldApproval)).status, 'expired');
          await db.pool.query("UPDATE approvals SET status='expired' WHERE id=$1", [freshApproval]);
          await trust.check(continued, 'GMAIL_FETCH_EMAILS', {});
          const words = reviews.at(-1)!.userMessages.map((item: { text: string }) => item.text);
          assert.deepEqual(words.slice(-3), [
            'Read my fixture flight dates.',
            'Include the fixture taxes.',
            'Use the new fixture flight dates.',
          ]);
          assert.equal(
            words.includes('Send the separate hotel request to hotel@example.test.'),
            false,
          );
          await tasks.execute(
            continued,
            { action: 'finish', id: task.id, status: 'done', result: 'Dates checked' },
            update.messageId,
          );
          await finish(update.turnId, 'succeeded');
          const chat = await begin('Summarise the fixture tasks.');
          t.after(() => finish(chat.turnId, 'cancelled'));
          await trust.check(chat, 'GMAIL_FETCH_EMAILS', {});
          const chatMessages = reviews.at(-1)!.userMessages as Array<{
            text: string;
            canAuthorize: boolean;
          }>;
          assert.equal(
            chatMessages.find((item) => item.text === 'Include the fixture taxes.')?.canAuthorize,
            false,
          );
          assert.equal(
            chatMessages.some((item) => item.text === 'Use the new fixture flight dates.'),
            false,
          );
          await finish(chat.turnId, 'succeeded');
        },
      );

      await t.test(
        'a repeated relay of one owner message delivers once and does not reset the spending boundary',
        async (t) => {
          const parent = await begin('Draft the fixture relay plan.');
          const task = (await tasks.execute(
            parent,
            {
              action: 'start',
              title: 'Fixture relay',
              message: 'Working on the fixture relay.',
              doneWhen: 'Done',
              now: 'Working',
            },
            (await row(parent.turnId)).message_id,
          )) as { id: string };
          t.after(async () => {
            await db.pool.query(
              "UPDATE turns SET task_id=NULL,status='cancelled',finished_at=now() WHERE task_id=$1",
              [task.id],
            );
            await db.pool.query('DELETE FROM tasks WHERE id=$1', [task.id]);
          });
          await finish(parent.turnId, 'succeeded');
          const owner = await begin('Send the fixture relay details to Ana.');
          t.after(() => finish(owner.turnId, 'cancelled'));
          const ownerMessageId = (await row(owner.turnId)).message_id;
          await tasks.execute(owner, { action: 'reply', ids: [task.id] }, ownerMessageId);
          await tasks.execute(owner, { action: 'reply', ids: [task.id] }, ownerMessageId);
          const delivered = (
            await db.pool.query(
              "SELECT id FROM turns WHERE task_id=$1 AND source='task' AND message_id=$2",
              [task.id, ownerMessageId],
            )
          ).rows;
          assert.equal(delivered.length, 1);
          const revision = (
            await db.pool.query('SELECT revision FROM tasks WHERE id=$1', [task.id])
          ).rows[0].revision;
          assert.equal(revision, 2);
          await finish(owner.turnId, 'succeeded');
        },
      );

      await t.test(
        'a relayed owner message shows a task only its own question, and only the main chat steers or stops tasks',
        async (t) => {
          const start = async (request: string, title: string) => {
            const parent = await begin(request);
            const task = (await tasks.execute(
              parent,
              {
                action: 'start',
                title,
                message: `Working on ${title}.`,
                doneWhen: 'Done',
                now: 'Working',
              },
              (await row(parent.turnId)).message_id,
            )) as { id: string };
            t.after(async () => {
              await db.pool.query(
                "UPDATE turns SET task_id=NULL,status='cancelled',finished_at=now() WHERE task_id=$1",
                [task.id],
              );
              await db.pool.query('DELETE FROM tasks WHERE id=$1', [task.id]);
            });
            await finish(parent.turnId, 'succeeded');
            return task;
          };
          const relay = async (text: string, taskId: string) => {
            const owner = await begin(text);
            await tasks.execute(
              owner,
              { action: 'reply', ids: [taskId] },
              (await row(owner.turnId)).message_id,
            );
            await finish(owner.turnId, 'succeeded');
            const relayed = await running(
              (
                await db.pool.query('SELECT id FROM turns WHERE task_id=$1 AND parent_turn_id=$2', [
                  taskId,
                  owner.turnId,
                ])
              ).rows[0].id,
            );
            await tasks.inherit(relayed);
            await trust.check(relayed, 'NOD_browser', { website: 'https://dentist.example.test' });
            await finish(relayed.turnId, 'succeeded');
            return reviews.at(-1)!;
          };
          const dentist = await start('Find a fixture dentist slot.', 'Fixture dentist');
          const worker = await running(
            (
              await db.pool.query("SELECT id FROM turns WHERE task_id=$1 AND source='task'", [
                dentist.id,
              ])
            ).rows[0].id,
          );
          const question = 'Fixture dentist has Tuesday 10:00. Shall I book it?';
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,'assistant',$5)",
            [randomUUID(), ownerId, worker.threadId, worker.turnId, question],
          );
          await db.pool.query(
            "UPDATE turns SET status='waiting',waiting_reason='question' WHERE id=$1",
            [worker.turnId],
          );
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text,hidden_at) VALUES($1,$2,$3,$4,'assistant','Retired schedule confirmation fixture',now())",
            [randomUUID(), ownerId, worker.threadId, worker.turnId],
          );
          assert.equal(
            (await relay('Yes.', dentist.id)).assistantMessageBeforeLatestUserMessage,
            question,
          );
          const chat = await begin('Anything else pending?');
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,'assistant','Shall I send the fixture summary to Ana now?')",
            [randomUUID(), ownerId, chat.threadId, chat.turnId],
          );
          await finish(chat.turnId, 'succeeded');
          assert.equal(
            'assistantMessageBeforeLatestUserMessage' in (await relay('Yes.', dentist.id)),
            false,
          );
          const parcel = await start('Watch the fixture parcel.', 'Fixture parcel');
          const backgrounds: string[] = [];
          for (const source of ['event', 'schedule'] as const) {
            const background = await begin('Synthetic background work.', { source });
            backgrounds.push(background.turnId);
            t.after(() => finish(background.turnId, 'cancelled'));
            await assert.rejects(
              tasks.execute(background, { action: 'stop', id: parcel.id }, null),
            );
            const answer = (await row(chat.turnId)).message_id;
            await db.pool.query('UPDATE turns SET message_id=$2 WHERE id=$1', [
              background.turnId,
              answer,
            ]);
            await assert.rejects(
              tasks.execute(background, { action: 'stop', id: parcel.id }, answer),
            );
            await assert.rejects(tasks.execute(background, { action: 'stop' }, answer));
          }
          const stopper = await begin('Stop the fixture dentist task.');
          t.after(() => finish(stopper.turnId, 'cancelled'));
          await tasks.execute(
            stopper,
            { action: 'stop', id: dentist.id },
            (await row(stopper.turnId)).message_id,
          );
          const reopen = await begin('Yes.');
          t.after(() => finish(reopen.turnId, 'cancelled'));
          await assert.rejects(
            tasks.execute(
              reopen,
              { action: 'reply', ids: [dentist.id] },
              (await row(reopen.turnId)).message_id,
            ),
          );
          const states = (
            await db.pool.query('SELECT id,state FROM tasks WHERE id=ANY($1::uuid[])', [
              [dentist.id, parcel.id],
            ])
          ).rows;
          assert.deepEqual(Object.fromEntries(states.map((task) => [task.id, task.state])), {
            [dentist.id]: 'cancelled',
            [parcel.id]: 'open',
          });
          assert.equal(
            (
              await db.pool.query('SELECT id FROM turns WHERE task_id=$1 AND parent_turn_id=$2', [
                dentist.id,
                reopen.turnId,
              ])
            ).rowCount,
            0,
          );
          const everything = await begin('Stop everything you are doing.');
          t.after(() => finish(everything.turnId, 'cancelled'));
          const stopped = await tasks.execute(
            everything,
            { action: 'stop' },
            (await row(everything.turnId)).message_id,
          );
          assert.deepEqual(Object.keys(stopped), ['stopped']);
          assert.deepEqual((stopped as { stopped: { tasks: string[] } }).stopped.tasks, [
            'Fixture parcel',
          ]);
          for (const turnId of backgrounds) assert.equal(await turnStatus(turnId), 'cancelled');
          for (const turnId of [everything.turnId, reopen.turnId])
            assert.equal(await turnStatus(turnId), 'running');
          assert.equal(
            (await db.pool.query('SELECT state FROM tasks WHERE id=$1', [parcel.id])).rows[0].state,
            'cancelled',
          );
        },
      );

      await t.test(
        'revision replies supersede the addressed proposal before a new user turn',
        async () => {
          for (const explicit of [false, true]) {
            const before = calls.length;
            const origin = await begin('A useful change is ready.', { source: 'event' });
            const args = { notificationRule: 'Original preference.' };
            const id = await propose(origin, 'NOD_notification_preferences_update', args);
            await finish(origin.turnId);
            let unrelated: string | undefined;
            if (explicit)
              unrelated = await propose(
                await begin('Another useful decision.', { source: 'event' }),
                'NOD_notification_preferences_update',
                { notificationRule: 'A separate proposal.' },
              );
            const revised = await messages.submit('Update my preferences to be shorter.', [], {
              ...(explicit ? { replyToMessageId: (await stored(id)).confirmation_message_id } : {}),
            });
            const resumed = await row(revised.turnId);
            assert.equal(resumed.source, 'user');
            assert.equal((await stored(id)).status, 'expired');
            assert.equal(await turnStatus(origin.turnId), explicit ? 'waiting' : 'cancelled');
            assert.equal(resumed.background, explicit);
            assert.equal(resumed.parent_turn_id, explicit ? origin.turnId : null);
            if (explicit) assert.equal(resumed.session_id, (await row(origin.turnId)).session_id);
            if (unrelated) assert.equal((await stored(unrelated)).status, 'pending');
            assert.equal(await confirm(id, true), undefined);
            const next = await propose(
              await running(revised.turnId),
              'NOD_notification_preferences_update',
              {
                notificationRule: 'Shorter preference.',
              },
            );
            assert.equal((await stored(next)).status, 'pending');
            assert.equal(calls.length, before);
            await confirm(next, true);
            await execute(next);
            await execute(next);
            assert.equal(calls.length, before + 1);
            assert.equal(calls.at(-1)?.args.notificationRule, 'Shorter preference.');
          }
          const before = calls.length;
          const origin = await begin('A useful change is ready.', { source: 'event' });
          const id = await propose(origin, 'NOD_notification_preferences_update', {
            notificationRule: 'Original preference.',
          });
          const confirmationMessageId = (await stored(id)).confirmation_message_id;
          const result = await messages.submit(
            'Yes',
            [
              await artifacts.storeUpload(
                Buffer.from('revision fixture'),
                'revision.txt',
                'text/plain',
              ),
            ],
            { replyToMessageId: confirmationMessageId },
          );
          assert.equal((await row(result.turnId)).source, 'user');
          assert.equal((await row(result.turnId)).parent_turn_id, origin.turnId);
          assert.equal(await turnStatus(origin.turnId), 'running');
          assert.equal((await stored(id)).status, 'expired');
          assert.equal(await confirm(id, true), undefined);
          assert.equal(calls.length, before);
        },
      );

      await t.test(
        'an unquoted clarification leaves a saved task with a visible way to continue',
        async (t) => {
          const parent = await begin(
            'Summarise the synthetic inbox and ask before sending anything.',
          );
          const task = (await tasks.execute(
            parent,
            {
              action: 'start',
              title: 'Synthetic inbox review',
              message: 'Reviewing the synthetic inbox.',
              doneWhen: 'The summary is ready',
              now: 'Reading the synthetic inbox',
            },
            (await row(parent.turnId)).message_id,
          )) as { id: string };
          t.after(async () => {
            await db.pool.query(
              "UPDATE turns SET task_id=NULL,status='cancelled',finished_at=now() WHERE task_id=$1",
              [task.id],
            );
            await db.pool.query('DELETE FROM tasks WHERE id=$1', [task.id]);
          });
          await finish(parent.turnId, 'succeeded');
          const workerId = (
            await db.pool.query("SELECT id FROM turns WHERE task_id=$1 AND source='task'", [
              task.id,
            ])
          ).rows[0].id as string;
          const worker = await running(workerId);
          const before = calls.length;
          const approvalId = await propose(
            worker,
            'GMAIL_SEND_EMAIL',
            email('synthetic-recipient@example.test'),
          );
          const confirmationId = (await stored(approvalId)).confirmation_message_id;
          await finish(workerId);

          const clarification = await messages.submit('wait what does that mean');
          assert.equal((await row(clarification.turnId)).source, 'user');
          assert.equal((await stored(approvalId)).status, 'expired');
          assert.equal(await turnStatus(workerId), 'cancelled');
          assert.equal(calls.length, before);

          const response = await request('GET', '/api/tasks');
          assert.equal(response.statusCode, 200, response.body);
          const detail = response
            .json<
              Array<{
                id: string;
                status: string;
                now: string;
                question: string | null;
                questionMessageId: string | null;
              }>
            >()
            .find((item) => item.id === task.id);
          assert.ok(detail);
          assert.equal(detail.status, 'needs_you');
          assert.equal(detail.now, 'Reading the synthetic inbox');
          assert.match(detail.question ?? '', /did not run.*Reply here to continue/i);
          assert.ok(detail.questionMessageId);
          assert.notEqual(detail.questionMessageId, confirmationId);
          const continuation = (
            await db.pool.query('SELECT turn_id,text FROM messages WHERE id=$1 AND owner_id=$2', [
              detail.questionMessageId,
              ownerId,
            ])
          ).rows[0];
          assert.equal(continuation.turn_id, workerId);
          assert.equal(continuation.text, detail.question);
          assert.equal(
            (
              await db.pool.query('SELECT created_at FROM messages WHERE id=$1 AND owner_id=$2', [
                detail.questionMessageId,
                ownerId,
              ])
            ).rows[0].created_at >
              (
                await db.pool.query('SELECT created_at FROM messages WHERE id=$1 AND owner_id=$2', [
                  clarification.messageId,
                  ownerId,
                ])
              ).rows[0].created_at,
            true,
          );

          const resumed = await messages.submit('Continue the remaining synthetic summary.', [], {
            replyToMessageId: detail.questionMessageId,
          });
          const resumedTurn = await row(resumed.turnId);
          assert.equal(resumedTurn.session_id, task.id);
          assert.equal(resumedTurn.parent_turn_id, workerId);
          assert.equal((await stored(approvalId)).status, 'expired');
          assert.equal(calls.length, before);
        },
      );

      await t.test(
        'background turns share one pending confirmation for the same action',
        async () => {
          const args = { id: randomUUID() };
          const turns = await Promise.all([
            begin('A synthetic event proposes a pause.', { source: 'event' }),
            begin('A synthetic scheduled check proposes a pause.', { source: 'schedule' }),
          ]);
          const before = calls.length;
          const results = await Promise.all(
            turns.map((turn) => approvals.request(turn, 'NOD_schedule_pause', args)),
          );
          for (const result of results) assert.ok(result[appConfirmation]);
          assert.equal(results[0][appConfirmation], results[1][appConfirmation]);
          const records = (
            await db.pool.query(
              'SELECT * FROM approvals WHERE owner_id=$1 AND thread_id=$2 AND action=$3 AND args=$4::jsonb',
              [ownerId, turns[0]!.threadId, 'NOD_schedule_pause', args],
            )
          ).rows;
          assert.equal(records.length, 1);
          assert.equal(records[0].status, 'pending');
          assert.equal(calls.length, before);
          assert.equal(
            (await assistantMessages(turns[0]!.turnId))! +
              (await assistantMessages(turns[1]!.turnId))!,
            1,
          );
          const original = turns.find((turn) => turn.turnId === records[0].turn_id)!;
          await assert.rejects(approvals.request(original, 'NOD_schedule_pause', args), {
            statusCode: 409,
          });
          const other = await begin('A different schedule needs a pause.', { source: 'event' });
          await propose(other, 'NOD_schedule_pause', { id: randomUUID() });
          assert.equal(await assistantMessages(other.turnId), 1);
          assert.equal(calls.length, before);
        },
      );

      await t.test(
        'a resume that does not trace back to an owner message carries no owner words',
        async () => {
          const generic = await running(
            await thread.enqueueTurn('Synthetic unrelated continuation', { source: 'resume' }),
          );
          await assert.rejects(
            approvals.request(generic, 'NOD_notification_preferences_update', {}),
            /direct request/,
          );
          assert.equal(await proposal(generic.turnId), undefined);
          aligned = true;
          await trust.check(generic, 'GMAIL_SEND_EMAIL', email('owner@example.test'));
          assert.equal(reviews.at(-1)?.userMessages, undefined);
          aligned = false;
          await db.pool.query(
            "UPDATE turns SET status='succeeded',finished_at=now() WHERE status IN ('queued','running')",
          );
        },
      );

      await t.test(
        'approval clicks bind the card, action, and client retry to the same approval',
        async () => {
          const first = await begin('Synthetic first approval');
          const firstId = await propose(first, 'GMAIL_SEND_EMAIL', {
            recipient_email: 'first@example.test',
            subject: 'First',
            body: 'First synthetic message.',
          });
          await finish(first.turnId);
          const second = await begin('Synthetic second approval');
          const secondId = await propose(second, 'GMAIL_SEND_EMAIL', {
            recipient_email: 'second@example.test',
            subject: 'Second',
            body: 'Second synthetic message.',
          });
          await finish(second.turnId);
          const firstCard = await stored(firstId);
          const input = {
            text: 'Send',
            threadId: first.threadId,
            replyToMessageId: firstCard.confirmation_message_id,
            clientMessageId: randomUUID(),
            approvalAnswer: { approvalId: secondId, approved: true },
          };
          const refused = await request('POST', '/api/messages', input);
          assert.equal(refused.statusCode, 409, refused.body);
          assert.equal((await stored(firstId)).status, 'pending');
          assert.equal((await stored(secondId)).status, 'pending');
          assert.equal(
            (await db.pool.query('SELECT 1 FROM messages WHERE id=$1', [input.clientMessageId]))
              .rowCount,
            0,
          );
          const valid = { ...input, approvalAnswer: { approvalId: firstId, approved: true } };
          const accepted = await request('POST', '/api/messages', valid);
          assert.equal(accepted.statusCode, 200, accepted.body);
          assert.deepEqual((await request('POST', '/api/messages', valid)).json(), accepted.json());
          const changed = await request('POST', '/api/messages', input);
          assert.equal(changed.statusCode, 409, changed.body);
          assert.equal((await stored(secondId)).status, 'pending');
          const shownState = async () =>
            (await request('GET', `/api/messages/around/${firstCard.confirmation_message_id}`))
              .json()
              .find((message: { id: string }) => message.id === firstCard.confirmation_message_id)
              .approval.state;
          assert.equal(await shownState(), 'working');
          await finish(first.turnId, 'cancelled');
          await finish(second.turnId, 'cancelled');
          await finish(accepted.json().turnId, 'cancelled');
          const before = calls.length;
          await assert.rejects(
            approvals.executeConfirmed(accepted.json().turnId, new AbortController().signal),
          );
          assert.equal(calls.length, before);
          assert.equal(await shownState(), 'expired');
          await db.pool.query("UPDATE approvals SET status='executing' WHERE id=$1", [firstId]);
          assert.equal(await shownState(), 'uncertain');
          await db.pool.query("UPDATE approvals SET status='completed' WHERE id=$1", [firstId]);
          assert.equal(await shownState(), 'done');
          await db.pool.query("UPDATE approvals SET status='confirmed' WHERE id=$1", [firstId]);
        },
      );

      await t.test(
        'a channel confirmation preserves the exact snapshot and client retries do not execute twice',
        async (t) => {
          const analyticsEvents: Parameters<ProductAnalytics['capture']>[0][] = [];
          const analytics = await createAnalytics({
            provider: { capture: (event) => analyticsEvents.push(event), shutdown: async () => {} },
            environment: 'development',
            dataRoot,
            installationId: randomUUID(),
          });
          t.after(() => analytics.shutdown());
          analytics.setUsageData(ownerId, true);
          const capture = analytics.forOwner(ownerId);
          const observedMessages = thread.createUserMessageService({
            confirmAction: approvals.chat,
            accepted: () => {
              const snapshot = snapshotAnalytics(capture);
              return (channel) =>
                snapshot?.({
                  event: 'owner_message_accepted',
                  properties: { channel: channel === 'web' ? 'web' : 'telegram' },
                });
            },
          });
          const acceptedEvents = () =>
            analyticsEvents.filter((event) => event.event === 'owner_message_accepted');
          const channel = 'telegram:fixture';
          const turn = await begin('Synthetic channel fixture', { channel });
          const turnIds = [turn.turnId];
          const statusMessageId = randomUUID();
          const foreignStatus = randomUUID();
          t.after(async () => {
            await db.pool.query(
              'UPDATE messages SET reply_to_message_id=NULL WHERE reply_to_message_id=ANY($1::uuid[])',
              [[statusMessageId, foreignStatus]],
            );
            await db.pool.query('DELETE FROM messages WHERE id=ANY($1::uuid[])', [
              [statusMessageId, foreignStatus],
            ]);
            await db.pool.query(
              "UPDATE turns SET status='cancelled',finished_at=now() WHERE id=ANY($1::uuid[]) AND status IN ('queued','running','waiting')",
              [turnIds],
            );
          });
          const args = { notificationRule: 'Synthetic original' };
          await approvals.request(turn, 'NOD_notification_preferences_update', args);
          const saved = await proposal(turn.turnId);
          args.notificationRule = 'Substituted after proposal';
          await finish(turn.turnId);
          const clientMessageId = randomUUID();
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,thread_id,role,text,reply_to_message_id,delivered_channel) VALUES($1,$2,$3,'assistant',$4,$5,$6)",
            [
              statusMessageId,
              ownerId,
              turn.threadId,
              'Saved task question',
              saved.confirmation_message_id,
              channel,
            ],
          );
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,thread_id,role,text,reply_to_message_id) VALUES($1,'foreign-owner',$2,'assistant',$3,$4)",
            [foreignStatus, turn.threadId, 'Foreign question', saved.confirmation_message_id],
          );
          assert.equal(
            await approvals.chat.answer({ threadId: turn.threadId, channel, text: 'Yes' }),
            undefined,
          );
          assert.equal(
            await approvals.chat.answer({
              threadId: turn.threadId,
              channel,
              text: 'Yes',
              replyToMessageId: foreignStatus,
            }),
            undefined,
          );
          const reply = {
            channel,
            replyToMessageId: statusMessageId,
            clientMessageId,
            sourceId: `channel:telegram:fixture:${randomUUID()}`,
          };
          await assert.rejects(
            observedMessages.submit('Yes.', [], {
              ...reply,
              persistSubmission: async () => {
                throw new Error('Synthetic confirmation rollback.');
              },
            }),
            /Synthetic confirmation rollback/,
          );
          assert.equal((await proposal(turn.turnId)).status, 'pending');
          assert.deepEqual(acceptedEvents(), []);
          let insertions = 0;
          const accepted = await observedMessages.submit('Yes.', [], {
            ...reply,
            onInserted: () => {
              insertions++;
            },
          });
          turnIds.push(accepted.turnId);
          assert.notEqual(accepted.turnId, turn.turnId);
          assert.deepEqual(
            await observedMessages.submit('Yes.', [], { ...reply, onInserted: () => insertions++ }),
            accepted,
          );
          assert.deepEqual(
            await observedMessages.submit('Yes.', [], {
              ...reply,
              clientMessageId: randomUUID(),
              onInserted: () => insertions++,
            }),
            accepted,
          );
          assert.equal(insertions, 1);
          assert.deepEqual(
            acceptedEvents().map((event) => event.properties.channel),
            ['telegram'],
          );
          const confirmed = await proposal(turn.turnId);
          assert.equal(confirmed.status, 'confirmed');
          assert.equal(confirmed.execution_turn_id, accepted.turnId);
          assert.equal((await row(accepted.turnId)).channel, channel);
          const before = calls.length;
          await assert.rejects(
            approvals.executeConfirmed(accepted.turnId, new AbortController().signal),
            /no longer active/,
          );
          await assert.rejects(
            approvals.executeConfirmed(turn.turnId, new AbortController().signal),
            /no longer active/,
          );
          await running(accepted.turnId);
          assert.ok(
            await approvals.executeConfirmed(accepted.turnId, new AbortController().signal),
          );
          assert.equal(calls.length, before + 1);
          assert.equal(calls.at(-1)?.args.notificationRule, 'Synthetic original');
          assert.equal(
            await approvals.executeConfirmed(accepted.turnId, new AbortController().signal),
            undefined,
          );
          assert.equal((await proposal(turn.turnId)).status, 'completed');
          await finish(accepted.turnId, 'succeeded');

          const declinedTurn = await begin('Synthetic declined confirmation', { channel: 'web' });
          turnIds.push(declinedTurn.turnId);
          await approvals.request(declinedTurn, 'NOD_notification_preferences_update', {
            notificationRule: 'Synthetic declined',
          });
          await finish(declinedTurn.turnId);
          const declinedReply = {
            channel: 'web',
            replyToMessageId: (await proposal(declinedTurn.turnId)).confirmation_message_id,
            clientMessageId: randomUUID(),
          };
          let declinedInsertions = 0;
          const declined = await observedMessages.submit('No.', [], {
            ...declinedReply,
            onInserted: () => {
              declinedInsertions++;
            },
          });
          turnIds.push(declined.turnId);
          assert.equal((await proposal(declinedTurn.turnId)).status, 'declined');
          assert.deepEqual(
            await observedMessages.submit('No.', [], {
              ...declinedReply,
              onInserted: () => declinedInsertions++,
            }),
            declined,
          );
          assert.equal(declinedInsertions, 1);
          assert.deepEqual(
            acceptedEvents().map((event) => event.properties.channel),
            ['telegram', 'web'],
          );
        },
      );

      await t.test('artifacts are owned and published only from inside the workspace', async () => {
        const { threadId: id } = await newTurn('succeeded');
        const workspace = join(dataRoot, 'workspaces', id);
        const privateDir = await mkdtemp(join(tmpdir(), 'nod-artifact-test-'));
        directories.push(workspace, privateDir);
        await mkdir(workspace, { recursive: true });
        await writeFile(join(privateDir, 'private.txt'), 'private fixture');
        await symlink(join(privateDir, 'private.txt'), join(workspace, 'escape.txt'));
        const read = async (threadId: string, path: string, maxBytes: number) => {
          assert.equal(threadId, id);
          const handle = await open(
            join(workspace, path),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const stat = await handle.stat();
            assert.ok(stat.isFile() && stat.size <= maxBytes);
            return await handle.readFile();
          } finally {
            await handle.close();
          }
        };
        await assert.rejects(
          artifacts.publishArtifact(id, join(privateDir, 'private.txt'), undefined, read),
        );
        await assert.rejects(artifacts.publishArtifact(id, 'escape.txt', undefined, read));
        await writeFile(join(workspace, 'report.html'), '<script>window.fixture=true</script>');
        const published = await artifacts.publishArtifact(
          id,
          'report.html',
          '../../report\r\n.html',
          read,
        );
        assert.equal(published.name, 'report.html');
        await writeFile(join(workspace, 'alert.n8n.json'), '{"nodes":[],"connections":{}}');
        const workflow = await artifacts.publishArtifact(id, 'alert.n8n.json', 'Rain alert', read);
        assert.equal(workflow.name, 'Rain alert.n8n.json');
        const response = await request('GET', published.url);
        assert.equal(response.statusCode, 200);
        await db.pool.query('UPDATE artifacts SET owner_id=$2 WHERE id=$1', [
          published.id,
          'another-owner',
        ]);
        assert.equal((await request('GET', published.url)).statusCode, 404);
        const error = await request('GET', '/api/fixture-error');
        assert.equal(error.statusCode, 500);
        assert.equal(error.body.includes('fixture-private-key'), false);
      });

      await t.test(
        'the reply reader sees only the owner reply and its answer binds to the question it read',
        async () => {
          const reply = 'dale, adelante';
          replyAnswers[reply] = 'yes';
          const ask = async () => {
            const turn = await newTurn();
            const id = await propose(turn, 'NOD_notification_preferences_update', {
              notificationRule: 'Read reply',
            });
            await finish(turn.turnId);
            const record = await stored(id);
            return {
              id,
              input: {
                text: reply,
                channel: 'web',
                threadId: record.thread_id as string,
                replyToMessageId: record.confirmation_message_id as string,
                clientMessageId: randomUUID(),
              },
            };
          };
          const first = await ask();
          const before = replies.length;
          assert.deepEqual(await approvals.chat.answer({ ...first.input, hasAttachments: true }), {
            approvalId: first.id,
          });
          assert.equal(replies.length, before);
          replyAnswers['reader down'] = 'fail';
          const outage = { ...first.input, text: 'reader down' };
          const unread = await approvals.chat.answer(outage);
          assert.equal(unread, undefined);
          assert.equal(
            await transaction(
              (client) => approvals.chat.accept(client, { ...outage, answer: unread }),
              db.pool,
            ),
            undefined,
          );
          assert.equal((await stored(first.id)).status, 'pending');
          delete replyAnswers['reader down'];
          const answer = await approvals.chat.answer(first.input);
          assert.deepEqual(answer, { approvalId: first.id, approved: true });
          assert.deepEqual(replies.at(-1), { reply });
          const emojiReads = replies.length;
          for (const [emoji, approved] of [
            ...['👍', '👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿'].map((value) => [value, true] as const),
            ...['👎', '👎🏻', '👎🏼', '👎🏽', '👎🏾', '👎🏿'].map((value) => [value, false] as const),
          ]) {
            assert.equal(await trust.answer(emoji), approved);
            assert.deepEqual(await approvals.chat.answer({ ...first.input, text: emoji }), {
              approvalId: first.id,
              approved,
            });
          }
          assert.equal(replies.length, emojiReads);
          assert.equal(
            await approvals.chat.answer({
              ...first.input,
              text: '👍',
              replyToMessageId: randomUUID(),
            }),
            undefined,
          );
          assert.equal(await trust.answer('👍 if you can send it tomorrow'), undefined);
          const long = `${'yes '.repeat(400)}but send it elsewhere`;
          assert.equal(await trust.answer(long), undefined);
          assert.deepEqual(replies.at(-1), { reply: long });
          const forged = await transaction(
            (client) =>
              approvals.chat.accept(client, {
                ...first.input,
                answer: { approvalId: randomUUID(), approved: true },
              }),
            db.pool,
          );
          assert.equal(forged, undefined);
          assert.equal((await stored(first.id)).status, 'pending');
          const second = await ask();
          await transaction(
            async (client) =>
              approvals.chat.accept(client, {
                ...second.input,
                answer: await approvals.chat.answer(second.input),
              }),
            db.pool,
          );
          assert.equal((await stored(second.id)).status, 'confirmed');
          const channel = 'telegram:fixture-reply-race';
          const asked = await begin('Synthetic chat-app request', { channel });
          const seen = await propose(asked, 'NOD_notification_preferences_update', {
            notificationRule: 'Seen before the reply',
          });
          await finish(asked.turnId);
          const reading = deferred();
          const held = deferred();
          duringReply = async () => {
            reading.resolve();
            await held.promise;
          };
          const submitted = messages.submit(reply, [], { channel });
          await Promise.race([reading.promise, submitted]);
          duringReply = async () => {};
          const later = await running(
            await thread.enqueueTurn('Synthetic background check', { source: 'event', channel }),
          );
          const unseen = await propose(later, 'NOD_notification_preferences_update', {
            notificationRule: 'Asked while the reply was read',
          });
          await finish(later.turnId);
          held.resolve();
          const answered = await submitted;
          assert.equal((await stored(unseen)).status, 'pending');
          assert.equal(await turnStatus(later.turnId), 'waiting');
          assert.equal((await stored(seen)).status, 'confirmed');
          assert.equal((await stored(seen)).execution_turn_id, answered.turnId);
          delete replyAnswers[reply];
          await thread.stopThread();
        },
      );
    } finally {
      await app.close();
      await thread.stopThreadWorkers();
      const files = (await db.pool.query('SELECT storage_path FROM artifacts')).rows.map((row) =>
        String(row.storage_path),
      );
      await db.pool.end();
      for (const path of files) await rm(path, { force: true });
      for (const path of directories) await rm(path, { recursive: true, force: true });
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
