import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
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
import { registerLocalAccess } from '../src/server/access.ts';
import { verificationCode, verificationSenderDomain } from '../src/server/email-code.ts';
import { createIntegrations } from '../src/server/integrations.ts';
import type { TurnRef } from '../src/server/thread.ts';
import {
  checkedKeyStore,
  createVault,
  credentialOrigin,
  sealCredential,
  type CredentialInjection,
} from '../src/server/vault.ts';
import type {
  CredentialRequest,
  VaultCardEntry,
  VaultLoginEntry,
} from '../src/shared/contracts.ts';
import { parsePasswordCsv } from '../src/shared/password-import.ts';
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
      await save(
        'Subdomain',
        'https://login.example.com',
        'same-second@example.test',
        'other-secret',
      );
      await save(
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
    const { app } = await start();
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

      await t.test('Nod never keeps a security code', async () => {
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
    try {
      await save('First');
      await save('Second');

      await t.test(
        'saved website URLs keep the exact origin and reject unsafe addresses',
        async () => {
          for (const [index, [url, origin]] of [
            ['https://www.example.com/uk/', 'https://www.example.com'],
            ['example.com/uk/?locale=en#login', 'https://example.com'],
            [
              ' https://accounts.example.test:8443/login?next=home#form ',
              'https://accounts.example.test:8443',
            ],
            ['http://localhost:4310/login', 'http://localhost:4310'],
          ].entries()) {
            const entry = await save(`Website ${index}`, url);
            assert.equal(entry.origin, origin);
            assert.equal((await read(entry.id, 'details')).json().origin, origin);
            assert.equal((await save(`Website ${index}`, origin)).id, entry.id);
            assert.equal(credentialOrigin(origin), origin);
            assert.throws(() => credentialOrigin(url));
          }
          const before = (await pool.query('SELECT count(*) FROM vault_entries')).rows[0].count;
          for (const origin of [
            'http://example.com/login',
            'https://user:synthetic-password@example.com/login',
            'https://user@example.com/login',
            'ftp://example.com/login',
            'https://router/login',
            'https://',
          ]) {
            const response = await app.inject({
              method: 'POST',
              url: '/api/vault',
              headers,
              payload: { label: 'Refused', origin, username: 'synthetic' },
            });
            assert.equal(response.statusCode, 400, origin);
          }
          assert.equal(
            (await pool.query('SELECT count(*) FROM vault_entries')).rows[0].count,
            before,
          );
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
            if (event.event === 'secure_entry_changed') secureEntries.push(event.properties.status);
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
    await click('.password-input-toggle');
    assert.equal(
      view.document.querySelector<HTMLInputElement>('input[name="password"]')!.type,
      'text',
    );
    await act(async () => view.document.querySelector('form')!.reset());
    const clearedPassword =
      view.document.querySelector<HTMLInputElement>('input[name="password"]')!;
    assert.equal(clearedPassword.value, '');
    assert.equal(clearedPassword.type, 'password');
    clearedPassword.value = 'synthetic-panel-password';
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
    ['/tasks/', '/tasks'],
    ['/prepared/00000000-0000-4000-8000-000000000705?private=synthetic', '/prepared'],
    ['/prepared/synthetic-private-id', '/not-found'],
    ['/prepared/00000000-0000-4000-8000-000000000705/extra', '/not-found'],
    ['/settings', '/settings'],
    ['/settings/models?private=synthetic', '/settings'],
    ['/settings/apps#synthetic', '/not-found'],
    ['/settings/memory', '/settings'],
    ['/settings/unknown-private-section', '/not-found'],
    ['/settings-typo', '/not-found'],
    ['/usage?private=synthetic#private', '/usage'],
    ['/vault?item=synthetic-private-id', '/vault'],
    ['https://private.invalid/apps?connect=synthetic-private', '/apps'],
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
    'https://app.example/payments',
  );
});

test('desktop onboarding turns on open at login once and resumes without repeating it', async () => {
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
HTMLElement.prototype.scrollTo=function(){};
window.matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){}});
let store=createSettingsStore(join(directory,'settings.json'),{});
let failRead=true;
let failSave=true;
let failLogin=false;
let saves=0;
let reads=0;
let rendererReady=0;
let delayApps=false;
let completePreparation;
let preparationCompleted=false;
let completions=0;
let statusListener;
window.nodDesktop={
  ready:async()=>{rendererReady++},
  status:async()=>({phase:'ready',runtime:{phase:'preparing'}}),
  onStatus:listener=>{statusListener=listener;return()=>{statusListener=undefined}},
  prepare:async()=>{const ready={phase:'ready',runtime:{phase:'ready'}};statusListener(ready);return ready},
  getSettings:async()=>{reads++;if(failRead)throw new Error('Synthetic native read failed');return store.get()},
  saveSettings:async change=>{saves++;if(failSave)throw new Error('Synthetic native save failed');if(failLogin&&change.launchAtLogin)return store.save({onboardingPreferenceStep:'complete'});return store.save(change)},
};
const calls=[];
window.fetch=globalThis.fetch=async(url,options={})=>{
 const path=new URL(url,window.location.href).pathname;calls.push(path);
 if(path==='/api/account/prepare')return new Promise(resolve=>{completePreparation=()=>resolve(Response.json({ok:true}))});
 if(path==='/api/models')return Response.json({connections:[{id:'synthetic',provider:'anthropic',method:'api_key',label:'Synthetic model',managed:false,status:'connected',models:[{id:'synthetic-model',name:'Synthetic model',efforts:['medium'],images:false,contextWindow:1000}]}],selection:{connectionId:'synthetic',modelId:'synthetic-model',effort:'medium'}});
 if(path==='/api/preferences')return Response.json({timeZone:'Europe/Lisbon',locale:'en-GB',hourCycle:'h23',quietHoursEnabled:false,quietStart:'22:00',quietEnd:'08:00',speechReply:'auto',speechVoice:null});
 if(path==='/api/speech')return Response.json({transcription:false,synthesis:false,voices:[],speechVoice:null,speechReply:'auto'});
 if(path==='/api/memory')return Response.json({saving:true,sensitive:false,notes:[],skills:[],archive:[]});
 if(path==='/api/configuration')return delayApps?new Promise(()=>{}):Response.json({integrationsReady:true});
 if(path==='/api/apps'||path==='/api/apps/catalog')return delayApps?new Promise(()=>{}):Response.json([]);
 if(path==='/api/onboarding/suggestions')return Response.json({ok:true});
 if(path==='/api/onboarding/profile')return Response.json({ok:true});
 throw new Error('Unexpected request '+path);
};
const {createElement,act}=await import('react');
const {createRoot}=await import('react-dom/client');
const {Onboarding}=await import('./src/web/pages/onboarding/index.tsx');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const session={user:{id:'synthetic-native-owner',name:'',email:null,avatarUrl:null},settings:{usageData:false,onboardingCompleted:false}};
let root=createRoot(document.getElementById('root'));
const render=()=>act(async()=>root.render(createElement(Onboarding,{user:session.user,onComplete:async()=>{completions++;assert.equal(preparationCompleted,true,'No completion before server preparation finishes')}})));
const settle=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))});
const waitFor=async condition=>{for(let at=0;at<100&&!(await condition());at++)await settle();assert.ok(await condition())};
const button=text=>[...document.querySelectorAll('button')].find(value=>value.textContent.trim()===text);
await render();
assert.equal(window.location.search,'');
await waitFor(()=>button('Try again'));
assert.equal(reads,1);
assert.equal(saves,0);
assert.equal(document.querySelector('[role="switch"]'),null);
failRead=false;
await act(async()=>button('Try again').click());
await waitFor(()=>document.body.textContent.includes('Synthetic native save failed'));
assert.equal(saves,1);
assert.notEqual((await store.get()).onboardingPreferenceStep,'complete');
failSave=false;
await act(async()=>button('Try again').click());
await waitFor(()=>document.querySelector('main [role="status"]'));
assert.equal((await store.get()).launchAtLogin,true);
assert.equal((await store.get()).notifications,false,'onboarding does not request notification permission');
assert.equal((await store.get()).onboardingPreferenceStep,'complete');
assert.equal(saves,2);
await act(async()=>root.unmount());
store=createSettingsStore(join(directory,'settings.json'),{});
root=createRoot(document.getElementById('root'));
await render();
await waitFor(()=>document.querySelector('main [role="status"]'));
assert.equal(document.querySelector('[role="switch"]'),null);
assert.equal(saves,2,'a completed native step is never written again');
await act(async()=>root.unmount());
await store.save({onboardingCompleted:true});
const {AccountSettings}=await import('./src/web/components/account-settings.tsx');
window.nodDesktop.onPreferences=()=>()=>{};
const account={user:session.user,theme:'system',usageData:false,saving:false,onSettings(){},async onTheme(){},async onUsageData(){},async onTraces(){}};
root=createRoot(document.getElementById('root'));
await act(async()=>root.render(createElement(AccountSettings,{account,open:true,initialTab:'General',openRequest:0,onOpenChange(){}})));
const login=()=>document.querySelector('[role="switch"][aria-label="Open at login"]');
const notices=()=>document.querySelector('[role="switch"][aria-label="Notifications"]');
await waitFor(()=>login()&&notices()&&!login().disabled&&!notices().disabled);
assert.equal(login().getAttribute('aria-checked'),'true');
assert.equal(notices().getAttribute('aria-checked'),'false');
await act(async()=>login().click());
await waitFor(()=>!login().disabled);
await act(async()=>notices().click());
await waitFor(()=>!notices().disabled);
assert.equal((await store.get()).launchAtLogin,false);
assert.equal((await store.get()).notifications,true);
assert.equal((await store.get()).onboardingPreferenceStep,'complete');
failSave=true;
await act(async()=>login().click());
await waitFor(()=>!login().disabled);
assert.equal(login().getAttribute('aria-checked'),'false');
assert.equal((await store.get()).launchAtLogin,false);
failSave=false;
await act(async()=>root.unmount());
const blockedPath=join(directory,'blocked-settings.json');
store=createSettingsStore(blockedPath,{});
failLogin=true;
const beforeBlocked=saves;
root=createRoot(document.getElementById('root'));
await render();
await waitFor(async()=>(await store.get()).onboardingPreferenceStep==='complete');
assert.equal(saves,beforeBlocked+1);
assert.equal((await store.get()).launchAtLogin,false);
assert.equal((await store.get()).onboardingPreferenceStep,'complete');
await act(async()=>root.unmount());
store=createSettingsStore(blockedPath,{});
root=createRoot(document.getElementById('root'));
await render();
await waitFor(()=>document.querySelector('main [role="status"]'));
assert.equal(saves,beforeBlocked+1);
await store.save({onboardingCompleted:true});
assert.equal((await store.get()).onboardingCompleted,true);
assert.equal((await store.get()).launchAtLogin,false);
await act(async()=>root.unmount());
assert.equal(calls.some(path=>path.startsWith('/api/desktop/setup')),false);
store=createSettingsStore(join(directory,'pending-runtime-settings.json'),{});
failLogin=false;
delayApps=true;
rendererReady=0;
sessionStorage.clear();
document.cookie='nod_onboarding_step=; path=/; max-age=0';
window.history.replaceState(null,'','/onboarding?welcome=complete');
root=createRoot(document.getElementById('root'));
await render();
await waitFor(()=>document.querySelector('[data-step="email"]'));
assert.ok(rendererReady>0,'The email screen must become visible before account discovery finishes');
assert.equal(button('Skip for now').disabled,false);
await act(async()=>button('Skip for now').click());
await waitFor(()=>document.querySelector('[data-step="about"]'));
for(let at=0;at<10&&!document.querySelector('[data-step="privacy"]');at++){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,1000))});if(button('Not now'))await act(async()=>button('Not now').click())}
await waitFor(()=>document.querySelector('[data-step="privacy"]'));
assert.ok(calls.includes('/api/onboarding/profile'));
await act(async()=>button('Continue').click());
await waitFor(()=>document.querySelector('[data-step="join"]'));
await act(async()=>button('Continue').click());
await waitFor(()=>document.querySelector('.setup-progress [role="status"]'));
assert.equal((await store.get()).onboardingPreferenceStep,'complete');
assert.equal(completions,0);
await act(async()=>statusListener({phase:'ready',runtime:{phase:'ready'}}));
await settle();
assert.equal(completions,0,'Desktop readiness must not complete onboarding before server preparation');
assert.ok(document.querySelector('.setup-progress [role="status"]'));
await act(async()=>{preparationCompleted=true;completePreparation()});
await waitFor(()=>completions===1);
await settle();
assert.equal(completions,1);
await act(async()=>root.unmount());
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

test('visible outputs keep private content out of analytics and fence delayed file actions', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 60_000,
    input: String.raw`
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><div id="root"></div>', {url:'http://127.0.0.1:51000/',pretendToBeVisual:true});
for (const name of ['window','document','Node','Element','HTMLElement','HTMLInputElement','HTMLButtonElement','Event','CustomEvent','KeyboardEvent','MouseEvent','MutationObserver','getComputedStyle','sessionStorage']) Object.defineProperty(globalThis,name,{configurable:true,value:name==='window'?dom.window:name==='document'?dom.window.document:typeof dom.window[name]==='function'&&name[0]===name[0].toLowerCase()?dom.window[name].bind(dom.window):dom.window[name]});
Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator});
globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.location=window.location;
globalThis.ResizeObserver=class{observe(){}disconnect(){}};
HTMLElement.prototype.scrollIntoView=function(){};
window.matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){}});
const observers=new Set();
globalThis.IntersectionObserver=class{
 constructor(callback){this.callback=callback;this.targets=new Set();observers.add(this)}
 observe(target){this.targets.add(target)}
 disconnect(){this.targets.clear();observers.delete(this)}
};
const visible=(selector)=>{for(const observer of observers){const targets=[...observer.targets].filter(target=>target.matches(selector));if(targets.length)observer.callback(targets.map(target=>({target,isIntersecting:true})))}};
const events=[];
const client={
 init(_key,options){this.options=options;options.loaded?.()},
 capture(event,properties={}){const value=this.options.before_send({event,properties});if(value)events.push(value)},
 reset(){},set_config(){},stopSessionRecording(){},startSessionRecording(){},
};
const {setAnalyticsClient,configureAnalytics,analyticsForCurrentSession}=await import('./src/web/lib/analytics.ts');
const {setRequestAccount}=await import('./src/web/lib/api.ts');
const {createElement,act}=await import('react');
const {createRoot}=await import('react-dom/client');
const {MessagePresentation}=await import('./src/web/components/message-presentation.tsx');
const {ArtifactWorkspace}=await import('./src/web/components/artifact-drawer.tsx');
const {MessageAttachments,conversationFiles}=await import('./src/web/components/attachment-card.tsx');
const {FileActions}=await import('./src/web/components/file-actions.tsx');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
setRequestAccount('synthetic-owner-one');
setAnalyticsClient(client);
const configuration={enabled:true,distinctId:'local:synthetic-owner-one',environment:'development'};
configureAnalytics(configuration,'web');
const checks=[];
const check=(id,condition)=>checks.push({id,status:condition?'pass':'fail'});
const privateValue='SYNTHETIC_PRIVATE_CANARY_89271';
const common={version:1,title:privateValue,sources:[]};
const chart={...common,type:'chart',chart:'bar',series:[{id:'private-series',label:privateValue,points:[{label:privateValue,value:89271}]}]};
const diagram={...common,type:'diagram',nodes:[{id:'private-node',label:privateValue}],edges:[]};
let root=createRoot(document.getElementById('root'));
const render=element=>act(async()=>root.render(element));
const count=name=>events.filter(event=>event.event===name).length;
await render(createElement(MessagePresentation,{value:chart,messageId:'private-message'}));
check('UI2-not-mounted',count('presentation_viewed')===0);
await act(async()=>visible('.message-presentation'));
await render(createElement(MessagePresentation,{value:chart,messageId:'private-message'}));
await act(async()=>visible('.message-presentation'));
check('UI2-once',count('presentation_viewed')===1);
Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
await render(createElement(MessagePresentation,{value:diagram,messageId:'private-other-message'}));
await act(async()=>visible('.message-presentation'));
check('UI2-hidden-tab',count('presentation_viewed')===1);
Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
await act(async()=>document.dispatchEvent(new Event('visibilitychange')));
check('UI2-holdout',events.filter(event=>event.event==='presentation_viewed').map(event=>event.properties.kind).join(',')==='chart,diagram');
const file={id:'00000000-0000-4000-8000-000000000001',url:'/api/artifacts/00000000-0000-4000-8000-000000000001',name:privateValue+'.txt',size:12,mimeType:'text/plain'};
window.fetch=globalThis.fetch=async()=>new Response('Private file', {headers:{'content-type':'text/plain'}});
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{}}});
const files=()=>createElement(ArtifactWorkspace,{files:[file],className:'test-workspace'},createElement(MessageAttachments,{attachments:[file]}));
await render(files());
await act(async()=>visible('.attachment-card'));
check('UI3-message-exposure',events.filter(event=>event.event==='artifact_viewed'&&event.properties.location==='message').length===1);
await act(async()=>document.querySelector('.attachment-card-open').click());
await act(async()=>visible('.artifact-drawer'));
check('UI3-drawer-open',events.filter(event=>event.event==='artifact_viewed'&&event.properties.location==='drawer').length===1);
await act(async()=>document.querySelector('button[aria-label="Copy contents"]').click());
check('UI4-copy',events.some(event=>event.event==='artifact_action'&&event.properties.action==='copy'&&event.properties.kind==='text'));
await act(async()=>document.querySelector('.artifact-drawer').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
const drawer=document.querySelector('.artifact-drawer');
check('UI3-retained-hidden',drawer?.hidden===true);
const beforeHidden=count('artifact_viewed');
await act(async()=>visible('.artifact-drawer'));
check('UI3-hidden-no-exposure',count('artifact_viewed')===beforeHidden);
let rejectSave=false;
let release;
window.nodDesktop={fileAction:async()=>{if(rejectSave)throw new Error('Synthetic save failed');if(release===null)await new Promise(resolve=>{release=resolve})}};
await render(createElement(FileActions,{item:file}));
const save=()=>document.querySelector('button[aria-label^="Save "]');
await act(async()=>save().click());
check('UI4-native-save',events.filter(event=>event.event==='artifact_action'&&event.properties.action==='download').length===1);
rejectSave=true;
await act(async()=>save().click());
check('UI4-rejected-save',events.filter(event=>event.event==='artifact_action'&&event.properties.action==='download').length===1);
rejectSave=false;release=null;
await act(async()=>save().click());
configureAnalytics(undefined);
configureAnalytics(configuration,'web');
await act(async()=>release());
check('UI5-consent-fence',events.filter(event=>event.event==='artifact_action'&&event.properties.action==='download').length===1);
release=null;
await act(async()=>save().click());
setRequestAccount('synthetic-owner-two');
await act(async()=>release());
check('UI5-owner-fence',events.filter(event=>event.event==='artifact_action'&&event.properties.action==='download').length===1);
check('UI2-content-free',!JSON.stringify(events).includes(privateValue)&&!JSON.stringify(events).includes(file.id)&&!JSON.stringify(events).includes('private-message'));
setRequestAccount('synthetic-owner-one');
configureAnalytics(configuration,'web');
client.capture('answer_choices_selected',{multiple:true,option_count:3,selected_count:2,label:privateValue,choice_ids:[file.id]});
check('UI7-choices-bounded',events.at(-1).properties.option_count===3&&events.at(-1).properties.selected_count===2&&!JSON.stringify(events.at(-1)).includes(privateValue)&&!JSON.stringify(events.at(-1)).includes(file.id));

const presentationMessage={id:'private-presentation-message',attachments:[],presentation:chart};
const presentationWorkspace=()=>createElement(ArtifactWorkspace,{files:conversationFiles([presentationMessage]),className:'test-workspace'},createElement(MessagePresentation,{value:chart,messageId:presentationMessage.id}));
await render(presentationWorkspace());
const beforePresentation=count('presentation_viewed');
await act(async()=>visible('.message-presentation'));
check('UI8-presentation-message',count('presentation_viewed')===beforePresentation+1);
await act(async()=>document.querySelector('.presentation-expand').click());
check('UI8-presentation-open',events.filter(event=>event.event==='presentation_action'&&event.properties.action==='open'&&event.properties.kind==='chart'&&event.properties.location==='message').length===1);
const beforeArtifact=count('artifact_viewed');
await act(async()=>{visible('.artifact-drawer');visible('.artifact-drawer .message-presentation')});
check('UI8-presentation-dedupe',count('presentation_viewed')===beforePresentation+1);
check('UI8-presentation-not-file',count('artifact_viewed')===beforeArtifact);
const copyContents=()=>document.querySelector('button[aria-label="Copy contents"],button[aria-label="Copied"]');
const presentationCopies=()=>events.filter(event=>event.event==='presentation_action'&&event.properties.action==='copy').length;
await act(async()=>copyContents().click());
check('UI8-presentation-copy',presentationCopies()===1&&events.at(-1).properties.kind==='chart'&&events.at(-1).properties.location==='drawer');
navigator.clipboard.writeText=async()=>{throw new Error('Synthetic clipboard rejected')};
await act(async()=>copyContents().click());
check('UI8-presentation-copy-failure',presentationCopies()===1);
let releaseCopy;
navigator.clipboard.writeText=()=>new Promise(resolve=>{releaseCopy=resolve});
await act(async()=>copyContents().click());
configureAnalytics(undefined);configureAnalytics(configuration,'web');
await act(async()=>releaseCopy());
check('UI8-presentation-copy-consent',presentationCopies()===1);
releaseCopy=undefined;
await act(async()=>copyContents().click());
setRequestAccount('synthetic-another-owner');
await act(async()=>releaseCopy());
check('UI8-presentation-copy-owner',presentationCopies()===1);
setRequestAccount('synthetic-owner-one');configureAnalytics(configuration,'web');
const beforeInvalid=count('presentation_action');
client.capture('presentation_action',{kind:'chart',action:'copy'});
client.capture('presentation_action',{kind:'private-new-kind',action:'copy',location:'drawer'});
check('UI8-presentation-bounded',count('presentation_action')===beforeInvalid);
check('UI8-presentation-private',!JSON.stringify(events).includes(privateValue)&&!JSON.stringify(events).includes(presentationMessage.id));

await act(async()=>root.unmount());
configureAnalytics(undefined);
dom.window.close();
console.log(JSON.stringify({checks,events:events.filter(event=>!event.event.startsWith('$'))},null,2));
assert.ok(checks.every(check=>check.status==='pass'),checks.filter(check=>check.status==='fail').map(check=>check.id).join(', '));
process.exit(0);
`,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
});

test('app completion analytics preserve the originating entry and require an owned confirmed result', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 30_000,
    input: String.raw`
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://127.0.0.1:51000/',pretendToBeVisual:true});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)});
for(const name of ['Node','Element','HTMLElement','Event','CustomEvent'])globalThis[name]=dom.window[name];
Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator});
const channels=[];
globalThis.BroadcastChannel=class{constructor(){channels.push(this)}close(){}};
window.open=()=>({opener:null,closed:false,close(){this.closed=true},location:{href:''}});
const {createElement,act}=await import('react');
const {createRoot}=await import('react-dom/client');
const {useAppSignIn}=await import('./src/web/hooks/use-app-sign-in.ts');
const {setAnalyticsClient,configureAnalytics}=await import('./src/web/lib/analytics.ts');
const {setRequestAccount}=await import('./src/web/lib/api.ts');
setRequestAccount('connection-owner');
const captured=[];
const client={init(_key,options){this.options=options},capture(event,properties={}){const value=this.options.before_send({event,properties});if(value)captured.push(value)},reset(){},set_config(){},stopSessionRecording(){},startSessionRecording(){}};
setAnalyticsClient(client);configureAnalytics({enabled:true,distinctId:'local:connection-owner',environment:'development'},'web');
const attempt='a'.repeat(43);
let connected=false,checks=0,delay=false,release;
window.fetch=globalThis.fetch=async(path,options)=>{
 if(path==='/api/apps/gmail/connect')return Response.json({url:'https://example.test/sign-in',attempt});
 if(path==='/api/apps/setup-cancel')return Response.json({ok:true});
 assert.equal(path,'/api/apps/setup-status');checks++;
 const hash=JSON.parse(options.body).hashes[0];
 const response=()=>Response.json({completed:connected?[hash]:[],apps:[{hash,available:true}]});
 if(delay)return new Promise(resolve=>{release=()=>resolve(response())});
 return response();
};
let signIn;
function Test(){signIn=useAppSignIn({entry:'onboarding',name:()=> 'Private account',onSettled(){}});return createElement('button',{onClick:()=>void signIn.connect({service:'gmail'})},'Connect')}
const root=createRoot(document.getElementById('root'));
await act(async()=>root.render(createElement(Test)));
const settle=async condition=>{for(let i=0;i<60&&!condition();i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10))});assert.ok(condition())};
const start=()=>act(async()=>document.querySelector('button').click());
const completions=()=>captured.filter(event=>event.event==='app_connection_completed');
await start();await settle(()=>checks===1);assert.equal(completions().length,0);
await act(async()=>channels[0].onmessage({data:{connection:'connected',service:'gmail',attempt}}));
await settle(()=>checks===2);assert.equal(completions().length,0,'an unverified broadcast must not become a successful conversion');
await start();await settle(()=>checks===3);await act(async()=>signIn.cancel());assert.equal(completions().length,0);
connected=true;await start();await settle(()=>completions().length===1);
assert.deepEqual(completions()[0].properties.entry,'onboarding');
delay=true;release=undefined;await start();await settle(()=>release);
setRequestAccount('other-owner');await act(async()=>release());assert.equal(completions().length,1);
await act(async()=>root.unmount());configureAnalytics(undefined);dom.window.close();
console.log(JSON.stringify({result:'pass',checks:['confirmed-success','original-entry','unverified-broadcast','cancelled-attempt','owner-fence'],events:captured},null,2));
process.exit(0);
`,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
});

test('app discovery redirects and managed chat links preserve confirmed connection attribution', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 30_000,
    input: String.raw`
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:51000/', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
for (const name of ['Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Event', 'KeyboardEvent', 'CustomEvent', 'MutationObserver', 'NodeFilter', 'DocumentFragment', 'FormData']) globalThis[name] = dom.window[name];
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
window.open = () => ({ opener: null, closed: false, close() { this.closed = true; }, document: { title: '', body: { textContent: '' } }, location: { href: '' } });
globalThis.BroadcastChannel = class { close() {} };
const { createElement, act, useState, StrictMode } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useAppSignIn } = await import('./src/web/hooks/use-app-sign-in.ts');
const { AppDiscoveryDialog } = await import('./src/web/components/app-discovery-dialog.tsx');
const { SetupActions } = await import('./src/web/components/setup-link.tsx');
const { setAnalyticsClient, configureAnalytics, appConnectionAnalytics } = await import('./src/web/lib/analytics.ts');
const { setRequestAccount } = await import('./src/web/lib/api.ts');
const captured = [];
const client = { init(_key, options) { this.options = options; }, capture(event, properties = {}) { const value = this.options.before_send({ event, properties }); if (value) captured.push(value); }, reset() {}, set_config() {}, stopSessionRecording() {}, startSessionRecording() {} };
setAnalyticsClient(client);
function owner(id) { setRequestAccount(id); configureAnalytics({ enabled: true, distinctId: 'local:' + id, environment: 'development' }, 'web'); }
owner('discovery-one');
const id = '00000000-0000-4000-8000-000000000811';
let reject = true, delayed = false, release, statusCalls = 0, completed = false, wrongHash = false;
window.fetch = globalThis.fetch = async (path, options) => {
  if (path === '/api/apps/gmail/connect') return Response.json({ url: 'http://127.0.0.1:51000/apps?connect=' + id });
  if (path === '/api/apps/discovery/' + id) return Response.json({ name: 'Synthetic app', paths: [{ kind: 'http', endpoint: 'https://example.test', auth: 'token', testPath: '/me' }] });
  if (path === '/api/apps/discovery/' + id + '/complete') {
    if (delayed) return new Promise((resolve) => { release = () => resolve(Response.json({})); });
    return reject ? Response.json({ error: 'Synthetic rejection' }, { status: 503 }) : Response.json({});
  }
  assert.equal(path, '/api/apps/setup-status');
  statusCalls++;
  const hashes = JSON.parse(options.body).hashes;
  return Response.json({ completed: completed ? (wrongHash ? ['unmatched-hash'] : hashes) : [], apps: hashes.map((hash) => ({ hash, slug: 'gmail', name: 'Synthetic app', available: true })) });
};
function Redirect() {
  const [discovery, setDiscovery] = useState();
  const signIn = useAppSignIn({ entry: 'chat', name: () => 'Synthetic app', onSettled() {}, onSetup: (url) => setDiscovery(new URL(url, window.location.origin).searchParams.get('connect')) });
  return discovery ? createElement(AppDiscoveryDialog, { id: discovery, onClose: () => setDiscovery(undefined), onConnected: () => setDiscovery(undefined) }) : createElement('button', { onClick: () => void signIn.connect({ service: 'gmail' }) }, 'Start connection');
}
const root = createRoot(document.getElementById('root'));
const render = (value) => act(async () => root.render(createElement(StrictMode, null, value)));
const settle = async (condition) => { for (let i = 0; i < 80 && !condition(); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); assert.ok(Boolean(condition()), 'observable condition did not occur'); };
const button = (text) => [...document.querySelectorAll('button')].find((value) => value.textContent.trim() === text);
const completions = () => captured.filter((event) => event.event === 'app_connection_completed');
const submit = () => act(async () => {
  document.querySelector('[name="accountName"]').value = 'Synthetic account';
  document.querySelector('[name="token"]').value = 'synthetic-token';
  document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
});
await render(createElement(Redirect));
await act(async () => button('Start connection').click());
await settle(() => document.querySelector('form'));
assert.equal(completions().length, 0);
await submit();
assert.equal(completions().length, 0);
assert.ok(document.body.textContent.includes('Synthetic rejection'));
reject = false;
await submit();
assert.equal(completions().length, 1);
assert.equal(completions()[0].properties.entry, 'chat');
await render(null);
appConnectionAnalytics('manage').transfer('00000000-0000-4000-8000-000000000812');
await render(createElement(AppDiscoveryDialog, { id, onClose() {}, onConnected() {} }));
await settle(() => document.querySelector('form'));
await submit();
assert.equal(completions().at(-1).properties.entry, 'apps');
await render(null);
const href = 'https://example.test/owned-setup';
await render(createElement(SetupActions, { actions: [{ href, setup: 'app', label: 'Synthetic app' }] }));
await settle(() => statusCalls > 0 && button('Connect'));
const beforeManaged = completions().length;
await act(async () => button('Connect').click());
assert.equal(completions().length, beforeManaged);
completed = true; wrongHash = true;
await act(async () => window.dispatchEvent(new Event('focus')));
assert.equal(completions().length, beforeManaged);
wrongHash = false;
await act(async () => window.dispatchEvent(new Event('focus')));
await settle(() => completions().length === beforeManaged + 1);
assert.equal(completions().at(-1).properties.entry, 'chat');
await act(async () => window.dispatchEvent(new Event('focus')));
assert.equal(completions().length, beforeManaged + 1);
await render(null);
appConnectionAnalytics('manage').transfer(id);
await render(createElement(AppDiscoveryDialog, { id, onClose() {}, onConnected() {} }));
await settle(() => document.querySelector('form'));
delayed = true; await submit(); await settle(() => release);
const beforeOwner = completions().length;
owner('discovery-two');
await act(async () => release());
assert.equal(completions().length, beforeOwner);
await render(null);
appConnectionAnalytics('manage').transfer(id);
await render(createElement(AppDiscoveryDialog, { id, onClose() {}, onConnected() {} }));
await settle(() => document.querySelector('form'));
release = undefined; await submit(); await settle(() => release);
configureAnalytics(undefined);
await act(async () => release());
assert.equal(completions().length, beforeOwner);
await act(async () => root.unmount()); dom.window.close();
console.log(JSON.stringify({ result: 'pass', checks: ['chat-discovery-origin', 'rejected-discovery', 'wrong-discovery-id', 'managed-chat-confirmed', 'wrong-completion-hash', 'completion-once', 'owner-fence', 'consent-fence'], events: captured }, null, 2));
process.exit(0);
`,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
});

test('feedback reconciles an uncertain submission and fences a discarded status check', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: 'http://127.0.0.1:51000/',
  pretendToBeVisual: true,
});
for (const name of ['Node', 'NodeFilter', 'DocumentFragment', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'File', 'FileReader']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  indexedDB: new IDBFactory(),
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
HTMLElement.prototype.scrollIntoView = function () {};
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });

const ownerId = 'synthetic-feedback-owner';
const pendingKey = 'nod.feedback.pending.' + ownerId;
window.localStorage.setItem('nod.feedback.report.' + ownerId, 'false');
const { saveFeedbackDraft, readFeedbackPending } = await import('./src/web/lib/feedback-draft.ts');
await saveFeedbackDraft(ownerId, {
  category: 'bug',
  feedback: 'Synthetic delivery result was lost.',
  attachments: [],
  pendingId: null,
  reportChoice: false,
});
const { setRequestAccount } = await import('./src/web/lib/api.ts');
setRequestAccount(ownerId);
let posts = 0;
let statusChecks = 0;
let submissionId;
globalThis.fetch = async (path, options) => {
  if (path === '/api/feedback/context')
    return Response.json({ enabled: true, recipient: 'Synthetic feedback service', appVersion: '1.0', appRelease: null, appModified: false, platform: 'darwin', development: false, source: 'local-web' });
  if (path === '/api/feedback') {
    posts++;
    submissionId = JSON.parse(options.body).submissionId;
    return Response.json({ submissionId, status: 'unknown' });
  }
  assert.equal(path, '/api/feedback/' + submissionId);
  statusChecks++;
  return Response.json(statusChecks === 1
    ? { submissionId, status: 'unknown', message: 'Delivery is still being confirmed.' }
    : { submissionId, status: 'submitted', issueUrl: 'https://linear.app/n8n/issue/LAB-1000/synthetic-feedback' });
};

const nativeSetTimeout = globalThis.setTimeout;
let reopened = false;
const pollDelay = (delay) => reopened && posts === 1 && statusChecks < 2 && (delay === 2000 || delay >= 8000) ? 10 : delay;
globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, pollDelay(delay), ...args);

const { createElement, act, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { FeedbackDialog } = await import('./src/web/components/feedback.tsx');
let setDialogOpen;
function Fixture() {
  const [open, setOpen] = useState(true);
  setDialogOpen = setOpen;
  return createElement(FeedbackDialog, { ownerId, open, onOpenChange: setOpen, returnFocus: () => null });
}
let root = createRoot(document.getElementById('root'));
await act(async () => root.render(createElement(Fixture)));
const submit = () => document.querySelector('.feedback-form button[type="submit"]');
const settle = async (condition) => {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++)
    await act(async () => new Promise((resolve) => nativeSetTimeout(resolve, 10)));
  assert.ok(condition(), 'Feedback did not reconcile its submission: posts=' + posts + ', checks=' + statusChecks + ', pending=' + readFeedbackPending(pendingKey));
};
await settle(() => submit() && !submit().disabled);
await act(async () => submit().click());
await settle(() => posts === 1 && readFeedbackPending(pendingKey));
assert.equal(submit().disabled, true);
await act(async () => root.unmount());
assert.equal(statusChecks, 0);
reopened = true;
root = createRoot(document.getElementById('root'));
await act(async () => root.render(createElement(Fixture)));
await settle(() => statusChecks >= 2 && !readFeedbackPending(pendingKey));
assert.equal(posts, 1);
await act(async () => root.unmount());

const discardedId = '00000000-0000-4000-8000-000000000704';
await saveFeedbackDraft(ownerId, {
  category: 'bug',
  feedback: 'Synthetic draft with an uncertain result.',
  attachments: [],
  pendingId: discardedId,
  reportChoice: false,
});
window.localStorage.setItem(pendingKey, discardedId);
const previousFetch = globalThis.fetch;
let releaseStatus;
globalThis.fetch = (path, options) => path === '/api/feedback/' + discardedId
  ? new Promise((resolve) => { releaseStatus = () => resolve(Response.json({ submissionId: discardedId, status: 'unknown' })); })
  : previousFetch(path, options);
root = createRoot(document.getElementById('root'));
await act(async () => root.render(createElement(Fixture)));
const footerDiscard = () => document.querySelector('.feedback-footer-actions button');
const statusButton = () => document.querySelector('.feedback-form > .feedback-send-notice[role="alert"] > button.feedback-text-action');
const confirmDiscard = () => document.querySelector('.feedback-draft-actions button:last-child');
const closeButton = () => document.querySelector('.feedback-dialog > .dialog-close');
await settle(() => statusButton());
await act(async () => statusButton().click());
await settle(() => releaseStatus);
await act(async () => closeButton().click());
assert.equal(document.querySelector('.feedback-dialog'), null);
const firstStatus = releaseStatus;
await act(async () => firstStatus());
assert.equal(readFeedbackPending(pendingKey), discardedId);
releaseStatus = undefined;
await act(async () => setDialogOpen(true));
await settle(() => statusButton() && !statusButton().disabled);
await act(async () => statusButton().click());
await settle(() => releaseStatus);
assert.equal(footerDiscard().disabled, false);
await act(async () => footerDiscard().click());
await act(async () => confirmDiscard().click());
await settle(() => !readFeedbackPending(pendingKey));
await act(async () => releaseStatus());
assert.equal(readFeedbackPending(pendingKey), null);
assert.equal(posts, 1);
await act(async () => root.unmount());
dom.window.close();
console.log(JSON.stringify({ posts, statusChecks, pending: readFeedbackPending(pendingKey) }));
process.exit(0);
`,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
});

test('local settings and successful UI actions preserve consent and owner boundaries', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 60_000,
    input: String.raw`
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://127.0.0.1:51000/',pretendToBeVisual:true});
for(const name of ['window','document','Node','NodeFilter','DocumentFragment','Element','HTMLElement','HTMLInputElement','HTMLTextAreaElement','HTMLButtonElement','Event','CustomEvent','KeyboardEvent','MouseEvent','MutationObserver','getComputedStyle','sessionStorage'])Object.defineProperty(globalThis,name,{configurable:true,value:name==='window'?dom.window:name==='document'?dom.window.document:typeof dom.window[name]==='function'&&name[0]===name[0].toLowerCase()?dom.window[name].bind(dom.window):dom.window[name]});
Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator});
globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.location=window.location;
globalThis.ResizeObserver=class{observe(){}disconnect(){}};
HTMLElement.prototype.scrollIntoView=function(){};
window.matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){}});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createElement,act}=await import('react');
const {createRoot}=await import('react-dom/client');
const {setAnalyticsClient,configureAnalytics}=await import('./src/web/lib/analytics.ts');
const {setRequestAccount}=await import('./src/web/lib/api.ts');
const events=[];
const client={init(_key,options){this.options=options;options.loaded?.()},capture(event,properties={}){const item=this.options.before_send({event,properties});if(item)events.push(item)},reset(){},set_config(){},stopSessionRecording(){},startSessionRecording(){}};
setAnalyticsClient(client);
const config={enabled:true,distinctId:'local:synthetic-settings-owner',environment:'development'};
const restore=()=>{setRequestAccount('synthetic-settings-owner');configureAnalytics(config,'web')};
restore();
const keepAlive=setInterval(()=>{},1000);
try {
const checks=[];
const check=(id,value)=>checks.push({id,status:value?'pass':'fail'});
const count=(name)=>events.filter(item=>item.event===name).length;
let root=createRoot(document.getElementById('root'));
const render=element=>act(async()=>root.render(element));
const settle=()=>act(async()=>new Promise(resolve=>setTimeout(resolve,5)));
const waitFor=async condition=>{for(let at=0;at<60&&!condition();at++)await settle();assert.ok(condition(),'fixture settled')};
const click=element=>act(async()=>element.click());
const button=text=>[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===text);
const remount=async element=>{await act(async()=>root.unmount());root=createRoot(document.getElementById('root'));await render(element)};
let persisted={theme:'system',resolvedTheme:'light',notifications:false,launchAtLogin:false,onboardingPreferenceStep:'complete'};
let nativeMode='ok',releaseNative;
window.nodDesktop={getSettings:async()=>({...persisted}),onPreferences:()=>()=>{},saveSettings:async change=>{if(nativeMode==='fail')throw new Error('Synthetic native failure');if(nativeMode==='hold')await new Promise(resolve=>releaseNative=resolve);if(nativeMode!=='ignore')persisted={...persisted,...change};return {...persisted}}};
const {useDesktopSettings}=await import('./src/web/components/desktop-settings.tsx');
let native;
function Native(){native=useDesktopSettings();return null}
await render(createElement(Native));await waitFor(()=>native.settings);
for(const change of [{theme:'dark'},{launchAtLogin:true},{notifications:true}])await act(async()=>native.save(change));
check('LS1-saved',count('local_setting_changed')===3);
const nativeCount=count('local_setting_changed');
await act(async()=>native.save({theme:'dark'}));
nativeMode='fail';await act(async()=>native.save({theme:'light'}).catch(()=>{}));
nativeMode='ignore';await act(async()=>native.save({theme:'light'}));
check('LS2-no-op-failure-ignored',count('local_setting_changed')===nativeCount);
nativeMode='hold';let saved;
await act(async()=>{saved=native.save({theme:'light'})});
setRequestAccount('synthetic-another-owner');await act(async()=>{releaseNative();await saved});
check('LS3-owner-fence',count('local_setting_changed')===nativeCount);
restore();await act(async()=>{saved=native.save({theme:'system'})});
configureAnalytics(undefined);configureAnalytics(config,'web');
await act(async()=>{releaseNative();await saved});
check('LS3-consent-fence',count('local_setting_changed')===nativeCount);
nativeMode='ok';delete window.nodDesktop;
let permission='granted',releasePermission,permissionRequests=0;
class SyntheticNotification{static get permission(){return permission}static requestPermission(){permissionRequests++;return new Promise(resolve=>releasePermission=value=>{permission=value;resolve(value)})}close(){this.onclose?.()}}
window.Notification=SyntheticNotification;
Object.defineProperty(window,'isSecureContext',{configurable:true,value:true});
Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_key,...args)=>args.at(-1)({})}});
let owner='synthetic-settings-owner';
let handoffMode='fail',releaseHandoff;
window.fetch=globalThis.fetch=async(url,options={})=>{
 const path=new URL(url,window.location.href).pathname;
 if(path==='/api/session')return Response.json({user:{id:owner,name:'',email:null,avatarUrl:null},settings:{theme:'system',onboardingCompleted:true,usageData:true,traces:false},capabilities:{developer:true,traces:true},analytics:config});
 if(path==='/api/browser-handoff/stream')return new Promise((_resolve,reject)=>options.signal?.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
 if(path==='/api/browser-handoff/done'){if(handoffMode==='hold')await new Promise(resolve=>releaseHandoff=resolve);return Response.json(handoffMode==='fail'?{error:'Synthetic handoff failure'}:{ok:true},{status:handoffMode==='fail'?500:200})}
 throw new Error('Unexpected fixture route '+path);
};
const {sessionStore}=await import('./src/web/lib/session.ts');
await sessionStore.refresh();restore();
const {BrowserNotificationSettings,BrowserNotificationPrompt}=await import('./src/web/components/browser-notifications.tsx');
const notice=()=>document.querySelector('[role="switch"][aria-label="Notifications"]');
await remount(createElement(BrowserNotificationSettings,{ownerId:owner}));
const startNotifications=count('local_setting_changed');
await click(notice());check('BN1-enabled',count('local_setting_changed')===startNotifications+1);
await click(button('Send test notification'));check('BN1-test-not-change',count('local_setting_changed')===startNotifications+1);
await click(notice());check('BN1-disabled',count('local_setting_changed')===startNotifications+2);
window.localStorage.removeItem('nod.browser-notifications.'+owner);
await remount(createElement(BrowserNotificationPrompt,{ownerId:owner}));
await click(button('Not now'));check('BN1-dismissed',count('local_setting_changed')===startNotifications+3);
await remount(createElement(BrowserNotificationSettings,{ownerId:owner}));
permission='default';await click(notice());await waitFor(()=>releasePermission);
check('BN2-denied-trigger',permissionRequests===1&&notice().disabled);
await act(async()=>releasePermission('denied'));
check('BN2-denied',permission==='denied'&&notice().disabled&&count('local_setting_changed')===startNotifications+3);
permission='default';await remount(createElement(BrowserNotificationSettings,{ownerId:owner}));
assert.equal(notice().disabled,false);
releasePermission=undefined;await click(notice());await waitFor(()=>releasePermission);
check('BN2-consent-trigger',permissionRequests===2&&permission==='default'&&notice().disabled);
configureAnalytics(undefined);configureAnalytics(config,'web');await act(async()=>releasePermission('granted'));
check('BN2-consent-fence',permission==='granted'&&window.localStorage.getItem('nod.browser-notifications.'+owner)==='enabled'&&count('local_setting_changed')===startNotifications+3);
permission='default';window.localStorage.removeItem('nod.browser-notifications.'+owner);
await remount(createElement(BrowserNotificationSettings,{ownerId:owner}));
assert.equal(notice().disabled,false);
releasePermission=undefined;await click(notice());await waitFor(()=>releasePermission);
check('BN2-owner-trigger',permissionRequests===3&&permission==='default'&&notice().disabled);
owner='synthetic-another-owner';await act(async()=>sessionStore.refresh());await act(async()=>releasePermission('granted'));
check('BN2-owner-fence',permission==='granted'&&window.localStorage.getItem('nod.browser-notifications.synthetic-settings-owner')===null&&count('local_setting_changed')===startNotifications+3);
owner='synthetic-settings-owner';await act(async()=>sessionStore.refresh());restore();
const {MessageBubble}=await import('./src/web/components/message.tsx');
const message={id:'00000000-0000-4000-8000-000000000711',role:'assistant',text:'SYNTHETIC_PRIVATE_COPY_89271',createdAt:new Date().toISOString(),attachments:[],reactions:[]};
let copyMode='fail',releaseCopy;
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{if(copyMode==='fail')throw new Error('Synthetic clipboard failure');if(copyMode==='hold')await new Promise(resolve=>releaseCopy=resolve)}}});
await remount(createElement(MessageBubble,{message}));
const copy=()=>document.querySelector('button[aria-label="Copy message"],button[aria-label="Message copied"]')??document.querySelector('button[aria-label="Copy"]');
assert.ok(copy(),'copy control exists');
const copyStart=count('message_action');
await click(copy());check('CP1-rejected',count('message_action')===copyStart);
copyMode='hold';await click(copy());await waitFor(()=>releaseCopy);
check('CP1-pending',count('message_action')===copyStart);
await act(async()=>releaseCopy());check('CP1-success',count('message_action')===copyStart+1);
await click(copy());configureAnalytics(undefined);configureAnalytics(config,'web');await act(async()=>releaseCopy());
check('CP2-consent-fence',count('message_action')===copyStart+1);
await click(copy());setRequestAccount('synthetic-another-owner');await act(async()=>releaseCopy());
check('CP2-owner-fence',count('message_action')===copyStart+1);restore();
const {BrowserHandoff}=await import('./src/web/components/browser-handoff.tsx');
const handoff=()=>createElement(BrowserHandoff,{turnId:'00000000-0000-4000-8000-000000000712'});
await remount(handoff());
const startHandoff=count('browser_handoff_action');
await click(button('Return to Nod'));check('BH1-rejected',count('browser_handoff_action')===startHandoff);
handoffMode='hold';await click(button('Return to Nod'));await waitFor(()=>releaseHandoff);
check('BH1-pending',count('browser_handoff_action')===startHandoff);
await act(async()=>releaseHandoff());check('BH1-success',count('browser_handoff_action')===startHandoff+1);
await remount(handoff());await click(button('Return to Nod'));await waitFor(()=>releaseHandoff);
configureAnalytics(undefined);configureAnalytics(config,'web');await act(async()=>releaseHandoff());
check('BH2-consent-fence',count('browser_handoff_action')===startHandoff+1);
await remount(handoff());await click(button('Return to Nod'));await waitFor(()=>releaseHandoff);
setRequestAccount('synthetic-another-owner');await act(async()=>releaseHandoff());
check('BH2-owner-fence',count('browser_handoff_action')===startHandoff+1);restore();
await remount(handoff());await click(document.querySelector('button[aria-label="Enlarge browser"]'));
await click(document.querySelector('button[aria-label="Shrink browser"]'));
check('BH3-resize',count('browser_handoff_action')===startHandoff+3);
const {deliverBrowserNotification}=await import('./src/web/lib/browser-notifications.ts');
permission='granted';window.localStorage.setItem('nod.browser-notifications.'+owner,'enabled');window.focus=()=>{};
Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
let notificationCurrent=true;
const notification=await deliverBrowserNotification(owner,'private-thread',{id:'private-message',createdAt:'2026-10-31T00:00:00Z'},()=>notificationCurrent);
assert.ok(notification);
notificationCurrent=false;notification.onclick();check('NO1-stale-owner',count('notification_opened')===0);
notificationCurrent=true;configureAnalytics(undefined);notification.onclick();check('NO1-consent-off',count('notification_opened')===0);
configureAnalytics(config,'web');notification.onclick();check('NO1-current-click',count('notification_opened')===1);
const {FileActions,reuseFile}=await import('./src/web/components/file-actions.tsx');
const reused=[];window.addEventListener('nod:attach-artifact',event=>reused.push(event.detail));
const reuseEvents=()=>events.filter(event=>event.event==='artifact_action'&&event.properties.action==='reuse_requested');
const artifact={id:'00000000-0000-4000-8000-000000000713',url:'/api/artifacts/00000000-0000-4000-8000-000000000713',name:'SYNTHETIC_PRIVATE_COPY_89271.txt',mimeType:'text/plain',size:12};
let nativeAction='open',rejectFile=false;
window.nodDesktop={fileMenu:async()=>nativeAction,fileAction:async()=>{if(rejectFile)throw new Error('Synthetic native action failure')}};
await remount(createElement(FileActions,{item:artifact,location:'drawer'}));
const fileMenu=()=>document.querySelector('button[aria-label^="File actions"]');
const artifactStart=count('artifact_action');
rejectFile=true;await click(fileMenu());check('FA1-rejected',count('artifact_action')===artifactStart);
rejectFile=false;await click(fileMenu());nativeAction='show';await click(fileMenu());
check('FA1-accepted',events.filter(event=>event.event==='artifact_action').slice(-2).map(event=>event.properties.action).join(',')==='open,reveal');
const buttonReuseStart=reuseEvents().length;
await click(document.querySelector('button[aria-label^="Use "]'));
check('FA1-reuse-request',reused.length===1&&reuseEvents().length===buttonReuseStart+1&&reuseEvents().at(-1).properties.location==='drawer');
nativeAction='reuse';await click(fileMenu());
check('FA2-native-reuse-once',reused.length===2&&reuseEvents().length===buttonReuseStart+2&&reuseEvents().at(-1).properties.location==='drawer');
const invalidStart=reuseEvents().length;
check('FA2-unowned-rejected',reuseFile({...artifact,url:'https://private.example.test/file'},'drawer')===false&&reused.length===2&&reuseEvents().length===invalidStart);
delete window.nodDesktop;
const {ChatTools}=await import('./src/web/components/chat-tools.tsx');
const {ArtifactDrawerContext}=await import('./src/web/components/artifact-context.tsx');
await remount(createElement(ArtifactDrawerContext.Provider,{value:{selectedId:artifact.id,open(){},setDrafts(){}}},createElement(ChatTools,{files:[artifact]})));
await act(async()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true,cancelable:true})));
await waitFor(()=>button('Use selected file in message'));
const commandStart=reuseEvents().length;
await click(button('Use selected file in message'));
await waitFor(()=>reused.length===3);
check('FA3-command-reuse',reused.length===3&&reuseEvents().length===commandStart+1&&reuseEvents().at(-1).properties.location==='commands');
const openReuseCommand=async()=>{
 await act(async()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true,cancelable:true})));
 await waitFor(()=>button('Use selected file in message'));
};
await openReuseCommand();
await act(async()=>{
 button('Use selected file in message').click();
 configureAnalytics(undefined);configureAnalytics(config,'web');
});
await waitFor(()=>reused.length===4);
check('FA3-command-consent-fence',reuseEvents().length===commandStart+1);
await openReuseCommand();
await act(async()=>{
 button('Use selected file in message').click();
 setRequestAccount('synthetic-another-owner');
});
await waitFor(()=>!document.querySelector('[role="dialog"]'));
await settle();
check('FA3-command-owner-fence',reused.length===4&&reuseEvents().length===commandStart+1);restore();
const {initializeTheme,setTheme}=await import('./src/web/lib/theme.ts');
let quickTheme={theme:'system',resolvedTheme:'light',notifications:false,launchAtLogin:false};
let rejectTheme=false,holdTheme=false,releaseTheme;
window.nodDesktop={getSettings:async()=>quickTheme,getPreferences:async()=>quickTheme,onPreferences:()=>()=>{},setTheme:async theme=>{if(rejectTheme)throw new Error('Synthetic theme failure');if(holdTheme)await new Promise(resolve=>releaseTheme=resolve);quickTheme={...quickTheme,theme};return quickTheme}};
const stopTheme=initializeTheme();await settle();
const themeStart=count('local_setting_changed');
await setTheme('dark');await setTheme('dark');check('QT1-native-change-only',count('local_setting_changed')===themeStart+1);
rejectTheme=true;await setTheme('light').catch(()=>{});check('QT1-native-failure',count('local_setting_changed')===themeStart+1);rejectTheme=false;
holdTheme=true;const pendingTheme=setTheme('light');setRequestAccount('synthetic-another-owner');releaseTheme();await pendingTheme;check('QT1-owner-fence',count('local_setting_changed')===themeStart+1);restore();
stopTheme();delete window.nodDesktop;window.localStorage.setItem('nod.theme','light');
await setTheme('dark');await setTheme('dark');check('QT1-browser-change-only',count('local_setting_changed')===themeStart+2);
check('private-data-excluded',!JSON.stringify(events).includes('SYNTHETIC_PRIVATE_COPY_89271')&&!JSON.stringify(events).includes(message.id)&&!JSON.stringify(events).includes('00000000-0000-4000-8000-000000000712'));
await act(async()=>root.unmount());configureAnalytics(undefined);dom.window.close();
console.log(JSON.stringify({checks,events:events.filter(event=>!event.event.startsWith('$'))},null,2));
assert.ok(checks.every(check=>check.status==='pass'),checks.filter(check=>check.status==='fail').map(check=>check.id).join(', '));
} finally {clearInterval(keepAlive);}
process.exit(0);
`,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).checks.length, 41);
});

test('internal file drops record reuse intent without changing attachment acceptance', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 30_000,
    input: String.raw`
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://nod.fixture.invalid',pretendToBeVisual:true});
for(const name of ['window','document','Node','NodeFilter','Element','HTMLElement','HTMLInputElement','HTMLButtonElement','Event','CustomEvent','KeyboardEvent','MutationObserver','DOMParser','localStorage','getComputedStyle'])Object.defineProperty(globalThis,name,{configurable:true,value:name==='window'?dom.window:name==='document'?dom.window.document:typeof dom.window[name]==='function'&&name[0]===name[0].toLowerCase()?dom.window[name].bind(dom.window):dom.window[name]});
Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator});
globalThis.requestAnimationFrame=window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame=window.cancelAnimationFrame.bind(window);
globalThis.location=window.location;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
globalThis.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
const rect={x:0,y:0,left:0,top:0,right:0,bottom:0,width:0,height:0};
HTMLElement.prototype.getBoundingClientRect=()=>rect;
HTMLElement.prototype.getClientRects=()=>[];
HTMLElement.prototype.scrollIntoView=()=>{};
HTMLElement.prototype.scrollTo=()=>{};
dom.window.Range.prototype.getBoundingClientRect=()=>rect;
dom.window.Range.prototype.getClientRects=()=>[];
window.matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){}});
const {act,createElement}=await import('react');
const {createRoot}=await import('react-dom/client');
const {setAnalyticsClient,configureAnalytics}=await import('./src/web/lib/analytics.ts');
const {setRequestAccount}=await import('./src/web/lib/api.ts');
const events=[],dispatches=[],renewals=[],uploads=[],checks=[];
const check=(id,value)=>checks.push({id,status:value?'pass':'fail'});
const client={init(_key,options){this.options=options;options.loaded?.()},capture(event,properties={}){const item=this.options.before_send({event,properties});if(item)events.push(item)},reset(){},set_config(){},stopSessionRecording(){},startSessionRecording(){}};
setAnalyticsClient(client);
const configuration={enabled:true,distinctId:'local:drop-owner',environment:'development'};
setRequestAccount('drop-owner');configureAnalytics(configuration,'web');
const artifact=number=>({id:'00000000-0000-4000-8000-'+String(number).padStart(12,'0'),name:'SYNTHETIC_PRIVATE_DROP_'+number+'.txt',mimeType:'text/plain',size:12,url:'/api/artifacts/00000000-0000-4000-8000-'+String(number).padStart(12,'0')});
const available=[artifact(721),artifact(722),artifact(724),artifact(725)];
let holdRenewals=false,releaseRenewal;
window.fetch=globalThis.fetch=async(url,options={})=>{
 if(url==='/api/speech')return Response.json({transcription:false});
 if(url==='/api/apps')return Response.json([]);
 if(url==='/api/trust')return Response.json({});
 if(url==='/api/onboarding/introduction')return Response.json({messageId:null});
 if(url==='/api/uploads/renew'){
  const ids=JSON.parse(options.body).ids;renewals.push({ids,owner:options.headers.get('X-nod-Account')});
  if(holdRenewals)await new Promise(resolve=>releaseRenewal=resolve);
  return Response.json(available.filter(item=>ids.includes(item.id)));
 }
 if(url==='/api/uploads'){
  uploads.push(options.body.get('file'));
  return Response.json(artifact(730+uploads.length));
 }
 throw new Error('Unexpected fixture route '+url);
};
window.addEventListener('nod:attach-artifact',event=>dispatches.push(event.detail));
const {Chat}=await import('./src/web/pages/chat.tsx');
const root=createRoot(document.getElementById('root'));
const state={threadId:'drop-thread',turns:[],activity:[],tasks:[],verificationRequests:[],configuration:{llmReady:true},messages:[{id:'drop-message',role:'assistant',text:'Synthetic message',turnId:null,createdAt:'2026-10-31T12:00:00Z',attachments:[]}]};
const keepAlive=setInterval(()=>{},1000);
try {
await act(async()=>root.render(createElement(Chat,{ownerId:'drop-owner',state,streams:{},refresh:async()=>{},resetConversation:async()=>state.threadId})));
const settle=()=>act(async()=>new Promise(resolve=>setTimeout(resolve,5)));
const waitFor=async condition=>{for(let at=0;at<100&&!condition();at++)await settle();assert.ok(condition(),'drop fixture settled')};
const editor=()=>document.querySelector('.composer [contenteditable]');
const conversation=()=>document.querySelector('.conversation-scroll');
const reuseEvents=()=>events.filter(event=>event.event==='artifact_action'&&event.properties.action==='reuse_requested');
const attachmentEvents=()=>events.filter(event=>event.event==='attachment_added');
const drop=async(target,value,files=[])=>{
 const event=new Event('drop',{bubbles:true,cancelable:true});
 Object.defineProperty(event,'dataTransfer',{value:{types:value?['application/x-nod-artifact']:['Files'],files,getData:type=>type==='application/x-nod-artifact'?value:''}});
 await act(async()=>target.dispatchEvent(event));
 assert.equal(event.defaultPrevented,true);
};
await waitFor(()=>editor());
await drop(editor(),JSON.stringify(artifact(721)));
await waitFor(()=>renewals.length===1&&!document.querySelector('.composer-file-status')?.textContent.includes('Checking'));
check('DROP1-editor',dispatches.length===1&&reuseEvents().length===1&&reuseEvents()[0].properties.location==='composer'&&renewals[0].owner==='drop-owner');
await drop(editor(),JSON.stringify(artifact(721)));
check('DROP1-duplicate-intent',dispatches.length===2&&reuseEvents().length===2&&renewals.length===1&&document.querySelectorAll('.composer-file').length===1);
await drop(conversation(),JSON.stringify(artifact(722)));
await waitFor(()=>renewals.length===2);
check('DROP2-conversation',dispatches.length===3&&reuseEvents().length===3&&reuseEvents().at(-1).properties.location==='composer'&&document.querySelectorAll('.composer-file').length===2);
const invalidEvents=reuseEvents().length,invalidRenewals=renewals.length;
for(const target of [editor(),conversation()]){
 await drop(target,'{invalid');
 await drop(target,JSON.stringify({...artifact(723),url:'https://private.example.test/secret'}));
}
check('DROP3-invalid',reuseEvents().length===invalidEvents&&renewals.length===invalidRenewals&&document.querySelectorAll('.composer-file').length===2);
const staleEvents=reuseEvents().length;
await drop(conversation(),JSON.stringify(artifact(723)));
await waitFor(()=>document.querySelector('.composer-file.is-failed'));
check('DROP4-stale-request',reuseEvents().length===staleEvents+1&&document.querySelector('.composer-file.is-failed').textContent.includes('SYNTHETIC_PRIVATE_DROP_723'));
holdRenewals=true;releaseRenewal=undefined;
await drop(editor(),JSON.stringify(artifact(724)));await waitFor(()=>releaseRenewal);
const pendingEvents=reuseEvents().length;
check('DROP5-pending-request',pendingEvents===staleEvents+2&&document.querySelectorAll('.composer-file').length===4);
setRequestAccount('other-drop-owner');await act(async()=>releaseRenewal());holdRenewals=false;
await waitFor(()=>[...document.querySelectorAll('.composer-file.is-failed')].some(item=>item.textContent.includes('SYNTHETIC_PRIVATE_DROP_724')));
check('DROP5-owner-change',reuseEvents().length===pendingEvents);
configureAnalytics(undefined);
await drop(editor(),JSON.stringify(artifact(725)));await waitFor(()=>renewals.at(-1).owner==='other-drop-owner');
check('DROP6-consent-off',reuseEvents().length===pendingEvents);
setRequestAccount('drop-owner');configureAnalytics(configuration,'web');
const externalReuse=reuseEvents().length,externalAttachments=attachmentEvents().length;
for(const target of [editor(),conversation()])await drop(target,'',[new File(['SYNTHETIC_PRIVATE_DROP_CONTENT'],'SYNTHETIC_PRIVATE_EXTERNAL.txt',{type:'text/plain'})]);
await waitFor(()=>uploads.length===2);
check('DROP7-external-files',reuseEvents().length===externalReuse&&attachmentEvents().length===externalAttachments+2&&attachmentEvents().slice(-2).every(event=>event.properties.method==='drop'));
check('DROP8-private-data',!JSON.stringify(events).includes('SYNTHETIC_PRIVATE')&&!JSON.stringify(events).includes('private.example.test')&&!JSON.stringify(events).includes(artifact(721).id));
await act(async()=>root.unmount());configureAnalytics(undefined);dom.window.close();
console.log(JSON.stringify({checks,events:events.filter(event=>!event.event.startsWith('$')),renewals:renewals.map(item=>({count:item.ids.length,owner:item.owner})),dispatchCount:dispatches.length,uploadCount:uploads.length},null,2));
assert.ok(checks.every(check=>check.status==='pass'),checks.filter(check=>check.status==='fail').map(check=>check.id).join(', '));
} finally {clearInterval(keepAlive);}
process.exit(0);
`,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).checks.length, 10);
});

test('desktop startup theme changes use the persisted preference without stale reads', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 15_000,
    input: String.raw`
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<!doctype html>',{url:'https://nod.fixture.invalid',pretendToBeVisual:true});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,Event:dom.window.Event,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)});
window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
const {setAnalyticsClient,configureAnalytics,captureAnalytics}=await import('./src/web/lib/analytics.ts');
const {setRequestAccount}=await import('./src/web/lib/api.ts');
const {initializeTheme,setTheme,currentTheme}=await import('./src/web/lib/theme.ts');
const events=[],checks=[];
const check=(id,value)=>checks.push({id,status:value?'pass':'fail'});
const client={init(_key,options){this.options=options;options.loaded?.()},capture(event,properties={}){const item=this.options.before_send({event,properties});if(item)events.push(item)},reset(){},set_config(){},stopSessionRecording(){},startSessionRecording(){}};
setAnalyticsClient(client);
const configuration={enabled:true,distinctId:'local:theme-owner',environment:'development'};
const restore=()=>{setRequestAccount('theme-owner');configureAnalytics(configuration,'desktop')};
restore();captureAnalytics('settings_viewed',{tab:'general'});assert.deepEqual(events.map(({event})=>event),['app_opened','settings_viewed'],'analytics capture is enabled');
const settings=theme=>({theme,resolvedTheme:theme==='system'?'dark':theme,notifications:false,launchAtLogin:false});
let releaseRead,rejectRead,listener,readCalls,saveCalls,persisted,rejectSave;
function bridge(theme){
 readCalls=0;saveCalls=0;persisted=settings(theme);rejectSave=false;
 window.nodDesktop={getSettings:async()=>persisted,getPreferences:()=>{readCalls++;return new Promise((resolve,reject)=>{releaseRead=resolve;rejectRead=reject})},onPreferences:callback=>{listener=callback;return()=>{}},setTheme:async next=>{saveCalls++;if(rejectSave)throw new Error('Synthetic theme save failure');persisted=settings(next);return persisted}};
 return initializeTheme();
}
const settle=async()=>{await Promise.resolve();await Promise.resolve()};
const themeEvents=()=>events.filter(event=>event.event==='local_setting_changed');
const keepAlive=setInterval(()=>{},1000);
try {
 let cleanup=bridge('light');
 const changed=setTheme('dark');await settle();
 check('THEME1-read-before-save',readCalls===1&&saveCalls===0);
 releaseRead(settings('light'));await changed;
 check('THEME1-startup-change',saveCalls===1&&themeEvents().length===1&&themeEvents()[0].properties.value==='dark'&&currentTheme()==='dark');cleanup();
 const noOpStart=themeEvents().length;cleanup=bridge('dark');
 const noOp=setTheme('dark');releaseRead(settings('dark'));await noOp;
 check('THEME2-no-op',saveCalls===1&&themeEvents().length===noOpStart);cleanup();
 cleanup=bridge('light');rejectSave=true;
 const failed=setTheme('dark').catch(error=>error);releaseRead(settings('light'));
 check('THEME3-save-failed',(await failed) instanceof Error&&saveCalls===1&&themeEvents().length===noOpStart&&currentTheme()==='light');cleanup();
 cleanup=bridge('light');
 const consent=setTheme('dark');configureAnalytics(undefined);configureAnalytics(configuration,'desktop');releaseRead(settings('light'));await consent;
 check('THEME4-consent-fence',saveCalls===1&&persisted.theme==='dark'&&themeEvents().length===noOpStart);cleanup();
 cleanup=bridge('light');
 const owner=setTheme('dark');setRequestAccount('other-theme-owner');releaseRead(settings('light'));await owner;
 check('THEME5-owner-fence',saveCalls===1&&persisted.theme==='dark'&&themeEvents().length===noOpStart);cleanup();restore();
 cleanup=bridge('light');listener(settings('dark'));
 const newerStart=themeEvents().length;
 await setTheme('system');releaseRead(settings('light'));await settle();
 check('THEME6-newer-preference',readCalls===1&&saveCalls===1&&themeEvents().length===newerStart+1&&themeEvents().at(-1).properties.value==='system'&&currentTheme()==='dark'&&window.localStorage.getItem('nod.theme')==='system');cleanup();
 cleanup=bridge('light');
 const unknownStart=themeEvents().length;
 const unknown=setTheme('dark');rejectRead(new Error('Synthetic preference read failure'));await unknown;
 check('THEME7-unknown-baseline',saveCalls===1&&persisted.theme==='dark'&&themeEvents().length===unknownStart);cleanup();
 configureAnalytics(undefined);dom.window.close();
 console.log(JSON.stringify({checks,events:themeEvents()},null,2));
 assert.ok(checks.every(check=>check.status==='pass'),checks.filter(check=>check.status==='fail').map(check=>check.id).join(', '));
} finally {clearInterval(keepAlive);}
process.exit(0);
`,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).checks.length, 8);
});

test('route analytics stay in the consent period that accepted the request', async () => {
  const { createAnalytics, registerAnalyticsRoutes } = await import('../src/server/analytics.ts');
  const captured: { event: string; properties: Record<string, unknown> }[] = [];
  const analytics = await createAnalytics({
    provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
    environment: 'development',
    dataRoot: '.',
    installationId: randomUUID(),
  });
  const owner = 'route-consent-owner';
  const app = Fastify();
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  const requests = new Map<
    number,
    {
      entered: ReturnType<typeof deferred>;
      released: ReturnType<typeof deferred>;
      status: number;
    }
  >();
  registerAnalyticsRoutes(app, analytics.forOwner(owner));
  app.patch('/api/preferences', async (request, reply) => {
    const { id } = request.body as { id: number };
    const held = requests.get(id)!;
    held.entered.resolve();
    await held.released.promise;
    return reply.status(held.status).send({ accepted: held.status === 200 });
  });
  let nextId = 0;
  async function start(status = 200) {
    const id = ++nextId;
    const held = {
      entered: deferred(),
      released: deferred(),
      status,
    };
    requests.set(id, held);
    const response = app
      .inject({
        method: 'PATCH',
        url: '/api/preferences',
        payload: { id, private: 'SYNTHETIC_PRIVATE_ROUTE_5278' },
      })
      .then((result) => result);
    await held.entered.promise;
    return async () => {
      held.released.resolve();
      assert.equal((await response).statusCode, status);
      requests.delete(id);
    };
  }
  try {
    analytics.setUsageData(owner, true);
    const failed = await start(500);
    await failed();
    assert.equal(captured.length, 0);

    analytics.setUsageData(owner, false);
    const optedOut = await start();
    analytics.setUsageData(owner, true);
    const current = await start();
    await current();
    assert.equal(captured.length, 1);
    await optedOut();
    assert.equal(captured.length, 1);

    const expired = await start();
    analytics.setUsageData(owner, false);
    analytics.setUsageData(owner, true);
    const later = await start();
    await expired();
    assert.equal(captured.length, 1);
    await later();
    assert.equal(captured.length, 2);
    assert.ok(
      captured.every(
        ({ event, properties }) =>
          event === 'settings_updated' &&
          properties.section === 'preferences' &&
          properties.operation === 'update',
      ),
    );
    assert.ok(!JSON.stringify(captured).includes('SYNTHETIC_PRIVATE_ROUTE_5278'));
  } finally {
    for (const held of requests.values()) held.released.resolve();
    await app.close();
    await analytics.shutdown();
  }
});
