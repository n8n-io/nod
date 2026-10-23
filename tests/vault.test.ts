import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openVaultValue, sealVaultValue } from '../src/server/vault-crypto.ts';
import { securityCodeIn } from '../src/shared/verification-code.ts';
import test from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { runProcess } from '../src/providers/process.ts';
import { Vault } from '../src/web/pages/vault.tsx';
import { Credentials } from '../src/web/pages/credentials.tsx';
import { SetupActions } from '../src/web/components/setup-link.tsx';
import { messageSetupLinks } from '../src/web/lib/message-links.ts';
import { actionLink } from '../src/runtime/communication.ts';
import { PrivateEntryWorkspace, usePrivateEntry } from '../src/web/components/private-entry.tsx';
import { pageDataCache } from '../src/web/lib/page-data-cache.ts';
import { Composio } from '@composio/core';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import type { CredentialKind } from '../src/ports/computer.ts';
import type { IntegrationProvider, VerificationEmail } from '../src/ports/integrations.ts';
import { readVerificationEmails } from '../src/providers/composio/verification-email.ts';
import { accessKey, credentialRequestKey, registerLocalAccess } from '../src/server/access.ts';
import { verificationCode, verificationSenderDomain } from '../src/server/email-code.ts';
import { createIntegrations } from '../src/server/integrations.ts';
import type { TurnRef } from '../src/server/thread.ts';
import {
  credentialOrigin,
  checkedKeyStore,
  createVault,
  openCredential,
  sealCredential,
  type CredentialInjection,
} from '../src/server/vault.ts';
import type {
  CredentialRequest,
  VaultCardEntry,
  VaultLoginEntry,
} from '../src/shared/contracts.ts';
import { parsePasswordCsv } from '../src/shared/password-import.ts';
import { authenticatorKey } from '../src/shared/authenticator-key.ts';
import { authenticatorCode } from '../src/server/authenticator.ts';
import { matchingWebsite } from '../src/providers/onepassword/websites.ts';
import { createOnePassword, forkedOnePassword } from '../src/providers/onepassword/index.ts';
import { PasswordManagerError, type PasswordManager } from '../src/ports/password-manager.ts';
import { createPayments } from '../src/server/payments.ts';
import type { CardEntry } from '../src/ports/computer.ts';

async function seedTurns(pool: pg.Pool) {
  await pool.query(
    'CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz)',
  );
  await pool.query(
    "CREATE TABLE turns(id uuid PRIMARY KEY,parent_turn_id uuid,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text,background boolean NOT NULL DEFAULT false,started_at timestamptz,session_id uuid GENERATED ALWAYS AS (CASE WHEN background THEN id ELSE thread_id END) STORED)",
  );
  const threads = new Map<string, string>();
  const turn = async (owner = 'local-development', background = false) => {
    let threadId = threads.get(owner);
    if (!threadId) {
      threadId = randomUUID();
      threads.set(owner, threadId);
      await pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [threadId, owner]);
    }
    const turnId = randomUUID();
    await pool.query('INSERT INTO turns(id,owner_id,thread_id,background) VALUES($1,$2,$3,$4)', [
      turnId,
      owner,
      threadId,
      background,
    ]);
    return { threadId, turnId };
  };
  const archive = async (owner = 'local-development') => {
    await pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [threads.get(owner)]);
    threads.delete(owner);
  };
  const wait = async (ref: { turnId: string }, reason = 'credentials') => {
    await pool.query(
      "UPDATE turns SET status='waiting',waiting_reason=$2,started_at=coalesce(started_at,clock_timestamp()) WHERE id=$1",
      [ref.turnId, reason],
    );
  };
  const resume = async (ref: { threadId: string; turnId: string }, source = 'credentials') => {
    const turnId = randomUUID();
    await pool.query(
      `INSERT INTO turns(id,owner_id,thread_id,source,source_id,parent_turn_id,started_at)
       SELECT $1,owner_id,thread_id,'resume',$3,id,clock_timestamp() FROM turns WHERE id=$2`,
      [turnId, ref.turnId, `${source}:${ref.turnId}`],
    );
    return { threadId: ref.threadId, turnId };
  };
  return { turn, archive, wait, resume };
}

test('vault encryption binds the secret to its record, owner, and exact origin', () => {
  const key = randomBytes(32);
  const entry = { id: randomUUID(), owner_id: 'local-development', origin: 'https://example.com' };
  const secret = { username: 'private@example.com', password: 'do-not-print-this-password' };
  const ciphertext = sealCredential(key, entry, secret);
  assert.equal(ciphertext.includes(secret.password), false);
  assert.deepEqual(openCredential(key, { ...entry, ciphertext }), secret);
  for (const replacement of [
    { id: randomUUID() },
    { owner_id: 'another-owner' },
    { origin: 'https://other.example.com' },
  ]) {
    assert.throws(() => openCredential(key, { ...entry, ...replacement, ciphertext }));
  }
  const damaged = Buffer.from(ciphertext, 'base64');
  damaged[damaged.length - 1] ^= 1;
  assert.throws(() => openCredential(key, { ...entry, ciphertext: damaged.toString('base64') }));
  assert.throws(() => openCredential(randomBytes(32), { ...entry, ciphertext }));
  const nonce = randomBytes(12);
  const shortTag = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 4 });
  shortTag.setAAD(Buffer.from(JSON.stringify(['fixture'])));
  shortTag.final();
  assert.throws(() =>
    openVaultValue(
      key,
      ['fixture'],
      Buffer.concat([nonce, shortTag.getAuthTag()]).toString('base64'),
    ),
  );
});

test('authenticator codes match RFC 6238 and only usable keys are accepted', () => {
  const base32 = (text: string) => {
    const bits = [...Buffer.from(text)].map((byte) => byte.toString(2).padStart(8, '0')).join('');
    return (bits.match(/.{1,5}/g) ?? [])
      .map((chunk) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[parseInt(chunk.padEnd(5, '0'), 2)])
      .join('');
  };
  const seeds = {
    SHA1: '12345678901234567890',
    SHA256: '12345678901234567890123456789012',
    SHA512: '1234567890123456789012345678901234567890123456789012345678901234',
  };
  for (const [seconds, algorithm, code] of [
    [59, 'SHA1', '94287082'],
    [59, 'SHA256', '46119246'],
    [59, 'SHA512', '90693936'],
    [1111111109, 'SHA1', '07081804'],
    [1111111111, 'SHA256', '67062674'],
    [1234567890, 'SHA512', '93441116'],
    [2000000000, 'SHA1', '69279037'],
    [20000000000, 'SHA256', '77737706'],
  ] as const) {
    const key = authenticatorKey(
      `otpauth://totp/RFC:test?secret=${base32(seeds[algorithm])}&algorithm=${algorithm.toLowerCase()}&digits=8&issuer=RFC`,
    );
    assert.ok(key);
    assert.equal(authenticatorCode(key, seconds * 1000), code);
  }
  assert.equal(
    authenticatorKey(' jbsw y3dp-ehpk 3pxp== '),
    'otpauth://totp/?secret=JBSWY3DPEHPK3PXP&algorithm=SHA1&digits=6&period=30',
  );
  assert.equal(
    authenticatorKey('OTPAUTH://totp/Shop:ana?secret=JBSWY3DPEHPK3PXP&period=60&digits=7'),
    'otpauth://totp/?secret=JBSWY3DPEHPK3PXP&algorithm=SHA1&digits=7&period=60',
  );
  for (const unusable of [
    '',
    'JBSWY3DP',
    'JBSWY3DPEHPK3PX1',
    'JBSWY3DPEHPK3PXPJ',
    'JBSWY3DPEHPK3PXPJBS',
    'JBSWY3DPEHPK3PXPJBSWY3',
    'otpauth://hotp/Shop?secret=JBSWY3DPEHPK3PXP&counter=1',
    'otpauth://totp/Shop?secret=JBSWY3DPEHPK3PXP&algorithm=MD5',
    'otpauth://totp/Shop?secret=JBSWY3DPEHPK3PXP&digits=9',
    'otpauth://totp/Shop?secret=JBSWY3DPEHPK3PXP&period=0',
    'otpauth://totp/Shop?issuer=Shop',
    'steam://JBSWY3DPEHPK3PXP',
  ])
    assert.equal(authenticatorKey(unusable), undefined, unusable);
});

test('password exports carry usable authenticator keys and count the rest', () => {
  const onePassword = parsePasswordCsv(
    'Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\n' +
      'Bank,https://bank.example.test,ana@example.test,bank-synthetic,otpauth://totp/Bank:ana?secret=JBSWY3DPEHPK3PXP&issuer=Bank,false,false,,\n' +
      'Shop,https://shop.example.test,ana@example.test,shop-synthetic,,false,false,,\n' +
      'Game,https://game.example.test,ana,game-synthetic,steam://JBSWY3DPEHPK3PXP,false,false,,\n',
  );
  assert.deepEqual(
    onePassword.logins.map((login) => [login.label, login.authenticatorKey]),
    [
      ['Bank', 'otpauth://totp/?secret=JBSWY3DPEHPK3PXP&algorithm=SHA1&digits=6&period=30'],
      ['Shop', undefined],
      ['Game', undefined],
    ],
  );
  assert.equal(onePassword.unusableKeys, 1);
  const bitwarden = parsePasswordCsv(
    'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n' +
      ',,login,Mail,,,0,https://mail.example.test,ana,mail-synthetic,jbsw y3dp ehpk 3pxp\n',
  );
  assert.equal(
    bitwarden.logins[0]?.authenticatorKey,
    'otpauth://totp/?secret=JBSWY3DPEHPK3PXP&algorithm=SHA1&digits=6&period=30',
  );
  assert.equal(bitwarden.unusableKeys, 0);
});

test('a 1Password login applies only where 1Password itself would fill it', () => {
  const anywhere = (url: string) => [{ url, autofillBehavior: 'AnywhereOnWebsite' }];
  assert.equal(matchingWebsite(anywhere('github.com'), 'https://github.com'), 'github.com');
  assert.equal(
    matchingWebsite(anywhere('https://github.com/login'), 'https://gist.github.com'),
    'https://github.com/login',
  );
  for (const page of [
    'https://github.com.attacker.example',
    'https://evilgithub.com',
    'https://github.co',
  ])
    assert.equal(matchingWebsite(anywhere('https://github.com'), page), undefined, page);
  assert.equal(
    matchingWebsite(anywhere('https://alice.github.io'), 'https://bob.github.io'),
    undefined,
  );
  const exact = [{ url: 'https://login.example.com', autofillBehavior: 'ExactDomain' }];
  assert.equal(matchingWebsite(exact, 'https://login.example.com'), 'https://login.example.com');
  assert.equal(matchingWebsite(exact, 'https://example.com'), undefined);
  assert.equal(matchingWebsite(exact, 'https://login.example.com:8443'), undefined);
  assert.equal(
    matchingWebsite(
      [{ url: 'https://example.com', autofillBehavior: 'Never' }],
      'https://example.com',
    ),
    undefined,
  );
  assert.equal(
    matchingWebsite(anywhere('android://key@com.example.app/'), 'https://example.com'),
    undefined,
  );
  for (const url of ['mailto:login@example.com', 'https://login:secret@example.com'])
    assert.equal(matchingWebsite(anywhere(url), 'https://example.com'), undefined, url);
});

test('the real 1Password helper runs in its own process and fails clearly without the app', async () => {
  const manager = createOnePassword({ open: forkedOnePassword('test') });
  try {
    await assert.rejects(
      manager.logins('Synthetic account', 'https://example.com'),
      (error: unknown) =>
        error instanceof PasswordManagerError &&
        error.reason === 'unavailable' &&
        /^1Password: ./.test(error.message),
    );
  } finally {
    await manager.close();
  }
  const running = async () =>
    /onepassword\/helper\.ts test/.test((await runProcess('ps', ['-ax', '-o', 'command='])).stdout);
  for (let attempt = 0; attempt < 50 && (await running()); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await running(), false);
});

test('a stopped 1Password helper fails its request at once and the next request reopens it', async () => {
  let opened = 0;
  const manager = createOnePassword({
    answerMs: 60_000,
    open: async () => {
      const dead = ++opened === 2;
      const closed: Array<() => void> = [];
      return {
        send: () => {
          if (!dead) closed.forEach((listener) => listener());
        },
        receive: () => {},
        closed: (listener: () => void) => {
          closed.push(listener);
          if (dead) listener();
        },
        close: () => {},
      };
    },
  });
  try {
    for (const _ of [1, 2]) {
      const started = Date.now();
      await assert.rejects(
        manager.logins('Synthetic account', 'https://example.com'),
        (error: unknown) => error instanceof PasswordManagerError && /stopped/.test(error.message),
      );
      assert.ok(Date.now() - started < 1_000);
    }
    assert.equal(opened, 2);
  } finally {
    await manager.close();
  }
});

test('an idle 1Password helper closing late never fails a request on its replacement', async () => {
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let opened = 0;
  const manager = createOnePassword({
    idleMs: 5,
    open: async () => {
      const answerMs = ++opened === 1 ? 0 : 60;
      const closed: Array<() => void> = [];
      let reply: (raw: unknown) => void = () => {};
      return {
        send: (message: { id: number }) =>
          void setTimeout(() => reply({ id: message.id, ok: true, value: [] }), answerMs),
        receive: (receiver: (raw: unknown) => void) => {
          reply = receiver;
        },
        closed: (listener: () => void) => closed.push(listener),
        close: () => void setTimeout(() => closed.forEach((listener) => listener()), 30),
      };
    },
  });
  try {
    assert.deepEqual(await manager.logins('Synthetic account', 'https://example.com'), []);
    await delay(15);
    assert.deepEqual(await manager.logins('Synthetic account', 'https://example.com'), []);
    assert.equal(opened, 2);
  } finally {
    await manager.close();
  }
});

test('explicit card code replies keep private codes separate from ordinary numeric prose', () => {
  for (const text of ['Security code: 123', 'CVC 123', 'My CVV is 1234', '123'])
    assert.ok(securityCodeIn(text));
  for (const text of ['call 911', 'Code: 123', 'Security code: 12345'])
    assert.equal(securityCodeIn(text), undefined);
});

test('vault accepts exact HTTPS origins and explicit local development origins', () => {
  assert.equal(credentialOrigin('https://EXAMPLE.com:443/'), 'https://example.com');
  assert.equal(credentialOrigin('http://127.0.0.1:4310'), 'http://127.0.0.1:4310');
  for (const invalid of [
    'http://example.com',
    'file:///tmp/a',
    'https://user:password@example.com',
    'https://example.com/login',
    'https://example.com?key=secret',
    'https://example.com/#fragment',
  ]) {
    assert.throws(() => credentialOrigin(invalid));
  }
});

test(
  'vault stores only encrypted secrets, isolates requests, consumes once, and resumes after injection',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_vault_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    const fixtureKey = randomBytes(32);
    let keyReads = 0;
    const { turn, wait, resume } = await seedTurns(pool);
    const other = await turn('other-user');
    const task1 = await turn();
    const task2 = await turn();
    const expiredTask = await turn();
    let injected = 0;
    let resumed = 0;
    let complete: () => void = () => {};
    let started: () => void = () => {};
    const injectionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const injectionComplete = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let failNext = false;
    const vault = await createVault(pool, {
      requestKey: Buffer.alloc(32, 42),
      keyStore: {
        id: 'fixture',
        configured: true,
        getKey: async () => {
          keyReads++;
          return fixtureKey;
        },
      },
      retry: async () => {},
      page: async (_threadId, step) => ({
        origin: 'https://example.com',
        url: 'https://example.com/login',
        ...(step ? { controls: [{ role: 'textbox', name: 'Passwort' }] } : {}),
      }),
      inject: async (input) => {
        if (failNext) {
          failNext = false;
          throw new Error('Synthetic injection failure');
        }
        assert.equal(input.origin, 'https://example.com');
        assert.equal(input.password, 'secret-password');
        assert.equal(input.username, undefined);
        injected++;
        started();
        await injectionComplete;
      },
      resume: async () => {
        resumed++;
      },
    });
    vault.registerRoutes(app);
    try {
      const input = {
        origin: 'https://example.com',
        label: 'Example',
        kind: 'password' as const,
        passwordSelector: '#password',
      };
      const hidden = await vault.request(other, 'other-user', input);
      assert.equal(
        (
          await app.inject({
            url: hidden.url.replace('/vault/', '/api/credential-requests/'),
          })
        ).statusCode,
        404,
      );
      const result = await vault.request(task1, 'local-development', input);
      await wait(task1);
      await vault.request({ ...task2, browserId: randomUUID() }, 'local-development', input);
      assert.equal(
        (
          await pool.query('SELECT status FROM credential_requests WHERE turn_id=$1', [
            task1.turnId,
          ])
        ).rows[0].status,
        'pending',
      );
      const url = result.url.replace('/vault/', '/api/credential-requests/');
      const status = await app.inject({ url: `${url}/status` });
      assert.deepEqual(status.json(), { status: 'pending' });
      assert.equal(status.headers['cache-control'], 'no-store');
      assert.equal(
        (
          await app.inject({
            url: `${hidden.url.replace('/vault/', '/api/credential-requests/')}/status`,
          })
        ).statusCode,
        404,
      );
      const form = await app.inject({ url });
      assert.equal(form.statusCode, 200);
      assert.equal(form.headers['cache-control'], 'no-store');
      assert.equal(form.json<CredentialRequest>().status, 'pending');
      assert.deepEqual(
        form.json<CredentialRequest>().fields?.map((field) => field.label),
        ['Passwort'],
      );
      const first = app.inject({
        method: 'POST',
        url,
        payload: {
          username: 'person@example.com',
          password: 'secret-password',
        },
      });
      await injectionStarted;
      assert.deepEqual((await app.inject({ url: `${url}/status` })).json(), {
        status: 'entering',
      });
      assert.equal((await app.inject({ url })).json().status, 'entering');
      assert.equal(resumed, 0);
      let secondSettled = false;
      const second = app
        .inject({
          method: 'POST',
          url,
          payload: { password: 'second-secret' },
        })
        .finally(() => {
          secondSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(secondSettled, true);
      complete();
      assert.equal((await first).statusCode, 200);
      assert.deepEqual((await app.inject({ url: `${url}/status` })).json(), {
        status: 'filled',
      });
      assert.equal((await app.inject({ url })).json().status, 'filled');
      await pool.query(
        "UPDATE vault_uses SET owner_id='other-user' WHERE id=(SELECT id FROM credential_requests WHERE turn_id=$1)",
        [task1.turnId],
      );
      assert.deepEqual((await app.inject({ url: `${url}/status` })).json(), {
        status: 'expired',
      });
      assert.equal((await app.inject({ url })).json().status, 'expired');
      await pool.query(
        "UPDATE vault_uses SET owner_id='local-development' WHERE id=(SELECT id FROM credential_requests WHERE turn_id=$1)",
        [task1.turnId],
      );
      assert.equal((await second).statusCode, 409);
      assert.equal(injected, 1);
      assert.equal(resumed, 1);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: { password: 'secret-password' },
          })
        ).statusCode,
        409,
      );
      const metadata = await app.inject({ url: '/api/vault' });
      assert.equal(metadata.json().length, 1);
      assert.equal(metadata.body.includes('secret-password'), false);
      assert.equal(metadata.body.includes('person@example.com'), true);
      assert.equal(JSON.stringify(await vault.list()).includes('person@example.com'), false);
      const stored = await pool.query('SELECT * FROM vault_entries');
      assert.equal(JSON.stringify(stored.rows).includes('secret-password'), false);
      await assert.rejects(vault.fillSaved(task2, 'another-owner', stored.rows[0].id, input));
      await assert.rejects(
        vault.fillSaved(task2, 'local-development', stored.rows[0].id, {
          ...input,
          origin: 'https://other.example.com',
        }),
      );
      const failedTask = await turn();
      failNext = true;
      await assert.rejects(
        vault.fillSaved(failedTask, 'local-development', stored.rows[0].id, input),
      );
      assert.equal(
        await vault.fillSaved(failedTask, 'local-development', stored.rows[0].id, input),
        false,
      );
      assert.equal(injected, 1);
      await vault.fillSaved(task2, 'local-development', stored.rows[0].id, input);
      assert.equal(injected, 2);
      assert.equal(resumed, 1);
      assert.equal(
        await vault.fillSaved(task2, 'local-development', stored.rows[0].id, input),
        false,
      );
      assert.equal(
        await vault.fillSaved(await resume(task1), 'local-development', stored.rows[0].id, input),
        false,
      );
      assert.equal(injected, 2);
      const requests = await pool.query('SELECT * FROM credential_requests');
      assert.equal(JSON.stringify(requests.rows).includes('secret-password'), false);
      assert.equal(JSON.stringify(requests.rows).includes(result.url.split('/').at(-1)!), false);
      const expired = await vault.request(expiredTask, 'local-development', input);
      await wait(expiredTask);
      await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [expiredTask.turnId]);
      const expiredUrl = expired.url.replace('/vault/', '/api/credential-requests/');
      assert.deepEqual((await app.inject({ url: `${expiredUrl}/status` })).json(), {
        status: 'expired',
      });
      assert.equal((await app.inject({ url: expiredUrl })).json().status, 'expired');
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: expiredUrl,
            payload: { password: 'expired-secret' },
          })
        ).statusCode,
        409,
      );
      const pendingTask = await turn();
      const pending = await vault.request(pendingTask, 'local-development', input);
      await wait(pendingTask);
      const pendingUrl = pending.url.replace('/vault/', '/api/credential-requests/');
      const readsBeforeStatus = keyReads;
      assert.deepEqual((await app.inject({ url: `${pendingUrl}/status` })).json(), {
        status: 'pending',
      });
      assert.equal(keyReads, readsBeforeStatus);
      assert.ok((await app.inject({ url: pendingUrl })).json().savedEntries.length > 0);
    } finally {
      complete();
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'OTP failures are uncertain, cannot replay, and never persist the code',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const keyRoot = await mkdtemp(join(tmpdir(), 'nod-request-key-'));
    t.after(() => rm(keyRoot, { recursive: true, force: true }));
    const originalAccess = await accessKey(keyRoot);
    const schema = `test_vault_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    let keyReads = 0;
    const { turn, wait, resume } = await seedTurns(pool);
    const otpTask = await turn();
    let calls = 0;
    const resumed: string[] = [];
    const options = {
      requestKey: Buffer.from(await credentialRequestKey(keyRoot), 'base64url'),
      keyStore: {
        id: 'unavailable',
        configured: false,
        getKey: async () => {
          keyReads++;
          throw new Error('Synthetic Vault key unavailable');
        },
      },
      retry: async () => {},
      inject: async (input: CredentialInjection) => {
        calls++;
        if (calls === 1) throw new Error(`Provider leaked ${input.code}`);
      },
      resume: async (turnId: string) => {
        resumed.push(turnId);
      },
    };
    const vault = await createVault(pool, options);
    vault.registerRoutes(app);
    try {
      const request = await vault.request(otpTask, 'local-development', {
        origin: 'https://example.com',
        label: 'Verification',
        kind: 'otp',
        passwordSelector: '#code',
      });
      await wait(otpTask);
      let url = request.url.replace('/vault/', '/api/credential-requests/');
      const failed = await app.inject({ method: 'POST', url, payload: { code: '123456' } });
      assert.equal(failed.statusCode, 502);
      assert.equal(failed.body.includes('123456'), false);
      assert.equal((await app.inject({ url })).json().status, 'uncertain');
      assert.deepEqual((await app.inject({ url: `${url}/status` })).json(), {
        status: 'uncertain',
      });
      assert.equal(
        (await app.inject({ method: 'POST', url, payload: { code: '789012' } })).statusCode,
        409,
      );
      await pool.query("UPDATE turns SET status='running' WHERE id=$1", [otpTask.turnId]);
      const fresh = await vault.request(otpTask, 'local-development', {
        origin: 'https://example.com',
        label: 'Verification',
        kind: 'otp',
        passwordSelector: '#code',
      });
      url = fresh.url.replace('/vault/', '/api/credential-requests/');
      await wait(otpTask);
      assert.deepEqual(resumed, []);
      assert.equal(
        (await app.inject({ method: 'POST', url, payload: { code: '789012' } })).statusCode,
        200,
      );
      assert.deepEqual(resumed, [otpTask.turnId]);
      assert.equal(calls, 2);
      const nextTurn = await resume(otpTask);
      const next = await vault.request(nextTurn, 'local-development', {
        origin: 'https://example.com',
        label: 'Verification',
        kind: 'otp',
        passwordSelector: '#next-code',
      });
      await wait(nextTurn);
      await rm(join(keyRoot, 'access-key'));
      assert.notEqual(await accessKey(keyRoot), originalAccess);
      const restarted = await createVault(pool, {
        ...options,
        requestKey: Buffer.from(await credentialRequestKey(keyRoot), 'base64url'),
      });
      const reopened = Fastify();
      restarted.registerRoutes(reopened);
      try {
        const continuation = (await reopened.inject({ url: `${url}/flow` })).json();
        assert.equal(continuation.nextId === next.url.split('/').at(-1), true);
        const nextUrl = `/api/credential-requests/${continuation.nextId}`;
        assert.equal((await reopened.inject({ url: nextUrl })).json().status, 'pending');
        assert.equal(
          (await reopened.inject({ method: 'POST', url, payload: { code: '324681' } })).statusCode,
          409,
        );
        assert.equal(
          (await reopened.inject({ method: 'POST', url: nextUrl, payload: { code: '324681' } }))
            .statusCode,
          200,
        );
        assert.equal(calls, 3);
        assert.equal(keyReads, 0);
        const rows = JSON.stringify((await pool.query('SELECT * FROM credential_requests')).rows);
        for (const secret of [
          next.url.split('/').at(-1)!,
          '324681',
          options.requestKey.toString('base64url'),
        ])
          assert.equal(rows.includes(secret), false);
      } finally {
        await reopened.close();
      }
      assert.equal((await pool.query('SELECT * FROM vault_entries')).rowCount, 0);
      assert.equal(
        JSON.stringify((await pool.query('SELECT * FROM credential_requests')).rows).includes(
          '789012',
        ),
        false,
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'credential retry restarts only pending expired forms and stale forms never inject',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_vault_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const { turn, archive, wait, resume } = await seedTurns(pool);
    const task1 = await turn();
    const app = Fastify();
    const key = randomBytes(32);
    let injected = 0;
    const retried: string[] = [];
    let failInjection = false;
    const vault = await createVault(pool, {
      requestKey: Buffer.alloc(32, 42),
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      inject: async () => {
        injected++;
        if (failInjection) throw new Error('Synthetic browser failure');
      },
      resume: async () => {},
      retry: async (turnId) => {
        retried.push(turnId);
      },
    });
    vault.registerRoutes(app);
    try {
      const input = {
        origin: 'https://example.com',
        label: 'Example',
        kind: 'password' as const,
        passwordSelector: '#password',
      };
      const request = await vault.request(task1, 'local-development', input);
      await wait(task1);
      const url = request.url.replace('/vault/', '/api/credential-requests/');
      assert.equal((await app.inject({ method: 'POST', url: `${url}/retry` })).statusCode, 409);
      await pool.query('UPDATE credential_requests SET failed_at=now() WHERE turn_id=$1', [
        task1.turnId,
      ]);
      const concurrent = await Promise.all([
        app.inject({ method: 'POST', url: `${url}/retry` }),
        app.inject({ method: 'POST', url: `${url}/retry` }),
      ]);
      assert.deepEqual(concurrent.map((result) => result.statusCode).sort(), [200, 409]);
      assert.equal((await app.inject({ method: 'POST', url: `${url}/retry` })).statusCode, 409);
      assert.deepEqual(retried, [task1.turnId]);
      assert.equal(injected, 0);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: { password: 'stale-secret' },
          })
        ).statusCode,
        409,
      );
      const retryTurn = await resume(task1, 'credentials-retry');
      const fresh = await vault.request(retryTurn, 'local-development', input);
      await wait(retryTurn);
      const freshUrl = fresh.url.replace('/vault/', '/api/credential-requests/');
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: { password: 'stale-secret' },
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: freshUrl,
            payload: { password: 'fresh-secret' },
          })
        ).statusCode,
        200,
      );
      assert.equal(injected, 1);
      assert.equal(
        (await app.inject({ method: 'POST', url: `${freshUrl}/retry` })).statusCode,
        409,
      );
      const entry = (await vault.list())[0];
      assert.equal(
        await vault.fillSaved(await resume(retryTurn), 'local-development', entry.id, input),
        false,
      );
      await archive();
      assert.equal(injected, 1);
      failInjection = true;
      const taskRetry = await turn();
      const failed = await vault.request(taskRetry, 'local-development', input);
      await wait(taskRetry);
      const failedUrl = failed.url.replace('/vault/', '/api/credential-requests/');
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: failedUrl,
            payload: { password: 'failed-secret' },
          })
        ).statusCode,
        502,
      );
      assert.equal(
        (await app.inject({ method: 'POST', url: `${failedUrl}/retry` })).statusCode,
        200,
      );
      assert.deepEqual(retried, [task1.turnId, taskRetry.turnId]);
      assert.equal(injected, 2);
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

async function vaultFixture() {
  const schema = `test_vault_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
    connectionTimeoutMillis: 1000,
  });
  const seeded = await seedTurns(pool);
  const app = Fastify();
  const calls = { injected: 0, retried: [] as string[] };
  let inspecting = async () => ({
    origin: 'https://example.com',
    url: 'https://example.com/login',
  });
  const vault = await createVault(pool, {
    requestKey: Buffer.alloc(32, 42),
    keyStore: { id: 'fixture', configured: true, getKey: async () => randomBytes(32) },
    page: () => inspecting(),
    inject: async () => {
      calls.injected++;
    },
    resume: async (turnId, client) => {
      await client.query(
        "INSERT INTO turns(id,owner_id,thread_id,source,source_id) SELECT gen_random_uuid(),owner_id,thread_id,'resume','credentials:'||id FROM turns WHERE id=$1",
        [turnId],
      );
    },
    retry: async (turnId) => {
      calls.retried.push(turnId);
    },
  });
  vault.registerRoutes(app);
  const input = {
    origin: 'https://example.com',
    label: 'Example',
    kind: 'password' as const,
    passwordSelector: '#password',
  };
  const link = async (ref: TurnRef) =>
    (await vault.request(ref, 'local-development', input)).url.replace(
      '/vault/',
      '/api/credential-requests/',
    );
  const submit = (url: string) =>
    app.inject({
      method: 'POST',
      url,
      payload: { password: 'fixture-secret' },
    });
  return {
    ...seeded,
    pool,
    app,
    vault,
    calls,
    resumed: async () =>
      (
        await pool.query(
          "SELECT substring(source_id from 13) AS id FROM turns WHERE source='resume'",
        )
      ).rows
        .map((row) => row.id as string)
        .sort(),
    link,
    submit,
    status: async (url: string) => (await app.inject({ url })).json().status,
    holdInspection: () => {
      let release!: () => void;
      let reached!: () => void;
      const started = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      inspecting = async () => {
        reached();
        await hold;
        return { origin: 'https://example.com', url: 'https://example.com/login' };
      };
      return { started, release };
    },
    close: async () => {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

test(
  'credential links work only while their turn waits for credentials and no later turn in its session started',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const f = await vaultFixture();
    try {
      const running = await f.turn();
      const url = await f.link(running);
      assert.equal(await f.status(url), 'expired');
      assert.equal((await f.submit(url)).statusCode, 409);
      for (const change of [
        "status='waiting',waiting_reason='question',started_at=now()",
        "status='failed',waiting_reason=NULL",
        "status='succeeded'",
      ]) {
        await f.pool.query(`UPDATE turns SET ${change} WHERE id=$1`, [running.turnId]);
        assert.equal(await f.status(url), 'expired');
        assert.equal((await f.submit(url)).statusCode, 409);
      }
      await f.wait(running);
      assert.equal(await f.status(url), 'pending');

      const check = await f.turn('local-development', true);
      const checkUrl = await f.link({ ...check, browserId: randomUUID() });
      await f.wait(check);
      assert.equal(await f.status(url), 'pending');
      assert.equal(await f.status(checkUrl), 'pending');

      const later = await f.turn();
      await f.pool.query('UPDATE turns SET started_at=clock_timestamp() WHERE id=$1', [
        later.turnId,
      ]);
      assert.equal(await f.status(url), 'expired');
      assert.equal(await f.status(checkUrl), 'pending');
      assert.equal((await f.submit(url)).statusCode, 409);
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: `${url}/saved`,
            payload: { entryId: randomUUID() },
          })
        ).statusCode,
        409,
      );
      assert.equal((await f.submit(checkUrl)).statusCode, 200);
      assert.deepEqual(f.calls, { injected: 1, retried: [] });
      assert.deepEqual(await f.resumed(), [check.turnId]);
      assert.equal((await f.app.inject({ method: 'POST', url: `${url}/retry` })).statusCode, 409);

      await f.pool.query('UPDATE turns SET started_at=NULL WHERE id=$1', [later.turnId]);
      assert.equal((await f.submit(url)).statusCode, 200);
      assert.deepEqual(f.calls, { injected: 2, retried: [] });
      assert.deepEqual(await f.resumed(), [check.turnId, running.turnId].sort());
    } finally {
      await f.close();
    }
  },
);

test(
  'credential preflight releases database locks and failed completion has one durable outcome',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const f = await vaultFixture();
    try {
      const turn = await f.turn();
      const url = await f.link(turn);
      await f.wait(turn);
      const gate = f.holdInspection();
      const submitting = f.submit(url);
      await gate.started;
      const client = await f.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM turns WHERE id=$1 FOR UPDATE NOWAIT', [turn.turnId]);
        await client.query('ROLLBACK');
        await f.pool
          .query(`CREATE FUNCTION reject_selection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic completion failure'; END $$;
      CREATE TRIGGER reject_selection BEFORE INSERT ON credential_account_selections FOR EACH ROW EXECUTE FUNCTION reject_selection()`);
      } finally {
        client.release();
        gate.release();
      }
      assert.equal((await submitting).statusCode, 502);
      assert.equal(f.calls.injected, 1);
      assert.equal(await f.status(url), 'uncertain');
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT r.status AS request_status,v.status AS operation_status FROM credential_requests r JOIN vault_uses v ON v.id=r.id',
          )
        ).rows,
        [{ request_status: 'consumed', operation_status: 'uncertain' }],
      );
      assert.equal((await f.submit(url)).statusCode, 409);
      assert.equal(f.calls.injected, 1);
      assert.deepEqual(await f.resumed(), []);
      assert.equal((await f.app.inject({ method: 'POST', url: `${url}/retry` })).statusCode, 200);
      assert.equal((await f.app.inject({ method: 'POST', url: `${url}/retry` })).statusCode, 409);
      assert.equal(await f.status(url), 'expired');
    } finally {
      await f.close();
    }
  },
);

test(
  'a lost Vault claim acknowledgement and a failed uncertainty write never repeat browser work',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const { createVaultUses, VaultUseError } = await import('../src/server/vault-use.ts');
    const f = await vaultFixture();
    try {
      let loseCommit = false;
      const pool = new Proxy(f.pool, {
        get(target, key) {
          if (key === 'connect')
            return async () => {
              const client = await target.connect();
              return new Proxy(client, {
                get(connection, member) {
                  if (member === 'query')
                    return async (...args: Parameters<typeof client.query>) => {
                      const result = await client.query(...args);
                      if (args[0] === 'COMMIT' && loseCommit) {
                        loseCommit = false;
                        throw new Error('Synthetic lost commit acknowledgement');
                      }
                      return result;
                    };
                  const value = Reflect.get(connection, member);
                  return typeof value === 'function' ? value.bind(connection) : value;
                },
              });
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const uses = await createVaultUses(pool, 'local-development');
      const turn = await f.turn();
      const use = {
        id: randomUUID(),
        ownerId: 'local-development',
        ...turn,
        origin: 'https://fixture.test',
        kind: 'password',
      };
      let entries = 0;
      const operation = {
        perform: async () => {
          entries++;
        },
      };
      const uncertain = (error: unknown) =>
        error instanceof VaultUseError && error.statusCode === 502;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const concurrent = { ...use, id: randomUUID() };
      const running = uses.run(concurrent, {
        perform: async () => {
          entered();
          await held;
        },
      });
      try {
        await started;
        await assert.rejects(
          uses.run(concurrent, {
            prepare: async () => {
              throw new Error('Synthetic preparation failure');
            },
            perform: operation.perform,
          }),
          /preparation failure/,
        );
        assert.equal(
          (await f.pool.query('SELECT status FROM vault_uses WHERE id=$1', [concurrent.id])).rows[0]
            .status,
          'running',
        );
      } finally {
        finish();
        await running;
      }
      assert.equal(
        (await f.pool.query('SELECT status FROM vault_uses WHERE id=$1', [concurrent.id])).rows[0]
          .status,
        'submitted',
      );
      loseCommit = true;
      await assert.rejects(uses.run(use, operation), uncertain);
      assert.equal(entries, 0);
      assert.equal(
        (await f.pool.query('SELECT status FROM vault_uses WHERE id=$1', [use.id])).rows[0].status,
        'uncertain',
      );
      await assert.rejects(
        uses.run(use, operation),
        (error: unknown) => error instanceof VaultUseError && error.statusCode === 409,
      );
      await f.pool
        .query(`CREATE FUNCTION reject_uncertain() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.status='uncertain' THEN RAISE EXCEPTION 'Synthetic uncertainty write failure'; END IF;
      RETURN NEW; END $$; CREATE TRIGGER reject_uncertain BEFORE UPDATE ON vault_uses FOR EACH ROW EXECUTE FUNCTION reject_uncertain()`);
      const failed = { ...use, id: randomUUID() };
      await assert.rejects(
        uses.run(failed, {
          perform: async () => {
            entries++;
            throw new Error('Synthetic browser failure');
          },
        }),
        uncertain,
      );
      assert.equal(entries, 1);
      assert.equal(
        (await f.pool.query('SELECT status FROM vault_uses WHERE id=$1', [failed.id])).rows[0]
          .status,
        'running',
      );
      await assert.rejects(
        uses.run(failed, operation),
        (error: unknown) => error instanceof VaultUseError && error.statusCode === 409,
      );
      assert.equal(entries, 1);
      await f.pool.query('DROP TRIGGER reject_uncertain ON vault_uses');
      await createVaultUses(f.pool, 'local-development');
      assert.equal(
        (await f.pool.query('SELECT status FROM vault_uses WHERE id=$1', [failed.id])).rows[0]
          .status,
        'uncertain',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'named Vault accounts preserve exact websites and chosen staged identity across restart',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_vault_accounts_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await pool.query(
      'CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz)',
    );
    await pool.query(
      "CREATE TABLE turns(id uuid PRIMARY KEY,parent_turn_id uuid,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text,background boolean NOT NULL DEFAULT false,started_at timestamptz,session_id uuid GENERATED ALWAYS AS (CASE WHEN background THEN id ELSE thread_id END) STORED)",
    );
    const threads = new Map<string, string>();
    const tasks = new Map<string, TurnRef>();
    const startTurn = async (owner = 'local-development', resumeOf?: string) => {
      let threadId = threads.get(owner);
      if (!threadId) {
        threadId = randomUUID();
        threads.set(owner, threadId);
        await pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [threadId, owner]);
      }
      const turnId = randomUUID();
      await pool.query(
        'INSERT INTO turns(id,owner_id,thread_id,source,source_id,parent_turn_id) VALUES($1,$2,$3,$4,$5,$6)',
        [
          turnId,
          owner,
          threadId,
          resumeOf ? 'resume' : 'user',
          resumeOf ? `credentials:${resumeOf}` : null,
          resumeOf ?? null,
        ],
      );
      return { threadId, turnId };
    };
    const task = (name: string) => tasks.get(name)!;
    const key = randomBytes(32);
    const stages = new Map<string, CredentialKind>();
    const injections: CredentialInjection[] = [];
    const resumed: string[] = [];
    let app = Fastify();
    const options = {
      requestKey: Buffer.alloc(32, 42),
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      page: async () => ({ origin: 'https://example.com', url: 'https://example.com/login' }),
      inject: async (input: CredentialInjection) => {
        injections.push(input);
        stages.set(input.threadId, input.kind === 'identifier' ? 'password' : 'otp');
      },
      retry: async () => {},
      resume: async (turnId: string) => {
        const name = [...tasks].find(([, value]) => value.turnId === turnId)?.[0];
        assert.ok(name);
        const result = await pool.query(
          "SELECT 1 FROM turns WHERE id=$1 AND status='waiting' AND waiting_reason='credentials'",
          [turnId],
        );
        assert.equal(result.rowCount, 1);
        tasks.set(name, await startTurn('local-development', turnId));
        resumed.push(name);
      },
    };
    let vault = await createVault(pool, options);
    vault.registerRoutes(app);
    const addTask = async (id: string, kind: CredentialKind = 'identifier') => {
      const turn = await startTurn();
      tasks.set(id, turn);
      stages.set(turn.threadId, kind);
    };
    const input = (kind: CredentialKind = 'identifier') => ({
      origin: 'https://example.com',
      label: 'Model provided label',
      kind,
      ...(kind === 'identifier' ? { usernameSelector: '#login' } : { passwordSelector: '#login' }),
    });
    const form = async (taskId: string) => {
      const request = await vault.request(
        task(taskId),
        'local-development',
        input(stages.get(task(taskId).threadId)),
      );
      await pool.query(
        "UPDATE turns SET status='waiting',waiting_reason='credentials' WHERE id=$1",
        [task(taskId).turnId],
      );
      return request.url.replace('/vault/', '/api/credential-requests/');
    };
    const choose = (url: string, entryId: string) =>
      app.inject({ method: 'POST', url: `${url}/saved`, payload: { entryId } });
    const describe = async (url: string) => (await app.inject({ url })).json<CredentialRequest>();
    const save = async (label: string, origin: string, username: string, password: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault',
        payload: { label, origin, username, password },
      });
      assert.equal(response.statusCode, 200);
      return response.json<VaultLoginEntry>();
    };
    try {
      const first = await save(
        'Personal',
        'EXAMPLE.com',
        'same-first@example.test',
        'first-password',
      );
      const second = await save(
        'Work',
        'https://EXAMPLE.com:443/',
        'same-second@example.test',
        'second-password',
      );
      const subdomain = await save(
        'Subdomain',
        'https://login.example.com',
        'same-second@example.test',
        'other-secret',
      );
      const port = await save(
        'Other port',
        'https://example.com:8443',
        'same-second@example.test',
        'port-secret',
      );
      const foreign = {
        id: randomUUID(),
        owner_id: 'foreign-owner',
        origin: 'https://example.com',
      };
      await pool.query(
        'INSERT INTO vault_entries(id,owner_id,label,origin,username_hint,ciphertext) VALUES($1,$2,$3,$4,$5,$6)',
        [
          foreign.id,
          foreign.owner_id,
          'Foreign',
          foreign.origin,
          'sa…',
          sealCredential(key, foreign, { username: 'foreign-user', password: 'foreign-secret' }),
        ],
      );

      await t.test(
        'selection metadata and POST enforce exact origin and owner without leaking other accounts',
        async () => {
          for (const [index, id] of [subdomain.id, port.id, foreign.id, randomUUID()].entries()) {
            const taskId = `invalid-${index}`;
            await addTask(taskId);
            const url = await form(taskId);
            assert.deepEqual(
              (await describe(url)).savedEntries?.map((entry) => [entry.id, entry.username]).sort(),
              [
                [first.id, 'same-first@example.test'],
                [second.id, 'same-second@example.test'],
              ].sort(),
            );
            const before = injections.length;
            const result = await choose(url, id);
            assert.equal(result.statusCode, 200);
            assert.equal(result.json().ok, false);
            assert.equal(injections.length, before);
            assert.equal(resumed.includes(taskId), false);
            assert.equal((await choose(url, first.id)).statusCode, 409);
            assert.equal(
              (
                await describe(
                  result.json().retryUrl.replace('/vault/', '/api/credential-requests/'),
                )
              ).status,
              'pending',
            );
          }
        },
      );

      await t.test(
        'a delayed key lookup cannot bypass a blocked or changed account selection',
        async () => {
          const alias = await save(
            'Personal alternate',
            'example.com',
            'alternate-first@example.test',
            'alternate-password',
          );
          for (const state of ['blocked', 'changed']) {
            const taskId = `key-race-${state}`;
            await addTask(taskId);
            await vault.fillSaved(task(taskId), 'local-development', first.id, input());
            let keyReady!: () => void;
            let releaseKey!: () => void;
            const started = new Promise<void>((resolve) => {
              keyReady = resolve;
            });
            const release = new Promise<void>((resolve) => {
              releaseKey = resolve;
            });
            const racingApp = Fastify();
            const racingVault = await createVault(pool, {
              ...options,
              keyStore: {
                id: 'held-fixture',
                configured: true,
                getKey: async () => {
                  keyReady();
                  await release;
                  return key;
                },
              },
            });
            racingVault.registerRoutes(racingApp);
            try {
              const before = injections.length;
              const filling = racingVault.fillSelected(
                task(taskId),
                'local-development',
                input('password'),
              );
              await started;
              if (state === 'blocked')
                await pool.query(
                  'UPDATE credential_account_selections SET blocked=true WHERE root_turn_id=$1',
                  [task(taskId).turnId],
                );
              else
                await pool.query(
                  'UPDATE credential_account_selections SET entry_id=$2 WHERE root_turn_id=$1',
                  [task(taskId).turnId, alias.id],
                );
              releaseKey();
              assert.equal(await filling, false);
              assert.equal(injections.length, before);
            } finally {
              releaseKey();
              await racingApp.close();
            }
          }
        },
      );

      await t.test(
        'one task can use two saved accounts after each sign-in completes without replay',
        async () => {
          await addTask('two-accounts', 'password');
          const turn = task('two-accounts');
          const combined = { ...input('password'), usernameSelector: '#account' };
          const before = injections.length;
          assert.equal(await vault.fillSaved(turn, 'local-development', first.id, combined), true);
          assert.equal(await vault.fillSelected(turn, 'local-development', combined), undefined);
          assert.equal(await vault.fillSaved(turn, 'local-development', second.id, combined), true);
          assert.deepEqual(
            injections.slice(before).map((entry) => entry.username),
            ['same-first@example.test', 'same-second@example.test'],
          );
          assert.equal(await vault.fillSaved(turn, 'local-development', first.id, combined), false);
          assert.equal(
            await vault.fillSaved(turn, 'local-development', second.id, combined),
            false,
          );
          assert.equal(injections.length, before + 2);
          await addTask('staged-account');
          await vault.fillSaved(task('staged-account'), 'local-development', first.id, input());
          assert.equal(
            await vault.fillSaved(
              task('staged-account'),
              'local-development',
              second.id,
              input('password'),
            ),
            false,
          );
          assert.equal(injections.length, before + 3);
        },
      );

      await t.test(
        'deleted chosen entry cannot switch automatically to the sole remaining account',
        async () => {
          const disposable = await save(
            'Disposable',
            'example.com',
            'removed-account',
            'removed-password',
          );
          await addTask('deleted');
          const url = await form('deleted');
          assert.equal((await choose(url, disposable.id)).json().ok, true);
          await app.inject({ method: 'DELETE', url: `/api/vault/${disposable.id}` });
          const before = injections.length;
          assert.equal(
            await vault.fillSelected(task('deleted'), 'local-development', input('password')),
            false,
          );
          assert.equal(injections.length, before);
          const passwordUrl = await form('deleted');
          assert.deepEqual((await describe(passwordUrl)).savedEntries, []);
          assert.equal((await choose(passwordUrl, first.id)).statusCode, 409);
          const replacement = (await choose(passwordUrl, disposable.id)).json<{
            ok: boolean;
            retryUrl: string;
          }>();
          assert.equal(replacement.ok, false);
          assert.equal((await describe(passwordUrl)).status, 'expired');
          const replacementId = replacement.retryUrl.split('/').at(-1)!;
          assert.deepEqual((await app.inject({ url: `${passwordUrl}/flow` })).json(), {
            nextId: replacementId,
          });
          assert.equal(
            (
              await app.inject({
                method: 'POST',
                url: passwordUrl,
                payload: { password: 'synthetic-stale-password' },
              })
            ).statusCode,
            409,
          );
          const view = await vaultPage(
            createElement(Credentials, { id: passwordUrl.split('/').at(-1)!, embedded: true }),
            async (url, init) => {
              const result = await app.inject({
                method: (init.method ?? 'GET') as 'GET' | 'POST',
                url,
                headers: init.body ? { 'content-type': 'application/json' } : {},
                payload: init.body ? String(init.body) : undefined,
              });
              return new Response(result.body, {
                status: result.statusCode,
                headers: { 'content-type': 'application/json' },
              });
            },
            'http://localhost:4310/?conversation=synthetic',
          );
          try {
            for (
              let attempt = 0;
              attempt < 100 && !view.document.querySelector('input[name="password"]');
              attempt++
            )
              await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
            const field = view.document.querySelector<HTMLInputElement>('input[name="password"]');
            assert.ok(field);
            assert.equal(field.value, '');
            assert.equal(window.location.search, '?conversation=synthetic');
          } finally {
            await view.close();
          }
          assert.equal(injections.length, before);
        },
      );

      await t.test(
        'expired, archived and foreign requests cannot select saved entries and OTP has no accounts',
        async () => {
          for (const state of ['ended', 'archived']) {
            await addTask(state);
            const url = await form(state);
            if (state === 'ended')
              await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [
                task(state).turnId,
              ]);
            else {
              await pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [
                task(state).threadId,
              ]);
              threads.delete('local-development');
            }
            const before = injections.length;
            assert.equal((await choose(url, first.id)).statusCode, 409);
            assert.equal((await describe(url)).savedEntries, undefined);
            assert.equal(injections.length, before);
          }
          const foreignTask = await startTurn('foreign-owner');
          const foreignRequest = await vault.request(foreignTask, 'foreign-owner', input());
          const foreignUrl = foreignRequest.url.replace('/vault/', '/api/credential-requests/');
          assert.equal((await app.inject({ url: foreignUrl })).statusCode, 404);
          assert.equal((await choose(foreignUrl, foreign.id)).statusCode, 409);
          await addTask('otp', 'otp');
          const otpUrl = await form('otp');
          assert.equal((await describe(otpUrl)).savedEntries, undefined);
          assert.equal((await choose(otpUrl, first.id)).statusCode, 409);
        },
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'Vault fills the model-selected fields across restart only while the page stays on the exact origin',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_vault_targets_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const turns = await seedTurns(pool);
    const origin = 'https://accounts.example.test';
    const key = randomBytes(32);
    const injections: CredentialInjection[] = [];
    let pageOrigin = origin;
    let app = Fastify();
    const options = {
      requestKey: Buffer.alloc(32, 42),
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      page: async () => ({ origin: pageOrigin, url: `${pageOrigin}/login` }),
      inject: async (input: CredentialInjection) => {
        injections.push(input);
        return { status: 'submitted' as const };
      },
      retry: async () => {},
      resume: async () => {},
    };
    let vault = await createVault(pool, options);
    vault.registerRoutes(app);
    const stored = async (turnId: string) =>
      (await pool.query('SELECT id,selectors FROM credential_requests WHERE turn_id=$1', [turnId]))
        .rows[0];
    try {
      for (const { kind, passwordSelector } of [
        { kind: 'identifier' },
        { kind: 'password', passwordSelector: '#entry' },
        { kind: 'otp', passwordSelector: '.code-digit' },
        { kind: 'otp', passwordSelector: ['@e1', '@e2', '@e3', '@e4', '@e5', '@e6'] },
      ] as const) {
        await t.test(
          `${kind} fills the chosen fields after a restart: ${passwordSelector}`,
          async () => {
            pageOrigin = origin;
            const turn = await turns.turn();
            const raw = {
              origin,
              label: 'Synthetic sign-in',
              kind,
              ...(kind !== 'otp' ? { usernameSelector: '@e3' } : {}),
              ...(kind !== 'identifier'
                ? {
                    passwordSelector:
                      typeof passwordSelector === 'string'
                        ? passwordSelector
                        : [...passwordSelector!],
                  }
                : {}),
            };
            const request = await vault.request(turn, 'local-development', raw);
            await turns.wait(turn);
            const before = await stored(turn.turnId);
            const selectedKey = kind === 'identifier' ? 'usernameSelector' : 'passwordSelector';
            assert.deepEqual(before.selectors[selectedKey], raw[selectedKey]);
            await app.close();
            app = Fastify();
            vault = await createVault(pool, options);
            vault.registerRoutes(app);
            const url = request.url.replace('/vault/', '/api/credential-requests/');
            if (kind === 'otp')
              assert.deepEqual(
                await vault.submitChatCode('local-development', turn.turnId, '001234', before.id),
                { status: 'submitted' },
              );
            else {
              const response = await app.inject({
                method: 'POST',
                url,
                payload: {
                  username: 'synthetic-member',
                  ...(kind === 'password' ? { password: 'synthetic-password' } : {}),
                },
              });
              assert.equal(response.statusCode, 200, response.body);
            }
            assert.equal(injections.at(-1)?.kind, kind);
            assert.deepEqual(injections.at(-1)?.[selectedKey], raw[selectedKey]);
            if (kind === 'password') assert.equal(injections.at(-1)?.usernameSelector, '@e3');
          },
        );
      }
      await t.test('a page on another origin blocks requests and submission', async () => {
        pageOrigin = origin;
        const turn = await turns.turn();
        const request = await vault.request(turn, 'local-development', {
          origin,
          label: 'Synthetic sign-in',
          kind: 'password',
          passwordSelector: '#entry',
        });
        await turns.wait(turn);
        pageOrigin = 'https://other.example.test';
        const count = injections.length;
        const url = request.url.replace('/vault/', '/api/credential-requests/');
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url,
              payload: { password: 'synthetic-password' },
            })
          ).statusCode,
          409,
        );
        await assert.rejects(
          vault.request(await turns.turn(), 'local-development', {
            origin,
            label: 'Synthetic sign-in',
            kind: 'password',
            passwordSelector: '#entry',
          }),
        );
        assert.equal(injections.length, count);
      });
      await t.test(
        'missing and overlapping field selections never request credentials',
        async () => {
          pageOrigin = origin;
          const turn = await turns.turn();
          const before = injections.length;
          for (const selectors of [
            {},
            { usernameSelector: '#entry', passwordSelector: '#entry' },
            { passwordSelector: ['@e1', '@e2'] },
          ]) {
            await assert.rejects(
              vault.request(turn, 'local-development', {
                origin,
                label: 'Synthetic sign-in',
                kind: 'password',
                ...selectors,
              }),
            );
          }
          await assert.rejects(
            vault.request(turn, 'local-development', {
              origin,
              label: 'Synthetic code',
              kind: 'otp',
              passwordSelector: ['@e1', '@e1'],
            }),
          );
          assert.equal(await stored(turn.turnId), undefined);
          assert.equal(injections.length, before);
        },
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'payment cards stay encrypted, owner-bound and separate from saved website logins',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_vault_cards_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const key = randomBytes(32);
    const owner = 'local-development';
    const headers = {
      host: 'localhost:4310',
      origin: 'http://localhost:4310',
      cookie: 'nod-access-4310=synthetic-local-access',
    };
    const expiryYear = new Date().getUTCFullYear() + 3;
    const input = {
      kind: 'card',
      label: 'Everyday card',
      cardholder: 'Synthetic Cardholder',
      cardNumber: '4242 4242-4242 4242',
      expiryMonth: 12,
      expiryYear,
    };
    await pool.query(`
      CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz);
      CREATE TABLE turns(id uuid PRIMARY KEY,parent_turn_id uuid,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text,background boolean NOT NULL DEFAULT false,started_at timestamptz,finished_at timestamptz,session_id uuid GENERATED ALWAYS AS (CASE WHEN background THEN id ELSE thread_id END) STORED);
    `);
    const start = async () => {
      const app = Fastify({ logger: false });
      registerLocalAccess(app, 4310, { key: 'synthetic-local-access' });
      const vault = await createVault(pool, {
        requestKey: Buffer.alloc(32, 42),
        keyStore: { id: 'synthetic', configured: true, getKey: async () => key },
        inject: async () => assert.fail('Cards must never enter a website login.'),
        resume: async () => assert.fail('Card management must not resume a task.'),
        retry: async () => assert.fail('Card management must not retry a task.'),
      });
      vault.registerRoutes(app);
      return { app, vault };
    };
    const { app, vault } = await start();
    const create = async (payload: Record<string, unknown> = input) => {
      const response = await app.inject({ method: 'POST', url: '/api/vault', headers, payload });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<VaultCardEntry>();
    };
    const read = (id: string, field: string, instance: FastifyInstance = app) =>
      instance.inject({ method: 'POST', url: `/api/vault/${id}/${field}`, headers, payload: {} });
    const update = (
      id: string,
      payload: Record<string, unknown>,
      instance: FastifyInstance = app,
    ) => instance.inject({ method: 'PATCH', url: `/api/vault/${id}`, headers, payload });
    try {
      const first = await create();
      await create({
        ...input,
        label: 'Travel card',
        cardNumber: '378282246310005',
      });
      await t.test(
        'cards never appear in login choices, invitations or automatic fills',
        async () => {
          const turn = { threadId: randomUUID(), turnId: randomUUID() };
          await pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [
            turn.threadId,
            owner,
          ]);
          await pool.query('INSERT INTO turns(id,owner_id,thread_id) VALUES($1,$2,$3)', [
            turn.turnId,
            owner,
            turn.threadId,
          ]);
          const requested = await vault.request(turn, owner, {
            origin: 'https://cards.example.test',
            label: 'Login',
            kind: 'password',
            usernameSelector: '#username',
            passwordSelector: '#password',
          });
          await assert.rejects(
            vault.fillSaved(turn, owner, first.id, {
              origin: 'https://cards.example.test',
              label: 'Login',
              kind: 'password',
              passwordSelector: '#password',
            }),
          );
          await pool.query(
            "UPDATE turns SET status='waiting',waiting_reason='credentials',started_at=clock_timestamp(),finished_at=clock_timestamp() WHERE id=$1",
            [turn.turnId],
          );
          const token = requested.url.split('/').at(-1)!;
          const description = await app.inject({
            url: `/api/credential-requests/${token}`,
            headers,
          });
          assert.deepEqual(description.json().savedEntries, []);
        },
      );
      await t.test('foreign records and transplanted ciphertext cannot reveal a card', async () => {
        const foreign = await create({ ...input, label: 'Foreign card' });
        await pool.query('UPDATE vault_cards SET owner_id=$2 WHERE id=$1', [
          foreign.id,
          'foreign-owner',
        ]);
        assert.equal((await read(foreign.id, 'card-number')).statusCode, 404);
        assert.equal((await update(foreign.id, input)).statusCode, 404);
        const transplanted = await create({ ...input, label: 'Transplanted card' });
        await pool.query(
          'UPDATE vault_cards SET ciphertext=(SELECT ciphertext FROM vault_cards WHERE id=$2) WHERE id=$1',
          [transplanted.id, first.id],
        );
        for (const result of [
          await read(transplanted.id, 'card-number'),
          await update(transplanted.id, input),
        ]) {
          assert.equal(result.statusCode, 500);
        }
        await app.inject({ method: 'DELETE', url: `/api/vault/${foreign.id}`, headers });
        assert.equal(
          (await pool.query('SELECT id FROM vault_cards WHERE id=$1', [foreign.id])).rowCount,
          1,
        );
      });

      await t.test('nod never keeps a security code, even one saved before', async () => {
        for (const response of [
          await app.inject({
            method: 'POST',
            url: '/api/vault',
            headers,
            payload: { ...input, label: 'With code', securityCode: '737' },
          }),
          await update(first.id, { ...input, securityCode: '737' }),
        ])
          assert.equal(response.statusCode, 400);
        const saved = await create({ ...input, label: 'Saved before' });
        const binding = ['nod-vault-card-v1', owner, saved.id];
        const sealed = async () =>
          (
            await pool.query<{ ciphertext: string }>(
              'SELECT ciphertext FROM vault_cards WHERE id=$1',
              [saved.id],
            )
          ).rows[0]!.ciphertext;
        const stored = JSON.parse(openVaultValue(key, binding, await sealed()));
        await pool.query('UPDATE vault_cards SET ciphertext=$2 WHERE id=$1', [
          saved.id,
          sealVaultValue(key, binding, JSON.stringify({ ...stored, securityCode: '737' })),
        ]);
        let unlocked = false;
        const locked = await createVault(pool, {
          requestKey: Buffer.alloc(32, 42),
          keyStore: {
            id: 'synthetic',
            configured: true,
            getKey: async () => {
              if (!unlocked) throw new Error('Synthetic locked key store.');
              return key;
            },
          },
          inject: async () => assert.fail('Cards must never enter a website login.'),
          resume: async () => assert.fail('Card management must not resume a task.'),
          retry: async () => assert.fail('Card management must not retry a task.'),
        });
        assert.equal(
          'securityCode' in JSON.parse(openVaultValue(key, binding, await sealed())),
          true,
        );
        unlocked = true;
        assert.deepEqual(await locked.paymentCard(saved.id), stored);
        assert.deepEqual(JSON.parse(openVaultValue(key, binding, await sealed())), stored);
        await pool.query('UPDATE vault_cards SET ciphertext=$2 WHERE id=$1', [
          saved.id,
          sealVaultValue(key, binding, JSON.stringify({ ...stored, securityCode: '737' })),
        ]);
        const restarted = await start();
        try {
          assert.deepEqual(JSON.parse(openVaultValue(key, binding, await sealed())), stored);
          assert.deepEqual(await restarted.vault.paymentCard(saved.id), stored);
        } finally {
          await restarted.app.close();
        }
      });
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
test(
  'saved login reads and edits stay explicit, owned and outside list metadata',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_vault_logins_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await pool.query(
      'CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz)',
    );
    await pool.query(
      "CREATE TABLE turns(id uuid PRIMARY KEY,parent_turn_id uuid,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running')",
    );
    const key = randomBytes(32);
    const headers = {
      host: 'localhost:4310',
      origin: 'http://localhost:4310',
      cookie: 'nod-access-4310=synthetic-local-access',
    };
    const start = async (getKey: () => Promise<Buffer> = async () => key) => {
      const instance = Fastify({ logger: false });
      registerLocalAccess(instance, 4310, { key: 'synthetic-local-access' });
      const vault = await createVault(pool, {
        requestKey: Buffer.alloc(32, 42),
        keyStore: checkedKeyStore(pool, { id: 'fixture', configured: true, getKey }),
        inject: async () => assert.fail('Viewing or editing a login must not fill a browser.'),
        resume: async () => assert.fail('Viewing or editing a login must not resume a turn.'),
        retry: async () => assert.fail('Viewing or editing a login must not restart a turn.'),
      });
      vault.registerRoutes(instance);
      return instance;
    };
    let app: FastifyInstance = await start();
    const patch = (id: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'PATCH', url: `/api/vault/${id}`, headers, payload });
    const read = (id: string, field: 'details' | 'password') =>
      app.inject({ method: 'POST', url: `/api/vault/${id}/${field}`, headers, payload: {} });
    const save = async (label: string, origin = 'https://accounts.example.test:8443') => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault',
        headers,
        payload: {
          label,
          origin,
          username: `${label}@example.test`,
          password: `${label}-secret`,
        },
      });
      assert.equal(response.statusCode, 200);
      return response.json<VaultLoginEntry>();
    };
    const holdKey = async () => {
      await app.close();
      let release!: (value: Buffer) => void;
      let started!: () => void;
      const reached = new Promise<void>((resolve) => {
        started = resolve;
      });
      const waiting = new Promise<Buffer>((resolve) => {
        release = resolve;
      });
      app = await start(async () => {
        started();
        return waiting;
      });
      return { reached, release: () => release(key) };
    };
    try {
      const first = await save('First');
      const second = await save('Second');
      await t.test(
        'foreign, missing and malformed IDs and body overrides cannot read or change values',
        async () => {
          const foreign = await save('Foreign');
          await pool.query('UPDATE vault_entries SET owner_id=$2 WHERE id=$1', [
            foreign.id,
            'foreign-owner',
          ]);
          for (const field of ['details', 'password'] as const) {
            for (const id of [foreign.id, randomUUID()]) {
              const response = await read(id, field);
              assert.equal(response.statusCode, 404);
            }
            assert.equal((await read('not-an-id', field)).statusCode, 400);
            for (const payload of [{ ownerId: 'foreign-owner' }, { password: 'injected-secret' }]) {
              const response = await app.inject({
                method: 'POST',
                url: `/api/vault/${first.id}/${field}`,
                headers,
                payload,
              });
              assert.equal(response.statusCode, 400);
              assert.doesNotMatch(response.body, /foreign-owner|injected-secret|First-secret/);
            }
          }
          for (const id of [foreign.id, randomUUID()])
            assert.equal((await patch(id, { label: 'wrong', username: 'wrong' })).statusCode, 404);
          assert.equal(
            (await patch(first.id, { label: 'name', username: 'user', ownerId: 'foreign' }))
              .statusCode,
            400,
          );
          assert.equal((await read(foreign.id, 'details')).statusCode, 404);
          assert.equal(
            (await pool.query('SELECT label FROM vault_entries WHERE id=$1', [foreign.id])).rows[0]
              .label,
            'Foreign',
          );
        },
      );

      await t.test(
        'deletion or ownership changes during key access cannot release an old value',
        async () => {
          for (const field of ['details', 'password'] as const) {
            const entry = await save(`Read-${field}`);
            const held = await holdKey();
            const pending = read(entry.id, field).then((response) => response);
            await held.reached;
            if (field === 'details')
              await pool.query('DELETE FROM vault_entries WHERE id=$1', [entry.id]);
            else
              await pool.query('UPDATE vault_entries SET owner_id=$2 WHERE id=$1', [
                entry.id,
                'foreign-owner',
              ]);
            held.release();
            const response = await pending;
            assert.equal(response.statusCode, 404);
            assert.doesNotMatch(response.body, /Read-.*-secret/);
          }
        },
      );

      await t.test(
        'a different Vault key fails closed instead of sealing beside the old one',
        async () => {
          const kept = await save('Kept');
          const count = async () =>
            (await pool.query('SELECT count(*)::int AS n FROM vault_entries')).rows[0].n;
          const before = await count();
          await app.close();
          app = await start(async () => randomBytes(32));
          assert.equal((await read(kept.id, 'details')).statusCode, 503);
          const refused = await app.inject({
            method: 'POST',
            url: '/api/vault',
            headers,
            payload: {
              label: 'Wrong key',
              origin: 'https://accounts.example.test:8443',
              username: 'wrong-key@example.test',
              password: 'wrong-key-secret',
            },
          });
          assert.equal(refused.statusCode, 503);
          assert.equal(await count(), before);
          await app.close();
          app = await start();
          assert.equal((await read(kept.id, 'password')).json().password, 'Kept-secret');
        },
      );

      await t.test(
        'an import adds new logins encrypted and keeps the ones already saved',
        async () => {
          const existing = await app.inject({
            method: 'POST',
            url: '/api/vault',
            headers,
            payload: {
              label: 'Kept',
              origin: 'https://import.example.com',
              username: 'kept@example.test',
              password: 'kept-original-secret',
            },
          });
          assert.equal(existing.statusCode, 200);
          const { logins, unreadable } = parsePasswordCsv(
            'name,url,username,password,note\n' +
              'Kept,https://import.example.com/login,kept@example.test,kept-changed-secret,\n' +
              'Fresh,http://import.example.com/,fresh@example.test,fresh-import-secret,\n' +
              'Fresh again,https://import.example.com,fresh@example.test,fresh-import-secret,\n' +
              ',https://other.example.org,,other-import-secret,\n' +
              'App,android://key@com.fixture.app/,ana,app-import-secret,\n',
          );
          assert.equal(unreadable, 1);
          const imported = await app.inject({
            method: 'POST',
            url: '/api/vault/import',
            headers,
            payload: {
              logins: [
                ...logins,
                {
                  label: 'Router',
                  origin: 'https://router',
                  username: 'admin',
                  password: 'router-import-secret',
                },
                {
                  label: 'Path',
                  origin: 'https://path.fixture.test/login',
                  username: 'path',
                  password: 'path-import-secret',
                },
                { ...logins[0], notes: 'Synthetic note' },
              ],
            },
          });
          assert.equal(imported.statusCode, 200);
          assert.deepEqual(imported.json(), {
            imported: 2,
            existing: 2,
            skipped: 3,
            authenticatorKeys: 0,
          });
          assert.equal(imported.body.includes('secret'), false);
          const listed = (await app.inject({ url: '/api/vault', headers })).json<
            VaultLoginEntry[]
          >();
          const fresh = listed.find((entry) => entry.label === 'Fresh again');
          const other = listed.find((entry) => entry.label === 'other.example.org');
          assert.equal(fresh?.origin, 'https://import.example.com');
          assert.equal(other?.origin, 'https://other.example.org');
          assert.equal((await read(fresh!.id, 'password')).json().password, 'fresh-import-secret');
          const kept = listed.find((entry) => entry.label === 'Kept');
          assert.equal((await read(kept!.id, 'password')).json().password, 'kept-original-secret');
          const stored = await pool.query(
            'SELECT label,origin,username_hint,ciphertext FROM vault_entries',
          );
          assert.equal(JSON.stringify(stored.rows).includes('import-secret'), false);
          assert.equal(JSON.stringify(stored.rows).includes('fresh@example.test'), false);
          const keyed = parsePasswordCsv(
            'Title,Url,Username,Password,OTPAuth\n' +
              'Kept,https://import.example.com,kept@example.test,kept-changed-secret,otpauth://totp/Kept?secret=JBSWY3DPEHPK3PXP\n' +
              'Keyed,https://keyed.example.com,keyed@example.test,keyed-import-secret,JBSWY3DPEHPK3PXPJBSWY3DP\n',
          );
          const rekeyed = await app.inject({
            method: 'POST',
            url: '/api/vault/import',
            headers,
            payload: {
              logins: [
                ...keyed.logins,
                {
                  label: 'Bad key',
                  origin: 'https://bad-key.example.com',
                  username: 'bad@example.test',
                  password: 'bad-key-import-secret',
                  authenticatorKey: 'otpauth://hotp/Bad?secret=JBSWY3DPEHPK3PXP',
                },
              ],
            },
          });
          assert.deepEqual(rekeyed.json(), {
            imported: 1,
            existing: 1,
            skipped: 1,
            authenticatorKeys: 2,
          });
          const relisted = (await app.inject({ url: '/api/vault', headers })).json<
            VaultLoginEntry[]
          >();
          const keptAgain = relisted.find(
            (entry) => entry.label === 'Kept' && entry.origin === 'https://import.example.com',
          )!;
          assert.equal((await read(keptAgain.id, 'details')).json().hasAuthenticator, true);
          assert.equal(
            (await read(keptAgain.id, 'password')).json().password,
            'kept-original-secret',
          );
          assert.equal(
            relisted.some((entry) => entry.label === 'Bad key'),
            false,
          );
          const sealed = JSON.stringify((await pool.query('SELECT * FROM vault_entries')).rows);
          assert.doesNotMatch(sealed, /JBSWY3DP|otpauth/i);
          assert.doesNotMatch(JSON.stringify(relisted), /JBSWY3DP|otpauth|authenticator/i);
        },
      );

      await t.test(
        'an authenticator key is checked, kept, replaced and removed only on request',
        async () => {
          const entry = await save('Keyed');
          const details = async () => (await read(entry.id, 'details')).json();
          const change = (payload: Record<string, unknown>) =>
            patch(entry.id, { label: 'Keyed', username: 'Keyed@example.test', ...payload });
          assert.equal((await details()).hasAuthenticator, false);
          const refused = await change({
            authenticatorKey: 'otpauth://hotp/Keyed?secret=JBSWY3DPEHPK3PXP&counter=1',
          });
          assert.equal(refused.statusCode, 400);
          assert.match(refused.json().error, /authenticator key/);
          assert.equal((await details()).hasAuthenticator, false);
          assert.equal((await change({ authenticatorKey: 'JBSWY3DPEHPK3PXP' })).statusCode, 200);
          assert.equal((await details()).hasAuthenticator, true);
          assert.equal((await change({ label: 'Renamed' })).statusCode, 200);
          assert.equal((await details()).hasAuthenticator, true);
          assert.equal((await read(entry.id, 'password')).json().password, 'Keyed-secret');
          assert.equal((await change({ authenticatorKey: '' })).statusCode, 200);
          assert.equal((await details()).hasAuthenticator, false);
          assert.equal((await read(entry.id, 'password')).json().password, 'Keyed-secret');
          const created = await app.inject({
            method: 'POST',
            url: '/api/vault',
            headers,
            payload: {
              label: 'Unusable',
              origin: 'https://unusable.example.test',
              username: 'unusable@example.test',
              password: 'unusable-secret',
              authenticatorKey: 'steam://JBSWY3DPEHPK3PXP',
            },
          });
          assert.equal(created.statusCode, 400);
          assert.equal(
            (
              await pool.query('SELECT 1 FROM vault_entries WHERE origin=$1', [
                'https://unusable.example.test',
              ])
            ).rowCount,
            0,
          );
        },
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'a saved authenticator key enters one current code for the account this task signed in with',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_vault_authenticator_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    try {
      const { turn } = await seedTurns(pool);
      const owner = 'local-development';
      const origin = 'https://bank.example.test';
      let observedOrigin = origin;
      const injections: CredentialInjection[] = [];
      const vault = await createVault(pool, {
        requestKey: Buffer.alloc(32, 42),
        keyStore: { id: 'fixture', configured: true, getKey: async () => Buffer.alloc(32, 9) },
        page: async () => ({ origin: observedOrigin, url: `${observedOrigin}/verify` }),
        inject: async (input) => {
          injections.push(input);
          return { status: 'submitted' as const };
        },
        resume: async () => {},
        retry: async () => {},
      });
      const authenticator =
        'otpauth://totp/Bank:first?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Bank';
      const first = await vault.saveLogin({
        origin,
        label: 'First',
        username: 'first@bank.example.test',
        password: 'first-synthetic-password',
        authenticatorKey: authenticator,
      });
      const second = await vault.saveLogin({
        origin,
        label: 'Second',
        username: 'second@bank.example.test',
        password: 'second-synthetic-password',
      });
      const code = { origin, label: 'Bank code', kind: 'otp' as const, passwordSelector: '#code' };
      const password = {
        origin,
        label: 'Bank',
        kind: 'password' as const,
        usernameSelector: '#user',
        passwordSelector: '#password',
      };
      const current = () => authenticatorCode(authenticatorKey(authenticator)!);

      await t.test('the code goes to the login this task entered, once per sign-in', async () => {
        const task = await turn();
        const realNow = Date.now;
        Date.now = () => realNow() + 5_000;
        try {
          assert.equal(await vault.fillSaved(task, owner, first.id, password), true);
        } finally {
          Date.now = realNow;
        }
        assert.equal((await vault.authenticatorLogin(task, owner, origin))?.id, first.id);
        const before = current();
        assert.equal(await vault.fillAuthenticatorCode(task, owner, first.id, code), true);
        const after = current();
        const entered = injections.at(-1)!;
        assert.equal(entered.kind, 'otp');
        assert.equal(entered.password, undefined);
        assert.match(entered.code!, /^\d{6}$/);
        assert.ok([before, after].includes(entered.code!));
        assert.equal(await vault.fillAuthenticatorCode(task, owner, first.id, code), false);
        assert.equal(injections.filter((input) => input.kind === 'otp').length, 1);
      });

      await t.test('another account in the same task never receives the key', async () => {
        const task = await turn();
        assert.equal(await vault.fillSaved(task, owner, second.id, password), true);
        assert.equal(await vault.authenticatorLogin(task, owner, origin), undefined);
        assert.equal(await vault.authenticatorLogin(task, owner, origin, first.id), undefined);
        const entered = injections.length;
        await assert.rejects(
          vault.fillAuthenticatorCode(task, owner, first.id, code),
          /matches the account already entered/,
        );
        assert.equal(injections.length, entered);
      });

      await t.test('an expired sign-in choice never gets a code', async () => {
        const task = await turn();
        assert.equal(await vault.fillSaved(task, owner, first.id, password), true);
        await pool.query(
          "UPDATE credential_account_selections SET expires_at=now()-interval '1 second' WHERE origin=$1",
          [origin],
        );
        assert.equal(await vault.authenticatorLogin(task, owner, origin), undefined);
        const entered = injections.length;
        await assert.rejects(
          vault.fillAuthenticatorCode(task, owner, first.id, code),
          /took too long/,
        );
        assert.equal(injections.length, entered);
      });

      await t.test('without a sign-in, only the named or single keyed login applies', async () => {
        const task = await turn();
        assert.equal((await vault.authenticatorLogin(task, owner, origin))?.id, first.id);
        assert.equal(await vault.authenticatorLogin(task, owner, origin, second.id), undefined);
        assert.equal(await vault.authenticatorLogin(task, 'another-owner', origin), undefined);
        assert.equal(
          await vault.authenticatorLogin(task, owner, 'https://other.example.test'),
          undefined,
        );
        assert.equal(
          await vault.fillAuthenticatorCode(task, owner, first.id, { ...code, emailCode: true }),
          false,
        );
        const entered = injections.length;
        observedOrigin = 'https://bank.example.test.attacker.example';
        await assert.rejects(
          vault.fillAuthenticatorCode(task, owner, first.id, code),
          /origin changed/,
        );
        observedOrigin = origin;
        assert.equal(injections.length, entered);
        await vault.saveLogin({
          origin,
          label: 'Second',
          username: 'second@bank.example.test',
          password: 'second-synthetic-password',
          authenticatorKey: 'JBSWY3DPEHPK3PXP',
        });
        assert.equal(await vault.authenticatorLogin(task, owner, origin), undefined);
        assert.equal(
          (await vault.authenticatorLogin(task, owner, origin, second.id))?.id,
          second.id,
        );
      });

      await t.test('the key stays sealed and out of every listing', async () => {
        const sealed = JSON.stringify((await pool.query('SELECT * FROM vault_entries')).rows);
        assert.doesNotMatch(sealed, /JBSWY3DP|otpauth/i);
        assert.doesNotMatch(JSON.stringify(await vault.list()), /JBSWY3DP|otpauth|authenticator/i);
        const uses = (
          await pool.query("SELECT item_id FROM vault_uses WHERE kind='otp' ORDER BY created_at")
        ).rows;
        assert.deepEqual(uses, [{ item_id: first.id }]);
      });
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'a password manager login picked in the private form is saved sealed and entered once',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_vault_manager_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    const bare = Fastify();
    try {
      const { turn, wait } = await seedTurns(pool);
      const owner = 'local-development';
      const origin = 'https://bank.example.test';
      const calls: string[] = [];
      const injections: CredentialInjection[] = [];
      const resumed: string[] = [];
      const password = 'manager-synthetic-password';
      const manager: PasswordManager = {
        name: '1Password',
        logins: async (account, site) => {
          calls.push(`logins ${account} ${site}`);
          if (account === 'Unreachable')
            throw new PasswordManagerError('unavailable', 'The library did not load.');
          return [
            { id: 'v1/i1', title: 'Bank', username: 'owner@bank.example.test', website: origin },
          ];
        },
        login: async (account, site, id) => {
          calls.push(`login ${account} ${site} ${id}`);
          if (id !== 'v1/i1')
            throw new PasswordManagerError(
              'missing',
              'This 1Password login is not for this website.',
            );
          return {
            title: 'Bank',
            username: 'owner@bank.example.test',
            password,
            authenticatorKey: 'otpauth://totp/Bank:owner?secret=JBSWY3DPEHPK3PXP&issuer=Bank',
          };
        },
        close: async () => {},
      };
      const options = {
        requestKey: Buffer.alloc(32, 42),
        keyStore: { id: 'fixture', configured: true, getKey: async () => Buffer.alloc(32, 5) },
        page: async () => ({ origin, url: `${origin}/login` }),
        inject: async (input: CredentialInjection) => {
          injections.push(input);
          return { status: 'submitted' as const };
        },
        resume: async (turnId: string) => {
          resumed.push(turnId);
        },
        retry: async () => {},
      };
      const vault = await createVault(pool, { ...options, passwordManager: manager });
      vault.registerRoutes(app);
      const request = {
        origin,
        label: 'Bank',
        kind: 'password' as const,
        usernameSelector: '#user',
        passwordSelector: '#password',
      };
      const task = await turn();
      const token = (await vault.request(task, owner, request)).url.split('/').at(-1)!;
      await wait(task);
      const path = `/api/credential-requests/${token}`;
      const describe = async () => (await app.inject({ url: path })).json<CredentialRequest>();
      const post = (suffix: string, payload: Record<string, unknown>) =>
        app.inject({ method: 'POST', url: `${path}${suffix}`, payload });

      await t.test('the form offers the manager and explains a missing app', async () => {
        assert.deepEqual((await describe()).passwordManager, { name: '1Password' });
        const failed = await post('/password-manager', { account: 'Unreachable' });
        assert.equal(failed.statusCode, 502);
        assert.match(failed.json().error, /Integrate with other apps/);
        assert.deepEqual((await describe()).passwordManager, { name: '1Password' });
        assert.equal((await post('/password-manager', { account: ' ' })).statusCode, 400);
      });

      await t.test('listing remembers the account and returns no secret', async () => {
        const listed = await post('/password-manager', { account: 'Synthetic Family' });
        assert.equal(listed.statusCode, 200);
        assert.deepEqual(listed.json().logins, [
          { id: 'v1/i1', title: 'Bank', username: 'owner@bank.example.test', website: origin },
        ]);
        assert.doesNotMatch(listed.body, /manager-synthetic-password|JBSWY3DP/);
        assert.deepEqual((await describe()).passwordManager, {
          name: '1Password',
          account: 'Synthetic Family',
        });
        assert.equal(calls.at(-1), `logins Synthetic Family ${origin}`);
      });

      await t.test('a login for another website is refused before anything is saved', async () => {
        const refused = await post('/password-manager/use', {
          account: 'Synthetic Family',
          id: 'v1/elsewhere',
        });
        assert.equal(refused.statusCode, 409);
        assert.match(refused.json().error, /not for this website/);
        assert.equal((await pool.query('SELECT 1 FROM vault_entries')).rowCount, 0);
        assert.equal(injections.length, 0);
      });

      await t.test('the picked login is sealed with its key and entered once', async () => {
        const used = await post('/password-manager/use', {
          account: 'Synthetic Family',
          id: 'v1/i1',
        });
        assert.equal(used.statusCode, 200, used.body);
        assert.deepEqual(used.json(), { ok: true });
        assert.equal(injections.length, 1);
        assert.equal(calls.at(-1), `login Synthetic Family ${origin} v1/i1`);
        assert.equal(injections[0]!.password, password);
        assert.equal(injections[0]!.username, 'owner@bank.example.test');
        assert.deepEqual(resumed, [task.turnId]);
        const [saved] = await vault.list();
        assert.equal(saved?.label, 'Bank');
        assert.equal(saved?.origin, origin);
        const { secret } = await vault.readCredential(saved!.id);
        assert.equal(secret.password, password);
        assert.ok(secret.authenticator);
        const sealed = JSON.stringify((await pool.query('SELECT * FROM vault_entries')).rows);
        assert.doesNotMatch(sealed, /manager-synthetic-password|JBSWY3DP|owner@bank/);
        assert.equal((await describe()).status, 'filled');
        assert.equal((await describe()).passwordManager, undefined);
        const reads = calls.length;
        const again = await post('/password-manager/use', {
          account: 'Synthetic Family',
          id: 'v1/i1',
        });
        assert.equal(again.statusCode, 409);
        assert.equal(calls.length, reads);
        assert.equal(injections.length, 1);
      });

      await t.test('other owners and nods without a manager get nothing', async () => {
        const foreign = await turn('another-owner');
        const foreignToken = (await vault.request(foreign, 'another-owner', request)).url
          .split('/')
          .at(-1)!;
        await wait(foreign);
        const before = calls.length;
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: `/api/credential-requests/${foreignToken}/password-manager`,
              payload: { account: 'Synthetic Family' },
            })
          ).statusCode,
          409,
        );
        assert.equal(calls.length, before);
        const plain = await createVault(pool, options);
        plain.registerRoutes(bare);
        const next = await turn();
        const plainToken = (await plain.request(next, owner, request)).url.split('/').at(-1)!;
        await wait(next);
        const described = (
          await bare.inject({ url: `/api/credential-requests/${plainToken}` })
        ).json<CredentialRequest>();
        assert.equal(described.passwordManager, undefined);
        assert.equal(
          (
            await bare.inject({
              method: 'POST',
              url: `/api/credential-requests/${plainToken}/password-manager`,
              payload: { account: 'Synthetic Family' },
            })
          ).statusCode,
          404,
        );
      });
    } finally {
      await app.close();
      await bare.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'one Vault form securely carries a password across identifier stages and restart',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_vault_one_form_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await pool.query(
        'CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz)',
      );
      await pool.query(
        "CREATE TABLE turns(id uuid PRIMARY KEY,parent_turn_id uuid,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text,background boolean NOT NULL DEFAULT false,started_at timestamptz,session_id uuid GENERATED ALWAYS AS (CASE WHEN background THEN id ELSE thread_id END) STORED)",
      );
      const threadId = randomUUID();
      await pool.query("INSERT INTO threads(id,owner_id) VALUES($1,'local-development')", [
        threadId,
      ]);
      const tasks = new Map<string, TurnRef>();
      const roots = new Map<string, string>();
      const startTurn = async (resumeOf?: string) => {
        const turnId = randomUUID();
        await pool.query(
          "INSERT INTO turns(id,owner_id,thread_id,source,source_id,parent_turn_id,started_at) VALUES($1,'local-development',$2,$3,$4,$5,clock_timestamp())",
          [
            turnId,
            threadId,
            resumeOf ? 'resume' : 'user',
            resumeOf ? `credentials:${resumeOf}` : null,
            resumeOf ?? null,
          ],
        );
        return { threadId, turnId };
      };
      const task = (name: string) => tasks.get(name)!;
      const key = randomBytes(32);
      const stages = new Map<string, CredentialKind>();
      const injections: CredentialInjection[] = [];
      const origin = 'https://accounts.example.test';
      let observedOrigin = origin;
      let unavailable = false;
      const options = {
        requestKey: Buffer.alloc(32, 42),
        keyStore: { id: 'fixture', configured: true, getKey: async () => key },
        page: async () => ({ origin: observedOrigin, url: observedOrigin + '/login' }),
        inject: async (input: CredentialInjection) => {
          injections.push(input);
          if (unavailable && input.kind === 'password') throw new Error('Synthetic unavailable');
          stages.set(input.threadId, input.kind === 'identifier' ? 'password' : 'otp');
          return { status: 'submitted' as const };
        },
        retry: async () => {},
        resume: async (turnId: string) => {
          const name = [...tasks].find(([, value]) => value.turnId === turnId)?.[0];
          assert.ok(name);
          const result = await pool.query(
            "SELECT 1 FROM turns WHERE id=$1 AND status='waiting' AND waiting_reason='credentials'",
            [turnId],
          );
          assert.equal(result.rowCount, 1);
          tasks.set(name, await startTurn(turnId));
        },
      };
      const vault = await createVault(pool, options);
      vault.registerRoutes(app);
      const requestInput = (kind: CredentialKind) => ({
        origin,
        label: 'Website login',
        kind,
        ...(kind === 'identifier'
          ? { usernameSelector: '#observed' }
          : { passwordSelector: '#observed' }),
      });
      const wait = (turn: TurnRef) =>
        pool.query("UPDATE turns SET status='waiting',waiting_reason='credentials' WHERE id=$1", [
          turn.turnId,
        ]);
      const begin = async (
        id: string,
        credentials = {
          username: 'synthetic@example.test',
          password: 'one-form-synthetic-password',
        } as { username: string; password?: string },
      ) => {
        if (!tasks.has(id)) {
          const turn = await startTurn();
          tasks.set(id, turn);
          roots.set(id, turn.turnId);
        }
        stages.set(threadId, 'identifier');
        const request = await vault.request(
          task(id),
          'local-development',
          requestInput('identifier'),
        );
        await wait(task(id));
        const url = request.url.replace('/vault/', '/api/credential-requests/');
        const submitted = await app.inject({
          method: 'POST',
          url,
          payload: credentials,
        });
        assert.equal(submitted.statusCode, 200);
        assert.equal(submitted.json().ok, true);
        assert.equal(injections.at(-1)?.kind, 'identifier');
        assert.equal(injections.at(-1)?.password, undefined);
        return url;
      };

      await t.test(
        'an uncertain password attempt clears its held value and is not replayed',
        async () => {
          await begin('interrupted');
          unavailable = true;
          await assert.rejects(
            vault.fillSelected(task('interrupted'), 'local-development', requestInput('password')),
          );
          unavailable = false;
          const selected = (
            await pool.query('SELECT * FROM credential_account_selections WHERE root_turn_id=$1', [
              roots.get('interrupted'),
            ])
          ).rows[0];
          assert.equal(selected.blocked, true);
          assert.equal(openCredential(key, selected).password, '');
          const count = injections.length;
          assert.equal(
            await vault.fillSelected(
              task('interrupted'),
              'local-development',
              requestInput('password'),
            ),
            false,
          );
          assert.equal(injections.length, count);
        },
      );

      await t.test('identifier recovery never fills or replays a held password', async () => {
        await begin('held-password-recovery');
        const turn = task('held-password-recovery');
        assert.equal(
          await vault.fillSelected(turn, 'local-development', requestInput('identifier')),
          true,
        );
        assert.equal(injections.at(-1)?.username, 'synthetic@example.test');
        assert.equal(injections.at(-1)?.password, undefined);
        assert.equal(
          await vault.fillSelected(turn, 'local-development', requestInput('password')),
          true,
        );
        assert.equal(injections.at(-1)?.password, 'one-form-synthetic-password');
        const before = injections.length;
        assert.equal(
          await vault.fillSelected(turn, 'local-development', requestInput('password')),
          undefined,
        );
        assert.equal(injections.length, before);
      });

      await t.test(
        'held credentials remain bound to owner, origin, running turn and expiry',
        async () => {
          const second = await app.inject({
            method: 'POST',
            url: '/api/vault',
            payload: {
              label: 'Second account',
              origin,
              username: 'second-member@example.test',
              password: 'second-synthetic-password',
            },
          });
          assert.equal(second.statusCode, 200);
          for (const kind of ['password', 'identifier'] as const) {
            const name = `fences-${kind}`;
            await begin(
              name,
              kind === 'identifier' ? { username: 'fenced-member@example.test' } : undefined,
            );
            const turn = task(name);
            const input = requestInput(kind);
            const count = injections.length;
            assert.equal(await vault.fillSelected(turn, 'another-owner', input), undefined);
            assert.equal(
              await vault.fillSelected(turn, 'local-development', {
                ...input,
                origin: 'https://other.example.test',
              }),
              undefined,
            );
            observedOrigin = 'https://other.example.test';
            assert.equal(await vault.fillSelected(turn, 'local-development', input), false);
            observedOrigin = origin;
            await pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [turn.turnId]);
            assert.equal(await vault.fillSelected(turn, 'local-development', input), false);
            await pool.query("UPDATE turns SET status='running' WHERE id=$1", [turn.turnId]);
            assert.equal(
              await vault.fillSelected(turn, 'local-development', requestInput('otp')),
              false,
            );
            await pool.query(
              "UPDATE credential_account_selections SET expires_at=now()-interval '1 second' WHERE root_turn_id=$1",
              [roots.get(name)],
            );
            assert.equal(await vault.fillSelected(turn, 'local-development', input), false);
            assert.equal(injections.length, count);
            const later = await startTurn();
            assert.equal(await vault.fillSelected(later, 'local-development', input), undefined);
            const request = await vault.request(later, 'local-development', input);
            if (kind === 'password') {
              const expired = (
                await pool.query(
                  'SELECT * FROM credential_account_selections WHERE root_turn_id=$1',
                  [roots.get(name)],
                )
              ).rows[0];
              assert.equal(expired.ciphertext, '');
              assert.equal(expired.blocked, true);
            }
            await wait(later);
            const response = await app.inject({
              url: request.url.replace('/vault/', '/api/credential-requests/'),
            });
            assert.ok(response.json().savedEntries.length > 1);
            assert.equal(response.json().selectedEntryId, undefined);
            assert.equal(injections.length, count);
          }
        },
      );
    } finally {
      try {
        await app.close();
      } finally {
        try {
          await pool.end();
        } finally {
          try {
            await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
          } finally {
            await admin.end();
          }
        }
      }
    }
  },
);

const now = Date.now();
const request = {
  recipient: 'owner@example.com',
  origin: 'https://app20.toconline.pt',
  after: now - 30_000,
  before: now,
};
const message: VerificationEmail = {
  id: 'fixture-mail',
  receivedAt: now - 1000,
  sender: 'login@toconline.pt',
  authenticatedDomain: 'toconline.pt',
  recipients: ['owner@example.com'],
  text: 'O seu código de autenticação é 381742.',
};

test('email verification binds authenticated messages to a recent exact recipient and one code', () => {
  assert.equal(verificationCode([message], request), '381742');
  for (const changed of [
    { receivedAt: request.after - 1 },
    { receivedAt: now + 1 },
    { recipients: ['other@example.com'] },
    { sender: 'attacker@evil.com' },
    { authenticatedDomain: 'evil.com', sender: 'login@evil.com' },
    {
      authenticatedDomain: 'example.com',
      sender: 'login@transactional.example.com',
      text: `Your verification code is 381742. Verify email: ${request.origin}/verify?token=abcdefghijklmnop`,
    },
    { text: 'Your verification codes are 381742 and 940173.' },
    { text: 'Your receipt number is 381742.' },
    { text: 'Your login code is a381742b.' },
  ])
    assert.equal(verificationCode([{ ...message, ...changed }], request), undefined);
  assert.equal(verificationCode([message, { ...message, id: 'second' }], request), undefined);
  assert.equal(verificationCode([], request), undefined);
  assert.equal(
    verificationCode(
      [{ ...message, text: 'Verification code: 381742. Use verification code 381742.' }],
      request,
    ),
    '381742',
  );
});

test('site matching uses public suffix boundaries and separates hosted tenants', () => {
  for (const [origin, domain] of [
    ['https://app20.toconline.pt', 'toconline.pt'],
    ['https://accounts.google.com', 'google.com'],
    ['https://login.example.co.uk', 'example.co.uk'],
    ['https://login.tenant.github.io', 'tenant.github.io'],
  ])
    assert.equal(verificationSenderDomain(origin), domain);
  for (const origin of [
    'https://co.uk',
    'https://github.io',
    'https://127.0.0.1',
    'https://[::1]',
    'http://example.com',
    'https://example.com/path',
    'https://user@example.com',
    'https://example.invalid',
    'broken',
  ])
    assert.equal(verificationSenderDomain(origin), undefined);
  const tenant = { ...request, origin: 'https://login.tenant.github.io' };
  assert.equal(
    verificationCode(
      [{ ...message, sender: 'login@other.github.io', authenticatedDomain: 'other.github.io' }],
      tenant,
    ),
    undefined,
  );
  assert.equal(
    verificationCode(
      [
        {
          ...message,
          sender: 'login@mail.tenant.github.io',
          authenticatedDomain: 'mail.tenant.github.io',
        },
      ],
      tenant,
    ),
    '381742',
  );
  assert.equal(
    verificationCode(
      [{ ...message, sender: 'login@evil-toconline.pt', authenticatedDomain: 'evil-toconline.pt' }],
      request,
    ),
    undefined,
  );
});

test(
  'a payment enters the card only into the approved merchant after the owner replies with the code',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async () => {
    const schema = `test_vault_pay_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
      max: 1,
      connectionTimeoutMillis: 1000,
    });
    const headers = {
      host: 'localhost:4310',
      origin: 'http://localhost:4310',
      cookie: 'nod-access-4310=synthetic-local-access',
    };
    const key = randomBytes(32);
    const app = Fastify({ logger: false });
    registerLocalAccess(app, 4310, { key: 'synthetic-local-access' });
    try {
      await pool.query(`
        CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz);
        CREATE TABLE turns(id uuid PRIMARY KEY,parent_turn_id uuid,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',background boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),session_id uuid GENERATED ALWAYS AS (CASE WHEN background THEN id ELSE thread_id END) STORED);
      `);
      const vault = await createVault(pool, {
        requestKey: Buffer.alloc(32, 42),
        keyStore: checkedKeyStore(pool, {
          id: 'synthetic',
          configured: true,
          getKey: async () => key,
        }),
        inject: async () => assert.fail('A payment never types a login.'),
        resume: async () => assert.fail('Card management must not resume a task.'),
        retry: async () => assert.fail('Card management must not retry a task.'),
      });
      vault.registerRoutes(app);
      const fills: CardEntry[] = [];
      const resumed: string[] = [];
      const url = 'https://shop.fixture.test/checkout';
      let elsewhere: string | undefined;
      let captureFails = false;
      let failFill = false;
      let presentationFailure = false;
      let presentedText = 'Synthetic private payment step.';
      let duringPresentation = async () => {};
      const presentations: Array<{
        turn: { threadId: string; turnId: string };
        input: Record<string, unknown>;
      }> = [];
      let duringFill = async () => {};
      const secureEntries: string[] = [];
      const make = () =>
        createPayments(pool, {
          ownerId: 'local-development',
          analytics: (event) => {
            if (event.event === 'nod_secure_entry_changed')
              secureEntries.push(event.properties.status);
          },
          uses: vault.uses,
          present: async (turn, input) => {
            if (presentationFailure) throw new Error('Synthetic payment presentation failure.');
            presentations.push(structuredClone({ turn, input }));
            await duringPresentation();
            input.amount = '0.01';
            return presentedText;
          },
          page: async () => ({ origin: new URL(url).origin, url }),
          destinations: async () => {
            const origin = new URL(url).origin;
            return {
              document: 'loader-1',
              destinations: {
                number: elsewhere ?? origin,
                expiry: origin,
                securityCode: elsewhere ?? origin,
                name: origin,
              },
            };
          },
          capture: async () => {
            if (captureFails) throw new Error('Synthetic paused page.');
            return new Uint8Array([255, 216, 255]);
          },
          cards: vault.paymentCards,
          card: vault.paymentCard,
          fill: async (input) => {
            if (failFill) throw new Error('Synthetic stale field.');
            await duringFill();
            fills.push(input);
          },
          resume: async (_turnId, prompt) => {
            resumed.push(prompt);
          },
          record: async () => {},
        });
      const payments = await make();
      payments.registerRoutes(app);
      const expiryYear = new Date().getUTCFullYear() + 3;
      const save = async (label: string, cardNumber: string) => {
        const saved = await app.inject({
          method: 'POST',
          url: '/api/vault',
          headers,
          payload: {
            kind: 'card',
            label,
            cardholder: 'Synthetic Cardholder',
            cardNumber,
            expiryMonth: 8,
            expiryYear,
          },
        });
        assert.equal(saved.statusCode, 200, saved.body);
        return saved.json<VaultCardEntry>();
      };
      const card = await save('Studio card', '4242 4242 4242 4242');
      const turn = { threadId: randomUUID(), turnId: randomUUID() };
      await pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [
        turn.threadId,
        'local-development',
      ]);
      await pool.query('INSERT INTO turns(id,owner_id,thread_id) VALUES($1,$2,$3)', [
        turn.turnId,
        'local-development',
        turn.threadId,
      ]);
      const fields = {
        number: '@e4',
        expiry: { selector: '@e5', format: 'YYYY-MM' },
        securityCode: '@e6',
        name: '@e3',
      };
      const order = { amount: '43.20', currency: 'eur', fields };
      presentationFailure = true;
      await assert.rejects(payments.request(turn, order));
      presentationFailure = false;
      assert.equal((await pool.query('SELECT id FROM vault_payments')).rowCount, 0);
      assert.equal(fills.length, 0);
      presentedText = '   ';
      await assert.rejects(payments.request(turn, order));
      presentedText = 'Synthetic private payment step.';
      duringPresentation = async () => {
        await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [turn.turnId]);
      };
      await assert.rejects(payments.request(turn, order));
      duringPresentation = async () => {};
      await pool.query("UPDATE turns SET status='running' WHERE id=$1", [turn.turnId]);
      assert.equal((await pool.query('SELECT id FROM vault_payments')).rowCount, 0);
      assert.equal(fills.length, 0);
      const parallel = { threadId: turn.threadId, turnId: randomUUID() };
      await pool.query(
        "INSERT INTO turns(id,owner_id,thread_id,background) VALUES($1,'local-development',$2,true)",
        [parallel.turnId, parallel.threadId],
      );
      await payments.request(parallel, order);
      const latest = async () =>
        (
          await pool.query<{ id: string; status: string }>(
            'SELECT p.id,coalesce(v.status,p.status) AS status FROM vault_payments p LEFT JOIN vault_uses v ON v.id=p.id::text ORDER BY p.created_at DESC LIMIT 1',
          )
        ).rows[0]!;
      const reply = async (code: string) =>
        (await payments.submitCode(turn.turnId, code, (await latest()).id)).status;
      const shop = 'https://shop.fixture.test';

      const first = await payments.request(turn, order);
      assert.equal(
        (await pool.query('SELECT status FROM vault_payments WHERE turn_id=$1', [parallel.turnId]))
          .rows[0].status,
        'pending',
      );
      await pool.query("UPDATE vault_payments SET status='superseded' WHERE turn_id=$1", [
        parallel.turnId,
      ]);
      assert.equal(first.question, 'Synthetic private payment step.');
      assert.equal(first.url, `/payments/${(await latest()).id}`);
      assert.deepEqual(
        messageSetupLinks(actionLink(first.url, first.question), 'http://localhost:4310'),
        [{ href: first.url, setup: 'vault', label: first.question }],
      );
      assert.equal(presentations.at(-1)!.input.amount, '43.20');
      assert.equal(
        (await payments.submitCode(randomUUID(), '737', (await latest()).id)).status,
        'unavailable',
      );
      const firstPaymentId = (await latest()).id;
      const responses = await Promise.all([
        payments.submitCode(turn.turnId, '737', firstPaymentId),
        payments.submitCode(turn.turnId, '737', firstPaymentId),
      ]);
      assert.deepEqual(responses.map((result) => result.status).sort(), [
        'submitted',
        'unavailable',
      ]);
      assert.deepEqual(
        secureEntries.filter((status) => status !== 'requested'),
        ['approved'],
      );
      assert.equal(resumed.length, 1);
      assert.equal(fills.length, 1);
      assert.equal(fills[0].destinations.number, shop);
      assert.equal(await reply('737'), 'unavailable');

      await payments.request(turn, order);
      const older = (await latest()).id;
      await payments.request(turn, order);
      assert.deepEqual(secureEntries.slice(-2), ['superseded', 'requested']);
      assert.equal((await payments.submitCode(turn.turnId, '737', older)).status, 'unavailable');
      failFill = true;
      assert.equal(await reply('737'), 'unavailable');
      failFill = false;
      assert.equal((await latest()).status, 'uncertain');
      assert.equal(fills.length, 1);

      elsewhere = 'https://pay.fixture.test';
      await payments.request(turn, order);
      assert.deepEqual(presentations.at(-1)!.input.destinations, [
        'https://pay.fixture.test',
        shop,
      ]);
      assert.equal(presentations.at(-1)!.input.requires, 'desktop_private_form');
      assert.equal(await reply('737'), 'submitted');
      assert.equal(fills.at(-1)?.card.securityCode, '737');
      assert.equal(fills.at(-1)?.destinations.number, 'https://pay.fixture.test');
      assert.equal(await reply('737'), 'unavailable');
      elsewhere = 'null';
      await assert.rejects(payments.request(turn, order));
      elsewhere = undefined;
      captureFails = true;
      await assert.rejects(payments.request(turn, order));
      captureFails = false;

      const linked = await payments.request(turn, order);
      const linkedId = linked.url!.split('/').at(-1)!;
      const securePath = `/api/payment-requests/${linkedId}`;
      assert.equal(
        (await app.inject({ method: 'GET', url: securePath, headers: { host: headers.host } }))
          .statusCode,
        401,
      );
      const described = await app.inject({ method: 'GET', url: securePath, headers });
      assert.equal(described.statusCode, 200);
      assert.equal(described.body.includes('4242424242424242'), false);
      const statusPath = `${securePath}/status`;
      assert.equal((await app.inject({ url: statusPath, headers })).json().status, 'pending');
      const beforeLink = fills.length;
      const replies = await Promise.all([
        app.inject({ method: 'POST', url: securePath, headers, payload: { code: '737' } }),
        app.inject({ method: 'POST', url: securePath, headers, payload: { code: '737' } }),
      ]);
      assert.deepEqual(replies.map((response) => response.statusCode).sort(), [200, 409]);
      assert.equal(fills.length, beforeLink + 1);
      assert.deepEqual((await app.inject({ url: statusPath, headers })).json(), {
        status: 'submitted',
      });
      assert.equal(
        (await app.inject({ url: `/api/payment-requests/${randomUUID()}/status`, headers }))
          .statusCode,
        404,
      );
      await pool.query("UPDATE vault_payments SET owner_id='foreign-owner' WHERE id=$1", [
        linkedId,
      ]);
      assert.equal((await app.inject({ url: statusPath, headers })).statusCode, 404);
      await pool.query("UPDATE vault_payments SET owner_id='local-development' WHERE id=$1", [
        linkedId,
      ]);
      assert.equal((await app.inject({ method: 'GET', url: securePath, headers })).statusCode, 409);
      assert.equal('securityCode' in (await vault.paymentCard(card.id)), false);

      await save('Travel card', '5555 5555 5555 4444');
      await assert.rejects(payments.request(turn, order));
      await payments.request(turn, { ...order, card: 'travel' });
      assert.equal((presentations.at(-1)!.input.card as { last4: string }).last4, '4444');
      await payments.request(turn, { ...order, card: '4242', amount: '1200', currency: 'JPY' });
      const yen = presentations.at(-1)!.input;
      assert.equal(yen.amountMinor, 1200);
      assert.equal(yen.amount, '1200');
      assert.equal(yen.currency, 'JPY');
      const privateCode = await payments.request(turn, { ...order, card: card.id });
      const codeId = privateCode.url!.split('/').at(-1)!;
      const codePath = `/api/payment-requests/${codeId}`;
      assert.equal(
        (await app.inject({ method: 'POST', url: codePath, headers, payload: {} })).statusCode,
        400,
      );
      const invalidCode = await app.inject({
        method: 'POST',
        url: codePath,
        headers,
        payload: { code: 'synthetic-invalid-code' },
      });
      assert.equal(invalidCode.statusCode, 400);
      assert.doesNotMatch(invalidCode.body, /synthetic-invalid-code/);
      const concurrent = await payments.request(turn, { ...order, card: card.id });
      const concurrentId = concurrent.url!.split('/').at(-1)!;
      const concurrentPath = `/api/payment-requests/${concurrentId}`;
      const beforeConcurrent = { fills: fills.length, resumes: resumed.length };
      const concurrentReplies = await Promise.all(
        Array.from({ length: 16 }, () =>
          app.inject({
            method: 'POST',
            url: concurrentPath,
            headers,
            payload: { code: '737' },
          }),
        ),
      );
      assert.equal(concurrentReplies.filter((response) => response.statusCode === 200).length, 1);
      assert.equal(concurrentReplies.filter((response) => response.statusCode === 409).length, 15);
      assert.deepEqual(
        { fills: fills.length, resumes: resumed.length },
        { fills: beforeConcurrent.fills + 1, resumes: beforeConcurrent.resumes + 1 },
      );
      assert.deepEqual(
        (await pool.query('SELECT status FROM vault_uses WHERE id=$1', [concurrentId])).rows,
        [{ status: 'submitted' }],
      );
      assert.ok(concurrentReplies.every((response) => !response.body.includes('737')));
      assert.doesNotMatch(resumed.at(-1)!, /737/);

      const expired = await payments.request(turn, { ...order, card: card.id });
      const expiredId = expired.url!.split('/').at(-1)!;
      await payments.request(turn, { ...order, card: card.id });
      const beforeExpiry = fills.length;
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/payment-requests/${expiredId}`,
            headers,
            payload: { code: '737' },
          })
        ).statusCode,
        409,
      );
      assert.equal(fills.length, beforeExpiry);

      await payments.request(turn, { ...order, card: card.id });
      const changedPayment = (await latest()).id;
      const changedCard = await app.inject({
        method: 'PATCH',
        url: `/api/vault/${card.id}`,
        headers,
        payload: {
          kind: 'card',
          label: 'Replacement card',
          cardholder: 'Synthetic Cardholder',
          cardNumber: '5555555555554444',
          expiryMonth: 8,
          expiryYear,
        },
      });
      assert.equal(changedCard.statusCode, 200, changedCard.body);
      assert.deepEqual(
        (
          await app.inject({ url: `/api/payment-requests/${changedPayment}/status`, headers })
        ).json(),
        { status: 'expired' },
      );
      const beforeChange = fills.length;
      assert.equal(
        (
          await app.inject({
            method: 'GET',
            url: `/api/payment-requests/${changedPayment}`,
            headers,
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/payment-requests/${changedPayment}`,
            headers,
            payload: { code: '737' },
          })
        ).statusCode,
        409,
      );
      assert.equal(fills.length, beforeChange);
      assert.equal(
        (await pool.query('SELECT 1 FROM vault_uses WHERE id=$1', [changedPayment])).rowCount,
        0,
      );
      const beforeStop = { fills: fills.length, resumes: resumed.length };
      await payments.request(turn, { ...order, card: card.id });
      const obsoletePayment = (await latest()).id;
      const laterTurn = randomUUID();
      await pool.query('INSERT INTO turns(id,owner_id,thread_id,status) VALUES($1,$2,$3,$4)', [
        laterTurn,
        'local-development',
        turn.threadId,
        'queued',
      ]);
      assert.equal(
        (await app.inject({ url: `/api/payment-requests/${obsoletePayment}`, headers })).statusCode,
        409,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/payment-requests/${obsoletePayment}`,
            headers,
            payload: { code: '737' },
          })
        ).statusCode,
        409,
      );
      assert.deepEqual({ fills: fills.length, resumes: resumed.length }, beforeStop);
      assert.equal(
        (await pool.query('SELECT 1 FROM vault_uses WHERE id=$1', [obsoletePayment])).rowCount,
        0,
      );
      await pool.query("UPDATE turns SET source='resume' WHERE id=$1", [laterTurn]);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/payment-requests/${obsoletePayment}`,
            headers,
            payload: { code: '737' },
          })
        ).statusCode,
        200,
      );
      await pool.query("UPDATE turns SET source='user' WHERE id=$1", [laterTurn]);
      await payments.request(parallel, { ...order, card: card.id });
      const parallelPayment = (await latest()).id;
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/payment-requests/${parallelPayment}`,
            headers,
            payload: { code: '737' },
          })
        ).statusCode,
        200,
      );
      await pool.query('DELETE FROM turns WHERE id=$1', [laterTurn]);
      const beforeCancelled = { fills: fills.length, resumes: resumed.length };
      await payments.request(turn, { ...order, card: card.id });
      const stoppedPayment = (await latest()).id;
      await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [turn.turnId]);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/payment-requests/${stoppedPayment}`,
            headers,
            payload: { code: '737' },
          })
        ).statusCode,
        409,
      );
      assert.deepEqual({ fills: fills.length, resumes: resumed.length }, beforeCancelled);
      assert.equal(
        (await pool.query('SELECT 1 FROM vault_uses WHERE id=$1', [stoppedPayment])).rowCount,
        0,
      );
      const deletedCardRequest = await payments.request(parallel, { ...order, card: card.id });
      const deletedCardStatus = `/api/payment-requests/${deletedCardRequest.url!.split('/').at(-1)}/status`;
      assert.deepEqual((await app.inject({ url: deletedCardStatus, headers })).json(), {
        status: 'pending',
      });
      assert.equal(
        (await app.inject({ method: 'DELETE', url: `/api/vault/${card.id}`, headers })).statusCode,
        200,
      );
      assert.deepEqual((await app.inject({ url: deletedCardStatus, headers })).json(), {
        status: 'expired',
      });
      assert.doesNotMatch(
        JSON.stringify(
          (
            await pool.query(
              'SELECT origin,amount_minor,currency,fields,destinations,status FROM vault_payments',
            )
          ).rows,
        ),
        /4242424242424242|737|1234/,
      );
      assert.doesNotMatch(
        JSON.stringify(presentations.map((item) => item.input)),
        /4242424242424242|737|1234/,
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('Gmail verification uses fixed account-bound read endpoints and validates received MIME headers', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-not-live',
    allowTracking: false,
    disableVersionCheck: true,
  });
  let nextPageToken: string | undefined;
  let auth = 'mx.google.com; dmarc=pass (p=REJECT) header.from=toconline.pt; dkim=pass';
  let sender = 'TOConline <login@toconline.pt>';
  let recipient = 'owner@example.com';
  let date = now - 1000;
  let labels = ['INBOX'];
  let mimeType = 'text/plain';
  let body = 'O seu código de autenticação é 381742.';
  let extraHeaders: Array<{ name: string; value: string }> = [];
  let parts: unknown[] | undefined;
  t.mock.method(client.tools, 'proxyExecute', async (input: { endpoint: string }) => {
    if (input.endpoint.endsWith('/messages')) {
      return { status: 200, headers: {}, data: { messages: [{ id: 'mail1' }], nextPageToken } };
    }
    assert.equal(input.endpoint, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/mail1');
    return {
      status: 200,
      headers: {},
      data: {
        id: 'mail1',
        internalDate: String(date),
        labelIds: labels,
        payload: {
          mimeType,
          parts,
          headers: [
            { name: 'From', value: sender },
            { name: 'To', value: recipient },
            { name: 'Authentication-Results', value: auth },
            ...extraHeaders,
            { name: 'Subject', value: 'Account verification' },
          ],
          body: { data: Buffer.from(body).toString('base64url') },
        },
      },
    };
  });
  const read = () =>
    readVerificationEmails(
      client.tools,
      'owned-account',
      {
        recipient: request.recipient,
        senderDomain: 'toconline.pt',
        after: request.after,
        before: request.before,
      },
      new AbortController().signal,
    );
  assert.equal(verificationCode((await read())!, request), '381742');
  mimeType = 'multipart/alternative';
  parts = [
    {
      mimeType: 'text/plain',
      body: {
        data: Buffer.from(
          'Your verification code is 381742.\n> Your verification code is 999999.',
        ).toString('base64url'),
      },
    },
    {
      mimeType: 'text/html',
      body: {
        data: Buffer.from(
          '<p>Your verification code is 381742.</p><blockquote>Your verification code is 999999.</blockquote>',
        ).toString('base64url'),
      },
    },
    {
      mimeType: 'text/html',
      headers: [{ name: 'Content-Disposition', value: 'attachment' }],
      body: {
        data: Buffer.from('<p>Your verification code is 999998.</p>').toString('base64url'),
      },
    },
  ];
  const unquoted = (await read())![0];
  assert.equal(verificationCode([unquoted], request), '381742');
  assert.doesNotMatch(unquoted.text, /999999|999998/);
  parts = undefined;
  mimeType = 'text/plain';
  sender = 'login@transactional.toconline.pt';
  assert.equal((await read())?.length, 1);
  for (const [authenticated, from] of [
    ['attacker.pt', 'login@transactional.toconline.pt'],
    ['co.uk', 'login@co.uk'],
    ['github.io', 'login@tenant.github.io'],
    ['other.github.io', 'login@tenant.github.io'],
  ]) {
    auth = `mx.google.com; dmarc=pass header.from=${authenticated}`;
    sender = from;
    assert.deepEqual(await read(), []);
  }
  for (const [spoofed, spoofedAuth] of [
    [
      '"TOConline <login@toconline.pt>" <attacker@attacker.pt>',
      'mx.google.com; dmarc=pass header.from=toconline.pt',
    ],
    [
      'login@toconline.pt',
      'mx.google.com; spf=pass smtp.mailfrom="; dmarc=pass header.from=toconline.pt;"@attacker.pt; dmarc=fail (p=NONE) header.from=attacker.pt',
    ],
    [
      'login@toconline.pt',
      'mx.google.com; spf=pass smtp.mailfrom="x\\" ; dmarc=pass header.from=toconline.pt ; y"@attacker.pt; dmarc=fail (p=NONE) header.from=attacker.pt',
    ],
  ]) {
    sender = spoofed;
    auth = spoofedAuth;
    assert.deepEqual(await read(), []);
  }
  sender = 'TOConline <login@toconline.pt> (reports <noreply@elsewhere.net>)';
  auth = 'mx.google.com; dmarc=pass header.from=toconline.pt';
  assert.equal((await read())?.length, 1);
  auth = 'mx.google.com; dmarc=pass header.from=toconline.pt';
  sender = 'login@mail.toconline.pt';
  assert.equal((await read())?.length, 1);
  auth = 'mx.google.com; dmarc=pass header.from=toconline.pt';
  sender = 'login@toconline.pt';
  auth = 'mx.google.com; dmarc=fail header.from=toconline.pt';
  assert.deepEqual(await read(), []);
  auth = 'untrusted.example; dmarc=pass header.from=toconline.pt';
  extraHeaders = [
    { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=toconline.pt' },
  ];
  assert.deepEqual(await read(), []);
  extraHeaders = [];
  auth = 'mx.google.com; dmarc=pass header.from=toconline.pt';
  sender = 'TOConline <login@toconline.pt>, attacker@example.com';
  assert.deepEqual(await read(), []);
  sender = 'login@toconline.pt';
  recipient = 'other@example.com';
  assert.deepEqual(await read(), []);
  recipient = request.recipient;
  date = request.after - 1;
  assert.deepEqual(await read(), []);
  date = now - 1000;
  labels = ['SPAM'];
  assert.deepEqual(await read(), []);
  labels = ['INBOX'];
  mimeType = 'text/html';
  body =
    '<p>Your verification code is <b>381742</b>.</p><script>security code 930184</script><blockquote>Your verification code is 999999.</blockquote><div class="gmail_quote">Your verification code is 999998.</div>';
  assert.equal(verificationCode((await read())!, request), '381742');
  mimeType = 'multipart/mixed';
  for (const attachment of [
    {
      mimeType: 'text/plain',
      headers: [{ name: 'Content-Disposition', value: 'attachment' }],
      body: { data: Buffer.from('Your verification code is 381742.').toString('base64url') },
    },
    {
      mimeType: 'multipart/mixed',
      filename: 'forwarded.eml',
      parts: [
        {
          mimeType: 'text/plain',
          body: { data: Buffer.from('Your verification code is 381742.').toString('base64url') },
        },
      ],
    },
    {
      mimeType: 'message/rfc822',
      parts: [
        {
          mimeType: 'text/plain',
          body: { data: Buffer.from('Your verification code is 381742.').toString('base64url') },
        },
      ],
    },
  ]) {
    parts = [
      {
        mimeType: 'text/plain',
        body: { data: Buffer.from('See the attachment.').toString('base64url') },
      },
      attachment,
    ];
    assert.equal(verificationCode((await read())!, request), undefined);
  }
  parts = undefined;
  nextPageToken = 'more-matches';
  assert.equal(await read(), undefined);
  await assert.rejects(
    readVerificationEmails(
      client.tools,
      'owned-account',
      {
        recipient: request.recipient,
        senderDomain: 'toconline.pt',
        after: request.after,
        before: request.before,
      },
      AbortSignal.abort(),
    ),
  );
});

const owner = 'local-development';
const origin = 'https://app20.toconline.pt';
const username = 'owner@example.com';
const code = '381742';
const login = { origin, label: 'Fixture login' };
const input = { ...login, kind: 'password' as const, passwordSelector: '#password' };
const otpInput = {
  ...login,
  kind: 'otp' as const,
  passwordSelector: '#otp',
  emailCode: true,
  emailRecipient: username,
};

async function seedCodeTurns(pool: pg.Pool) {
  await pool.query(
    'CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz)',
  );
  await pool.query(
    "CREATE TABLE turns(id uuid PRIMARY KEY,parent_turn_id uuid,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text,background boolean NOT NULL DEFAULT false,started_at timestamptz,session_id uuid GENERATED ALWAYS AS (CASE WHEN background THEN id ELSE thread_id END) STORED)",
  );
  let threadId = '';
  const tasks = new Map<string, TurnRef>();
  const archive = async () => {
    if (threadId) await pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [threadId]);
    threadId = randomUUID();
    await pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [threadId, owner]);
  };
  await archive();
  const start = async (name: string, resumeOf?: string) => {
    const turn = { threadId, turnId: randomUUID() };
    await pool.query(
      'INSERT INTO turns(id,owner_id,thread_id,source,source_id,parent_turn_id,started_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())',
      [
        turn.turnId,
        owner,
        turn.threadId,
        resumeOf ? 'resume' : 'user',
        resumeOf ? `credentials:${resumeOf}` : null,
        resumeOf ?? null,
      ],
    );
    tasks.set(name, turn);
    return turn;
  };
  const failures: string[] = [];
  const resume = async (turnId: string) => {
    const name = [...tasks].find(([, value]) => value.turnId === turnId)?.[0];
    const parent = await pool.query(
      "SELECT 1 FROM turns WHERE id=$1 AND status='waiting' AND waiting_reason='credentials'",
      [turnId],
    );
    if (!name || !parent.rowCount) {
      failures.push(turnId);
      throw new Error(`Unexpected resume of ${turnId}.`);
    }
    await start(name, turnId);
  };
  const wait = async (turn: TurnRef) => {
    await pool.query(
      "UPDATE turns SET status='waiting',waiting_reason='credentials' WHERE id=$1 AND status='running'",
      [turn.turnId],
    );
  };
  const resumed = async (turnId: string) => {
    assert.deepEqual(failures, []);
    return (
      await pool.query(
        `SELECT p.status AS parent,p.waiting_reason AS reason,r.status,r.source FROM turns p
         JOIN turns r ON r.source_id='credentials:'||p.id::text WHERE p.id=$1`,
        [turnId],
      )
    ).rows;
  };
  return { task: (name: string) => tasks.get(name)!, start, resume, archive, wait, resumed };
}

test(
  'automatic email codes bind page delivery to a recent account and recheck task, page and mailbox before filling once',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `test_vault_email_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const turns = await seedCodeTurns(pool);
    const { task } = turns;
    const app = Fastify();
    t.after(async () => {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const origins = new Map<string, string>();
    const shown = new Map<string, string | undefined>();
    const injected: Array<{ threadId: string; code?: string }> = [];
    let read = 0;
    let lookup: (() => Promise<void>) | undefined;
    let available = true;
    let injectionFailure = false;
    let resultCode: string | undefined = code;
    let emails: VerificationEmail[] | undefined;
    const currentCode = '492615';
    const vault = await createVault(pool, {
      requestKey: Buffer.alloc(32, 42),
      keyStore: { id: 'fixture', configured: true, getKey: async () => randomKey },
      page: async (id) => {
        const current = origins.get(id) ?? origin;
        return { origin: current, url: `${current}/login` };
      },
      inject: async (value) => {
        injected.push({ threadId: value.threadId, code: value.code });
        if (injectionFailure && value.kind === 'otp') throw new Error('Uncertain code submission.');
        return { status: 'submitted' as const };
      },
      resume: turns.resume,
      retry: async () => {},
      emailCode: async (request) => {
        read++;
        assert.equal(request.recipient, username);
        assert.equal(request.origin, origin);
        await lookup?.();
        const found = emails ? verificationCode(emails, request) : resultCode;
        return found ? { code: found, current: async () => available } : undefined;
      },
    });
    const randomKey = randomBytes(32);
    vault.registerRoutes(app);
    const saved = (
      await app.inject({
        method: 'POST',
        url: '/api/vault',
        payload: { ...login, kind: 'login', username, password: 'fixture-private-password' },
      })
    ).json();
    assert.ok(saved.id);
    const begin = async (id: string) => {
      const turn = await turns.start(id);
      origins.delete(turn.threadId);
      shown.delete(turn.threadId);
      return turn;
    };
    const show = (id: string, recipient: string | undefined) =>
      shown.set(task(id).threadId, recipient);
    const start = async (id: string, entryId = saved.id) => {
      const turn = await begin(id);
      await vault.fillSaved(turn, owner, entryId, input);
    };
    const fill = (id: string) => {
      const threadId = task(id).threadId;
      const { emailRecipient: _recipient, ...withoutRecipient } = otpInput;
      const recipient = shown.has(threadId) ? shown.get(threadId) : username;
      return vault.fillEmailCode(
        task(id),
        owner,
        recipient === undefined ? withoutRecipient : { ...otpInput, emailRecipient: recipient },
      );
    };
    const root = (id: string) => task(id).turnId;
    await start('success');
    assert.equal(
      await vault.fillEmailCode(task('success'), owner, { ...otpInput, emailCode: false }),
      false,
    );
    const { emailCode: _emailCode, ...unobservedOtp } = otpInput;
    assert.equal(await vault.fillEmailCode(task('success'), owner, unobservedOtp), false);
    assert.equal(read, 0);
    assert.equal(await fill('success'), true);
    assert.equal(await fill('success'), false);
    assert.equal(read, 1);
    assert.equal(injected.filter((value) => value.code).length, 1);
    await start('simultaneous');
    assert.deepEqual((await Promise.all([fill('simultaneous'), fill('simultaneous')])).sort(), [
      false,
      true,
    ]);
    assert.equal(injected.filter((value) => value.code).length, 2);
    const afterConcurrentReads = read;
    for (const [id, change] of [
      [
        'wrong-recipient',
        async (id: string) => {
          show(id, 'other@example.com');
        },
      ],
      [
        'mismatched-masked-recipient',
        async (id: string) => {
          show(id, 'someone***@example.com');
        },
      ],
      [
        'mismatched-masked-tld',
        async (id: string) => {
          show(id, 'o***@example.n**');
        },
      ],
      [
        'wrong-origin',
        async (id: string) => {
          origins.set(task(id).threadId, 'https://evil.com');
        },
      ],
      [
        'cancelled',
        async (id: string) => {
          await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [task(id).turnId]);
        },
      ],
    ] as const) {
      await start(id);
      await change(id);
      assert.equal(await fill(id), false, id);
      assert.equal(read, afterConcurrentReads, id);
    }
    for (const [id, entered] of [
      ['entered-long-ago', "now()-interval '6 minutes'"],
      ['never-entered', 'NULL'],
    ] as const) {
      await start(id);
      await pool.query(
        `UPDATE credential_account_selections SET credential_entered_at=${entered} WHERE root_turn_id=$1`,
        [root(id)],
      );
      assert.equal(await fill(id), true, id);
    }
    const readsBeforeOwner = read;
    await start('wrong-owner');
    assert.equal(await vault.fillEmailCode(task('wrong-owner'), 'other', otpInput), false);
    assert.equal(read, readsBeforeOwner);
    for (const [id, recipient] of [
      ['masked', 'o***@example.com'],
      ['masked-bullets', 'ow•••@example.com'],
      ['masked-tld', 'o***@example.***'],
      ['masked-tld-bullets', 'ow•••@example.•••'],
      ['selected-without-recipient', undefined],
    ] as const) {
      await start(id);
      show(id, recipient);
      assert.equal(await fill(id), true, id);
      assert.equal(await fill(id), false, id);
    }
    await begin('direct-email');
    assert.equal(await fill('direct-email'), true);
    assert.equal(await fill('direct-email'), false);
    await begin('prior-challenge-email');
    emails = [{ ...message, receivedAt: Date.now() - 2 * 60_000 }];
    const attemptsBeforePriorChallenge = injected.length;
    assert.equal(await fill('prior-challenge-email'), false);
    assert.equal(injected.length, attemptsBeforePriorChallenge);
    await begin('current-challenge-email');
    emails.push({
      ...message,
      id: 'current-challenge-code',
      receivedAt: Date.now() - 1000,
      text: `Your verification code is ${currentCode}.`,
    });
    assert.equal(await fill('current-challenge-email'), true);
    assert.equal(injected.at(-1)?.code, currentCode);
    const unrelatedTurn = await begin('unrelated-sender');
    emails = [
      {
        ...message,
        receivedAt: Date.now() - 1000,
        sender: 'sender@unrelated.example.org',
        authenticatedDomain: 'unrelated.example.org',
        text: `Your verification code is 123456. Verify email: ${origin}/verify?token=abcdefghijklmnop`,
      },
    ];
    const beforeUnrelated = injected.length;
    assert.equal(await fill('unrelated-sender'), false);
    assert.equal(injected.length, beforeUnrelated);
    const manualCode = await vault.request(unrelatedTurn, owner, otpInput);
    await turns.wait(unrelatedTurn);
    const manualForm = await app.inject({
      url: manualCode.url.replace('/vault/', '/api/credential-requests/'),
    });
    assert.equal(manualForm.statusCode, 200);
    assert.equal(manualForm.json().kind, 'otp');
    assert.equal(manualForm.json().status, 'pending');
    assert.equal(manualForm.body.includes('123456'), false);
    emails = undefined;
    const nonEmailLogin = (
      await app.inject({
        method: 'POST',
        url: '/api/vault',
        payload: {
          ...login,
          kind: 'login',
          username: 'synthetic-tax-identifier',
          password: 'fixture-private-password',
        },
      })
    ).json();
    assert.ok(nonEmailLogin.id);
    await start('non-email-login', nonEmailLogin.id);
    assert.equal(await fill('non-email-login'), true);
    for (const [id, recipient] of [
      ['non-email-login-mask', 'o***@example.com'],
      ['non-email-login-missing', undefined],
    ] as const) {
      await start(id, nonEmailLogin.id);
      show(id, recipient);
      const before: number = read;
      assert.equal(await fill(id), false, id);
      assert.equal(read, before, id);
    }
    for (const [id, recipient] of [
      ['unbound-mask', 'o***@example.com'],
      ['unbound-recipient', undefined],
    ] as const) {
      await begin(id);
      show(id, recipient);
      const before: number = read;
      assert.equal(await fill(id), false, id);
      assert.equal(read, before, id);
    }
    for (const [id, offset, filled] of [
      ['long-direct-email', -6 * 60_000, true],
      ['future-direct-email', 60_000, false],
    ] as const) {
      const turn = await begin(id);
      await pool.query('UPDATE turns SET started_at=$2 WHERE id=$1', [
        turn.turnId,
        new Date(Date.now() + offset),
      ]);
      const before: number = read;
      assert.equal(await fill(id), filled, id);
      assert.equal(read, before + (filled ? 1 : 0), id);
    }
    for (const [id, change] of [
      [
        'cancelled-direct-email',
        async (turn: TurnRef) => {
          await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [turn.turnId]);
        },
      ],
      [
        'changed-origin-direct-email',
        async (turn: TurnRef) => {
          origins.set(turn.threadId, 'https://evil.com');
        },
      ],
    ] as const) {
      const turn = await begin(id);
      lookup = () => change(turn);
      const before = injected.length;
      assert.equal(await fill(id), false, id);
      assert.equal(injected.length, before, id);
    }
    lookup = undefined;
    await start('uncertain-submission');
    injectionFailure = true;
    const attemptsBeforeUncertain = injected.length;
    await assert.rejects(fill('uncertain-submission'));
    assert.equal(await fill('uncertain-submission'), false);
    assert.equal(injected.length, attemptsBeforeUncertain + 1);
    injectionFailure = false;
    for (const [id, change] of [
      [
        'late-cancel',
        async (id: string) => {
          await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [task(id).turnId]);
        },
      ],
      [
        'late-origin',
        async (id: string) => {
          origins.set(task(id).threadId, 'https://evil.com');
        },
      ],
      [
        'late-archive',
        async () => {
          await turns.archive();
        },
      ],
      [
        'late-expiry',
        async (id: string) => {
          await pool.query(
            'UPDATE credential_account_selections SET expires_at=now() WHERE root_turn_id=$1',
            [root(id)],
          );
        },
      ],
    ] as const) {
      await start(id);
      lookup = () => change(id);
      const codes = injected.filter((value) => value.code).length;
      assert.equal(await fill(id), false, id);
      assert.equal(injected.filter((value) => value.code).length, codes, id);
    }
    lookup = undefined;
    await start('revoked');
    available = false;
    assert.equal(await fill('revoked'), false);
    available = true;
    await start('missing');
    resultCode = undefined;
    assert.equal(await fill('missing'), false);
    resultCode = code;
    assert.equal(await fill('missing'), true);
    assert.equal(await fill('missing'), false);
    const manualTurn = await begin('manual-password');
    const manual = await vault.request(manualTurn, owner, input);
    await turns.wait(manualTurn);
    const readsBeforePassword = read;
    assert.equal(await fill('manual-password'), false);
    assert.equal(read, readsBeforePassword);
    const submitted = await app.inject({
      method: 'POST',
      url: manual.url.replace('/vault/', '/api/credential-requests/'),
      payload: { username, password: 'fixture-private-password' },
    });
    assert.equal(submitted.statusCode, 200);
    assert.deepEqual(await turns.resumed(manualTurn.turnId), [
      { parent: 'waiting', reason: 'credentials', status: 'running', source: 'resume' },
    ]);
    assert.equal(
      (
        await pool.query(
          'SELECT blocked FROM credential_account_selections WHERE root_turn_id=$1',
          [manualTurn.turnId],
        )
      ).rows[0]?.blocked,
      true,
    );
    assert.equal(await fill('manual-password'), true);
    await start('provider-error');
    lookup = async () => {
      throw new Error('provider-private-mail 381742');
    };
    assert.equal(await fill('provider-error'), false);
    lookup = undefined;
    assert.equal(await fill('provider-error'), true);
    await start('entry-removed');
    lookup = async () => {
      await pool.query('DELETE FROM vault_entries WHERE id=$1', [saved.id]);
    };
    assert.equal(await fill('entry-removed'), false);
    const persisted = JSON.stringify([
      (await pool.query('SELECT * FROM credential_requests')).rows,
      (await pool.query('SELECT * FROM credential_account_selections')).rows,
      (await pool.query('SELECT * FROM vault_uses')).rows,
    ]);
    for (const secret of [
      code,
      currentCode,
      username,
      'fixture-private-password',
      'provider-private-mail',
    ])
      assert.equal(persisted.includes(secret), false);
  },
);

test(
  'chat codes consume the exact pending owned request without plaintext storage',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `test_chat_code_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const turns = await seedCodeTurns(pool);
    const other = await turns.start('other');
    const chat = await turns.start('chat');
    await pool.query(
      "UPDATE turns SET started_at=(SELECT started_at FROM turns WHERE id=$2)-interval '1 millisecond' WHERE id=$1",
      [other.turnId, chat.turnId],
    );
    const app = Fastify();
    t.after(async () => {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    let injected = 0;
    const vault = await createVault(pool, {
      requestKey: Buffer.alloc(32, 42),
      keyStore: { id: 'fixture', configured: true, getKey: async () => randomBytes(32) },
      page: async () => ({ origin, url: `${origin}/login` }),
      inject: async (input) => {
        injected++;
        assert.equal(input.code, code);
        return { status: 'submitted' as const };
      },
      resume: turns.resume,
      retry: async () => {},
    });
    vault.registerRoutes(app);
    await vault.request(chat, owner, otpInput);
    const pending = async () =>
      (
        await pool.query(
          "SELECT id FROM credential_requests WHERE turn_id=$1 AND status='pending' ORDER BY id",
          [chat.turnId],
        )
      ).rows.map((row) => row.id as string);
    const requestId = (await pending())[0];
    assert.deepEqual(await vault.submitChatCode(owner, chat.turnId, code, requestId), {
      status: 'unavailable',
    });
    assert.equal(injected, 0);
    await turns.wait(chat);
    assert.deepEqual(await vault.submitChatCode('other-owner', chat.turnId, code, requestId), {
      status: 'unavailable',
    });
    assert.deepEqual(await vault.submitChatCode(owner, other.turnId, code, requestId), {
      status: 'unavailable',
    });
    assert.deepEqual(await vault.submitChatCode(owner, chat.turnId, code, 'stale-request'), {
      status: 'unavailable',
    });
    assert.deepEqual(await vault.submitChatCode(owner, chat.turnId, 'my code 381742', requestId), {
      status: 'invalid',
    });
    assert.equal(injected, 0);
    assert.deepEqual(await vault.submitChatCode(owner, chat.turnId, code, requestId), {
      status: 'submitted',
    });
    assert.deepEqual(await vault.submitChatCode(owner, chat.turnId, code, requestId), {
      status: 'unavailable',
    });
    assert.equal(injected, 1);
    assert.deepEqual(await turns.resumed(chat.turnId), [
      { parent: 'waiting', reason: 'credentials', status: 'running', source: 'resume' },
    ]);
    const persisted = JSON.stringify((await pool.query('SELECT * FROM credential_requests')).rows);
    for (const secret of [code, username, 'recipient'])
      assert.equal(persisted.includes(secret), false);
  },
);

test(
  'private mailbox codes require one owned verified connection and retain revocation fences',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `test_email_code_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const owner = 'local-development';
    const recipient = 'owner@example.com';
    let inspected: string[] = [];
    let reads: string[] = [];
    let active = true;
    let remoteEmail = recipient;
    let requestedRecipient = recipient;
    let fail = false;
    let duringRead: (() => Promise<void>) | undefined;
    let messages: VerificationEmail[] = [];
    const provider: IntegrationProvider = {
      id: 'mail-fixture',
      configured: true,
      webhooksConfigured: false,
      supportsSubscriptions: [],
      createSession: async () => {
        throw new Error('Mailbox reads must not use model sessions.');
      },
      deleteSession: async () => {},
      deleteAccount: async () => {
        assert.fail('Must not disconnect.');
      },
      inspectAccount: async (id, user) => {
        inspected.push(id);
        assert.equal(user, owner);
        return { active, service: 'gmail', accountEmail: remoteEmail };
      },
      verificationEmails: async (id, query) => {
        reads.push(id);
        assert.equal(query.recipient, requestedRecipient);
        if (fail) throw new Error('private-message-body 381742');
        await duringRead?.();
        return messages;
      },
      parseCallback: () => ({ state: '', accountId: '', success: false }),
      subscribe: async () => ({ id: '' }),
      unsubscribe: async () => {},
      verifyWebhook: async () => {
        throw new Error('Unused');
      },
      matchesSubscription: () => false,
    };
    const integrations = await createIntegrations(pool, {
      ownerId: 'local-development',
      provider,
      baseUrl: 'http://localhost:4310',
      wake: async () => {},
    });
    const connection = randomUUID();
    await pool.query(
      `INSERT INTO app_connections(id,owner_id,slug,account_id,provider_id,account_email) VALUES
    ($1,$2,'gmail','owned-mailbox','mail-fixture',$3),
    (gen_random_uuid(),'another-owner','gmail','foreign-mailbox','mail-fixture',$3),
    (gen_random_uuid(),$2,'gmail','different-mailbox','mail-fixture','other@example.com')`,
      [connection, owner, recipient],
    );
    const now = Date.now();
    const input = {
      recipient,
      origin: 'https://app20.toconline.pt',
      after: now - 20_000,
      before: now,
      length: 6,
    };
    const mail: VerificationEmail = {
      id: 'mail1',
      receivedAt: now - 1000,
      sender: 'security@toconline.pt',
      authenticatedDomain: 'toconline.pt',
      recipients: [recipient],
      text: 'Your login verification code is 381742.',
    };
    messages = [mail];
    const read = (changes = {}, signal = new AbortController().signal) =>
      integrations.emailCode(owner, { ...input, ...changes }, signal);
    const result = await read();
    assert.equal(result?.code, '381742');
    assert.equal(await result?.current(), true);
    assert.deepEqual(inspected, ['owned-mailbox']);
    assert.deepEqual(reads, ['owned-mailbox']);
    requestedRecipient = 'owner+trial@example.com';
    messages = [{ ...mail, recipients: [requestedRecipient] }];
    const alias = await read({ recipient: requestedRecipient });
    assert.equal(alias?.code, '381742');
    assert.equal(await alias?.current(), true);
    messages = [mail];
    assert.equal(await read({ recipient: requestedRecipient }), undefined);
    messages = [{ ...mail, recipients: [requestedRecipient] }];
    remoteEmail = requestedRecipient;
    assert.equal(await read({ recipient: requestedRecipient }), undefined);
    remoteEmail = recipient;
    await pool.query('UPDATE app_connections SET account_email=$2 WHERE id=$1', [
      connection,
      requestedRecipient,
    ]);
    assert.equal(await alias?.current(), false);
    await pool.query('UPDATE app_connections SET account_email=$2 WHERE id=$1', [
      connection,
      recipient,
    ]);
    const aliasedDuplicate = randomUUID();
    await pool.query(
      "INSERT INTO app_connections(id,owner_id,slug,account_id,provider_id,account_email) VALUES($1,$2,'gmail','aliased-mailbox','mail-fixture','owner+other@example.com')",
      [aliasedDuplicate, owner],
    );
    assert.equal(await read({ recipient: requestedRecipient }), undefined);
    await pool.query('DELETE FROM app_connections WHERE id=$1', [aliasedDuplicate]);
    for (const [primary, aliasRecipient, expected] of [
      ['first.last@example.com', 'firstlast+trial@example.com', false],
      ['first.last@example.com', 'first.last+trial@example.com', true],
      ['first.last@gmail.com', 'firstlast+trial@gmail.com', true],
      ['first.last@gmail.com', 'first.last+trial@googlemail.com', true],
      ['first.last@googlemail.com', 'firstlast+trial@gmail.com', true],
      ['first.last@googlemail.com', 'firstlast+trial@googlemail.com', true],
      ['first.last@example.com', 'firstlast+trial@googlemail.com', false],
    ] as const) {
      await pool.query('UPDATE app_connections SET account_email=$2 WHERE id=$1', [
        connection,
        primary,
      ]);
      remoteEmail = primary;
      requestedRecipient = aliasRecipient;
      messages = [{ ...mail, recipients: [aliasRecipient] }];
      assert.equal(Boolean(await read({ recipient: aliasRecipient })), expected);
    }
    await pool.query('UPDATE app_connections SET account_email=$2 WHERE id=$1', [
      connection,
      recipient,
    ]);
    remoteEmail = recipient;
    requestedRecipient = recipient;
    messages = [mail];
    await pool.query('UPDATE app_connections SET revoked=true WHERE id=$1', [connection]);
    assert.equal(await result?.current(), false);
    inspected = [];
    reads = [];
    assert.equal(await read(), undefined);
    assert.equal(
      await integrations.emailCode('another-owner', input, new AbortController().signal),
      undefined,
    );
    assert.equal(await read({ recipient: 'missing@example.com' }), undefined);
    assert.equal(await read({ origin: 'https://co.uk' }), undefined);
    assert.equal(await read({ after: now - 10 * 60_000 }), undefined);
    assert.equal(await read({}, AbortSignal.abort()), undefined);
    assert.deepEqual(inspected, []);
    assert.deepEqual(reads, []);
    await pool.query('UPDATE app_connections SET revoked=false WHERE id=$1', [connection]);
    remoteEmail = 'other@example.com';
    assert.equal(await read(), undefined);
    assert.deepEqual(reads, []);
    remoteEmail = recipient;
    active = false;
    assert.equal(await read(), undefined);
    assert.deepEqual(reads, []);
    active = true;
    const duplicate = randomUUID();
    await pool.query(
      "INSERT INTO app_connections(id,owner_id,slug,account_id,provider_id,account_email) VALUES($1,$2,'gmail','duplicate-mailbox','mail-fixture',$3)",
      [duplicate, owner, recipient],
    );
    assert.equal(await read(), undefined);
    assert.deepEqual(reads, []);
    await pool.query('DELETE FROM app_connections WHERE id=$1', [duplicate]);
    messages = [];
    assert.equal(await read({}, AbortSignal.timeout(200)), undefined);
    const arrival = setTimeout(() => {
      messages = [mail];
    }, 200);
    assert.equal((await read({}, AbortSignal.timeout(15_000)))?.code, '381742');
    clearTimeout(arrival);
    messages = [];
    messages = [mail, { ...mail, id: 'mail2', text: 'Your login verification code is 940173.' }];
    assert.equal(await read(), undefined);
    messages = [{ ...mail, receivedAt: now - 60_000 }];
    assert.equal(await read(), undefined);
    fail = true;
    assert.equal(await read(), undefined);
    fail = false;
    messages = [mail];
    duringRead = async () => {
      await pool.query('UPDATE app_connections SET revoked=true WHERE id=$1', [connection]);
    };
    assert.equal(await read(), undefined);
    const persisted = JSON.stringify([
      (await pool.query('SELECT * FROM integration_events')).rows,
      (await pool.query('SELECT * FROM app_connections')).rows,
    ]);
    for (const secret of ['381742', '940173', 'private-message-body', mail.text])
      assert.equal(persisted.includes(secret), false);
    assert.ok(reads.every((id) => id === 'owned-mailbox'));
  },
);

async function vaultPage(
  element: React.ReactNode,
  response: (path: string, init: RequestInit) => Promise<Response>,
  url: string,
) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url,
    pretendToBeVisual: true,
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    FormData: dom.window.FormData,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (path: unknown, init: RequestInit = {}) => response(String(path), init),
  };
  const originals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  await act(async () => root.render(element));
  return {
    document: dom.window.document,
    async render(element: React.ReactNode) {
      await act(async () => root.render(element));
    },
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, value] of originals)
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    },
  };
}

test('the website session dialog keeps credentials and URL tokens out of chat', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<div id="root"></div>', {url:'http://localhost/vault',pretendToBeVisual:true});
Object.assign(globalThis, {
  window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true,
  getComputedStyle:dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window),
  ...Object.fromEntries(['Node','NodeFilter','Event','CustomEvent','Element','HTMLElement','HTMLInputElement','MutationObserver'].map(name => [name,dom.window[name]])),
});
Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator});
const {act,createElement}=await import('react');
const {createRoot}=await import('react-dom/client');
const {WebsiteSessionDialog}=await import('./src/web/components/website-session-dialog.tsx');
const root=createRoot(document.querySelector('#root'));
try {
  const requests=[];
  await act(async()=>root.render(createElement(WebsiteSessionDialog,{open:true,onOpenChange(){},onAsk:text=>requests.push(text)})));
  const input=document.querySelector('input[type="url"]');
  assert.ok(input);
  for(const value of ['https://owner:synthetic-private@example.test','http://example.test','https://example.test/synthetic-path-token?token=synthetic-token#synthetic-fragment']) {
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);
      input.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await act(async()=>document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  }
  assert.equal(requests.length,1);
  assert.match(requests[0],/https:\/\/example.test/);
  assert.doesNotMatch(requests[0],/synthetic-private|synthetic-token|synthetic-fragment|synthetic-path-token/);
} finally {
  await act(async()=>root.unmount());
  dom.window.close();
}
`,
  });
  assert.equal(result.exitCode, 0, result.stderr);
});

test('Vault does not open or prefill a login from arbitrary query data', async () => {
  for (const query of [
    '',
    '?add=card&cardNumber=4242424242424242',
    '?add=login&origin=https%3A%2F%2Fexample.test',
    '?add=login&password=synthetic',
    '?add=login&add=login',
    '?add=login#synthetic',
  ]) {
    pageDataCache.clear();
    const view = await vaultPage(
      createElement(Vault),
      async (path, init) => {
        assert.notEqual(init.method, 'POST');
        assert.ok(['/api/vault', '/api/vault/sessions'].includes(path), path);
        return Response.json([]);
      },
      `http://localhost:4310/vault${query}`,
    );
    try {
      assert.equal(view.document.querySelector('.vault-add-form'), null);
    } finally {
      await view.close();
      pageDataCache.clear();
    }
  }
});

test(
  'beside-chat private entry clears closed fields and follows owned server submission without replay',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `test_private_panel_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    const turns = await seedTurns(pool);
    const turn = await turns.turn();
    let release = () => {};
    let started = () => {};
    let completed = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const injectionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const submissionCompleted = new Promise<void>((resolve) => {
      completed = resolve;
    });
    let submitted = 0;
    let entered = 0;
    let failed = false;
    let requestSignal: AbortSignal | null | undefined;
    const key = randomBytes(32);
    const vault = await createVault(pool, {
      requestKey: Buffer.alloc(32, 42),
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      page: async () => ({
        origin: 'https://panel.example.test',
        url: 'https://panel.example.test/login',
      }),
      inject: async (input) => {
        entered++;
        assert.equal(input.password, 'synthetic-panel-password');
        if (failed) throw new Error('Synthetic private entry interruption');
        started();
        await gate;
        return { status: 'submitted' as const };
      },
      resume: async () => {},
      retry: async () => {},
    });
    vault.registerRoutes(app);
    const request = await vault.request(turn, 'local-development', {
      origin: 'https://panel.example.test',
      label: 'Synthetic sign-in',
      kind: 'password',
      passwordSelector: '#password',
    });
    await turns.wait(turn);
    const accepted: boolean[] = [];
    function OpenEntry({ href }: { href: string }) {
      const entry = usePrivateEntry();
      return createElement(
        'button',
        {
          id: 'open-private',
          onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
            accepted.push(entry?.open(href, event.currentTarget) ?? false);
          },
        },
        'Open private form',
      );
    }
    const panel = (href = request.url, owner = 'first') =>
      createElement(PrivateEntryWorkspace, {
        key: owner,
        children: createElement(OpenEntry, { href }),
      });
    const view = await vaultPage(
      panel(),
      async (path, init) => {
        if (init.method === 'POST') {
          submitted++;
          requestSignal = init.signal;
        }
        const result = await app.inject({
          method: (init.method ?? 'GET') as 'GET' | 'POST',
          url: path,
          headers: init.body ? { 'content-type': 'application/json' } : {},
          payload: init.body ? String(init.body) : undefined,
        });
        if (init.method === 'POST') completed();
        return new Response(result.body, {
          status: result.statusCode,
          headers: { 'content-type': 'application/json' },
        });
      },
      'http://localhost:4310/?conversation=synthetic',
    );
    t.after(async () => {
      release();
      await view.close();
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const click = async (selector: string) =>
      act(async () => {
        const target = view.document.querySelector<HTMLButtonElement>(selector);
        assert.ok(target, selector);
        target.click();
      });
    const settle = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 100 && !predicate(); attempt++)
        await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
      assert.ok(predicate());
    };
    await click('#open-private');
    await settle(() => Boolean(view.document.querySelector('input[name="password"]')));
    const password = view.document.querySelector<HTMLInputElement>('input[name="password"]')!;
    password.value = 'synthetic-unsent-password';
    await click('.private-entry-toolbar button');
    assert.equal(view.document.querySelector('input[name="password"]'), null);
    await click('#open-private');
    await settle(() => Boolean(view.document.querySelector('input[name="password"]')));
    assert.equal(
      view.document.querySelector<HTMLInputElement>('input[name="password"]')!.value,
      '',
    );
    view.document.querySelector<HTMLInputElement>('input[name="password"]')!.value =
      'synthetic-panel-password';
    await click('.credential-secret button');
    assert.equal(
      view.document.querySelector<HTMLInputElement>('input[name="password"]')!.type,
      'text',
    );
    await act(async () => {
      const form = view.document.querySelector('form')!;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await injectionStarted;
    assert.equal(submitted, 1);
    assert.equal(entered, 1);
    await click('.private-entry-toolbar button');
    assert.equal(requestSignal?.aborted, true);
    await click('#open-private');
    await settle(() => Boolean(view.document.querySelector('.credential-complete')));
    assert.equal(view.document.querySelector('form'), null);
    await act(async () => {
      release();
      await submissionCompleted;
    });
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle(() => Boolean(view.document.querySelector('.success-mark')));
    assert.equal(submitted, 1);
    assert.equal(entered, 1);
    assert.equal(window.location.pathname, '/');
    assert.equal(window.location.search, '?conversation=synthetic');
    assert.equal(window.localStorage.length, 0);
    assert.equal(window.sessionStorage.length, 0);
    await view.render(panel(request.url, 'second'));
    assert.equal(view.document.querySelector('.private-entry-panel'), null);
    for (const href of [
      `https://other.example.test${request.url}`,
      `${request.url}?secret=synthetic`,
      `${request.url}#synthetic`,
      `${request.url}/extra`,
      'javascript:alert(1)',
    ]) {
      await view.render(panel(href, 'second'));
      await click('#open-private');
      assert.equal(accepted.at(-1), false);
      assert.equal(view.document.querySelector('.private-entry-panel'), null);
    }
    const next = await turns.turn();
    failed = true;
    const uncertain = await vault.request(next, 'local-development', {
      origin: 'https://panel.example.test',
      label: 'Synthetic sign-in',
      kind: 'password',
      passwordSelector: '#password',
    });
    await turns.wait(next);
    await view.render(panel(uncertain.url, 'second'));
    await click('#open-private');
    await settle(() =>
      Boolean(view.document.querySelector('.credential-accounts .button-outline')),
    );
    await click('.credential-accounts .button-outline');
    await settle(
      () =>
        Boolean(view.document.querySelector('.credential-complete')) &&
        !view.document.querySelector('[aria-busy="true"]'),
    );
    assert.equal(view.document.querySelector('form'), null);
    assert.equal(view.document.querySelector('.success-mark'), null);
    assert.deepEqual(
      (
        await app.inject({
          url: uncertain.url.replace('/vault/', '/api/credential-requests/') + '/status',
        })
      ).json(),
      { status: 'uncertain' },
    );
    assert.equal(submitted, 2);
    assert.equal(entered, 2);
    await view.render(panel('/vault?add=card', 'card-owner'));
    await click('#open-private');
    const unsentCard = view.document.querySelector<HTMLInputElement>('input[name="cardNumber"]')!;
    assert.ok(unsentCard);
    unsentCard.value = '4242424242424242';
    await click('.private-entry-toolbar button');
    assert.equal(view.document.querySelector('input[name="cardNumber"]'), null);
    await click('#open-private');
    assert.equal(
      view.document.querySelector<HTMLInputElement>('input[name="cardNumber"]')!.value,
      '',
    );
    for (const [name, value] of Object.entries({
      label: 'Synthetic review card',
      cardholder: 'Synthetic Owner',
      cardNumber: '4242424242424242',
      expiry: '12 / 2030',
    }))
      view.document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!.value = value;
    await act(async () =>
      view.document
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    await settle(() => Boolean(view.document.querySelector('.private-entry-card [role="status"]')));
    assert.equal(view.document.querySelector('form'), null);
    const savedCards = (await app.inject({ url: '/api/vault' }))
      .json()
      .filter((entry: { kind: string }) => entry.kind === 'card');
    assert.equal(savedCards.length, 1);
    assert.equal(savedCards[0].last4, '4242');
    assert.equal(JSON.stringify(savedCards).includes('4242424242424242'), false);
    assert.equal(window.localStorage.length, 0);
    assert.equal(window.sessionStorage.length, 0);
    assert.equal(window.location.search, '?conversation=synthetic');
    pageDataCache.clear();
    for (const href of [
      '/vault?add=card&cardNumber=4242424242424242',
      '/vault?add=card&add=card',
      '/vault?add=card#synthetic',
      '/vault?add=login',
      'https://foreign.example.test/vault?add=card',
    ]) {
      await view.render(panel(href, 'card-owner'));
      await click('#open-private');
      assert.equal(accepted.at(-1), false);
      assert.equal(view.document.querySelector('form'), null);
    }
    const foreign = await turns.turn('foreign-owner');
    const foreignRequest = await vault.request(foreign, 'foreign-owner', {
      origin: 'https://panel.example.test',
      label: 'Foreign sign-in',
      kind: 'password',
      passwordSelector: '#password',
    });
    await turns.wait(foreign);
    await view.render(panel(foreignRequest.url, 'third'));
    await click('#open-private');
    await settle(() => Boolean(view.document.querySelector('.notice')));
    assert.equal(view.document.querySelector('form'), null);
    assert.equal(submitted, 3);
  },
);

test('chat removes private-entry actions only after the server confirms submission', async () => {
  const token = 'synthetic-private-entry-token';
  const payment = randomUUID();
  let credentialStatus: CredentialRequest['status'] = 'pending';
  let paymentSubmitted = false;
  let unavailable = false;
  const missingReads = new Map<string, number>();
  const view = await vaultPage(
    createElement(SetupActions, {
      actions: [
        { href: `/vault/${token}`, setup: 'vault', label: 'Private login' },
        { href: `/payments/${payment}`, setup: 'vault', label: 'Private payment' },
        { href: `/vault/${token}-uncertain`, setup: 'vault', label: 'Uncertain login' },
        { href: `/vault/${token}-expired`, setup: 'vault', label: 'Expired login' },
        { href: `/vault/${token}-404`, setup: 'vault', label: 'Missing login' },
        { href: `/vault/${token}-410`, setup: 'vault', label: 'Removed login' },
      ],
    }),
    async (path) => {
      const gone = /-(404|410)\/status$/.exec(path);
      if (gone) {
        missingReads.set(path, (missingReads.get(path) ?? 0) + 1);
        return Response.json({ error: 'Unavailable' }, { status: Number(gone[1]) });
      }
      if (unavailable) return Response.json({ error: 'Unavailable' }, { status: 503 });
      if (path === `/api/credential-requests/${token}/status`)
        return Response.json({ status: credentialStatus });
      if (path === `/api/credential-requests/${token}-uncertain/status`)
        return Response.json({ status: 'uncertain' });
      if (path === `/api/credential-requests/${token}-expired/status`)
        return Response.json({ status: 'expired' });
      if (path === `/api/payment-requests/${payment}/status`)
        return Response.json({ status: paymentSubmitted ? 'submitted' : 'pending' });
      throw new Error(`Unexpected fixture request ${path}`);
    },
    'http://localhost:4310/',
  );
  const refresh = () => act(async () => window.dispatchEvent(new Event('focus')));
  const actions = () => view.document.querySelectorAll('[data-setup="vault"]').length;
  try {
    assert.equal(actions(), 6);
    credentialStatus = 'entering';
    await refresh();
    assert.equal(actions(), 6);
    credentialStatus = 'filled';
    unavailable = true;
    await refresh();
    assert.equal(actions(), 6);
    unavailable = false;
    await refresh();
    assert.equal(actions(), 5);
    paymentSubmitted = true;
    await refresh();
    assert.equal(actions(), 4);
    assert.deepEqual([...missingReads.values()], [1, 1]);
  } finally {
    await view.close();
  }
});

test('analytics routes collapse private paths to known pages', async () => {
  const { analyticsRoute, sanitizedAnalyticsUrl } =
    await import('../src/web/lib/analytics-privacy.ts');
  for (const [path, route] of [
    ['/', '/'],
    ['/you', '/'],
    ['/tasks/', '/tasks'],
    ['/settings', '/settings'],
    ['/settings/models?private=synthetic', '/settings'],
    ['/settings/apps#synthetic', '/not-found'],
    ['/settings/memory', '/settings'],
    ['/settings/unknown-private-section', '/not-found'],
    ['/settings-typo', '/not-found'],
    ['/usage?private=synthetic#private', '/usage'],
    ['/vault?item=synthetic-private-id', '/vault'],
    ['https://private.invalid/apps?connect=synthetic-private', '/apps'],
    ['/browser-connect/synthetic-private-token', '/apps'],
    ['/vault/synthetic-private-id', '/credentials'],
    ['/credentials/synthetic-private-id?token=synthetic-private', '/credentials'],
    ['/payments/synthetic-private-id', '/payments'],
    ['/payments/synthetic-private-id/extra', '/not-found'],
    ['/credentials', '/credentials'],
    ['/privacy', '/not-found'],
    ['/memory', '/not-found'],
    ['/login', '/not-found'],
    ['/desktop/setup', '/not-found'],
    ['/synthetic-private-path', '/not-found'],
  ])
    assert.equal(analyticsRoute(path), route, path);
  assert.equal(
    sanitizedAnalyticsUrl('/payments/synthetic-private-id?code=1'),
    'https://nod.invalid/payments',
  );
});

test('onboarding step events are sent only after the owner opts in on the first step', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://nod.fixture.invalid/onboarding', pretendToBeVisual: true });
for (const name of ['window','document','Node','Element','HTMLElement','HTMLInputElement','HTMLButtonElement','Event','CustomEvent','KeyboardEvent','MouseEvent','MutationObserver','getComputedStyle','sessionStorage']) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : name === 'document' ? dom.window.document : typeof dom.window[name] === 'function' && name[0] === name[0].toLowerCase() ? dom.window[name].bind(dom.window) : dom.window[name] });
Object.defineProperty(globalThis, 'navigator', {configurable:true,value:dom.window.navigator});
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.location = window.location;
globalThis.EventSource = window.EventSource = class { static CLOSED = 2; readyState = 0; close() {} addEventListener() {} };
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
let finishPreparation;
let deferPreparation = false;
let suggestions = 0;
window.fetch = globalThis.fetch = async (url) => {
  const path = new URL(url, window.location.href).pathname;
  if (path === '/api/account/prepare') return deferPreparation ? new Promise(resolve => {finishPreparation = () => resolve(Response.json({ok:true}));}) : Response.json({ ok: true });
  if (path === '/api/apps') return Response.json([]);
  if (path === '/api/onboarding/suggestions') {suggestions++; return Response.json({ok:true});}
  if (path === '/api/models') return Response.json({ connections: [{ id: 'synthetic', status: 'connected', models: [] }], selection: null });
  if (path === '/api/channel-settings') return Response.json({ ready: false, channels: [] });
  return Response.json({ error: 'Synthetic route unavailable.' }, { status: 404 });
};
const analytics = await import('./src/web/lib/analytics.ts');
const captured = [];
let options;
analytics.setAnalyticsClient({
  init(_key, value) { options = value; },
  capture(event, properties) {
    const sent = options?.before_send({ uuid: 'synthetic', event, properties: { ...properties }, timestamp: new Date() });
    if (sent) captured.push(sent);
  },
  set_config() {}, reset() {}, stopSessionRecording() {}, startSessionRecording() {}, get_session_id() {},
});
const enabled = { enabled: true, distinctId: 'local:11111111-1111-4111-8111-111111111111', environment: 'production' };
analytics.configureAnalytics(enabled, 'web');
analytics.captureAnalytics('nod_onboarding_step_viewed', { step: 'synthetic-private-step', direction: 'forward' });
analytics.captureAnalytics('nod_onboarding_recap', { steps_viewed: ['welcome'] });
analytics.captureAnalytics('nod_settings_viewed', { tab: 'appearance' });
analytics.captureAnalytics('nod_settings_viewed', { tab: 'general' });
assert.deepEqual(captured.map(event => [event.event, event.properties.step, event.properties.direction, event.properties.tab]), [['nod_onboarding_step_viewed', undefined, 'forward', undefined], ['nod_settings_viewed', undefined, undefined, undefined], ['nod_settings_viewed', undefined, undefined, 'general']]);
captured.length = 0;
analytics.configureAnalytics(undefined, 'web');
const { createElement, act, StrictMode } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Onboarding } = await import('./src/web/pages/onboarding/index.tsx');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root = createRoot(document.getElementById('root'));
let sharing = false;
let native = false;
const render = () => {const view = createElement(Onboarding, {
  user: { id: 'synthetic-owner', name: 'Synthetic', email: null, avatarUrl: null },
  onComplete: async () => {},
  onFeedback() {},
  usageData: sharing,
  onUsageData: async (value) => { sharing = value; analytics.configureAnalytics(value ? enabled : undefined, 'web'); render(); },
}); root.render(native ? createElement(StrictMode, null, view) : view);};
const settle = (ms = 50) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
const button = (text) => [...document.querySelectorAll('button')].find(item => item.textContent.trim() === text);
const steps = () => captured.map(event => [event.event, event.properties.step, event.properties.direction]);
await act(async () => render());
for (let attempt = 0; attempt < 80 && !(document.querySelector('[role=switch]') && button('Let’s go')); attempt++) await settle();
assert.deepEqual(captured, []);
await act(async () => document.querySelector('[role=switch]').click());
await settle();
assert.equal(sharing, true);
assert.deepEqual(captured, []);
await act(async () => button('Let’s go').click());
await settle();
assert.deepEqual(steps(), [['nod_onboarding_step_viewed', 'brain', 'forward']]);
await act(async () => root.unmount());
captured.length = 0;
deferPreparation = true;
sessionStorage.removeItem('nod.onboarding.suggestions');
suggestions = 0;
sessionStorage.setItem('nod.onboarding.step', JSON.stringify({ owner: 'synthetic-owner', step: 'telegram', version: 2 }));
root = createRoot(document.getElementById('root'));
await act(async () => render());
for (let attempt = 0; attempt < 80 && !button('Skip for now'); attempt++) await settle();
assert.equal(suggestions, 0, 'suggestions wait for account preparation');
await act(async () => button('Skip for now').click());
await settle();
assert.deepEqual(steps(), [['nod_onboarding_step_viewed', 'telegram', 'forward'], ['nod_onboarding_step_skipped', 'telegram', undefined]]);
assert.equal(captured.some(event => event.event === 'nod_onboarding_recap'), false);
assert.equal(suggestions, 0);
await act(async () => finishPreparation());
for (let attempt = 0; attempt < 80 && !suggestions; attempt++) await settle();
assert.equal(suggestions, 1);
await act(async () => root.unmount());
sessionStorage.setItem('nod.onboarding.step', JSON.stringify({ owner: 'synthetic-owner', step: 'telegram', version: 1 }));
root = createRoot(document.getElementById('root'));
await act(async () => render());
for (let attempt = 0; attempt < 80 && !button('Let’s go'); attempt++) await settle();
assert.ok(document.querySelector('[role=switch]'));
await act(async () => root.unmount());
captured.length = 0;
native = true;
let desktopPreferences = {theme:'system',resolvedTheme:'light',notifications:false,launchAtLogin:false,onboardingPreferenceStep:'notifications'};
window.nodDesktop = {
  getSettings:async()=>desktopPreferences,
  saveSettings:async change=>(desktopPreferences={...desktopPreferences,...change}),
  getPreferences:async()=>desktopPreferences,
  onPreferences:()=>()=>{},
};
analytics.configureAnalytics(enabled, 'desktop');
sessionStorage.setItem('nod.onboarding.step', JSON.stringify({ owner: 'synthetic-owner', step: 'brain', version: 2 }));
root = createRoot(document.getElementById('root'));
await act(async () => render());
await settle();
assert.deepEqual(steps(), [['nod_onboarding_step_viewed', 'brain', 'forward']]);
await act(async () => root.unmount());
captured.length = 0;
analytics.configureAnalytics(undefined, 'desktop');
sessionStorage.setItem('nod.onboarding.step', JSON.stringify({ owner: 'synthetic-owner', step: 'preferences', version: 2 }));
root = createRoot(document.getElementById('root'));
await act(async () => render());
for (let attempt = 0; attempt < 80 && !button('Continue'); attempt++) await settle();
assert.equal(document.querySelector('.ob').dataset.step, 'notifications');
assert.deepEqual(captured, []);
await act(async () => root.unmount());
analytics.configureAnalytics(enabled, 'desktop');
root = createRoot(document.getElementById('root'));
await act(async () => render());
for (let attempt = 0; attempt < 80 && !button('Continue'); attempt++) await settle();
assert.equal(document.querySelector('.ob').dataset.step, 'notifications');
assert.deepEqual(steps(), [['nod_onboarding_step_viewed', 'notifications', 'forward']]);
await act(async () => button('Enable notifications').click());
await settle();
assert.equal(captured.length, 1);
await act(async () => button('Continue').click());
for (let attempt = 0; attempt < 80 && !(document.querySelector('.ob')?.dataset.step === 'launchAtLogin' && button('Start chatting')); attempt++) await settle();
assert.deepEqual(steps(), [['nod_onboarding_step_viewed', 'notifications', 'forward'], ['nod_onboarding_step_viewed', 'launch_at_login', 'forward']]);
assert.equal(button('Start chatting').disabled, true);
await act(async () => button('Enable open at login').click());
await settle();
await act(async () => button('Start chatting').click());
await settle();
assert.equal(document.querySelector('.ob'), null);
assert.deepEqual(steps(), [['nod_onboarding_step_viewed', 'notifications', 'forward'], ['nod_onboarding_step_viewed', 'launch_at_login', 'forward']]);
assert.ok(captured.every(event => event.properties.surface === 'desktop'));
await act(async () => root.unmount());
delete window.nodDesktop;
dom.window.close();
process.exit(0);
`,
  });
  assert.equal(result.exitCode, 0, result.stderr);
});

test('session replay masks private DOM without exposing content', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html data-theme="dark" data-desktop="true"><head><title>synthetic-private-title</title><style>.visible { color: red }</style></head><body><nav data-analytics-public>Settings</nav><div class="visible">synthetic-private-chat</div><div class="message-text"><span data-analytics-public>synthetic-private-markup</span></div><div class="vault-inset-value">synthetic-private-vault</div><input value="synthetic-private-input"><input type="hidden" value="synthetic-private-hidden"><input type="file"><img src="https://private.invalid/synthetic-private-image"><iframe src="https://private.invalid/synthetic-private-frame"></iframe><div id="mutable" title="synthetic-private-tooltip" data-owner="synthetic-private-owner" data-desktop="synthetic-private-layout" style="background-image: url(https://private.invalid/synthetic-private-css)">synthetic-private-name</div><a href="/credentials/synthetic-private-id?token=synthetic-private-token">synthetic-private-link</a><div contenteditable="true">synthetic-private-composer</div></body></html>', { url: 'https://nod.fixture.invalid/credentials/synthetic-private-request?token=synthetic-private-query#synthetic-private-hash', pretendToBeVisual: true });
for (const name of ['window','document','Node','NodeFilter','Element','HTMLElement','HTMLInputElement','HTMLFormElement','HTMLIFrameElement','HTMLImageElement','HTMLLinkElement','HTMLStyleElement','HTMLMediaElement','HTMLVideoElement','HTMLAudioElement','HTMLCanvasElement','SVGElement','Document','DocumentFragment','ShadowRoot','CSSStyleSheet','CSSStyleDeclaration','MutationObserver','Event','CustomEvent']) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : name === 'document' ? dom.window.document : dom.window[name] });
Object.defineProperty(globalThis, 'navigator', {configurable:true,value:dom.window.navigator});
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.location = window.location;
const requests=[];
window.XMLHttpRequest = undefined;
globalThis.XMLHttpRequest = undefined;
window.fetch = globalThis.fetch = async (url, init={}) => {
  const path = new URL(url,window.location.href).pathname;
  if (path==='/api/configuration') return Response.json({integrationsReady:true});
  if (path==='/api/apps') return Response.json([{slug:'gmail',status:'connected',connectionId:'synthetic-gmail-connection',accountId:'synthetic-gmail-account',accountEmail:'synthetic-private-inbox@example.test'}]);
  if (path==='/api/models') return Response.json({connections:[{id:'synthetic-compatible',provider:'compatible',method:'api_key',label:'synthetic-private-lan-host',status:'connected',managed:false,models:[]}],selection:null,local:true});
  requests.push({url:String(url),body:init.body instanceof ArrayBuffer ? (new Uint8Array(init.body)[0]===31 ? gunzipSync(Buffer.from(init.body)) : Buffer.from(init.body)).toString() : init.body && typeof init.body.text === 'function' ? await init.body.text() : init.body});
  return Response.json(path.endsWith('/config') ? {sessionRecording:{sampleRate:null,minimumDurationMilliseconds:null,masking:{maskAllInputs:false},urlTriggers:[],eventTriggers:[],linkedFlag:null,urlBlocklist:[],scriptConfig:{script:'posthog-recorder'},version:1},hasFeatureFlags:false} : {status:1});
};
const { recordingOptions } = await import('./src/web/lib/analytics-privacy.ts');
const { createElement, act } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { Sidebar } = await import('./src/web/components/sidebar.tsx');
document.body.insertAdjacentHTML('beforeend', renderToStaticMarkup(createElement(Sidebar, {path:'/', unreadCount:73, collapsed:false, onToggle() {}, onNavigate() {}})));
const { TelegramSetup } = await import('./src/web/components/telegram-setup.tsx');
document.body.insertAdjacentHTML('beforeend', renderToStaticMarkup(createElement(TelegramSetup, {
  setup: { provider: 'telegram', enabled: true, mode: 'polling', pairingExpiresAt: new Date(Date.now() + 900000).toISOString() },
  pairingUrl: 'https://t.me/synthetic_private_bot?start=synthetic-private-pairing-code',
  manual: false, fields: {}, busy: false, error: '',
  onField() {}, onVerify() {}, onConfirm() {}, onNewLink() {}, onManual() {}, onSaveId() {},
})));
const { MessageBubble } = await import('./src/web/components/message.tsx');
const { TaskCard } = await import('./src/web/pages/tasks.tsx');
const now = new Date().toISOString();
document.body.insertAdjacentHTML('beforeend', renderToStaticMarkup(createElement(MessageBubble, {message:{id:'synthetic-message',role:'user',text:'synthetic-private-message',turnId:null,createdAt:now,attachments:[{id:'22222222-2222-4222-8222-222222222222',name:'synthetic-private-file.pdf',mimeType:'application/pdf',size:12,url:'/api/artifacts/22222222-2222-4222-8222-222222222222'}],replyTo:{id:'synthetic-quoted',role:'assistant',text:'synthetic-private-quote'}}, onReply() {}})));
document.body.insertAdjacentHTML('beforeend', renderToStaticMarkup(createElement(TaskCard, {task:{id:'synthetic-task',title:'synthetic-private-task',doneWhen:'synthetic-private-done',now:'synthetic-private-now',result:'',status:'working',question:null,waitingFor:[],nextCheck:null,createdAt:now,updatedAt:now,closedAt:null,steps:['synthetic-private-step'],stepIndex:0}})));
document.body.insertAdjacentHTML('beforeend', '<div class="chat-turn-preview">synthetic-private-turn</div><div class="message-link-previews">synthetic-private-preview</div><a class="message-link-tooltip" href="https://example.org/synthetic-private-tooltip">synthetic-private-tooltip</a><div class="pending-attachments">synthetic-private-pending</div><div class="reply-context composer-reply">synthetic-private-draft-reply</div><p class="statement-summary usage-sentence">synthetic-private-rule</p><span class="vault-use-text">synthetic-private-site</span><span class="vault-item-text">synthetic-private-login</span><span class="compact-account-details">synthetic-private-account</span><aside class="artifact-drawer" style="width: 480px"><h2 title="synthetic-private-file.pdf">synthetic-private-file.pdf</h2><table><td title="synthetic-private-cell">synthetic-private-cell</td></table></aside>');
const pairingPaths = [...document.querySelectorAll('.telegram-setup-qr path')].map(path => path.getAttribute('d'));
assert.ok(pairingPaths.length > 0);
const stylesheet = document.createElement('style');
document.head.append(stylesheet);
stylesheet.sheet.insertRule('.fixture-stylesheet { background-image: url("file:///synthetic-private-local/image.png") }');
await import('posthog-js/dist/posthog-recorder.js');
const events = [];
const record = window.__PosthogExtensions__.rrweb.record;
const stop = record({...recordingOptions, emit: e => events.push(e)});
assert.ok(stop);
document.querySelector('#mutable').textContent = 'synthetic-private-mutated-text';
document.querySelector('#mutable').setAttribute('title', 'synthetic-private-mutated-tooltip');
document.documentElement.setAttribute('data-desktop', 'false');
document.querySelector('#mutable').setAttribute('data-desktop', 'synthetic-private-mutated-layout');
document.querySelector('input').value = 'synthetic-private-mutated-input';
document.querySelector('input').dispatchEvent(new window.Event('input', {bubbles:true}));
document.querySelectorAll('.chat-unread-badge').forEach(badge => { badge.firstChild.textContent = '74'; });
await new Promise(resolve => setTimeout(resolve, 60));
stop();
const recordedNodes = [];
function visit(node) { recordedNodes.push(node); node.childNodes?.forEach(visit); }
visit(events.find(event => event.type === 2).data.node);
const badges = recordedNodes.filter(node => node.attributes?.class === 'chat-unread-badge');
assert.equal(badges.length, document.querySelectorAll('.chat-unread-badge').length);
assert.ok(badges.length > 0);
assert.deepEqual(badges.map(node => node.childNodes[0].textContent), Array(badges.length).fill('**'));
const badgeTextIds = new Set(badges.map(node => node.childNodes[0].id));
const badgeUpdates = events.filter(event => event.type === 3).flatMap(event => event.data.texts ?? []).filter(text => badgeTextIds.has(text.id));
assert.equal(badgeUpdates.length, badges.length);
assert.deepEqual(badgeUpdates.map(text => text.value), Array(badges.length).fill('**'));
for (const name of ['message-reply-quote','message-attachments','task-preview-title','task-preview-line','task-preview-steps','chat-turn-preview','message-link-previews','message-link-tooltip','pending-attachments','reply-context','usage-sentence','vault-use-text','vault-item-text','compact-account-details','artifact-drawer']) {
  const blocked = recordedNodes.filter(node => node.attributes?.class?.split(' ').includes(name));
  assert.ok(blocked.length > 0, name);
  for (const node of blocked) assert.deepEqual(node.childNodes, [], name);
}
const content = JSON.stringify(events.filter(e => e.type === 2 || e.type === 3));
for (const path of pairingPaths) assert.equal(content.includes(path), false);
assert.doesNotMatch(content, /synthetic-private/);

const analytics = await import('./src/web/lib/analytics-client.ts');
const { posthog: sdk } = await import('posthog-js/no-external');
analytics.configureAnalytics({enabled:true, distinctId:'local:11111111-1111-4111-8111-111111111111',environment:'production'},'web');
sdk.set_config({request_batching:false,disable_compression:true,api_transport:'fetch'});
await new Promise(resolve => setTimeout(resolve,80));
const { createRoot } = await import('react-dom/client');
const { Email } = await import('./src/web/pages/onboarding/steps/email.tsx');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const emailContainer = document.createElement('div');
document.body.append(emailContainer);
const emailRoot = createRoot(emailContainer);
await act(async () => {emailRoot.render(createElement(Email,{arrived:'back',onNext() {},onBack() {}})); await new Promise(resolve => setTimeout(resolve,50));});
await act(async () => {await new Promise(resolve => setTimeout(resolve,50));});
assert.ok(emailContainer.textContent.includes('synthetic-private-inbox@example.test'));
const { Brain } = await import('./src/web/pages/onboarding/steps/brain.tsx');
const brainContainer = document.createElement('div');
document.body.append(brainContainer);
const brainRoot = createRoot(brainContainer);
await act(async () => {brainRoot.render(createElement(Brain,{arrived:'back',onNext() {},onBack() {}})); await new Promise(resolve => setTimeout(resolve,50));});
assert.ok(brainContainer.textContent.includes('Connected to synthetic-private-lan-host'));
document.querySelector('#mutable').textContent = 'synthetic-private-recorded-mutation';
document.querySelector('input').value = 'synthetic-private-recorded-input';
document.querySelector('input').dispatchEvent(new window.Event('input', {bubbles:true}));
for (let attempt = 0; attempt < 120 && !requests.some(request => new URL(request.url).pathname === '/s/'); attempt++) await new Promise(resolve => setTimeout(resolve,50));
const recordings = requests.filter(request => new URL(request.url).pathname === '/s/').flatMap(request => JSON.parse(request.body));
assert.ok(recordings.length > 0);
function decodeSnapshot(value) {
  if (typeof value === 'string' && value.charCodeAt(0) === 31 && value.charCodeAt(1) === 139) return decodeSnapshot(JSON.parse(gunzipSync(Buffer.from(value,'latin1')).toString()));
  if (Array.isArray(value)) return value.map(decodeSnapshot);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,decodeSnapshot(item)]));
  return value;
}
const snapshots = recordings.flatMap(event => event.properties.$snapshot_data).map(decodeSnapshot);
assert.ok(snapshots.some(event => event.type === 2));
assert.ok(snapshots.some(event => event.type === 3));
assert.match(JSON.stringify(snapshots), /Connected to/);
assert.doesNotMatch(JSON.stringify(snapshots), /synthetic-private/);
await act(async () => emailRoot.unmount());
await act(async () => brainRoot.unmount());
dom.window.close();
process.exit(0);

`,
  });
  assert.equal(result.exitCode, 0, result.stderr);
});

test(
  'a Vault without a key check proves the old key before it creates one',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `test_vault_key_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    try {
      await seedTurns(pool);
      const key = randomBytes(32);
      const vault = await createVault(pool, {
        requestKey: Buffer.alloc(32, 42),
        keyStore: { id: 'synthetic', configured: true, getKey: async () => key },
        inject: async () => {},
        resume: async () => {},
        retry: async () => {},
      });
      const input = {
        origin: 'https://legacy.example.test',
        label: 'Synthetic account',
        username: 'synthetic@example.test',
        password: 'Synthetic legacy value',
      };
      const first = await vault.saveLogin(input);
      const wrong = checkedKeyStore(pool, {
        id: 'wrong',
        configured: true,
        getKey: async () => randomBytes(32),
      });
      await assert.rejects(wrong.getKey());
      assert.equal(
        (await pool.query("SELECT to_regclass('vault_key_check') AS table_name")).rows[0]
          .table_name,
        null,
      );
      const valid = checkedKeyStore(pool, {
        id: 'correct',
        configured: true,
        getKey: async () => key,
      });
      assert.deepEqual(await valid.getKey(), key);
      assert.equal((await vault.readCredential(first.id)).secret.password, input.password);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('onboarding advances only after a newly confirmed connection with ready owned state', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 25_000,
    input: String.raw`
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><div id="root"></div>', {url:'http://127.0.0.1:51000/onboarding',pretendToBeVisual:true});
for (const name of ['window','document','Node','Element','HTMLElement','HTMLInputElement','HTMLButtonElement','Event','CustomEvent','MutationObserver','getComputedStyle','sessionStorage']) Object.defineProperty(globalThis,name,{configurable:true,value:name==='window'?dom.window:name==='document'?dom.window.document:typeof dom.window[name]==='function'&&name[0]===name[0].toLowerCase()?dom.window[name].bind(dom.window):dom.window[name]});
Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator});
globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.location=window.location;
globalThis.ResizeObserver=class {observe(){} disconnect(){}};
HTMLElement.prototype.scrollIntoView=function(){};
window.matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){}});
window.open=()=>({closed:false,opener:null,location:{replace(){}},close(){}});
let channel;
globalThis.BroadcastChannel=class {constructor(){channel=this;} close(){}};
const {createElement,act}=await import('react');
const {createRoot}=await import('react-dom/client');
const {Brain}=await import('./src/web/pages/onboarding/steps/brain.tsx');
const {Email}=await import('./src/web/pages/onboarding/steps/email.tsx');
const {Telegram}=await import('./src/web/pages/onboarding/steps/telegram.tsx');
const {About}=await import('./src/web/pages/onboarding/steps/about.tsx');
const {pageDataCache}=await import('./src/web/lib/page-data-cache.ts');
const {writeStep}=await import('./src/web/pages/onboarding/storage.ts');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
let root;
let advances=0;
const settle=(ms=15)=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,ms));});
const waitFor=async(condition)=>{for(let i=0;i<100&&!condition();i++)await settle();assert.ok(condition(),'Expected the confirmed connection to advance its React step');};
const button=text=>[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===text);
const click=async(text)=>{await waitFor(()=>button(text)&&!button(text).disabled);await act(async()=>button(text).click());await settle();};
async function mount(Component,arrived='forward') {
  if(root) await act(async()=>root.unmount());
  pageDataCache.clear(); advances=0;
  root=createRoot(document.getElementById('root'));
  await act(async()=>root.render(createElement(Component,{arrived,onNext(){advances++;},onBack(){},onSkip(){}})));
  await settle();
}
const connection={id:'fixture-model',provider:'anthropic',method:'api_key',status:'connected',label:'Fixture model',managed:false,models:[{id:'fixture-model-name',name:'Fixture',efforts:['off'],images:false,contextWindow:32000}]};
let models={connections:[],selection:null};
let failKey=true;
let select;
let oauth;
let gmailConnected=false;
let disconnectPending=false;
let disconnectCalls=0;
let failDisconnect=true;
let gmailReconnect=false;
let gmailCompleted=false;
let gmailMissing=false;
let failApps=false;
let failTelegram=true;
let failChannelLoad=false;
let interviewSaves=0;
let interviewDraft={answers:[],turns:[],done:false};
let interviewGeneration='synthetic-generation-1';
let interviewCompleted=false;
let generations=1;
const interviewState=()=>({...interviewDraft,generation:interviewGeneration,completed:interviewCompleted});
let interviewPosts=0;
let holdInterviewRead=false;
let releaseInterviewRead;
let failInterviewRead=false;
let failInterviewReset=false;
let resetVersion;
let interviewDeletes=0;
const recoveryRequests=[];
let holdRecovery=false;
let releaseRecovery;
let failInterviewPost=0;
let failInterviewSave=false;
let expectedAnswers=['Synthetic project focus'];
let telegram={provider:'telegram',enabled:true,mode:'polling',accountHandle:'@fixture_bot',pairingCandidate:{id:'123456',name:'Fixture'},pairingExpiresAt:new Date(Date.now()+600000).toISOString()};
const attempt='A'.repeat(43);
window.fetch=globalThis.fetch=async(url,options={})=>{
  const path=new URL(url,window.location.href).pathname;
  const body=options.body?JSON.parse(options.body):{};
  if(path==='/api/onboarding/interview'){
    if(!options.method||options.method==='GET'){
      if(holdInterviewRead)return new Promise(resolve=>{releaseInterviewRead=()=>resolve(Response.json(interviewState()));});
      return failInterviewRead?Response.json({error:'Synthetic draft unavailable'},{status:500}):Response.json(resetVersion?{resetVersion}:interviewState());
    }
    if(options.method==='DELETE')interviewDeletes++;
    if(options.method==='DELETE'&&'resetVersion' in body){
      recoveryRequests.push(body);
      if(body.resetVersion!==resetVersion)return Response.json({error:'Synthetic recovery version changed'},{status:409});
      const recover=()=>{
        resetVersion=undefined;
        interviewGeneration='synthetic-generation-'+(++generations);
        interviewCompleted=false;
        interviewDraft={answers:[],turns:[],done:false};
        return Response.json(interviewState());
      };
      return holdRecovery?new Promise(resolve=>{releaseRecovery=()=>resolve(recover());}):recover();
    }
    if(body.generation!==interviewGeneration)return Response.json({error:'Synthetic generation changed'},{status:409});
    if(options.method==='DELETE'){
      if(failInterviewReset)return Response.json({error:'Synthetic reset failed'},{status:500});
      interviewGeneration='synthetic-generation-'+(++generations);
      interviewCompleted=false;
      interviewDraft={answers:[],turns:[],done:false};
      return Response.json(interviewState());
    }
    if(options.method==='PUT'){
      if(failInterviewSave)return Response.json({error:'Synthetic answers changed'},{status:409});
      assert.deepEqual(body.answers,expectedAnswers);
      interviewSaves++;
      interviewCompleted=true;
      interviewDraft={answers:[],turns:[],done:true};
      return Response.json({ok:true});
    }
    if(interviewCompleted)return Response.json({error:'Synthetic generation completed'},{status:409});
    interviewPosts++;
    if(failInterviewPost)return Response.json({error:'Synthetic draft write failed'},{status:failInterviewPost});
    const answers=[],turns=[];
    let said=[];
    for(const message of body.talk){if(message.from==='owner'){answers.push(message.text);turns.push(said);said=[];}else said.push(message.text);}
    const messages=answers.length?['Synthetic interview complete.']:['Synthetic question?'];
    interviewDraft={answers,turns:[...turns,messages],done:answers.length>0};
    return Response.json({messages,done:answers.length>0});
  }
  if(path==='/api/onboarding/suggestions')return Response.json({ok:true});
  if(path==='/api/models')return Response.json(models);
  if(path==='/api/models/keys'){
    if(failKey)return Response.json({error:'Fixture key rejected'},{status:503});
    models={connections:[connection],selection:null};
    return Response.json(models);
  }
  if(path==='/api/models/selection')return new Promise(resolve=>{select=()=>{models={...models,selection:body};resolve(Response.json(models));};});
  if(path==='/api/models/oauth')return Response.json({attempt:'fixture-oauth',url:'https://auth.openai.com/authorize?fixture=1'});
  if(path==='/api/models/oauth/status/fixture-oauth')return new Promise(resolve=>{oauth=()=>resolve(Response.json({status:'connected'}));});
  if(path==='/api/configuration')return Response.json({integrationsReady:true});
  if(path==='/api/apps')return failApps?Response.json({error:'Fixture account refresh failed'},{status:503}):Response.json([{slug:'gmail',name:'Gmail',status:gmailConnected?'connected':'disconnected',connectionId:gmailConnected||disconnectPending?'fixture-account':undefined,accountId:gmailConnected||disconnectPending?'fixture-gmail':undefined,reconnectRequired:gmailReconnect,disconnectPending}]);
  if(path==='/api/apps/gmail/accounts/fixture-account/disconnect'){
    assert.equal(options.method,'POST');
    assert.equal(options.body,undefined);
    disconnectCalls++;
    if(failDisconnect)return Response.json({error:'Fixture disconnection unavailable'},{status:502});
    disconnectPending=false;
    return Response.json({disconnected:true});
  }
  if(path==='/api/apps/gmail/connect')return Response.json({url:'https://connect.composio.dev/link/fixture',attempt});
  if(path==='/api/apps/setup-status')return Response.json({completed:gmailCompleted?body.hashes:[],apps:gmailMissing?[]:body.hashes.map(hash=>({hash,pairingConfirmed:true}))});
  if(path==='/api/channels')return failChannelLoad?Response.json({error:'Fixture channel refresh failed'},{status:503}):Response.json({channels:[],inbox:[],deliveries:[],error:null});
  if(path==='/api/channel-settings')return Response.json({ready:true,channels:[telegram]});
  if(path==='/api/channel-settings/telegram/confirm'){
    if(failTelegram)return Response.json({error:'Fixture pairing rejected'},{status:503});
    telegram={provider:'telegram',enabled:true,mode:'polling',accountHandle:'@fixture_bot',allowedUserId:'123456'};
    return Response.json({channel:telegram});
  }
  throw new Error('Unexpected fixture request '+path);
};
await mount(Brain);
await act(async()=>[...document.querySelectorAll('.ob-brain-option')].find(item=>item.textContent.includes('Anthropic')).click());
await waitFor(()=>document.querySelector('#ob-brain-key-anthropic'));
await act(async()=>{const input=document.querySelector('#ob-brain-key-anthropic');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'synthetic-model-key');input.dispatchEvent(new Event('input',{bubbles:true}));});
await click('Connect');
assert.equal(advances,0);
assert.match(document.body.textContent,/Fixture key rejected/);
failKey=false;
await click('Connect');
await waitFor(()=>select);
assert.equal(advances,0,'connection alone cannot advance before model selection is ready');
await act(async()=>select());
await waitFor(()=>advances===1);
await act(async()=>pageDataCache.refresh('/api/models',true));
assert.equal(advances,1);
for(const direction of ['forward','back']){
  await mount(Brain,direction);
  await waitFor(()=>button('Continue')&&!button('Continue').disabled);
  assert.equal(advances,0,'cached model must not bounce '+direction);
}
models={connections:[],selection:null};
await mount(Brain);
await act(async()=>[...document.querySelectorAll('.ob-brain-option')].find(item=>item.textContent.includes('OpenAI')).click());
await click('Sign in with ChatGPT');
await waitFor(()=>oauth);
assert.equal(advances,0);
models={connections:[{...connection,provider:'openai',method:'subscription'}],selection:{connectionId:connection.id,modelId:connection.models[0].id,effort:'off'}};
await act(async()=>oauth());
await waitFor(()=>advances===1);
disconnectPending=true;
await mount(Email);
await waitFor(()=>button('Retry disconnection'));
assert.equal(disconnectCalls,0,'uncertain disconnection is never retried automatically');
assert.ok(button('Connect Gmail').disabled);
assert.ok(button('Continue').disabled);
await click('Retry disconnection');
assert.equal(disconnectCalls,1);
assert.match(document.body.textContent,/Fixture disconnection unavailable/);
assert.ok(button('Connect Gmail').disabled);
assert.equal(advances,0);
failDisconnect=false;
await click('Retry disconnection');
await waitFor(()=>button('Connect Gmail')&&!button('Connect Gmail').disabled);
assert.equal(disconnectCalls,2);
assert.equal(button('Retry disconnection'),undefined);
assert.doesNotMatch(document.body.textContent,/Fixture disconnection unavailable/);
assert.equal(advances,0,'recovered disconnection still requires Gmail consent');
await mount(Email);
await act(async()=>{for(const action of document.querySelectorAll('.ob-footer-end button'))action.click();});
assert.equal(advances,0,'unconnected Gmail cannot be skipped');
await click('Connect Gmail');
await act(async()=>channel.onmessage({data:{connection:'connected',service:'gmail',attempt:'B'.repeat(43)}}));
assert.equal(advances,0,'foreign callback cannot advance');
failApps=true;
await act(async()=>channel.onmessage({data:{connection:'connected',service:'gmail',attempt}}));
await settle();
assert.equal(advances,0,'callback alone cannot advance without confirmed account state');
failApps=false; gmailConnected=false; gmailReconnect=true;
await act(async()=>pageDataCache.refresh('/api/apps',true));
assert.equal(advances,0,'an inactive account cannot complete onboarding');
gmailConnected=true;
await act(async()=>pageDataCache.refresh('/api/apps',true));
await waitFor(()=>advances===1);
assert.equal(gmailReconnect,true,'expired inbox history does not invalidate a connected account');
await act(async()=>pageDataCache.refresh('/api/apps',true));
assert.equal(advances,1);
for(const direction of ['forward','back']){
  await mount(Email,direction);
  await waitFor(()=>button('Continue')&&!button('Continue').disabled);
  assert.equal(advances,0,'cached email must not bounce '+direction);
}
for(const direction of ['forward','back']){
  gmailConnected=false; gmailCompleted=false;
  await mount(Email,direction);
  await click('Connect Gmail');
  gmailConnected=true; gmailCompleted=true;
  await act(async()=>window.dispatchEvent(new Event('focus')));
  await waitFor(()=>button('Continue')&&!button('Continue').disabled);
  assert.equal(advances,direction==='forward'?1:0,'confirmed polling only advances forward');
}
gmailConnected=false; gmailCompleted=false; gmailMissing=false;
await mount(Email);
await click('Connect Gmail');
gmailConnected=true;
await act(async()=>window.dispatchEvent(new Event('focus')));
await waitFor(()=>document.querySelector('[data-gmail="connected"]'));
assert.doesNotMatch(document.body.textContent,/Gmail didn’t connect/);
assert.equal(advances,0,'an account refresh cannot replace confirmation of this attempt');
gmailCompleted=true;
await act(async()=>window.dispatchEvent(new Event('focus')));
await waitFor(()=>advances===1);
gmailConnected=false; gmailCompleted=false; gmailMissing=false;
await mount(Email);
await click('Connect Gmail');
gmailMissing=true;
await act(async()=>window.dispatchEvent(new Event('focus')));
await waitFor(()=>document.body.textContent.includes('Gmail didn’t connect'));
assert.equal(advances,0,'an absent attempt without completion remains a failure');
await mount(Telegram);
await click('Confirm');
assert.equal(advances,0);
assert.match(document.body.textContent,/Fixture pairing rejected/);
failChannelLoad=true;
await act(async()=>window.dispatchEvent(new Event('focus')));
await waitFor(()=>button('Retry loading'));
failTelegram=false;
await click('Confirm');
await waitFor(()=>advances===1);
assert.doesNotMatch(document.body.textContent,/Fixture channel refresh failed/);
failChannelLoad=false;
await act(async()=>window.dispatchEvent(new Event('focus')));
assert.equal(advances,1);
for(const direction of ['forward','back']){
  await mount(Telegram,direction);
  await waitFor(()=>button('Continue')&&!button('Continue').disabled);
  assert.equal(advances,0,'cached Telegram must not bounce '+direction);
}
sessionStorage.clear();
writeStep({owner:'fixture-owner',step:'about',version:2});
interviewCompleted=false;
interviewDraft={answers:['Synthetic saved first answer'],turns:[['Synthetic saved first question'],['Synthetic saved next question']],done:false};
holdInterviewRead=true;
await mount(About,'forward');
assert.equal(interviewPosts,0,'cold restart must restore before generating another question');
assert.equal(document.querySelector('input[aria-label="Your answer"]')?.disabled??true,true);
await act(async()=>releaseInterviewRead());holdInterviewRead=false;
await waitFor(()=>document.body.textContent.includes('Synthetic saved first answer')&&document.body.textContent.includes('Synthetic saved next question'));
await act(async()=>root.unmount());root=undefined;
interviewCompleted=false;
interviewDraft={answers:[],turns:[],done:false};
sessionStorage.removeItem('nod.onboarding.about');
writeStep({owner:'fixture-owner',step:'about',version:2});
await mount(About,'back');
await act(async()=>{for(const action of document.querySelectorAll('.ob-footer-end button'))action.click()});
assert.equal(advances,0,'returning to an unanswered interview must not bypass its questions');
assert.equal(interviewSaves,0);
await waitFor(()=>document.body.textContent.includes('Synthetic question?'));
await act(async()=>{const input=document.querySelector('input[aria-label="Your answer"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Synthetic project focus');input.dispatchEvent(new Event('input',{bubbles:true}));});
await act(async()=>document.querySelector('button[aria-label="Send"]').click());
await waitFor(()=>button('Continue')&&!button('Continue').disabled);
assert.equal(advances,0);
await click('Continue');
assert.equal(interviewSaves,1);
assert.equal(advances,1);
await mount(About,'back');
await waitFor(()=>button('Continue')&&!button('Continue').disabled);
assert.ok(document.body.textContent.includes('Synthetic project focus'));
await click('Continue');
assert.equal(interviewSaves,1,'returning through completed answers must not save them again');
assert.equal(advances,1);
failInterviewReset=true;
await click('Change my answers');
assert.ok(document.body.textContent.includes('Synthetic project focus'));
assert.match(document.body.textContent,/Synthetic reset failed/);
failInterviewReset=false;
await click('Change my answers');
await waitFor(()=>document.body.textContent.includes('Synthetic question?'));
assert.equal(document.body.textContent.includes('Synthetic project focus'),false);
await act(async()=>root.unmount());root=undefined;
sessionStorage.clear();
writeStep({owner:'fixture-owner',step:'about',version:2});
interviewCompleted=false;
interviewDraft={answers:['Synthetic saved first answer'],turns:[['Synthetic saved first question'],['Synthetic saved next question']],done:false};
sessionStorage.setItem('nod.onboarding.about',JSON.stringify({owner:'fixture-owner',version:2,completed:true,answers:['Synthetic stale completed answer'],turns:[['Synthetic stale question'],['Synthetic stale closing']],done:true}));
holdInterviewRead=true;
const postsBeforeRestore=interviewPosts;
await mount(About,'forward');
assert.equal(interviewPosts,postsBeforeRestore,'restore must finish before any empty interview can overwrite saved progress');
assert.equal(document.querySelector('input[aria-label="Your answer"]')?.disabled??true,true);
await act(async()=>releaseInterviewRead());holdInterviewRead=false;
await waitFor(()=>document.body.textContent.includes('Synthetic saved first answer')&&document.body.textContent.includes('Synthetic saved next question'));
assert.equal(interviewPosts,postsBeforeRestore,'restored unanswered question does not regenerate a reply');
assert.doesNotMatch(document.body.textContent,/Synthetic stale completed answer/,'active server progress wins over a completed same-session cache');
assert.equal(sessionStorage.getItem('nod.onboarding.about'),null,'active server progress removes the stale completed cache without copying unfinished answers');
await act(async()=>root.unmount());root=undefined;
failInterviewRead=true;
await mount(About,'forward');
await waitFor(()=>button('Try again'));
assert.match(document.body.textContent,/Synthetic draft unavailable/);
assert.equal(button('Start interview again'),undefined,'a transient read failure must not offer deletion');
assert.equal(interviewPosts,postsBeforeRestore);
failInterviewRead=false;
await click('Try again');
await waitFor(()=>document.body.textContent.includes('Synthetic saved next question'));
assert.equal(interviewPosts,postsBeforeRestore);
failInterviewPost=400;
await act(async()=>{const input=document.querySelector('input[aria-label="Your answer"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Synthetic rejected answer');input.dispatchEvent(new Event('input',{bubbles:true}));});
await act(async()=>document.querySelector('button[aria-label="Send"]').click());
await waitFor(()=>document.querySelector('input[aria-label="Your answer"]')?.value==='Synthetic rejected answer');
assert.equal(document.querySelector('input[aria-label="Your answer"]').disabled,false);
assert.match(document.body.textContent,/Synthetic draft write failed/);
assert.equal(button('Continue'),undefined);
failInterviewPost=500;
await act(async()=>{const input=document.querySelector('input[aria-label="Your answer"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Synthetic next answer');input.dispatchEvent(new Event('input',{bubbles:true}));});
await act(async()=>document.querySelector('button[aria-label="Send"]').click());
await waitFor(()=>button('Try again'));
assert.match(document.body.textContent,/Synthetic draft write failed/);
assert.match(document.body.textContent,/Synthetic next answer/);
assert.equal(button('Continue'),undefined,'storage failure must not advance through a fallback question');
failInterviewPost=0;
await click('Try again');
await waitFor(()=>button('Continue')&&!button('Continue').disabled);
assert.deepEqual(interviewDraft.answers,['Synthetic saved first answer','Synthetic next answer']);
failInterviewSave=true;
interviewCompleted=false;
interviewDraft={answers:['Synthetic newer answer'],turns:[['Synthetic first question'],['Synthetic newer question']],done:false};
await click('Continue');
await waitFor(()=>button('Try again'));
assert.match(document.body.textContent,/Synthetic answers changed/);
await click('Try again');
await waitFor(()=>document.body.textContent.includes('Synthetic newer question'));
assert.match(document.body.textContent,/Synthetic newer answer/);
assert.doesNotMatch(document.body.textContent,/Synthetic next answer/);
failInterviewSave=false;
await act(async()=>root.unmount());root=undefined;
for(const cache of [{owner:'another-owner',version:2},{owner:'fixture-owner',version:1}]){
  interviewCompleted=true;
  interviewDraft={answers:[],turns:[],done:true};
  sessionStorage.setItem('nod.onboarding.about',JSON.stringify({...cache,generation:interviewGeneration,completed:true,answers:['Synthetic foreign cached answer'],turns:[['Synthetic foreign question'],['Synthetic foreign closing']],done:true}));
  const count=interviewPosts;
  await mount(About,'back');
  await waitFor(()=>button('Continue')&&!button('Continue').disabled);
  assert.doesNotMatch(document.body.textContent,/Synthetic foreign/,'cache is scoped to owner and onboarding version');
  assert.equal(interviewPosts,count,'completed receipt without a matching cache never restarts the interview');
}
const oldGeneration=interviewGeneration;
const savedBeforeReplay=interviewSaves;
interviewGeneration='synthetic-generation-'+(++generations);
interviewCompleted=false;
interviewDraft={answers:[],turns:[],done:false};
await click('Continue');
await waitFor(()=>button('Try again'));
assert.match(document.body.textContent,/Your setup answers changed/);
assert.equal(advances,0,'a stale completion receipt cannot advance after another tab resets the interview');
assert.equal(interviewSaves,savedBeforeReplay,'old completed answers cannot overwrite current memory');
await click('Try again');
await waitFor(()=>document.body.textContent.includes('Synthetic question?'));
assert.equal(button('Continue'),undefined);
sessionStorage.setItem('nod.onboarding.about',JSON.stringify({owner:'fixture-owner',version:2,generation:oldGeneration,completed:true,answers:['Synthetic retired answer'],turns:[['Synthetic retired question'],['Synthetic retired closing']],done:true}));
await mount(About,'back');
await waitFor(()=>document.body.textContent.includes('Synthetic question?'));
assert.doesNotMatch(document.body.textContent,/Synthetic retired/);
assert.equal(sessionStorage.getItem('nod.onboarding.about'),null);
resetVersion='synthetic-corrupt-version-1';
const postsBeforeRecovery=interviewPosts;
const deletesBeforeRecovery=interviewDeletes;
await mount(About);
await waitFor(()=>button('Start interview again'));
assert.equal(button('Try again')?.disabled,false);
assert.equal(document.querySelector('input[aria-label="Your answer"]')?.disabled??true,true);
assert.equal(interviewPosts,postsBeforeRecovery,'corrupt saved progress cannot silently start a new interview');
assert.equal(interviewDeletes,deletesBeforeRecovery,'corrupt saved progress cannot be deleted without an explicit choice');
holdRecovery=true;
await act(async()=>{button('Start interview again').click();button('Start interview again').click();});
await settle();
assert.deepEqual(recoveryRequests,[{resetVersion:'synthetic-corrupt-version-1'}]);
assert.equal(interviewDeletes,deletesBeforeRecovery+1);
assert.equal(interviewPosts,postsBeforeRecovery);
await act(async()=>releaseRecovery());holdRecovery=false;
await waitFor(()=>document.body.textContent.includes('Synthetic question?'));
assert.equal(button('Start interview again'),undefined);
assert.equal(document.querySelector('input[aria-label="Your answer"]').disabled,false);
assert.equal(interviewPosts,postsBeforeRecovery+1);
assert.equal(advances,0);
resetVersion='synthetic-corrupt-version-2';
await mount(About);
await waitFor(()=>button('Start interview again'));
resetVersion='synthetic-corrupt-version-3';
await click('Start interview again');
assert.equal(recoveryRequests.length,2);
assert.deepEqual(recoveryRequests[1],{resetVersion:'synthetic-corrupt-version-2'});
assert.equal(button('Start interview again'),undefined,'a stale reset token must require a reload');
assert.equal(interviewPosts,postsBeforeRecovery+1);
await click('Try again');
await waitFor(()=>button('Start interview again'));
assert.equal(recoveryRequests.length,2,'reloading recovery must never repeat the delete');
await click('Start interview again');
await waitFor(()=>document.body.textContent.includes('Synthetic question?'));
assert.deepEqual(recoveryRequests[2],{resetVersion:'synthetic-corrupt-version-3'});
assert.equal(interviewDeletes,deletesBeforeRecovery+3);
assert.equal(interviewPosts,postsBeforeRecovery+2);
await act(async()=>root.unmount());
dom.window.close();
process.exit(0);
`,
  });
  assert.equal(result.exitCode, 0, result.stderr);
});

test('desktop onboarding uses the normal backend and waits for workspace readiness before completing', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 30_000,
    input: String.raw`
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:51000/onboarding', pretendToBeVisual: true });
for (const name of ['window','document','Node','Element','HTMLElement','HTMLInputElement','HTMLButtonElement','Event','CustomEvent','KeyboardEvent','MouseEvent','MutationObserver','getComputedStyle','sessionStorage']) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : name === 'document' ? dom.window.document : typeof dom.window[name] === 'function' && name[0] === name[0].toLowerCase() ? dom.window[name].bind(dom.window) : dom.window[name] });
Object.defineProperty(globalThis, 'navigator', {configurable:true,value:dom.window.navigator});
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.location = window.location;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
HTMLElement.prototype.scrollIntoView = function () {};
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });

let statusListener;
let runtimeRetries = 0;
let releaseRetry;
let modelConnected = false;
window.nodDesktop = {
  getSettings: async () => ({ onboardingPreferenceStep: 'complete' }),
  onPreferences: () => () => {},
  status: async () => ({phase:'ready',runtime:{phase:'preparing'}}),
  onStatus: listener => {statusListener=listener;return()=>{statusListener=undefined}},
  prepare: async () => {runtimeRetries++;return new Promise(resolve=>{releaseRetry=(next={phase:'ready',runtime:{phase:'ready'}})=>{statusListener(next);resolve(next)}})},
};
const owner = { id: 'synthetic-setup-owner', name: '', email: null, avatarUrl: null };
const calls = [];
let finishCalls = 0;
let failFinish = false;
let modelsStatus = 'connected';
let failModels = false;
let suggestions = 0;
let aborted = 0;
let releasePreparation;
window.fetch = globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url, window.location.href).pathname;
  calls.push(path);
  if (path === '/api/account/prepare') return new Promise((resolve,reject)=>{
    releasePreparation=()=>resolve(Response.json({ok:true}));
    options.signal.addEventListener('abort',()=>{aborted++;reject(new DOMException('Aborted','AbortError'))},{once:true});
  });
  if (path === '/api/preferences') return Response.json({timeZone:'Europe/Lisbon'});
  if (path === '/api/models') return failModels ? Response.json({error:'Synthetic model service is unavailable'}, {status:503}) : Response.json({connections:modelConnected?[{id:'synthetic-model',provider:'anthropic',method:'api_key',status:modelsStatus,label:'Synthetic model',managed:false,models:[]}]:[],selection:null});
  if (path === '/api/apps') return Response.json([{slug:'gmail',name:'Gmail',status:'disconnected'}]);
  if (path === '/api/configuration') return Response.json({integrationsReady:true});
  if (path === '/api/channel-settings') return Response.json({ready:false,channels:[]});
  if (path === '/api/onboarding/suggestions') {suggestions++;return Response.json({ok:true});}
  return Response.json({error:'Unexpected synthetic request'}, {status:404});
};
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Onboarding } = await import('./src/web/pages/onboarding/index.tsx');
const { pageDataCache } = await import('./src/web/lib/page-data-cache.ts');
const { writeStep } = await import('./src/web/pages/onboarding/storage.ts');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root = createRoot(document.getElementById('root'));
const render=()=>root.render(createElement(Onboarding,{user:owner,onComplete:async()=>{finishCalls++;if(failFinish)throw new Error('Synthetic completion save failed')}}));
const settle=(ms=30)=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,ms))});
const button=text=>[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===text);
const waitFor=async condition=>{for(let at=0;at<80&&!condition();at++)await settle();assert.ok(Boolean(condition()),'Expected onboarding recovery or progression')};
window.history.replaceState(null,'','/onboarding?welcome=complete');
await act(async()=>render());
await waitFor(()=>document.querySelector('.ob')?.dataset.step==='brain');
assert.equal(window.location.search,'');
assert.ok(calls.includes('/api/account/prepare'));
assert.equal(calls.some(path=>path.startsWith('/api/desktop/setup')),false);
await waitFor(()=>[...document.querySelectorAll('.ob-brain-option')].some(item=>item.textContent.includes('Anthropic')));
await act(async()=>[...document.querySelectorAll('.ob-brain-option')].find(item=>item.textContent.includes('Anthropic')).click());
await waitFor(()=>document.querySelector('#ob-brain-key-anthropic'));
async function recoverWithDraft(input, draft) {
  const fill=value=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))};
  await act(async()=>fill(draft));
  await act(async()=>statusListener({phase:'ready',runtime:{phase:'error',error:'Synthetic runtime interrupted'}}));
  await waitFor(()=>button('Try again'));
  assert.equal(input.isConnected,true);
  assert.equal(input.value,draft);
  assert.equal(input.closest('[inert]'),null);
  const before=runtimeRetries;
  await act(async()=>button('Try again').click());
  await waitFor(()=>runtimeRetries===before+1);
  assert.equal(button('Try again').disabled,true);
  assert.equal(input.isConnected,true);
  assert.equal(input.closest('[inert]'),null);
  await act(async()=>fill(draft+'-kept'));
  await act(async()=>releaseRetry());
  await waitFor(()=>!button('Try again'));
  assert.equal(input.isConnected,true);
  assert.equal(input.value,draft+'-kept');
}
await recoverWithDraft(document.querySelector('#ob-brain-key-anthropic'),'synthetic-model-draft');
assert.equal(document.querySelector('.ob').dataset.step,'brain');
await act(async()=>root.unmount());
modelConnected=true;
pageDataCache.clear();
writeStep({owner:owner.id,step:'email',version:2});
root=createRoot(document.getElementById('root'));
await act(async()=>render());
await waitFor(()=>button('Connect Gmail')&&!button('Connect Gmail').disabled);
const gmailCard=document.querySelector('.ob-email-gmail');
await act(async()=>statusListener({phase:'ready',runtime:{phase:'error',error:'Synthetic runtime interrupted'}}));
await waitFor(()=>button('Try again'));
assert.equal(gmailCard.isConnected,true);
assert.equal(gmailCard.closest('[inert]'),null);
const beforeEmailRetry=runtimeRetries;
await act(async()=>button('Try again').click());
await waitFor(()=>runtimeRetries===beforeEmailRetry+1);
await act(async()=>releaseRetry());
await waitFor(()=>!button('Try again'));
assert.equal(gmailCard.isConnected,true);
assert.equal(document.querySelector('.ob').dataset.step,'email');
await act(async()=>root.unmount());
sessionStorage.clear();
for(const cookie of dom.cookieJar.getCookiesSync(window.location.href))if(!cookie.isPersistent())document.cookie=cookie.key+'=; path=/; max-age=0';
dom.reconfigure({url:'http://127.0.0.1:51001/onboarding?welcome=complete'});
root=createRoot(document.getElementById('root'));
await act(async()=>render());
await waitFor(()=>document.querySelector('.ob')?.dataset.step==='email');
assert.equal(window.location.search,'');
await waitFor(()=>button('Connect Gmail')&&!button('Connect Gmail').disabled);
await act(async()=>root.unmount());
writeStep({owner:'foreign-owner',step:'email',version:2});
root=createRoot(document.getElementById('root'));
await act(async()=>render());
assert.equal(document.querySelector('.ob').dataset.step,'welcome');
await act(async()=>root.unmount());
writeStep({owner:owner.id,step:'email',version:1});
root=createRoot(document.getElementById('root'));
await act(async()=>render());
assert.equal(document.querySelector('.ob').dataset.step,'welcome');
await act(async()=>root.unmount());
writeStep({owner:owner.id,step:'telegram',version:2});
root=createRoot(document.getElementById('root'));
await act(async()=>render());
await waitFor(()=>button('Skip for now'));
assert.equal(suggestions,0);
assert.ok(button('Back')&&!button('Back').disabled);
await act(async()=>button('Skip for now').click());
await waitFor(()=>document.querySelector('main [role="status"]'));
assert.equal(document.activeElement,document.querySelector('main'));
assert.equal(document.querySelector('main button'),null);
assert.equal(document.querySelector('main a'),null);
assert.equal(finishCalls,0);
await act(async()=>statusListener({phase:'ready',runtime:{phase:'error',error:'Synthetic runtime interrupted'}}));
await waitFor(()=>button('Try again'));
assert.ok(document.querySelector('main [role="alert"]'));
assert.equal(finishCalls,0);
const beforeFinalRetry=runtimeRetries;
const preparationsBeforeRetry=calls.filter(path=>path==='/api/account/prepare').length;
for(const failure of [
 {phase:'error',error:'Synthetic retry failed again',runtime:{phase:'error',message:'Synthetic retry failed again'}},
 {phase:'ready',runtime:{phase:'error',error:'Synthetic nested retry failed again'}},
 {phase:'preparing',runtime:{phase:'preparing'}},
]){
 await act(async()=>button('Try again').click());
 await waitFor(()=>button('Try again')?.disabled);
 await act(async()=>releaseRetry(failure));
 await waitFor(()=>button('Try again')&&!button('Try again').disabled);
 assert.match(document.querySelector('main [role="alert"]').textContent,/failed again|not ready yet/);
 assert.equal(calls.filter(path=>path==='/api/account/prepare').length,preparationsBeforeRetry,'failed native retry must not restart the backend preparation wait');
 assert.equal(finishCalls,0);
}
assert.equal(runtimeRetries,beforeFinalRetry+3);
await act(async()=>button('Try again').click());
await waitFor(()=>runtimeRetries===beforeFinalRetry+4);
await act(async()=>releaseRetry());
await waitFor(()=>document.querySelector('main [role="status"]'));
assert.ok(aborted>1);
assert.equal(document.querySelector('main button'),null);
failFinish=true;
await act(async()=>releasePreparation());
await waitFor(()=>finishCalls===1&&button('Try again'));
assert.ok(sessionStorage.getItem('nod.onboarding.step'));
await settle();
assert.equal(finishCalls,1,'failed completion must not be retried automatically');
const preparationsBeforeCompletionRetry=calls.filter(path=>path==='/api/account/prepare').length;
failFinish=false;
await act(async()=>button('Try again').click());
await waitFor(()=>finishCalls===2);
assert.equal(calls.filter(path=>path==='/api/account/prepare').length,preparationsBeforeCompletionRetry,'completion retry reuses successful preparation');
assert.equal(sessionStorage.getItem('nod.onboarding.step'),null);
assert.equal(document.cookie.includes('nod_onboarding_step='),false);
await act(async()=>statusListener({phase:'ready',runtime:{phase:'ready'}}));
await settle();
assert.equal(finishCalls,2);
assert.equal(calls.some(path=>path.startsWith('/api/desktop/setup')),false);
await act(async()=>root.unmount());
assert.equal(statusListener,undefined);
for(const unavailable of ['request','loading','reconnect']) {
  failModels=unavailable==='request';
  modelsStatus=unavailable==='loading'?'loading':unavailable==='reconnect'?'reconnect':'connected';
  pageDataCache.clear();
  writeStep({owner:owner.id,step:'email',version:2});
  root=createRoot(document.getElementById('root'));
  await act(async()=>render());
  await settle();
  assert.equal(document.querySelector('.ob').dataset.step,unavailable==='reconnect'?'brain':'email');
  await act(async()=>root.unmount());
}
failModels=false;
modelsStatus='connected';
delete window.nodDesktop;
pageDataCache.clear();
writeStep({owner:owner.id,step:'telegram',version:2});
root=createRoot(document.getElementById('root'));
await act(async()=>render());
await waitFor(()=>button('Skip for now'));
await act(async()=>releasePreparation());
failFinish=true;
await act(async()=>button('Skip for now').click());
await waitFor(()=>finishCalls===3&&button('Try again'));
assert.ok(sessionStorage.getItem('nod.onboarding.step'));
failFinish=false;
await act(async()=>button('Try again').click());
await waitFor(()=>finishCalls===4);
assert.equal(sessionStorage.getItem('nod.onboarding.step'),null);
await act(async()=>root.unmount());
dom.window.close();
process.exit(0);
`,
  });
  assert.equal(result.exitCode, 0, result.stderr);
});

test('desktop onboarding persists explicit native choices and resumes without repeating them', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 30_000,
    input: String.raw`
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JSDOM} from 'jsdom';
import {createSettingsStore} from './desktop/main/settings.mjs';
const directory=await mkdtemp(join(tmpdir(),'nod-native-preferences-'));
const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://127.0.0.1:51000/onboarding?preferences=required',pretendToBeVisual:true});
for(const name of ['window','document','Node','Element','HTMLElement','HTMLInputElement','HTMLButtonElement','Event','CustomEvent','KeyboardEvent','MouseEvent','MutationObserver','getComputedStyle','sessionStorage']) Object.defineProperty(globalThis,name,{configurable:true,value:name==='window'?dom.window:name==='document'?dom.window.document:typeof dom.window[name]==='function'&&name[0]===name[0].toLowerCase()?dom.window[name].bind(dom.window):dom.window[name]});
Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator});
globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.location=window.location;
globalThis.ResizeObserver=class{observe(){}disconnect(){}};
HTMLElement.prototype.scrollIntoView=function(){};
window.matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){}});
let store=createSettingsStore(join(directory,'settings.json'),{});
let failRead=true;
let failSave=true;
let saves=0;
let reads=0;
let statusListener;
let runtimeRetries=0;
window.nodDesktop={
  status:async()=>({phase:'ready',runtime:{phase:'preparing'}}),
  onStatus:listener=>{statusListener=listener;return()=>{statusListener=undefined}},
  prepare:async()=>{runtimeRetries++;const ready={phase:'ready',runtime:{phase:'ready'}};statusListener(ready);return ready},
  getSettings:async()=>{reads++;if(failRead)throw new Error('Synthetic native read failed');return store.get()},
  saveSettings:async change=>{saves++;if(failSave)throw new Error('Synthetic native save failed');return store.save(change)},
};
const calls=[];
window.fetch=globalThis.fetch=async(url,options={})=>{
 const path=new URL(url,window.location.href).pathname;calls.push(path);
 if(path==='/api/account/prepare')return new Promise(()=>{});
 if(path==='/api/models')return Response.json({connections:[{id:'synthetic',status:'connected',models:[]}],selection:null});
 if(path==='/api/preferences')return Response.json({timeZone:'Europe/Lisbon'});
 if(path==='/api/onboarding/suggestions')return Response.json({ok:true});
 throw new Error('Unexpected request '+path);
};
const {createElement,act}=await import('react');
const {createRoot}=await import('react-dom/client');
const {Onboarding}=await import('./src/web/pages/onboarding/index.tsx');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const session={user:{id:'synthetic-native-owner',name:'',email:null,avatarUrl:null},settings:{usageData:false,onboardingCompleted:false}};
let root=createRoot(document.getElementById('root'));
const render=()=>act(async()=>root.render(createElement(Onboarding,{user:session.user,onComplete:async()=>assert.fail('No completion before runtime ready')})));
const settle=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))});
const waitFor=async condition=>{for(let at=0;at<100&&!condition();at++)await settle();assert.ok(condition())};
const button=text=>[...document.querySelectorAll('button')].find(value=>value.textContent.trim()===text);
await render();
assert.equal(window.location.search,'');
await waitFor(()=>button('Try again'));
assert.equal(reads,1);
assert.equal(saves,0);
assert.equal(document.querySelector('[role="switch"]'),null);
failRead=false;
await act(async()=>button('Try again').click());
await waitFor(()=>button('Enable notifications'));
const preferenceAction=()=>document.querySelector('.ob-preference-action button');
assert.equal((await store.get()).notifications,false);
assert.ok(preferenceAction());
assert.equal(saves,0);
assert.equal(button('Continue').disabled,true);
await act(async()=>button('Continue').click());
assert.equal((await store.get()).onboardingPreferenceStep,'notifications');
const notificationAction=preferenceAction();
await act(async()=>statusListener({phase:'ready',runtime:{phase:'error',error:'Synthetic runtime interrupted'}}));
await waitFor(()=>button('Try again'));
assert.equal(preferenceAction(),notificationAction);
await act(async()=>button('Try again').click());
await waitFor(()=>runtimeRetries===1&&!button('Try again'));
assert.equal(preferenceAction(),notificationAction);
assert.equal(saves,0);
assert.equal((await store.get()).onboardingPreferenceStep,'notifications');
await act(async()=>{preferenceAction().click();preferenceAction().click()});
await waitFor(()=>document.body.textContent.includes('Synthetic native save failed'));
assert.equal(saves,1);
assert.equal((await store.get()).onboardingPreferenceStep,'notifications');
assert.ok(preferenceAction());
failSave=false;
await act(async()=>preferenceAction().click());
await waitFor(()=>!preferenceAction()&&!button('Continue').disabled);
assert.equal((await store.get()).notifications,true);
assert.equal((await store.get()).onboardingPreferenceStep,'notifications');
await act(async()=>button('Continue').click());
await waitFor(()=>(document.querySelector('.ob')?.dataset.step)==='launchAtLogin');
assert.equal((await store.get()).onboardingPreferenceStep,'launchAtLogin');
assert.equal(button('Start chatting').disabled,true);
await waitFor(()=>preferenceAction());
await act(async()=>preferenceAction().click());
await waitFor(()=>!preferenceAction()&&!button('Start chatting').disabled);
assert.equal((await store.get()).launchAtLogin,true);
assert.equal((await store.get()).onboardingPreferenceStep,'launchAtLogin');
await act(async()=>root.unmount());
store=createSettingsStore(join(directory,'settings.json'),{});
root=createRoot(document.getElementById('root'));
await render();
await waitFor(()=>button('Start chatting')&&!button('Start chatting').disabled);
assert.equal(document.querySelector('.ob').dataset.step,'launchAtLogin');
assert.equal(preferenceAction(),null);
assert.equal((await store.get()).launchAtLogin,true);
await act(async()=>button('Start chatting').click());
await waitFor(()=>document.querySelector('main [role="status"]'));
assert.equal((await store.get()).launchAtLogin,true);
assert.equal((await store.get()).onboardingPreferenceStep,'complete');
assert.equal(saves,5);
await act(async()=>root.unmount());
store=createSettingsStore(join(directory,'settings.json'),{});
root=createRoot(document.getElementById('root'));
await render();
await waitFor(()=>document.querySelector('main [role="status"]'));
assert.equal(document.querySelector('[role="switch"]'),null);
assert.equal(saves,5);
await act(async()=>root.unmount());
await store.save({onboardingCompleted:true});
const {DesktopOptions,useDesktopSettings}=await import('./src/web/components/desktop-settings.tsx');
window.nodDesktop.onPreferences=()=>()=>{};
function GeneralChoices(){
 const native=useDesktopSettings();
 return native.settings?createElement(DesktopOptions,{settings:native.settings,busy:native.busy,onChange:native.save}):null;
}
root=createRoot(document.getElementById('root'));
await act(async()=>root.render(createElement(GeneralChoices)));
await waitFor(()=>document.querySelectorAll('[role="switch"]').length===2);
const login=()=>document.querySelector('[role="switch"][aria-label="Open at login"]');
const notices=()=>document.querySelector('[role="switch"][aria-label="Desktop notifications"]');
assert.equal(login().getAttribute('aria-checked'),'true');
assert.equal(notices().getAttribute('aria-checked'),'true');
await act(async()=>login().click());
await waitFor(()=>!login().disabled);
await act(async()=>notices().click());
await waitFor(()=>!notices().disabled);
assert.equal((await store.get()).launchAtLogin,false);
assert.equal((await store.get()).notifications,false);
assert.equal((await store.get()).onboardingPreferenceStep,'complete');
failSave=true;
await act(async()=>login().click());
await waitFor(()=>!login().disabled);
assert.equal(login().getAttribute('aria-checked'),'false');
assert.equal((await store.get()).launchAtLogin,false);
failSave=false;
await act(async()=>root.unmount());
assert.equal(calls.some(path=>path.startsWith('/api/desktop/setup')),false);
await rm(directory,{recursive:true,force:true});
dom.window.close();
process.exit(0);
`,
  });
  assert.equal(result.exitCode, 0, result.stderr);
});

test(
  'sign-in method choices claim once and carry only active owned browser steps into the private flow',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    for (const scenario of [
      'staged continuity',
      'uncertain selection',
      'expired retry',
      'trust refusal',
    ])
      await t.test(scenario, async (t) => {
        const schema = `test_method_flow_${randomUUID().replaceAll('-', '')}`;
        const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
        await admin.query(`CREATE SCHEMA ${schema}`);
        const pool = new pg.Pool({
          connectionString: process.env.TEST_DATABASE_URL,
          options: `-c search_path=${schema}`,
        });
        const app = Fastify();
        t.after(async () => {
          await app.close();
          await pool.end();
          await admin.query(`DROP SCHEMA ${schema} CASCADE`);
          await admin.end();
        });
        const turns = await seedTurns(pool);
        const origin = 'https://choice.example.test';
        let currentOrigin = origin;
        let clicks = 0;
        let resumed = 0;
        const fail = scenario === 'uncertain selection';
        const refused = scenario === 'trust refusal';
        const entered: CredentialInjection[] = [];
        const key = randomBytes(32);
        const options = {
          requestKey: Buffer.alloc(32, 42),
          keyStore: { id: 'fixture', configured: true, getKey: async () => key },
          page: async () => ({ origin: currentOrigin, url: `${currentOrigin}/login` }),
          signInMethods: async (
            _browser: string,
            actualOrigin: string,
            choices: { label: string; selector: string }[],
          ) => {
            assert.equal(actualOrigin, currentOrigin);
            return {
              document: 'synthetic-document',
              methods: choices.map((choice) => ({
                id: randomUUID(),
                label: choice.label,
                page: { origin: currentOrigin, url: `${currentOrigin}/login` },
              })),
            };
          },
          checkMethods: async (
            _turn: TurnRef,
            methods: { selector: string; page: { origin: string } }[],
          ) => {
            assert.ok(methods.every((method) => method.page.origin === currentOrigin));
            if (refused) throw new Error('Synthetic trust refusal');
          },
          selectSignInMethod: async (
            _browser: string,
            choice: { origin: string; document: string; methodId: string },
          ) => {
            assert.equal(choice.origin, currentOrigin);
            assert.equal(choice.document, 'synthetic-document');
            assert.ok(choice.methodId);
            clicks++;
            if (fail) throw new Error('Synthetic interrupted selection');
          },
          inject: async (input: CredentialInjection) => {
            entered.push(input);
          },
          resume: async () => {
            resumed++;
          },
          retry: async () => {},
        };
        const vault = await createVault(pool, options);
        vault.registerRoutes(app);
        const get = async (url: string) =>
          (await app.inject({ method: 'GET', url })).json<CredentialRequest>();
        if (scenario === 'uncertain selection') {
          const failureTurn = await turns.turn();
          const failure = await vault.request(failureTurn, 'local-development', {
            origin: currentOrigin,
            label: 'Identity',
            kind: 'method',
            methods: [{ label: 'Continue', selector: '#continue' }],
          });
          await turns.wait(failureTurn);
          const failurePath = `/api/credential-requests/${failure.url.split('/').at(-1)}`;
          const failureRequest = await get(failurePath);
          assert.equal(
            (
              await app.inject({
                method: 'POST',
                url: `${failurePath}/method`,
                payload: { methodId: failureRequest.methods![0].id },
              })
            ).statusCode,
            502,
          );
          assert.equal((await get(failurePath)).status, 'uncertain');
          assert.equal(
            (
              await app.inject({
                method: 'POST',
                url: `${failurePath}/method`,
                payload: { methodId: failureRequest.methods![0].id },
              })
            ).statusCode,
            409,
          );
          assert.equal(clicks, 1);
          assert.equal(resumed, 0);
          assert.deepEqual(
            (await app.inject({ method: 'GET', url: `${failurePath}/flow` })).json(),
            {},
          );
          return;
        }
        if (scenario === 'expired retry') {
          const expiredTurn = await turns.turn();
          const expired = await vault.request(expiredTurn, 'local-development', {
            origin: currentOrigin,
            label: 'Identity',
            kind: 'method',
            methods: [{ label: 'Continue', selector: '#continue' }],
          });
          await turns.wait(expiredTurn);
          const expiredPath = `/api/credential-requests/${expired.url.split('/').at(-1)}`;
          const expiredRequest = await get(expiredPath);
          await pool.query(
            "UPDATE credential_requests SET flow_expires_at=now()-interval '1 second' WHERE turn_id=$1",
            [expiredTurn.turnId],
          );
          assert.equal((await get(expiredPath)).status, 'expired');
          assert.equal(
            (
              await app.inject({
                method: 'POST',
                url: `${expiredPath}/method`,
                payload: { methodId: expiredRequest.methods![0].id },
              })
            ).statusCode,
            409,
          );
          assert.equal(clicks, 0);
          assert.equal(
            (await app.inject({ method: 'POST', url: `${expiredPath}/retry`, payload: {} }))
              .statusCode,
            200,
          );
          assert.equal(
            (await app.inject({ method: 'POST', url: `${expiredPath}/retry`, payload: {} }))
              .statusCode,
            409,
          );
          const retriedTurn = await turns.resume(expiredTurn, 'credentials-retry');
          const retried = await vault.request(retriedTurn, 'local-development', {
            origin: currentOrigin,
            label: 'Identity',
            kind: 'identifier',
            usernameSelector: '#email',
          });
          await turns.wait(retriedTurn);
          assert.equal(
            (await app.inject({ method: 'GET', url: `${expiredPath}/flow` })).json().nextId,
            retried.url.split('/').at(-1),
          );
          assert.equal(clicks, 0);
          return;
        }
        if (scenario === 'trust refusal') {
          const refusedTurn = await turns.turn();
          await assert.rejects(
            vault.request(refusedTurn, 'local-development', {
              origin: currentOrigin,
              label: 'Identity',
              kind: 'method',
              methods: [{ label: 'Continue', selector: '#continue' }],
            }),
            /trust refusal/,
          );
          assert.equal(
            (
              await pool.query('SELECT 1 FROM credential_requests WHERE turn_id=$1', [
                refusedTurn.turnId,
              ])
            ).rowCount,
            0,
          );
          return;
        }
        const turn = await turns.turn();
        const requested = await vault.request(turn, 'local-development', {
          origin,
          label: 'Synthetic website',
          kind: 'method',
          methods: [
            { label: 'Continue with Identity', selector: '#identity' },
            { label: 'Use email', selector: '#email' },
          ],
        });
        const path = `/api/credential-requests/${requested.url.split('/').at(-1)}`;
        await turns.wait(turn);
        const initial = await get(path);
        assert.equal(initial.kind, 'method');
        assert.equal(initial.status, 'pending');
        assert.equal(initial.methods?.length, 2);
        assert.doesNotMatch(JSON.stringify(initial), /#identity|#email|synthetic-document/);
        const wrong = await app.inject({
          method: 'POST',
          url: `${path}/method`,
          payload: { methodId: randomUUID() },
        });
        assert.equal(wrong.statusCode, 409);
        assert.equal(clicks, 0);
        let viewOpen = true;
        let clientRequests = 0;
        let pendingRequests = 0;
        const view = await vaultPage(
          createElement(Credentials, { id: initial.id, embedded: true }),
          async (url, init) => {
            clientRequests++;
            pendingRequests++;
            const result = await app.inject({
              method: (init.method ?? 'GET') as 'GET' | 'POST',
              url,
              headers: init.body ? { 'content-type': 'application/json' } : {},
              payload: init.body ? String(init.body) : undefined,
            });
            pendingRequests--;
            return new Response(result.body, {
              status: result.statusCode,
              headers: { 'content-type': 'application/json' },
            });
          },
          'http://localhost:4310/?conversation=synthetic',
        );
        t.after(async () => {
          if (viewOpen) await view.close();
        });
        const settle = async (predicate: () => boolean) => {
          await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
          for (let attempt = 0; attempt < 100 && (!predicate() || pendingRequests > 0); attempt++)
            await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
          await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
          assert.ok(predicate());
          assert.equal(pendingRequests, 0);
        };
        const focus = async () => act(async () => window.dispatchEvent(new window.Event('focus')));
        await settle(() => Boolean(view.document.querySelector('.credential-accounts button')));
        const choice = view.document.querySelector<HTMLButtonElement>(
          '.credential-accounts button',
        )!;
        choice.focus();
        const [, duplicate] = await Promise.all([
          act(async () => {
            choice.click();
            choice.click();
          }),
          app.inject({
            method: 'POST',
            url: `${path}/method`,
            payload: { methodId: initial.methods![0].id },
          }),
        ]);
        assert.ok([200, 409].includes(duplicate.statusCode));
        await settle(
          () =>
            resumed === 1 &&
            view.document.querySelector('.credential-card')?.getAttribute('aria-busy') === 'false',
        );
        assert.equal(view.document.activeElement, view.document.querySelector('.credential-card'));
        assert.equal(clicks, 1);
        assert.equal(resumed, 1);
        assert.equal((await get(path)).status, 'filled');
        assert.deepEqual((await app.inject({ method: 'GET', url: `${path}/flow` })).json(), {});
        const nextTurn = await turns.resume(turn);
        currentOrigin = 'https://identity.example.test';
        const next = await vault.request(nextTurn, 'local-development', {
          origin: currentOrigin,
          label: 'Identity',
          kind: 'identifier',
          usernameSelector: '#email',
          submitSelector: '#next',
        });
        assert.deepEqual((await app.inject({ method: 'GET', url: `${path}/flow` })).json(), {});
        await turns.wait(nextTurn);
        const flow = (await app.inject({ method: 'GET', url: `${path}/flow` })).json<{
          nextId: string;
        }>();
        assert.equal(flow.nextId, next.url.split('/').at(-1));
        const nextPath = `/api/credential-requests/${flow.nextId}`;
        assert.equal((await get(nextPath)).origin, currentOrigin);
        await focus();
        await settle(() => Boolean(view.document.querySelector('input[name="username"]')));
        assert.equal(view.document.querySelector('input[name="password"]'), null);
        assert.equal(window.location.search, '?conversation=synthetic');

        const stale = await app.inject({
          method: 'POST',
          url: path,
          payload: { username: 'synthetic@example.test' },
        });
        assert.equal(stale.statusCode, 409);
        assert.equal(entered.length, 0);
        view.document.querySelector<HTMLInputElement>('input[name="username"]')!.value =
          'synthetic@example.test';
        await act(async () =>
          view.document
            .querySelector('form')!
            .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
        );
        await settle(
          () =>
            resumed === 2 &&
            entered.length === 1 &&
            view.document.querySelector('.credential-card')?.getAttribute('aria-busy') === 'false',
        );
        assert.equal(entered.length, 1);
        const passwordTurn = await turns.resume(nextTurn);
        const password = await vault.request(passwordTurn, 'local-development', {
          origin: currentOrigin,
          label: 'Identity',
          kind: 'password',
          passwordSelector: '#password',
          submitSelector: '#continue',
        });
        await turns.wait(passwordTurn);
        await focus();
        await settle(() => Boolean(view.document.querySelector('input[name="password"]')));
        assert.equal(
          view.document.querySelector<HTMLInputElement>('input[name="password"]')!.value,
          '',
        );
        assert.equal(
          view.document.querySelector<HTMLInputElement>('input[name="username"]')!.value,
          'synthetic@example.test',
        );
        assert.equal(
          (await app.inject({ method: 'GET', url: `${path}/flow` })).json().nextId,
          password.url.split('/').at(-1),
        );
        view.document.querySelector<HTMLInputElement>('input[name="password"]')!.value =
          'synthetic-flow-password';
        await act(async () =>
          view.document
            .querySelector('form')!
            .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
        );
        await settle(
          () =>
            resumed === 3 &&
            entered.length === 2 &&
            view.document.querySelector('.credential-card')?.getAttribute('aria-busy') === 'false',
        );
        const codeTurn = await turns.resume(passwordTurn);
        const code = await vault.request(codeTurn, 'local-development', {
          origin: currentOrigin,
          label: 'Identity',
          kind: 'otp',
          passwordSelector: '#code',
          submitSelector: '#verify',
        });
        await turns.wait(codeTurn);
        await focus();
        await settle(() => Boolean(view.document.querySelector('input[name="code"]')));
        view.document.querySelector<HTMLInputElement>('input[name="code"]')!.value = '732814';
        await view.render(createElement('div'));
        const closedRequests = clientRequests;
        await focus();
        await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
        assert.equal(clientRequests, closedRequests);
        await view.render(createElement(Credentials, { id: initial.id, embedded: true }));
        await settle(() => Boolean(view.document.querySelector('input[name="code"]')));
        assert.equal(
          view.document.querySelector<HTMLInputElement>('input[name="code"]')!.value,
          '',
        );
        assert.equal(window.location.search, '?conversation=synthetic');
        assert.equal(window.localStorage.length, 0);
        assert.equal(window.sessionStorage.length, 0);
        await view.close();
        viewOpen = false;

        assert.equal(
          (await app.inject({ method: 'GET', url: `${path}/flow` })).json().nextId,
          code.url.split('/').at(-1),
        );
        const restarted = await createVault(pool, options);
        const reopened = Fastify();
        restarted.registerRoutes(reopened);
        assert.equal(
          (await reopened.inject({ method: 'GET', url: `${path}/flow` })).json().nextId,
          code.url.split('/').at(-1),
        );
        await reopened.close();
        await pool.query(
          'UPDATE credential_requests SET owner_id=$1 WHERE token_hash=(SELECT token_hash FROM credential_requests WHERE kind=$2 LIMIT 1)',
          ['another-owner', 'otp'],
        );
        assert.deepEqual((await app.inject({ method: 'GET', url: `${path}/flow` })).json(), {});
        await pool.query(
          "UPDATE credential_requests SET owner_id='local-development' WHERE kind='otp'",
        );
        await pool.query('UPDATE credential_requests SET browser_id=$1 WHERE kind=$2', [
          randomUUID(),
          'otp',
        ]);
        assert.deepEqual((await app.inject({ method: 'GET', url: `${path}/flow` })).json(), {});
      });
  },
);
