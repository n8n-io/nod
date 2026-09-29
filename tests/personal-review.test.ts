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
  'personal proposals validate before review, preserve supported goal fields and revalidate before execution',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_personal_review_${suffix}`;
    const bossSchema = `test_personal_review_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
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
      { action: string; args: Record<string, unknown>; invalid?: boolean }
    >();
    const ids: string[] = [];
    const integrationProvider = createIntegrationFixture('http://localhost:4320').provider;
    const application = await createApplication(
      {
        agent: {
          async open(options) {
            const phase = phases.get(options.taskId) ?? 0;
            phases.set(options.taskId, phase + 1);
            return {
              resumed: phase > 0,
              abort() {},
              dispose() {},
              async prompt(text) {
                if (phase === 0) {
                  const input = JSON.parse(text.split('Request data (JSON):\n')[1]!);
                  const plan = plans.get(input.currentInstruction)!;
                  assert.ok(plan);
                  const execute = () =>
                    options.tools
                      .find(
                        (tool) =>
                          tool.name ===
                          (plan.action.startsWith('GMAIL_') ? 'apps' : 'manage_personal_context'),
                      )!
                      .execute({ action: plan.action, args: plan.args });
                  if (plan.invalid) await assert.rejects(execute, /could not be completed/);
                  else {
                    await execute();
                    return;
                  }
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
          transcribe: async () => '',
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
        const task = (await pool.query('SELECT status,error FROM tasks WHERE id=$1', [id])).rows[0];
        if (task.status === status) return;
        assert.notEqual(task.status, 'failed', task.error);
        await delay(20);
      }
      assert.fail(`Synthetic task did not become ${status}.`);
    }
    async function propose(
      action: string,
      args: Record<string, unknown>,
      invalid = false,
      directText?: string,
    ) {
      const text = directText ?? `Synthetic proposal ${randomUUID()}`;
      plans.set(text, { action, args, invalid });
      const response = await request('POST', '/api/messages', { text });
      assert.equal(response.statusCode, 200);
      const id = response.json().taskId as string;
      ids.push(id);
      await waitFor(
        id,
        invalid || directText || /^(goal|schedule)_/.test(action) ? 'succeeded' : 'waiting_user',
      );
      return id;
    }
    const approvalsFor = async (id: string) =>
      (await pool.query('SELECT * FROM approvals WHERE task_id=$1', [id])).rows;
    async function pendingPlan(action: string, args: Record<string, unknown>) {
      const id = await propose('memory_propose', { text: 'Synthetic pending plan fixture' });
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
        'a direct goal creation retains normalized fields without confirmation',
        async () => {
          const id = await propose(
            'goal_create',
            {
              title: 'Review Northstar',
              description: 'Synthetic review goal',
              status: 'active',
              nextAction: 'Choose the invoices to review',
              targetDate: '2026-10-25',
            },
            false,
            'I would like a goal for reviewing Northstar and choosing its invoices.',
          );
          const [approval] = await approvalsFor(id);
          assert.equal(approval.args.progress, 0);
          assert.equal(approval.args.nextAction, 'Choose the invoices to review');
          assert.equal(approval.status, 'completed');
          assert.equal(approval.confirmation_message_id, null);
          const goals = await application.personal.listGoals();
          assert.equal(goals.length, 1);
          assert.equal(goals[0].status, 'active');
          assert.equal(goals[0].nextAction, 'Choose the invoices to review');
          assert.equal(goals[0].targetDate, '2026-10-25');
        },
      );
      await t.test(
        'invalid fields, timings, targets and empty changes never create a review',
        async () => {
          const foreignId = randomUUID();
          await pool.query(
            "INSERT INTO goals(id,owner_id,title,description) VALUES($1,'foreign','Foreign','Foreign')",
            [foreignId],
          );
          const cases: Array<[string, Record<string, unknown>]> = [
            ['goal_create', { title: 'Goal', unexpected: true }],
            ['goal_create', { title: 'Goal', progress: 101 }],
            ['goal_create', { title: 'Goal', status: 'invented' }],
            ['goal_update', { id: (await application.personal.listGoals())[0].id }],
            ['goal_update', { id: foreignId, nextAction: 'No access' }],
            ['profile_update', { unexpected: true }],
            ['profile_update', {}],
            ['notification_preferences_update', { timeZone: 'Unknown/Fixture' }],
            ['memory_propose', { text: '' }],
            [
              'schedule_create',
              {
                title: 'Once',
                prompt: 'Review',
                kind: 'once',
                runAt: '2020-01-01T12:00:00Z',
                timeZone: 'Europe/Lisbon',
              },
            ],
            [
              'schedule_create',
              { title: 'Recurring', prompt: 'Review', cron: 'invalid', timeZone: 'Europe/Lisbon' },
            ],
            ['schedule_update', { id: randomUUID(), enabled: false }],
            ['schedule_cancel', { id: randomUUID(), unexpected: true }],
          ];
          const taskIds = await Promise.all(
            cases.map(([action, args]) => propose(action, args, true)),
          );
          for (const id of taskIds) assert.equal((await approvalsFor(id)).length, 0);
          assert.equal((await application.personal.listGoals()).length, 1);
          assert.equal((await application.personal.listSchedules()).length, 0);
        },
      );
      await t.test(
        'deleted targets and obsolete invalid payloads stay pending without an uncertain execution',
        async () => {
          const goal = (await application.personal.listGoals())[0];
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
      await t.test(
        'chat confirmations identify only the selected owned provider account',
        async () => {
          const candidates = [
            { id: randomUUID(), owner: ownerId, provider: integrationProvider.id, slug: 'gmail' },
            { id: randomUUID(), owner: ownerId, provider: integrationProvider.id, slug: 'gmail' },
            { id: randomUUID(), owner: 'foreign', provider: integrationProvider.id, slug: 'gmail' },
            { id: randomUUID(), owner: ownerId, provider: 'other-provider', slug: 'gmail' },
            {
              id: randomUUID(),
              owner: ownerId,
              provider: integrationProvider.id,
              slug: 'googledrive',
            },
          ];
          for (const [index, account] of candidates.entries())
            await pool.query(
              `INSERT INTO app_connections(id,owner_id,provider_id,slug,account_id,account_name,account_email,callback_hash)
             VALUES($1,$2,$3,$4,$5,$6,$7,'private-callback-fixture')`,
              [
                account.id,
                account.owner,
                account.provider,
                account.slug,
                `private-provider-account-${index}`,
                `Verified account ${index + 1}`,
                `verified${index + 1}@example.test`,
              ],
            );
          for (const [index, account] of candidates.entries()) {
            const metadata = await application.integrations.describeApproval(
              ownerId,
              'GMAIL_SEND_EMAIL',
              { connectionId: account.id },
            );
            assert.deepEqual(
              metadata,
              index < 2
                ? {
                    name: 'Gmail',
                    accountName: `Verified account ${index + 1}`,
                    accountEmail: `verified${index + 1}@example.test`,
                  }
                : undefined,
            );
            assert.doesNotMatch(
              JSON.stringify(metadata) ?? '',
              /private-provider-account|private-callback/,
            );
          }
          const selected = candidates[1];
          const taskId = await propose('GMAIL_SEND_EMAIL', {
            connectionId: selected.id,
            recipient_email: 'fixture@example.test',
            subject: 'Synthetic review',
          });
          const [approval] = await approvalsFor(taskId);
          const question = (
            await pool.query('SELECT text FROM messages WHERE id=$1', [
              approval.confirmation_message_id,
            ])
          ).rows[0].text;
          assert.match(question, /verified2@example.test/);
          assert.doesNotMatch(
            question,
            /verified1@example.test|private-provider-account|private-callback|connectionId|\/approvals\//,
          );
          await pool.query('UPDATE app_connections SET revoked=true WHERE id=$1', [selected.id]);
          assert.equal(
            await application.integrations.describeApproval(ownerId, 'GMAIL_SEND_EMAIL', {
              connectionId: selected.id,
            }),
            undefined,
          );
          assert.equal(
            (
              await request('POST', '/api/messages', {
                text: 'Yes',
                replyToMessageId: approval.confirmation_message_id,
              })
            ).statusCode,
            404,
          );
          assert.equal((await approvalsFor(taskId))[0].status, 'pending');
          await assert.rejects(
            application.integrations.describeApproval('foreign', 'GMAIL_SEND_EMAIL', {
              connectionId: selected.id,
            }),
          );
        },
      );
      await t.test(
        'an explicit reversible goal request executes directly and retains validation and user provenance',
        async () => {
          const taskId = await propose(
            'goal_create',
            { title: 'Direct fixture', nextAction: 'Review the plan' },
            false,
            'Create a goal titled Direct fixture with next action Review the plan.',
          );
          const [action] = await approvalsFor(taskId);
          assert.equal(action.status, 'completed');
          assert.equal(action.confirmation_message_id, null);
          const source = (
            await pool.query("SELECT id FROM messages WHERE task_id=$1 AND role='user'", [taskId])
          ).rows[0];
          assert.equal(action.source_message_id, source.id);
          const goals = await application.personal.listGoals();
          assert.equal(goals.length, 1);
          assert.equal(goals[0].title, 'Direct fixture');
          assert.equal(goals[0].nextAction, 'Review the plan');
          const invalid = await propose(
            'goal_create',
            { title: 'Invalid direct', progress: 200 },
            true,
            'Create a goal titled Invalid direct.',
          );
          assert.equal((await approvalsFor(invalid)).length, 0);
          assert.equal((await application.personal.listGoals()).length, 1);
        },
      );

      await t.test(
        'goal pause and resume requests preserve saved progress, next step and date',
        async () => {
          const goal = (await application.personal.listGoals())[0];
          await propose(
            'goal_update',
            {
              id: goal.id,
              progress: 25,
              nextAction: 'Prepare the Northstar summary.',
              targetDate: '2026-10-02',
            },
            false,
            `Update the goal "${goal.title}" to 25% with next step Prepare the Northstar summary and target date 2026-10-02.`,
          );
          for (const status of ['paused', 'active']) {
            const current = (await application.personal.listGoals())[0];
            const taskId = await propose(
              'goal_update',
              { id: goal.id, status },
              false,
              `${current.status === 'active' ? 'Pause' : 'Resume'} the goal "${current.title}".`,
            );
            const reloaded = (await request('GET', '/api/goals')).json()[0];
            assert.equal(reloaded.status, status);
            assert.equal(reloaded.progress, 25);
            assert.equal(reloaded.nextAction, 'Prepare the Northstar summary.');
            assert.equal(reloaded.targetDate, '2026-10-02');
            const [saved] = await approvalsFor(taskId);
            assert.equal(saved.status, 'completed');
            assert.equal(saved.confirmation_message_id, null);
            const source = (
              await pool.query('SELECT source_message_id FROM tasks WHERE id=$1', [taskId])
            ).rows[0];
            assert.equal(saved.source_message_id, source.source_message_id);
          }
        },
      );

      await t.test(
        'an explicit goal completion persists without another confirmation',
        async () => {
          const goal = (await application.personal.listGoals())[0];
          const taskId = await propose(
            'goal_update',
            { id: goal.id, status: 'completed', progress: 100 },
            false,
            `Mark the goal "${goal.title}" completed with progress 100% now.`,
          );
          const reloaded = (await request('GET', '/api/goals')).json()[0];
          assert.equal(reloaded.status, 'completed');
          assert.equal(reloaded.progress, 100);
          assert.equal(reloaded.nextAction, goal.nextAction);
          assert.equal(reloaded.targetDate, goal.targetDate);
          const [saved] = await approvalsFor(taskId);
          assert.equal(saved.status, 'completed');
          assert.equal(saved.confirmation_message_id, null);
          const source = (
            await pool.query('SELECT source_message_id FROM tasks WHERE id=$1', [taskId])
          ).rows[0];
          assert.equal(saved.source_message_id, source.source_message_id);
        },
      );

      await t.test(
        'schedule pause, resume and change requests persist direct authorized changes',
        async () => {
          await propose(
            'schedule_create',
            {
              title: 'Weekly Northstar review',
              prompt: 'Review the synthetic invoices.',
              kind: 'recurring',
              cron: '0 9 * * 1',
              timeZone: 'Europe/Lisbon',
            },
            false,
            'Create a schedule titled Weekly Northstar review every Monday at 09:00 in Europe/Lisbon.',
          );
          const schedule = (await application.personal.listSchedules())[0];
          for (const enabled of [false, true]) {
            const current = (await application.personal.listSchedules())[0];
            const taskId = await propose(
              enabled ? 'schedule_update' : 'schedule_cancel',
              enabled ? { id: schedule.id, enabled } : { id: schedule.id },
              false,
              `${current.enabled ? 'Pause' : 'Resume'} the schedule "${current.title}".`,
            );
            const reloaded = (await request('GET', '/api/schedules')).json()[0];
            assert.equal(reloaded.enabled, enabled);
            assert.equal(reloaded.cron, '0 9 * * 1');
            assert.equal(reloaded.timeZone, 'Europe/Lisbon');
            assert.equal(reloaded.prompt, 'Review the synthetic invoices.');
            assert.equal(Boolean(reloaded.nextRun), enabled);
            const [saved] = await approvalsFor(taskId);
            assert.equal(saved.status, 'completed');
            assert.equal(saved.confirmation_message_id, null);
          }
          const current = (await application.personal.listSchedules())[0];
          const taskId = await propose(
            'schedule_update',
            { id: schedule.id, cron: '0 10 * * 1' },
            false,
            `Move the schedule "${current.title}" to 10:00.`,
          );
          const reloaded = (await request('GET', '/api/schedules')).json()[0];
          assert.equal(reloaded.cron, '0 10 * * 1');
          assert.equal(reloaded.timeZone, 'Europe/Lisbon');
          assert.equal(reloaded.enabled, true);
          const [saved] = await approvalsFor(taskId);
          assert.equal(saved.status, 'completed');
          assert.equal(saved.confirmation_message_id, null);
          const source = (
            await pool.query('SELECT source_message_id FROM tasks WHERE id=$1', [taskId])
          ).rows[0];
          assert.equal(saved.source_message_id, source.source_message_id);
        },
      );
    } finally {
      await application.app.close();
      await pool.end();
      for (const id of ids)
        await rm(join(dataRoot, 'workspaces', id), { recursive: true, force: true });
      await admin.query(
        `DROP SCHEMA IF EXISTS ${bossSchema} CASCADE; DROP SCHEMA ${schema} CASCADE`,
      );
      await admin.end();
    }
  },
);
