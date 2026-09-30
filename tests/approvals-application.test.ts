import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Composio } from '@composio/core';
import pg from 'pg';
import { createIntegrationFixture } from '../scripts/e2e-fixtures.ts';
import type { AgentToolResult } from '../src/ports/agent.ts';
import { createComposioProvider } from '../src/providers/composio/integrations.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

test(
  'application approvals revalidate targets before execution and name only the selected owned account',
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
      { action: string; args: Record<string, unknown>; invalid?: boolean; complete?: boolean }
    >();
    const results = new Map<string, AgentToolResult>();
    const ids: string[] = [];
    const calendar = { connectionId: randomUUID(), accountId: 'synthetic-calendar-account' };
    const calendarResult = {
      items: [{ id: 'synthetic-calendar-event', summary: 'Northstar review' }],
    };
    const calendarExecutions: Array<{
      action: string;
      args: Record<string, unknown>;
      accountId?: string;
    }> = [];
    const integrationProvider = createIntegrationFixture('http://localhost:4320').provider;
    const client = new Composio({
      apiKey: 'fixture-key-never-live',
      allowTracking: false,
      disableVersionCheck: true,
      fileUploadDirs: false,
    });
    const catalog = t.mock.method(
      client.tools,
      'getRawComposioToolBySlug',
      async (slug: string) => {
        assert.equal(slug, 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS');
        return { slug, name: slug, tags: ['readOnlyHint'] };
      },
    );
    const composio = createComposioProvider({ client });
    const readOnly = integrationProvider.readOnly;
    integrationProvider.readOnly = (action) =>
      action === 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS'
        ? composio.readOnly(action)
        : readOnly(action);
    const createSession = integrationProvider.createSession;
    integrationProvider.createSession = async (...args) => {
      const session = await createSession(...args);
      return {
        ...session,
        async execute(action, args, accountId) {
          if (action !== 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS')
            return session.execute(action, args, accountId);
          calendarExecutions.push({ action, args, accountId });
          return calendarResult;
        },
      };
    };
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
                  const execute = () =>
                    options.tools
                      .find(
                        (tool) =>
                          tool.name ===
                          (plan.action === plan.action.toUpperCase()
                            ? 'apps'
                            : 'manage_personal_context'),
                      )!
                      .execute({ action: plan.action, args: plan.args });
                  if (plan.invalid) await assert.rejects(execute);
                  else {
                    results.set(options.turnId, await execute());
                    if (plan.complete)
                      options.onEvent({
                        type: 'final',
                        text: 'Synthetic personal request handled.',
                      });
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
        const turn = (await pool.query('SELECT status,error FROM turns WHERE id=$1', [id])).rows[0];
        if (turn.status === status) return;
        assert.notEqual(turn.status, 'failed', turn.error);
        await delay(20);
      }
      assert.fail(`Synthetic turn did not become ${status}.`);
    }
    async function propose(
      action: string,
      args: Record<string, unknown>,
      invalid = false,
      directText?: string,
    ) {
      const text = directText ?? `Synthetic proposal ${randomUUID()}`;
      plans.set(text, { action, args, invalid, complete: Boolean(directText) });
      const response = await request('POST', '/api/messages', { text });
      assert.equal(response.statusCode, 200);
      const id = response.json().turnId as string;
      ids.push(response.json().threadId as string);
      await waitFor(
        id,
        invalid || directText || /^(goal|schedule)_/.test(action) ? 'succeeded' : 'waiting',
      );
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
        'calendar reads finish without an approval or confirmation message',
        async () => {
          await pool.query(
            `INSERT INTO app_connections(id,owner_id,provider_id,slug,account_id,account_name,account_active,account_checked_at)
           VALUES($1,$2,$3,'googlecalendar',$4,'Synthetic calendar',true,now())`,
            [calendar.connectionId, ownerId, integrationProvider.id, calendar.accountId],
          );
          const action = 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS';
          const args = { time_min: '2026-09-30T00:00:00Z', time_max: '2026-10-02T00:00:00Z' };
          const turnId = await propose(
            action,
            { ...args, connectionId: calendar.connectionId },
            false,
            'Anything on my calendar for me to address?',
          );
          assert.equal(catalog.mock.callCount(), 1);
          assert.deepEqual(calendarExecutions, [{ action, args, accountId: calendar.accountId }]);
          assert.deepEqual(results.get(turnId)?.content, [
            { type: 'text', text: JSON.stringify(calendarResult) },
          ]);
          assert.deepEqual(await approvalsFor(turnId), []);
          const messages = (
            await pool.query("SELECT text FROM messages WHERE turn_id=$1 AND role='assistant'", [
              turnId,
            ])
          ).rows;
          assert.deepEqual(messages, [{ text: 'Synthetic personal request handled.' }]);
        },
      );
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
          const turnId = await propose('GMAIL_SEND_EMAIL', {
            connectionId: selected.id,
            recipient_email: 'fixture@example.test',
            subject: 'Synthetic review',
            body: 'A synthetic reply for the selected account.',
          });
          const [approval] = await approvalsFor(turnId);
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
          assert.equal((await approvalsFor(turnId))[0].status, 'pending');
          await assert.rejects(
            application.integrations.describeApproval('foreign', 'GMAIL_SEND_EMAIL', {
              connectionId: selected.id,
            }),
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
