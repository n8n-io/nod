import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { Agent, RuntimeContext, RuntimeResult } from '../src/ports/agent.ts';
import type { Artifact, AppState, MessageHistoryPage } from '../src/shared/contracts.ts';
import { createAgentBrowserComputer } from '../src/providers/agent-browser/index.ts';
import { createChatSdkTransport } from '../src/providers/chat-sdk/index.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { createChannels } from '../src/server/channels.ts';
import { browserDownloadPdf, createBrowserDownloadFixture } from './browser-download-fixture.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

const native = process.env.OTTO_TEST_NATIVE_DOWNLOAD === 'true';
const pdfHash = createHash('sha256').update(browserDownloadPdf).digest('hex');
const telegram = {
  TELEGRAM_ENABLED: 'true',
  TELEGRAM_BOT_TOKEN: '987:fixture-not-live',
  TELEGRAM_WEBHOOK_SECRET_TOKEN: 'fixture-browser-download-webhook-secret',
  TELEGRAM_ALLOWED_USER_ID: '123456',
};

test(
  'browser downloads pass through runtime publication, owned HTTP delivery and Telegram multipart',
  { skip: !process.env.TEST_DATABASE_URL && !native, timeout: 150_000 },
  async (t) => {
    assert.ok(process.env.TEST_DATABASE_URL, 'A disposable test database is required.');
    if (native)
      assert.ok(process.env.OTTO_TEST_BROWSER_EXECUTABLE, 'A native browser is required.');
    const cleanup: Array<() => Promise<unknown>> = [];
    t.after(async () => {
      const failures: unknown[] = [];
      for (const dispose of cleanup.reverse()) {
        try {
          await dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Fixture cleanup failed.');
    });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_browser_delivery_${suffix}`;
    const bossSchema = `test_browser_delivery_boss_${suffix}`;
    const dataRoot = await mkdtemp(join(tmpdir(), 'otto-browser-delivery-'));
    cleanup.push(() => rm(dataRoot, { recursive: true, force: true }));
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    cleanup.push(() => admin.end());
    await admin.query(`CREATE SCHEMA ${schema}`);
    cleanup.push(() => admin.query(`DROP SCHEMA ${schema} CASCADE`));
    cleanup.push(() => admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`));
    const database = new URL(process.env.TEST_DATABASE_URL);
    database.searchParams.set('options', `-c search_path=${schema}`);
    database.searchParams.set('application_name', schema);
    process.env.DATABASE_URL = database.href;
    process.env.DATABASE_POOL_MAX = '4';
    process.env.PGBOSS_SCHEMA = bossSchema;
    process.env.OTTO_DATA_ROOT = dataRoot;
    process.env.OTTO_MODE = 'local';
    const db = await import('../src/server/db.ts');
    cleanup.push(() => db.pool.end());
    const tasks = await import('../src/server/tasks.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const { createArtifactService, localArtifacts } = await import('../src/server/artifacts.ts');
    const { ownerId, port } = await import('../src/server/config.ts');
    const app = await createApp();
    cleanup.push(() => app.close());
    const headers = { host: `localhost:${port}` };
    const sent: Array<{ chat: string; name: string; mimeType: string; bytes: Buffer }> = [];
    const fetchLocal = globalThis.fetch.bind(globalThis);
    const captured = new Map<string, Artifact>();
    const held = new Map<string, RuntimeContext>();
    const release = new Map<string, () => void>();
    const runtimes = new Map<string, ReturnType<typeof createAgentRuntime>>();
    const publications = new Map<
      string,
      { stored: (artifact: Artifact) => void; resume: Promise<void> }
    >();
    const publicationStarts = new Map<string, { enter: () => void; resume: Promise<void> }>();
    cleanup.push(async () => {
      const results = await Promise.allSettled(
        [...runtimes.values()].map((runtime) => runtime.dispose()),
      );
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    });
    cleanup.push(() => tasks.stopTasks());
    let channels: Awaited<ReturnType<typeof createChannels>> | undefined;
    const forbidden = async () => {
      throw new Error('Unused fixture capability.');
    };
    const waitFor = async (condition: () => Promise<boolean> | boolean) => {
      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline) {
        if (await condition()) return;
        await delay(25);
      }
      assert.fail('The synthetic task did not reach its expected boundary.');
    };
    const succeeded = (id: string) =>
      waitFor(async () => {
        const row = (await db.pool.query('SELECT status FROM tasks WHERE id=$1', [id])).rows[0];
        assert.notEqual(row?.status, 'failed', 'The synthetic download task failed.');
        return row?.status === 'succeeded';
      });
    t.mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === `https://api.telegram.org/bot${telegram.TELEGRAM_BOT_TOKEN}/getMe`)
          return Response.json({
            ok: true,
            result: { id: 987, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' },
          });
        assert.equal(
          url,
          `https://api.telegram.org/bot${telegram.TELEGRAM_BOT_TOKEN}/sendDocument`,
        );
        assert.ok(init?.body instanceof FormData);
        const document = init.body.get('document');
        assert.ok(document instanceof File);
        assert.doesNotMatch(
          String(init.body.get('caption') ?? ''),
          /https?:|synthetic-session|\/api\//,
        );
        sent.push({
          chat: String(init.body.get('chat_id')),
          name: document.name,
          mimeType: document.type,
          bytes: Buffer.from(await document.arrayBuffer()),
        });
        return Response.json({
          ok: true,
          result: {
            message_id: sent.length + 100,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 123456, type: 'private' },
            text: 'Fixture accepted',
          },
        });
      },
    );
    try {
      await db.initializeDatabase();
      await tasks.initializeTasks();
      await createPersonalService({
        pool: db.pool,
        ownerId,
        scheduler: tasks.boss,
        submitTask: tasks.submitTask,
        refresh() {},
      }).initialize({ workers: false });
      channels = await createChannels(db.pool, {
        ownerId,
        transport: createChatSdkTransport(db.pool, telegram),
        resolveAttachments: localArtifacts.readTaskArtifacts,
        subscribe: () => () => {},
        intervalMs: 600_000,
        submit: (text, sourceId, client, channel, _prepared, messageId) =>
          tasks.submitTask(text, [], undefined, false, { sourceId, client, channel, messageId }),
      });
      cleanup.push(() => channels!.close());
      channels.registerRoutes(app);
      await tasks.startTaskWorkers({
        artifacts: {
          ...localArtifacts,
          async storeArtifact(...args) {
            const starting = args[3] ? publicationStarts.get(args[3]) : undefined;
            if (starting) {
              starting.enter();
              await starting.resume;
            }
            const artifact = await localArtifacts.storeArtifact(...args);
            const publication = args[3] ? publications.get(args[3]) : undefined;
            if (publication) {
              publication.stored(artifact);
              await publication.resume;
            }
            return artifact;
          },
        },
        runTask: async (context) => {
          if (context.prompt.startsWith('Held ')) {
            held.set(context.taskId, context);
            await new Promise<void>((resolve) => release.set(context.taskId, resolve));
            return { status: 'succeeded' } satisfies RuntimeResult;
          }
          const runtime = runtimes.get(context.prompt);
          assert.ok(runtime, 'A task must use its assigned synthetic runtime.');
          return runtime.runTask(context);
        },
        speech: { synthesize: forbidden },
        requestCredential: forbidden,
        integration: forbidden,
        manage: forbidden,
      });
      let updateId = 0;
      for (const mode of ['adapter fixture', 'authenticated native Chromium'] as const) {
        await t.test(mode, { skip: mode !== 'adapter fixture' && !native }, async (test) => {
          const fixture = await createBrowserDownloadFixture();
          test.after(() => fixture.close());
          assert.equal(
            (
              await fetchLocal(`${fixture.origin}/invoice.pdf`, {
                signal: AbortSignal.timeout(2000),
              })
            ).status,
            403,
          );
          const downloadCalls: string[] = [];
          const active = new Set<string>();
          const computer =
            mode === 'adapter fixture'
              ? fakeComputer({
                  act: async (taskId, input) => {
                    assert.deepEqual(input, { action: 'open', url: `${fixture.origin}/session` });
                    active.add(taskId);
                    return {
                      text: 'Synthetic invoices',
                      url: `${fixture.origin}/session`,
                      candidates: [],
                    };
                  },
                  download: async (taskId, input, signal) => {
                    assert.ok(active.has(taskId));
                    signal?.throwIfAborted();
                    assert.deepEqual(input, { selector: '#download', name: 'invoice.pdf' });
                    downloadCalls.push(taskId);
                    return {
                      bytes: Buffer.from(browserDownloadPdf),
                      name: 'invoice.pdf',
                      mimeType: 'application/pdf',
                    };
                  },
                })
              : createAgentBrowserComputer({
                  dataRoot: join(dataRoot, 'browser'),
                  browserExecutable: process.env.OTTO_TEST_BROWSER_EXECUTABLE,
                  headless: true,
                });
          const agent: Agent = {
            open: async (input) => ({
              resumed: false,
              prompt: async () => {
                const tools = new Map(input.tools.map((tool) => [tool.name, tool]));
                await tools
                  .get('browser')!
                  .execute({ action: 'open', url: `${fixture.origin}/session` });
                const result = await tools
                  .get('download_browser_file')!
                  .execute({ selector: '#download', name: 'invoice.pdf' });
                assert.equal(result.content.length, 1);
                const content = result.content[0];
                assert.equal(content.type, 'text');
                if (content.type !== 'text') throw new Error('Expected an artifact receipt.');
                const artifact = JSON.parse(content.text) as Artifact;
                assert.deepEqual(Object.keys(artifact).sort(), [
                  'id',
                  'mimeType',
                  'name',
                  'size',
                  'url',
                ]);
                assert.equal(artifact.mimeType, 'application/pdf');
                assert.equal(artifact.name, 'invoice.pdf');
                assert.equal(artifact.size, browserDownloadPdf.length);
                captured.set(input.taskId, artifact);
              },
              abort() {},
              dispose() {},
            }),
            dispose() {},
          };
          const runtime = createAgentRuntime({
            agent,
            computer,
            workspace: fakeWorkspace({
              open: () => ({
                path: '/synthetic/unused-workspace',
                instructions: 'The browser owns the synthetic download.',
                execute: forbidden,
                readFile: forbidden,
                writeFile: forbidden,
              }),
            }),
          });
          const prompt = `Download the synthetic invoice using ${mode}.`;
          runtimes.set(prompt, runtime);
          try {
            const webId = await tasks.submitTask(prompt);
            await succeeded(webId);
            const webFile = captured.get(webId)!;
            assert.ok(webFile);
            const response = await app.inject({ method: 'GET', url: webFile.url, headers });
            assert.equal(response.statusCode, 200);
            assert.equal(response.headers['content-type'], 'application/pdf');
            assert.equal(response.headers['cache-control'], 'private, no-store');
            assert.equal(
              response.headers['content-security-policy'],
              "default-src 'none'; sandbox",
            );
            assert.deepEqual(response.rawPayload, browserDownloadPdf);
            assert.equal(createHash('sha256').update(response.rawPayload).digest('hex'), pdfHash);
            const beforeSend = sent.length;
            const inbound = ++updateId;
            const accepted = await app.inject({
              method: 'POST',
              url: '/api/webhooks/telegram',
              headers: {
                ...headers,
                'x-telegram-bot-api-secret-token': telegram.TELEGRAM_WEBHOOK_SECRET_TOKEN,
              },
              payload: {
                update_id: inbound,
                message: {
                  message_id: inbound,
                  date: Math.floor(Date.now() / 1000),
                  text: prompt,
                  from: { id: 123456, is_bot: false, first_name: 'Fixture' },
                  chat: { id: 123456, type: 'private' },
                },
              },
            });
            assert.equal(accepted.statusCode, 200);
            await channels!.drain();
            const inbox = (
              await db.pool.query('SELECT task_id FROM channel_inbox WHERE text=$1', [prompt])
            ).rows;
            assert.equal(inbox.length, 1);
            const telegramId = inbox[0].task_id as string;
            assert.notEqual(telegramId, webId);
            await succeeded(telegramId);
            await channels!.drain();
            const telegramFile = captured.get(telegramId)!;
            assert.ok(telegramFile);
            assert.notEqual(telegramFile.id, webFile.id);
            assert.equal(sent.length, beforeSend + 1);
            assert.deepEqual(sent.at(-1), {
              chat: '123456',
              name: 'invoice.pdf',
              mimeType: 'application/pdf',
              bytes: browserDownloadPdf,
            });
            assert.equal(createHash('sha256').update(sent.at(-1)!.bytes).digest('hex'), pdfHash);
            await channels!.drain();
            assert.equal(sent.length, beforeSend + 1);
            const deliveries = (
              await db.pool.query(
                'SELECT o.state,m.owner_id,m.task_id,m.attachments FROM channel_outbox o JOIN messages m ON m.id=o.message_id WHERE m.task_id=$1',
                [telegramId],
              )
            ).rows;
            assert.equal(deliveries.length, 1);
            assert.equal(deliveries[0].state, 'sent');
            assert.equal(deliveries[0].owner_id, ownerId);
            assert.equal(deliveries[0].attachments[0].id, telegramFile.id);
            const state = (
              await app.inject({ method: 'GET', url: '/api/state', headers })
            ).json<AppState>();
            const history = (
              await app.inject({ method: 'GET', url: '/api/messages', headers })
            ).json<MessageHistoryPage>().messages;
            for (const messages of [state.messages, history]) {
              assert.equal(
                messages.some((message) => message.taskId === telegramId),
                false,
              );
              assert.equal(
                messages
                  .flatMap((message) => message.attachments)
                  .some((file) => file.id === webFile.id),
                true,
              );
            }
            const foreign = createArtifactService({
              database: db.pool,
              ownerId: 'foreign-owner',
              localRoot: dataRoot,
            });
            await assert.rejects(foreign.readArtifact(webFile.id), /unavailable/);
            await assert.rejects(
              localArtifacts.readTaskArtifacts(telegramId, [webFile.id]),
              /unavailable/,
            );
            await db.pool.query("UPDATE artifacts SET owner_id='foreign-owner' WHERE id=$1", [
              webFile.id,
            ]);
            assert.deepEqual(await foreign.readArtifact(webFile.id), browserDownloadPdf);
            const denied = await app.inject({ method: 'GET', url: webFile.url, headers });
            assert.equal(denied.statusCode, 404);
            assert.deepEqual(denied.json(), { error: 'File not found.' });
            await db.pool.query('UPDATE artifacts SET owner_id=$2 WHERE id=$1', [
              webFile.id,
              ownerId,
            ]);
            if (mode === 'adapter fixture') assert.deepEqual(downloadCalls, [webId, telegramId]);
            else {
              assert.equal(fixture.authenticatedDownloads(), 2);
              assert.equal(fixture.unauthenticatedDownloads(), 1);
            }
          } finally {
            await runtime.dispose();
            runtimes.delete(prompt);
          }
        });
      }
      await t.test(
        'four concurrent browser publications share their four transaction clients',
        async () => {
          const ids = await Promise.all(
            Array.from({ length: 4 }, (_, index) =>
              tasks.submitTask(`Held concurrent browser publication ${index}`),
            ),
          );
          await waitFor(() => ids.every((id) => held.has(id)));
          const entered = new Set<string>();
          let resume!: () => void;
          const resumed = new Promise<void>((resolve) => {
            resume = resolve;
          });
          for (const id of ids)
            publicationStarts.set(id, { enter: () => entered.add(id), resume: resumed });
          const publishing = Promise.allSettled(
            ids.map((id) =>
              held.get(id)!.publishBrowserFile!({
                bytes: browserDownloadPdf,
                name: 'invoice.pdf',
                mimeType: 'application/pdf',
              }),
            ),
          );
          try {
            await waitFor(() => entered.size === 4);
            assert.equal(db.pool.totalCount, 4);
            assert.equal(db.pool.idleCount, 0);
            resume();
            const results = await publishing;
            assert.deepEqual(
              results.map((result) => result.status),
              Array(4).fill('fulfilled'),
            );
            for (const [index, result] of results.entries()) {
              assert.equal(result.status, 'fulfilled');
              const messages = (
                await db.pool.query(
                  "SELECT attachments FROM messages WHERE task_id=$1 AND owner_id=$2 AND role='assistant'",
                  [ids[index], ownerId],
                )
              ).rows;
              assert.deepEqual(
                messages.map((message) => message.attachments),
                [[result.value]],
              );
              assert.deepEqual(
                await localArtifacts.readArtifact(result.value.id),
                browserDownloadPdf,
              );
            }
          } finally {
            resume();
            await publishing;
            for (const id of ids) {
              publicationStarts.delete(id);
              release.get(id)!();
            }
          }
        },
      );
      await t.test(
        'cancelled and obsolete task callbacks cannot publish captured bytes',
        async () => {
          for (const kind of ['cancelled', 'obsolete'] as const) {
            const id = await tasks.submitTask(`Held ${kind} browser publication`);
            await waitFor(() => held.has(id));
            const context = held.get(id)!;
            assert.ok(context.publishBrowserFile);
            if (kind === 'cancelled') await tasks.cancelTask(id);
            else {
              await db.pool.query('UPDATE tasks SET revision=revision+1 WHERE id=$1', [id]);
              assert.equal(context.signal.aborted, false);
            }
            await assert.rejects(
              context.publishBrowserFile({
                bytes: browserDownloadPdf,
                name: 'invoice.pdf',
                mimeType: 'application/pdf',
              }),
              { statusCode: 409 },
            );
            assert.equal(
              (await db.pool.query('SELECT id FROM artifacts WHERE task_id=$1', [id])).rowCount,
              0,
            );
            assert.equal(
              (
                await db.pool.query(
                  "SELECT id FROM messages WHERE task_id=$1 AND role='assistant'",
                  [id],
                )
              ).rowCount,
              0,
            );
            release.get(id)!();
          }
        },
      );
      await t.test(
        'failed message insertion rolls back metadata without deleting retained bytes',
        async () => {
          const id = await tasks.submitTask('Held rejected browser publication');
          await waitFor(() => held.has(id));
          let artifact: Artifact | undefined;
          publications.set(id, {
            stored: (file) => {
              artifact = file;
            },
            resume: Promise.resolve(),
          });
          await db.pool.query(
            `ALTER TABLE messages ADD CONSTRAINT reject_browser_publication CHECK (role<>'assistant' OR task_id IS DISTINCT FROM '${id}'::uuid)`,
          );
          try {
            await assert.rejects(
              held.get(id)!.publishBrowserFile!({
                bytes: browserDownloadPdf,
                name: 'invoice.pdf',
                mimeType: 'application/pdf',
              }),
              { code: '23514' },
            );
            assert.ok(artifact);
            assert.equal(
              (await db.pool.query('SELECT id FROM artifacts WHERE task_id=$1', [id])).rowCount,
              0,
            );
            assert.equal(
              (
                await db.pool.query(
                  "SELECT id FROM messages WHERE task_id=$1 AND role='assistant'",
                  [id],
                )
              ).rowCount,
              0,
            );
            await assert.rejects(localArtifacts.readArtifact(artifact.id), /unavailable/);
            assert.deepEqual(
              await readFile(join(dataRoot, 'artifacts', artifact.id)),
              browserDownloadPdf,
            );
          } finally {
            await db.pool.query('ALTER TABLE messages DROP CONSTRAINT reject_browser_publication');
            publications.delete(id);
            release.get(id)!();
          }
        },
      );
      await t.test(
        'committed attachment bytes survive a failed refresh acknowledgement',
        async () => {
          const id = await tasks.submitTask('Held committed browser publication');
          await waitFor(() => held.has(id));
          const { events } = await import('../src/server/events.ts');
          const failure = new Error('Synthetic refresh acknowledgement failure.');
          const rejectRefresh = () => {
            throw failure;
          };
          events.once('event', rejectRefresh);
          try {
            await assert.rejects(
              held.get(id)!.publishBrowserFile!({
                bytes: browserDownloadPdf,
                name: 'invoice.pdf',
                mimeType: 'application/pdf',
              }),
              failure,
            );
            const rows = (
              await db.pool.query(
                "SELECT a.id FROM artifacts a JOIN messages m ON m.task_id=a.task_id AND m.attachments @> jsonb_build_array(jsonb_build_object('id',a.id)) WHERE a.task_id=$1 AND a.owner_id=$2 AND m.owner_id=$2 AND m.role='assistant'",
                [id, ownerId],
              )
            ).rows;
            assert.equal(rows.length, 1);
            assert.deepEqual(await localArtifacts.readArtifact(rows[0].id), browserDownloadPdf);
          } finally {
            events.off('event', rejectRefresh);
            release.get(id)!();
          }
        },
      );
      await t.test(
        'publication keeps its message when cancellation or reset waits on stored bytes',
        async () => {
          for (const action of ['cancel', 'reset'] as const) {
            const id = await tasks.submitTask(`Held ${action} during browser publication`);
            await waitFor(() => held.has(id));
            let markStored!: (artifact: Artifact) => void;
            const stored = new Promise<Artifact>((resolve) => {
              markStored = resolve;
            });
            let resume!: () => void;
            const resumed = new Promise<void>((resolve) => {
              resume = resolve;
            });
            publications.set(id, { stored: markStored, resume: resumed });
            const publishing = held.get(id)!.publishBrowserFile!({
              bytes: browserDownloadPdf,
              name: 'invoice.pdf',
              mimeType: 'application/pdf',
            }).then(
              (artifact) => ({ artifact }),
              (error: unknown) => ({ error }),
            );
            const artifact = await stored;
            const cancelling =
              action === 'cancel' ? tasks.cancelTask(id) : tasks.resetConversation();
            try {
              assert.equal(
                (await admin.query(`SELECT id FROM ${schema}.artifacts WHERE id=$1`, [artifact.id]))
                  .rowCount,
                0,
              );
              await waitFor(async () => {
                const blocked = await admin.query(
                  "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'UPDATE tasks SET status=''cancelled''%'",
                  [schema],
                );
                return blocked.rowCount === 1;
              });
              resume();
              const result = await publishing;
              await cancelling;
              assert.deepEqual(result, { artifact });
              const messages = (
                await db.pool.query(
                  "SELECT attachments FROM messages WHERE task_id=$1 AND owner_id=$2 AND role='assistant'",
                  [id, ownerId],
                )
              ).rows;
              assert.deepEqual(
                messages.map((message) => message.attachments),
                [[artifact]],
              );
              assert.equal(
                (await db.pool.query('SELECT status FROM tasks WHERE id=$1', [id])).rows[0].status,
                'cancelled',
              );
              assert.deepEqual(await localArtifacts.readArtifact(artifact.id), browserDownloadPdf);
            } finally {
              resume();
              await publishing;
              await cancelling;
              publications.delete(id);
              release.get(id)!();
            }
          }
        },
      );
    } finally {
      for (const finish of release.values()) finish();
    }
  },
);
