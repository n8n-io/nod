import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Composio } from '@composio/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { JSDOM } from 'jsdom';
import pg from 'pg';
import type { CredentialKind, LoginInspection, LoginTarget } from '../src/ports/computer.ts';
import type { IntegrationProvider, VerificationEmail } from '../src/ports/integrations.ts';
import {
  loginInspectionSchema,
  loginInspectionScript,
} from '../src/providers/agent-browser/login.ts';
import { readVerificationEmails } from '../src/providers/composio/verification-email.ts';
import { registerLocalAccess } from '../src/server/access.ts';
import { verificationCode, verificationSenderDomain } from '../src/server/email-code.ts';
import { createIntegrations } from '../src/server/integrations.ts';
import type { TurnRef } from '../src/server/thread.ts';
import {
  credentialOrigin,
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

async function seedTurns(pool: pg.Pool) {
  await pool.query(
    'CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz)',
  );
  await pool.query(
    "CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text,started_at timestamptz);CREATE TABLE approvals(owner_id text,turn_id uuid,execution_turn_id uuid)",
  );
  const threads = new Map<string, string>();
  const turn = async (owner = 'local-development') => {
    let threadId = threads.get(owner);
    if (!threadId) {
      threadId = randomUUID();
      threads.set(owner, threadId);
      await pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [threadId, owner]);
    }
    const turnId = randomUUID();
    await pool.query('INSERT INTO turns(id,owner_id,thread_id) VALUES($1,$2,$3)', [
      turnId,
      owner,
      threadId,
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
      `INSERT INTO turns(id,owner_id,thread_id,source,source_id,started_at)
       SELECT $1,owner_id,thread_id,'resume',$3,clock_timestamp() FROM turns WHERE id=$2`,
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
    const vault = await createVault(pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => fixtureKey },
      retry: async () => {},
      inject: async (input) => {
        assert.equal(input.origin, 'https://example.com');
        assert.equal(input.password, 'secret-password');
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
      const url = result.url.replace('/vault/', '/api/credential-requests/');
      const form = await app.inject({ url });
      assert.equal(form.statusCode, 200);
      assert.equal(form.headers['cache-control'], 'no-store');
      const first = app.inject({
        method: 'POST',
        url,
        payload: {
          label: 'Fixture login',
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
          payload: { label: 'Fixture login', password: 'second-secret' },
        })
        .finally(() => {
          secondSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(secondSettled, false);
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
            payload: { label: 'Fixture login', password: 'secret-password' },
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
      await vault.fillSaved(task2, 'local-development', stored.rows[0].id, input);
      assert.equal(injected, 2);
      assert.equal(resumed, 1);
      await assert.rejects(
        vault.fillSaved(task2, 'local-development', stored.rows[0].id, input),
        /fresh credentials/,
      );
      await assert.rejects(
        vault.fillSaved(await resume(task1), 'local-development', stored.rows[0].id, input),
        /fresh credentials/,
      );
      assert.equal(injected, 2);
      const requests = await pool.query('SELECT * FROM credential_requests');
      assert.equal(JSON.stringify(requests.rows).includes('secret-password'), false);
      assert.equal(JSON.stringify(requests.rows).includes(result.url.split('/').at(-1)!), false);
      const expired = await vault.request(expiredTask, 'local-development', input);
      await wait(expiredTask);
      await pool.query(
        "UPDATE credential_requests SET expires_at = now() - interval '1 second' WHERE turn_id = $1",
        [expiredTask.turnId],
      );
      const expiredUrl = expired.url.replace('/vault/', '/api/credential-requests/');
      assert.equal((await app.inject({ url: expiredUrl })).json().status, 'expired');
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: expiredUrl,
            payload: { label: 'Fixture login', password: 'expired-secret' },
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
  'OTP failures return safe errors, allow fresh input, and never persist the code',
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
    let resumeAttempts = 0;
    const vault = await createVault(pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => fixtureKey },
      retry: async () => {},
      inject: async (input) => {
        calls++;
        if (calls === 1) throw new Error(`Provider leaked ${input.code}`);
      },
      resume: async () => {
        resumeAttempts++;
        if (resumeAttempts === 1) throw new Error('Queue temporarily unavailable');
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
      const url = request.url.replace('/vault/', '/api/credential-requests/');
      const failed = await app.inject({ method: 'POST', url, payload: { code: '123456' } });
      assert.equal(failed.statusCode, 502);
      assert.equal(failed.body.includes('123456'), false);
      assert.equal((await app.inject({ url })).json().status, 'pending');
      assert.equal(
        (await app.inject({ method: 'POST', url, payload: { code: '789012' } })).statusCode,
        200,
      );
      assert.equal(
        (await pool.query('SELECT * FROM credential_requests WHERE resume_pending = true'))
          .rowCount,
        1,
      );
      await vault.resumePending();
      assert.equal(
        (await pool.query('SELECT * FROM credential_requests WHERE resume_pending = true'))
          .rowCount,
        0,
      );
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
  'failed autofill requires fresh input and pending forms survive a restart',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_vault_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    let app = Fastify();
    const fixtureKey = randomBytes(32);
    const { turn, wait, resume } = await seedTurns(pool);
    const taskRetry = await turn();
    const taskInterrupted = await turn();
    let attempts = 0;
    const options = {
      keyStore: { id: 'fixture', configured: true, getKey: async () => fixtureKey },
      retry: async () => {},
      inject: async () => {
        attempts++;
        if (attempts === 1) throw new Error('Synthetic injection failure');
      },
      resume: async () => {},
    };
    const vault = await createVault(pool, options);
    vault.registerRoutes(app);
    try {
      const saved = await app.inject({
        method: 'POST',
        url: '/api/vault',
        payload: {
          label: 'Example',
          origin: 'https://example.com',
          username: 'person',
          password: 'old-password',
        },
      });
      const input = {
        origin: 'https://example.com',
        label: 'Example',
        kind: 'password' as const,
        passwordSelector: '#password',
      };
      await assert.rejects(vault.fillSaved(taskRetry, 'local-development', saved.json().id, input));
      await assert.rejects(
        vault.fillSaved(taskRetry, 'local-development', saved.json().id, input),
        /fresh credentials/,
      );
      assert.equal(attempts, 1);
      const retry = await vault.request(taskRetry, 'local-development', input);
      await wait(taskRetry);
      const response = await app.inject({
        method: 'POST',
        url: retry.url.replace('/vault/', '/api/credential-requests/'),
        payload: { label: 'Fixture login', username: 'person', password: 'replacement-password' },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(attempts, 2);
      const interrupted = await vault.request(taskInterrupted, 'local-development', input);
      await wait(taskInterrupted);
      await app.close();
      app = Fastify();
      const restarted = await createVault(pool, options);
      restarted.registerRoutes(app);
      const url = interrupted.url.replace('/vault/', '/api/credential-requests/');
      assert.equal((await app.inject({ url })).json().status, 'pending');
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: { label: 'Fixture login', password: 'fresh-after-restart' },
          })
        ).statusCode,
        200,
      );
      assert.equal(attempts, 3);
      await assert.rejects(
        restarted.fillSaved(
          await resume(taskInterrupted),
          'local-development',
          saved.json().id,
          input,
        ),
        /fresh credentials/,
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
    const task2 = await turn();
    const app = Fastify();
    const key = randomBytes(32);
    let injected = 0;
    let keyReads = 0;
    const retried: string[] = [];
    let failInjection = false;
    const vault = await createVault(pool, {
      keyStore: {
        id: 'fixture',
        configured: true,
        getKey: async () => {
          keyReads++;
          return key;
        },
      },
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
      await pool.query(
        "UPDATE credential_requests SET expires_at=now()-interval '1 second' WHERE turn_id=$1",
        [task1.turnId],
      );
      assert.equal((await app.inject({ method: 'POST', url: `${url}/retry` })).statusCode, 200);
      assert.deepEqual(retried, [task1.turnId]);
      assert.equal(injected, 0);
      assert.equal(keyReads, 0);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: { label: 'Fixture login', password: 'stale-secret' },
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
            payload: { label: 'Fixture login', password: 'stale-secret' },
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: freshUrl,
            payload: { label: 'Fixture login', password: 'fresh-secret' },
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
      await assert.rejects(
        vault.fillSaved(await resume(retryTurn), 'local-development', entry.id, input),
        /fresh credentials/,
      );
      const archived = await vault.request(task2, 'local-development', input);
      await wait(task2);
      await archive();
      const archivedUrl = archived.url.replace('/vault/', '/api/credential-requests/');
      assert.equal((await app.inject({ url: archivedUrl })).json().status, 'expired');
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: archivedUrl,
            payload: { label: 'Fixture login', password: 'archived-secret' },
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (await app.inject({ method: 'POST', url: `${archivedUrl}/retry` })).statusCode,
        409,
      );
      await assert.rejects(
        vault.request(task2, 'local-development', input),
        /no longer request credentials/,
      );
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
            payload: { label: 'Fixture login', password: 'failed-secret' },
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

test(
  'an expired credential link restarts the credential step only once',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_vault_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const { turn, wait } = await seedTurns(pool);
    const task = await turn();
    const app = Fastify();
    const retried: string[] = [];
    const vault = await createVault(pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => randomBytes(32) },
      inject: async () => {},
      resume: async () => {},
      retry: async (turnId) => {
        retried.push(turnId);
      },
    });
    vault.registerRoutes(app);
    try {
      const request = await vault.request(task, 'local-development', {
        origin: 'https://example.com',
        label: 'Example',
        kind: 'password',
        passwordSelector: '#password',
      });
      await wait(task);
      const url = request.url.replace('/vault/', '/api/credential-requests/');
      await pool.query(
        "UPDATE credential_requests SET expires_at=now()-interval '1 second' WHERE turn_id=$1",
        [task.turnId],
      );
      const concurrent = await Promise.all([
        app.inject({ method: 'POST', url: `${url}/retry` }),
        app.inject({ method: 'POST', url: `${url}/retry` }),
      ]);
      assert.deepEqual(concurrent.map((result) => result.statusCode).sort(), [200, 409]);
      assert.equal((await app.inject({ method: 'POST', url: `${url}/retry` })).statusCode, 409);
      assert.deepEqual(retried, [task.turnId]);
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
  });
  const seeded = await seedTurns(pool);
  const app = Fastify();
  const calls = { injected: 0, resumed: [] as string[], retried: [] as string[] };
  let hold = Promise.resolve();
  let entered = () => {};
  const vault = await createVault(pool, {
    keyStore: { id: 'fixture', configured: true, getKey: async () => randomBytes(32) },
    inject: async () => {
      calls.injected++;
      entered();
      await hold;
    },
    resume: async (turnId) => {
      calls.resumed.push(turnId);
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
  const link = async (ref: { threadId: string; turnId: string }) =>
    (await vault.request(ref, 'local-development', input)).url.replace(
      '/vault/',
      '/api/credential-requests/',
    );
  const submit = (url: string) =>
    app.inject({
      method: 'POST',
      url,
      payload: { label: 'Fixture login', password: 'fixture-secret' },
    });
  return {
    ...seeded,
    pool,
    app,
    vault,
    calls,
    link,
    submit,
    status: async (url: string) => (await app.inject({ url })).json().status,
    holdInjection: () => {
      let release = () => {};
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      return { release, started };
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
  'credential links work only while their turn waits for credentials and no later turn started',
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
        assert.equal(
          (await f.app.inject({ method: 'POST', url: `${url}/refresh` })).statusCode,
          409,
        );
      }
      await f.wait(running);
      assert.equal(await f.status(url), 'pending');

      const later = await f.turn();
      await f.pool.query('UPDATE turns SET started_at=clock_timestamp() WHERE id=$1', [
        later.turnId,
      ]);
      assert.equal(await f.status(url), 'expired');
      assert.equal((await f.submit(url)).statusCode, 409);
      assert.equal((await f.app.inject({ method: 'POST', url: `${url}/refresh` })).statusCode, 409);
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
      await f.pool.query(
        "UPDATE credential_requests SET expires_at=now()-interval '1 second',resume_pending=true WHERE turn_id=$1",
        [running.turnId],
      );
      assert.equal((await f.app.inject({ method: 'POST', url: `${url}/retry` })).statusCode, 409);
      await f.vault.resumePending();
      assert.deepEqual(f.calls, { injected: 0, resumed: [], retried: [] });
      assert.equal(
        (await f.pool.query('SELECT 1 FROM credential_requests WHERE resume_pending')).rowCount,
        0,
      );

      await f.pool.query('UPDATE turns SET started_at=NULL WHERE id=$1', [later.turnId]);
      await f.pool.query(
        "UPDATE credential_requests SET expires_at=now()+interval '5 minutes' WHERE turn_id=$1",
        [running.turnId],
      );
      assert.equal((await f.submit(url)).statusCode, 200);
      assert.deepEqual(f.calls, { injected: 1, resumed: [running.turnId], retried: [] });
    } finally {
      await f.close();
    }
  },
);

test(
  'credential submission and creation serialize on the thread lock',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const f = await vaultFixture();
    try {
      const waiting = await f.turn();
      const url = await f.link(waiting);
      await f.wait(waiting);
      const next = await f.turn();
      const gate = f.holdInjection();
      const submitted = f.submit(url);
      await gate.started;
      let created = false;
      const creating = f.link(next).then((value) => {
        created = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(created, false);
      gate.release();
      assert.equal((await submitted).statusCode, 200);
      const nextUrl = await creating;
      assert.deepEqual(
        (
          await f.pool.query('SELECT turn_id,status FROM credential_requests ORDER BY turn_id=$1', [
            next.turnId,
          ])
        ).rows,
        [
          { turn_id: waiting.turnId, status: 'filled' },
          { turn_id: next.turnId, status: 'pending' },
        ],
      );
      await f.wait(next);
      assert.equal(await f.status(nextUrl), 'pending');
      assert.equal(await f.status(url), 'filled');
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
      "CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text,started_at timestamptz);CREATE TABLE approvals(owner_id text,turn_id uuid,execution_turn_id uuid)",
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
        'INSERT INTO turns(id,owner_id,thread_id,source,source_id) VALUES($1,$2,$3,$4,$5)',
        [
          turnId,
          owner,
          threadId,
          resumeOf ? 'resume' : 'user',
          resumeOf ? `credentials:${resumeOf}` : null,
        ],
      );
      return { threadId, turnId };
    };
    const task = (name: string) => tasks.get(name)!;
    const key = randomBytes(32);
    const stages = new Map<string, CredentialKind>();
    const injections: CredentialInjection[] = [];
    const resumed: string[] = [];
    let reject = false;
    let app = Fastify();
    const options = {
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      inspect: async (threadId: string): Promise<LoginInspection> => ({
        origin: 'https://example.com',
        url: 'https://example.com/login',
        fields: [
          { kind: stages.get(threadId) ?? 'identifier', selector: '#login', label: 'Login' },
        ],
        methods: [{ id: 'credentials', kind: 'credentials', label: 'Login', supported: true }],
      }),
      inject: async (input: CredentialInjection) => {
        injections.push(input);
        if (reject) return { status: 'rejected' as const };
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
              (await describe(url)).savedEntries?.map((entry) => entry.id).sort(),
              [first.id, second.id].sort(),
            );
            const before = injections.length;
            const result = await choose(url, id);
            assert.equal(result.statusCode, 200);
            assert.equal(result.json().ok, false);
            assert.match(result.json().error, /no longer available/);
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
            'same-first@example.test',
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
        'rejected saved details return a fresh named-entry form and never overwrite the saved account',
        async () => {
          await addTask('rejected', 'password');
          const url = await form('rejected');
          const expiresAt = (await describe(url)).expiresAt;
          const beforeCount = (await vault.list()).length;
          reject = true;
          const response = await choose(url, second.id);
          reject = false;
          assert.equal(response.json().ok, false);
          assert.equal(resumed.includes('rejected'), false);
          const retryUrl = response.json().retryUrl.replace('/vault/', '/api/credential-requests/');
          const retried = await describe(retryUrl);
          assert.equal(retried.expiresAt, expiresAt);
          assert.deepEqual(retried.savedEntries, []);
          assert.equal(
            await vault.fillSelected(task('rejected'), 'local-development', input('password')),
            false,
          );
          const injected = injections.length;
          const missingName = await app.inject({
            method: 'POST',
            url: retryUrl,
            payload: { password: 'replacement-password' },
          });
          assert.equal(missingName.statusCode, 400);
          assert.equal(injections.length, injected);
          const corrected = await app.inject({
            method: 'POST',
            url: retryUrl,
            payload: { label: 'Work replacement', password: 'replacement-password' },
          });
          assert.equal(corrected.statusCode, 200);
          assert.equal((await vault.list()).length, beforeCount + 1);
          assert.equal((await vault.list()).find((entry) => entry.id === second.id)?.label, 'Work');
          assert.ok((await vault.list()).find((entry) => entry.label === 'Work replacement'));
          const stored = (
            await pool.query('SELECT * FROM vault_entries WHERE label=$1', ['Work replacement'])
          ).rows[0];
          assert.equal(stored.origin, 'https://example.com');
          assert.doesNotMatch(JSON.stringify(stored), /replacement-password|same-second/);
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
          for (const state of ['expired', 'archived']) {
            await addTask(state);
            const url = await form(state);
            if (state === 'expired')
              await pool.query(
                "UPDATE credential_requests SET expires_at=now()-interval '1 second' WHERE turn_id=$1",
                [task(state).turnId],
              );
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

async function seedNamedTurns(pool: pg.Pool, names: string[], owner = 'local-development') {
  await pool.query(
    'CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz)',
  );
  await pool.query(
    "CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text,started_at timestamptz,finished_at timestamptz);CREATE TABLE approvals(owner_id text,turn_id uuid,execution_turn_id uuid)",
  );
  const threadId = randomUUID();
  await pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [threadId, owner]);
  const turns: Record<string, TurnRef> = {};
  for (const name of names) {
    const turnId = randomUUID();
    await pool.query('INSERT INTO turns(id,owner_id,thread_id) VALUES($1,$2,$3)', [
      turnId,
      owner,
      threadId,
    ]);
    turns[name] = { threadId, turnId };
  }
  return turns;
}

test(
  'Vault preserves model-selected page fields across restart and rejects replaced targets',
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
    let replaceDuringLookup = false;
    let lookups = 0;
    let app = Fastify();
    let dom: JSDOM;
    const page = () => {
      dom?.window.close();
      dom = new JSDOM(
        '<form><label>利用者<input id="handle" autocomplete="one-time-code"></label><label>秘密<input id="entry" type="password"></label><label>確認<input id="pin" maxlength="6"></label><p>送信先 owner@example.test</p><input id="unrelated-password" type="password"><input id="unrelated-email" type="email"><button>進む</button></form>',
        { url: `${origin}/login`, runScripts: 'outside-only' },
      );
      dom.window.HTMLElement.prototype.getClientRects = () =>
        [{ x: 0, y: 0, width: 200, height: 30 }] as unknown as DOMRectList;
    };
    const options = {
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      inspect: async (_threadId: string, target?: LoginTarget) =>
        loginInspectionSchema.parse(dom.window.eval(loginInspectionScript(target))),
      inject: async (input: CredentialInjection) => {
        injections.push(input);
        return { status: 'submitted' as const };
      },
      emailCode: async (request: { recipient: string; origin: string; length?: number }) => {
        lookups++;
        assert.equal(request.recipient, 'owner@example.test');
        assert.equal(request.origin, origin);
        assert.equal(request.length, 6);
        if (replaceDuringLookup) {
          const target = dom.window.document.querySelector('#pin')!;
          target.replaceWith(target.cloneNode());
        }
        return { code: '001234', current: async () => true };
      },
      retry: async () => {},
      resume: async () => {},
    };
    let vault = await createVault(pool, options);
    vault.registerRoutes(app);
    const stored = async (turnId: string) =>
      (
        await pool.query(
          'SELECT id,selectors,inspection FROM credential_requests WHERE turn_id=$1',
          [turnId],
        )
      ).rows[0];
    try {
      for (const kind of ['identifier', 'password', 'otp'] as const) {
        await t.test(`${kind} uses the selected field and rehydrates its binding`, async () => {
          page();
          const turn = await turns.turn();
          const raw = {
            origin,
            label: 'Synthetic sign-in',
            kind,
            ...(kind === 'identifier' || kind === 'password'
              ? { usernameSelector: '#handle' }
              : {}),
            ...(kind !== 'identifier'
              ? { passwordSelector: kind === 'otp' ? '#pin' : '#entry' }
              : {}),
            ...(kind === 'otp' ? { emailCode: true } : {}),
          };
          const request = await vault.request(turn, 'local-development', raw);
          await turns.wait(turn);
          const before = await stored(turn.turnId);
          const selectedKey = kind === 'identifier' ? 'usernameSelector' : 'passwordSelector';
          assert.notEqual(before.selectors[selectedKey], raw[selectedKey]);
          assert.equal(
            dom.window.document.querySelector(before.selectors[selectedKey]),
            dom.window.document.querySelector(raw[selectedKey]!),
          );
          if (kind === 'password')
            assert.equal(
              dom.window.document.querySelector(before.selectors.usernameSelector),
              dom.window.document.querySelector('#handle'),
            );
          assert.equal(JSON.stringify(before.inspection).includes('owner@example.test'), false);
          await app.close();
          app = Fastify();
          vault = await createVault(pool, options);
          vault.registerRoutes(app);
          const url = request.url.replace('/vault/', '/api/credential-requests/');
          const refreshed = await app.inject({ method: 'POST', url: `${url}/refresh` });
          assert.equal(refreshed.statusCode, 200, refreshed.body);
          assert.deepEqual((await stored(turn.turnId)).selectors, before.selectors);
          if (kind === 'otp') {
            assert.equal(before.selectors.emailCode, true);
            assert.deepEqual(
              await vault.submitChatCode('local-development', turn.turnId, '001234', before.id),
              { status: 'submitted' },
            );
          } else {
            const response = await app.inject({
              method: 'POST',
              url,
              payload: {
                username: 'synthetic-member',
                ...(kind === 'password'
                  ? { label: 'Fixture login', password: 'synthetic-password' }
                  : {}),
              },
            });
            assert.equal(response.statusCode, 200, response.body);
          }
          assert.equal(injections.at(-1)?.kind, kind);
          assert.equal(injections.at(-1)?.[selectedKey], before.selectors[selectedKey]);
          assert.equal(
            dom.window.document.querySelector<HTMLInputElement>('#unrelated-password')!.value,
            '',
          );
        });
      }
      for (const mutation of ['replace', 'hide', 'disable', 'origin'] as const) {
        await t.test(`${mutation} prevents refresh and private submission`, async () => {
          page();
          const turn = await turns.turn();
          const request = await vault.request(turn, 'local-development', {
            origin,
            label: 'Synthetic sign-in',
            kind: 'password',
            passwordSelector: '#entry',
          });
          await turns.wait(turn);
          const target = dom.window.document.querySelector<HTMLInputElement>('#entry')!;
          if (mutation === 'replace') target.replaceWith(target.cloneNode());
          if (mutation === 'hide') target.hidden = true;
          if (mutation === 'disable') target.disabled = true;
          if (mutation === 'origin') dom.reconfigure({ url: 'https://other.example.test/login' });
          const count = injections.length;
          const url = request.url.replace('/vault/', '/api/credential-requests/');
          assert.equal(
            (await app.inject({ method: 'POST', url: `${url}/refresh` })).statusCode,
            409,
          );
          assert.equal(
            (
              await app.inject({
                method: 'POST',
                url,
                payload: { label: 'Fixture', password: 'synthetic-password' },
              })
            ).statusCode,
            409,
          );
          assert.equal(injections.length, count);
        });
      }
      await t.test(
        'missing, ambiguous and overlapping field selections never request credentials',
        async () => {
          page();
          const turn = await turns.turn();
          const before = injections.length;
          for (const selectors of [
            {},
            { passwordSelector: '#missing' },
            { passwordSelector: '#entry,#unrelated-password' },
            { usernameSelector: '#entry', passwordSelector: '#entry' },
          ]) {
            await assert.rejects(
              vault.request(turn, 'local-development', {
                origin,
                label: 'Synthetic sign-in',
                kind: 'password',
                ...selectors,
              }),
              /login field changed|visible sign-in field/,
            );
          }
          assert.equal(await stored(turn.turnId), undefined);
          assert.equal(injections.length, before);
        },
      );
      for (const replaced of [false, true]) {
        await t.test(
          `email lookup revalidates the selected node after lookup: ${replaced}`,
          async () => {
            page();
            replaceDuringLookup = replaced;
            const turn = await turns.turn();
            await pool.query('UPDATE turns SET started_at=clock_timestamp() WHERE id=$1', [
              turn.turnId,
            ]);
            const before = injections.length;
            const reads = lookups;
            assert.equal(
              await vault.fillEmailCode(turn, 'local-development', {
                origin,
                label: 'Synthetic verification',
                kind: 'otp',
                passwordSelector: '#pin',
                emailCode: true,
              }),
              !replaced,
            );
            assert.equal(lookups, reads + 1);
            assert.equal(injections.length, before + (replaced ? 0 : 1));
          },
        );
      }
    } finally {
      dom!.window.close();
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'Vault rejects a freshly blocked browser before creating, refreshing or filling a sign-in step',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_browser_block_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify();
    let blocked = false;
    let injections = 0;
    let resumes = 0;
    const origin = 'https://accounts.example.com';
    const input = { origin, label: 'Synthetic sign-in', kind: 'password' as const };
    try {
      const turns = await seedNamedTurns(pool, ['new', 'refresh', 'submit', 'saved']);
      const key = randomBytes(32);
      const vault = await createVault(pool, {
        keyStore: { id: 'fixture', configured: true, getKey: async () => key },
        inspect: async (): Promise<LoginInspection> => ({
          origin,
          url: `${origin}/login`,
          ...(blocked ? { issue: 'browser_not_supported' as const } : {}),
          fields: [
            { kind: 'identifier', selector: '#username', label: 'Username' },
            { kind: 'password', selector: '#password', label: 'Password' },
          ],
          methods: [
            {
              id: 'credentials',
              kind: 'credentials',
              label: 'Secure form',
              supported: true,
            },
            { id: 'oauth-google', kind: 'oauth', label: 'Google', supported: true },
          ],
        }),
        inject: async () => {
          injections++;
        },
        retry: async () => {},
        resume: async () => {
          resumes++;
        },
      });
      vault.registerRoutes(app);
      const saved = await app.inject({
        method: 'POST',
        url: '/api/vault',
        payload: {
          label: 'Synthetic',
          origin,
          username: 'synthetic@example.com',
          password: 'fixture-password',
        },
      });
      assert.equal(saved.statusCode, 200);
      blocked = true;
      const isBlocked = (error: unknown) => {
        assert.equal((error as { statusCode: number }).statusCode, 409);
        assert.match((error as Error).message, /blocked sign-in/);
        return true;
      };
      await assert.rejects(vault.request(turns.new, 'local-development', input), isBlocked);
      await assert.rejects(
        vault.fillSaved(turns.saved, 'local-development', saved.json().id, input),
        isBlocked,
      );
      for (const [id, suffix, payload] of [
        ['refresh', '/refresh', {}],
        ['submit', '', { password: 'fixture-password' }],
      ] as const) {
        blocked = false;
        const request = await vault.request(turns[id], 'local-development', input);
        await pool.query(
          "UPDATE turns SET status='waiting',waiting_reason='credentials',started_at=coalesce(started_at,clock_timestamp()),finished_at=clock_timestamp() WHERE id=$1",
          [turns[id].turnId],
        );
        blocked = true;
        const response = await app.inject({
          method: 'POST',
          url: `${request.url.replace('/vault/', '/api/credential-requests/')}${suffix}`,
          payload,
        });
        assert.equal(response.statusCode, 409);
        assert.match(response.json().error, /blocked sign-in/);
      }
      assert.equal(injections, 0);
      assert.equal(resumes, 0);
      assert.equal(
        (await pool.query('SELECT 1 FROM credential_requests WHERE turn_id=$1', [turns.new.turnId]))
          .rowCount,
        0,
      );
      assert.equal(
        (await pool.query("SELECT 1 FROM credential_requests WHERE status='filled'")).rowCount,
        0,
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
    const headers = { host: 'localhost:4310', origin: 'http://localhost:4310' };
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
      CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text,started_at timestamptz,finished_at timestamptz);
      CREATE TABLE approvals(owner_id text,turn_id uuid,execution_turn_id uuid);
      CREATE TABLE vault_entries(id text PRIMARY KEY,owner_id text NOT NULL,label text NOT NULL,origin text NOT NULL,username_hint text NOT NULL,ciphertext text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),identifier_label text NOT NULL DEFAULT '');
    `);
    const login = { id: randomUUID(), owner_id: owner, origin: 'https://login.example.test' };
    const legacyCiphertext = sealCredential(key, login, {
      username: 'full-username@example.test',
      password: 'legacy-synthetic-password',
    });
    await pool.query(
      'INSERT INTO vault_entries(id,owner_id,label,origin,username_hint,ciphertext) VALUES($1,$2,$3,$4,$5,$6)',
      [login.id, owner, 'Legacy login', login.origin, 'fu…', legacyCiphertext],
    );
    const start = async (getKey: () => Promise<Buffer> = async () => key) => {
      const app = Fastify({ logger: false });
      registerLocalAccess(app, 4310);
      const vault = await createVault(pool, {
        keyStore: { id: 'synthetic', configured: true, getKey },
        inject: async () => assert.fail('Cards must never enter a website login.'),
        resume: async () => assert.fail('Card management must not resume a task.'),
        retry: async () => assert.fail('Card management must not retry a task.'),
      });
      vault.registerRoutes(app);
      return { app, vault };
    };
    let { app, vault } = await start();
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
          assert.equal(requested.invitation.savedLoginAvailable, false);
          await assert.rejects(
            vault.fillSaved(turn, owner, first.id, {
              origin: 'https://cards.example.test',
              label: 'Login',
              kind: 'password',
              passwordSelector: '#password',
            }),
            /No saved password/,
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
        assert.equal((await read(foreign.id, 'security-code')).statusCode, 404);
        assert.equal((await update(foreign.id, input)).statusCode, 404);
        const transplanted = await create({ ...input, label: 'Transplanted card' });
        await pool.query(
          'UPDATE vault_cards SET ciphertext=(SELECT ciphertext FROM vault_cards WHERE id=$2) WHERE id=$1',
          [transplanted.id, first.id],
        );
        for (const result of [
          await read(transplanted.id, 'card-number'),
          await read(transplanted.id, 'security-code'),
          await update(transplanted.id, input),
        ]) {
          assert.equal(result.statusCode, 500);
          assert.deepEqual(result.json(), { error: 'This saved card could not be opened.' });
        }
        await app.inject({ method: 'DELETE', url: `/api/vault/${foreign.id}`, headers });
        assert.equal(
          (await pool.query('SELECT id FROM vault_cards WHERE id=$1', [foreign.id])).rowCount,
          1,
        );
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
      "CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running');CREATE TABLE approvals(owner_id text,turn_id uuid,execution_turn_id uuid)",
    );
    const key = randomBytes(32);
    const headers = { host: 'localhost:4310', origin: 'http://localhost:4310' };
    const start = async (getKey: () => Promise<Buffer> = async () => key) => {
      const instance = Fastify({ logger: false });
      registerLocalAccess(instance, 4310);
      const vault = await createVault(pool, {
        keyStore: { id: 'fixture', configured: true, getKey },
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
    const save = async (label: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/vault',
        headers,
        payload: {
          label,
          origin: 'https://accounts.example.test:8443',
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
              assert.deepEqual(response.json(), { error: 'This saved login could not be found.' });
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
        'rename and username changes preserve the blank or omitted password and other accounts',
        async () => {
          for (const password of [undefined, '']) {
            const response = await patch(first.id, {
              label: ' Renamed work login ',
              username: 'new-user@example.test',
              ...(password === undefined ? {} : { password }),
            });
            assert.equal(response.statusCode, 200);
            assert.equal(response.json().id, first.id);
            assert.equal(response.json().origin, first.origin);
            assert.doesNotMatch(response.body, /new-user@example|First-secret|ciphertext|owner_id/);
            assert.equal(
              (await read(first.id, 'details')).json().username,
              'new-user@example.test',
            );
            assert.equal((await read(first.id, 'password')).json().password, 'First-secret');
          }
          assert.equal((await read(second.id, 'password')).json().password, 'Second-secret');
          const list = await app.inject({ url: '/api/vault', headers });
          assert.equal(list.json().length, 2);
          assert.doesNotMatch(list.body, /First-secret|Second-secret/);
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
        'edit key access races recheck ownership and preserve the latest password',
        async () => {
          for (const change of ['password', 'owner', 'delete']) {
            const entry = await save(`Race-${change}`);
            const held = await holdKey();
            const pending = patch(entry.id, {
              label: 'Race updated',
              username: 'edited-user',
              password: '',
            }).then((value) => value);
            await held.reached;
            if (change === 'password')
              await pool.query('UPDATE vault_entries SET ciphertext=$2 WHERE id=$1', [
                entry.id,
                sealCredential(
                  key,
                  { id: entry.id, owner_id: 'local-development', origin: entry.origin },
                  { username: 'concurrent-user', password: 'latest-password' },
                ),
              ]);
            else if (change === 'owner')
              await pool.query('UPDATE vault_entries SET owner_id=$2 WHERE id=$1', [
                entry.id,
                'other-owner',
              ]);
            else await pool.query('DELETE FROM vault_entries WHERE id=$1', [entry.id]);
            held.release();
            const response = await pending;
            assert.equal(response.statusCode, change === 'password' ? 200 : 404);
            if (change === 'password') {
              assert.equal((await read(entry.id, 'password')).json().password, 'latest-password');
              assert.equal((await read(entry.id, 'details')).json().username, 'edited-user');
            }
          }
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
    let app = Fastify();
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await pool.query(
        'CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz)',
      );
      await pool.query(
        "CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text,started_at timestamptz);CREATE TABLE approvals(owner_id text,turn_id uuid,execution_turn_id uuid)",
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
          "INSERT INTO turns(id,owner_id,thread_id,source,source_id,started_at) VALUES($1,'local-development',$2,$3,$4,clock_timestamp())",
          [
            turnId,
            threadId,
            resumeOf ? 'resume' : 'user',
            resumeOf ? `credentials:${resumeOf}` : null,
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
      let rejected = false;
      let unavailable = false;
      const options = {
        keyStore: { id: 'fixture', configured: true, getKey: async () => key },
        inspect: async (id: string): Promise<LoginInspection> => ({
          origin: observedOrigin,
          url: observedOrigin + '/login',
          fields: [{ kind: stages.get(id) ?? 'identifier', selector: '#observed', label: 'Email' }],
          methods: [{ id: 'credentials', kind: 'credentials', label: 'Sign in', supported: true }],
        }),
        inject: async (input: CredentialInjection) => {
          injections.push(input);
          if (unavailable && input.kind === 'password') throw new Error('Synthetic unavailable');
          if (rejected && input.kind === 'password') return { status: 'rejected' as const };
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
      let vault = await createVault(pool, options);
      vault.registerRoutes(app);
      const requestInput = (kind: CredentialKind) => ({ origin, label: 'Website login', kind });
      const wait = (turn: TurnRef) =>
        pool.query("UPDATE turns SET status='waiting',waiting_reason='credentials' WHERE id=$1", [
          turn.turnId,
        ]);
      const begin = async (id: string) => {
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
          payload: {
            label: 'My Google account',
            username: 'synthetic@example.test',
            password: 'one-form-synthetic-password',
          },
        });
        assert.equal(submitted.statusCode, 200);
        assert.equal(submitted.json().ok, true);
        assert.equal(injections.at(-1)?.kind, 'identifier');
        assert.equal(injections.at(-1)?.password, undefined);
        return url;
      };

      await t.test(
        'a rejected held password is consumed without saving or trying it twice',
        async () => {
          await begin('rejected');
          const before = (await pool.query('SELECT * FROM vault_entries')).rowCount;
          const beforeInjections = injections.length;
          rejected = true;
          assert.equal(
            await vault.fillSelected(
              task('rejected'),
              'local-development',
              requestInput('password'),
            ),
            false,
          );
          assert.equal((await pool.query('SELECT * FROM vault_entries')).rowCount, before);
          assert.equal(injections.length, beforeInjections + 1);
          assert.equal(injections.at(-1)?.kind, 'password');
          const selected = (
            await pool.query('SELECT * FROM credential_account_selections WHERE root_turn_id=$1', [
              roots.get('rejected'),
            ])
          ).rows[0];
          assert.equal(selected.blocked, true);
          assert.equal(openCredential(key, selected).password, '');
          const count = injections.length;
          assert.equal(
            await vault.fillSelected(
              task('rejected'),
              'local-development',
              requestInput('password'),
            ),
            false,
          );
          assert.equal(injections.length, count);
          rejected = false;
          await begin('rejected');
          assert.equal(
            await vault.fillSelected(
              task('rejected'),
              'local-development',
              requestInput('password'),
            ),
            true,
          );
          assert.equal(
            (await pool.query('SELECT * FROM vault_entries')).rowCount,
            (before ?? 0) + 1,
          );
        },
      );

      await t.test(
        'an uncertain password attempt clears its held value and is not replayed',
        async () => {
          await begin('interrupted');
          unavailable = true;
          assert.equal(
            await vault.fillSelected(
              task('interrupted'),
              'local-development',
              requestInput('password'),
            ),
            false,
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

      await t.test(
        'held passwords remain bound to owner, origin, running turn and expiry',
        async () => {
          await begin('fences');
          const count = injections.length;
          assert.equal(
            await vault.fillSelected(task('fences'), 'another-owner', requestInput('password')),
            undefined,
          );
          assert.equal(
            await vault.fillSelected(task('fences'), 'local-development', {
              ...requestInput('password'),
              origin: 'https://other.example.test',
            }),
            undefined,
          );
          observedOrigin = 'https://other.example.test';
          assert.equal(
            await vault.fillSelected(task('fences'), 'local-development', requestInput('password')),
            false,
          );
          observedOrigin = origin;
          await pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [
            task('fences').turnId,
          ]);
          assert.equal(
            await vault.fillSelected(task('fences'), 'local-development', requestInput('password')),
            false,
          );
          await pool.query("UPDATE turns SET status='running' WHERE id=$1", [
            task('fences').turnId,
          ]);
          await pool.query(
            "UPDATE credential_account_selections SET expires_at=now()-interval '1 second' WHERE root_turn_id=$1",
            [roots.get('fences')],
          );
          assert.equal(
            await vault.fillSelected(task('fences'), 'local-development', requestInput('password')),
            false,
          );
          assert.equal(injections.length, count);
          await vault.resumePending();
          const expired = (
            await pool.query('SELECT * FROM credential_account_selections WHERE root_turn_id=$1', [
              roots.get('fences'),
            ])
          ).rows[0];
          assert.equal(expired.ciphertext, '');
          assert.equal(expired.blocked, true);
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
  length: 6,
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
    { text: 'Your verification codes are 381742 and 940173.' },
    { text: 'Your receipt number is 381742.' },
    { text: 'Your login code is a381742b.' },
    { text: 'Your login code is 3817429.' },
    { text: 'Your security code is 3817.' },
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

test('Gmail verification uses fixed account-bound read endpoints and validates received MIME headers', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-not-live',
    allowTracking: false,
    disableVersionCheck: true,
  });
  const calls: unknown[] = [];
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
  t.mock.method(
    client.tools,
    'proxyExecute',
    async (
      input: {
        endpoint: string;
        method: string;
        connectedAccountId: string;
        parameters: Array<{ name: string; value: unknown }>;
      },
      options: { signal: AbortSignal },
    ) => {
      calls.push(input);
      assert.equal(input.connectedAccountId, 'owned-account');
      assert.equal(input.method, 'GET');
      assert.equal(options.signal.aborted, false);
      if (input.endpoint.endsWith('/messages')) {
        assert.equal(input.parameters.find((item) => item.name === 'maxResults')?.value, 5);
        assert.equal(
          input.parameters.find((item) => item.name === 'includeSpamTrash')?.value,
          'false',
        );
        assert.match(
          String(input.parameters.find((item) => item.name === 'q')?.value),
          /^to:owner@example.com from:toconline.pt after:\d+ before:\d+$/,
        );
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
    },
  );
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
  assert.equal(calls.length, 2);
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
  body = '<p>Your verification code is <b>381742</b>.</p><script>security code 930184</script>';
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
  const count = calls.length;
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
  assert.equal(calls.length, count);
});

const owner = 'local-development';
const origin = 'https://app20.toconline.pt';
const username = 'owner@example.com';
const code = '381742';
const input = { origin, label: 'Fixture login', kind: 'password' as const };
const otpInput = { ...input, kind: 'otp' as const, emailCode: true };
function inspection(kind: 'password' | 'otp'): LoginInspection {
  return {
    origin,
    url: `${origin}/login`,
    fields: [{ kind, selector: `#${kind}`, label: kind }],
    methods: [{ id: 'credentials', kind: 'credentials', label: 'Sign in', supported: true }],
    ...(kind === 'otp' ? { emailCode: { recipient: username, length: 6 } } : {}),
  };
}

async function seedCodeTurns(pool: pg.Pool) {
  await pool.query(
    'CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,archived_at timestamptz)',
  );
  await pool.query(
    "CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text,started_at timestamptz);CREATE TABLE approvals(owner_id text,turn_id uuid,execution_turn_id uuid)",
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
      'INSERT INTO turns(id,owner_id,thread_id,source,source_id,started_at) VALUES($1,$2,$3,$4,$5,clock_timestamp())',
      [
        turn.turnId,
        owner,
        turn.threadId,
        resumeOf ? 'resume' : 'user',
        resumeOf ? `credentials:${resumeOf}` : null,
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
    const pages = new Map<string, LoginInspection>();
    const injected: Array<{ threadId: string; code?: string }> = [];
    let read = 0;
    let lookup: (() => Promise<void>) | undefined;
    let available = true;
    let reject = false;
    let injectionFailure = false;
    let resultCode: string | undefined = code;
    let emails: VerificationEmail[] | undefined;
    const currentCode = '492615';
    const vault = await createVault(pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => randomKey },
      inspect: async (id) => pages.get(id)!,
      inject: async (value) => {
        injected.push({ threadId: value.threadId, code: value.code });
        if (injectionFailure && value.kind === 'otp') throw new Error('Uncertain code submission.');
        if (value.kind === 'password') pages.set(value.threadId, inspection('otp'));
        return { status: reject && value.kind === 'otp' ? 'rejected' : 'submitted' };
      },
      resume: turns.resume,
      retry: async () => {},
      emailCode: async (request, signal) => {
        read++;
        assert.equal(request.recipient, username);
        assert.equal(request.origin, origin);
        assert.equal(request.length, 6);
        assert.ok(request.after > Date.now() - 35_000);
        assert.ok(request.before <= Date.now());
        assert.equal(signal.aborted, false);
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
        payload: { ...input, kind: 'login', username, password: 'fixture-private-password' },
      })
    ).json();
    assert.ok(saved.id);
    const page = (id: string) => pages.get(task(id).threadId)!;
    const start = async (id: string, entryId = saved.id) => {
      const turn = await turns.start(id);
      pages.set(turn.threadId, inspection('password'));
      await vault.fillSaved(turn, owner, entryId, input);
      assert.equal(page(id).fields[0]?.kind, 'otp');
    };
    const fill = (id: string) => vault.fillEmailCode(task(id), owner, otpInput);
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
    assert.equal(read, 2);
    for (const [id, change] of [
      [
        'wrong-recipient',
        async (id: string) => {
          page(id).emailCode!.recipient = 'other@example.com';
        },
      ],
      [
        'no-metadata',
        async (id: string) => {
          delete page(id).emailCode;
        },
      ],
      [
        'mismatched-masked-recipient',
        async (id: string) => {
          page(id).emailCode = { recipientHint: 'someone***@example.com', length: 6 };
        },
      ],
      [
        'mismatched-masked-tld',
        async (id: string) => {
          page(id).emailCode = { recipientHint: 'o***@example.n**', length: 6 };
        },
      ],
      [
        'wrong-origin',
        async (id: string) => {
          page(id).origin = 'https://evil.com';
        },
      ],
      [
        'legacy',
        async (id: string) => {
          await pool.query(
            'UPDATE credential_account_selections SET credential_entered_at=NULL WHERE root_turn_id=$1',
            [root(id)],
          );
        },
      ],
      [
        'old-auth',
        async (id: string) => {
          await pool.query(
            "UPDATE credential_account_selections SET credential_entered_at=now()-interval '6 minutes' WHERE root_turn_id=$1",
            [root(id)],
          );
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
      assert.equal(read, 2, id);
    }
    await start('wrong-owner');
    assert.equal(await vault.fillEmailCode(task('wrong-owner'), 'other', otpInput), false);
    assert.equal(read, 2);
    for (const [id, delivery] of [
      ['masked', { recipientHint: 'o***@example.com', length: 6 }],
      ['masked-bullets', { recipientHint: 'ow•••@example.com', length: 6 }],
      ['masked-tld', { recipientHint: 'o***@example.***', length: 6 }],
      ['masked-tld-bullets', { recipientHint: 'ow•••@example.•••', length: 6 }],
      ['selected-without-recipient', { length: 6 }],
    ] as const) {
      await start(id);
      page(id).emailCode = delivery;
      assert.equal(await fill(id), true, id);
      assert.equal(await fill(id), false, id);
    }
    const direct = await turns.start('direct-email');
    pages.set(direct.threadId, inspection('otp'));
    assert.equal(await fill('direct-email'), true);
    assert.equal(await fill('direct-email'), false);
    const priorChallenge = await turns.start('prior-challenge-email');
    pages.set(priorChallenge.threadId, inspection('otp'));
    emails = [{ ...message, receivedAt: Date.now() - 2 * 60_000 }];
    const attemptsBeforePriorChallenge = injected.length;
    assert.equal(await fill('prior-challenge-email'), false);
    assert.equal(injected.length, attemptsBeforePriorChallenge);
    const currentChallenge = await turns.start('current-challenge-email');
    pages.set(currentChallenge.threadId, inspection('otp'));
    emails.push({
      ...message,
      id: 'current-challenge-code',
      receivedAt: Date.now() - 1000,
      text: `Your verification code is ${currentCode}.`,
    });
    assert.equal(await fill('current-challenge-email'), true);
    assert.equal(injected.at(-1)?.code, currentCode);
    emails = undefined;
    const nonEmailLogin = (
      await app.inject({
        method: 'POST',
        url: '/api/vault',
        payload: {
          ...input,
          kind: 'login',
          username: 'synthetic-tax-identifier',
          password: 'fixture-private-password',
        },
      })
    ).json();
    assert.ok(nonEmailLogin.id);
    await start('non-email-login', nonEmailLogin.id);
    assert.equal(await fill('non-email-login'), true);
    for (const [id, delivery] of [
      ['non-email-login-mask', { recipientHint: 'o***@example.com', length: 6 }],
      ['non-email-login-missing', { length: 6 }],
    ] as const) {
      await start(id, nonEmailLogin.id);
      page(id).emailCode = delivery;
      const before: number = read;
      assert.equal(await fill(id), false, id);
      assert.equal(read, before, id);
    }
    for (const [id, delivery] of [
      ['unbound-mask', { recipientHint: 'o***@example.com', length: 6 }],
      ['unbound-recipient', { length: 6 }],
    ] as const) {
      const turn = await turns.start(id);
      pages.set(turn.threadId, { ...inspection('otp'), emailCode: delivery });
      const before: number = read;
      assert.equal(await fill(id), false, id);
      assert.equal(read, before, id);
    }
    for (const [id, offset] of [
      ['stale-direct-email', -6 * 60_000],
      ['future-direct-email', 60_000],
    ] as const) {
      const turn = await turns.start(id);
      pages.set(turn.threadId, inspection('otp'));
      await pool.query('UPDATE turns SET started_at=$2 WHERE id=$1', [
        turn.turnId,
        new Date(Date.now() + offset),
      ]);
      const before: number = read;
      assert.equal(await fill(id), false, id);
      assert.equal(read, before, id);
    }
    for (const [id, change] of [
      [
        'cancelled-direct-email',
        async (turn: TurnRef) => {
          await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [turn.turnId]);
        },
      ],
      [
        'expired-direct-email',
        async (turn: TurnRef) => {
          await pool.query("UPDATE turns SET started_at=now()-interval '6 minutes' WHERE id=$1", [
            turn.turnId,
          ]);
        },
      ],
      [
        'changed-direct-email',
        async (turn: TurnRef) => {
          pages.get(turn.threadId)!.emailCode!.recipient = 'different@example.com';
        },
      ],
    ] as const) {
      const turn = await turns.start(id);
      pages.set(turn.threadId, inspection('otp'));
      lookup = () => change(turn);
      const before = injected.length;
      assert.equal(await fill(id), false, id);
      assert.equal(injected.length, before, id);
    }
    lookup = undefined;
    await start('uncertain-submission');
    injectionFailure = true;
    const attemptsBeforeUncertain = injected.length;
    assert.equal(await fill('uncertain-submission'), false);
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
        'late-page',
        async (id: string) => {
          page(id).emailCode!.recipient = 'other@example.com';
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
    resultCode = '3817';
    await start('wrong-length');
    assert.equal(await fill('wrong-length'), false);
    resultCode = code;
    await start('rejected');
    reject = true;
    assert.equal(await fill('rejected'), false);
    assert.equal(await fill('rejected'), false);
    reject = false;
    const manualTurn = await turns.start('manual-password');
    pages.set(manualTurn.threadId, inspection('password'));
    const manual = await vault.request(manualTurn, owner, input);
    await turns.wait(manualTurn);
    const readsBeforePassword = read;
    assert.equal(await fill('manual-password'), false);
    assert.equal(read, readsBeforePassword);
    const submitted = await app.inject({
      method: 'POST',
      url: manual.url.replace('/vault/', '/api/credential-requests/'),
      payload: {
        label: 'Manually entered fixture',
        username,
        password: 'fixture-private-password',
      },
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
    await start('entry-removed');
    lookup = async () => {
      await pool.query('DELETE FROM vault_entries WHERE id=$1', [saved.id]);
    };
    assert.equal(await fill('entry-removed'), false);
    const persisted = JSON.stringify([
      (await pool.query('SELECT * FROM credential_requests')).rows,
      (await pool.query('SELECT * FROM credential_account_selections')).rows,
      (await pool.query('SELECT * FROM credential_autofill_attempts')).rows,
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
  'chat codes consume the exact pending owned request and rejected codes rotate without plaintext storage',
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
    let reject = true;
    const vault = await createVault(pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => randomBytes(32) },
      inspect: async () => inspection('otp'),
      inject: async (input) => {
        injected++;
        assert.equal(input.code, code);
        return { status: reject ? 'rejected' : 'submitted' };
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
    assert.deepEqual(await vault.submitChatCode(owner, chat.turnId, '3817', requestId), {
      status: 'unavailable',
    });
    assert.equal(injected, 0);
    assert.deepEqual(await vault.submitChatCode(owner, chat.turnId, code, requestId), {
      status: 'rejected',
    });
    const retryId = (await pending())[0];
    assert.notEqual(retryId, requestId);
    assert.deepEqual(await vault.submitChatCode(owner, chat.turnId, code, requestId), {
      status: 'unavailable',
    });
    reject = false;
    assert.deepEqual(await vault.submitChatCode(owner, chat.turnId, code, retryId), {
      status: 'submitted',
    });
    assert.deepEqual(await vault.submitChatCode(owner, chat.turnId, code, retryId), {
      status: 'unavailable',
    });
    assert.equal(injected, 2);
    assert.deepEqual(await turns.resumed(chat.turnId), [
      { parent: 'waiting', reason: 'credentials', status: 'running', source: 'resume' },
    ]);
    const persisted = JSON.stringify((await pool.query('SELECT * FROM credential_requests')).rows);
    for (const secret of [code, username, 'recipient'])
      assert.equal(persisted.includes(secret), false);
    assert.ok(
      (await pool.query('SELECT selectors FROM credential_requests')).rows.every(
        (row) => row.selectors.emailCode === true,
      ),
    );
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
      restoreSession: async () => {
        throw new Error('Mailbox reads must not use model sessions.');
      },
      readOnly: async () => false,
      deleteSession: async () => {},
      deleteAccount: async () => {
        assert.fail('Must not disconnect.');
      },
      inspectAccount: async (id, user) => {
        inspected.push(id);
        assert.equal(user, owner);
        return { active, service: 'gmail', accountEmail: remoteEmail };
      },
      verificationEmails: async (id, query, signal) => {
        reads.push(id);
        assert.equal(query.recipient, recipient);
        assert.equal(query.senderDomain, 'toconline.pt');
        assert.equal(signal.aborted, false);
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
    assert.equal(await read(), undefined);
    messages = [mail, { ...mail, id: 'mail2', text: 'Your login verification code is 940173.' }];
    assert.equal(await read(), undefined);
    messages = [{ ...mail, receivedAt: now - 60_000 }];
    assert.equal(await read(), undefined);
    fail = true;
    assert.equal(await read(), undefined);
    fail = false;
    messages = [mail];
    const currentMailbox = await read();
    assert.ok(currentMailbox);
    const change = await pool.connect();
    const fill = await pool.connect();
    try {
      await change.query('BEGIN');
      await change.query('UPDATE app_connections SET revoked=true WHERE id=$1', [connection]);
      await assert.rejects(currentMailbox.current(), { code: '55P03' });
      await change.query('ROLLBACK');
      await fill.query('BEGIN');
      assert.equal(await currentMailbox.current(fill), true);
      await assert.rejects(
        change.query('SELECT id FROM app_connections WHERE id=$1 FOR UPDATE NOWAIT', [connection]),
        { code: '55P03' },
      );
      await fill.query('COMMIT');
      assert.equal(
        (
          await change.query('SELECT id FROM app_connections WHERE id=$1 FOR UPDATE NOWAIT', [
            connection,
          ])
        ).rowCount,
        1,
      );
    } finally {
      await change.query('ROLLBACK');
      await fill.query('ROLLBACK');
      change.release();
      fill.release();
    }
    duringRead = async () => {
      await pool.query('UPDATE app_connections SET revoked=true WHERE id=$1', [connection]);
    };
    assert.equal(await read(), undefined);
    const persisted = JSON.stringify([
      (await pool.query('SELECT * FROM integration_events')).rows,
      (await pool.query('SELECT * FROM integration_sessions')).rows,
      (await pool.query('SELECT * FROM app_connections')).rows,
    ]);
    for (const secret of ['381742', '940173', 'private-message-body', mail.text])
      assert.equal(persisted.includes(secret), false);
    assert.ok(reads.every((id) => id === 'owned-mailbox'));
  },
);
