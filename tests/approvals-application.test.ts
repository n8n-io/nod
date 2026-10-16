import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { AgentToolResult } from '../src/ports/agent.ts';
import type { Preferences } from '../src/server/preferences.ts';
import { createIntegrationFixture } from '../scripts/e2e-fixtures.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';
import { accessCookie, accessKey } from '../src/server/access.ts';

test(
  'personal approvals revalidate targets before execution',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_personal_review_${suffix}`;
    const bossSchema = `test_personal_review_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    t.after(async () => {
      await admin.query(
        `DROP SCHEMA IF EXISTS ${bossSchema} CASCADE; DROP SCHEMA ${schema} CASCADE`,
      );
      await admin.end();
    });
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'otto-test-runtime-'));
    t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
    process.env.OTTO_DATA_ROOT = runtimeRoot;
    const { createApplication } = await import('../src/server/composition.ts');
    const { pool } = await import('../src/server/db.ts');
    const { dataRoot, ownerId, port } = await import('../src/server/config.ts');
    const { enqueueTurn } = await import('../src/server/thread.ts');
    const phases = new Map<string, number>();
    const results = new Map<string, AgentToolResult>();
    const plans = new Map<
      string,
      { tool?: string; action: string; args: Record<string, unknown> }
    >();
    const batches = new Map<
      string,
      { subagents: boolean; calls: Array<{ action: string; args: Record<string, unknown> }> }
    >();
    const parts = new Map<string, { action: string; args: Record<string, unknown> }>();
    let partsWaiting = 0;
    let partsArrived = () => {};
    let partsReady = Promise.resolve();
    let steering:
      { entered(turnId: string): void; wait: Promise<void>; messages: string[] } | undefined;
    const ids: string[] = [];
    const asked = new Set<string>();
    const cleared = new Set<string>();
    const descriptions: Array<Record<string, any>> = [];
    const confirmationText = 'Proceed with the saved synthetic action?';
    let confirmationValid = true;
    let confirmationReviews = 0;
    let beforeConfirmation = async () => {};
    const executedApps: string[] = [];
    const integrationFixture = createIntegrationFixture(`http://localhost:${port}`);
    const application = await createApplication(
      {
        agent: {
          async open(options) {
            const phase = phases.get(options.turnId) ?? 0;
            phases.set(options.turnId, phase + 1);
            const held = steering;
            steering = undefined;
            return {
              resumed: phase > 0,
              abort() {},
              dispose() {},
              async prompt(text) {
                const tool = (name: string) => options.tools.find((item) => item.name === name)!;
                const part = parts.get(
                  /one part of the owner's request: (\S+)/.exec(text)?.[1] ?? '',
                );
                if (part) {
                  if (--partsWaiting === 0) partsArrived();
                  await partsReady;
                  await tool('apps')
                    .execute(part)
                    .catch(() => {});
                  return;
                }
                const batch =
                  phase === 0
                    ? batches.get(
                        JSON.parse(text.split('Request data (JSON):\n')[1]!.split('\n')[0]!)
                          .currentInstruction,
                      )
                    : undefined;
                if (batch) {
                  await Promise.allSettled(
                    batch.calls.map((call, index) => {
                      if (!batch.subagents) return tool('apps').execute(call);
                      const title = `${options.turnId}-${index}`;
                      parts.set(title, call);
                      return tool('delegate').execute({ title, instruction: 'Run this part.' });
                    }),
                  );
                  return;
                }
                if (held) {
                  held.entered(options.turnId);
                  await held.wait;
                  const messages = (await options.nextMessages?.()) ?? [];
                  held.messages.push(...messages.map((message) => message.text));
                  assert.equal(messages.length, 1);
                  text = messages[0]!.text;
                }
                const plan =
                  phase === 0
                    ? plans.get(
                        JSON.parse(text.split('Request data (JSON):\n')[1]!.split('\n')[0]!)
                          .currentInstruction,
                      )
                    : undefined;
                if (plan) {
                  const result = await options.tools
                    .find((tool) => tool.name === (plan.tool ?? 'manage_personal_context'))!
                    .execute({ action: plan.action, args: plan.args });
                  results.set(options.turnId, result);
                  return;
                }
                options.onEvent({ type: 'final', text: 'Synthetic personal request handled.' });
              },
            };
          },
          dispose() {},
        },
        computer: fakeComputer(),
        workspace: fakeWorkspace(),
        integrations: {
          ...integrationFixture.provider,
          createSession: async (...args) => {
            const session = await integrationFixture.provider.createSession(...args);
            const execute = session.execute.bind(session);
            session.execute = async (...input) => {
              executedApps.push(input[0]);
              return execute(...input);
            };
            return session;
          },
        },
        speech: {
          id: 'fixture',
          configured: false,
          synthesize: async () => ({
            bytes: Buffer.alloc(0),
            mimeType: 'audio/mpeg',
            fileName: 'unused.mp3',
          }),
        },
        keyStore: { id: 'fixture', configured: true, getKey: async () => Buffer.alloc(32, 7) },
        model: { provider: 'fixture', name: 'fixture', configured: true },
        onboardingCurator: {
          id: 'fixture',
          configured: true,
          curate: async ({ task, input }) => {
            if ('purpose' in input && input.purpose === 'confirmation') {
              descriptions.push(input);
              await beforeConfirmation();
              return { text: confirmationText };
            }
            if ('purpose' in input && input.purpose === 'confirmation_review') {
              confirmationReviews++;
              return { valid: confirmationValid };
            }
            return task === 'review' && 'reply' in input
              ? {
                  answer: ({ Yes: 'yes', No: 'no' } as Record<string, string>)[String(input.reply)],
                }
              : task === 'review'
                ? {
                    run:
                      asked.has(
                        (input as { userMessages?: Array<{ text: string }> }).userMessages?.at(-1)
                          ?.text ?? '',
                      ) ||
                      cleared.has(
                        String(
                          (input as { action?: { arguments?: { recipient_email?: unknown } } })
                            .action?.arguments?.recipient_email,
                        ),
                      ),
                  }
                : undefined;
          },
        },
      },
      { channels: false },
    );
    integrationFixture.register(application.app);
    const headers = {
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
      cookie: `${accessCookie(port)}=${await accessKey(dataRoot)}`,
    };
    const request = (
      method: 'GET' | 'POST' | 'PATCH',
      path: string,
      payload?: Record<string, unknown>,
    ) => application.app.inject({ method, url: path, headers, payload });
    async function waitFor(id: string, status: string) {
      for (let attempt = 0; attempt < 300; attempt++) {
        const turn = (await pool.query('SELECT status,error FROM turns WHERE id=$1', [id])).rows[0];
        if (status.split('|').includes(turn.status)) return;
        assert.notEqual(turn.status, 'failed', turn.error);
        await delay(20);
      }
      assert.fail(`Synthetic turn did not become ${status}.`);
    }
    async function propose(
      action: string,
      args: Record<string, unknown>,
      tool?: string,
      text = `Synthetic proposal ${randomUUID()}`,
    ) {
      plans.set(text, { tool, action, args });
      const response = await request('POST', '/api/messages', { text });
      assert.equal(response.statusCode, 200);
      const id = response.json().turnId as string;
      ids.push(response.json().threadId as string);
      await waitFor(id, tool ? 'waiting|succeeded' : 'waiting');
      return id;
    }
    const approvalsFor = async (id: string) =>
      (await pool.query('SELECT * FROM approvals WHERE turn_id=$1', [id])).rows;
    async function reminder() {
      const response = await request('POST', '/api/schedules', {
        title: 'Synthetic cancellation reminder',
        prompt: 'Review the synthetic checklist.',
        kind: 'once',
        runAt: '2099-01-01T09:00:00Z',
        timeZone: 'UTC',
      });
      assert.equal(response.statusCode, 200, response.body);
      const id = response.json().id as string;
      const { job_id: jobId } = (
        await pool.query('SELECT job_id FROM schedules WHERE id=$1 AND owner_id=$2', [id, ownerId])
      ).rows[0];
      assert.ok(jobId);
      return { id, jobId: jobId as string };
    }
    async function assertCancelled(schedule: { id: string; jobId: string }, messageId: string) {
      assert.deepEqual(
        (
          await pool.query(
            'SELECT enabled,job_id,next_run_at FROM schedules WHERE id=$1 AND owner_id=$2',
            [schedule.id, ownerId],
          )
        ).rows[0],
        { enabled: false, job_id: null, next_run_at: null },
      );
      assert.equal(
        (await pool.query(`SELECT state FROM ${bossSchema}.job WHERE id=$1`, [schedule.jobId]))
          .rows[0].state,
        'cancelled',
      );
      assert.deepEqual(
        (
          await pool.query(
            "SELECT status,source_message_id,confirmation_message_id FROM approvals WHERE owner_id=$1 AND action='OTTO_schedule_cancel' AND args=$2::jsonb AND status<>'expired'",
            [ownerId, { id: schedule.id }],
          )
        ).rows,
        [{ status: 'completed', source_message_id: messageId, confirmation_message_id: null }],
      );
    }
    async function pendingPlan(action: string, args: Record<string, unknown>) {
      const id = await propose('notification_preferences_update', {
        notificationRule: 'Synthetic pending plan fixture',
      });
      const [pending] = await approvalsFor(id);
      await pool.query('UPDATE approvals SET action=$2,args=$3 WHERE id=$1', [
        pending.id,
        `OTTO_${action}`,
        args,
      ]);
      await pool.query('UPDATE messages SET text=$2 WHERE id=$1', [
        pending.confirmation_message_id,
        'Apply the saved plan change? Reply Yes or No.',
      ]);
      return id;
    }
    try {
      await t.test(
        'a compromised agent cannot send outside the account until the owner confirms',
        async () => {
          const connect = await request('POST', '/api/apps/gmail/connect', {});
          assert.equal(connect.statusCode, 200, connect.body);
          const accountId = new URL(connect.json().url).pathname.split('/').pop();
          const consent = await application.app.inject({
            method: 'POST',
            url: `/e2e/connect/${accountId}`,
            headers,
          });
          const callback = new URL(String(consent.headers.location));
          await application.app.inject({ url: `${callback.pathname}${callback.search}`, headers });
          const email = (to: string) => ({
            recipient_email: to,
            subject: 'Synthetic invoices',
            body: 'Synthetic forwarded content.',
          });
          const sends = () =>
            integrationFixture.writes.filter((write) => write.action === 'GMAIL_SEND_EMAIL').length;
          const held = await propose('GMAIL_SEND_EMAIL', email('collector@example.test'), 'apps');
          const cards = await approvalsFor(held);
          assert.equal(cards.length, 1, 'the send to a stranger was not held for confirmation');
          const [card] = cards;
          assert.equal(card.status, 'pending');
          assert.equal(card.args.recipient_email, 'collector@example.test');
          assert.equal(sends(), 0);
          const declined = await request('POST', '/api/messages', {
            text: 'No',
            replyToMessageId: card.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          assert.equal(declined.statusCode, 200, declined.body);
          await waitFor(declined.json().turnId, 'succeeded');
          assert.equal((await approvalsFor(held))[0].status, 'declined');
          assert.equal(sends(), 0);
        },
      );

      await t.test(
        'a rejected generated confirmation cannot create an approval or send an email',
        async () => {
          const before = confirmationReviews;
          const writes = integrationFixture.writes.length;
          const text = `Synthetic rejected confirmation ${randomUUID()}`;
          plans.set(text, {
            tool: 'apps',
            action: 'GMAIL_SEND_EMAIL',
            args: {
              recipient_email: 'blocked@example.test',
              subject: 'Synthetic reviewed email',
              body: 'Synthetic body awaiting confirmation.',
            },
          });
          confirmationValid = false;
          try {
            const response = await request('POST', '/api/messages', { text });
            assert.equal(response.statusCode, 200, response.body);
            const turn = response.json().turnId as string;
            ids.push(response.json().threadId as string);
            await waitFor(turn, 'failed|succeeded|waiting');
            assert.equal(confirmationReviews, before + 1);
            assert.deepEqual(await approvalsFor(turn), []);
            assert.equal(
              (
                await pool.query(
                  "SELECT id FROM messages WHERE turn_id=$1 AND role='assistant' AND text=$2",
                  [turn, confirmationText],
                )
              ).rowCount,
              0,
            );
            assert.equal(integrationFixture.writes.length, writes);
          } finally {
            confirmationValid = true;
          }
        },
      );

      await t.test(
        'a schedule changed during confirmation generation cannot save a stale approval',
        async () => {
          const schedule = await reminder();
          const text = `Synthetic stale schedule confirmation ${randomUUID()}`;
          plans.set(text, { action: 'schedule_cancel', args: { id: schedule.id } });
          beforeConfirmation = async () => {
            const changed = await request('PATCH', `/api/schedules/${schedule.id}`, {
              title: 'A different synthetic reminder',
              prompt: 'Review a different synthetic checklist.',
            });
            assert.equal(changed.statusCode, 200, changed.body);
          };
          try {
            const response = await request('POST', '/api/messages', { text });
            assert.equal(response.statusCode, 200, response.body);
            const turn = response.json().turnId as string;
            await waitFor(turn, 'failed|succeeded|waiting');
            assert.deepEqual(await approvalsFor(turn), []);
            assert.equal(
              (
                await pool.query(
                  "SELECT id FROM messages WHERE turn_id=$1 AND role='assistant' AND text=$2",
                  [turn, confirmationText],
                )
              ).rowCount,
              0,
            );
            const current = (
              await pool.query('SELECT title,enabled FROM schedules WHERE id=$1', [schedule.id])
            ).rows[0];
            assert.equal(current.title, 'A different synthetic reminder');
            assert.equal(current.enabled, true);
          } finally {
            beforeConfirmation = async () => {};
          }
        },
      );

      await t.test("spending limits change only from the owner's words or their yes", async () => {
        const limits = async () => {
          const view = (await request('GET', '/api/trust')).json();
          return { limit: view.limit, taskUsd: view.taskUsd };
        };
        const unasked = await propose('limits_update', { monthlyUsd: 500, taskUsd: null });
        const [approval] = await approvalsFor(unasked);
        assert.equal(approval.status, 'pending');
        assert.deepEqual(await limits(), { limit: null, taskUsd: 5 });
        const confirmed = await request('POST', '/api/messages', {
          text: 'Yes',
          replyToMessageId: approval.confirmation_message_id,
          clientMessageId: randomUUID(),
        });
        assert.equal(confirmed.statusCode, 200, confirmed.body);
        await waitFor(confirmed.json().turnId, 'succeeded');
        assert.equal((await approvalsFor(unasked))[0].status, 'completed');
        assert.deepEqual(await limits(), {
          limit: { monthlyUsd: 500, reached: false },
          taskUsd: null,
        });
        const text = 'From now on, check in when a task passes $20 and drop my monthly limit.';
        asked.add(text);
        plans.set(text, { action: 'limits_update', args: { monthlyUsd: null, taskUsd: 20 } });
        const response = await request('POST', '/api/messages', { text });
        assert.equal(response.statusCode, 200, response.body);
        await waitFor(response.json().turnId, 'succeeded');
        assert.deepEqual(
          (await approvalsFor(response.json().turnId)).map((row) => [
            row.status,
            row.confirmation_message_id,
          ]),
          [['completed', null]],
        );
        assert.deepEqual(await limits(), { limit: null, taskUsd: 20 });
      });

      await t.test(
        'schedule confirmations cannot mutate a revision edited after the question was saved',
        async () => {
          for (const action of ['schedule_cancel', 'schedule_update']) {
            const schedule = await reminder();
            const args = {
              id: schedule.id,
              ...(action === 'schedule_update' ? { title: 'The proposed synthetic title' } : {}),
            };
            const turn = await propose(action, args);
            const [approval] = await approvalsFor(turn);
            assert.equal(approval.expected_revision, 0);
            const changed = await request('PATCH', `/api/schedules/${schedule.id}`, {
              title: 'A newer synthetic reminder',
              prompt: 'Review the newer synthetic checklist.',
            });
            assert.equal(changed.statusCode, 200, changed.body);
            const saved = (
              await pool.query('SELECT * FROM schedules WHERE id=$1 AND owner_id=$2', [
                schedule.id,
                ownerId,
              ])
            ).rows[0];
            const job = (
              await pool.query(`SELECT * FROM ${bossSchema}.job WHERE id=$1`, [saved.job_id])
            ).rows[0];
            const response = await request('POST', '/api/messages', {
              text: 'Yes',
              replyToMessageId: approval.confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            assert.equal(response.statusCode, 409, response.body);
            assert.equal((await approvalsFor(turn))[0].status, 'pending');
            assert.deepEqual(
              (await pool.query('SELECT * FROM schedules WHERE id=$1', [schedule.id])).rows[0],
              saved,
            );
            assert.deepEqual(
              (await pool.query(`SELECT * FROM ${bossSchema}.job WHERE id=$1`, [saved.job_id]))
                .rows[0],
              job,
            );
            assert.deepEqual(approval.args, args);
            assert.deepEqual(descriptions.at(-1)?.data.args, args);
            const fresh = await propose(action, args);
            const [reviewed] = await approvalsFor(fresh);
            assert.equal(reviewed.expected_revision, saved.revision);
            const confirmed = await request('POST', '/api/messages', {
              text: 'Yes',
              replyToMessageId: reviewed.confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            assert.equal(confirmed.statusCode, 200, confirmed.body);
            await waitFor(confirmed.json().turnId, 'succeeded');
            assert.equal((await approvalsFor(fresh))[0].status, 'completed');
            const applied = (
              await pool.query('SELECT revision,title,enabled FROM schedules WHERE id=$1', [
                schedule.id,
              ])
            ).rows[0];
            assert.equal(applied.revision, saved.revision + 1);
            assert.equal(applied.enabled, action !== 'schedule_cancel');
            assert.equal(applied.title, args.title ?? saved.title);
          }
        },
      );

      await t.test(
        'legacy schedule approvals without a saved revision cannot execute',
        async () => {
          const schedule = await reminder();
          const turn = await propose('schedule_cancel', { id: schedule.id });
          const [approval] = await approvalsFor(turn);
          await pool.query('UPDATE approvals SET expected_revision=NULL WHERE id=$1', [
            approval.id,
          ]);
          const response = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: approval.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          assert.equal(response.statusCode, 409, response.body);
          assert.equal((await approvalsFor(turn))[0].status, 'pending');
          assert.deepEqual(
            (
              await pool.query('SELECT revision,enabled,job_id FROM schedules WHERE id=$1', [
                schedule.id,
              ])
            ).rows[0],
            { revision: 0, enabled: true, job_id: schedule.jobId },
          );
        },
      );

      await t.test(
        'schedule execution rechecks the saved revision after waiting for its row lock',
        async () => {
          const schedule = await reminder();
          const turn = await propose('schedule_cancel', { id: schedule.id });
          const [approval] = await approvalsFor(turn);
          const job = (
            await pool.query(`SELECT * FROM ${bossSchema}.job WHERE id=$1`, [schedule.jobId])
          ).rows[0];
          const editor = await pool.connect();
          let execution: string | undefined;
          try {
            await editor.query('BEGIN');
            await editor.query('SELECT id FROM schedules WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
              schedule.id,
              ownerId,
            ]);
            const response = await request('POST', '/api/messages', {
              text: 'Yes',
              replyToMessageId: approval.confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            assert.equal(response.statusCode, 200, response.body);
            execution = response.json().turnId as string;
            for (let attempt = 0; attempt < 300; attempt++) {
              if ((await approvalsFor(turn))[0].status === 'executing') break;
              await delay(20);
            }
            assert.equal((await approvalsFor(turn))[0].status, 'executing');
            await editor.query(
              'UPDATE schedules SET title=$3,revision=revision+1 WHERE id=$1 AND owner_id=$2',
              [schedule.id, ownerId, 'Concurrently edited synthetic reminder'],
            );
            await editor.query('COMMIT');
            await waitFor(execution, 'failed');
            assert.equal((await approvalsFor(turn))[0].status, 'uncertain');
            assert.deepEqual(
              (
                await pool.query('SELECT title,enabled,job_id FROM schedules WHERE id=$1', [
                  schedule.id,
                ])
              ).rows[0],
              {
                title: 'Concurrently edited synthetic reminder',
                enabled: true,
                job_id: schedule.jobId,
              },
            );
            assert.deepEqual(
              (await pool.query(`SELECT * FROM ${bossSchema}.job WHERE id=$1`, [schedule.jobId]))
                .rows[0],
              job,
            );
          } finally {
            await editor.query('ROLLBACK');
            editor.release();
            if (execution) await waitFor(execution, 'failed|succeeded');
          }
        },
      );

      await t.test(
        'an explicit confirmation request can hold a read until the bound approval is accepted',
        async () => {
          const before = executedApps.filter((action) => action === 'GMAIL_FETCH_EMAILS').length;
          const turn = await propose(
            'GMAIL_FETCH_EMAILS',
            { query: 'in:inbox' },
            'apps',
            'Ask before reading my synthetic inbox.',
          );
          const [pending] = await approvalsFor(turn);
          assert.equal(pending.status, 'pending');
          assert.equal(pending.action, 'GMAIL_FETCH_EMAILS');
          assert.equal(
            executedApps.filter((action) => action === 'GMAIL_FETCH_EMAILS').length,
            before,
          );
          const response = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: pending.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          assert.equal(response.statusCode, 200, response.body);
          await waitFor(response.json().turnId, 'succeeded');
          assert.equal((await approvalsFor(turn))[0].status, 'completed');
          assert.equal(
            executedApps.filter((action) => action === 'GMAIL_FETCH_EMAILS').length,
            before + 1,
          );
        },
      );

      await t.test('tool discovery runs without waiting for the checker', async () => {
        const turn = await propose('SEARCH_TOOLS', { query: 'gmail email' }, 'apps');
        const result = results.get(turn);
        assert.ok(result);
        const text = result.content.map((part) => ('text' in part ? part.text : '')).join('');
        assert.match(text, /GMAIL_FETCH_EMAILS/);
        assert.equal((await approvalsFor(turn)).length, 0);
      });

      await t.test(
        'parallel app calls in one turn open one confirmation, in a batch or across subagents',
        async () => {
          const sends = () =>
            integrationFixture.writes.filter((write) => write.action === 'GMAIL_SEND_EMAIL').length;
          for (const subagents of [false, true]) {
            partsWaiting = 2;
            partsReady = new Promise<void>((resolve) => {
              partsArrived = resolve;
            });
            const text = `Synthetic parallel sends ${randomUUID()}`;
            batches.set(text, {
              subagents,
              calls: ['first', 'second'].map((name) => ({
                action: 'GMAIL_SEND_EMAIL',
                args: {
                  recipient_email: `${name}@example.test`,
                  subject: 'Synthetic invoices',
                  body: 'Synthetic content.',
                },
              })),
            });
            const response = await request('POST', '/api/messages', { text });
            assert.equal(response.statusCode, 200, response.body);
            const turn = response.json().turnId as string;
            if (subagents) {
              const reached = await Promise.race([
                partsReady.then(() => true),
                delay(5000, false, { ref: false }),
              ]);
              partsArrived();
              assert.ok(reached, 'Both synthetic subagents must start before either uses an app.');
            }
            await waitFor(turn, 'waiting');
            const cards = await approvalsFor(turn);
            assert.deepEqual(
              cards.map((card) => card.status),
              ['pending'],
            );
            assert.equal(
              (
                await pool.query("SELECT id FROM messages WHERE turn_id=$1 AND role='assistant'", [
                  turn,
                ])
              ).rowCount,
              1,
            );
            assert.equal(sends(), 0);
            const declined = await request('POST', '/api/messages', {
              text: 'No',
              replyToMessageId: cards[0].confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            assert.equal(declined.statusCode, 200, declined.body);
            await waitFor(declined.json().turnId, 'succeeded');
          }
        },
      );

      await t.test('an allowed send issued after one that asks never runs', async () => {
        cleared.add('allowed@example.test');
        const text = `Synthetic ordered sends ${randomUUID()}`;
        batches.set(text, {
          subagents: false,
          calls: ['asked', 'allowed'].map((name) => ({
            action: 'GMAIL_SEND_EMAIL',
            args: {
              recipient_email: `${name}@example.test`,
              subject: 'Synthetic invoices',
              body: 'Synthetic content.',
            },
          })),
        });
        const response = await request('POST', '/api/messages', { text });
        assert.equal(response.statusCode, 200, response.body);
        const turn = response.json().turnId as string;
        await waitFor(turn, 'waiting');
        const cards = await approvalsFor(turn);
        assert.deepEqual(
          cards.map((card) => [card.status, card.args.recipient_email]),
          [['pending', 'asked@example.test']],
        );
        assert.equal(
          integrationFixture.writes.filter((write) => write.action === 'GMAIL_SEND_EMAIL').length,
          0,
        );
        const declined = await request('POST', '/api/messages', {
          text: 'No',
          replyToMessageId: cards[0].confirmation_message_id,
          clientMessageId: randomUUID(),
        });
        assert.equal(declined.statusCode, 200, declined.body);
        await waitFor(declined.json().turnId, 'succeeded');
        cleared.clear();
      });

      await t.test(
        'a schedule cancellation steered into a confirmed turn uses the fresh owner request',
        async () => {
          const schedule = await reminder();
          const proposed = await propose('notification_preferences_update', {
            notificationRule: 'Synthetic confirmed preference',
          });
          const [approval] = await approvalsFor(proposed);
          let enter!: (turnId: string) => void;
          const entered = new Promise<string>((resolve) => {
            enter = resolve;
          });
          let release!: () => void;
          const wait = new Promise<void>((resolve) => {
            release = resolve;
          });
          const messages: string[] = [];
          steering = { entered: enter, wait, messages };
          try {
            const confirmed = await request('POST', '/api/messages', {
              text: 'Yes',
              replyToMessageId: approval.confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            assert.equal(confirmed.statusCode, 200, confirmed.body);
            const resumed = confirmed.json().turnId as string;
            assert.equal(
              await Promise.race([
                entered,
                delay(6000, undefined, { ref: false }).then(() => {
                  throw new Error('Synthetic confirmed turn did not start.');
                }),
              ]),
              resumed,
            );
            assert.deepEqual(
              (
                await pool.query('SELECT source,status,background FROM turns WHERE id=$1', [
                  resumed,
                ])
              ).rows[0],
              { source: 'resume', status: 'running', background: false },
            );
            assert.equal((await approvalsFor(proposed))[0].status, 'completed');
            const text = 'Cancel the synthetic reminder now.';
            asked.add(text);
            plans.set(text, { action: 'schedule_cancel', args: { id: schedule.id } });
            const cancellation = await request('POST', '/api/messages', {
              text,
              clientMessageId: randomUUID(),
            });
            assert.equal(cancellation.statusCode, 200, cancellation.body);
            release();
            await waitFor(resumed, 'succeeded');
            assert.equal(messages.length, 1);
            assert.equal(
              (
                await pool.query('SELECT turn_id FROM messages WHERE id=$1', [
                  cancellation.json().messageId,
                ])
              ).rows[0].turn_id,
              resumed,
            );
            await assertCancelled(schedule, cancellation.json().messageId);
          } finally {
            steering = undefined;
            release();
          }
        },
      );

      await t.test(
        'a fresh owner cancellation supersedes a background pause proposal without another approval',
        async () => {
          const schedule = await reminder();
          const trigger = 'Inspect the synthetic reminder.';
          plans.set(trigger, { action: 'schedule_cancel', args: { id: schedule.id } });
          const background = await enqueueTurn(trigger, { source: 'event' });
          await waitFor(background, 'waiting');
          const [approval] = await approvalsFor(background);
          assert.equal(approval.status, 'pending');
          const text = 'Cancel that synthetic reminder.';
          asked.add(text);
          plans.set(text, { action: 'schedule_cancel', args: { id: schedule.id } });
          const cancellation = await request('POST', '/api/messages', {
            text,
            clientMessageId: randomUUID(),
          });
          assert.equal(cancellation.statusCode, 200, cancellation.body);
          await waitFor(cancellation.json().turnId, 'succeeded');
          assert.equal((await approvalsFor(background))[0].status, 'expired');
          await assertCancelled(schedule, cancellation.json().messageId);
        },
      );

      await t.test(
        'already paused schedule cancellation returns its saved state without another approval',
        async () => {
          const created = await request('POST', '/api/schedules', {
            title: 'Synthetic paused recurring reminder',
            prompt: 'Review the synthetic weekly checklist.',
            kind: 'recurring',
            cron: '0 9 1 1 *',
            timeZone: 'UTC',
          });
          assert.equal(created.statusCode, 200, created.body);
          const scheduleId = created.json().id as string;
          const jobId = (
            await pool.query('SELECT job_id FROM schedules WHERE id=$1 AND owner_id=$2', [
              scheduleId,
              ownerId,
            ])
          ).rows[0].job_id;
          const paused = await request('PATCH', `/api/schedules/${scheduleId}`, { enabled: false });
          assert.equal(paused.statusCode, 200, paused.body);
          const saved = (
            await pool.query('SELECT * FROM schedules WHERE id=$1 AND owner_id=$2', [
              scheduleId,
              ownerId,
            ])
          ).rows[0];
          assert.equal(saved.enabled, false);
          assert.equal(saved.job_id, null);
          assert.equal(saved.next_run_at, null);
          const job = (await pool.query(`SELECT * FROM ${bossSchema}.job WHERE id=$1`, [jobId]))
            .rows[0];
          assert.equal(job.state, 'cancelled');
          const trigger = 'Inspect a synthetic reminder that is already paused.';
          plans.set(trigger, { action: 'schedule_cancel', args: { id: scheduleId } });
          const background = await enqueueTurn(trigger, { source: 'event' });
          await waitFor(background, 'succeeded');
          assert.deepEqual(await approvalsFor(background), []);
          assert.equal(
            (await pool.query('SELECT id FROM messages WHERE turn_id=$1', [background])).rowCount,
            0,
          );
          assert.deepEqual(
            (
              await pool.query('SELECT * FROM schedules WHERE id=$1 AND owner_id=$2', [
                scheduleId,
                ownerId,
              ])
            ).rows[0],
            saved,
          );
          assert.deepEqual(
            (await pool.query(`SELECT * FROM ${bossSchema}.job WHERE id=$1`, [jobId])).rows[0],
            job,
          );
          const output = results.get(background)?.content[0];
          assert.ok(output?.type === 'text');
          assert.deepEqual(JSON.parse(output.text), paused.json());
        },
      );

      await t.test(
        'deleted targets and obsolete invalid payloads stay pending without an uncertain execution',
        async () => {
          const schedule = { id: randomUUID() };
          await pool.query(
            "INSERT INTO schedules(id,owner_id,title,prompt,cron,time_zone) VALUES($1,$2,'Review Northstar','Synthetic review','0 9 * * 1','UTC')",
            [schedule.id, ownerId],
          );
          const id = await propose('schedule_cancel', { id: schedule.id });
          assert.equal(descriptions.at(-1)?.data.details.schedule.title, 'Review Northstar');
          assert.equal(descriptions.at(-1)?.data.details.schedule.prompt, 'Synthetic review');
          const [approval] = await approvalsFor(id);
          await pool.query('DELETE FROM schedules WHERE id=$1 AND owner_id=$2', [
            schedule.id,
            ownerId,
          ]);
          assert.equal(
            (
              await request('POST', '/api/messages', {
                text: 'Yes',
                replyToMessageId: approval.confirmation_message_id,
                clientMessageId: randomUUID(),
              })
            ).statusCode,
            404,
          );
          assert.equal((await approvalsFor(id))[0].status, 'pending');
          const legacyId = await pendingPlan('notification_preferences_update', {
            notificationRule: 'Valid at proposal',
          });
          const [legacy] = await approvalsFor(legacyId);
          await pool.query('UPDATE approvals SET args=$2 WHERE id=$1', [
            legacy.id,
            { notificationRule: 'Invalid historical payload', unexpected: true },
          ]);
          assert.equal(
            (
              await request('POST', '/api/messages', {
                text: 'Yes',
                replyToMessageId: legacy.confirmation_message_id,
                clientMessageId: randomUUID(),
              })
            ).statusCode,
            400,
          );
          assert.equal((await approvalsFor(legacyId))[0].status, 'pending');
          assert.notEqual(
            ((await application.personal.manage('notification_preferences_get', {})) as Preferences)
              .notificationRule,
            'Invalid historical payload',
          );
        },
      );
    } finally {
      await application.app.close();
      await pool.end();
      for (const id of ids)
        await rm(join(dataRoot, 'workspaces', id), { recursive: true, force: true });
    }
  },
);
