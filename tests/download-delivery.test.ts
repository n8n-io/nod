import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { accessCookie, accessKey } from '../src/server/access.ts';

const native = process.env.NOD_TEST_NATIVE_DOWNLOAD === 'true';
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
    if (native) assert.ok(process.env.NOD_TEST_BROWSER_EXECUTABLE, 'A native browser is required.');
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
    const dataRoot = await mkdtemp(join(tmpdir(), 'nod-browser-delivery-'));
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
    process.env.NOD_DATA_ROOT = dataRoot;
    const db = await import('../src/server/db.ts');
    cleanup.push(() => db.pool.end());
    const threads = await import('../src/server/thread.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const { createArtifactService, localArtifacts } = await import('../src/server/artifacts.ts');
    const { transaction } = await import('../src/server/transaction.ts');
    cleanup.push(() => localArtifacts.close());
    const { ownerId, port } = await import('../src/server/config.ts');
    const app = await createApp();
    cleanup.push(() => app.close());
    const headers = {
      host: `localhost:${port}`,
      cookie: `${accessCookie(port)}=${await accessKey(dataRoot)}`,
    };
    const sent: Array<{ chat: string; name: string; mimeType: string; bytes: Buffer }> = [];
    const fetchLocal = globalThis.fetch.bind(globalThis);
    const captured = new Map<string, Artifact>();
    const publicationPaths = new Map<string, string>();
    const held = new Map<string, RuntimeContext>();
    const release = new Map<string, () => void>();
    const runtimes = new Map<string, ReturnType<typeof createAgentRuntime>>();
    const publications = new Map<
      string,
      { stored: (artifact: Artifact) => void; resume: Promise<void> }
    >();
    let completedTurns = 0;
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
      await t.test(
        'publication and upload retention reuse a one-connection caller transaction',
        async () => {
          const pool = new pg.Pool({
            connectionString: database.href,
            max: 1,
            connectionTimeoutMillis: 500,
          });
          const artifacts = createArtifactService({ database: pool, ownerId, localRoot: dataRoot });
          const threadId = (await threads.activeThread()).id;
          const upload = await artifacts.storeUpload(
            Buffer.from('pending fixture'),
            'pending.txt',
            'text/plain',
          );
          const expiry = (
            await pool.query('SELECT expires_at FROM artifacts WHERE id=$1', [upload.id])
          ).rows[0].expires_at;
          const rolledBack = new Error('Synthetic publication rollback');
          let removeRolledBack: (() => Promise<void>) | undefined;
          let rolledBackPath = '';
          try {
            await assert.rejects(
              transaction(async (client) => {
                const stored = await artifacts.storeArtifact(
                  browserDownloadPdf,
                  'channel.pdf',
                  'application/pdf',
                  threadId,
                  client,
                  (remove) => {
                    removeRolledBack = remove;
                  },
                );
                const published = await artifacts.publishArtifact(
                  threadId,
                  'invoice.pdf',
                  undefined,
                  async () => browserDownloadPdf,
                  client,
                );
                await artifacts.retainArtifacts([upload.id, upload.id], client);
                const rows = (
                  await client.query(
                    'SELECT id,storage_path,expires_at FROM artifacts WHERE id=ANY($1::uuid[])',
                    [[stored.id, published.id, upload.id]],
                  )
                ).rows;
                assert.equal(rows.length, 3);
                for (const row of rows) assert.equal(row.expires_at, null);
                rolledBackPath = rows.find((row) => row.id === stored.id).storage_path;
                assert.equal(
                  (
                    await db.pool.query('SELECT id FROM artifacts WHERE id=ANY($1::uuid[])', [
                      [stored.id, published.id],
                    ])
                  ).rowCount,
                  0,
                );
                throw rolledBack;
              }, pool),
              (error) => error === rolledBack,
            );
            assert.deepEqual(
              (await pool.query('SELECT expires_at FROM artifacts WHERE id=$1', [upload.id]))
                .rows[0].expires_at,
              expiry,
            );
            assert.deepEqual(await readFile(rolledBackPath), browserDownloadPdf);
            assert.ok(removeRolledBack);
            await removeRolledBack();
            await assert.rejects(readFile(rolledBackPath), { code: 'ENOENT' });
            const published = await transaction(async (client) => {
              const artifact = await artifacts.publishArtifact(
                threadId,
                'invoice.pdf',
                undefined,
                async () => browserDownloadPdf,
                client,
              );
              await artifacts.retainArtifacts([upload.id], client);
              return artifact;
            }, pool);
            await artifacts.sweep();
            assert.deepEqual(await artifacts.readArtifact(published.id), browserDownloadPdf);
            assert.equal((await artifacts.readArtifact(upload.id)).toString(), 'pending fixture');
            assert.equal(
              (await pool.query('SELECT expires_at FROM artifacts WHERE id=$1', [upload.id]))
                .rows[0].expires_at,
              null,
            );
          } finally {
            await artifacts.close();
            await pool.end();
          }
        },
      );
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
        analytics: ({ event }) => {
          if (event === 'turn_completed') completedTurns += 1;
        },
        browserStep: async () => 'run',
        readArtifact: async (threadId, path) =>
          readFile(join(dataRoot, 'workspaces', threadId, path)),
        writeArtifact: async (threadId, path, bytes, signal) => {
          await stagingCompletion;
          signal?.throwIfAborted();
          await writeFile(join(dataRoot, 'workspaces', threadId, path), bytes);
        },
        artifacts: {
          ...localArtifacts,
          async publishArtifact(...args) {
            const artifact = await localArtifacts.publishArtifact(...args);
            const row = (
              await args[4]!.query('SELECT storage_path FROM artifacts WHERE id=$1', [artifact.id])
            ).rows[0];
            publicationPaths.set(artifact.name, row.storage_path);
            return artifact;
          },
          async storeArtifact(...args) {
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
      await t.test('authenticated native Chromium', { skip: !native }, async (test) => {
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
        const computer = createAgentBrowserComputer({
          dataRoot: join(dataRoot, 'browser'),
          browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
          privateNetwork: true,
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
              const artifact = JSON.parse(
                content.text.slice(content.text.indexOf('{'), content.text.lastIndexOf('}') + 1),
              ) as Artifact;
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
        const prompt = 'Download the synthetic invoice.';
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
          assert.equal(response.headers['content-security-policy'], "default-src 'none'; sandbox");
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
          await assert.rejects(foreign.readArtifact(webFile.id), /unavailable/);
          const denied = await app.inject({ method: 'GET', url: webFile.url, headers });
          assert.equal(denied.statusCode, 404);
          await db.pool.query('UPDATE artifacts SET owner_id=$2 WHERE id=$1', [
            webFile.id,
            ownerId,
          ]);
          assert.equal(fixture.authenticatedDownloads(), 2);
          assert.equal(fixture.unauthenticatedDownloads(), 1);
        } finally {
          await runtime.dispose();
          runtimes.delete(prompt);
        }
      });
      const submitHeld = async (text: string) => {
        const submitted = await threads.submitUserMessage(text);
        await waitFor(() => held.has(submitted.turnId));
        return submitted;
      };
      await t.test(
        'workspace file references deliver owned bytes without share_file',
        async (test) => {
          const { turnId } = await submitHeld('Held workspace file references');
          const context = held.get(turnId)!;
          test.after(() => release.get(turnId)!());
          const root = `/workspace/${context.threadId}`;
          const calendar = Buffer.from('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n');
          const notes = Buffer.from('Synthetic map links');
          const local = join(dataRoot, 'workspaces', context.threadId);
          await writeFile(join(local, 'calendar.ics'), calendar);
          await writeFile(join(local, 'map links 100%.txt'), notes);
          await writeFile(join(local, 'private.txt'), 'Private working file');
          await context.reply(
            `Your files:\n- \`${root}/calendar.ics\`\n- [Map links](sandbox:${root}/map%20links%20100%.txt)\n\n` +
              `Example only:\n\`\`\`text\n${root}/private.txt\n\`\`\``,
          );
          const messages = (
            await db.pool.query("SELECT * FROM messages WHERE turn_id=$1 AND role='assistant'", [
              turnId,
            ])
          ).rows;
          assert.equal(messages.length, 1);
          const files = messages[0].attachments as Artifact[];
          assert.deepEqual(
            files.map((file) => file.name),
            ['calendar.ics', 'map links 100%.txt'],
          );
          for (const [index, bytes] of [calendar, notes].entries()) {
            const response = await app.inject({ method: 'GET', url: files[index].url, headers });
            assert.equal(response.statusCode, 200);
            assert.deepEqual(response.rawPayload, bytes);
            assert.ok(messages[0].text.includes(files[index].url));
          }
          await assert.rejects(context.reply(`Missing: \`${root}/missing.txt\``));
          await writeFile(join(local, 'uncommitted.txt'), 'Uncommitted output');
          await assert.rejects(
            context.reply(`\`${root}/uncommitted.txt\` and \`${root}/missing.txt\``),
          );
          assert.equal(
            (
              await db.pool.query(
                "SELECT id FROM artifacts WHERE thread_id=$1 AND name='uncommitted.txt'",
                [context.threadId],
              )
            ).rowCount,
            0,
          );
          await assert.rejects(readFile(publicationPaths.get('uncommitted.txt')!), {
            code: 'ENOENT',
          });
          await assert.rejects(
            context.reply(`\`${root}/uncommitted.txt\``, undefined, randomUUID()),
          );
          await assert.rejects(readFile(publicationPaths.get('uncommitted.txt')!), {
            code: 'ENOENT',
          });
          const foreign = randomUUID();
          await mkdir(join(dataRoot, 'workspaces', foreign));
          await writeFile(
            join(dataRoot, 'workspaces', foreign, 'private.txt'),
            'Foreign workspace',
          );
          await assert.rejects(context.reply(`Foreign: \`/workspace/${foreign}/private.txt\``));
          await writeFile(join(dataRoot, 'workspaces', 'private.txt'), 'Outside workspace');
          await assert.rejects(context.reply(`Escape: \`${root}/../private.txt\``));
          assert.equal(
            (
              await db.pool.query("SELECT id FROM messages WHERE turn_id=$1 AND role='assistant'", [
                turnId,
              ])
            ).rowCount,
            1,
          );
          const shared = await context.publish('calendar.ics');
          await context.reply(`Calendar again: \`${root}/calendar.ics\``);
          const again = (
            await db.pool.query(
              "SELECT attachments FROM messages WHERE turn_id=$1 AND role='assistant' ORDER BY created_at,id",
              [turnId],
            )
          ).rows;
          assert.deepEqual(
            again[1].attachments.map((file: Artifact) => file.id),
            [shared.id],
          );
          release.get(turnId)!();
          await succeeded(turnId);
          assert.equal(
            (
              await db.pool.query(
                "SELECT count(*)::int AS count FROM artifacts WHERE thread_id=$1 AND name='private.txt'",
                [context.threadId],
              )
            ).rows[0].count,
            0,
          );
          const stopped = await submitHeld('Held stopped file references');
          const late = held.get(stopped.turnId)!;
          await threads.stopThread();
          await assert.rejects(late.reply(`Late: \`${root}/private.txt\``));
          release.get(stopped.turnId)!();
          assert.equal(
            (
              await db.pool.query("SELECT id FROM messages WHERE turn_id=$1 AND role='assistant'", [
                stopped.turnId,
              ])
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'page screenshot tools stage owned images and refuse a missing screen',
        async () => {
          for (const available of [true, false]) {
            const prompt = `Capture the synthetic page ${available}`;
            let screenshotId: string | undefined;
            let captures = 0;
            const runtime = createAgentRuntime({
              computer: fakeComputer({
                screenshot: async () => {
                  captures++;
                  return available ? Buffer.from('synthetic page pixels') : null;
                },
                screenStatus: () => ({ state: 'live' }),
              }),
              workspace: fakeWorkspace(),
              agent: {
                open: async (input) => ({
                  resumed: false,
                  abort() {},
                  dispose() {},
                  prompt: async () => {
                    const tools = new Map(input.tools.map((tool) => [tool.name, tool]));
                    const capture = () =>
                      tools
                        .get('browser')!
                        .execute({ action: 'share_screenshot', name: 'page.png' });
                    if (!available) {
                      await assert.rejects(capture(), /available screenshot/);
                      return;
                    }
                    const result = await capture();
                    const content = result.content[0];
                    assert.equal(content.type, 'text');
                    if (content.type !== 'text') throw new Error('Expected a screenshot receipt.');
                    const receipt = JSON.parse(
                      content.text.slice(
                        content.text.indexOf('{'),
                        content.text.lastIndexOf('}') + 1,
                      ),
                    );
                    screenshotId = receipt.id;
                    assert.equal(receipt.source, 'browser_screenshot');
                    assert.equal(
                      (
                        await db.pool.query(
                          "SELECT id FROM messages WHERE turn_id=$1 AND role='assistant'",
                          [input.turnId],
                        )
                      ).rowCount,
                      0,
                    );
                    await tools.get('send_message')!.execute({
                      text: 'This is the sourced page screenshot.',
                      presentation: {
                        version: 1,
                        type: 'image',
                        title: 'Synthetic page',
                        sources: [],
                        artifactId: screenshotId,
                        alt: 'The synthetic page content.',
                      },
                    });
                  },
                }),
                dispose() {},
              },
            });
            runtimes.set(prompt, runtime);
            try {
              const turn = await threads.submitUserMessage(prompt);
              await succeeded(turn.turnId);
              assert.equal(captures, 1);
              const saved = (
                await db.pool.query(
                  "SELECT * FROM messages WHERE turn_id=$1 AND role='assistant'",
                  [turn.turnId],
                )
              ).rows;
              assert.equal(saved.length, available ? 1 : 0);
              if (available) {
                assert.equal(saved[0].presentation.artifactId, screenshotId);
                assert.deepEqual(
                  saved[0].attachments.map((item: Artifact) => [item.id, item.source]),
                  [[screenshotId, 'browser_screenshot']],
                );
                const pixels = await app.inject({
                  method: 'GET',
                  url: `/api/artifacts/${screenshotId}`,
                  headers,
                });
                assert.equal(pixels.statusCode, 200);
                assert.equal(pixels.body, 'synthetic page pixels');
                const history = (
                  await app.inject({ method: 'GET', url: '/api/messages', headers })
                ).json<MessageHistoryPage>().messages;
                assert.deepEqual(
                  history.find((message) => message.id === saved[0].id)?.presentation,
                  saved[0].presentation,
                );
              }
            } finally {
              await runtime.dispose();
              runtimes.delete(prompt);
            }
          }
        },
      );
      await t.test(
        'raster downloads and screenshots join one reply or flush once, while stop prevents delivery',
        async () => {
          for (const capture of ['download', 'screenshot'] as const)
            for (const mode of ['visual', 'alone', 'stopped'] as const) {
              const { turnId } = await submitHeld(`Held raster ${capture} ${mode}`);
              const context = held.get(turnId)!;
              const artifact =
                capture === 'screenshot'
                  ? await context.publishScreenshot!(
                      Buffer.from('synthetic raster fixture'),
                      'seat-plan.png',
                    )
                  : await context.publishBrowserFile!({
                      bytes: Buffer.from('synthetic raster fixture'),
                      name: 'seat-plan.png',
                      mimeType: 'image/png',
                    });
              const messages = async () =>
                (
                  await db.pool.query(
                    "SELECT attachments,presentation FROM messages WHERE turn_id=$1 AND role='assistant'",
                    [turnId],
                  )
                ).rows;
              assert.deepEqual(await messages(), []);
              if (mode === 'visual')
                await context.reply('The window seat is on the left.', undefined, undefined, {
                  version: 1,
                  type: 'image',
                  title: 'Seat plan',
                  sources: [],
                  artifactId: artifact.id,
                  alt: 'Synthetic cabin plan with a left window seat.',
                });
              if (mode === 'stopped') await threads.stopThread();
              const completedBeforeRelease = completedTurns;
              release.get(turnId)!();
              await waitFor(() => completedTurns > completedBeforeRelease);
              if (mode !== 'stopped') await succeeded(turnId);
              const saved = await messages();
              assert.equal(saved.length, mode === 'stopped' ? 0 : 1);
              if (mode !== 'stopped') {
                assert.deepEqual(
                  saved[0].attachments.map((item: Artifact) => item.id),
                  [artifact.id],
                );
                assert.equal(
                  saved[0].presentation?.artifactId ?? null,
                  mode === 'visual' ? artifact.id : null,
                );
                assert.equal(
                  saved[0].attachments[0].source,
                  capture === 'screenshot' ? 'browser_screenshot' : undefined,
                );
              }
            }
        },
      );
    } finally {
      for (const finish of release.values()) finish();
    }
  },
);
