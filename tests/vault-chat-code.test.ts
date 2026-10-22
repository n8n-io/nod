import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { accessCookie, accessKey } from '../src/server/access.ts';

test(
  'chat verification intercepts owned codes before message routing and plaintext persistence',
  {
    skip: !process.env.TEST_DATABASE_URL,
    timeout: 30_000,
  },
  async (t) => {
    const schema = `test_chat_codes_${randomUUID().replaceAll('-', '')}`;
    const bossSchema = `test_boss_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'nod-test-runtime-'));
    t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
    process.env.NOD_DATA_ROOT = runtimeRoot;
    const db = await import('../src/server/db.ts');
    const { createChatVerification } = await import('../src/server/chat-verification.ts');
    const thread = await import('../src/server/thread.ts');
    t.after(async () => {
      await thread.boss.stop();
      await db.pool.end();
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      } finally {
        await admin.end();
      }
    });
    const { createApp } = await import('../src/server/app.ts');
    const { dataRoot, ownerId, port, configuration } = await import('../src/server/config.ts');
    await db.initializeDatabase();
    await thread.initializeThreads();
    await db.pool.query(`CREATE TABLE credential_requests (
    id text PRIMARY KEY,thread_id uuid REFERENCES threads(id),turn_id uuid REFERENCES turns(id),
    owner_id text NOT NULL,kind text NOT NULL,status text NOT NULL DEFAULT 'pending'
  )`);
    const ordinary: string[] = [];
    const injected: Array<{ owner: string; turnId: string; code: string; requestId: string }> = [];
    let hold: Promise<void> | undefined;
    let started: (() => void) | undefined;
    let throwPrivateError = false;
    const failurePresentations: Array<{ threadId: string; input: object }> = [];
    let beforePayment = async () => {};
    let duringPayment = async () => {};
    const { createPayments } = await import('../src/server/payments.ts');
    const { createVaultUses } = await import('../src/server/vault-use.ts');
    const paymentCard = {
      id: randomUUID(),
      version: 'synthetic-card-version',
      label: 'Studio card',
      brand: 'Visa',
      last4: '4242',
    };
    const entered: string[] = [];
    const payments = await createPayments(db.pool, {
      ownerId,
      uses: await createVaultUses(db.pool, ownerId),
      present: async () => 'Synthetic private payment step.',
      page: async () => ({
        origin: 'https://shop.fixture.test',
        url: 'https://shop.fixture.test/checkout',
      }),
      destinations: async () => ({
        document: 'loader-1',
        destinations: { number: 'https://shop.fixture.test' },
      }),
      capture: async () => new Uint8Array([255, 216, 255]),
      cards: async () => [paymentCard],
      card: async () => ({
        cardholder: 'Synthetic Cardholder',
        cardNumber: '4242424242424242',
        expiryMonth: 8,
        expiryYear: 2031,
      }),
      fill: async (input) => {
        entered.push(input.card.securityCode ?? '');
        await duringPayment();
      },
      resume: thread.resumeAfterPayment,
      record: async () => {},
    });
    const verification = await createChatVerification(db.pool, {
      ownerId,
      keyStore: { getKey: async () => Buffer.alloc(32, 61) },
      submitPayment: async (turnId, code, paymentId) => {
        await beforePayment();
        return payments.submitCode(turnId, code, paymentId);
      },
      refresh() {},
      async present(threadId, input) {
        failurePresentations.push({ threadId, input: structuredClone(input) });
        return 'Synthetic verification result.';
      },
      async submitCode(owner, turnId, code, requestId) {
        injected.push({ owner, turnId, code, requestId });
        started?.();
        await hold;
        if (throwPrivateError) throw new Error(`Untrusted website echoed ${code}`);
        await db.pool.query("UPDATE credential_requests SET status='filled' WHERE id=$1", [
          requestId,
        ]);
        return { status: 'submitted' as const };
      },
    });
    const app = await createApp({
      verification,
      configuration: () => ({ ...configuration(), llmReady: true }),
      submitMessage: async (text, _attachments, input) => {
        ordinary.push(text);
        return { threadId: randomUUID(), turnId: randomUUID(), messageId: input!.clientMessageId! };
      },
    });
    const headers = {
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
      cookie: `${accessCookie(port)}=${await accessKey(dataRoot)}`,
    };
    const send = (text: string, extra: Record<string, unknown> = {}) =>
      app.inject({
        method: 'POST',
        url: '/api/messages',
        headers,
        payload: { text, clientMessageId: randomUUID(), ...extra },
      });
    async function seed(
      options: {
        owner?: string;
        channel?: string;
        kind?: string;
        archived?: boolean;
        status?: string;
        reason?: string;
        superseded?: boolean;
        supersededLongAgo?: boolean;
      } = {},
    ) {
      const owner = options.owner ?? ownerId;
      const threadId = (await thread.activeThread(db.pool, owner)).id;
      const turnId = randomUUID();
      const requestId = randomUUID();
      const messageId = randomUUID();
      await db.pool.query(
        `INSERT INTO turns(id,owner_id,thread_id,source,prompt,channel,status,waiting_reason,started_at)
      VALUES($1,$2,$3,'user','Sign in',$4,$5,$6,clock_timestamp())`,
        [
          turnId,
          owner,
          threadId,
          options.channel ?? 'web',
          options.status ?? 'waiting',
          options.reason ?? 'credentials',
        ],
      );
      await db.pool.query(
        `INSERT INTO credential_requests(id,thread_id,turn_id,owner_id,kind) VALUES($1,$2,$3,$4,$5)`,
        [requestId, threadId, turnId, owner, options.kind ?? 'otp'],
      );
      await db.pool.query(
        "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id) VALUES($1,$2,'assistant','Reply with the verification code.',$3,$4)",
        [messageId, owner, threadId, turnId],
      );
      await verification.bindQuestion(turnId, messageId);
      if (options.archived)
        await db.pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [threadId]);
      if (options.superseded || options.supersededLongAgo) {
        if (options.supersededLongAgo)
          await db.pool.query(
            "UPDATE turns SET created_at=now()-interval '20 minutes' WHERE id=$1",
            [turnId],
          );
        await db.pool.query(
          `INSERT INTO turns(id,owner_id,thread_id,source,prompt,status,started_at,created_at)
           VALUES($1,$2,$3,'user','Later','running',clock_timestamp(),
             CASE WHEN $4 THEN now()-interval '11 minutes' ELSE clock_timestamp() END)`,
          [randomUUID(), owner, threadId, Boolean(options.supersededLongAgo)],
        );
      }
      return { threadId, turnId, requestId, messageId };
    }
    async function reset() {
      await db.pool.query(
        'DELETE FROM chat_verification_submissions; DELETE FROM messages; DELETE FROM credential_requests; DELETE FROM vault_payments; DELETE FROM turn_events; DELETE FROM turns; DELETE FROM threads',
      );
      ordinary.length = 0;
      entered.length = 0;
      injected.length = 0;
      hold = undefined;
      started = undefined;
      throwPrivateError = false;
      failurePresentations.length = 0;
    }
    try {
      await t.test(
        'failure presentation never sees the code and never retries private entry',
        async () => {
          await reset();
          const pending = await seed();
          const clientMessageId = randomUUID();
          throwPrivateError = true;
          const response = await send('654913', { clientMessageId });
          assert.equal(response.statusCode, 200, response.body);
          assert.equal(response.json().verificationStatus, 'unavailable');
          assert.deepEqual(failurePresentations, [
            {
              threadId: pending.threadId,
              input: { kind: 'verification_failure', verification: 'otp' },
            },
          ]);
          const messages = await db.pool.query('SELECT text FROM messages ORDER BY created_at,id');
          assert.doesNotMatch(JSON.stringify(messages.rows), /654913|Untrusted website/);
          assert.equal((await send('654913', { clientMessageId })).statusCode, 200);
          assert.equal(injected.length, 1);
          assert.equal(failurePresentations.length, 1);
        },
      );
      await t.test(
        'Stop cancels a waiting payment before or during entry without restarting the task',
        async () => {
          for (const afterEntry of [false, true]) {
            await reset();
            const pending = await seed();
            await payments.request(pending, {
              amount: '43.20',
              currency: 'EUR',
              fields: { number: '@e4', expiry: '@e5', securityCode: '@e6' },
            });
            const paymentId = (await db.pool.query('SELECT id FROM vault_payments')).rows[0].id;
            let reached!: () => void;
            let release!: () => void;
            const started = new Promise<void>((resolve) => {
              reached = resolve;
            });
            const gate = new Promise<void>((resolve) => {
              release = resolve;
            });
            const pause = async () => {
              reached();
              await gate;
            };
            if (afterEntry) duringPayment = pause;
            else beforePayment = pause;
            const reply = verification.accept('737', {
              clientMessageId: randomUUID(),
              threadId: pending.threadId,
              verificationRequestId: paymentId,
            });
            try {
              await started;
              const stopped = await app.inject({
                method: 'POST',
                url: '/api/thread/stop',
                headers,
              });
              assert.equal(stopped.statusCode, 200, stopped.body);
            } finally {
              release();
              beforePayment = async () => {};
              duringPayment = async () => {};
            }
            assert.equal(
              (await reply)!.verificationStatus,
              afterEntry ? 'submitted' : 'unavailable',
            );
            assert.deepEqual(entered, afterEntry ? ['737'] : []);
            assert.equal(
              (await db.pool.query('SELECT status FROM turns WHERE id=$1', [pending.turnId]))
                .rows[0].status,
              'cancelled',
            );
            assert.equal(
              (await db.pool.query('SELECT 1 FROM vault_uses WHERE id=$1', [paymentId])).rowCount,
              afterEntry ? 1 : 0,
            );
            assert.equal(
              (
                await db.pool.query('SELECT id FROM turns WHERE source_id=$1', [
                  `credentials:${pending.turnId}`,
                ])
              ).rowCount,
              0,
            );
          }
        },
      );
      await t.test(
        'concise code replies bypass ordinary routing and save only a masked acknowledgement',
        async () => {
          for (const [text, code] of [
            [' 739126 ', '739126'],
            ['001234.', '001234'],
            ['001\u00a0234', '001234'],
            ['001\u202f234', '001234'],
            ['O código é 001\u00a0234', '001234'],
            ['The code is 739126', '739126'],
            ['Code: 073912', '073912'],
            ['OTP: 012345', '012345'],
            ['2FA code: 012345', '012345'],
            ['Verification code = 739126', '739126'],
            ['SMS code: 739126.', '739126'],
            ['O código é 739 126.', '739126'],
            ['Código de verificação: 739 126', '739126'],
            ['739 126', '739126'],
            ['1 2 3 4 5 6 7 8', '12345678'],
            ['Mi código es 739126', '739126'],
            ['Der Code lautet 739 126.', '739126'],
            ['Votre code : 073912', '073912'],
            ['認証コード 739126', '739126'],
          ]) {
            await reset();
            const request = await seed();
            const before = (await app.inject({ url: '/api/state', headers })).json();
            assert.equal(before.verificationRequests[0].id, request.requestId);
            const response = await send(text);
            assert.equal(response.statusCode, 200, response.body);
            assert.equal(response.json().verificationStatus, 'submitted');
            assert.deepEqual(injected, [
              {
                owner: ownerId,
                turnId: request.turnId,
                code,
                requestId: request.requestId,
              },
            ]);
            assert.deepEqual(ordinary, []);
            const state = (await app.inject({ url: '/api/state', headers })).json();
            assert.equal(state.verificationRequests.length, 0);
            assert.ok(!JSON.stringify(state).includes(code));
            assert.ok(!JSON.stringify(state).includes(text.trim()));
            const persisted = await db.pool.query(
              'SELECT row_to_json(m) AS row FROM messages m UNION ALL SELECT row_to_json(v) FROM chat_verification_submissions v UNION ALL SELECT row_to_json(t) FROM turns t',
            );
            assert.ok(!JSON.stringify(persisted.rows).includes(code));
            assert.ok(!JSON.stringify(persisted.rows).includes(text.trim()));
          }
        },
      );
      await t.test(
        'a security code sent by itself pays in nod while other numbers are held back',
        async () => {
          await reset();
          const threadId = (await thread.activeThread(db.pool, ownerId)).id;
          const turnId = randomUUID();
          await db.pool.query(
            `INSERT INTO turns(id,owner_id,thread_id,source,prompt,channel,status,waiting_reason,started_at)
             VALUES($1,$2,$3,'user','Buy the hinges','web','waiting','credentials',clock_timestamp())`,
            [turnId, ownerId, threadId],
          );
          const order = {
            amount: '43.20',
            currency: 'EUR',
            fields: { number: '@e4', expiry: '@e5', securityCode: '@e6' },
          };
          await payments.request({ threadId, turnId }, order);
          await assert.rejects(
            verification.accept('7395', {
              clientMessageId: randomUUID(),
              channel: 'telegram:synthetic',
            }),
            (error: Error & { statusCode?: number }) => error.statusCode === 409,
          );
          assert.equal((await send('73951')).statusCode, 409);
          for (const text of [
            '2 hinges for 7395',
            'mi código es 739',
            'card ending 4242',
            'The year is 2026',
          ])
            assert.equal((await send(text)).statusCode, 409, text);
          const earlierTurn = randomUUID();
          const earlierMessage = randomUUID();
          await db.pool.query(
            `INSERT INTO turns(id,owner_id,thread_id,source,prompt,channel,status,created_at)
             VALUES($1,$2,$3,'user','Find hinges','web','completed',now()-interval '1 hour')`,
            [earlierTurn, ownerId, threadId],
          );
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id) VALUES($1,$2,'assistant','Found two hinges.',$3,$4)",
            [earlierMessage, ownerId, threadId, earlierTurn],
          );
          const replied = await send("it's 739", { replyToMessageId: earlierMessage });
          assert.equal(replied.statusCode, 409);
          const prose = ['2 hinges for the door', 'Pay at 15:30'];
          for (const text of prose) assert.equal((await send(text)).statusCode, 200, text);
          assert.deepEqual(ordinary, prose);
          assert.deepEqual(entered, []);
          const response = await send('7395');
          assert.equal(response.statusCode, 200, response.body);
          assert.equal(response.json().verificationStatus, 'submitted');
          assert.deepEqual(entered, ['7395']);
          assert.equal((await send('2026')).statusCode, 200);
          assert.deepEqual(ordinary, [...prose, '2026']);
          assert.deepEqual(entered, ['7395']);
          const persisted = await db.pool.query(
            `SELECT text AS value FROM messages UNION ALL SELECT prompt FROM turns
             UNION ALL SELECT fields::text||status FROM vault_payments`,
          );
          assert.ok(!JSON.stringify(persisted.rows).includes('7395'));
        },
      );
      await t.test(
        'duplicates during and after injection do not replay a code or fall through after request consumption',
        async () => {
          await reset();
          const request = await seed();
          const clientMessageId = randomUUID();
          let release!: () => void;
          hold = new Promise<void>((resolve) => {
            release = resolve;
          });
          const entering = new Promise<void>((resolve) => {
            started = resolve;
          });
          const first = send('The code is 834 725', { clientMessageId });
          await Promise.race([
            entering,
            first.then(() => assert.fail('Expected private verification injection.')),
          ]);
          const duplicate = await send('834725', { clientMessageId });
          assert.equal(duplicate.statusCode, 200, duplicate.body);
          assert.equal(duplicate.json().verificationStatus, 'pending');
          assert.equal(injected.length, 1);
          release();
          assert.equal((await first).statusCode, 200);
          const after = await send('Código: 834725', {
            clientMessageId,
            verificationRequestId: request.requestId,
          });
          assert.equal(after.statusCode, 200, after.body);
          assert.equal(after.json().verificationStatus, 'submitted');
          assert.equal(injected.length, 1);
          assert.deepEqual(ordinary, []);
          assert.equal(
            (await db.pool.query("SELECT * FROM messages WHERE role='user'")).rowCount,
            1,
          );
        },
      );
      await t.test('code-shaped attachments cannot bypass an OTP wait', async () => {
        await reset();
        await seed();
        const response = await send('578231', { attachmentIds: [randomUUID()] });
        assert.equal(response.statusCode, 409, response.body);
        assert.deepEqual(ordinary, []);
        assert.equal(injected.length, 0);
        assert.equal((await db.pool.query("SELECT * FROM messages WHERE role='user'")).rowCount, 0);
      });
      await t.test(
        'ambiguous explicit code replies stay private while a challenge is registered',
        async () => {
          await reset();
          await seed();
          for (const text of [
            'Code: +123456',
            'Code: +351912345678',
            'Code: 123456 or 654321',
            'O código é 739126 ou 928361',
            'Code: 123456 and please continue',
            '739126 ist mein Code',
            'Code: 123',
            'Code: 123456789',
            'Code: 2026-09-29',
          ]) {
            const response = await send(text);
            assert.equal(response.statusCode, 409);
            assert.ok(!response.body.includes(text));
          }
          assert.deepEqual(ordinary, []);
          assert.equal(injected.length, 0);
          assert.equal(
            (await db.pool.query("SELECT * FROM messages WHERE role='user'")).rowCount,
            0,
          );
          assert.equal(
            (await db.pool.query('SELECT * FROM chat_verification_submissions')).rowCount,
            0,
          );
        },
      );
      await t.test(
        'unrelated numeric prose stays ordinary and concise codes need a challenge',
        async () => {
          const unrelated = [
            'The code is in the email',
            'The meeting is at 15:30',
            'I have 2 boxes and 12 hinges',
            'Code:',
          ];
          await reset();
          await seed();
          for (const text of unrelated) assert.equal((await send(text)).statusCode, 200);
          assert.deepEqual(ordinary, unrelated);
          for (const text of ['The code snippet has 123456 lines', 'Order 123456 is ready'])
            assert.equal((await send(text)).statusCode, 409, text);
          assert.deepEqual(ordinary, unrelated);
          assert.equal(injected.length, 0);
          await reset();
          const noChallenge = [
            '2026',
            'Code: +123456',
            'Code: +351912345678',
            'Code = abcdef',
            'Code:',
            'Código =',
            'Code: 123456 or 654321',
            'Code: 2026-09-29',
            'Code: 12.34',
          ];
          for (const text of noChallenge) assert.equal((await send(text)).statusCode, 200);
          assert.deepEqual(ordinary, noChallenge);
          assert.equal(injected.length, 0);
        },
      );
      await t.test(
        'an unavailable fingerprint key never routes pending codes or replays receipts',
        async () => {
          await reset();
          await seed();
          const unavailable = await createChatVerification(db.pool, {
            ownerId,
            keyStore: {
              getKey: async () => {
                throw new Error('Private key failure.');
              },
            },
            refresh() {},
            submitCode: async () => {
              throw new Error('No injection expected.');
            },
          });
          const clientMessageId = randomUUID();
          const assertUnavailable = () =>
            assert.rejects(
              unavailable.accept('482753', {
                clientMessageId,
                persistOrdinary: async () => {
                  throw new Error('No ordinary persistence expected.');
                },
              }),
              (error: unknown) => {
                assert.equal((error as { statusCode: number }).statusCode, 503);
                assert.doesNotMatch(String(error), /482753|Private key failure/);
                return true;
              },
            );
          await assertUnavailable();
          assert.equal(injected.length, 0);
          assert.equal(
            (await db.pool.query("SELECT * FROM messages WHERE role='user'")).rowCount,
            0,
          );
          assert.equal(
            (await db.pool.query('SELECT * FROM chat_verification_submissions')).rowCount,
            0,
          );
          assert.equal(
            (await verification.accept('482753', { clientMessageId }))?.verificationStatus,
            'submitted',
          );
          await assertUnavailable();
          assert.equal(injected.length, 1);
          assert.deepEqual(ordinary, []);
          assert.equal(
            (await db.pool.query('SELECT * FROM chat_verification_submissions')).rowCount,
            1,
          );
        },
      );
      await t.test(
        'foreign, other-channel, expired, reset-thread, non-waiting, superseded and non-code requests cannot accept a code',
        async () => {
          for (const options of [
            { owner: 'someone-else' },
            { channel: 'telegram:other' },
            { archived: true },
            { kind: 'password' },
            { status: 'running', reason: undefined },
            { reason: 'question' },
            { status: 'failed' },
            { superseded: true },
          ]) {
            await reset();
            const request = await seed(options);
            assert.deepEqual(await verification.pending(), []);
            const response = await send('761924', { verificationRequestId: request.requestId });
            assert.equal(response.statusCode, 409, JSON.stringify(options));
            assert.deepEqual(ordinary, []);
            assert.equal(injected.length, 0);
          }
        },
      );
      await t.test('codes are held only while their request is pending', async () => {
        for (const options of [{ status: 'cancelled' }, { status: 'failed' }]) {
          await reset();
          await seed(options);
          const response = await send('The code is 791 483');
          assert.equal(response.statusCode, 409, JSON.stringify(options));
          assert.deepEqual(ordinary, []);
          assert.equal(injected.length, 0);
          assert.equal(
            (await db.pool.query("SELECT * FROM messages WHERE role='user'")).rowCount,
            0,
          );
        }
        for (const options of [
          { superseded: true },
          { status: 'cancelled', superseded: true },
          { status: 'failed', superseded: true },
        ]) {
          await reset();
          await seed(options);
          assert.equal((await send('The code is 791 483')).statusCode, 409);
          assert.deepEqual(ordinary, [], JSON.stringify(options));
          assert.equal(injected.length, 0);
        }
        for (const options of [
          { supersededLongAgo: true },
          { status: 'cancelled', supersededLongAgo: true },
        ]) {
          await reset();
          const stale = await seed(options);
          assert.equal(
            (await send('791483', { replyToMessageId: stale.messageId })).statusCode,
            409,
          );
          assert.equal((await send('Call me at 1530')).statusCode, 200);
          assert.equal((await send('The code is 791 483')).statusCode, 200);
          assert.deepEqual(
            ordinary,
            ['Call me at 1530', 'The code is 791 483'],
            JSON.stringify(options),
          );
          assert.equal(injected.length, 0);
        }
        await reset();
        await seed();
        assert.equal((await send('791483')).statusCode, 200);
        assert.equal(injected.length, 1);
        const persisted = await db.pool.query('SELECT row_to_json(m) FROM messages m');
        assert.doesNotMatch(JSON.stringify(persisted.rows), /791483/);
        assert.equal((await send('Código: 791 483')).statusCode, 200);
        assert.deepEqual(ordinary, ['Código: 791 483']);
        assert.equal(injected.length, 1);
      });
      await t.test(
        'reset fences and invalid explicit code input never persist or route plaintext',
        async () => {
          await reset();
          const request = await seed();
          assert.equal(
            (
              await send('582491', {
                verificationRequestId: request.requestId,
                threadId: randomUUID(),
              })
            ).statusCode,
            409,
          );
          assert.equal(
            (
              await send('my password', {
                verificationRequestId: request.requestId,
                threadId: request.threadId,
              })
            ).statusCode,
            409,
          );
          assert.deepEqual(ordinary, []);
          assert.equal(injected.length, 0);
          assert.equal(
            (await db.pool.query("SELECT * FROM messages WHERE role='user'")).rowCount,
            0,
          );
        },
      );
    } finally {
      await app.close();
    }
  },
);
