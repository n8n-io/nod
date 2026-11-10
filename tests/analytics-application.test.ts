import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { ProductAnalytics } from '../src/ports/analytics.ts';
import { createIntegrationFixture } from '../scripts/e2e-fixtures.ts';
import { accessCookie, accessKey } from '../src/server/access.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

const gate = () => {
  let resolve!: () => void;
  let settled = false;
  const promise = new Promise<void>((done) => {
    resolve = () => {
      settled = true;
      done();
    };
  });
  return {
    promise,
    resolve,
    get settled() {
      return settled;
    },
  };
};
const classification = () => ({ entered: gate(), released: gate(), usageId: randomUUID() });

test(
  'application workers classify completed turns within their original analytics consent',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 45_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_analytics_app_${suffix}`;
    const bossSchema = `test_analytics_app_boss_${suffix}`;
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
    const dataDirectory = await mkdtemp(join(tmpdir(), 'nod-analytics-application-'));
    process.env.NOD_DATA_ROOT = dataDirectory;
    process.env.NOD_ANALYTICS_ID = randomUUID();
    t.after(() => rm(dataDirectory, { recursive: true, force: true }));
    const { createApplication } = await import('../src/server/composition.ts');
    const { pool } = await import('../src/server/db.ts');
    const { dataRoot, port, ownerId } = await import('../src/server/config.ts');
    const events: Parameters<ProductAnalytics['capture']>[0][] = [];
    const requests: object[] = [];
    let currentClassification = classification();
    let heldAgent:
      { entered: ReturnType<typeof gate>; released: ReturnType<typeof gate> } | undefined;
    const application = await createApplication(
      {
        analytics: { capture: (event) => events.push(event), shutdown: async () => {} },
        agent: {
          async open(options) {
            return {
              resumed: false,
              abort() {},
              dispose() {},
              async prompt() {
                if (heldAgent) {
                  const held = heldAgent;
                  held.entered.resolve();
                  await held.released.promise;
                }
                options.onEvent({
                  type: 'provider_usage',
                  usage: {
                    id: randomUUID(),
                    provider: 'anthropic',
                    model: 'claude-opus-5-5',
                    category: 'agent',
                    operation: 'request',
                    status: 'succeeded',
                    durationMs: 5,
                    costUsd: 0.002,
                    pricing: 'sdk_estimate',
                  },
                });
                options.onEvent({ type: 'final', text: 'Synthetic analytics task completed.' });
              },
            };
          },
          dispose() {},
        },
        classificationCurator: {
          id: 'fixture',
          configured: true,
          async curate(request, _signal, report) {
            assert.equal(request.task, 'classify');
            requests.push(request.input);
            const held = currentClassification;
            held.entered.resolve();
            await held.released.promise;
            report?.({
              id: held.usageId,
              provider: 'anthropic',
              model: 'claude-haiku-5-5',
              costUsd: 0.0001,
              inputTokens: 30,
              outputTokens: 8,
              durationMs: 7,
              status: 'succeeded',
              pricing: 'sdk_estimate',
            });
            return { task_type: 'research' };
          },
        },
        memoryCurator: { id: 'fixture', configured: false, curate: async () => ({}) },
        computer: fakeComputer(),
        workspace: fakeWorkspace(),
        integrations: createIntegrationFixture(`http://localhost:${port}`).provider,
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
        model: { provider: 'anthropic', name: 'claude-opus-5-5', configured: true },
      },
      { channels: false, heartbeat: false },
    );
    const headers = {
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
      cookie: `${accessCookie(port)}=${await accessKey(dataRoot)}`,
    };
    const sharing = async (usageData: boolean) => {
      const response = await application.app.inject({
        method: 'PATCH',
        url: '/api/account',
        headers,
        payload: { usageData },
      });
      assert.equal(response.statusCode, 200, response.body);
    };
    const send = async (text: string, clientMessageId = randomUUID()) => {
      const response = await application.app.inject({
        method: 'POST',
        url: '/api/messages',
        headers,
        payload: { text, clientMessageId },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json().turnId as string;
    };
    const waitFor = async (check: () => Promise<boolean>, label: string) => {
      for (let attempt = 0; attempt < 300; attempt++) {
        if (await check()) return;
        await delay(20);
      }
      assert.fail(`${label} did not happen.`);
    };
    const settle = (id: string) =>
      waitFor(async () => {
        const row = (await pool.query('SELECT status,error FROM turns WHERE id=$1', [id])).rows[0];
        assert.notEqual(row?.status, 'failed', row?.error);
        return row?.status === 'succeeded';
      }, 'Completed execution');
    const usage = (id: string) =>
      pool.query('SELECT owner_id,turn_id,cost_usd,details FROM model_usage WHERE id=$1', [id]);
    try {
      await t.test(
        'completion is immediate and classification cost retains the original run',
        async () => {
          await sharing(true);
          const before = events.length;
          const clientMessageId = randomUUID();
          const id = await send('Compare two synthetic products.', clientMessageId);
          assert.equal(await send('Compare two synthetic products.', clientMessageId), id);
          const accepted = events
            .slice(before)
            .filter((event) => event.event === 'owner_message_accepted');
          assert.equal(accepted.length, 1);
          assert.equal(accepted[0]!.properties.channel, 'web');
          assert.equal(accepted[0]!.properties.analytics_schema, 'v4');
          assert.equal(accepted[0]!.properties.capture_source, 'server');
          assert.equal(Object.hasOwn(accepted[0]!.properties, 'run_id'), false);
          assert.equal(JSON.stringify(accepted).includes('Compare two synthetic products.'), false);
          await waitFor(async () => currentClassification.entered.settled, 'Classifier dispatch');
          await settle(id);
          const started = events.slice(before).find((event) => event.event === 'turn_started')!;
          const completed = events.slice(before).find((event) => event.event === 'turn_completed')!;
          assert.ok(started);
          assert.ok(completed);
          assert.equal(started.properties.task_taxonomy_version, 1);
          assert.equal(completed.properties.task_taxonomy_version, 1);
          assert.equal(completed.properties.run_id, started.properties.run_id);
          assert.equal(completed.properties.model, 'claude-opus-5-5');
          assert.ok(!events.slice(before).some((event) => event.event === 'task_classified'));
          currentClassification.released.resolve();
          await waitFor(
            async () => events.slice(before).some((event) => event.event === 'task_classified'),
            'Classification event',
          );
          const classified = events
            .slice(before)
            .find((event) => event.event === 'task_classified')!;
          const costs = events
            .slice(before)
            .filter(
              (event) =>
                event.event === 'model_used' && event.properties.purpose === 'task_classification',
            );
          assert.equal(costs.length, 1);
          assert.equal(classified.properties.task_type, 'research');
          for (const event of [classified, costs[0]!]) {
            assert.equal(event.properties.run_id, started.properties.run_id);
            assert.equal(event.properties.work_type, 'immediate');
            assert.equal(event.properties.owner_requested, true);
          }
          assert.equal(costs[0]!.properties.model, 'claude-haiku-5-5');
          assert.equal(costs[0]!.properties.cost_usd, 0.0001);
          const rows = (await usage(currentClassification.usageId)).rows;
          assert.equal(rows.length, 1);
          assert.equal(rows[0].owner_id, ownerId);
          assert.equal(rows[0].turn_id, id);
          assert.equal(rows[0].cost_usd, 0.0001);
          assert.equal(rows[0].details.category, 'task_classification');
          assert.equal(requests.length, 1);
        },
      );
      await t.test(
        'opt-out suppresses late classification analytics while retaining incurred cost',
        async () => {
          currentClassification = classification();
          const before = events.length;
          const id = await send('Compare two other synthetic products.');
          await waitFor(async () => currentClassification.entered.settled, 'Classifier dispatch');
          await settle(id);
          await sharing(false);
          currentClassification.released.resolve();
          await waitFor(
            async () => (await usage(currentClassification.usageId)).rowCount === 1,
            'Incurred classification cost',
          );
          assert.ok(
            !events
              .slice(before)
              .some(
                (event) =>
                  event.event === 'task_classified' ||
                  (event.event === 'model_used' &&
                    event.properties.purpose === 'task_classification'),
              ),
          );
          assert.equal((await usage(currentClassification.usageId)).rows[0].turn_id, id);
          assert.equal(requests.length, 2);
        },
      );
      await t.test(
        'enabling sharing during execution does not replace its initial consent',
        async () => {
          heldAgent = { entered: gate(), released: gate() };
          currentClassification = classification();
          const id = await send('Compare a final pair of synthetic products.');
          await waitFor(async () => heldAgent!.entered.settled, 'Agent execution');
          await sharing(true);
          heldAgent.released.resolve();
          await settle(id);
          heldAgent = undefined;
          const control = 'Compare synthetic products after sharing was enabled.';
          const next = await send(control);
          await waitFor(
            async () =>
              requests.some((request) => (request as { request: string }).request === control),
            'New consent classifier dispatch',
          );
          currentClassification.released.resolve();
          await settle(next);
          await waitFor(
            async () =>
              (
                await pool.query(
                  'SELECT 1 FROM analytics_task_categories WHERE origin_turn_id=$1',
                  [next],
                )
              ).rowCount === 1,
            'New consent classification',
          );
          assert.equal(requests.length, 3);
          assert.ok(
            !requests.some(
              (request) =>
                (request as { request: string }).request ===
                'Compare a final pair of synthetic products.',
            ),
          );
          assert.equal(
            (
              await pool.query('SELECT 1 FROM analytics_task_categories WHERE origin_turn_id=$1', [
                id,
              ])
            ).rowCount,
            0,
          );
        },
      );
    } finally {
      currentClassification.released.resolve();
      heldAgent?.released.resolve();
      await application.app.close();
      await pool.end();
    }
  },
);
