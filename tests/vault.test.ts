import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { openVaultValue, sealVaultValue } from '../src/server/vault-crypto.ts';
import { securityCodeIn } from '../src/shared/verification-code.ts';
import test from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { runProcess } from '../src/providers/process.ts';
import { Trust } from '../src/web/pages/trust.tsx';
import { pageDataCache } from '../src/web/lib/page-data-cache.ts';
import { Composio } from '@composio/core';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import type { CredentialKind } from '../src/ports/computer.ts';
import type { IntegrationProvider, VerificationEmail } from '../src/ports/integrations.ts';
import { readVerificationEmails } from '../src/providers/composio/verification-email.ts';
import { registerLocalAccess } from '../src/server/access.ts';
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
      keyStore: { id: 'fixture', configured: true, getKey: async () => fixtureKey },
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
      const form = await app.inject({ url });
      assert.equal(form.statusCode, 200);
      assert.equal(form.headers['cache-control'], 'no-store');
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
    const { turn, wait } = await seedTurns(pool);
    const otpTask = await turn();
    let calls = 0;
    const resumed: string[] = [];
    const vault = await createVault(pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => fixtureKey },
      retry: async () => {},
      inject: async (input) => {
        calls++;
        if (calls === 1) throw new Error(`Provider leaked ${input.code}`);
      },
      resume: async (turnId) => {
        resumed.push(turnId);
      },
    });
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
          assert.equal((await choose(passwordUrl, disposable.id)).json().ok, false);
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
      cookie: 'otto-access-4310=synthetic-local-access',
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

      await t.test('Otto never keeps a security code, even one saved before', async () => {
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
        const binding = ['otto-vault-card-v1', owner, saved.id];
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
      cookie: 'otto-access-4310=synthetic-local-access',
    };
    const start = async (getKey: () => Promise<Buffer> = async () => key) => {
      const instance = Fastify({ logger: false });
      registerLocalAccess(instance, 4310, { key: 'synthetic-local-access' });
      const vault = await createVault(pool, {
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
          assert.deepEqual(imported.json(), { imported: 2, existing: 2, skipped: 3 });
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
      cookie: 'otto-access-4310=synthetic-local-access',
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
      let inOtto = true;
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
            if (event.event === 'otto_secure_entry_changed')
              secureEntries.push(event.properties.status);
          },
          uses: vault.uses,
          inOtto: async () => inOtto,
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
      assert.equal(presentations.at(-1)!.input.requires, 'security_code');
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

      inOtto = false;
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
      const beforeLink = fills.length;
      const replies = await Promise.all([
        app.inject({ method: 'POST', url: securePath, headers, payload: { code: '737' } }),
        app.inject({ method: 'POST', url: securePath, headers, payload: { code: '737' } }),
      ]);
      assert.deepEqual(replies.map((response) => response.statusCode).sort(), [200, 409]);
      assert.equal(fills.length, beforeLink + 1);
      assert.equal((await app.inject({ method: 'GET', url: securePath, headers })).statusCode, 409);
      assert.equal('securityCode' in (await vault.paymentCard(card.id)), false);
      inOtto = true;

      await save('Travel card', '5555 5555 5555 4444');
      await assert.rejects(payments.request(turn, order));
      await payments.request(turn, { ...order, card: 'travel' });
      assert.equal((presentations.at(-1)!.input.card as { last4: string }).last4, '4444');
      await payments.request(turn, { ...order, card: '4242', amount: '1200', currency: 'JPY' });
      const yen = presentations.at(-1)!.input;
      assert.equal(yen.amountMinor, 1200);
      assert.equal(yen.amount, '1200');
      assert.equal(yen.currency, 'JPY');
      inOtto = false;
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
      createElement(Trust),
      async (path, init) => {
        assert.notEqual(init.method, 'POST');
        if (path === '/api/vault/activity')
          return Response.json({ week: { signIns: 0, held: 0, asked: 0 }, entries: [] });
        if (path === '/api/trust')
          return Response.json({
            week: { things: 0, actions: 0, spentUsd: 0 },
            month: {
              start: new Date().toISOString(),
              days: 31,
              elapsedDays: 1,
              spentUsd: 0,
              forecastUsd: 0,
              daily: [0],
              unpriced: false,
            },
            limit: null,
            taskUsd: 5,
            entries: [],
            next: null,
          });
        assert.ok(['/api/vault', '/api/vault/sessions'].includes(path), path);
        return Response.json([]);
      },
      `http://localhost:4310/trust${query}`,
    );
    try {
      assert.equal(view.document.querySelector('.vault-add-form'), null);
    } finally {
      await view.close();
      pageDataCache.clear();
    }
  }
});

test('analytics routes collapse private paths to known pages', async () => {
  const { analyticsRoute, sanitizedAnalyticsUrl } =
    await import('../src/web/lib/analytics-privacy.ts');
  for (const [path, route] of [
    ['/', '/'],
    ['/you', '/'],
    ['/tasks/', '/tasks'],
    ['/trust?tab=saved#private', '/trust'],
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
    'https://otto.invalid/payments',
  );
});

test('onboarding step events are sent only after the owner opts in on the first step', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://otto.fixture.invalid/onboarding', pretendToBeVisual: true });
for (const name of ['window','document','Node','Element','HTMLElement','HTMLInputElement','HTMLButtonElement','Event','CustomEvent','KeyboardEvent','MouseEvent','MutationObserver','getComputedStyle','sessionStorage']) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : name === 'document' ? dom.window.document : typeof dom.window[name] === 'function' && name[0] === name[0].toLowerCase() ? dom.window[name].bind(dom.window) : dom.window[name] });
Object.defineProperty(globalThis, 'navigator', {configurable:true,value:dom.window.navigator});
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.location = window.location;
globalThis.EventSource = window.EventSource = class { static CLOSED = 2; readyState = 0; close() {} addEventListener() {} };
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
window.fetch = globalThis.fetch = async (url) => {
  const path = new URL(url, window.location.href).pathname;
  if (path === '/api/account/prepare') return Response.json({ ok: true });
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
analytics.captureAnalytics('otto_onboarding_step_viewed', { step: 'synthetic-private-step', direction: 'forward' });
analytics.captureAnalytics('otto_onboarding_recap', { steps_viewed: ['welcome'] });
analytics.captureAnalytics('otto_settings_viewed', { tab: 'appearance' });
analytics.captureAnalytics('otto_settings_viewed', { tab: 'general' });
assert.deepEqual(captured.map(event => [event.event, event.properties.step, event.properties.direction, event.properties.tab]), [['otto_onboarding_step_viewed', undefined, 'forward', undefined], ['otto_settings_viewed', undefined, undefined, undefined], ['otto_settings_viewed', undefined, undefined, 'general']]);
captured.length = 0;
analytics.configureAnalytics(undefined, 'web');
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Onboarding } = await import('./src/web/pages/onboarding/index.tsx');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root = createRoot(document.getElementById('root'));
let sharing = false;
const render = () => root.render(createElement(Onboarding, {
  user: { id: 'synthetic-owner', name: 'Synthetic', email: null, avatarUrl: null },
  onComplete: async () => {},
  onFeedback() {},
  usageData: sharing,
  onUsageData: async (value) => { sharing = value; analytics.configureAnalytics(value ? enabled : undefined, 'web'); render(); },
}));
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
assert.deepEqual(steps(), [['otto_onboarding_step_viewed', 'brain', 'forward']]);
await act(async () => root.unmount());
captured.length = 0;
sessionStorage.setItem('otto.onboarding.step', JSON.stringify({ owner: 'synthetic-owner', step: 'open', version: 2 }));
root = createRoot(document.getElementById('root'));
await act(async () => render());
for (let attempt = 0; attempt < 80 && !button('Back'); attempt++) await settle();
await act(async () => button('Back').click());
for (let attempt = 0; attempt < 80 && !button('Skip for now'); attempt++) await settle();
await act(async () => button('Skip for now').click());
await settle();
assert.deepEqual(steps(), [['otto_onboarding_step_viewed', 'open_source', 'forward'], ['otto_onboarding_step_viewed', 'telegram', 'back'], ['otto_onboarding_step_skipped', 'telegram', undefined], ['otto_onboarding_step_viewed', 'open_source', 'forward']]);
assert.equal(captured.some(event => event.event === 'otto_onboarding_recap'), false);
await act(async () => root.unmount());
sessionStorage.setItem('otto.onboarding.step', JSON.stringify({ owner: 'synthetic-owner', step: 'open', version: 1 }));
root = createRoot(document.getElementById('root'));
await act(async () => render());
for (let attempt = 0; attempt < 80 && !button('Let’s go'); attempt++) await settle();
assert.ok(document.querySelector('[role=switch]'));
await act(async () => root.unmount());
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
const dom = new JSDOM('<!doctype html><html data-theme="dark" data-desktop="true"><head><title>synthetic-private-title</title><style>.visible { color: red }</style></head><body><nav data-analytics-public>Settings</nav><div class="visible">synthetic-private-chat</div><div class="message-text"><span data-analytics-public>synthetic-private-markup</span></div><div class="vault-inset-value">synthetic-private-vault</div><input value="synthetic-private-input"><input type="hidden" value="synthetic-private-hidden"><input type="file"><img src="https://private.invalid/synthetic-private-image"><iframe src="https://private.invalid/synthetic-private-frame"></iframe><div id="mutable" title="synthetic-private-tooltip" data-owner="synthetic-private-owner" data-desktop="synthetic-private-layout" style="background-image: url(https://private.invalid/synthetic-private-css)">synthetic-private-name</div><a href="/credentials/synthetic-private-id?token=synthetic-private-token">synthetic-private-link</a><div contenteditable="true">synthetic-private-composer</div></body></html>', { url: 'https://otto.fixture.invalid/credentials/synthetic-private-request?token=synthetic-private-query#synthetic-private-hash', pretendToBeVisual: true });
for (const name of ['window','document','Node','NodeFilter','Element','HTMLElement','HTMLInputElement','HTMLFormElement','HTMLIFrameElement','HTMLImageElement','HTMLLinkElement','HTMLStyleElement','HTMLMediaElement','HTMLVideoElement','HTMLAudioElement','HTMLCanvasElement','SVGElement','Document','DocumentFragment','ShadowRoot','CSSStyleSheet','CSSStyleDeclaration','MutationObserver','Event','CustomEvent']) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : name === 'document' ? dom.window.document : dom.window[name] });
Object.defineProperty(globalThis, 'navigator', {configurable:true,value:dom.window.navigator});
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.location = window.location;
const requests=[];
const integrationStatus = {mode:'own',switchable:true,keyWritable:true,suffix:'K7Q9',managed:null};
window.XMLHttpRequest = undefined;
globalThis.XMLHttpRequest = undefined;
window.fetch = globalThis.fetch = async (url, init={}) => {
  const path = new URL(url,window.location.href).pathname;
  if (path==='/api/configuration') return Response.json({integrationsReady:true});
  if (path==='/api/apps') return Response.json([{slug:'gmail',status:'disconnected'}]);
  if (path==='/api/models') return Response.json({connections:[{id:'synthetic-compatible',provider:'compatible',method:'api_key',label:'synthetic-private-lan-host',status:'connected',managed:false,models:[]}],selection:null,local:true});
  if (path==='/api/integrations/key') {
    assert.equal(init.method ?? 'GET', 'GET');
    return Response.json(integrationStatus);
  }
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
document.body.insertAdjacentHTML('beforeend', '<div class="chat-turn-preview">synthetic-private-turn</div><div class="message-link-previews">synthetic-private-preview</div><a class="message-link-tooltip" href="https://example.org/synthetic-private-tooltip">synthetic-private-tooltip</a><div class="pending-attachments">synthetic-private-pending</div><div class="reply-context composer-reply">synthetic-private-draft-reply</div><p class="statement-summary trust-sentence">synthetic-private-rule</p><span class="vault-use-text">synthetic-private-site</span><span class="vault-item-text">synthetic-private-login</span><span class="compact-account-details">synthetic-private-account</span><aside class="artifact-drawer" style="width: 480px"><h2 title="synthetic-private-file.pdf">synthetic-private-file.pdf</h2><table><td title="synthetic-private-cell">synthetic-private-cell</td></table></aside>');
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
for (const name of ['message-reply-quote','message-attachments','task-preview-title','task-preview-line','task-preview-steps','chat-turn-preview','message-link-previews','message-link-tooltip','pending-attachments','reply-context','trust-sentence','vault-use-text','vault-item-text','compact-account-details','artifact-drawer']) {
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
const changeConnection = emailContainer.querySelector('.ob-email-summary button');
assert.ok(changeConnection);
await act(async () => changeConnection.click());
assert.ok(emailContainer.textContent.includes('K7Q9'));
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
assert.doesNotMatch(JSON.stringify(snapshots), /K7Q9/);
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
