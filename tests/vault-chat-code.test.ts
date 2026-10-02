import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

test(
  'chat verification intercepts owned codes before message routing and plaintext persistence',
  {
    skip: !process.env.TEST_DATABASE_URL,
    timeout: 30_000,
  },
  async (t) => {
    const schema = `test_chat_codes_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    const db = await import('../src/server/db.ts');
    const { createChatVerification } = await import('../src/server/chat-verification.ts');
    const thread = await import('../src/server/thread.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { ownerId, port, configuration } = await import('../src/server/config.ts');
    await db.initializeDatabase();
    await db.pool.query(`CREATE TABLE credential_requests (
    id text PRIMARY KEY,thread_id uuid REFERENCES threads(id),turn_id uuid REFERENCES turns(id),
    owner_id text NOT NULL,kind text NOT NULL,status text NOT NULL DEFAULT 'pending',
    expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
  )`);
    const ordinary: string[] = [];
    const injected: Array<{ owner: string; turnId: string; code: string; requestId: string }> = [];
    let outcome: 'submitted' | 'unavailable' = 'submitted';
    let hold: Promise<void> | undefined;
    let started: (() => void) | undefined;
    let throwPrivateError = false;
    const verification = await createChatVerification(db.pool, {
      ownerId,
      keyStore: { getKey: async () => Buffer.alloc(32, 61) },
      refresh() {},
      async submitCode(owner, turnId, code, requestId) {
        injected.push({ owner, turnId, code, requestId });
        started?.();
        await hold;
        if (throwPrivateError) throw new Error(`Untrusted website echoed ${code}`);
        if (outcome === 'submitted') {
          await db.pool.query("UPDATE credential_requests SET status='filled' WHERE id=$1", [
            requestId,
          ]);
        }
        return { status: outcome };
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
    const headers = { host: `localhost:${port}`, origin: `http://localhost:${port}` };
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
        expired?: boolean;
        archived?: boolean;
        status?: string;
        reason?: string;
        superseded?: boolean;
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
        `INSERT INTO credential_requests(id,thread_id,turn_id,owner_id,kind,expires_at)
      VALUES($1,$2,$3,$4,$5,now()+$6::interval)`,
        [
          requestId,
          threadId,
          turnId,
          owner,
          options.kind ?? 'otp',
          options.expired ? '-1 minute' : '10 minutes',
        ],
      );
      await db.pool.query(
        "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id) VALUES($1,$2,'assistant','Reply with the verification code.',$3,$4)",
        [messageId, owner, threadId, turnId],
      );
      if (options.archived)
        await db.pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [threadId]);
      if (options.superseded)
        await db.pool.query(
          `INSERT INTO turns(id,owner_id,thread_id,source,prompt,status,started_at)
           VALUES($1,$2,$3,'user','Later','running',clock_timestamp())`,
          [randomUUID(), owner, threadId],
        );
      return { threadId, turnId, requestId, messageId };
    }
    async function reset() {
      await db.pool.query(
        'DELETE FROM chat_verification_submissions; DELETE FROM messages; DELETE FROM credential_requests; DELETE FROM turn_events; DELETE FROM turns; DELETE FROM threads',
      );
      ordinary.length = 0;
      injected.length = 0;
      outcome = 'submitted';
      hold = undefined;
      started = undefined;
      throwPrivateError = false;
    }
    try {
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
          ]) {
            await reset();
            const request = await seed();
            const before = (await app.inject({ url: '/api/state', headers })).json();
            assert.equal(before.verificationRequests[0].id, request.requestId);
            assert.deepEqual(Object.keys(before.verificationRequests[0]).sort(), [
              'expiresAt',
              'id',
              'turnId',
            ]);
            const response = await send(text);
            assert.equal(response.statusCode, 200, response.body);
            assert.equal(response.json().messageText, 'Verification code sent securely.');
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
            assert.equal((await db.pool.query('SELECT * FROM inspector_records')).rowCount, 0);
          }
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
          assert.equal(duplicate.json().messageText, 'Verification code received securely.');
          const pendingReceipt = (
            await db.pool.query('SELECT text FROM messages WHERE id=$1', [clientMessageId])
          ).rows[0];
          assert.equal(pendingReceipt.text, 'Verification code received securely.');
          assert.equal(injected.length, 1);
          release();
          assert.equal((await first).statusCode, 200);
          const after = await send('Código: 834725', {
            clientMessageId,
            verificationRequestId: request.requestId,
          });
          assert.equal(after.statusCode, 200, after.body);
          assert.equal(after.json().verificationStatus, 'submitted');
          await db.pool.query(
            "UPDATE chat_verification_submissions SET status='rejected' WHERE message_id=$1",
            [clientMessageId],
          );
          const legacy = await send('Código: 834725', {
            clientMessageId,
            verificationRequestId: request.requestId,
          });
          assert.equal(legacy.json().verificationStatus, 'unavailable');
          assert.equal(injected.length, 1);
          assert.deepEqual(ordinary, []);
          assert.equal(
            (await db.pool.query("SELECT * FROM messages WHERE role='user'")).rowCount,
            1,
          );
        },
      );
      await t.test('only the latest waiting turn accepts a code', async () => {
        await reset();
        const first = await seed();
        const second = await seed();
        assert.deepEqual(
          (await verification.pending()).map((request) => request.id),
          [second.requestId],
        );
        assert.equal(
          (await send('473826', { verificationRequestId: first.requestId })).statusCode,
          409,
        );
        assert.equal(injected.length, 0);
        assert.equal((await send('473826')).statusCode, 200);
        assert.equal(injected[0]?.requestId, second.requestId);
        assert.deepEqual(ordinary, []);
      });
      await t.test(
        'code-shaped attachments and forced messages cannot bypass an OTP wait',
        async () => {
          for (const extra of [{ attachmentIds: [randomUUID()] }, { forceNew: true }]) {
            await reset();
            await seed();
            const response = await send('578231', extra);
            assert.equal(response.statusCode, 'forceNew' in extra ? 400 : 409, response.body);
            assert.match(
              response.json().error,
              'forceNew' in extra ? /Check the supplied values/ : /code by itself/,
            );
            assert.deepEqual(ordinary, []);
            assert.equal(injected.length, 0);
            assert.equal(
              (await db.pool.query("SELECT * FROM messages WHERE role='user'")).rowCount,
              0,
            );
          }
          await reset();
          assert.equal((await send('2026', { forceNew: true })).statusCode, 400);
          assert.deepEqual(ordinary, []);
          assert.equal((await send('2026')).statusCode, 200);
          assert.deepEqual(ordinary, ['2026']);
        },
      );
      await t.test(
        'ambiguous explicit code replies stay private while a challenge is registered',
        async () => {
          await reset();
          await seed();
          for (const text of [
            'Code: +123456',
            'Code: +351912345678',
            'Code = abcdef',
            'Code:',
            'Código =',
            'Code: 123456 or 654321',
            'O código é 739126 ou 928361',
            'Code: 123456 and please continue',
            'Code: 123',
            'Code: 123456789',
            'Code: 2026-09-29',
            'Code: 12.34',
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
            'The year is 2026',
            'The code snippet has 123456 lines',
            'Code snippet has 123456 lines',
            'The code is in the email',
            'Order 123456 is ready',
          ];
          await reset();
          await seed();
          for (const text of unrelated) assert.equal((await send(text)).statusCode, 200);
          assert.deepEqual(ordinary, unrelated);
          assert.equal(injected.length, 0);
          await reset();
          const noChallenge = [
            '2026',
            'The code is 739126',
            'Código: 739 126',
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
          let keyReads = 0;
          const unavailable = await createChatVerification(db.pool, {
            ownerId,
            keyStore: {
              getKey: async () => {
                keyReads += 1;
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
          assert.equal(keyReads, 1);
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
          assert.equal(keyReads, 2);
          assert.equal(injected.length, 1);
          assert.deepEqual(ordinary, []);
          assert.equal(
            (await db.pool.query('SELECT * FROM chat_verification_submissions')).rowCount,
            1,
          );
          assert.equal(
            (await db.pool.query('SELECT text FROM messages WHERE id=$1', [clientMessageId]))
              .rows[0].text,
            'Verification code sent securely.',
          );
        },
      );
      await t.test(
        'foreign, other-channel, expired, reset-thread, non-waiting, superseded and non-code requests cannot accept a code',
        async () => {
          for (const options of [
            { owner: 'someone-else' },
            { channel: 'telegram:other' },
            { expired: true },
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
      await t.test(
        'expired, stopped and consumed code replies never become ordinary chat',
        async () => {
          for (const options of [
            { expired: true },
            { status: 'cancelled' },
            { status: 'failed' },
            { status: 'cancelled', expired: true },
            { status: 'failed', expired: true },
          ]) {
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
          await reset();
          await seed();
          assert.equal((await send('791483')).statusCode, 200);
          assert.equal((await send('Código: 791 483')).statusCode, 409);
          await db.pool.query(
            "UPDATE credential_requests SET expires_at=now()-interval '1 minute'",
          );
          assert.equal((await send('Código: 791 483')).statusCode, 409);
          assert.equal(injected.length, 1);
          assert.deepEqual(ordinary, []);
          const persisted = await db.pool.query('SELECT row_to_json(m) FROM messages m');
          assert.doesNotMatch(JSON.stringify(persisted.rows), /791483/);
        },
      );
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
      await db.pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
