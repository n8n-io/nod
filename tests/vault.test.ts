import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { runProcess } from '../src/providers/process.ts';
import { Vault } from '../src/web/pages/vault.tsx';
import { Payment } from '../src/web/pages/payment.tsx';
import { SetupActions } from '../src/web/components/setup-link.tsx';
import { messageSetupLinks } from '../src/web/lib/message-links.ts';
import { paymentInvitation } from '../src/runtime/communication.ts';
import { VaultItemForm } from '../src/web/components/vault-item-form.tsx';
import { VaultDetails } from '../src/web/components/vault-details.tsx';
import { pageDataCache } from '../src/web/lib/page-data-cache.ts';
import Fastify, { type FastifyInstance } from 'fastify';
import pg, { DatabaseError } from 'pg';
import { BrowserActionError, type CredentialInput } from '../src/ports/computer.ts';
import { registerLocalAccess } from '../src/server/access.ts';
import { normalizedEmail } from '../src/server/email-address.ts';
import {
  checkedKeyStore,
  createVault,
  credentialOrigin,
  sealCredential,
} from '../src/server/vault.ts';
import type { VaultCardEntry, VaultLoginEntry } from '../src/shared/contracts.ts';
import { parsePasswordCsv } from '../src/shared/password-import.ts';
import { createPayments } from '../src/server/payments.ts';
import type { CardEntry } from '../src/ports/computer.ts';
import { withFailureLog } from '../src/server/failure-log.ts';
import { cancelTurnOperations } from '../src/server/turn-cancellation.ts';
import { afterCommit } from '../src/server/transaction.ts';

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
  const calls = { injected: 0 };
  const inspecting = async () => ({
    origin: 'https://example.com',
    url: 'https://example.com/login',
  });
  let cancelAtCommit: string | undefined;
  let absent: string | undefined;
  const database = new Proxy(pool, {
    get(target, member) {
      if (member === 'connect')
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(connection, key) {
              if (key === 'query')
                return async (...args: Parameters<typeof client.query>) => {
                  const value = await client.query(...args);
                  if (args[0] === 'COMMIT' && cancelAtCommit) {
                    const turnId = cancelAtCommit;
                    cancelAtCommit = undefined;
                    await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [turnId]);
                    cancelTurnOperations([turnId]);
                  }
                  return value;
                };
              const value = Reflect.get(connection, key);
              return typeof value === 'function' ? value.bind(connection) : value;
            },
          });
        };
      const value = Reflect.get(target, member);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const vault = await createVault(database, {
    keyStore: { id: 'fixture', configured: true, getKey: async () => randomBytes(32) },
    page: async (_id, step) => ({
      ...(await inspecting()),
      ...(step?.selector && step.selector === absent ? { controls: [] } : {}),
    }),
    inject: async () => {
      calls.injected++;
    },
  });
  vault.registerRoutes(app);
  return {
    ...seeded,
    pool,
    app,
    vault,
    calls,
    cancelBeforeEntry(turnId: string) {
      cancelAtCommit = turnId;
    },
    removeFromPage(selector?: string) {
      absent = selector;
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
  'a saved login stopped before entry enters nothing and stays not entered',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const f = await vaultFixture();
    try {
      const entry = await f.vault.saveLogin({
        label: 'Example',
        origin: 'https://example.com',
        username: 'synthetic@example.com',
        password: 'fixture-secret',
      });
      const turn = await f.turn();
      f.cancelBeforeEntry(turn.turnId);
      await assert.rejects(
        f.vault.fill(turn, 'local-development', entry.id, {
          origin: 'https://example.com',
          usernameSelector: '#username',
          passwordSelector: '#password',
        }),
        (error: unknown) =>
          error instanceof Error && 'notEntered' in error && error.notEntered === true,
      );
      assert.equal(f.calls.injected, 0);
      assert.deepEqual((await f.pool.query('SELECT status FROM vault_uses')).rows, [
        { status: 'not_entered' },
      ]);
    } finally {
      await f.close();
    }
  },
);

test(
  'a sign-in step for a control that is not on the page is refused before a saved login is spent',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const f = await vaultFixture();
    try {
      const step = {
        origin: 'https://example.com',
        usernameSelector: '#username',
        passwordSelector: '#password',
        submitSelector: '#sign-in',
      };
      const entry = await f.vault.saveLogin({
        label: 'Example',
        origin: step.origin,
        username: 'synthetic@example.com',
        password: 'fixture-secret',
      });
      const missing = /not on the current page, so nothing was entered/;
      const turn = await f.turn();
      for (const selector of ['#username', '#password', '#sign-in']) {
        f.removeFromPage(selector);
        await assert.rejects(f.vault.fill(turn, 'local-development', entry.id, step), missing);
      }
      assert.equal((await f.pool.query('SELECT 1 FROM vault_uses')).rowCount, 0);
      f.removeFromPage();
      assert.equal(await f.vault.fill(turn, 'local-development', entry.id, step), true);
      assert.equal(f.calls.injected, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  'interrupted Vault claims and private entry retain uncertainty without replay or secret diagnostics',
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
                        throw new DatabaseError('fixture-private-value', 0, 'error');
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
      const failures: Array<{
        event: string;
        error: unknown;
        context?: Record<string, unknown>;
      }> = [];
      const record = (event: string, error: unknown, context?: Record<string, unknown>) => {
        failures.push({ event, error, context });
      };
      loseCommit = true;
      await withFailureLog(record, async () => {
        await assert.rejects(uses.run(use, operation), uncertain);
      });
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
      const interrupted = { ...use, id: randomUUID() };
      let websiteSubmissions = 0;
      await withFailureLog(record, async () => {
        await assert.rejects(
          uses.run(interrupted, {
            perform: async () => {
              websiteSubmissions++;
              throw new BrowserActionError('browser_card_changed', 'fixture-private-value');
            },
          }),
          uncertain,
        );
      });
      assert.equal(websiteSubmissions, 1);
      assert.equal(
        (await f.pool.query('SELECT status FROM vault_uses WHERE id=$1', [interrupted.id])).rows[0]
          .status,
        'uncertain',
      );
      await assert.rejects(
        uses.run(interrupted, { perform: operation.perform }),
        (error: unknown) => error instanceof VaultUseError && error.statusCode === 409,
      );
      assert.equal(websiteSubmissions, 1);
      const scripted = { ...use, id: randomUUID() };
      await assert.rejects(
        uses.run(scripted, {
          perform: async () => {
            throw new BrowserActionError('browser_card_reload', 'fixture-private-value');
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof VaultUseError);
          assert.equal(error.statusCode, 502);
          assert.match(error.message, /Reload the page/);
          assert.equal(error.message.includes('fixture-private-value'), false);
          return true;
        },
      );
      assert.equal(
        (await f.pool.query('SELECT status FROM vault_uses WHERE id=$1', [scripted.id])).rows[0]
          .status,
        'uncertain',
      );
      await assert.rejects(
        uses.run(scripted, { perform: operation.perform }),
        (error: unknown) => error instanceof VaultUseError && error.statusCode === 409,
      );
      const beforeRecovery = entries;
      await uses.run({ ...use, id: randomUUID() }, operation);
      assert.equal(entries, beforeRecovery + 1);
      for (const code of ['ECONNRESET', 'UND_ERR_SOCKET']) {
        const disconnected = { ...use, id: randomUUID() };
        await withFailureLog(record, async () => {
          await assert.rejects(
            uses.run(disconnected, {
              perform: async () => {
                throw Object.assign(new Error('fixture-private-value'), { code });
              },
            }),
            uncertain,
          );
        });
      }
      const stoppedPreparation = { ...use, id: randomUUID() };
      const beforePreparation = entries;
      await assert.rejects(
        uses.run(stoppedPreparation, {
          prepare: async () => {
            cancelTurnOperations([stoppedPreparation.turnId]);
            return false;
          },
          perform: operation.perform,
        }),
        (error: unknown) =>
          error instanceof VaultUseError && error.statusCode === 409 && error.notEntered,
      );
      assert.equal(entries, beforePreparation);
      assert.equal(
        (await f.pool.query('SELECT 1 FROM vault_uses WHERE id=$1', [stoppedPreparation.id]))
          .rowCount,
        0,
      );
      const lifetime = new AbortController();
      const closingUses = await createVaultUses(
        f.pool,
        'local-development',
        undefined,
        lifetime.signal,
      );
      const afterShutdown = { ...use, id: randomUUID() };
      lifetime.abort();
      const entriesBeforeShutdown = entries;
      await assert.rejects(
        closingUses.run(afterShutdown, operation),
        (error: unknown) =>
          error instanceof VaultUseError && error.statusCode === 409 && error.notEntered,
      );
      assert.equal(entries, entriesBeforeShutdown);
      assert.equal(
        (await f.pool.query('SELECT 1 FROM vault_uses WHERE id=$1', [afterShutdown.id])).rowCount,
        0,
      );
      const unfinished = { ...use, id: randomUUID() };
      await withFailureLog(record, async () => {
        await assert.rejects(
          uses.run(unfinished, {
            perform: async () => {
              websiteSubmissions++;
              return true;
            },
            complete: async () => {
              throw new Error('fixture-private-value');
            },
          }),
          uncertain,
        );
      });
      assert.equal(websiteSubmissions, 2);
      assert.equal(
        (await f.pool.query('SELECT status FROM vault_uses WHERE id=$1', [unfinished.id])).rows[0]
          .status,
        'uncertain',
      );
      await assert.rejects(
        uses.run(unfinished, { perform: operation.perform }),
        (error: unknown) => error instanceof VaultUseError && error.statusCode === 409,
      );
      assert.equal(websiteSubmissions, 2);
      const malformed = { ...use, id: randomUUID(), kind: 'fixture-private-value' };
      await withFailureLog(record, async () => {
        await assert.rejects(
          uses.run(malformed, {
            perform: async () => {
              throw Object.assign(new BrowserActionError('browser_card_changed'), {
                code: 'fixture-private-value',
              });
            },
          }),
          uncertain,
        );
      });
      assert.deepEqual(
        failures
          .filter((failure) => failure.event === 'vault_private_operation_interrupted')
          .map((failure) => failure.context),
        [
          { stage: 'claim', kind: 'password', cause: 'database' },
          {
            stage: 'entry',
            kind: 'password',
            cause: 'browser',
            browserCode: 'browser_card_changed',
          },
          { stage: 'entry', kind: 'password', cause: 'transport' },
          { stage: 'entry', kind: 'password', cause: 'transport' },
          { stage: 'completion', kind: 'password', cause: 'operation' },
          { stage: 'entry', kind: 'other', cause: 'browser' },
        ],
      );
      assert.equal(
        JSON.stringify(
          failures.map(({ event, error, context }) => ({
            event,
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            context,
          })),
        ).includes('fixture-private-value'),
        false,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'saved logins keep exact websites, owners and one entry per account in a task',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_vault_accounts_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const { turn, archive } = await seedTurns(pool);
    const owner = 'local-development';
    const key = randomBytes(32);
    const injections: CredentialInput[] = [];
    let observedOrigin = 'https://example.com';
    const vault = await createVault(pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => key },
      page: async () => ({ origin: observedOrigin, url: `${observedOrigin}/login` }),
      inject: async (input) => {
        injections.push(input);
      },
    });
    const identifier = (origin = 'https://example.com') => ({ origin, usernameSelector: '#login' });
    const password = (origin = 'https://example.com') => ({
      origin,
      passwordSelector: '#password',
    });
    const combined = (origin = 'https://example.com') => ({
      origin,
      usernameSelector: '#account',
      passwordSelector: '#password',
    });
    const code = (origin: string) => ({ origin, kind: 'otp' as const, passwordSelector: '#code' });
    try {
      const first = await vault.saveLogin({
        label: 'Personal',
        origin: 'https://example.com',
        username: 'same-first@example.test',
        password: 'first-password',
      });
      const second = await vault.saveLogin({
        label: 'Work',
        origin: 'https://example.com',
        username: 'same-second@example.test',
        password: 'second-password',
      });

      await t.test('root and www entry types into the real destination only', async (t) => {
        t.after(() => {
          observedOrigin = 'https://example.com';
        });
        for (const [savedOrigin, destination] of [
          ['https://example.net:8443', 'https://www.example.net:8443'],
          ['https://www.example.org:9443', 'https://example.org:9443'],
          ['https://tenant.github.io:8443', 'https://www.tenant.github.io:8443'],
          ['https://xn--bcher-kva.de:7443', 'https://www.xn--bcher-kva.de:7443'],
        ] as const) {
          observedOrigin = destination;
          const saved = await vault.saveLogin({
            label: 'Synthetic root and www account',
            origin: savedOrigin,
            username: 'synthetic-account@example.test',
            password: 'synthetic-www-password',
            authenticatorKey: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
          });
          const original = (
            await pool.query('SELECT origin,ciphertext FROM vault_entries WHERE id=$1', [saved.id])
          ).rows[0];
          const task = await turn();
          assert.equal(await vault.fill(task, owner, saved.id, identifier(destination)), true);
          assert.equal(injections.at(-1)?.origin, destination);
          assert.equal(injections.at(-1)?.username, 'synthetic-account@example.test');
          assert.equal(await vault.fill(task, owner, saved.id, password(destination)), true);
          assert.equal(injections.at(-1)?.password, 'synthetic-www-password');
          assert.equal(await vault.fill(task, owner, saved.id, password(destination)), false);
          assert.equal((await vault.authenticatorLogin(task, owner, destination))?.id, saved.id);
          assert.equal(await vault.fill(task, owner, saved.id, code(destination)), true);
          assert.match(injections.at(-1)?.code ?? '', /^\d{6}$/);
          assert.equal(await vault.fill(task, owner, saved.id, code(destination)), false);
          assert.deepEqual(
            (
              await pool.query('SELECT DISTINCT origin FROM vault_uses WHERE item_id=$1', [
                saved.id,
              ])
            ).rows,
            [{ origin: destination }],
          );
          assert.deepEqual(
            (
              await pool.query('SELECT origin,ciphertext FROM vault_entries WHERE id=$1', [
                saved.id,
              ])
            ).rows[0],
            original,
          );
        }
      });

      await t.test('www matching refuses other sites and keeps exact excluded hosts', async (t) => {
        t.after(() => {
          observedOrigin = 'https://example.com';
        });
        for (const [savedOrigin, destination] of [
          ['https://example.net:9444', 'https://www.example.net:9445'],
          ['https://example.net:9446', 'https://login.example.net:9446'],
          ['https://login.example.net:9447', 'https://www.login.example.net:9447'],
          ['https://example.net:9448', 'https://www.www.example.net:9448'],
          ['https://www.com', 'https://www.www.com'],
          ['https://www.www.com', 'https://www.com'],
          ['https://www.ck', 'https://www.www.ck'],
          ['https://www.www.ck', 'https://www.ck'],
          ['https://co.uk', 'https://www.co.uk'],
          ['https://github.io', 'https://www.github.io'],
          ['https://first.github.io', 'https://www.second.github.io'],
          ['https://fixture.invalid', 'https://www.fixture.invalid'],
          ['https://localhost', 'https://www.localhost'],
        ] as const) {
          const saved = await vault.saveLogin({
            label: 'Synthetic excluded login',
            origin: savedOrigin,
            username: 'excluded',
            password: 'excluded-password',
          });
          observedOrigin = destination;
          const before = injections.length;
          await assert.rejects(vault.fill(await turn(), owner, saved.id, combined(destination)));
          assert.equal(injections.length, before);
          observedOrigin = savedOrigin;
          assert.equal(
            await vault.fill(await turn(), owner, saved.id, combined(savedOrigin)),
            true,
          );
          assert.equal(injections.at(-1)?.origin, savedOrigin);
        }
        for (const [origin, alternate] of [
          ['https://127.0.0.1:9449', 'https://www.127.0.0.1:9449'],
          ['https://[::1]:9449', 'https://www.[::1]:9449'],
        ] as const) {
          const saved = await vault.saveLogin({
            label: 'Synthetic IP login',
            origin,
            username: 'ip-account',
            password: 'ip-password',
          });
          observedOrigin = alternate;
          const before = injections.length;
          await assert.rejects(
            vault.fill(await turn(), owner, saved.id, combined(alternate)),
            /website address is not valid/,
          );
          assert.equal(injections.length, before);
          observedOrigin = origin;
          assert.equal(await vault.fill(await turn(), owner, saved.id, combined(origin)), true);
          assert.equal(injections.at(-1)?.origin, origin);
        }
      });

      await t.test('saved logins stay with their owner, live task and actual page', async () => {
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
            'fo…',
            sealCredential(key, foreign, { username: 'foreign-user', password: 'foreign-secret' }),
          ],
        );
        const before = injections.length;
        await assert.rejects(vault.fill(await turn(), owner, foreign.id, combined()));
        await assert.rejects(
          vault.fill(await turn('foreign-owner'), 'foreign-owner', foreign.id, combined()),
        );
        observedOrigin = 'https://www.example.com';
        await assert.rejects(
          vault.fill(await turn(), owner, first.id, combined()),
          /origin changed/,
        );
        observedOrigin = 'https://example.com';
        const ended = await turn();
        await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [ended.turnId]);
        await assert.rejects(vault.fill(ended, owner, first.id, combined()));
        const archived = await turn();
        await archive();
        await assert.rejects(vault.fill(archived, owner, first.id, combined()));
        assert.equal(injections.length, before);
      });

      await t.test('one task can use two saved accounts once each', async () => {
        const task = await turn();
        const before = injections.length;
        assert.equal(await vault.fill(task, owner, first.id, combined()), true);
        assert.equal(await vault.fill(task, owner, second.id, combined()), true);
        assert.deepEqual(
          injections.slice(before).map((entry) => entry.username),
          ['same-first@example.test', 'same-second@example.test'],
        );
        assert.equal(await vault.fill(task, owner, first.id, combined()), false);
        assert.equal(await vault.fill(task, owner, second.id, combined()), false);
        assert.equal(injections.length, before + 2);
      });
    } finally {
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
        keyStore: { id: 'synthetic', configured: true, getKey: async () => key },
        inject: async () => assert.fail('Cards must never enter a website login.'),
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
        keyStore: checkedKeyStore(pool, { id: 'fixture', configured: true, getKey }),
        inject: async () => assert.fail('Viewing or editing a login must not fill a browser.'),
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
      const injections: CredentialInput[] = [];
      const vault = await createVault(pool, {
        keyStore: { id: 'fixture', configured: true, getKey: async () => Buffer.alloc(32, 9) },
        page: async () => ({ origin: observedOrigin, url: `${observedOrigin}/verify` }),
        inject: async (input) => {
          injections.push(input);
          return { status: 'submitted' as const };
        },
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
      const code = { origin, kind: 'otp' as const, passwordSelector: '#code' };
      const password = { origin, usernameSelector: '#user', passwordSelector: '#password' };

      await t.test('another account in the same task never receives the key', async () => {
        const task = await turn();
        assert.equal(await vault.fill(task, owner, second.id, password), true);
        assert.equal(await vault.authenticatorLogin(task, owner, origin), undefined);
        assert.equal(await vault.authenticatorLogin(task, owner, origin, first.id), undefined);
        const entered = injections.length;
        assert.notEqual(await vault.fill(task, owner, first.id, code).catch(() => false), true);
        assert.equal(injections.length, entered);
      });
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('verification addresses reject missing or invalid values before normalization', () => {
  for (const value of [undefined, null, 42, {}, '', 'invalid'])
    assert.equal(normalizedEmail(value), undefined);
  assert.equal(normalizedEmail('  OWNER@EXAMPLE.COM  '), 'owner@example.com');
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
        keyStore: checkedKeyStore(pool, {
          id: 'synthetic',
          configured: true,
          getKey: async () => key,
        }),
        inject: async () => assert.fail('A payment never types a login.'),
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
      let presentedAction = 'Approve payment';
      let duringPresentation = async () => {};
      const presentations: Array<{
        turn: { threadId: string; turnId: string };
        input: Record<string, unknown>;
      }> = [];
      let duringFill = async (_signal?: AbortSignal) => {};
      let stopBeforeEntry: string | undefined;
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
            return { question: presentedText, action: presentedAction };
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
          card: async (id, version, client) => {
            const card = await vault.paymentCard(id, version, client);
            if (stopBeforeEntry && client) {
              const turnId = stopBeforeEntry;
              stopBeforeEntry = undefined;
              afterCommit(client, () => cancelTurnOperations([turnId]));
            }
            return card;
          },
          fill: async (input, signal) => {
            if (failFill) throw new Error('Synthetic stale field.');
            await duringFill(signal);
            signal?.throwIfAborted();
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
      presentedAction = '   ';
      await assert.rejects(payments.request(turn, order));
      presentedAction = 'Approve payment';
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
      assert.equal(first.action, 'Approve payment');
      assert.equal(first.url, `/payments/${(await latest()).id}`);
      const invitation = paymentInvitation(first.url, first.question, first.action);
      assert.deepEqual(messageSetupLinks(invitation, 'http://localhost:4310'), [
        { href: first.url, setup: 'vault', label: first.action },
      ]);
      assert.throws(() =>
        paymentInvitation(`https://shop.fixture.test${first.url}`, first.question, first.action),
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
      assert.equal(presentations.at(-1)!.input.requires, 'private_form');
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
      const beforeNotEntered = { fills: fills.length, resumes: resumed.length };
      const notEnteredPayment = await payments.request(turn, { ...order, card: card.id });
      const notEnteredId = notEnteredPayment.url!.split('/').at(-1)!;
      const notEnteredPath = `/api/payment-requests/${notEnteredId}`;
      stopBeforeEntry = turn.turnId;
      const notEnteredReply = await app.inject({
        method: 'POST',
        url: notEnteredPath,
        headers,
        payload: { code: '737' },
      });
      assert.equal(notEnteredReply.statusCode, 409, notEnteredReply.body);
      assert.match(notEnteredReply.json().error, /stopped before entry/);
      assert.deepEqual((await app.inject({ url: `${notEnteredPath}/status`, headers })).json(), {
        status: 'expired',
        notEntered: true,
      });
      assert.deepEqual({ fills: fills.length, resumes: resumed.length }, beforeNotEntered);
      assert.deepEqual(
        (await pool.query('SELECT status FROM vault_uses WHERE id=$1', [notEnteredId])).rows,
        [{ status: 'not_entered' }],
      );
      const paymentView = await vaultPage(
        createElement(Payment, { id: notEnteredId }),
        async (path) => {
          const result = await app.inject({ url: path, headers });
          return new Response(result.body, {
            status: result.statusCode,
            headers: { 'content-type': 'application/json' },
          });
        },
        `http://localhost:4310/payments/${notEnteredId}`,
      );
      try {
        for (
          let attempt = 0;
          !paymentView.document.body.textContent?.includes('Stopped before entry') && attempt < 100;
          attempt++
        )
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
          });
        assert.match(paymentView.document.body.textContent!, /No values were entered in this step/);
        assert.doesNotMatch(
          paymentView.document.body.textContent!,
          /result is unknown|may have reached/i,
        );
        assert.equal(paymentView.document.querySelectorAll('input, button').length, 0);
        await paymentView.render(createElement(Payment, { id: notEnteredId, key: 'reload' }));
        for (
          let attempt = 0;
          !paymentView.document.body.textContent?.includes('Stopped before entry') && attempt < 100;
          attempt++
        )
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
          });
        assert.match(paymentView.document.body.textContent!, /No values were entered in this step/);
      } finally {
        await paymentView.close();
      }
      await pool.query("UPDATE turns SET status='running' WHERE id=$1", [turn.turnId]);
      const beforeInterrupted = { fills: fills.length, resumes: resumed.length };
      const interrupted = await payments.request(turn, { ...order, card: card.id });
      const interruptedId = interrupted.url!.split('/').at(-1)!;
      let entrySignal: AbortSignal | undefined;
      let entered!: () => void;
      let release!: () => void;
      const entryStarted = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const entryReady = new Promise<void>((resolve) => {
        release = resolve;
      });
      duringFill = async (signal) => {
        entrySignal = signal;
        entered();
        await entryReady;
      };
      const interruptedReply = app
        .inject({
          method: 'POST',
          url: `/api/payment-requests/${interruptedId}`,
          headers,
          payload: { code: '737' },
        })
        .then((response) => response);
      try {
        await entryStarted;
        assert.ok(entrySignal);
        assert.equal(entrySignal.aborted, false);
        await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [turn.turnId]);
        cancelTurnOperations([turn.turnId]);
        assert.equal(entrySignal.aborted, true);
        release();
        assert.equal((await interruptedReply).statusCode, 409);
        assert.equal(fills.length, beforeInterrupted.fills);
        assert.deepEqual(
          (await pool.query('SELECT status FROM vault_uses WHERE id=$1', [interruptedId])).rows,
          [{ status: 'uncertain' }],
        );
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: `/api/payment-requests/${interruptedId}`,
              headers,
              payload: { code: '737' },
            })
          ).statusCode,
          409,
        );
      } finally {
        release();
        await interruptedReply;
        duringFill = async () => {};
      }
      await pool.query("UPDATE turns SET status='running' WHERE id=$1", [turn.turnId]);
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
  'Vault forms keep the service reason when a save is refused',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    for (const kind of ['login', 'card'] as const) {
      for (const operation of ['create', 'update'] as const) {
        await t.test(`${operation} ${kind}`, async (t) => {
          const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
          const schema = `test_vault_form_${randomUUID().replaceAll('-', '')}`;
          await admin.query(`CREATE SCHEMA ${schema}`);
          const pool = new pg.Pool({
            connectionString: process.env.TEST_DATABASE_URL,
            options: `-c search_path=${schema}`,
          });
          const app = Fastify();
          let closeView: (() => Promise<void>) | undefined;
          t.after(async () => {
            await closeView?.();
            await app.close();
            await pool.end();
            await admin.query(`DROP SCHEMA ${schema} CASCADE`);
            await admin.end();
          });
          await seedTurns(pool);
          const key = randomBytes(32);
          let unavailable = operation === 'create';
          const privateFailure = 'Synthetic private key-store detail';
          const vault = await createVault(pool, {
            keyStore: {
              id: 'fixture',
              configured: true,
              getKey: async () => {
                if (unavailable) throw new Error(privateFailure);
                return key;
              },
            },
            page: async () => assert.fail('Unexpected website inspection.'),
            inject: async () => assert.fail('Unexpected private website entry.'),
          });
          vault.registerRoutes(app);
          const secret = kind === 'login' ? 'Synthetic saved password' : '4242424242424242';
          const payload =
            kind === 'login'
              ? {
                  kind,
                  label: 'Synthetic login',
                  origin: 'https://vault-form.example.test',
                  username: 'synthetic-user',
                  password: secret,
                }
              : {
                  kind,
                  label: 'Synthetic card',
                  cardholder: 'Synthetic cardholder',
                  cardNumber: secret,
                  expiryMonth: 12,
                  expiryYear: 2035,
                };
          let saved = 0;
          const onSaved = () => {
            saved++;
          };
          let entry: VaultLoginEntry | VaultCardEntry | undefined;
          if (operation === 'update') {
            const created = await app.inject({ method: 'POST', url: '/api/vault', payload });
            assert.equal(created.statusCode, 200, created.body);
            entry = created.json();
          }
          let failure: { status: number; reason: string } | undefined;
          let writes = 0;
          const view = await vaultPage(
            entry
              ? createElement(VaultDetails, {
                  entry,
                  backLabel: 'Vault',
                  onClose() {},
                  onSaved,
                  onDeleted: () => assert.fail('Unexpected item deletion.'),
                })
              : createElement(VaultItemForm, { kind, onSaved, onCancel() {} }),
            async (path, init) => {
              const result = await app.inject({
                method: (init.method ?? 'GET') as 'GET' | 'POST' | 'PATCH',
                url: path,
                headers: init.body ? { 'content-type': 'application/json' } : {},
                payload: init.body ? String(init.body) : undefined,
              });
              if (path === '/api/vault' || init.method === 'PATCH') {
                writes++;
                if (result.statusCode >= 400)
                  failure = { status: result.statusCode, reason: result.json().error };
              }
              return new Response(result.body, {
                status: result.statusCode,
                headers: { 'content-type': 'application/json' },
              });
            },
            'http://localhost:4310/vault',
          );
          closeView = () => view.close();
          const settle = async (ready: () => boolean) => {
            for (let attempt = 0; attempt < 100 && !ready(); attempt++)
              await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
            assert.ok(ready());
          };
          const field = (name: string) =>
            view.document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
          if (operation === 'update') {
            await settle(
              () =>
                view.document.querySelector<HTMLButtonElement>('[data-vault-edit]')?.disabled ===
                false,
            );
            await act(async () =>
              view.document.querySelector<HTMLButtonElement>('[data-vault-edit]')!.click(),
            );
            await pool.query(`DELETE FROM ${kind === 'login' ? 'vault_entries' : 'vault_cards'}`);
          }
          field('label').value = 'Synthetic changed item';
          if (kind === 'login') {
            if (operation === 'create') field('origin').value = payload.origin!;
            field('username').value = 'synthetic-user';
            field('password').value = secret;
          } else {
            field('cardholder').value = 'Synthetic cardholder';
            field('cardNumber').value = secret;
            field('expiry').value = '12 / 2035';
          }
          const submit = () =>
            act(async () => {
              const form = view.document.querySelector('form')!;
              form.dispatchEvent(new Event('input', { bubbles: true }));
              form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            });
          await submit();
          await settle(() => Boolean(failure));
          assert.equal(failure!.status, operation === 'create' ? 503 : 404);
          assert.ok(view.document.body.textContent?.includes(failure!.reason));
          assert.equal(view.document.body.textContent?.includes(privateFailure), false);
          assert.equal(field(kind === 'login' ? 'password' : 'cardNumber').value, '');
          assert.equal(saved, 0);
          assert.equal(writes, 1);
          const table = kind === 'login' ? 'vault_entries' : 'vault_cards';
          assert.equal((await pool.query(`SELECT 1 FROM ${table}`)).rowCount, 0);
          if (operation === 'create') {
            unavailable = false;
            field(kind === 'login' ? 'password' : 'cardNumber').value = secret;
            await submit();
            await settle(() => saved === 1);
            assert.equal(writes, 2);
            const rows = (await pool.query(`SELECT * FROM ${table}`)).rows;
            assert.equal(rows.length, 1);
            assert.equal(JSON.stringify(rows).includes(secret), false);
          }
        });
      }
    }
  },
);

test('chat removes a payment action only after the server confirms submission', async () => {
  const payment = randomUUID();
  const missing = { [randomUUID()]: 404, [randomUUID()]: 410 };
  let paymentSubmitted = false;
  let unavailable = false;
  const missingReads = new Map<string, number>();
  const view = await vaultPage(
    createElement(SetupActions, {
      actions: [
        { href: `/payments/${payment}`, setup: 'vault', label: 'Private payment' },
        ...Object.keys(missing).map((id) => ({
          href: `/payments/${id}`,
          setup: 'vault' as const,
          label: 'Removed payment',
        })),
      ],
    }),
    async (path) => {
      const id = /^\/api\/payment-requests\/([^/]+)\/status$/.exec(path)?.[1];
      if (id && missing[id]) {
        missingReads.set(path, (missingReads.get(path) ?? 0) + 1);
        return Response.json({ error: 'Unavailable' }, { status: missing[id] });
      }
      if (unavailable) return Response.json({ error: 'Unavailable' }, { status: 503 });
      if (id === payment)
        return Response.json({ status: paymentSubmitted ? 'submitted' : 'pending' });
      throw new Error(`Unexpected fixture request ${path}`);
    },
    'http://localhost:4310/',
  );
  const refresh = () => act(async () => window.dispatchEvent(new Event('focus')));
  const actions = () => view.document.querySelectorAll('[data-setup="vault"]').length;
  try {
    assert.equal(actions(), 3);
    paymentSubmitted = true;
    unavailable = true;
    await refresh();
    assert.equal(actions(), 3);
    unavailable = false;
    await refresh();
    assert.equal(actions(), 2);
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
    ['/vault/synthetic-private-id', '/not-found'],
    ['/credentials/synthetic-private-id?token=synthetic-private', '/not-found'],
    ['/payments/synthetic-private-id', '/payments'],
    ['/payments/synthetic-private-id/extra', '/not-found'],
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

test('desktop onboarding saves native preferences once and follows model updates without stale reads', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 30_000,
    input: String.raw`
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mock} from 'node:test';
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
let completionFailure;
let completions=0;
let statusListener;
let modelConnected=true;
let modelFailure;
let modelReads=0;
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
 if(path==='/api/models'){modelReads++;return Response.json({connections:modelConnected?[{id:'synthetic',provider:'anthropic',method:'api_key',label:'Synthetic model',managed:false,status:'connected',models:[{id:'synthetic-model',name:'Synthetic model',efforts:['medium'],images:false,contextWindow:1000}]}]:[],selection:modelConnected?{connectionId:'synthetic',modelId:'synthetic-model',effort:'medium'}:null,...(modelFailure?{selectionIssue:{reason:modelFailure}}:{})})}
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
const {sessionStore}=await import('./src/web/lib/session.ts');
const {writeStep}=await import('./src/web/pages/onboarding/storage.ts');
const {onboardingVersion}=await import('./src/shared/onboarding.ts');
sessionStore.getSnapshot=()=>({session,epoch:0});
let stream;
globalThis.EventSource=class{
 static CLOSED=2;
 readyState=1;
 closed=false;
 constructor(){stream=this}
 close(){this.closed=true;this.readyState=2}
};
let root=createRoot(document.getElementById('root'));
const render=()=>act(async()=>root.render(createElement(Onboarding,{user:session.user,onComplete:async()=>{completions++;if(completionFailure){const failure=completionFailure;completionFailure=undefined;throw failure}}})));
const realTimeout=setTimeout;
mock.timers.enable({apis:['setTimeout']});
const settle=()=>act(async()=>{await new Promise(resolve=>realTimeout(resolve,20));mock.timers.tick(20)});
const waitFor=async condition=>{for(let at=0;at<100&&!(await condition());at++)await settle();assert.ok(await condition())};
const button=text=>[...document.querySelectorAll('button')].find(value=>value.textContent.trim()===text);
const changed=()=>act(async()=>stream.onmessage(new dom.window.MessageEvent('message',{data:JSON.stringify({type:'refresh'})})));
const waitForModel=async condition=>{for(let at=0;at<200&&!condition();at++)await act(async()=>{mock.timers.tick(20);await new Promise(resolve=>setImmediate(resolve))});assert.ok(condition())};
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
await waitFor(async()=>(await store.get()).onboardingPreferenceStep==='complete');
assert.equal((await store.get()).launchAtLogin,true);
assert.equal((await store.get()).notifications,false,'onboarding does not request notification permission');
assert.equal((await store.get()).onboardingPreferenceStep,'complete');
assert.equal(saves,2);
await waitFor(()=>completions===1);
await act(async()=>root.unmount());
store=createSettingsStore(join(directory,'settings.json'),{});
const completedReads=reads;
window.history.replaceState(null,'','/onboarding?preferences=required');
root=createRoot(document.getElementById('root'));
await render();
await waitFor(()=>reads>completedReads);
await waitFor(()=>completions===2);
assert.equal(document.querySelector('[role="switch"]'),null);
assert.equal(saves,2,'a completed native step is never written again');
await act(async()=>root.unmount());
assert.equal(Object.hasOwn(await store.get(),'onboardingCompleted'),false);
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
window.history.replaceState(null,'','/onboarding?preferences=required');
root=createRoot(document.getElementById('root'));
await render();
await waitFor(async()=>(await store.get()).onboardingPreferenceStep==='complete');
await waitFor(()=>completions===3);
assert.equal(saves,beforeBlocked+1);
assert.equal((await store.get()).launchAtLogin,false);
assert.equal((await store.get()).onboardingPreferenceStep,'complete');
await act(async()=>root.unmount());
store=createSettingsStore(blockedPath,{});
const blockedReads=reads;
window.history.replaceState(null,'','/onboarding?preferences=required');
root=createRoot(document.getElementById('root'));
await render();
await waitFor(()=>reads>blockedReads);
await waitFor(()=>completions===4);
assert.equal(saves,beforeBlocked+1);
assert.equal(Object.hasOwn(await store.get(),'onboardingCompleted'),false);
assert.equal((await store.get()).onboardingPreferenceStep,'complete');
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
const emailSkip=()=>document.querySelector('[data-step="email"] .ob-footer-end button:not(.ob-next)');
assert.equal(emailSkip().disabled,false);
await act(async()=>emailSkip().click());
await waitFor(()=>document.querySelector('[data-step="about"]'));
modelFailure='Synthetic provider failed while About you was open.';
const beforeAboutRefresh=modelReads;
await changed();
await waitForModel(()=>modelReads>beforeAboutRefresh);
assert.ok(document.querySelector('[data-step="about"]'));
for(let at=0;at<10&&!document.querySelector('[data-step="brain"]');at++){await settle();if(button('Not now'))await act(async()=>button('Not now').click())}
await waitFor(()=>document.querySelector('[data-step="brain"]'));
await waitForModel(()=>document.querySelector('.ob-brain-connected details')?.textContent.includes(modelFailure));
modelFailure=undefined;
await changed();
await waitForModel(()=>!document.querySelector('.ob-brain-connected details'));
assert.ok(document.querySelector('[data-step="brain"]'));
await act(async()=>button('Continue').click());
await waitFor(()=>document.querySelector('[data-step="join"]'));
assert.ok(calls.includes('/api/onboarding/profile'));
assert.equal(document.querySelector('.ob-dots').getAttribute('aria-label'),'Step 4 of 4');
completionFailure=new Error('Synthetic account save failed.');
const beforeFinish=completions;
await act(async()=>button('Continue').click());
await waitFor(()=>document.querySelector('.setup-progress [role="alert"]'));
assert.ok(document.querySelector('.setup-progress [role="alert"]').textContent.includes('Synthetic account save failed.'));
assert.equal((await store.get()).onboardingPreferenceStep,'complete');
assert.equal(completions,beforeFinish+1);
await act(async()=>button('Try again').click());
await waitFor(()=>completions===beforeFinish+2);
await settle();
assert.equal(completions,beforeFinish+2);
assert.equal(calls.includes('/api/account/prepare'),false);
await act(async()=>root.unmount());
modelConnected=false;
writeStep({owner:session.user.id,step:'brain',version:onboardingVersion});
root=createRoot(document.getElementById('root'));
await render();
await waitFor(()=>button('Continue')?.disabled===true);
assert.ok(stream);
modelConnected=true;
await changed();
await waitForModel(()=>button('Continue')?.disabled===false);
modelFailure='Synthetic provider rejected the selected model request.';
await changed();
await waitForModel(()=>document.querySelector('.ob-brain-connected details')?.textContent.includes(modelFailure));
assert.ok(document.querySelector('.ob-brain-connected [role="alert"]'));
assert.equal(button('Continue').disabled,false);
await act(async()=>root.unmount());
assert.equal(stream.closed,true);
const beforeClosed=modelReads;
await changed();
await settle();
assert.equal(modelReads,beforeClosed);
modelFailure=undefined;
writeStep({owner:session.user.id,step:'privacy',version:onboardingVersion});
root=createRoot(document.getElementById('root'));
const shared=usageShared=>act(async()=>root.render(createElement(Onboarding,{user:session.user,usageShared,onComplete:async()=>{}})));
await shared(true);
await waitFor(()=>document.querySelector('[data-step="privacy"]'));
await shared(false);
await waitFor(()=>document.querySelector('[data-step="join"]'));
await shared(true);
await settle();
assert.ok(document.querySelector('[data-step="join"]'));
await act(async()=>root.unmount());
await rm(directory,{recursive:true,force:true});
dom.window.close();
process.exit(0);
`,
  });
  assert.equal(result.exitCode, 0, result.stderr);
});

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
let connected=false,checks=0,delay=false,release,failure;
window.fetch=globalThis.fetch=async(path,options)=>{
 if(path==='/api/apps/gmail/connect')return Response.json({url:'https://example.test/sign-in',attempt});
 if(path==='/api/apps/setup-cancel')return Response.json({ok:true});
 assert.equal(path,'/api/apps/setup-status');checks++;
 const hash=JSON.parse(options.body).hashes[0];
 const response=()=>Response.json({completed:connected?[hash]:[],apps:[{hash,available:!failure,...(failure?{error:failure}:{})}]});
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
connected=false;failure='Sign-in could not finish: invalid_request: Synthetic refusal';
await start();await settle(()=>signIn.error===failure);
failure=undefined;const polled=checks;await start();await settle(()=>checks>polled);
failure='Sign-in could not finish: Synthetic exchange failure';
await act(async()=>channels[0].onmessage({data:{connection:'failed',service:'gmail',attempt}}));
await settle(()=>signIn.error===failure);failure=undefined;
delay=true;release=undefined;await start();await settle(()=>release);
setRequestAccount('other-owner');await act(async()=>release());assert.equal(completions().length,1);
await act(async()=>root.unmount());configureAnalytics(undefined);dom.window.close();
console.log(JSON.stringify({result:'pass',checks:['confirmed-success','original-entry','failure-reason','unverified-broadcast','cancelled-attempt','owner-fence'],events:captured},null,2));
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
