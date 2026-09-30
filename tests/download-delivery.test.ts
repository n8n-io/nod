import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    const threads = await import('../src/server/thread.ts');
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
    let stagingCompletion: Promise<unknown> | undefined;
    cleanup.push(async () => {
      const results = await Promise.allSettled(
        [...runtimes.values()].map((runtime) => runtime.dispose()),
      );
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    });
    cleanup.push(() => threads.stopThreadWorkers());
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
      assert.fail('The synthetic turn did not reach its expected boundary.');
    };
    const succeeded = (id: string) =>
      waitFor(async () => {
        const row = (await db.pool.query('SELECT status FROM turns WHERE id=$1', [id])).rows[0];
        assert.notEqual(row?.status, 'failed', 'The synthetic download turn failed.');
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
      await threads.initializeThreads();
      await createPersonalService({
        pool: db.pool,
        ownerId,
        scheduler: threads.boss,
        enqueueTurn: threads.enqueueTurn,
        refresh() {},
      }).initialize({ workers: false });
      channels = await createChannels(db.pool, {
        ownerId,
        transport: createChatSdkTransport(db.pool, telegram),
        resolveAttachments: localArtifacts.readThreadArtifacts,
        subscribe: () => () => {},
        intervalMs: 600_000,
        submit: async (text, sourceId, client, channel, messageId) =>
          (
            await threads.submitUserMessage(text, [], {
              sourceId,
              client,
              channel,
              clientMessageId: messageId,
            })
          ).turnId,
      });
      cleanup.push(() => channels!.close());
      channels.registerRoutes(app);
      await threads.startThreadWorkers({
        writeArtifact: async (threadId, path, bytes, signal) => {
          await stagingCompletion;
          signal?.throwIfAborted();
          await writeFile(join(dataRoot, 'workspaces', threadId, path), bytes);
        },
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
        runTurn: async (context) => {
          if (context.prompt.startsWith('Held ')) {
            held.set(context.turnId, context);
            await new Promise<void>((resolve) => release.set(context.turnId, resolve));
            return { status: 'succeeded' } satisfies RuntimeResult;
          }
          const runtime = runtimes.get(context.prompt);
          assert.ok(runtime, 'A turn must use its assigned synthetic runtime.');
          return runtime.runTurn(context);
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
                  act: async (threadId, input) => {
                    assert.deepEqual(input, { action: 'open', url: `${fixture.origin}/session` });
                    active.add(threadId);
                    return {
                      text: 'Synthetic invoices',
                      url: `${fixture.origin}/session`,
                      candidates: [],
                    };
                  },
                  download: async (threadId, input, signal) => {
                    assert.ok(active.has(threadId));
                    signal?.throwIfAborted();
                    assert.deepEqual(input, {
                      selector: '#download',
                      url: undefined,
                      name: 'invoice.pdf',
                    });
                    downloadCalls.push(threadId);
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
                  .get('browser')!
                  .execute({ action: 'download', selector: '#download', name: 'invoice.pdf' });
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
                  'workspaceFile',
                ]);
                assert.equal(artifact.mimeType, 'application/pdf');
                assert.equal(artifact.name, 'invoice.pdf');
                assert.equal(artifact.size, browserDownloadPdf.length);
                captured.set(input.turnId, artifact);
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
                exec: forbidden,
              }),
            }),
          });
          const prompt = `Download the synthetic invoice using ${mode}.`;
          runtimes.set(prompt, runtime);
          try {
            const web = await threads.submitUserMessage(prompt);
            const webId = web.turnId;
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
              await db.pool.query('SELECT turn_id FROM channel_inbox WHERE text=$1', [prompt])
            ).rows;
            assert.equal(inbox.length, 1);
            const telegramId = inbox[0].turn_id as string;
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
                'SELECT o.state,m.owner_id,m.thread_id,m.attachments FROM channel_outbox o JOIN messages m ON m.id=o.message_id WHERE m.turn_id=$1',
                [telegramId],
              )
            ).rows;
            assert.equal(deliveries.length, 1);
            assert.equal(deliveries[0].state, 'sent');
            assert.equal(deliveries[0].owner_id, ownerId);
            assert.equal(deliveries[0].thread_id, web.threadId);
            assert.equal(deliveries[0].attachments[0].id, telegramFile.id);
            const state = (
              await app.inject({ method: 'GET', url: '/api/state', headers })
            ).json<AppState>();
            const history = (
              await app.inject({ method: 'GET', url: '/api/messages', headers })
            ).json<MessageHistoryPage>().messages;
            assert.equal(state.threadId, web.threadId);
            for (const messages of [state.messages, history])
              for (const file of [webFile, telegramFile])
                assert.equal(
                  messages
                    .flatMap((message) => message.attachments)
                    .some((attachment) => attachment.id === file.id),
                  true,
                );
            const foreign = createArtifactService({
              database: db.pool,
              ownerId: 'foreign-owner',
              localRoot: dataRoot,
            });
            await assert.rejects(foreign.readArtifact(webFile.id), /unavailable/);
            await assert.rejects(
              localArtifacts.readThreadArtifacts(randomUUID(), [webFile.id]),
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
            if (mode === 'adapter fixture')
              assert.deepEqual(downloadCalls, [web.threadId, web.threadId]);
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
      const submitHeld = async (text: string) => {
        const submitted = await threads.submitUserMessage(text);
        await waitFor(() => held.has(submitted.turnId));
        return submitted;
      };
      const pdfFile = () => ({
        bytes: browserDownloadPdf,
        name: 'invoice.pdf',
        mimeType: 'application/pdf',
      });
      await t.test(
        'cancelled and obsolete turn callbacks cannot publish captured bytes',
        async () => {
          for (const kind of ['cancelled', 'obsolete'] as const) {
            const { threadId, turnId } = await submitHeld(`Held ${kind} browser publication`);
            const context = held.get(turnId)!;
            assert.ok(context.publishBrowserFile);
            const artifactCount = async () =>
              (await db.pool.query('SELECT id FROM artifacts WHERE thread_id=$1', [threadId]))
                .rowCount;
            const before = await artifactCount();
            if (kind === 'cancelled') await threads.stopThread();
            else {
              await db.pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [threadId]);
              assert.equal(context.signal.aborted, false);
            }
            await assert.rejects(context.publishBrowserFile(pdfFile()), { statusCode: 409 });
            assert.equal(await artifactCount(), before);
            assert.equal(
              (
                await db.pool.query(
                  "SELECT id FROM messages WHERE turn_id=$1 AND role='assistant'",
                  [turnId],
                )
              ).rowCount,
              0,
            );
            release.get(turnId)!();
          }
        },
      );
      await t.test(
        'failed message insertion rolls back metadata without deleting retained bytes',
        async () => {
          const { threadId, turnId } = await submitHeld('Held rejected browser publication');
          let artifact: Artifact | undefined;
          publications.set(threadId, {
            stored: (file) => {
              artifact = file;
            },
            resume: Promise.resolve(),
          });
          await db.pool.query(
            `ALTER TABLE messages ADD CONSTRAINT reject_browser_publication CHECK (role<>'assistant' OR turn_id IS DISTINCT FROM '${turnId}'::uuid)`,
          );
          try {
            await assert.rejects(held.get(turnId)!.publishBrowserFile!(pdfFile()), {
              code: '23514',
            });
            assert.ok(artifact);
            assert.equal(
              (await db.pool.query('SELECT id FROM artifacts WHERE id=$1', [artifact.id])).rowCount,
              0,
            );
            assert.equal(
              (
                await db.pool.query(
                  "SELECT id FROM messages WHERE turn_id=$1 AND role='assistant'",
                  [turnId],
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
            publications.delete(threadId);
            release.get(turnId)!();
          }
        },
      );
      await t.test(
        'publication keeps its message when stop or reset waits on stored bytes',
        async () => {
          for (const action of ['stop', 'reset'] as const) {
            const { threadId, turnId } = await submitHeld(
              `Held ${action} during browser publication`,
            );
            let markStored!: (artifact: Artifact) => void;
            const stored = new Promise<Artifact>((resolve) => {
              markStored = resolve;
            });
            let resume!: () => void;
            const resumed = new Promise<void>((resolve) => {
              resume = resolve;
            });
            publications.set(threadId, { stored: markStored, resume: resumed });
            const publishing = held.get(turnId)!.publishBrowserFile!(pdfFile()).then(
              (artifact) => ({ artifact }),
              (error: unknown) => ({ error }),
            );
            const artifact = await stored;
            const cancelling = action === 'stop' ? threads.stopThread() : threads.resetThread();
            stagingCompletion = cancelling;
            try {
              assert.equal(
                (await admin.query(`SELECT id FROM ${schema}.artifacts WHERE id=$1`, [artifact.id]))
                  .rowCount,
                0,
              );
              await waitFor(async () => {
                const blocked = await admin.query(
                  "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'UPDATE turns SET status=''cancelled''%'",
                  [schema],
                );
                return blocked.rowCount === 1;
              });
              resume();
              const result = await publishing;
              await cancelling;
              assert.deepEqual(result, {
                artifact: { ...artifact, workspaceFile: `${artifact.id}-invoice.pdf` },
              });
              const messages = (
                await db.pool.query(
                  "SELECT attachments FROM messages WHERE turn_id=$1 AND owner_id=$2 AND role='assistant'",
                  [turnId, ownerId],
                )
              ).rows;
              assert.deepEqual(
                messages.map((message) => message.attachments),
                [[artifact]],
              );
              assert.equal(
                (await db.pool.query('SELECT status FROM turns WHERE id=$1', [turnId])).rows[0]
                  .status,
                'cancelled',
              );
              assert.deepEqual(await localArtifacts.readArtifact(artifact.id), browserDownloadPdf);
              assert.deepEqual(
                await readFile(
                  join(dataRoot, 'workspaces', threadId, `${artifact.id}-invoice.pdf`),
                ),
                browserDownloadPdf,
              );
            } finally {
              resume();
              await publishing;
              await cancelling;
              stagingCompletion = undefined;
              publications.delete(threadId);
              release.get(turnId)!();
            }
          }
        },
      );
    } finally {
      for (const finish of release.values()) finish();
    }
  },
);
