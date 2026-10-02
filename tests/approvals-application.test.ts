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
    const plans = new Map<string, { action: string; args: Record<string, unknown> }>();
    const ids: string[] = [];
    const integrationProvider = createIntegrationFixture('http://localhost:4320').provider;
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
                if (phase === 0) {
                  const input = JSON.parse(text.split('Request data (JSON):\n')[1]!);
                  const plan = plans.get(input.currentInstruction)!;
                  assert.ok(plan);
                  await options.tools
                    .find((tool) => tool.name === 'manage_personal_context')!
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
        integrations: integrationProvider,
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
    const headers = { host: `localhost:${port}`, origin: `http://localhost:${port}` };
    const request = (method: 'GET' | 'POST', path: string, payload?: Record<string, unknown>) =>
      application.app.inject({ method, url: path, headers, payload });
    async function waitFor(id: string, status: string) {
      for (let attempt = 0; attempt < 300; attempt++) {
        const turn = (await pool.query('SELECT status,error FROM turns WHERE id=$1', [id])).rows[0];
        if (turn.status === status) return;
        assert.notEqual(turn.status, 'failed', turn.error);
        await delay(20);
      }
      assert.fail(`Synthetic turn did not become ${status}.`);
    }
    async function propose(action: string, args: Record<string, unknown>) {
      const text = `Synthetic proposal ${randomUUID()}`;
      plans.set(text, { action, args });
      const response = await request('POST', '/api/messages', { text });
      assert.equal(response.statusCode, 200);
      const id = response.json().turnId as string;
      ids.push(response.json().threadId as string);
      await waitFor(id, 'waiting');
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
        'deleted targets and obsolete invalid payloads stay pending without an uncertain execution',
        async () => {
          const goal = { id: randomUUID() };
          await pool.query(
            "INSERT INTO goals(id,owner_id,title,description) VALUES($1,$2,'Review Northstar','Synthetic review goal')",
            [goal.id, ownerId],
          );
          const id = await pendingPlan('goal_update', { id: goal.id, progress: 20 });
          const [approval] = await approvalsFor(id);
          await pool.query('DELETE FROM goals WHERE id=$1 AND owner_id=$2', [goal.id, ownerId]);
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
          const legacyId = await pendingPlan('goal_create', { title: 'Valid at proposal' });
          const [legacy] = await approvalsFor(legacyId);
          await pool.query('UPDATE approvals SET args=$2 WHERE id=$1', [
            legacy.id,
            { title: 'Invalid historical payload', unexpected: true },
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
          assert.equal((await application.personal.listGoals()).length, 0);
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
