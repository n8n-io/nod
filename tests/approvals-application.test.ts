import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import { createIntegrationFixture } from '../scripts/e2e-fixtures.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

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
    const { createApplication } = await import('../src/server/composition.ts');
    const { pool } = await import('../src/server/db.ts');
    const { dataRoot, ownerId, port } = await import('../src/server/config.ts');
    const phases = new Map<string, number>();
    const plans = new Map<
      string,
      { tool?: string; action: string; args: Record<string, unknown> }
    >();
    const ids: string[] = [];
    const integrationFixture = createIntegrationFixture(`http://localhost:${port}`);
    const application = await createApplication(
      {
        agent: {
          async open(options) {
            const phase = phases.get(options.turnId) ?? 0;
            phases.set(options.turnId, phase + 1);
            return {
              resumed: phase > 0,
              abort() {},
              dispose() {},
              async prompt(text) {
                const plan =
                  phase === 0
                    ? plans.get(
                        JSON.parse(text.split('Request data (JSON):\n')[1]!.split('\n')[0]!)
                          .currentInstruction,
                      )
                    : undefined;
                if (plan) {
                  await options.tools
                    .find((tool) => tool.name === (plan.tool ?? 'manage_personal_context'))!
                    .execute({ action: plan.action, args: plan.args });
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
        relevance: { id: 'fixture', configured: false, classify: async () => 'ignore' },
        model: { provider: 'fixture', name: 'fixture', configured: true },
      },
      { channels: false },
    );
    integrationFixture.register(application.app);
    const headers = { host: `localhost:${port}`, origin: `http://localhost:${port}` };
    const request = (method: 'GET' | 'POST', path: string, payload?: Record<string, unknown>) =>
      application.app.inject({ method, url: path, headers, payload });
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
          const direct = await propose(
            'GMAIL_SEND_EMAIL',
            email('ana.owner-named@example.test'),
            'apps',
            'Email ana.owner-named@example.test the synthetic invoices.',
          );
          assert.equal((await approvalsFor(direct)).length, 0);
          assert.equal(sends(), 1);
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
