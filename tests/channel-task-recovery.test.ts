import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import type { MessagingTransport } from '../src/ports/messaging.ts';
import { createChannels } from '../src/server/channels.ts';
import { TaskReviewRequiredError } from '../src/server/outcomes.ts';

test(
  'blocked channel continuations refuse once without poisoning later work or acknowledging unknown failures',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_channel_recovery_${suffix}`;
    const bossSchema = `test_channel_recovery_jobs_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const db = await import('../src/server/db.ts');
    const tasks = await import('../src/server/tasks.ts');
    const { dataRoot } = await import('../src/server/config.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const fixtures: Array<{ close(): Promise<void> }> = [];
    const sent: Array<Parameters<MessagingTransport['post']>[0]> = [];
    const refusal = 'I can’t safely repeat the earlier action because its outcome is unknown.';
    const waitFor = async (check: () => Promise<boolean> | boolean) => {
      for (let attempt = 0; attempt < 300; attempt++) {
        if (await check()) return;
        await delay(20);
      }
      throw new Error('Fixture condition did not complete.');
    };
    const row = async (id: string) =>
      (await db.pool.query('SELECT * FROM tasks WHERE id=$1', [id])).rows[0];
    const jobs = async () =>
      (
        await db.pool.query(
          `SELECT id,data FROM ${bossSchema}.job WHERE name='assistant-task' ORDER BY id`,
        )
      ).rows;
    const open = async (
      accountId: string,
      submit: Parameters<typeof createChannels>[1]['submit'],
      prepare?: Parameters<typeof createChannels>[1]['prepare'],
      ownerId = 'local-development',
    ) => {
      const app = Fastify();
      const transport = (): MessagingTransport => ({
        channels: ['telegram', 'whatsapp'].map((id) => ({
          id,
          status: 'configured',
          missing: [],
          accountId,
          allowedSenderIds: [`${accountId}-sender`],
          ...(id === 'whatsapp' ? { replyWindowMs: 86400000 } : {}),
        })),
        receive: async (request) => {
          const body = JSON.parse(Buffer.from(request.body).toString('utf8'));
          return {
            status: 200,
            body: 'accepted',
            messages: [
              {
                channelId: request.channelId,
                accountId,
                senderId: `${accountId}-sender`,
                messageId: body.id,
                threadId: `${accountId}-thread-${body.id}`,
                text: body.text,
                sentAt: new Date(),
              },
            ],
          };
        },
        post: async (message) => {
          sent.push(message);
          return { id: randomUUID() };
        },
        close: async () => {},
      });
      const channels = await createChannels(db.pool, {
        ownerId,
        transport: transport(),
        submit,
        ...(prepare ? { prepare } : {}),
        subscribe: () => () => {},
        intervalMs: 600000,
      });
      channels.registerRoutes(app);
      fixtures.push(app);
      return {
        app,
        channels,
        transport,
        source: (id: string, provider = 'telegram') => `channel:${provider}:${accountId}:${id}`,
        send: (id: string, text = 'Continue the earlier synthetic action', provider = 'telegram') =>
          app.inject({ method: 'POST', url: `/api/webhooks/${provider}`, payload: { id, text } }),
      };
    };
    let originalId = '';
    try {
      await db.initializeDatabase();
      await tasks.initializeTasks();
      await createPersonalService({
        pool: db.pool,
        ownerId: 'local-development',
        scheduler: tasks.boss,
        submitTask: tasks.submitTask,
        refresh() {},
      }).initialize({ workers: false });
      await t.test(
        'the real failed-task route produces one owned refusal and lets fresh inbound and outbound finish',
        async () => {
          let originalOutcome = '';
          const service = tasks.createUserMessageService({
            routeConversation: async (context) => {
              if (context.text === 'Continue the earlier synthetic action') {
                assert.ok(
                  context.blockedCandidates?.some(
                    (candidate) => candidate.outcomeId === originalOutcome,
                  ),
                );
                return { kind: 'continue', outcomeId: originalOutcome };
              }
              return {
                kind: 'new_outcome',
                title: 'Synthetic channel work',
                objective: 'Produce an independent fixture result.',
              };
            },
          });
          const fixture = await open(
            'fixture-owner-a',
            async (text, sourceId, client, channel, preparedRoute, clientMessageId) =>
              (
                await service.submit(text, [], {
                  sourceId,
                  client,
                  channel,
                  preparedRoute,
                  clientMessageId,
                })
              ).taskId,
            (text, sourceId, channel) => service.prepare(text, [], { sourceId, channel }),
          );
          await fixture.send('original', 'Create the original fixture work');
          await fixture.channels.drain();
          originalId = (
            await db.pool.query('SELECT task_id FROM channel_inbox WHERE source_id=$1', [
              fixture.source('original'),
            ])
          ).rows[0].task_id;
          await db.pool.query(
            "UPDATE tasks SET status='failed',error='Synthetic unknown action',external_action=true WHERE id=$1",
            [originalId],
          );
          originalOutcome = (await row(originalId)).outcome_id;
          const before = await row(originalId);
          const jobsBefore = await jobs();
          await fixture.send('blocked');
          await fixture.channels.drain();
          assert.deepEqual(await row(originalId), before);
          assert.deepEqual(await jobs(), jobsBefore);
          assert.equal(
            (
              await db.pool.query('SELECT id FROM pending_task_inputs WHERE task_id=$1', [
                originalId,
              ])
            ).rowCount,
            0,
          );
          const receipt = (
            await db.pool.query(
              `SELECT i.state,i.task_id,i.owner_id,m.owner_id AS message_owner,m.task_id AS message_task,m.role,m.text,o.state AS delivery
           FROM channel_inbox i JOIN channel_outbox o USING(source_id) JOIN messages m ON m.id=o.message_id WHERE i.source_id=$1`,
              [fixture.source('blocked')],
            )
          ).rows[0];
          assert.deepEqual(receipt, {
            state: 'discarded',
            task_id: null,
            owner_id: 'local-development',
            message_owner: 'local-development',
            message_task: null,
            role: 'assistant',
            text: refusal,
            delivery: 'sent',
          });
          await fixture.send('blocked');
          await fixture.channels.drain();
          assert.equal(
            sent.filter((message) => message.threadId === 'fixture-owner-a-thread-blocked').length,
            1,
          );
          await tasks.startTaskWorkers({
            runTask: async (context) => {
              await context.reply('Independent fixture completed.');
              return { status: 'succeeded' };
            },
            speech: {
              synthesize: async () => {
                throw new Error('Unused fixture.');
              },
            },
            requestCredential: async () => ({ url: '/vault/fixture' }),
            integration: async () => ({}),
            manage: async () => ({}),
          });
          await fixture.send('independent', 'Read an independent synthetic value');
          await fixture.channels.drain();
          const independentId = (
            await db.pool.query('SELECT task_id FROM channel_inbox WHERE source_id=$1', [
              fixture.source('independent'),
            ])
          ).rows[0].task_id;
          assert.notEqual(independentId, originalId);
          await waitFor(async () => (await row(independentId)).status === 'succeeded');
          await fixture.channels.drain();
          assert.ok(
            sent.some(
              (message) =>
                message.accountId === 'fixture-owner-a' &&
                message.threadId === 'fixture-owner-a-thread-independent' &&
                message.text === 'Independent fixture completed.',
            ),
          );
          assert.deepEqual(await row(originalId), before);
          await fixture.app.close();
        },
      );
      await t.test(
        'a recognized refusal rolls back partial tasks, jobs, messages and old revisions before committing its receipt',
        async () => {
          const before = await row(originalId);
          const jobsBefore = await jobs();
          const messagesBefore = (await db.pool.query('SELECT id FROM messages ORDER BY id')).rows;
          const fixture = await open(
            'fixture-rollback',
            async (_text, sourceId, client, channel) => {
              await tasks.submitTask('PRIVATE-PARTIAL-FIXTURE', [], undefined, false, {
                client,
                channel,
                sourceId,
              });
              await client.query('UPDATE tasks SET revision=revision+1 WHERE id=$1', [originalId]);
              throw new TaskReviewRequiredError(randomUUID(), 'Synthetic blocked work');
            },
          );
          await db.pool.query(
            "ALTER TABLE channel_outbox ADD CONSTRAINT fixture_refusal_failure CHECK(source_id<>'channel:telegram:fixture-rollback:rollback')",
          );
          await fixture.send('rollback');
          await fixture.channels.drain();
          assert.deepEqual(await row(originalId), before);
          assert.deepEqual(await jobs(), jobsBefore);
          assert.deepEqual(
            (await db.pool.query('SELECT id FROM messages ORDER BY id')).rows,
            messagesBefore,
          );
          assert.equal(
            (
              await db.pool.query('SELECT state FROM channel_inbox WHERE source_id=$1', [
                fixture.source('rollback'),
              ])
            ).rows[0].state,
            'pending',
          );
          assert.equal(
            sent.some((message) => message.accountId === 'fixture-rollback'),
            false,
          );
          await db.pool.query('ALTER TABLE channel_outbox DROP CONSTRAINT fixture_refusal_failure');
          await fixture.channels.drain();
          assert.deepEqual(await row(originalId), before);
          assert.deepEqual(await jobs(), jobsBefore);
          assert.equal(
            (await db.pool.query("SELECT id FROM tasks WHERE prompt='PRIVATE-PARTIAL-FIXTURE'"))
              .rowCount,
            0,
          );
          assert.equal(
            (await db.pool.query("SELECT id FROM messages WHERE text='PRIVATE-PARTIAL-FIXTURE'"))
              .rowCount,
            0,
          );
          assert.deepEqual(
            (
              await db.pool.query('SELECT state,task_id FROM channel_inbox WHERE source_id=$1', [
                fixture.source('rollback'),
              ])
            ).rows[0],
            { state: 'discarded', task_id: null },
          );
          assert.equal(
            sent.filter((message) => message.accountId === 'fixture-rollback').length,
            1,
          );
          await fixture.app.close();
        },
      );
      await t.test(
        'refusals retain the exact second owner, channel, account and thread',
        async () => {
          const fixture = await open(
            'fixture-owner-b',
            async () => {
              throw new TaskReviewRequiredError(randomUUID(), 'Synthetic blocked work');
            },
            undefined,
            'second-owner',
          );
          for (const provider of ['telegram', 'whatsapp']) {
            await fixture.send(provider, 'Continue the earlier synthetic action', provider);
            await fixture.channels.drain();
            const receipt = (
              await db.pool.query(
                'SELECT i.owner_id,m.owner_id AS message_owner,i.provider,i.account_id,i.thread_id,m.task_id FROM channel_inbox i JOIN channel_outbox o USING(source_id) JOIN messages m ON m.id=o.message_id WHERE i.source_id=$1',
                [fixture.source(provider, provider)],
              )
            ).rows[0];
            assert.deepEqual(receipt, {
              owner_id: 'second-owner',
              message_owner: 'second-owner',
              provider,
              account_id: 'fixture-owner-b',
              thread_id: `fixture-owner-b-thread-${provider}`,
              task_id: null,
            });
            assert.ok(
              sent.some(
                (message) =>
                  message.channelId === provider &&
                  message.accountId === 'fixture-owner-b' &&
                  message.threadId === `fixture-owner-b-thread-${provider}` &&
                  message.text === refusal,
              ),
            );
          }
          assert.equal(
            (
              await db.pool.query(
                "SELECT id FROM messages WHERE owner_id='second-owner' AND role='user'",
              )
            ).rowCount,
            0,
          );
          await fixture.app.close();
        },
      );
      await t.test(
        'generic conflicts and unknown errors remain pending with no refusal or partial writes',
        async () => {
          for (const mode of ['generic-409', 'unknown']) {
            let blocked = true;
            const fixture = await open(
              `fixture-${mode}`,
              async (_text, sourceId, client, channel) => {
                const id = await tasks.submitTask('PRIVATE-RETRY-FIXTURE', [], undefined, false, {
                  client,
                  channel,
                  sourceId,
                });
                if (blocked) {
                  const error = new Error('PRIVATE-UNEXPECTED-FAILURE');
                  if (mode === 'generic-409') Object.assign(error, { statusCode: 409 });
                  throw error;
                }
                return id;
              },
            );
            const jobsBefore = await jobs();
            await fixture.send('retry');
            await fixture.channels.drain();
            assert.deepEqual(await jobs(), jobsBefore);
            assert.equal(
              (
                await db.pool.query('SELECT state FROM channel_inbox WHERE source_id=$1', [
                  fixture.source('retry'),
                ])
              ).rows[0].state,
              'pending',
            );
            assert.equal(
              (
                await db.pool.query('SELECT message_id FROM channel_outbox WHERE source_id=$1', [
                  fixture.source('retry'),
                ])
              ).rowCount,
              0,
            );
            assert.equal(
              sent.some((message) => message.accountId === `fixture-${mode}`),
              false,
            );
            blocked = false;
            await fixture.channels.drain();
            assert.equal(
              (
                await db.pool.query('SELECT state FROM channel_inbox WHERE source_id=$1', [
                  fixture.source('retry'),
                ])
              ).rows[0].state,
              'submitted',
            );
            await fixture.app.close();
          }
        },
      );
      await t.test(
        'closure during a refused submission leaves its inbox retryable without emitting a stale reply',
        async () => {
          let release = () => {};
          let entered = () => {};
          const started = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          const fixture = await open('fixture-closing', async () => {
            entered();
            await held;
            throw new TaskReviewRequiredError(randomUUID(), 'Synthetic blocked work');
          });
          await fixture.send('close');
          await started;
          const closing = fixture.channels.close();
          release();
          await closing;
          assert.equal(
            (
              await db.pool.query('SELECT state FROM channel_inbox WHERE source_id=$1', [
                fixture.source('close'),
              ])
            ).rows[0].state,
            'pending',
          );
          assert.equal(
            (
              await db.pool.query('SELECT message_id FROM channel_outbox WHERE source_id=$1', [
                fixture.source('close'),
              ])
            ).rowCount,
            0,
          );
          assert.equal(
            sent.some((message) => message.accountId === 'fixture-closing'),
            false,
          );
          await fixture.app.close();
          const reopened = await open('fixture-closing', async () => {
            throw new TaskReviewRequiredError(randomUUID(), 'Synthetic blocked work');
          });
          await reopened.channels.drain();
          assert.equal(sent.filter((message) => message.accountId === 'fixture-closing').length, 1);
          await reopened.app.close();
        },
      );
    } finally {
      await Promise.all(fixtures.map((fixture) => fixture.close()));
      await tasks.stopTasks();
      const ids = (await db.pool.query('SELECT id FROM tasks')).rows.map(
        (entry) => entry.id as string,
      );
      await db.pool.end();
      for (const id of ids)
        await rm(join(dataRoot, 'workspaces', id), { recursive: true, force: true });
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
