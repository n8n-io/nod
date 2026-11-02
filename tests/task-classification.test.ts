import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import type { MemoryCurator } from '../src/ports/memory-curator.ts';
import type { ProductAnalytics } from '../src/ports/analytics.ts';
import { createAnalytics } from '../src/server/analytics.ts';
import { createTaskClassification } from '../src/server/task-classification.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test(
  'task classification keeps purpose bounded across owned executions and consent changes',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60_000 },
  async (t) => {
    const schema = `test_task_classification_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const pool = new pg.Pool({ connectionString: url.href });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    await pool.query(`
      CREATE TABLE threads(id uuid PRIMARY KEY, owner_id text NOT NULL, archived_at timestamptz);
      CREATE TABLE turns(
        id uuid PRIMARY KEY, owner_id text NOT NULL, thread_id uuid NOT NULL REFERENCES threads(id),
        session_id uuid NOT NULL, source text NOT NULL, source_id text, message_id uuid,
        parent_turn_id uuid, task_id uuid, prompt text NOT NULL, channel text NOT NULL DEFAULT 'web',
        background boolean NOT NULL DEFAULT false, proactive boolean NOT NULL DEFAULT false,
        status text NOT NULL DEFAULT 'succeeded', created_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz DEFAULT now(), finished_at timestamptz DEFAULT now()
      );
      CREATE TABLE messages(
        id uuid PRIMARY KEY, owner_id text NOT NULL, thread_id uuid NOT NULL REFERENCES threads(id),
        turn_id uuid REFERENCES turns(id), role text NOT NULL, text text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE tasks(
        id uuid PRIMARY KEY, owner_id text NOT NULL, session_id uuid NOT NULL,
        title text NOT NULL, brief text NOT NULL DEFAULT '', done_when text NOT NULL
      );
    `);
    async function fixture(
      context: TestContext,
      options: {
        classify?: MemoryCurator['curate'];
        configured?: boolean;
        available?: boolean;
        enabled?: boolean;
        secrets?: string[];
      } = {},
    ) {
      const ownerId = `synthetic-${randomUUID()}`;
      const threadId = randomUUID();
      await pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [threadId, ownerId]);
      const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
      const requests: Parameters<MemoryCurator['curate']>[0][] = [];
      const signals: Array<AbortSignal | undefined> = [];
      const analytics = await createAnalytics({
        ...(options.available === false
          ? {}
          : {
              provider: {
                capture: (event) => captured.push(event),
                shutdown: async () => {},
              },
            }),
        environment: 'development',
        dataRoot: '.',
        installationId: randomUUID(),
      });
      context.after(() => analytics.shutdown());
      analytics.setUsageData(ownerId, options.enabled !== false, 'synthetic-revision-1');
      const curator: MemoryCurator = {
        id: 'fixture',
        configured: options.configured !== false,
        async curate(request, signal, report) {
          requests.push(request);
          signals.push(signal);
          return options.classify
            ? options.classify(request, signal, report)
            : { task_type: 'research' };
        },
      };
      const serviceOptions = {
        pool,
        ownerId,
        curator,
        analytics: analytics.forOwner(ownerId),
        consent: () => analytics.consent(ownerId),
        secrets: options.secrets,
      };
      const service = createTaskClassification(serviceOptions);
      await service.initialize();
      async function turn(
        prompt: string,
        fields: {
          source?: string;
          sourceId?: string;
          sessionId?: string;
          parentTurnId?: string;
          taskId?: string;
          background?: boolean;
          proactive?: boolean;
          status?: string;
          owner?: string;
          withMessage?: boolean;
        } = {},
      ) {
        const id = randomUUID();
        const messageId = fields.withMessage === false ? null : randomUUID();
        const owner = fields.owner ?? ownerId;
        await pool.query(
          `INSERT INTO turns(id,owner_id,thread_id,session_id,source,source_id,message_id,parent_turn_id,prompt,background,proactive,status,task_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            id,
            owner,
            threadId,
            fields.sessionId ?? threadId,
            fields.source ?? 'user',
            fields.sourceId ?? null,
            messageId,
            fields.parentTurnId ?? null,
            prompt,
            fields.background ?? false,
            fields.proactive ?? false,
            fields.status ?? 'succeeded',
            fields.taskId ?? null,
          ],
        );
        if (messageId)
          await pool.query(
            'INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,$5,$6)',
            [messageId, owner, threadId, id, 'user', prompt],
          );
        return id;
      }
      async function task(
        fields: {
          sessionId?: string;
          owner?: string;
          title?: string;
          brief?: string;
          doneWhen?: string;
        } = {},
      ) {
        const id = randomUUID();
        const sessionId = fields.sessionId ?? randomUUID();
        await pool.query(
          'INSERT INTO tasks(id,owner_id,session_id,title,brief,done_when) VALUES($1,$2,$3,$4,$5,$6)',
          [
            id,
            fields.owner ?? ownerId,
            sessionId,
            fields.title ?? 'Synthetic saved task',
            fields.brief ?? '',
            fields.doneWhen ?? '',
          ],
        );
        return { taskId: id, sessionId };
      }
      const run = (id: string) => analytics.withRun(ownerId, () => service.run(id));
      const results = () => captured.filter((event) => event.event === 'task_classified');
      return {
        ownerId,
        threadId,
        captured,
        requests,
        signals,
        analytics,
        service,
        serviceOptions,
        turn,
        task,
        run,
        results,
      };
    }

    await t.test(
      'only purpose reaches analytics and assistant content is excluded from the classifier',
      async (t) => {
        const f = await fixture(t);
        const prompt = 'Compare the specifications in private-research-canary.txt.';
        const id = await f.turn(prompt);
        await pool.query(
          'INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,$5,$6)',
          [randomUUID(), f.ownerId, f.threadId, id, 'assistant', 'private-assistant-canary'],
        );
        await f.run(id);
        assert.equal(f.requests.length, 1);
        assert.ok(JSON.stringify(f.requests[0].input).includes(prompt));
        assert.ok(!JSON.stringify(f.requests[0].input).includes('private-assistant-canary'));
        assert.deepEqual(Object.keys(f.requests[0].input), ['request']);
        assert.equal(f.results().length, 1);
        assert.equal(f.results()[0].properties.task_type, 'research');
        assert.equal(f.results()[0].properties.classification_status, 'classified');
        assert.equal(f.results()[0].properties.task_taxonomy_version, 1);
        for (const value of [prompt, id, f.threadId, f.ownerId, 'private-assistant-canary'])
          assert.ok(!JSON.stringify(f.captured).includes(value), value);
        assert.ok(!f.captured.some((event) => event.event === 'task_finished'));
      },
    );
    await t.test('new goals in the persistent chat receive their own categories', async (t) => {
      let calls = 0;
      const f = await fixture(t, {
        classify: async () => ({ task_type: calls++ === 0 ? 'research' : 'content_creation' }),
      });
      await f.run(await f.turn('Compare the two products.'));
      await f.run(await f.turn('Write a short story about a lighthouse.'));
      assert.equal(f.requests.length, 2);
      assert.deepEqual(
        f.results().map((event) => event.properties.task_type),
        ['research', 'content_creation'],
      );
    });
    await t.test(
      'approval resumes reuse the original purpose after service recreation',
      async (t) => {
        const f = await fixture(t);
        const first = await f.turn('Compare the specifications.', { status: 'waiting_user' });
        await f.run(first);
        const resume = await f.turn('Yes.', { source: 'resume', parentTurnId: first });
        const reopened = createTaskClassification(f.serviceOptions);
        await reopened.initialize();
        await f.analytics.withRun(f.ownerId, () => reopened.run(resume));
        assert.equal(f.requests.length, 1);
        assert.deepEqual(
          f.results().map((event) => event.properties.task_type),
          ['research', 'research'],
        );
        assert.notEqual(f.results()[0].properties.run_id, f.results()[1].properties.run_id);
      },
    );
    await t.test('background task replies retain purpose even with a user source', async (t) => {
      const f = await fixture(t, { classify: async () => ({ task_type: 'data_analysis' }) });
      const sessionId = randomUUID();
      await f.run(
        await f.turn('Calculate the average of the attached figures.', {
          source: 'task',
          sessionId,
          background: true,
          withMessage: false,
        }),
      );
      await f.run(await f.turn('Use one decimal place.', { sessionId, background: true }));
      assert.equal(f.requests.length, 1);
      assert.deepEqual(
        f.results().map((event) => event.properties.task_type),
        ['data_analysis', 'data_analysis'],
      );
    });
    await t.test(
      'separate saved tasks from one request classify their own bounded purposes',
      async (t) => {
        const f = await fixture(t);
        const prompt =
          'Compare the two products and draft a message asking my colleague to review them.';
        const purposes = [
          {
            title: 'Product comparison',
            brief: 'Compare the specifications of the two products.',
            doneWhen: 'A comparison table is ready.',
          },
          {
            title: 'Review request',
            brief: 'Draft a short message asking my colleague to review the products.',
            doneWhen: 'An unsent draft is ready.',
          },
        ];
        for (const purpose of purposes) {
          const task = await f.task(purpose);
          await f.run(
            await f.turn(prompt, { ...task, source: 'task', background: true, withMessage: false }),
          );
        }
        assert.deepEqual(
          f.requests.map(({ input }) => input),
          purposes.map(({ brief }) => ({ request: brief })),
        );
        assert.equal(f.results().length, 2);
        for (const value of [
          prompt,
          ...purposes.flatMap(({ title, brief, doneWhen }) => [title, brief, doneWhen]),
        ])
          assert.ok(!JSON.stringify(f.captured).includes(value));
      },
    );
    await t.test('an empty saved task brief falls back to its completion criteria', async (t) => {
      const f = await fixture(t);
      const doneWhen = 'A French translation of the supplied note is ready.';
      const task = await f.task({ brief: '  \n ', doneWhen });
      await f.run(
        await f.turn('Prepare several different outputs.', {
          ...task,
          source: 'task',
          background: true,
          withMessage: false,
        }),
      );
      assert.deepEqual(
        f.requests.map(({ input }) => input),
        [{ request: doneWhen }],
      );
    });
    await t.test(
      'a reopened saved task retains completion criteria when its brief is absent',
      async (t) => {
        const f = await fixture(t, { classify: async () => ({ task_type: 'translation' }) });
        const doneWhen = 'A German version of the provided note is ready.';
        const task = await f.task({ brief: '', doneWhen });
        await f.turn('Prepare several different outputs.', {
          ...task,
          source: 'task',
          background: true,
          withMessage: false,
          status: 'cancelled',
        });
        await f.run(
          await f.turn('Continue the remaining work.', {
            sessionId: task.sessionId,
            background: true,
          }),
        );
        await f.run(
          await f.turn('Use formal wording.', { sessionId: task.sessionId, background: true }),
        );
        assert.deepEqual(
          f.requests.map(({ input }) => input),
          [{ request: doneWhen }],
        );
        assert.deepEqual(
          f.results().map(({ properties }) => properties.task_type),
          ['translation', 'translation'],
        );
        assert.notEqual(f.results()[0].properties.run_id, f.results()[1].properties.run_id);
      },
    );
    for (const mismatch of ['owner', 'session', 'missing', 'empty'])
      await t.test(
        `a saved task with ${mismatch} binding falls back without reading unrelated content`,
        async (t) => {
          const f = await fixture(t);
          const prompt = 'Calculate the average of the supplied figures.';
          const task = await f.task({
            owner: mismatch === 'owner' ? `foreign-${randomUUID()}` : f.ownerId,
            title: 'Unrelated private title',
            brief: mismatch === 'empty' ? '  ' : 'Unrelated private task brief',
            doneWhen: mismatch === 'empty' ? '  ' : 'Unrelated private completion criteria',
          });
          await f.run(
            await f.turn(prompt, {
              ...task,
              taskId: mismatch === 'missing' ? randomUUID() : task.taskId,
              sessionId: mismatch === 'session' ? randomUUID() : task.sessionId,
              source: 'task',
              background: true,
              withMessage: false,
            }),
          );
          assert.deepEqual(
            f.requests.map(({ input }) => input),
            [{ request: prompt }],
          );
          assert.ok(!JSON.stringify(f.captured).includes('Unrelated private'));
        },
      );
    await t.test(
      'saved task purposes retain the classifier redaction and length limit',
      async (t) => {
        const secret = 'synthetic-task-secret-6q2';
        const f = await fixture(t, { secrets: [secret] });
        const task = await f.task({
          brief: `Compare the products using ${secret}. ${'detail '.repeat(1100)}`,
        });
        await f.run(
          await f.turn('Prepare several different outputs.', {
            ...task,
            source: 'task',
            background: true,
            withMessage: false,
          }),
        );
        const input = f.requests[0].input;
        assert.ok('request' in input);
        const request = input.request;
        assert.ok(typeof request === 'string');
        assert.equal(request.length, 6000);
        assert.ok(request.startsWith('Compare the products using '));
        assert.ok(!request.includes(secret));
        assert.ok(!JSON.stringify(f.captured).includes('Compare the products using'));
      },
    );
    await t.test('schedule creation and its later work have separate purposes', async (t) => {
      let calls = 0;
      const f = await fixture(t, {
        classify: async () => ({ task_type: calls++ === 0 ? 'scheduling' : 'monitoring' }),
      });
      await f.run(await f.turn('Every morning, check the status page for new incidents.'));
      await f.run(
        await f.turn('Check the status page for new incidents.', {
          source: 'schedule',
          sessionId: randomUUID(),
          background: true,
          withMessage: false,
        }),
      );
      assert.equal(f.requests.length, 2);
      assert.deepEqual(
        f.results().map((event) => event.properties.task_type),
        ['scheduling', 'monitoring'],
      );
    });
    await t.test('a reopened background task classifies its cancelled origin once', async (t) => {
      const f = await fixture(t, { classify: async () => ({ task_type: 'data_analysis' }) });
      const sessionId = randomUUID();
      await f.turn('Calculate the average of the attached figures.', {
        source: 'task',
        sessionId,
        background: true,
        withMessage: false,
        status: 'cancelled',
      });
      await f.run(await f.turn('Continue the calculation.', { sessionId, background: true }));
      await f.run(await f.turn('Show one decimal place.', { sessionId, background: true }));
      assert.equal(f.requests.length, 1);
      assert.deepEqual(
        f.results().map((event) => event.properties.task_type),
        ['data_analysis', 'data_analysis'],
      );
    });
    await t.test(
      'a reply arriving during origin classification shares and retains that result',
      async (t) => {
        const entered = deferred<void>();
        const answer = deferred<unknown>();
        const f = await fixture(t, {
          classify: async () => {
            entered.resolve();
            return answer.promise;
          },
        });
        const sessionId = randomUUID();
        const first = await f.turn('Compare the two products.', {
          source: 'task',
          sessionId,
          background: true,
          status: 'waiting_user',
          withMessage: false,
        });
        const firstRun = f.run(first);
        await entered.promise;
        await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [first]);
        const second = await f.turn('Continue with the cheaper option.', {
          sessionId,
          background: true,
        });
        const secondRun = f.run(second);
        answer.resolve({ task_type: 'research' });
        await Promise.all([firstRun, secondRun]);
        await f.run(
          await f.turn('Show the comparison as a table.', { sessionId, background: true }),
        );
        assert.equal(f.requests.length, 1);
        assert.equal(f.results().length, 2);
        assert.ok(f.results().every((event) => event.properties.task_type === 'research'));
      },
    );
    for (const status of ['cancelled', 'interrupted', 'skipped'])
      await t.test(`${status} executions are explicitly inapplicable`, async (t) => {
        const f = await fixture(t);
        await f.run(await f.turn('Compare the products.', { status }));
        assert.equal(f.requests.length, 0);
        assert.equal(f.results().length, 1);
        assert.equal(f.results()[0].properties.classification_status, 'not_applicable');
      });
    for (const fields of [
      { source: 'event', proactive: true, background: true },
      { source: 'task', sourceId: 'onboarding:synthetic-task', background: true },
    ])
      await t.test(`system work ${fields.sourceId ?? fields.source} is inapplicable`, async (t) => {
        const f = await fixture(t);
        await f.run(await f.turn('Prepare suggestions.', fields));
        assert.equal(f.requests.length, 0);
        assert.equal(f.results()[0].properties.classification_status, 'not_applicable');
      });
    for (const options of [{ available: false }, { enabled: false }])
      await t.test(
        `disabled collection makes no classification calls ${JSON.stringify(options)}`,
        async (t) => {
          const f = await fixture(t, options);
          await f.run(await f.turn('Compare the products.'));
          assert.equal(f.requests.length, 0);
          assert.deepEqual(f.captured, []);
        },
      );
    await t.test(
      'execution-start consent cannot be replaced by later sharing permission',
      async (t) => {
        const f = await fixture(t, { enabled: false });
        const disabled = f.analytics.consent(f.ownerId);
        f.analytics.setUsageData(f.ownerId, true, 'synthetic-revision-2');
        const stale = f.analytics.consent(f.ownerId);
        f.analytics.setUsageData(f.ownerId, false, 'synthetic-revision-3');
        f.analytics.setUsageData(f.ownerId, true, 'synthetic-revision-4');
        const id = await f.turn('Compare the products.');
        for (const consent of [disabled, stale])
          await f.analytics.withRun(f.ownerId, () => f.service.run(id, consent));
        assert.equal(f.requests.length, 0);
        assert.deepEqual(f.captured, []);
      },
    );
    await t.test(
      'revoking consent settles a classifier that ignores its abort signal',
      async (t) => {
        const entered = deferred<void>();
        const f = await fixture(t, {
          classify: async () => {
            entered.resolve();
            return new Promise<unknown>(() => {});
          },
        });
        const running = f.run(await f.turn('Compare the products.'));
        await entered.promise;
        f.analytics.setUsageData(f.ownerId, false, 'synthetic-revision-2');
        assert.equal(await Promise.race([running.then(() => true), delay(500, false)]), true);
        assert.deepEqual(f.captured, []);
        const cached = await pool.query(
          'SELECT count(*)::integer AS count FROM analytics_task_categories WHERE owner_id=$1',
          [f.ownerId],
        );
        assert.equal(cached.rows[0].count, 0);
      },
    );
    for (const reenable of [false, true])
      await t.test(
        `in-flight classification cannot survive consent rotation ${reenable}`,
        async (t) => {
          const entered = deferred<void>();
          const answer = deferred<unknown>();
          const f = await fixture(t, {
            classify: async () => {
              entered.resolve();
              return answer.promise;
            },
          });
          const running = f.run(await f.turn('Compare the products.'));
          await entered.promise;
          f.analytics.setUsageData(f.ownerId, false, 'synthetic-revision-2');
          if (reenable) f.analytics.setUsageData(f.ownerId, true, 'synthetic-revision-3');
          answer.resolve({ task_type: 'research' });
          await running;
          assert.ok(f.signals[0]?.aborted);
          assert.deepEqual(f.captured, []);
        },
      );
    await t.test('reset discards in-flight classification without a consent change', async (t) => {
      const entered = deferred<void>();
      const answer = deferred<unknown>();
      const f = await fixture(t, {
        classify: async () => {
          entered.resolve();
          return answer.promise;
        },
      });
      const running = f.run(await f.turn('Compare the products.'));
      await entered.promise;
      await pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [f.threadId]);
      answer.resolve({ task_type: 'research' });
      await running;
      assert.deepEqual(f.captured, []);
    });
    await t.test('late cancellation cannot receive a classified result', async (t) => {
      const entered = deferred<void>();
      const answer = deferred<unknown>();
      const f = await fixture(t, {
        classify: async () => {
          entered.resolve();
          return answer.promise;
        },
      });
      const id = await f.turn('Compare the products.');
      const running = f.run(id);
      await entered.promise;
      await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [id]);
      answer.resolve({ task_type: 'research' });
      await running;
      assert.ok(
        !f.results().some((event) => event.properties.classification_status === 'classified'),
      );
      const cached = await pool.query(
        'SELECT count(*)::integer AS count FROM analytics_task_categories WHERE owner_id=$1',
        [f.ownerId],
      );
      assert.equal(cached.rows[0].count, 0);
    });
    await t.test('foreign owners and archived conversations provide no input', async (t) => {
      const f = await fixture(t);
      await f.run(
        await f.turn('foreign-owner-private-request', { owner: 'synthetic-other-owner' }),
      );
      await pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [f.threadId]);
      await f.run(await f.turn('archived-private-request'));
      assert.equal(f.requests.length, 0);
      assert.deepEqual(f.captured, []);
    });
    await t.test(
      'invalid and content-bearing responses never become task properties',
      async (t) => {
        for (const response of [
          { task_type: 'research', title: 'private-classifier-title' },
          { task_type: 'private-classifier-label' },
          'private-classifier-text',
          null,
        ]) {
          const f = await fixture(t, { classify: async () => response });
          await f.run(await f.turn('Compare the products.'));
          assert.equal(f.results().length, 1);
          assert.equal(f.results()[0].properties.task_type, 'unknown');
          assert.equal(f.results()[0].properties.classification_status, 'failed');
          assert.ok(!JSON.stringify(f.captured).includes('private-classifier'));
        }
      },
    );
    await t.test(
      'unavailable and failed classification leave execution outcomes untouched',
      async (t) => {
        for (const [options, expected] of [
          [{ configured: false }, 'unavailable'],
          [
            {
              classify: async () => {
                throw new Error('private-provider-error');
              },
            },
            'failed',
          ],
        ] as const) {
          const f = await fixture(t, options);
          const id = await f.turn('Compare the products.');
          await f.run(id);
          assert.equal(f.results()[0].properties.classification_status, expected);
          assert.equal(f.results()[0].properties.task_type, 'unknown');
          assert.equal(
            (await pool.query('SELECT status FROM turns WHERE id=$1', [id])).rows[0].status,
            'succeeded',
          );
          assert.ok(!f.captured.some((event) => event.event === 'task_finished'));
          assert.ok(!JSON.stringify(f.captured).includes('private-provider-error'));
        }
      },
    );
    await t.test('known private values are removed and classifier input is bounded', async (t) => {
      const secret = 'synthetic-private-classifier-secret';
      const f = await fixture(t, { secrets: [secret] });
      await f.run(await f.turn(`Compare the two products. ${secret} ${'bounded '.repeat(1000)}`));
      assert.equal(f.requests.length, 1);
      const request = (f.requests[0].input as { request: string }).request;
      assert.ok(!request.includes(secret));
      assert.ok(request.length <= 6000);
      assert.ok(!JSON.stringify(f.captured).includes(secret));
    });
    await t.test(
      'reverse-order completions preserve their originating analytics run',
      async (t) => {
        const entered = deferred<void>();
        const answers = new Map<string, ReturnType<typeof deferred<unknown>>>();
        const f = await fixture(t, {
          classify: async (request) => {
            const input = (request.input as { request: string }).request;
            const answer = deferred<unknown>();
            answers.set(input, answer);
            if (answers.size === 2) entered.resolve();
            return answer.promise;
          },
        });
        const first = await f.turn('Compare products.');
        const second = await f.turn('Write a poem.');
        const runIds = new Map<string, string>();
        const execute = (id: string) =>
          f.analytics.withRun(f.ownerId, async () => {
            runIds.set(id, f.analytics.currentRun(f.ownerId)!.id);
            await f.service.run(id);
          });
        const firstRun = execute(first);
        const secondRun = execute(second);
        await entered.promise;
        const keys = [...answers.keys()];
        answers
          .get(keys.find((key) => key.includes('Write a poem.'))!)!
          .resolve({ task_type: 'content_creation' });
        await secondRun;
        answers
          .get(keys.find((key) => key.includes('Compare products.'))!)!
          .resolve({ task_type: 'research' });
        await firstRun;
        assert.deepEqual(
          f.results().map((event) => [event.properties.run_id, event.properties.task_type]),
          [
            [runIds.get(second), 'content_creation'],
            [runIds.get(first), 'research'],
          ],
        );
      },
    );
  },
);
