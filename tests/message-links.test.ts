import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMessageText, safeMessageLink } from '../src/web/lib/message-links.ts';

const origin = 'http://localhost:4310';

test('Apps links use the app route without obsolete aliases', () => {
  for (const path of ['/apps', `${origin}/apps`])
    assert.deepEqual(safeMessageLink(path, origin), { href: '/apps', kind: 'navigation' });
  assert.equal(safeMessageLink('/connections', origin), null);
  assert.equal(safeMessageLink(`${origin}/connections`, origin), null);
  assert.equal(safeMessageLink('/apps/unknown', origin), null);
  const connect = '/apps?connect=7f455e58-c202-4401-bb22-0a4e853a3ef5';
  assert.deepEqual(safeMessageLink(connect, origin), { href: connect, kind: 'navigation' });
  assert.equal(safeMessageLink('/apps?connect=bad', origin), null);
  assert.equal(safeMessageLink(`${connect}&next=https://example.com`, origin), null);
  assert.equal(safeMessageLink(`${connect}#token`, origin), null);
});

test('markdown artifact links show the filename without markdown punctuation', () => {
  const path = '/api/artifacts/cf047140-c98b-496b-96e2-365472458734';
  assert.deepEqual(
    parseMessageText(`Title: Example Domain. Artifact: [browser-check.txt](${path})`, origin),
    [
      { type: 'text', text: 'Title: Example Domain. Artifact: ' },
      { type: 'link', text: 'browser-check.txt', href: path, kind: 'artifact' },
    ],
  );
});

test('credential links use clear labels and omit tokens and fragments', () => {
  const parts = parseMessageText(
    '[Sign in](/credentials/request-id?token=private-token#private-fragment)',
    origin,
  );
  assert.deepEqual(
    parts.filter((part) => part.type === 'link'),
    [
      {
        type: 'link',
        text: 'Sign in',
        href: '/credentials/request-id',
        kind: 'credential',
      },
    ],
  );
  assert.equal(JSON.stringify(parts).includes('private-token'), false);
  assert.equal(safeMessageLink('/approvals/action-id', origin), null);
  assert.equal(safeMessageLink(`${origin}/approvals/action-id`, origin), null);
});

test('only intended app paths and credential-free HTTP URLs become links', () => {
  for (const value of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert',
    'data:text/html,test',
    'file:///etc/passwd',
    'mailto:hello@example.com',
    '//evil.example/api/artifacts/id',
    '/api/vault',
    '/api/artifacts/',
    '/api/artifacts/id/extra',
    '/api/artifacts/id/../../credentials/request',
    '/api/artifacts/%2e%2e/credentials/request',
    '/api/artifacts/id%2f..%2fvault',
    'http://localhost:4310/api/vault',
    'http://localhost:4310/api/artifacts/id/../../credentials/request',
    'https://user:password@example.com/',
    'https://example.com/\njavascript:alert',
    'https:\\evil.example',
    'https://example.com/"onclick="alert',
  ])
    assert.equal(safeMessageLink(value, origin), null, value);
  assert.deepEqual(safeMessageLink('https://example.com/docs?q=otto#usage', origin), {
    href: 'https://example.com/docs?q=otto#usage',
    kind: 'external',
  });
  assert.deepEqual(safeMessageLink('/api/artifacts/file-id', origin), {
    href: '/api/artifacts/file-id',
    kind: 'artifact',
  });
  assert.equal(
    parseMessageText(
      '//evil.example/api/artifacts/id file:///credentials/id javascript:/approvals/id',
      origin,
    ).some((part) => part.type === 'link'),
    false,
  );
});

test('plain URLs keep trailing sentence punctuation outside links and HTML stays text', () => {
  const parts = parseMessageText(
    'See https://example.com/docs. <script>alert(1)</script> [unsafe](javascript:alert) <img src=x onerror=alert(1)>',
    origin,
  );
  assert.deepEqual(
    parts.filter((part) => part.type === 'link'),
    [
      {
        type: 'link',
        text: 'https://example.com/docs',
        href: 'https://example.com/docs',
        kind: 'external',
      },
    ],
  );
  const plain = parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
  assert.match(plain, /\. <script>alert\(1\)<\/script>/);
  assert.match(plain, /\[unsafe\]\(javascript:alert\)/);
  assert.match(plain, /<img src=x onerror=alert\(1\)>/);
});

test('Vault request links retain their safe path and use the canonical label', () => {
  const parts = parseMessageText(
    '/vault/private-link?token=hidden#fragment',
    'http://localhost:4310',
  );
  assert.deepEqual(parts, [
    { type: 'link', text: 'Vault', href: '/vault/private-link', kind: 'credential' },
  ]);
});
