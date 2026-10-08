import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { runProcess } from '../src/providers/process.ts';
import { VaultDetails } from '../src/web/components/vault-details.tsx';
import { Credentials } from '../src/web/pages/credentials.tsx';
import { Vault } from '../src/web/pages/vault.tsx';
import { setRequestAccount } from '../src/web/lib/api.ts';
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
    "CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text,background boolean NOT NULL DEFAULT false,started_at timestamptz);CREATE TABLE approvals(owner_id text,turn_id uuid,execution_turn_id uuid)",
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
      assert.deepEqual((await vault.readCredential(saved.json().id)).secret, {
        username: 'person',
        password: 'old-password',
      });
      assert.equal((await vault.list()).length, 2);
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
      const concurrent = await Promise.all([
        app.inject({ method: 'POST', url: `${url}/retry` }),
        app.inject({ method: 'POST', url: `${url}/retry` }),
      ]);
      assert.deepEqual(concurrent.map((result) => result.statusCode).sort(), [200, 409]);
      assert.equal((await app.inject({ method: 'POST', url: `${url}/retry` })).statusCode, 409);
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
  'credential links work only while their turn waits for credentials and no later foreground turn started',
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

      const check = await f.turn();
      await f.pool.query(
        'UPDATE turns SET background=true,started_at=clock_timestamp() WHERE id=$1',
        [check.turnId],
      );
      assert.equal(await f.status(url), 'pending');

      const later = await f.turn();
      await f.pool.query('UPDATE turns SET started_at=clock_timestamp() WHERE id=$1', [
        later.turnId,
      ]);
      assert.equal(await f.status(url), 'expired');
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
      "CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text,background boolean NOT NULL DEFAULT false,started_at timestamptz);CREATE TABLE approvals(owner_id text,turn_id uuid,execution_turn_id uuid)",
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
        'combined sign-in pages allow a different account than the saved one already chosen',
        async () => {
          await addTask('combined-different');
          const turn = task('combined-different');
          await vault.fillSaved(turn, 'local-development', first.id, input());
          const combined = { ...input('password'), usernameSelector: '#account' };
          const request = await vault.request(turn, 'local-development', combined);
          await pool.query(
            "UPDATE turns SET status='waiting',waiting_reason='credentials' WHERE id=$1",
            [turn.turnId],
          );
          const url = request.url.replace('/vault/', '/api/credential-requests/');
          assert.deepEqual(
            (await describe(url)).fields?.map((field) => field.kind),
            ['identifier', 'password'],
          );
          const response = await app.inject({
            method: 'POST',
            url,
            payload: {
              label: 'Different account',
              username: 'different-member@example.test',
              password: 'different-synthetic-password',
            },
          });
          assert.equal(response.statusCode, 200);
          assert.equal(response.json().ok, true);
          assert.equal(injections.at(-1)?.username, 'different-member@example.test');
          assert.equal(injections.at(-1)?.password, 'different-synthetic-password');
          assert.deepEqual((await vault.readCredential(first.id)).secret, {
            username: 'same-first@example.test',
            password: 'first-password',
          });
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
      for (const kind of ['identifier', 'password', 'otp'] as const) {
        await t.test(`${kind} fills the chosen field after a restart`, async () => {
          pageOrigin = origin;
          const turn = await turns.turn();
          const raw = {
            origin,
            label: 'Synthetic sign-in',
            kind,
            ...(kind !== 'otp' ? { usernameSelector: '@e3' } : {}),
            ...(kind !== 'identifier'
              ? { passwordSelector: kind === 'otp' ? '.code-digit' : '#entry' }
              : {}),
          };
          const request = await vault.request(turn, 'local-development', raw);
          await turns.wait(turn);
          const before = await stored(turn.turnId);
          const selectedKey = kind === 'identifier' ? 'usernameSelector' : 'passwordSelector';
          assert.equal(before.selectors[selectedKey], raw[selectedKey]);
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
                ...(kind === 'password'
                  ? { label: 'Fixture login', password: 'synthetic-password' }
                  : {}),
              },
            });
            assert.equal(response.statusCode, 200, response.body);
          }
          assert.equal(injections.at(-1)?.kind, kind);
          assert.equal(injections.at(-1)?.[selectedKey], raw[selectedKey]);
          if (kind === 'password') assert.equal(injections.at(-1)?.usernameSelector, '@e3');
        });
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
              payload: { label: 'Fixture', password: 'synthetic-password' },
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
          /origin changed/,
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
          ]) {
            await assert.rejects(
              vault.request(turn, 'local-development', {
                origin,
                label: 'Synthetic sign-in',
                kind: 'password',
                ...selectors,
              }),
              /visible sign-in field|different fields/,
            );
          }
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
      CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text,background boolean NOT NULL DEFAULT false,started_at timestamptz,finished_at timestamptz);
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
      registerLocalAccess(app, 4310, { key: 'synthetic-local-access' });
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
    const headers = {
      host: 'localhost:4310',
      origin: 'http://localhost:4310',
      cookie: 'otto-access-4310=synthetic-local-access',
    };
    const start = async (getKey: () => Promise<Buffer> = async () => key) => {
      const instance = Fastify({ logger: false });
      registerLocalAccess(instance, 4310, { key: 'synthetic-local-access' });
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
        "CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text,background boolean NOT NULL DEFAULT false,started_at timestamptz);CREATE TABLE approvals(owner_id text,turn_id uuid,execution_turn_id uuid)",
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
      let unavailable = false;
      let unavailableIdentifier = false;
      const options = {
        keyStore: { id: 'fixture', configured: true, getKey: async () => key },
        page: async () => ({ origin: observedOrigin, url: observedOrigin + '/login' }),
        inject: async (input: CredentialInjection) => {
          injections.push(input);
          if (unavailableIdentifier && input.kind === 'identifier')
            throw new Error('Synthetic identifier unavailable');
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
      let vault = await createVault(pool, options);
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
          label: 'My Google account',
          username: 'synthetic@example.test',
          password: 'one-form-synthetic-password',
        } as { label?: string; username: string; password?: string },
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
        'passwordless identifiers survive recovery, restart and a later login without filling an empty password',
        async () => {
          const username = 'passwordless-member@example.test';
          await begin('identifier-reuse', { username });
          await app.close();
          app = Fastify();
          vault = await createVault(pool, options);
          vault.registerRoutes(app);
          const resetInput = { ...requestInput('identifier'), usernameSelector: '#fresh-account' };
          assert.equal(
            await vault.fillSelected(task('identifier-reuse'), 'local-development', resetInput),
            true,
          );
          assert.equal(injections.at(-1)?.username, username);
          assert.equal(injections.at(-1)?.usernameSelector, '#fresh-account');
          assert.equal(injections.at(-1)?.password, undefined);
          assert.equal(injections.at(-1)?.code, undefined);
          const entries = await vault.list();
          const entry = (
            await Promise.all(entries.map((candidate) => vault.readCredential(candidate.id)))
          ).find((candidate) => candidate.secret.username === username);
          assert.ok(entry);
          assert.equal(entry.secret.password, '');
          await vault.fillSaved(
            task('identifier-reuse'),
            'local-development',
            entry.entry.id,
            resetInput,
          );
          assert.equal(injections.at(-1)?.username, username);
          await begin('identifier-reuse', { username });
          assert.equal((await vault.list()).length, entries.length);
          const later = await startTurn();
          tasks.set('identifier-later', later);
          await vault.fillSaved(later, 'local-development', entry.entry.id, resetInput);
          const before = injections.length;
          const passwordInput = { ...requestInput('password'), usernameSelector: '#fresh-account' };
          assert.equal(await vault.fillSelected(later, 'local-development', passwordInput), false);
          assert.equal(
            await vault.fillSaved(later, 'local-development', entry.entry.id, passwordInput),
            false,
          );
          assert.equal(injections.length, before);
          const request = await vault.request(later, 'local-development', passwordInput);
          await wait(later);
          const url = request.url.replace('/vault/', '/api/credential-requests/');
          const description = await app.inject({ url });
          assert.deepEqual(description.json().savedEntries, []);
          assert.deepEqual(
            description.json().fields.map((field: { kind: string }) => field.kind),
            ['identifier', 'password'],
          );
          const rejected = await app.inject({
            method: 'POST',
            url: `${url}/saved`,
            payload: { entryId: entry.entry.id },
          });
          assert.equal(rejected.statusCode, 409);
          assert.equal(injections.length, before);
          const response = await app.inject({
            method: 'POST',
            url,
            payload: { label: 'Passwordless member', password: 'new-synthetic-password' },
          });
          assert.equal(response.statusCode, 200);
          assert.equal(response.json().ok, true);
          assert.equal(injections.at(-1)?.username, username);
          const upgraded = await vault.readCredential(entry.entry.id);
          assert.equal(upgraded.secret.username, username);
          assert.equal(upgraded.secret.password, 'new-synthetic-password');
          assert.equal((await vault.list()).length, entries.length);
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
          false,
        );
        assert.equal(injections.length, before);
      });

      await t.test(
        'held credentials remain bound to owner, origin, running turn and expiry',
        async () => {
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
            if (kind === 'password') {
              await vault.resumePending();
              const expired = (
                await pool.query(
                  'SELECT * FROM credential_account_selections WHERE root_turn_id=$1',
                  [roots.get(name)],
                )
              ).rows[0];
              assert.equal(expired.ciphertext, '');
              assert.equal(expired.blocked, true);
            }
            const later = await startTurn();
            assert.equal(await vault.fillSelected(later, 'local-development', input), undefined);
            const request = await vault.request(later, 'local-development', input);
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

      await t.test(
        'failed identifier recovery is fenced without replaying credentials',
        async () => {
          const name = 'identifier-uncertain';
          await begin(name, { username: `${name}@example.test` });
          const turn = task(name);
          const before = injections.length;
          unavailableIdentifier = true;
          assert.equal(
            await vault.fillSelected(turn, 'local-development', requestInput('identifier')),
            false,
          );
          unavailableIdentifier = false;
          assert.equal(injections.length, before + 1);
          assert.equal(
            await vault.fillSelected(turn, 'local-development', requestInput('identifier')),
            false,
          );
          assert.equal(
            await vault.fillSelected(turn, 'local-development', requestInput('password')),
            false,
          );
          assert.equal(injections.length, before + 1);
          const rows = await pool.query(
            'SELECT * FROM credential_account_selections WHERE root_turn_id=$1',
            [roots.get(name)],
          );
          assert.equal(rows.rows[0].blocked, true);
          assert.equal(rows.rows[0].credential_entered_at, null);
          assert.equal(openCredential(key, rows.rows[0]).password, '');
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

test('verification links do not grant unrelated senders authority over the signup site', () => {
  const signup = { ...request, origin: 'https://app.example.net' };
  const email = {
    ...message,
    sender: 'login@transactional.example.com',
    authenticatedDomain: 'example.com',
    text: `Your verification code is 123456. Verify email: ${signup.origin}/verify?token=abcdefghijklmnop`,
  };
  assert.equal(verificationCode([email], signup), undefined);
  assert.equal(
    verificationCode([{ ...email, authenticatedDomain: 'unrelated.com' }], signup),
    undefined,
  );
  assert.equal(
    verificationCode(
      [{ ...email, sender: 'login@evil.github.io', authenticatedDomain: 'trusted.github.io' }],
      signup,
    ),
    undefined,
  );
  assert.equal(
    verificationCode([{ ...email, sender: 'login@co.uk', authenticatedDomain: 'co.uk' }], signup),
    undefined,
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
  sender = 'Attacker <sender@unrelated.example.org>';
  auth = 'mx.google.com; dmarc=pass header.from=unrelated.example.org';
  for (const [type, content] of [
    [
      'text/plain',
      `Your verification code is 123456.\nVerify email (${request.origin}/verify?token=abcdefghijklmnop)`,
    ],
    [
      'text/html',
      `<p>Your verification code is 123456.</p><a href="${request.origin}/verify?token=abcdefghijklmnop">Verify email</a>`,
    ],
  ]) {
    mimeType = type;
    body = content;
    const unrelated = await read();
    assert.equal(unrelated?.length, 1);
    assert.equal(verificationCode(unrelated!, request), undefined);
  }
  sender = 'TOConline <login@toconline.pt>';
  auth = 'mx.google.com; dmarc=pass (p=REJECT) header.from=toconline.pt; dkim=pass';
  body = 'O seu código de autenticação é 381742.';
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
  auth = 'mx.google.com; dmarc=pass header.from=tenant.github.io';
  sender = 'login@mail.tenant.github.io';
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
    "CREATE TABLE turns(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text,status text NOT NULL DEFAULT 'running',waiting_reason text,background boolean NOT NULL DEFAULT false,started_at timestamptz);CREATE TABLE approvals(owner_id text,turn_id uuid,execution_turn_id uuid)",
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
      emailCode: async (request, signal) => {
        read++;
        assert.equal(request.recipient, username);
        assert.equal(request.origin, origin);
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
    assert.equal(read, 2);
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
    for (const [id, offset] of [
      ['stale-direct-email', -6 * 60_000],
      ['future-direct-email', 60_000],
    ] as const) {
      const turn = await begin(id);
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
    assert.equal(await fill('provider-error'), true);
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
      restoreSession: async () => {
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
      verificationEmails: async (id, query, signal) => {
        reads.push(id);
        assert.equal(query.recipient, requestedRecipient);
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

test(
  'manually saved identifier-only logins stay origin-bound and cannot become empty credentials',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_vault_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const { turn } = await seedTurns(pool);
    const app = Fastify();
    const key = randomBytes(32);
    const injections: CredentialInjection[] = [];
    const vault = await createVault(pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      inject: async (input) => {
        injections.push(input);
      },
      resume: async () => {},
      retry: async () => {},
    });
    vault.registerRoutes(app);
    try {
      const payload = {
        label: 'Fixture login',
        origin: 'https://example.test',
        username: 'tester@example.test',
      };
      for (const invalid of [
        { ...payload, origin: '' },
        { ...payload, origin: 'https://user:password@example.test' },
        { ...payload, username: '' },
        { ...payload, username: ' ', password: '' },
      ])
        assert.equal(
          (await app.inject({ method: 'POST', url: '/api/vault', payload: invalid })).statusCode,
          400,
        );
      const saved = await app.inject({ method: 'POST', url: '/api/vault', payload });
      assert.equal(saved.statusCode, 200);
      const id = saved.json().id as string;
      const stored = await vault.readCredential(id);
      assert.deepEqual(stored.secret, { username: payload.username, password: '' });
      assert.equal(stored.entry.origin, payload.origin);
      assert.equal(stored.entry.ciphertext.includes(payload.username), false);
      assert.equal(
        (await app.inject({ method: 'POST', url: `/api/vault/${id}/details`, payload: {} })).json()
          .hasPassword,
        false,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/vault/${id}`,
            payload: { label: payload.label, username: '' },
          })
        ).statusCode,
        400,
      );
      const ref = await turn();
      const input = {
        origin: payload.origin,
        kind: 'identifier' as const,
        label: payload.label,
        usernameSelector: '#email',
      };
      await assert.rejects(vault.fillSaved(ref, 'another-owner', id, input));
      await assert.rejects(
        vault.fillSaved(ref, 'local-development', id, {
          ...input,
          origin: 'https://other.example.test',
        }),
      );
      assert.equal(injections.length, 0);
      await vault.fillSaved(ref, 'local-development', id, input);
      assert.equal(injections.length, 1);
      assert.equal(injections[0].username, payload.username);
      assert.equal(injections[0].origin, payload.origin);
      assert.equal(
        await vault.fillSelected(ref, 'local-development', {
          origin: payload.origin,
          kind: 'password',
          label: payload.label,
          passwordSelector: '#password',
        }),
        false,
      );
      assert.equal(injections.length, 1);
      assert.equal(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/vault/${id}`,
            payload: {
              label: payload.label,
              username: payload.username,
              password: 'synthetic-password',
            },
          })
        ).statusCode,
        200,
      );
      assert.equal((await vault.readCredential(id)).secret.password, 'synthetic-password');
      const details = await app.inject({
        method: 'POST',
        url: `/api/vault/${id}/details`,
        payload: {},
      });
      assert.equal(details.json().hasPassword, true);
      assert.equal(details.body.includes('synthetic-password'), false);
      const passwordOnly = await app.inject({
        method: 'POST',
        url: '/api/vault',
        payload: {
          label: 'Password only',
          origin: 'https://other.example.test',
          password: 'synthetic-password',
        },
      });
      assert.equal(passwordOnly.statusCode, 200);
      assert.equal((await vault.readCredential(passwordOnly.json().id)).secret.username, '');
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

async function vaultPage(
  element: React.ReactNode,
  response: (path: string, init: RequestInit) => Promise<Response>,
  url = 'http://localhost:4310/vault/synthetic_credential_request',
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
    window: dom.window,
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

test(
  'a Vault save link opens an empty secure form and saves only the submitted owned login',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_vault_link_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    await seedTurns(pool);
    const key = randomBytes(32);
    const app = Fastify();
    const vault = await createVault(pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      inject: async () => assert.fail('Saving a manual login must not use the browser.'),
      resume: async () => assert.fail('Saving a manual login must not resume a task.'),
      retry: async () => assert.fail('Saving a manual login must not retry a task.'),
    });
    vault.registerRoutes(app);
    const submitted: unknown[] = [];
    const requests = new Set<Promise<Response>>();
    const settle = async () => {
      while (requests.size) await act(async () => void (await Promise.all(requests)));
    };
    let view: Awaited<ReturnType<typeof vaultPage>> | undefined;
    pageDataCache.clear();
    setRequestAccount('local-development');
    try {
      view = await vaultPage(
        createElement(Vault),
        (path, init) => {
          const request = (async () => {
            assert.equal(new Headers(init.headers).get('X-Otto-Account'), 'local-development');
            assert.ok(path.startsWith('/api/vault'));
            if (path === '/api/vault' && init.method === 'POST')
              submitted.push(JSON.parse(String(init.body)));
            const response = await app.inject({
              method: (init.method ?? 'GET') as 'GET' | 'POST',
              url: path,
              ...(init.body ? { payload: JSON.parse(String(init.body)) } : {}),
            });
            return new Response(response.body, {
              status: response.statusCode,
              headers: { 'Content-Type': 'application/json' },
            });
          })();
          requests.add(request);
          void request.catch(() => undefined).finally(() => requests.delete(request));
          return request;
        },
        'http://localhost:4310/vault?add=login',
      );
      await settle();
      const form = view.document.querySelector<HTMLFormElement>('.vault-add-form');
      assert.ok(form, 'The save link must open the login form.');
      assert.equal(submitted.length, 0);
      assert.deepEqual(await vault.list(), []);
      assert.equal(view.window.location.search, '');
      const input = (name: string) => {
        const field = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
        assert.ok(field);
        return field;
      };
      for (const name of ['origin', 'username', 'password']) assert.equal(input(name).value, '');
      input('label').value = 'Synthetic manual login';
      input('origin').value = 'https://identity.example.test';
      input('username').value = 'owner@example.test';
      input('password').value = 'synthetic-manual-password';
      await act(async () => {
        form.dispatchEvent(new view!.window.Event('submit', { bubbles: true, cancelable: true }));
      });
      assert.equal(input('password').value, '');
      await settle();
      assert.equal(view.document.querySelector('.vault-add-form'), null);
      assert.deepEqual(submitted, [
        {
          label: 'Synthetic manual login',
          origin: 'https://identity.example.test',
          username: 'owner@example.test',
          password: 'synthetic-manual-password',
        },
      ]);
      const entries = await vault.list();
      assert.equal(entries.length, 1);
      const { entry, secret } = await vault.readCredential(entries[0].id);
      assert.equal(entry.owner_id, 'local-development');
      assert.equal(entry.origin, 'https://identity.example.test');
      assert.deepEqual(secret, {
        username: 'owner@example.test',
        password: 'synthetic-manual-password',
      });
      for (const value of Object.values(secret)) {
        assert.equal(entry.ciphertext.includes(value), false);
        assert.equal(view.window.location.href.includes(value), false);
      }
      assert.deepEqual(await vault.list('another-owner'), []);
      assert.equal((await pool.query('SELECT * FROM credential_requests')).rowCount, 0);
    } finally {
      await view?.close();
      await Promise.allSettled(requests);
      pageDataCache.clear();
      setRequestAccount(null);
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('Vault does not open or prefill a login from arbitrary query data', async () => {
  for (const query of [
    '',
    '?add=card',
    '?add=login&origin=https%3A%2F%2Fexample.test',
    '?add=login&password=synthetic',
    '?add=login&add=login',
    '?add=login#synthetic',
  ]) {
    pageDataCache.clear();
    const view = await vaultPage(
      createElement(Vault),
      async (path, init) => {
        assert.equal(path, '/api/vault');
        assert.notEqual(init.method, 'POST');
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

test('Vault Escape cancels edits and clears replacement secrets without disabling the selected login', async () => {
  const entry = {
    kind: 'login' as const,
    id: randomUUID(),
    label: 'Fixture account',
    origin: 'https://example.test',
    usernameHint: 'te…',
    updatedAt: new Date().toISOString(),
  };
  let detailsReads = 0;
  let writes = 0;
  const page = await vaultPage(
    createElement(VaultDetails, {
      entry,
      onClose() {},
      onSaved() {
        writes++;
      },
      onDeleted() {
        writes++;
      },
    }),
    async (path, init) => {
      if (path.endsWith('/details')) {
        detailsReads++;
        return Response.json({ ...entry, username: 'tester@example.test', hasPassword: false });
      }
      assert.equal(init.method ?? 'GET', 'GET');
      return new Response(null, { status: 204 });
    },
  );
  try {
    const buttons = () => [...page.document.querySelectorAll<HTMLButtonElement>('button')];
    await act(async () =>
      buttons()
        .find((button) => button.hasAttribute('data-vault-edit'))!
        .click(),
    );
    const secret = page.document.querySelector<HTMLInputElement>('input[name="password"]')!;
    const save = () => page.document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    for (const event of ['blur', 'visibilitychange']) {
      secret.value = 'synthetic replacement';
      await act(async () =>
        secret.dispatchEvent(new page.window.Event('input', { bubbles: true })),
      );
      assert.equal(save().disabled, false);
      await act(async () => {
        if (event === 'blur') page.window.dispatchEvent(new page.window.Event(event));
        else {
          Object.defineProperty(page.document, 'hidden', { configurable: true, value: true });
          page.document.dispatchEvent(new page.window.Event(event));
        }
      });
      assert.equal(secret.value, '');
      assert.equal(save().disabled, true);
      Object.defineProperty(page.document, 'hidden', { configurable: true, value: false });
    }
    const label = page.document.querySelector<HTMLInputElement>('input[name="label"]')!;
    label.value = 'Renamed fixture account';
    await act(async () => label.dispatchEvent(new page.window.Event('input', { bubbles: true })));
    secret.value = 'synthetic replacement';
    await act(async () => page.window.dispatchEvent(new page.window.Event('blur')));
    assert.equal(secret.value, '');
    assert.equal(save().disabled, false);
    secret.value = 'synthetic replacement';
    await act(async () => secret.dispatchEvent(new page.window.Event('input', { bubbles: true })));
    await act(async () =>
      secret.dispatchEvent(
        new page.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    assert.equal(secret.value, '');
    assert.equal(page.document.querySelector('form'), null);
    const edit = buttons().find((button) => button.hasAttribute('data-vault-edit'))!;
    assert.equal(edit.disabled, false);
    assert.equal(page.document.activeElement, edit);
    await act(async () =>
      edit.dispatchEvent(
        new page.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    assert.equal(page.document.querySelector('[data-vault-edit]'), edit);
    await act(async () =>
      page.document.querySelector<HTMLButtonElement>('[data-vault-field="username"]')!.click(),
    );
    assert.equal(page.document.activeElement?.getAttribute('name'), 'username');
    assert.equal(
      page.document.querySelector<HTMLInputElement>('input[name="username"]')!.value,
      'tester@example.test',
    );
    assert.equal(detailsReads, 1);
    assert.equal(writes, 0);
  } finally {
    await page.close();
  }
});

test('secure sign-in keeps failed submissions editable and returns to chat only after accepted submission', async () => {
  const request = {
    id: 'synthetic_credential_request',
    turnId: randomUUID(),
    origin: 'https://example.test',
    label: 'Fixture sign-in',
    kind: 'otp',
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    fields: [{ kind: 'otp', selector: '#code', label: 'Verification code' }],
  };
  let finish!: (value: Response) => void;
  let submissions = 0;
  let closed = 0;
  let focused = 0;
  const page = await vaultPage(
    createElement(Credentials, { id: request.id }),
    async (_path, init) => {
      if (init.method !== 'POST') return Response.json(request);
      submissions++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  );
  Object.defineProperty(page.window, 'opener', {
    value: {
      closed: false,
      location: { origin: page.window.location.origin },
      focus() {
        focused++;
      },
    },
  });
  const close = page.window.close.bind(page.window);
  page.window.close = () => {
    closed++;
    Object.defineProperty(page.window, 'closed', { value: true, configurable: true });
  };
  try {
    const submit = async () => {
      page.document.querySelector<HTMLInputElement>('input[name="code"]')!.value = '123456';
      await act(async () =>
        page.document
          .querySelector('form')!
          .dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true })),
      );
    };
    await submit();
    assert.equal(submissions, 1);
    assert.equal(closed, 0);
    assert.equal(page.document.querySelector('form'), null);
    await act(async () =>
      finish(Response.json({ error: 'Synthetic rejected request' }, { status: 502 })),
    );
    assert.equal(closed, 0);
    assert.ok(page.document.querySelector('form'));
    assert.equal(page.document.querySelector<HTMLInputElement>('input[name="code"]')!.value, '');
    await submit();
    assert.equal(submissions, 2);
    assert.equal(closed, 0);
    await act(async () =>
      finish(Response.json({ ok: false, retryUrl: '/vault/synthetic_replacement_request' })),
    );
    assert.equal(closed, 0);
    assert.ok(page.document.querySelector('form'));
    await submit();
    assert.equal(submissions, 3);
    assert.equal(closed, 0);
    await act(async () => finish(Response.json({ ok: true })));
    assert.equal(closed, 1);
    assert.equal(focused, 1);
  } finally {
    page.window.close = close;
    await page.close();
  }
});

test('Vault preserves the saved card when a replacement contains only whitespace', async () => {
  const entry: VaultCardEntry = {
    kind: 'card',
    id: randomUUID(),
    label: 'Fixture card',
    brand: 'Visa',
    last4: '4242',
    expiryMonth: 12,
    expiryYear: 2028,
    updatedAt: new Date().toISOString(),
  };
  const updates: Record<string, unknown>[] = [];
  let saved = 0;
  const page = await vaultPage(
    createElement(VaultDetails, {
      entry,
      onClose() {},
      onSaved() {
        saved++;
      },
      onDeleted() {},
    }),
    async (path, init) => {
      if (path.endsWith('/details'))
        return Response.json({ ...entry, cardholder: 'Alex Tester', hasSecurityCode: false });
      assert.equal(init.method, 'PATCH');
      const update = JSON.parse(String(init.body));
      updates.push(update);
      if ('cardNumber' in update)
        return Response.json({ error: 'Invalid replacement card number' }, { status: 400 });
      return Response.json({ ...entry, label: update.label });
    },
  );
  try {
    await act(async () =>
      page.document.querySelector<HTMLButtonElement>('[data-vault-edit]')!.click(),
    );
    const card = page.document.querySelector<HTMLInputElement>('input[name="cardNumber"]')!;
    card.value = '   ';
    await act(async () => card.dispatchEvent(new page.window.Event('input', { bubbles: true })));
    const save = page.document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    assert.equal(save.disabled, true);
    const label = page.document.querySelector<HTMLInputElement>('input[name="label"]')!;
    label.value = 'Renamed fixture card';
    await act(async () => label.dispatchEvent(new page.window.Event('input', { bubbles: true })));
    assert.equal(save.disabled, false);
    await act(async () => save.click());
    assert.equal(updates.length, 1);
    assert.equal(Object.hasOwn(updates[0], 'cardNumber'), false);
    assert.equal(updates[0].label, label.value);
    assert.equal(saved, 1);
    assert.equal(page.document.querySelector('form'), null);
  } finally {
    await page.close();
  }
});

test('Vault keeps intentional whitespace in replacement passwords', async () => {
  const entry = {
    kind: 'login' as const,
    id: randomUUID(),
    label: 'Fixture account',
    origin: 'https://example.test',
    usernameHint: 'te…',
    updatedAt: new Date().toISOString(),
  };
  const passwords: string[] = [];
  const page = await vaultPage(
    createElement(VaultDetails, { entry, onClose() {}, onSaved() {}, onDeleted() {} }),
    async (path, init) => {
      if (path.endsWith('/details'))
        return Response.json({ ...entry, username: 'tester@example.test', hasPassword: true });
      if (path.endsWith('/icon')) return new Response(null, { status: 204 });
      assert.equal(init.method, 'PATCH');
      passwords.push(JSON.parse(String(init.body)).password);
      return Response.json(entry);
    },
  );
  try {
    for (const value of ['   ', '  synthetic password  ']) {
      await act(async () =>
        page.document.querySelector<HTMLButtonElement>('[data-vault-edit]')!.click(),
      );
      const password = page.document.querySelector<HTMLInputElement>('input[name="password"]')!;
      password.value = value;
      await act(async () =>
        password.dispatchEvent(new page.window.Event('input', { bubbles: true })),
      );
      const save = page.document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      assert.equal(save.disabled, false);
      await act(async () => save.click());
      assert.equal(passwords.at(-1), value);
    }
    assert.equal(passwords.length, 2);
  } finally {
    await page.close();
  }
});

test('session replay masks private DOM and analytics transport separates owners without exposing content', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html data-theme="dark" data-desktop="true"><head><title>synthetic-private-title</title><style>.visible { color: red }</style></head><body><nav data-analytics-public>Settings</nav><div class="visible">synthetic-private-chat</div><div class="message-text"><span data-analytics-public>synthetic-private-markup</span></div><div class="vault-inset-value">synthetic-private-vault</div><input value="synthetic-private-input"><input type="hidden" value="synthetic-private-hidden"><input type="file"><img src="https://private.invalid/synthetic-private-image"><iframe src="https://private.invalid/synthetic-private-frame"></iframe><div id="mutable" title="synthetic-private-tooltip" data-owner="synthetic-private-owner" data-desktop="synthetic-private-layout" style="background-image: url(https://private.invalid/synthetic-private-css)">synthetic-private-name</div><a href="/credentials/synthetic-private-id?token=synthetic-private-token">synthetic-private-link</a><div contenteditable="true">synthetic-private-composer</div><figure class="telegram-pairing-qr"><svg><path d="M12345678 87654321h1v1h-1z"></path></svg></figure></body></html>', { url: 'https://otto.fixture.invalid/credentials/synthetic-private-request?token=synthetic-private-query#synthetic-private-hash', pretendToBeVisual: true });
for (const name of ['window','document','Node','NodeFilter','Element','HTMLElement','HTMLInputElement','HTMLFormElement','HTMLIFrameElement','HTMLImageElement','HTMLLinkElement','HTMLStyleElement','HTMLMediaElement','HTMLVideoElement','HTMLAudioElement','HTMLCanvasElement','SVGElement','Document','DocumentFragment','ShadowRoot','CSSStyleSheet','CSSStyleDeclaration','MutationObserver','Event','CustomEvent']) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : name === 'document' ? dom.window.document : dom.window[name] });
Object.defineProperty(globalThis, 'navigator', {configurable:true,value:dom.window.navigator});
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.location = window.location;
const requests=[];
window.XMLHttpRequest = undefined;
globalThis.XMLHttpRequest = undefined;
window.fetch = globalThis.fetch = async (url, init={}) => { requests.push({url:String(url),body:init.body instanceof ArrayBuffer ? (new Uint8Array(init.body)[0]===31 ? gunzipSync(Buffer.from(init.body)) : Buffer.from(init.body)).toString() : init.body && typeof init.body.text === 'function' ? await init.body.text() : init.body}); return Response.json(new URL(url).pathname.endsWith('/config') ? {sessionRecording:{sampleRate:null,minimumDurationMilliseconds:null,masking:{maskAllInputs:false},urlTriggers:[],eventTriggers:[],linkedFlag:null,urlBlocklist:[],scriptConfig:{script:'posthog-recorder'},version:1},hasFeatureFlags:false} : {status:1}); };
const { recordingOptions } = await import('./src/web/lib/analytics-privacy.ts');
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { Sidebar } = await import('./src/web/components/sidebar.tsx');
document.body.insertAdjacentHTML('beforeend', renderToStaticMarkup(createElement(Sidebar, {path:'/', unreadCount:73, collapsed:false, onToggle() {}, onNavigate() {}})));
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
const content = JSON.stringify(events.filter(e => e.type === 2 || e.type === 3));
assert.match(content, /Settings/);
assert.match(content, /"textContent":"Chat"/);
assert.match(content, /visible/);
assert.match(content, /data-theme.*dark/);
assert.match(content, /"data-desktop":"true"/);
assert.match(content, /"data-desktop":"false"/);
assert.doesNotMatch(content, /M12345678 87654321h1v1h-1z/);
assert.match(content, /https:\/\/otto.invalid\/credentials/);
assert.doesNotMatch(content, /synthetic-private/);

const analytics = await import('./src/web/lib/analytics-client.ts');
const { posthog: sdk } = await import('posthog-js/no-external');
analytics.configureAnalytics({enabled:true, distinctId:'hosted:fixture-owner-a',deployment:'hosted',environment:'production'},'web');
sdk.set_config({request_batching:false,disable_compression:true,api_transport:'fetch'});
await new Promise(resolve => setTimeout(resolve,80));
assert.equal(sdk.sessionRecordingStarted(), true);
document.querySelector('#mutable').textContent = 'synthetic-private-recorded-mutation';
document.querySelector('input').value = 'synthetic-private-recorded-input';
document.querySelector('input').dispatchEvent(new window.Event('input', {bubbles:true}));
for (let attempt = 0; attempt < 120 && !requests.some(request => new URL(request.url).pathname === '/s/'); attempt++) await new Promise(resolve => setTimeout(resolve,50));
const recordings = requests.filter(request => new URL(request.url).pathname === '/s/').flatMap(request => JSON.parse(request.body));
assert.ok(recordings.length > 0);
assert.ok(recordings.every(event => event.event === '$snapshot' && event.properties.distinct_id === 'hosted:fixture-owner-a'));
function decodeSnapshot(value) {
  if (typeof value === 'string' && value.charCodeAt(0) === 31 && value.charCodeAt(1) === 139) return decodeSnapshot(JSON.parse(gunzipSync(Buffer.from(value,'latin1')).toString()));
  if (Array.isArray(value)) return value.map(decodeSnapshot);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,decodeSnapshot(item)]));
  return value;
}
const snapshots = recordings.flatMap(event => event.properties.$snapshot_data).map(decodeSnapshot);
assert.ok(snapshots.some(event => event.type === 2));
assert.ok(snapshots.some(event => event.type === 3));
assert.equal(snapshots.find(event => event.type === 4).data.href, 'https://otto.invalid/credentials');
assert.match(JSON.stringify(snapshots), /Settings/);
assert.doesNotMatch(JSON.stringify(snapshots), /synthetic-private/);
assert.equal(requests.filter(request => new URL(request.url).pathname.endsWith('/config')).length, 1);
assert.ok(requests.every(request => !new URL(request.url).pathname.startsWith('/flags')));
analytics.capturePageview('/credentials/synthetic-private-request?token=synthetic-private-query');
analytics.capturePageview('/credentials/synthetic-private-other?token=synthetic-private-query');
sdk.capture('otto_settings_viewed', {tab:'models', secret:'synthetic-private-event'}, {
  $set: { email: 'synthetic-private-email' }, $set_once: { name: 'synthetic-private-person' },
});
const { analyticsForCurrentSession } = await import('./src/web/lib/analytics.ts');
const pendingActionCapture = analyticsForCurrentSession();
analytics.configureAnalytics({enabled:true, distinctId:'hosted:fixture-owner-a',deployment:'hosted',environment:'production'},'web');
pendingActionCapture('otto_chat_stop_requested');
const firstSession = sdk.get_session_id();
analytics.configureAnalytics({enabled:true, distinctId:'hosted:fixture-owner-b',deployment:'hosted',environment:'production'},'web');
pendingActionCapture('otto_ui_error', {area:'chat',action:'send'});
analytics.capturePageview('/');
assert.notEqual(sdk.get_session_id(),firstSession);
const sanitize = sdk.config.before_send;
for (const value of ['synthetic-private-diagnostic', {message:'synthetic-private-error'}, -1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
  const properties = sanitize({event:'$pageview',properties:{
    $recording_status:value,
    $sdk_debug_replay_url_trigger_status:value,
    $sdk_debug_replay_event_trigger_status:value,
    $sdk_debug_replay_linked_flag_trigger_status:value,
    $sdk_debug_recording_script_not_loaded:value,
    $sdk_debug_replay_stale_config:value,
    $sdk_debug_replay_rrweb_error:value,
    $sdk_debug_rrweb_attached:value,
    $sdk_debug_rrweb_start_attempted:value,
    $sdk_debug_replay_flush_hold_reason:value,
    $session_recording_start_reason:value,
    $sdk_debug_replay_internal_buffer_length:value,
    $sdk_debug_replay_internal_buffer_size:value,
    $sdk_debug_replay_flushed_size:value,
    $sdk_debug_error_capturing_properties:value,
  }}).properties;
  assert.ok(Object.keys(properties).every(key => !key.startsWith('$sdk_debug') && key !== '$recording_status' && key !== '$session_recording_start_reason'));
}
analytics.configureAnalytics(undefined,'web');
analytics.captureAnalytics('otto_ui_error', {area:'chat',action:'send'});
await new Promise(resolve => setTimeout(resolve, 60));
const captured = requests.filter(request => request.body && new URL(request.url).pathname !== '/s/').flatMap(request => JSON.parse(request.body).batch);
assert.deepEqual(captured.map(event => event.event), ['$pageview','otto_settings_viewed','otto_chat_stop_requested','$pageview']);
assert.deepEqual(captured.map(event => event.properties.distinct_id), ['hosted:fixture-owner-a','hosted:fixture-owner-a','hosted:fixture-owner-a','hosted:fixture-owner-b']);
assert.equal(captured[0].properties.route, '/credentials');
assert.equal(captured[0].properties.$recording_status, 'active');
assert.equal(captured[0].properties.$sdk_debug_replay_rrweb_error, false);
assert.equal(captured[0].properties.$sdk_debug_rrweb_attached, true);
assert.equal(captured[0].properties.$sdk_debug_replay_url_trigger_status, 'trigger_disabled');
assert.equal(captured[0].properties.$sdk_debug_replay_event_trigger_status, 'trigger_disabled');
assert.equal(captured[0].properties.$sdk_debug_replay_linked_flag_trigger_status, 'trigger_disabled');
assert.ok(captured[0].properties.$sdk_debug_replay_internal_buffer_length >= 0);
assert.ok(captured[0].properties.$sdk_debug_replay_flushed_size > 0);
assert.equal(captured[1].properties.tab, 'models');
assert.equal(captured[3].properties.route, '/');
assert.notEqual(captured[0].properties.$session_id, captured[3].properties.$session_id);
assert.doesNotMatch(JSON.stringify(requests), /synthetic-private|\$set|\$identify|\$referrer|\$initial/);
assert.ok(captured.every(event => event.properties.$process_person_profile === false));
const { setAnalyticsClient } = await import('./src/web/lib/analytics.ts');
const failure = () => { throw new Error('Synthetic unavailable telemetry'); };
setAnalyticsClient({ stopSessionRecording() {}, reset() {}, set_config() {}, capture: failure, startSessionRecording: failure });
assert.doesNotThrow(() => analytics.configureAnalytics({enabled:true, distinctId:'hosted:fixture-owner-c',deployment:'hosted',environment:'production'},'web'));
assert.doesNotThrow(() => analytics.captureAnalytics('otto_chat_message_sent', {has_attachments:false,is_reply:false}));
assert.doesNotThrow(() => analytics.capturePageview('/'));
await new Promise(resolve => setTimeout(resolve, 30));
setAnalyticsClient({ stopSessionRecording: failure });
assert.doesNotThrow(() => analytics.configureAnalytics(undefined,'web'));
assert.doesNotThrow(() => analytics.captureAnalytics('otto_chat_stop_requested'));
const freshAnalytics = await import('./src/web/lib/analytics.ts?failure=initialization');
let failedInitializations = 0;
freshAnalytics.setAnalyticsClient({init() {failedInitializations++; failure();}, stopSessionRecording: failure});
assert.doesNotThrow(() => freshAnalytics.configureAnalytics({enabled:true, distinctId:'hosted:fixture-owner-d',deployment:'hosted',environment:'production'},'web'));
assert.equal(failedInitializations, 1);
assert.doesNotThrow(() => freshAnalytics.capturePageview('/'));
dom.window.close();
process.exit(0);

`,
  });
  assert.equal(result.exitCode, 0, result.stderr);
});
