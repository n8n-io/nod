import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { AgentToolResult } from '../src/ports/agent.ts';
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
    let steering:
      { entered(turnId: string): void; wait: Promise<void>; messages: string[] } | undefined;
    const ids: string[] = [];
    const asked = new Set<string>();
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
                if (held) {
                  held.entered(options.turnId);
                  await held.wait;
                  const messages = (await options.nextMessages?.()) ?? [];
                  held.messages.push(...messages);
                  assert.equal(messages.length, 1);
                  text = messages[0]!;
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
        integrations: integrationFixture.provider,
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
          curate: async ({ task, input }) =>
            task === 'review' && 'reply' in input
              ? {
                  answer: ({ Yes: 'yes', No: 'no' } as Record<string, string>)[String(input.reply)],
                }
              : task === 'review'
                ? {
                    run: asked.has(
                      (input as { userMessages?: Array<{ text: string }> }).userMessages?.at(-1)
                        ?.text ?? '',
                    ),
                  }
                : undefined,
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
      const id = await propose('profile_update', { preferences: 'Synthetic pending plan fixture' });
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

      await t.test('tool discovery runs without waiting for the checker', async () => {
        const turn = await propose('SEARCH_TOOLS', { query: 'gmail email' }, 'apps');
        const result = results.get(turn);
        assert.ok(result);
        const text = result.content.map((part) => ('text' in part ? part.text : '')).join('');
        assert.match(text, /GMAIL_FETCH_EMAILS/);
        assert.equal((await approvalsFor(turn)).length, 0);
      });

      await t.test(
        'a schedule cancellation steered into a confirmed turn uses the fresh owner request',
        async () => {
          const schedule = await reminder();
          const proposed = await propose('profile_update', {
            preferences: 'Synthetic confirmed preference',
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
          const id = await pendingPlan('schedule_cancel', { id: schedule.id });
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
          const legacyId = await pendingPlan('profile_update', {
            preferences: 'Valid at proposal',
          });
          const [legacy] = await approvalsFor(legacyId);
          await pool.query('UPDATE approvals SET args=$2 WHERE id=$1', [
            legacy.id,
            { preferences: 'Invalid historical payload', unexpected: true },
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
            (await application.personal.getProfile()).preferences,
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
