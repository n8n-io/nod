import assert from 'node:assert/strict';
import test from 'node:test';
import { actionConfirmation } from '../src/server/action-presentation.ts';
import { vaultInvitation } from '../src/runtime/communication.ts';

test('confirmation shows readable target and account without internal identifiers or nested arguments', () => {
  const question = actionConfirmation(
    'GMAIL_DELETE_MESSAGE',
    {
      connectionId: 'connection-private',
      message_id: 'message-private',
      user_id: 'user-private',
      subject: 'Northstar review',
      options: { token: 'token-private', strategy: 'implementation-private' },
    },
    { name: 'Gmail', accountEmail: 'test@example.test' },
  );
  assert.match(question, /^Delete this email using Gmail \(test@example.test\)\?/);
  assert.match(question, /Subject: Northstar review/);
  assert.doesNotMatch(question, /private|message id|user id|options|\{|\}/);
  assert.match(question, /Reply yes to confirm or no to leave it unchanged/);
});

test('goal confirmation uses its owned title, readable changes and escaped user text', () => {
  const question = actionConfirmation(
    'OTTO_goal_update',
    {
      id: 'hidden-goal',
      progress: 50,
      nextAction: '[Click here](https://unsafe.test)',
      status: 'paused',
    },
    undefined,
    'Learn piano',
  );
  assert.match(question, /For: Learn piano/);
  assert.match(question, /Progress: 50%/);
  assert.match(question, /Status: paused/);
  assert.ok(question.includes('Next step: \\[Click here\\]\\(https://unsafe.test\\)'));
  assert.doesNotMatch(question, /hidden-goal|nextAction/);
});

test('connected write confirmation shows bounded request fields and masks secrets', () => {
  const http = actionConfirmation('CONNECTED_HTTP', {
    method: 'PUT',
    path: '/repos/example/file',
    body: { title: 'Update guide', authorization: 'Bearer private-fixture-token' },
  });
  assert.match(http, /Method: PUT/);
  assert.match(http, /Path: \/repos\/example\/file/);
  assert.match(http, /Update guide/);
  assert.doesNotMatch(http, /private-fixture-token/);
  const mcp = actionConfirmation('CONNECTED_MCP_CALL', {
    tool: 'create_record',
    input: { title: 'New record', apiKey: 'private-fixture-key', text: 'x'.repeat(5000) },
  });
  assert.ok(mcp.includes('Tool: create\\_record'));
  assert.match(mcp, /New record/);
  assert.doesNotMatch(mcp, /private-fixture-key/);
  assert.ok(mcp.length < 2500);
});

test('schedule confirmation shows local date and frequency while messages retain useful send details', () => {
  const question = actionConfirmation('OTTO_schedule_create', {
    title: 'Portfolio check',
    timeZone: 'Europe/Lisbon',
    runAt: '2026-09-25T13:21:00Z',
    prompt: 'Review my portfolio',
  });
  assert.match(question, /When: 25 September 2026 at 14:21/);
  assert.match(question, /Time zone: Europe\/Lisbon/);
  assert.doesNotMatch(question, /runAt|timeZone/);
  assert.match(
    actionConfirmation('OTTO_schedule_create', { cron: '*/5 * * * *' }),
    /Every 5 minutes/,
  );
  const send = actionConfirmation('GMAIL_SEND_EMAIL', {
    to: ['alex@example.test'],
    subject: 'Review',
    body: 'The update is ready.',
  });
  for (const expected of [
    'To: alex@example.test',
    'Subject: Review',
    'Message: The update is ready.',
  ])
    assert.ok(send.includes(expected));
});

test('Vault absence copy requires an explicit broker result and uses action-specific secure links', () => {
  const base = {
    origin: 'https://example.test/login?state=private#code',
    kind: 'password' as const,
  };
  const missing = vaultInvitation({ ...base, savedLoginAvailable: false }, '/vault/fixture');
  assert.match(missing, /There isn’t a login saved for this website in Vault/);
  assert.match(missing, /\[Add login\]\(\/vault\/fixture\)/);
  for (const savedLoginAvailable of [true, undefined]) {
    const message = vaultInvitation({ ...base, savedLoginAvailable }, '/vault/fixture');
    assert.doesNotMatch(message, /isn’t|no saved|Add login|state|private|#code/);
    assert.match(message, /^https:\/\/example.test needs you to sign in/);
  }
  const code = vaultInvitation(
    { ...base, kind: 'otp', savedLoginAvailable: false },
    '/vault/fixture',
  );
  assert.match(code, /Reply here with the code/);
  assert.doesNotMatch(code, /isn’t|Add login|\/vault\//);
});
