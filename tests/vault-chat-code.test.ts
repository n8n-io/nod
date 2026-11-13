import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { accessCookie, accessKey } from '../src/server/access.ts';

test('a verification code is held back in any wording or language and is the code only by itself', async () => {
  const { classifyVerificationReply, securityCodeIn } =
    await import('../src/shared/verification-code.ts');
  for (const text of ['1234', '12 34', ' 1234. '])
    assert.deepEqual(classifyVerificationReply(text), { kind: 'code', code: '1234' });
  for (const text of [
    'Your code is 1234',
    '验证码1234',
    'رمز1234',
    'otp1234',
    'code:1234',
    'oh and while ur in there whats the status of invoice NS-1042',
  ])
    assert.deepEqual(classifyVerificationReply(text), { kind: 'wrapped' });
  for (const text of ['1234 is the code', 'Send 12 34 as the code', 'otp 1234 now', '+1234'])
    assert.deepEqual(classifyVerificationReply(text), { kind: 'invalid' });
  for (const text of ['MP3', 'meeting at 10:30', 'abc123def', 'no numbers here'])
    assert.deepEqual(classifyVerificationReply(text), { kind: 'ordinary' });
  assert.equal(securityCodeIn('1234'), '1234');
  assert.equal(securityCodeIn('CVV: 123'), '123');
});

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
      present: async () => ({
        question: 'Synthetic private payment step.',
        action: 'Approve payment',
      }),
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
        'DELETE FROM audio_messages; DELETE FROM chat_verification_submissions; DELETE FROM messages; DELETE FROM credential_requests; DELETE FROM vault_payments; DELETE FROM turn_events; DELETE FROM turns; DELETE FROM threads',
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
        'custom choice answers keep private code screening while exact visible choices stay ordinary',
        async () => {
          const { createSpeech } = await import('../src/server/speech.ts');
          let spokenCode = '';
          let transcriptions = 0;
          const isolated = await createApp({
            verification,
            configuration: () => ({ ...configuration(), llmReady: true }),
            speech: createSpeech({
              id: 'fixture',
              configured: true,
              async transcribe() {
                transcriptions++;
                return spokenCode;
              },
              async synthesize() {
                throw new Error('Unexpected synthetic speech output.');
              },
            }),
          });
          const sendAudio = (message: object) => {
            const boundary = 'synthetic-choice-audio';
            return isolated.inject({
              method: 'POST',
              url: '/api/messages/audio',
              headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
              payload: Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\n${JSON.stringify(message)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.webm"\r\nContent-Type: audio/webm\r\n\r\nSynthetic private recording\r\n--${boundary}--\r\n`,
              ),
            });
          };
          try {
            for (const kind of ['otp', 'payment']) {
              await reset();
              const privateQuestion = await seed();
              const code = kind === 'otp' ? '123456' : '737';
              if (kind === 'payment') {
                await db.pool.query('DELETE FROM credential_requests');
                await payments.request(privateQuestion, {
                  amount: '43.20',
                  currency: 'EUR',
                  fields: { number: '@e4', expiry: '@e5', securityCode: '@e6' },
                });
              }
              const questionId = randomUUID();
              const questionTurn = randomUUID();
              const choiceId = randomUUID();
              await db.pool.query(
                `INSERT INTO turns(id,owner_id,thread_id,session_id,source,prompt,status,waiting_reason)
                  VALUES($1,$2,$3,$1,'event','Choose a synthetic reference','waiting','question')`,
                [questionTurn, ownerId, privateQuestion.threadId],
              );
              await db.pool.query(
                `INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id,answer_choices)
                  VALUES($1,$2,'assistant','Which reference?',$3,$4,$5)`,
                [
                  questionId,
                  ownerId,
                  privateQuestion.threadId,
                  questionTurn,
                  JSON.stringify({ options: [{ id: choiceId, label: code }], multiple: false }),
                ],
              );
              const submit = (input: object) =>
                isolated.inject({
                  method: 'POST',
                  url: '/api/messages',
                  headers,
                  payload: {
                    text: code,
                    threadId: privateQuestion.threadId,
                    replyToMessageId: questionId,
                    clientMessageId: randomUUID(),
                    ...input,
                  },
                });
              const customId = randomUUID();
              const custom = await submit({
                clientMessageId: customId,
                questionAnswer: { custom: true },
              });
              assert.equal(custom.statusCode, 409, custom.body);
              assert.equal(
                (
                  await db.pool.query(
                    'SELECT 1 FROM messages WHERE id=$1 UNION ALL SELECT 1 FROM turns WHERE message_id=$1',
                    [customId],
                  )
                ).rowCount,
                0,
              );
              spokenCode = code;
              const audio = {
                threadId: privateQuestion.threadId,
                replyToMessageId: questionId,
                clientMessageId: randomUUID(),
                questionAnswer: { custom: true },
              };
              const before = transcriptions;
              const recorded = await sendAudio(audio);
              assert.equal(recorded.statusCode, 409, recorded.body);
              assert.equal(transcriptions, before + 1);
              assert.equal((await sendAudio(audio)).statusCode, 409);
              assert.equal(transcriptions, before + 1);
              assert.equal(
                (
                  await db.pool.query(
                    'SELECT 1 FROM messages WHERE id=$1 UNION ALL SELECT 1 FROM turns WHERE message_id=$1 UNION ALL SELECT 1 FROM audio_messages WHERE message_id=$1 AND response IS NOT NULL',
                    [audio.clientMessageId],
                  )
                ).rowCount,
                0,
              );
              assert.equal((await db.pool.query('SELECT 1 FROM artifacts')).rowCount, 0);
              assert.equal(
                (
                  await submit({
                    replyToMessageId: privateQuestion.messageId,
                    questionAnswer: { choiceIds: [choiceId] },
                  })
                ).statusCode,
                409,
              );
              const chosenId = randomUUID();
              const selection = {
                clientMessageId: chosenId,
                questionAnswer: { choiceIds: [choiceId] },
              };
              const chosen = await submit(selection);
              assert.equal(chosen.statusCode, 200, chosen.body);
              assert.deepEqual((await submit(selection)).json(), chosen.json());
              assert.equal(
                (await db.pool.query('SELECT text FROM messages WHERE id=$1', [chosenId])).rows[0]
                  .text,
                code,
              );
              assert.deepEqual(entered, []);
              assert.deepEqual(injected, []);
            }
          } finally {
            await isolated.close();
          }
        },
      );
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
        'cancellation after reservation records no delivery and never replays started private entry',
        async () => {
          for (const afterEntry of [false, true]) {
            await reset();
            const request = await seed();
            const controller = new AbortController();
            const cancelled = new Error('Synthetic cancellation.');
            const delivered: string[] = [];
            const guarded = await createChatVerification(db.pool, {
              ownerId,
              keyStore: { getKey: async () => Buffer.alloc(32, 61) },
              refresh() {
                if (!afterEntry) controller.abort(cancelled);
              },
              submitCode: async (_owner, _turn, code) => {
                delivered.push(code);
                controller.abort(cancelled);
                return { status: 'submitted' };
              },
            });
            const clientMessageId = randomUUID();
            await assert.rejects(
              guarded.accept('563829', {
                clientMessageId,
                threadId: request.threadId,
                signal: controller.signal,
                persistVerification: async () => controller.signal.throwIfAborted(),
              }),
              (error: unknown) => error === cancelled,
            );
            const receipt = (
              await db.pool.query(
                `SELECT v.status,m.text FROM chat_verification_submissions v
                 JOIN messages m ON m.id=v.message_id WHERE v.message_id=$1`,
                [clientMessageId],
              )
            ).rows[0];
            assert.equal(receipt.status, afterEntry ? 'submitted' : 'cancelled');
            if (afterEntry) assert.match(receipt.text, /sent securely/);
            else assert.match(receipt.text, /cancelled/i);
            assert.deepEqual(delivered, afterEntry ? ['563829'] : []);
            assert.doesNotMatch(JSON.stringify(receipt), /563829/);
            const replay = await guarded.accept('563829', {
              clientMessageId,
              threadId: request.threadId,
            });
            assert.equal(replay?.verificationStatus, afterEntry ? 'submitted' : 'unavailable');
            assert.equal(replay?.messageText, receipt.text);
            assert.deepEqual(delivered, afterEntry ? ['563829'] : []);
          }
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
        'a security code sent by itself pays in Nod while unrelated numbered messages reach chat',
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
          const unrelated = [
            'unrelated but can u remind me what invoice NS-1043 was for? the paid one',
            '2 hinges for 2041',
            'card ending 4242',
            'The year is 2026',
            'What is code abc123def?',
            'What is code abc123?',
          ];
          for (const text of unrelated) assert.equal((await send(text)).statusCode, 200, text);
          const wrappedCodes = ['my code is 1234', 'Code: 123', 'O código é 739', 'pin 8421'];
          for (const text of wrappedCodes) {
            const response = await send(text);
            assert.equal(response.statusCode, 409, text);
            assert.ok(!response.body.includes(text));
          }
          assert.deepEqual(ordinary, unrelated);
          assert.deepEqual(entered, []);
          assert.equal(
            (await db.pool.query('SELECT text FROM messages WHERE role=$1', ['user'])).rows.some(
              ({ text }: { text: string }) => wrappedCodes.includes(text),
            ),
            false,
          );
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
          assert.equal(replied.statusCode, 200);
          const prose = ['2 hinges for the door', 'Pay at 15:30'];
          for (const text of prose) assert.equal((await send(text)).statusCode, 200, text);
          assert.deepEqual(ordinary, [...unrelated, "it's 739", ...prose]);
          assert.deepEqual(entered, []);
          const response = await send('7395');
          assert.equal(response.statusCode, 200, response.body);
          assert.equal(response.json().verificationStatus, 'submitted');
          assert.deepEqual(entered, ['7395']);
          assert.equal((await send('2026')).statusCode, 200);
          assert.deepEqual(ordinary, [...unrelated, "it's 739", ...prose, '2026']);
          assert.deepEqual(entered, ['7395']);
          const persisted = await db.pool.query(
            `SELECT text AS value FROM messages UNION ALL SELECT prompt FROM turns
             UNION ALL SELECT fields::text||status FROM vault_payments`,
          );
          assert.ok(!JSON.stringify(persisted.rows).includes('7395'));
        },
      );
      await t.test(
        'an expired payment still holds code-like replies while an invoice question reaches chat',
        async () => {
          await reset();
          const threadId = (await thread.activeThread(db.pool, ownerId)).id;
          const turnId = randomUUID();
          await db.pool.query(
            `INSERT INTO turns(id,owner_id,thread_id,source,prompt,channel,status,waiting_reason,started_at)
             VALUES($1,$2,$3,'user','Buy the hinges','web','waiting','credentials',clock_timestamp())`,
            [turnId, ownerId, threadId],
          );
          await payments.request(
            { threadId, turnId },
            {
              amount: '43.20',
              currency: 'EUR',
              fields: { number: '@e4', expiry: '@e5', securityCode: '@e6' },
            },
          );
          await db.pool.query(
            `INSERT INTO turns(id,owner_id,thread_id,source,prompt,channel,status,started_at)
             VALUES($1,$2,$3,'user','Unrelated follow-up','web','succeeded',clock_timestamp())`,
            [randomUUID(), ownerId, threadId],
          );
          assert.equal((await send('739')).statusCode, 409);
          assert.equal((await send('73951')).statusCode, 409);
          assert.equal((await send('my code is 739')).statusCode, 409);
          assert.equal((await send('Code: 739')).statusCode, 409);
          const question = 'What was invoice NS-1043 for?';
          assert.equal((await send(question)).statusCode, 200);
          assert.deepEqual(ordinary, [question]);
          assert.deepEqual(entered, []);
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
          const first = send('834 725', { clientMessageId });
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
          const after = await send('834725.', {
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
      await t.test(
        'ambiguous explicit code replies stay private while a challenge is registered',
        async () => {
          await reset();
          const question = await seed();
          for (const text of [
            'oh and while ur in there whats the status of invoice NS-1042',
            'Your code is 482913',
            '验证码482913',
            'Code: +123456',
            'Code: +351912345678',
            'Code: 123456 or 654321',
            'O código é 739126 ou 928361',
            'Code: 123456 and please continue',
            '739126 ist mein Code',
            'Code: 123',
            'Code: 123456789',
            'Code: 2026-09-29',
          ])
            for (const reply of [{}, { replyToMessageId: question.messageId }]) {
              const response = await send(text, reply);
              assert.equal(response.statusCode, 409, text);
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
          assert.equal((await send('482913')).json().verificationStatus, 'submitted');
          assert.deepEqual(
            injected.map(({ code }) => code),
            ['482913'],
          );
          await reset();
          await seed({ superseded: true });
          assert.equal((await send('Your code is 482913')).statusCode, 409);
          assert.deepEqual(ordinary, []);
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
    } finally {
      await app.close();
    }
  },
);
