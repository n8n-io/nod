import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { Agent, RuntimeContext } from '../src/ports/agent.ts';
import type { ConnectedApp } from '../src/ports/integrations.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { createPreferencesStore } from '../src/server/preferences.ts';
import type { ThreadDependencies } from '../src/server/thread.ts';
import type { SubmitMessageResponse } from '../src/shared/contracts.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';
import { createMemoryService } from '../src/server/memory.ts';
import { createFilesystemObjectStore } from '../src/providers/object-storage/filesystem.ts';

test(
  'one thread runs every turn in order on the same session and workspace',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 120_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_thread_${suffix}`;
    const bossSchema = `test_boss_${suffix}`;
    const root = await mkdtemp(join(tmpdir(), 'thread-test-'));
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const environment = {
      DATABASE_URL: process.env.DATABASE_URL,
      PGBOSS_SCHEMA: process.env.PGBOSS_SCHEMA,
      OTTO_DATA_ROOT: process.env.OTTO_DATA_ROOT,
    };
    t.after(() => {
      for (const [key, value] of Object.entries(environment))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });
    const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = databaseUrl.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    process.env.OTTO_DATA_ROOT = root;
    const db = await import('../src/server/db.ts');
    const thread = await import('../src/server/thread.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { registerBugReport } = await import('../src/server/bug-report.ts');
    const { createPromptInspector } = await import('../src/server/inspector-prompts.ts');
    const { configuration, dataRoot, ownerId, port } = await import('../src/server/config.ts');
    const { localArtifacts, storeArtifact } = await import('../src/server/artifacts.ts');
    const { createPersonalService } = await import('../src/server/personal.ts');
    const { createVault } = await import('../src/server/vault.ts');
    const { createApprovals } = await import('../src/server/approvals.ts');
    const { events } = await import('../src/server/events.ts');
    const { createAccountSession } = await import('../src/server/account.ts');
    const { createAccountStore } = await import('../src/server/account-store.ts');
    const { createTriage } = await import('../src/server/triage.ts');
    assert.equal(dataRoot, root);

    await db.initializeDatabase();
    await thread.initializeThreads();
    const personal = createPersonalService({
      pool: db.pool,
      ownerId,
      scheduler: thread.boss,
      enqueueTurn: thread.enqueueTurn,
      refresh() {},
    });
    await personal.initialize({ workers: false });
    const promptInspector = createPromptInspector(db.pool, {
      ownerId,
      enabled: () => true,
      provider: 'fixture',
      model: 'fixture',
    });
    await promptInspector.initialize(db.pool);
    let injected = 0;
    let executed = 0;
    const fixtureKey = randomBytes(32);
    const vault = await createVault(db.pool, {
      keyStore: { id: 'fixture', configured: true, getKey: async () => fixtureKey },
      inject: async () => {
        injected++;
      },
      resume: thread.resumeAfterCredentials,
      retry: thread.retryCredentials,
    });
    const approvals = await createApprovals(async () => {
      executed++;
      return {};
    });
    const accounts = createAccountStore(db.pool);
    await accounts.initialize();
    const userMessages = thread.createUserMessageService({ confirmAction: approvals.acceptChat });
    const app = await createApp({
      submitMessage: userMessages.submit,
      configuration: () => ({ ...configuration(), llmReady: true }),
      onboard: (_timeZone, threadId) => thread.restartOnboarding(threadId),
      startOnboarding: thread.startOnboarding,
    });
    let savedPiEntries: unknown[] = [];
    let reportedPiThread = '';
    registerBugReport(app, {
      pool: db.pool,
      ownerId,
      captureEnabled: () => true,
      sessionEntries: async (threadId) => {
        reportedPiThread = threadId;
        return savedPiEntries;
      },
    });
    personal.registerRoutes(app);
    vault.registerRoutes(app);
    createAccountSession({
      accounts,
      origin: `http://localhost:${port}`,
      localUser: { id: ownerId, name: 'You', email: null, avatarUrl: null },
      start: async (_owner, name) => {
        await thread.startOnboarding(name, ['Gmail']);
      },
    }).register(app);
    const headers = { host: `localhost:${port}`, origin: `http://localhost:${port}` };
    const request = (
      method: 'GET' | 'POST' | 'PUT' | 'PATCH',
      path: string,
      payload?: Record<string, unknown>,
    ) => app.inject({ method, url: path, headers, payload });

    const readOnlyRefusals: string[] = [];
    const agent: Agent = {
      open: async (input) => ({
        resumed: false,
        abort: () => {},
        dispose: () => {},
        prompt: async () => {
          const tools = new Map(input.tools.map((entry) => [entry.name, entry]));
          await tools.get('apps')!.execute({ action: 'GMAIL_FETCH_EMAILS', args: {} });
          assert.equal(tools.has('shell'), false);
          await input
            .runTool('bash', { command: 'curl https://example.test' }, async () => {
              throw new Error('The sandbox must not run during a read-only turn.');
            })
            .catch((error: Error) => readOnlyRefusals.push(error.message));
          await tools.get('send_message')!.execute({ text: 'Two threads wait for your reply.' });
        },
      }),
      dispose: () => {},
    };
    const readOnlyRuntime = createAgentRuntime({
      agent,
      computer: fakeComputer(),
      workspace: fakeWorkspace(),
    });
    const quietRuntime = createAgentRuntime({
      agent: {
        open: async (input) => ({
          resumed: false,
          abort() {},
          dispose() {},
          async prompt() {
            await input.tools
              .find((tool) => tool.name === 'apps')!
              .execute({
                action: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
                args: { message_id: 'synthetic-message' },
              });
            input.onEvent({ type: 'text_delta', text: 'Checking a synthetic update.' });
            input.onEvent({ type: 'final', text: 'No useful outcome to deliver.' });
          },
        }),
        dispose() {},
      },
      computer: fakeComputer(),
      workspace: fakeWorkspace(),
    });
    let quietBackgroundWork = false;
    let currentApps: ConnectedApp[] = [];
    let inventoryGate: Promise<void> | undefined;
    let inventoryWaiting = false;
    const readConnectedApps = async () => {
      if (inventoryGate) {
        inventoryWaiting = true;
        await inventoryGate;
      }
      return structuredClone(currentApps);
    };
    let activityLookup: ThreadDependencies['activityCheck'];
    let activityRun: ((context: RuntimeContext) => Promise<void>) | undefined;

    const runs: RuntimeContext[] = [];
    const taken = new Map<string, Array<{ id: string; text: string }>>();
    const gates = new Map<string, () => void>();
    const hold = (prompt: string) =>
      new Promise<void>((resolve) => {
        gates.set(prompt, resolve);
      });
    const waiting = new Map<string, Promise<void>>();
    const stagedReads = new Map<string, string>();
    const workspaceListings = new Map<string, string[]>();
    const abortedPrompts = new Set<string>();
    const remoteUploads = new Map<string, Uint8Array>();
    const fileContexts = new Map<string, RuntimeContext>();
    const integrationReads: boolean[] = [];
    const appResults = new Map<string, unknown>();
    const largeAppResult = {
      threads: Array.from({ length: 400 }, (_, index) => ({
        id: `synthetic-thread-${index}`,
        snippet: 'Synthetic inbox snippet. '.repeat(8),
      })),
    };
    let remoteAttachmentRead = false;
    let fenced: RuntimeContext | undefined;
    let releaseFence: () => void = () => {};
    const fenceGate = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    let failRelease = 0;

    const dependencies: ThreadDependencies = {
      connectedApps: readConnectedApps,
      activityCheck: async (turn) => activityLookup?.(turn),
      speech: {
        synthesize: async () => {
          throw new Error('Unused fixture');
        },
      },
      requestCredential: async () => {
        throw new Error('Unused fixture');
      },
      integration: async (_turn, action, _args, options) => {
        if (action === 'GMAIL_LIST_THREADS') return largeAppResult;
        integrationReads.push(options.readOnly);
        return { successful: true, data: { threads: 2 } };
      },
      manage: async () => {
        throw new Error('Unused fixture');
      },
      artifacts: {
        ...localArtifacts,
        storeArtifact: async (...input) => {
          const artifact = await localArtifacts.storeArtifact(...input);
          if (artifact.name === 'atomic.png') {
            void thread.stopThread();
            await delay(300);
          }
          return artifact;
        },
      },
      runTurn: async (context) => {
        runs.push(context);
        if (context.prompt === 'background-research-fixture') {
          const file = await context.publishBrowserFile!({
            bytes: Buffer.from('synthetic research'),
            name: 'research.txt',
            mimeType: 'text/plain',
          });
          await context.publishScreenshot!(Buffer.from('synthetic image'), 'research.png');
          await context.downloadIntegrationFile!('GMAIL_GET_ATTACHMENT', {});
          assert.equal(
            (await db.pool.query('SELECT id FROM messages WHERE turn_id=$1', [context.turnId]))
              .rowCount,
            0,
          );
          assert.equal(
            (await readFile(join(context.workspacePath, file.workspaceFile))).toString(),
            'synthetic research',
          );
          await context.publish(file.workspaceFile, 'finished.txt');
          return { status: 'succeeded' };
        }
        if (context.activityCheck) {
          await activityRun?.(context);
          return { status: 'succeeded' };
        }
        if (context.readOnly) return readOnlyRuntime.runTurn(context);
        if (quietBackgroundWork && context.background) return quietRuntime.runTurn(context);
        if (context.prompt === 'remote-attachment-fixture') {
          assert.equal(context.attachments.length, 1);
          assert.equal(
            Buffer.from(remoteUploads.get(context.threadId)!).toString(),
            'remote synthetic bytes',
          );
          await assert.rejects(readFile(context.attachments[0].path), { code: 'ENOENT' });
          remoteAttachmentRead = true;
          return { status: 'succeeded' };
        }
        if (context.prompt === 'cancel-fence-fixture') {
          fenced = context;
          await fenceGate;
          return { status: 'succeeded' };
        }
        if (context.prompt === 'pdf-source-fixture') {
          await context.publishBrowserFile!({
            bytes: Buffer.from('%PDF-1.4 synthetic statement'),
            name: 'statement.pdf',
            mimeType: 'application/pdf',
          });
          return { status: 'succeeded' };
        }
        if (context.prompt === 'large-app-result-fixture') {
          appResults.set(context.prompt, await context.integration('GMAIL_LIST_THREADS', {}));
          return { status: 'succeeded' };
        }
        if (context.prompt.endsWith('-file-fixture')) {
          fileContexts.set(context.prompt, context);
          return { status: 'succeeded' };
        }
        if (context.prompt === 'Hold old worker') {
          context.delta('Old stream', randomUUID());
          await new Promise<void>((resolve) =>
            context.signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          return { status: 'succeeded' };
        }
        if (context.prompt === 'Fresh conversation') {
          context.delta('Fresh stream', randomUUID());
          await context.reply('Fresh answer.');
          return { status: 'succeeded' };
        }
        const gate = waiting.get(context.prompt);
        if (gate) {
          await Promise.race([
            gate,
            new Promise<void>((resolve) =>
              context.signal.addEventListener('abort', () => resolve(), { once: true }),
            ),
          ]);
          if (context.signal.aborted) {
            abortedPrompts.add(context.prompt);
            throw new Error('Aborted fixture');
          }
        }
        if (context.prompt.startsWith('steer-')) {
          const messages = await context.takeMessages!();
          taken.set(context.turnId, messages);
          if (messages.length) await context.manage('provenance_fixture', {});
        }
        if (context.attachments.length)
          stagedReads.set(context.prompt, await readFile(context.attachments[0].path, 'utf8'));
        workspaceListings.set(context.prompt, await readdir(context.workspacePath));
        if (context.prompt === 'runtime-failure') throw new Error('Synthetic runtime failure');
        if (context.prompt === 'screenshot-during-stop') {
          await context.publishScreenshot!(new Uint8Array([1, 2, 3]), 'atomic.png');
          return { status: 'succeeded' };
        }
        if (context.prompt === 'release-retry') failRelease = 1;
        if (context.prompt === 'ask-question') {
          await context.waitForUser!('Which account should I use?');
          return { status: 'waiting_user' };
        }
        await context.reply(`done: ${context.prompt}`);
        return { status: 'succeeded' };
      },
    };

    const block = (prompt: string) => waiting.set(prompt, hold(prompt));
    const release = (prompt: string) => gates.get(prompt)?.();

    async function waitFor(predicate: () => Promise<boolean> | boolean, timeout = 15_000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await delay(20);
      }
      assert.fail('The thread fixture did not reach the expected state.');
    }
    const turnStatus = async (turnId: string) =>
      (await db.pool.query('SELECT status FROM turns WHERE id=$1', [turnId])).rows[0]?.status as
        string | undefined;
    const settled = (turnId: string) => async () =>
      ['succeeded', 'waiting', 'failed', 'cancelled'].includes((await turnStatus(turnId)) ?? '');
    const ran = (turnId: string) => runs.find((context) => context.turnId === turnId);
    const drainJobs = async (threadId: string) =>
      (
        await db.pool.query(`SELECT id FROM ${bossSchema}.job WHERE data->>'threadId'=$1`, [
          threadId,
        ])
      ).rowCount ?? 0;
    const sendJson = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/messages',
        headers: { ...headers, 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
    const counts = async () => ({
      turns: (await db.pool.query('SELECT count(*)::int AS count FROM turns')).rows[0].count,
      messages: (await db.pool.query('SELECT count(*)::int AS count FROM messages')).rows[0].count,
      jobs: (
        await db.pool.query(
          `SELECT count(*)::int AS count FROM ${bossSchema}.job WHERE name='thread-drain'`,
        )
      ).rows[0].count,
    });
    const deltas: Array<{ turnId?: string; threadId?: string }> = [];
    const onEvent = (event: { type: string; turnId?: string; threadId?: string }) => {
      if (event.type === 'delta') deltas.push(event);
    };
    events.on('event', onEvent);

    try {
      const threadId = (await thread.activeThread(db.pool)).id;
      let firstThreadId = '';
      const firstClientMessageId = randomUUID();

      await t.test('turn and drain job roll back together in the caller transaction', async () => {
        const jobsBefore = await drainJobs(threadId);
        let rolledBackTurn = '';
        await assert.rejects(
          db.transaction(async (client) => {
            rolledBackTurn = await thread.enqueueTurn('rollback-fixture', {
              source: 'schedule',
              sourceId: 'rollback-fixture',
              client,
            });
            throw new Error('Injected rollback');
          }),
          /Injected rollback/,
        );
        assert.equal(
          (await db.pool.query('SELECT id FROM turns WHERE id=$1', [rolledBackTurn])).rowCount,
          0,
        );
        assert.equal(await drainJobs(threadId), jobsBefore);
      });

      await t.test('parallel source dispatch creates one turn and one drain job', async () => {
        const jobsBefore = await drainJobs(threadId);
        const ids = await Promise.all(
          Array.from({ length: 6 }, () =>
            thread.enqueueTurn('schedule-fixture', {
              sourceId: 'schedule:one-job',
              source: 'schedule',
            }),
          ),
        );
        assert.equal(new Set(ids).size, 1);
        assert.equal(
          (await db.pool.query('SELECT thread_id FROM turns WHERE id=$1', [ids[0]])).rows[0]
            .thread_id,
          threadId,
        );
        assert.equal(await drainJobs(threadId), jobsBefore + 1);
      });

      await t.test('credential resume and source-keyed messages are idempotent', async () => {
        const id = randomUUID();
        await db.pool.query(
          "INSERT INTO turns(id,owner_id,thread_id,source,prompt,channel,status,waiting_reason,finished_at) VALUES($1,'local-development',$2,'user','Resume fixture','telegram:fixture','waiting','credentials',now())",
          [id, threadId],
        );
        await Promise.all([
          thread.resumeAfterCredentials(id),
          thread.resumeAfterCredentials(id),
          thread.resumeAfterCredentials(id),
        ]);
        const resumed = await db.pool.query(
          'SELECT source,channel,background,thread_id FROM turns WHERE source_id=$1',
          [`credentials:${id}`],
        );
        assert.equal(resumed.rowCount, 1);
        assert.deepEqual(resumed.rows[0], {
          source: 'resume',
          channel: 'telegram:fixture',
          background: false,
          thread_id: threadId,
        });
        const results = await Promise.all(
          Array.from({ length: 3 }, () =>
            thread.submitUserMessage('Approved fixture result', [], {
              sourceId: 'approval:fixture',
            }),
          ),
        );
        assert.equal(new Set(results.map((result) => result.turnId)).size, 1);
        assert.equal(new Set(results.map((result) => result.messageId)).size, 1);
        assert.equal(
          (
            await db.pool.query(
              "SELECT id FROM messages WHERE role='user' AND text='Approved fixture result'",
            )
          ).rowCount,
          1,
        );
      });

      await t.test(
        'client message IDs dedupe concurrent sends and reject changed payloads',
        async () => {
          const before = await counts();
          const payload = {
            clientMessageId: firstClientMessageId,
            text: '  Prepare the synthetic report  ',
          };
          const responses = await Promise.all([sendJson(payload), sendJson(payload)]);
          for (const response of responses) assert.equal(response.statusCode, 200, response.body);
          const first = responses[0]!.json<SubmitMessageResponse>();
          assert.deepEqual(responses[1]!.json(), first);
          assert.equal(first.messageId, firstClientMessageId);
          const oneMore = {
            turns: before.turns + 1,
            messages: before.messages + 1,
            jobs: before.jobs + 1,
          };
          assert.deepEqual(await counts(), oneMore);
          assert.deepEqual((await sendJson(payload)).json(), first);
          assert.equal(
            (await sendJson({ ...payload, text: 'A changed instruction' })).statusCode,
            409,
          );
          assert.equal(
            (await sendJson({ ...payload, replyToMessageId: randomUUID() })).statusCode,
            409,
          );
          assert.deepEqual(await counts(), oneMore);
        },
      );

      await t.test('foreign and assistant message IDs cannot be reused', async () => {
        const foreignThread = randomUUID(),
          foreignId = randomUUID(),
          assistantId = randomUUID();
        await db.pool.query("INSERT INTO threads(id,owner_id) VALUES($1,'another-owner')", [
          foreignThread,
        ]);
        await db.pool.query(
          "INSERT INTO messages(id,owner_id,role,text,thread_id) VALUES($1,'another-owner','user','Same synthetic text',$2),($3,'local-development','assistant','Same synthetic text',$4)",
          [foreignId, foreignThread, assistantId, threadId],
        );
        const before = await counts();
        for (const id of [foreignId, assistantId])
          assert.equal(
            (await sendJson({ clientMessageId: id, text: 'Same synthetic text' })).statusCode,
            409,
          );
        assert.deepEqual(await counts(), before);
      });

      await t.test(
        'worker start interrupts running turns once without retrying them and drains queued turns',
        async () => {
          const missingJob = await thread.enqueueTurn('recovery-fixture', {
            source: 'schedule',
            sourceId: 'recovery-fixture',
          });
          await db.pool.query(`DELETE FROM ${bossSchema}.job WHERE data->>'threadId'=$1`, [
            threadId,
          ]);
          const foreground = randomUUID();
          const background = randomUUID();
          const legacyControl = randomUUID();
          await db.pool.query(
            "INSERT INTO turns(id,owner_id,thread_id,source,prompt,status,background,started_at) VALUES($1,'local-development',$3,'user','Do not repeat','running',false,now()),($2,'local-development',$3,'schedule','Do not repeat quietly','running',true,now())",
            [foreground, background, threadId],
          );
          await db.pool.query(
            "INSERT INTO turns(id,owner_id,thread_id,source,source_id,prompt,status,background) VALUES($1,'local-development',$2,'resume',$3,'Old browser control','queued',false)",
            [legacyControl, threadId, `control:${foreground}`],
          );
          await db.pool.query("UPDATE threads SET status='manual_control' WHERE id=$1", [threadId]);
          await thread.startThreadWorkers(dependencies);
          await waitFor(async () => (await turnStatus(missingJob)) === 'succeeded');
          assert.equal(await turnStatus(legacyControl), 'cancelled');
          assert.equal(
            (
              await db.pool.query(
                "SELECT id FROM turns WHERE thread_id=$1 AND status IN ('queued','running')",
                [threadId],
              )
            ).rowCount,
            0,
          );
          for (const id of [foreground, background]) {
            assert.equal(await turnStatus(id), 'failed');
            assert.equal(Boolean(ran(id)), false);
          }
          const interruptedReplies = async (id: string) =>
            (
              await db.pool.query(
                "SELECT text,thread_id FROM messages WHERE turn_id=$1 AND role='assistant'",
                [id],
              )
            ).rows;
          assert.deepEqual(await interruptedReplies(foreground), [
            { text: thread.interruptedMessage, thread_id: threadId },
          ]);
          assert.deepEqual(await interruptedReplies(background), []);
          assert.equal(
            (
              await db.pool.query(
                "SELECT id FROM turns WHERE thread_id=$1 AND source='resume' AND id<>$3 AND created_at > (SELECT created_at FROM turns WHERE id=$2)",
                [threadId, foreground, legacyControl],
              )
            ).rowCount,
            0,
          );
        },
      );

      await t.test('consecutive messages run as turns on the same thread', async () => {
        const first = await thread.submitUserMessage('first message', [], { channel: 'web' });
        await waitFor(settled(first.turnId));
        const second = await thread.submitUserMessage('second message', [], {
          channel: 'web',
          threadId: first.threadId,
        });
        await waitFor(settled(second.turnId));
        assert.equal(second.threadId, first.threadId);
        assert.equal(await turnStatus(first.turnId), 'succeeded');
        assert.equal(await turnStatus(second.turnId), 'succeeded');
        assert.equal(ran(first.turnId)?.threadId, first.threadId);
        assert.equal(ran(second.turnId)?.threadId, first.threadId);
        assert.equal(ran(first.turnId)?.workspacePath, ran(second.turnId)?.workspacePath);
        assert.equal(ran(first.turnId)?.currentMessageId, first.messageId);
        assert.equal(ran(second.turnId)?.currentMessageId, second.messageId);
        assert.equal(
          (
            await db.pool.query(
              "SELECT count(*)::int AS count FROM threads WHERE owner_id='local-development'",
            )
          ).rows[0].count,
          1,
        );
        firstThreadId = first.threadId;
      });

      await t.test('turns retain owned manual and automatic region preferences', async () => {
        const preferences = createPreferencesStore(db.pool, ownerId);
        const otherOwner = `region-owner-${randomUUID()}`;
        const otherPreferences = createPreferencesStore(db.pool, otherOwner);
        const original = await preferences.get();
        try {
          await otherPreferences.update({ locale: 'en-CA', timeZone: 'America/Toronto' });
          await preferences.update({ locale: 'en-US', timeZone: 'Europe/Lisbon' });
          const manual = await thread.submitUserMessage('Manual region fixture');
          await waitFor(settled(manual.turnId));
          assert.equal(ran(manual.turnId)?.locale, 'en-US');

          await preferences.update({ locale: null });
          await preferences.update({ hourCycle: 'h23' });
          assert.equal((await preferences.get()).locale, null);
          assert.equal((await otherPreferences.get()).locale, 'en-CA');
          const automatic = await thread.submitUserMessage('Automatic region fixture');
          await waitFor(settled(automatic.turnId));
          assert.equal(ran(automatic.turnId)?.locale, 'en-PT');
          assert.equal(ran(automatic.turnId)?.timeZone, 'Europe/Lisbon');
          assert.equal(ran(automatic.turnId)?.hourCycle, 'h23');
        } finally {
          await preferences.update(original);
          await db.pool.query('DELETE FROM preferences WHERE owner_id=$1', [otherOwner]);
        }
      });

      await t.test(
        'messages sent during a running turn join it in order until one needs its own turn',
        async () => {
          const provenance: Array<string | null> = [];
          const manage = dependencies.manage;
          dependencies.manage = async (_turn, _action, _args, source) => {
            provenance.push(source.sourceMessageId);
            return {};
          };
          try {
            block('steer-first');
            const first = await thread.submitUserMessage('steer-first', [], { channel: 'web' });
            await waitFor(() => Boolean(ran(first.turnId)));
            const jobs = await drainJobs(first.threadId);
            const second = await thread.submitUserMessage('joined second', [], { channel: 'web' });
            const third = await thread.submitUserMessage('joined third', [], { channel: 'web' });
            const artifact = await storeArtifact(
              Buffer.from('synthetic later bytes'),
              'later.txt',
              'text/plain',
            );
            const fourth = await thread.submitUserMessage('attached fourth', [artifact], {
              channel: 'web',
            });
            const fifth = await thread.submitUserMessage('queued fifth', [], { channel: 'web' });
            assert.equal(await drainJobs(first.threadId), jobs);
            release('steer-first');
            await waitFor(settled(fifth.turnId));
            assert.deepEqual(taken.get(first.turnId), [
              { id: second.messageId, text: 'joined second' },
              { id: third.messageId, text: 'joined third' },
            ]);
            assert.deepEqual(provenance, [third.messageId]);
            const owners = (
              await db.pool.query('SELECT id,turn_id FROM messages WHERE id=ANY($1::uuid[])', [
                [second.messageId, third.messageId, fourth.messageId, fifth.messageId],
              ])
            ).rows;
            assert.deepEqual(Object.fromEntries(owners.map((row) => [row.id, row.turn_id])), {
              [second.messageId]: first.turnId,
              [third.messageId]: first.turnId,
              [fourth.messageId]: fourth.turnId,
              [fifth.messageId]: fifth.turnId,
            });
            assert.equal(ran(second.turnId), undefined);
            assert.equal(ran(third.turnId), undefined);
            const order = runs.map((context) => context.turnId);
            assert.ok(order.indexOf(first.turnId) < order.indexOf(fourth.turnId));
            assert.ok(order.indexOf(fourth.turnId) < order.indexOf(fifth.turnId));
            for (const turn of [first, second, third, fourth, fifth])
              assert.equal(await turnStatus(turn.turnId), 'succeeded');

            block('steer-other');
            const current = await thread.submitUserMessage('steer-other', [], { channel: 'web' });
            await waitFor(() => Boolean(ran(current.turnId)));
            const remote = await thread.submitUserMessage('remote message', [], {
              channel: 'telegram:fixture',
            });
            const later = await thread.submitUserMessage('later web message', [], {
              channel: 'web',
            });
            release('steer-other');
            await waitFor(settled(later.turnId));
            assert.deepEqual(taken.get(current.turnId), []);
            assert.equal(ran(remote.turnId)?.channel, 'telegram');
            assert.equal(ran(later.turnId)?.threadId, current.threadId);
          } finally {
            dependencies.manage = manage;
          }
        },
      );

      await t.test(
        'an uploaded attachment stays in the thread workspace for later turns',
        async () => {
          const artifact = await storeArtifact(
            Buffer.from('synthetic attachment bytes'),
            'notes.txt',
            'text/plain',
          );
          const first = await thread.submitUserMessage('read attachment', [artifact], {
            channel: 'web',
          });
          await waitFor(settled(first.turnId));
          const staged = `${artifact.id}-notes.txt`;
          const workspace = join(root, 'workspaces', first.threadId);
          assert.equal(ran(first.turnId)?.workspacePath, workspace);
          assert.equal(ran(first.turnId)?.attachments[0]?.path, join(workspace, staged));
          assert.equal(stagedReads.get('read attachment'), 'synthetic attachment bytes');
          const second = await thread.submitUserMessage('use attachment again', [], {
            channel: 'web',
          });
          await waitFor(settled(second.turnId));
          assert.equal(ran(second.turnId)?.workspacePath, workspace);
          assert.equal(ran(second.turnId)?.attachments.length, 0);
          assert.ok(workspaceListings.get('use attachment again')?.includes(staged));
          assert.equal(
            await readFile(join(workspace, staged), 'utf8'),
            'synthetic attachment bytes',
          );
        },
      );

      await t.test(
        'turn uploads reach the configured remote workspace and never the host',
        async () => {
          dependencies.writeArtifact = async (target, path, bytes, signal) => {
            assert.match(path, /^[a-f0-9-]{36}-remote.txt$/);
            assert.equal(signal?.aborted, false);
            remoteUploads.set(target, bytes);
          };
          try {
            const artifact = await storeArtifact(
              Buffer.from('remote synthetic bytes'),
              'remote.txt',
              'text/plain',
            );
            await thread.submitUserMessage('remote-attachment-fixture', [artifact]);
            await waitFor(() => remoteAttachmentRead);
          } finally {
            dependencies.writeArtifact = undefined;
          }
        },
      );

      await t.test(
        'a large app result is saved in the thread workspace and returned by reference',
        async () => {
          const { turnId, threadId: id } = await thread.submitUserMessage(
            'large-app-result-fixture',
          );
          await waitFor(settled(turnId));
          const full = JSON.stringify(largeAppResult);
          const result = appResults.get('large-app-result-fixture') as {
            workspaceFile: string;
            bytes: number;
            preview: string;
          };
          assert.match(result.workspaceFile, /^[a-f0-9-]{36}-GMAIL_LIST_THREADS\.json$/);
          assert.equal(result.bytes, Buffer.byteLength(full));
          assert.ok(result.preview.length < full.length && full.startsWith(result.preview));
          assert.equal(
            await readFile(join(root, 'workspaces', id, result.workspaceFile), 'utf8'),
            full,
          );
          dependencies.writeArtifact = async () => {
            throw new Error('Fixture workspace unavailable');
          };
          try {
            const unsaved = await thread.submitUserMessage('large-app-result-fixture');
            await waitFor(settled(unsaved.turnId));
          } finally {
            dependencies.writeArtifact = undefined;
          }
          const fallback = appResults.get('large-app-result-fixture') as Record<string, unknown>;
          assert.equal(fallback.workspaceFile, undefined);
          assert.equal(fallback.preview, result.preview);
        },
      );

      await t.test('replies stage owned downloaded files but never foreign artifacts', async () => {
        const { turnId: sourceTurn } = await thread.submitUserMessage('pdf-source-fixture');
        await waitFor(async () => (await turnStatus(sourceTurn)) === 'succeeded');
        const download = (
          await db.pool.query(
            "SELECT id,attachments FROM messages WHERE turn_id=$1 AND role='assistant' AND jsonb_array_length(attachments)=1",
            [sourceTurn],
          )
        ).rows[0];
        const pdf = download.attachments[0];
        const stagedName = `${pdf.id}-statement.pdf`;
        const foreignThread = randomUUID();
        const foreignArtifact = randomUUID();
        const foreignMessage = randomUUID();
        const foreignAttachments = JSON.stringify([
          {
            id: foreignArtifact,
            name: 'foreign.pdf',
            mimeType: 'application/pdf',
            size: 12,
            url: '',
          },
        ]);
        await db.pool.query("INSERT INTO threads(id,owner_id) VALUES($1,'foreign-owner')", [
          foreignThread,
        ]);
        await db.pool.query(
          "INSERT INTO artifacts(id,owner_id,thread_id,name,mime_type,size,storage_path) VALUES($1,'foreign-owner',$2,'foreign.pdf','application/pdf',12,'/nonexistent/foreign.pdf')",
          [foreignArtifact, foreignThread],
        );
        await db.pool.query(
          "INSERT INTO messages(id,owner_id,role,text,thread_id,attachments) VALUES($1,'foreign-owner','assistant','',$2,$3)",
          [foreignMessage, foreignThread, foreignAttachments],
        );
        await db.pool.query(
          "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id,attachments) VALUES($1,'local-development','assistant','',$2,$3,$4)",
          [randomUUID(), threadId, sourceTurn, foreignAttachments],
        );
        const staged = (context: RuntimeContext) =>
          context.attachments.map((item) => item.path.slice(context.workspacePath.length + 1));

        await thread.submitUserMessage('pdf-reply-file-fixture', [], {
          replyToMessageId: download.id,
        });
        await waitFor(() => fileContexts.has('pdf-reply-file-fixture'));
        const reply = fileContexts.get('pdf-reply-file-fixture')!;
        assert.deepEqual(staged(reply), [stagedName]);
        assert.equal(
          await readFile(reply.attachments[0].path, 'utf8'),
          '%PDF-1.4 synthetic statement',
        );
        const described = [
          { name: 'statement.pdf', mimeType: 'application/pdf', workspaceFile: stagedName },
        ];
        assert.deepEqual(reply.replyTo?.attachments, described);
        assert.deepEqual(
          reply.history.find((item) => item.attachments?.[0]?.name === 'foreign.pdf')?.attachments,
          [{ name: 'foreign.pdf', mimeType: 'application/pdf' }],
        );
        await assert.rejects(
          thread.submitUserMessage('foreign-reply-file-fixture', [], {
            replyToMessageId: foreignMessage,
          }),
          { statusCode: 404 },
        );
        assert.equal(
          (await db.pool.query("SELECT id FROM turns WHERE prompt='foreign-reply-file-fixture'"))
            .rowCount,
          0,
        );
        assert.equal(JSON.stringify([...fileContexts.values()]).includes(foreignArtifact), false);
      });

      await t.test('a waiting question does not block the next user message', async () => {
        const question = await thread.submitUserMessage('ask-question', [], { channel: 'web' });
        await waitFor(settled(question.turnId));
        const row = (
          await db.pool.query('SELECT status,waiting_reason FROM turns WHERE id=$1', [
            question.turnId,
          ])
        ).rows[0];
        assert.deepEqual(row, { status: 'waiting', waiting_reason: 'question' });
        assert.equal(
          (
            await db.pool.query(
              "SELECT count(*)::int AS count FROM messages WHERE turn_id=$1 AND role='assistant' AND text='Which account should I use?'",
              [question.turnId],
            )
          ).rows[0].count,
          1,
        );
        await waitFor(async () => (await thread.activeThread(db.pool)).status === 'idle');
        const answer = await thread.submitUserMessage('the work account', [], { channel: 'web' });
        await waitFor(settled(answer.turnId));
        assert.equal(await turnStatus(answer.turnId), 'succeeded');
        assert.equal(ran(answer.turnId)?.threadId, question.threadId);
        assert.ok(
          ran(answer.turnId)?.history.some(
            (message) =>
              message.role === 'assistant' && message.text === 'Which account should I use?',
          ),
        );
      });

      await t.test(
        'a runtime failure ends the turn failed with one message and no retry',
        async () => {
          const before = (await db.pool.query('SELECT count(*)::int AS count FROM turns')).rows[0]
            .count;
          const failed = await thread.submitUserMessage('runtime-failure', [], { channel: 'web' });
          await waitFor(settled(failed.turnId));
          await delay(1200);
          const row = (
            await db.pool.query('SELECT status,error FROM turns WHERE id=$1', [failed.turnId])
          ).rows[0];
          assert.equal(row.status, 'failed');
          const messages = (
            await db.pool.query(
              "SELECT text FROM messages WHERE thread_id=$1 AND role='assistant' AND created_at >= (SELECT created_at FROM turns WHERE id=$2)",
              [failed.threadId, failed.turnId],
            )
          ).rows.map((message) => message.text);
          assert.deepEqual(messages, [thread.interruptedMessage]);
          assert.equal(
            (await db.pool.query('SELECT count(*)::int AS count FROM turns')).rows[0].count,
            before + 1,
          );
          assert.equal(runs.filter((context) => context.prompt === 'runtime-failure').length, 1);
          await waitFor(async () => (await thread.activeThread(db.pool)).status === 'idle');
        },
      );

      await t.test('stop cancels the running turn and every queued turn', async () => {
        block('stop running');
        const runningTurn = await thread.submitUserMessage('stop running', [], { channel: 'web' });
        await waitFor(() => Boolean(ran(runningTurn.turnId)));
        const queued = await thread.submitUserMessage('stop queued', [], { channel: 'web' });
        const scheduled = await thread.enqueueTurn('stop scheduled', {
          source: 'schedule',
          sourceId: `schedule:${randomUUID()}`,
        });
        await thread.stopThread();
        await waitFor(() => abortedPrompts.has('stop running'));
        await delay(700);
        for (const turnId of [runningTurn.turnId, queued.turnId, scheduled])
          assert.equal(await turnStatus(turnId), 'cancelled');
        assert.equal(ran(queued.turnId), undefined);
        assert.equal(
          runs.some((context) => context.turnId === scheduled),
          false,
        );
        assert.equal(
          (
            await db.pool.query(
              'SELECT count(*)::int AS count FROM messages WHERE turn_id=ANY($1::uuid[]) AND role=$2',
              [[runningTurn.turnId, queued.turnId, scheduled], 'assistant'],
            )
          ).rows[0].count,
          0,
        );
        await waitFor(async () => (await thread.activeThread(db.pool)).status === 'idle');
        const after = await thread.submitUserMessage('after stop', [], { channel: 'web' });
        await waitFor(settled(after.turnId));
        assert.equal(await turnStatus(after.turnId), 'succeeded');
      });

      await t.test('stopped turns cannot write replies, events, or invoke tools', async () => {
        const { turnId: id } = await thread.submitUserMessage('cancel-fence-fixture');
        await waitFor(() => Boolean(fenced));
        await thread.stopThread();
        const context = fenced!;
        assert.equal(context.signal.aborted, true);
        await assert.rejects(context.reply('late-reply-fixture'));
        await assert.rejects(context.emit('late-event-fixture', 'must not persist'));
        await assert.rejects(context.manage('profile_update', { name: 'Injected' }));
        const reads = integrationReads.length;
        await assert.rejects(context.integration('GMAIL_FETCH_EMAILS', {}));
        assert.equal(integrationReads.length, reads);
        await assert.rejects(context.publish('/no-such-file'));
        releaseFence();
        await waitFor(async () => (await turnStatus(id)) === 'cancelled');
        assert.equal(
          (await db.pool.query("SELECT id FROM messages WHERE text='late-reply-fixture'")).rowCount,
          0,
        );
        assert.equal(
          (await db.pool.query("SELECT id FROM turn_events WHERE type='late-event-fixture'"))
            .rowCount,
          0,
        );
        await waitFor(async () => (await thread.activeThread(db.pool)).status === 'idle');
      });

      await t.test('a stop during artifact delivery leaves no orphaned artifact', async () => {
        const turn = await thread.submitUserMessage('screenshot-during-stop', [], {
          channel: 'web',
        });
        await waitFor(settled(turn.turnId));
        await waitFor(async () => (await thread.activeThread(db.pool)).status === 'idle');
        const artifacts = (
          await db.pool.query("SELECT id FROM artifacts WHERE name='atomic.png'")
        ).rows.map((row) => row.id as string);
        assert.equal(artifacts.length, 1);
        const messages = await db.pool.query(
          "SELECT attachments FROM messages WHERE turn_id=$1 AND role='assistant'",
          [turn.turnId],
        );
        assert.deepEqual(
          messages.rows.flatMap((row) => row.attachments.map((item: { id: string }) => item.id)),
          artifacts,
        );
      });

      await t.test('a failed thread release is retried so later turns still run', async (t) => {
        const send = thread.boss.send.bind(thread.boss) as (
          name: string,
          data?: object | null,
          options?: object,
        ) => Promise<string | null>;
        t.mock.method(
          thread.boss,
          'send',
          async (name: string, data?: object | null, options?: object) => {
            if (failRelease > 0) {
              failRelease--;
              throw new Error('Synthetic queue failure');
            }
            return send(name, data, options);
          },
        );
        const first = await thread.submitUserMessage('release-retry', [], { channel: 'web' });
        await waitFor(settled(first.turnId));
        const next = await thread.submitUserMessage('after release retry', [], { channel: 'web' });
        await waitFor(settled(next.turnId));
        assert.equal(failRelease, 0);
        assert.equal(await turnStatus(next.turnId), 'succeeded');
      });

      await t.test(
        'completing onboarding starts one read-only welcome without a user message',
        async () => {
          block('Earlier synthetic request');
          const earlier = await thread.submitUserMessage('Earlier synthetic request');
          await waitFor(() => Boolean(ran(earlier.turnId)));
          await thread.startOnboarding('Alex', ['Gmail']);
          assert.equal(
            (await db.pool.query("SELECT id FROM turns WHERE source_id LIKE 'onboarding:%'"))
              .rowCount,
            0,
          );
          await thread.stopThread();
          await waitFor(async () => (await thread.activeThread(db.pool)).status === 'idle');
          const landing = () => request('POST', '/api/account/welcome', {});
          assert.equal((await landing()).statusCode, 409);
          const complete = () => request('PATCH', '/api/account', { onboardingCompleted: true });
          for (const response of await Promise.all([complete(), complete(), complete()]))
            assert.equal(response.statusCode, 200);
          for (const response of await Promise.all([landing(), landing()]))
            assert.deepEqual(response.json(), { ok: true });
          const welcome = await db.pool.query(
            "SELECT id,thread_id,read_only,background FROM turns WHERE source_id LIKE 'onboarding:%'",
          );
          assert.equal(welcome.rowCount, 1);
          const turn = welcome.rows[0];
          assert.equal(turn.read_only, true);
          assert.equal(turn.background, true);
          assert.equal(turn.thread_id, firstThreadId);
          await waitFor(async () => (await turnStatus(turn.id)) === 'succeeded');
          assert.deepEqual(
            (
              await db.pool.query(
                'SELECT role,text FROM messages WHERE turn_id=$1 ORDER BY created_at,id',
                [turn.id],
              )
            ).rows.map((row) => row.role),
            ['assistant', 'assistant'],
          );
          assert.equal(
            (
              await db.pool.query(
                "SELECT id FROM messages WHERE turn_id=$1 AND text='Two threads wait for your reply.'",
                [turn.id],
              )
            ).rowCount,
            1,
          );
          assert.deepEqual(readOnlyRefusals, [
            'This turn can only read. Use app reads, and browser open, snapshot or scroll.',
          ]);
          assert.deepEqual(integrationReads, [true]);
          assert.deepEqual(
            runs.filter((context) => context.readOnly).map((context) => context.turnId),
            [turn.id],
          );
        },
      );

      let freshThread = '';
      await t.test(
        'reset archives the thread, revokes old work and resumes on a fresh thread while preserving saved data',
        async () => {
          const held = await thread.submitUserMessage('Hold old worker');
          await waitFor(() => Boolean(ran(held.turnId)));
          const heldContext = ran(held.turnId)!;
          const running = async (text: string) => {
            const turn = await thread.submitUserMessage(text, []);
            await db.pool.query("UPDATE turns SET status='running' WHERE id=$1", [turn.turnId]);
            return turn;
          };
          const old = await running('Archived unique conversation phrase');
          await thread.reply(old, 'Archived answer.');
          await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [old.turnId]);
          const oldMessage = (
            await db.pool.query("SELECT id FROM messages WHERE turn_id=$1 AND role='assistant'", [
              old.turnId,
            ])
          ).rows[0].id as string;
          await request('PUT', '/api/profile', {
            name: 'Fixture name',
            location: 'Lisbon',
            phone: '',
            preferences: 'Concise',
          });
          assert.equal(
            (await request('POST', '/api/goals', { title: 'Saved goal' })).statusCode,
            200,
          );
          assert.equal(
            (
              await request('POST', '/api/schedules', {
                title: 'Saved routine',
                prompt: 'Check a fixture',
                cron: '0 9 * * 1',
                timeZone: 'Europe/Lisbon',
              })
            ).statusCode,
            200,
          );
          assert.equal(
            (
              await request('POST', '/api/vault', {
                label: 'Saved account',
                origin: 'https://example.com',
                username: 'fixture',
                password: 'synthetic-secret',
              })
            ).statusCode,
            200,
          );
          await db.pool.query(
            'CREATE TABLE app_connections(id uuid PRIMARY KEY,owner_id text,account_id text)',
          );
          await db.pool.query("INSERT INTO app_connections VALUES($1,$2,'saved-fixture-account')", [
            randomUUID(),
            ownerId,
          ]);
          const credentialTurn = await running('Old credential task');
          const credential = await vault.request(credentialTurn, ownerId, {
            origin: 'https://example.com',
            label: 'Example',
            kind: 'password',
            passwordSelector: '#password',
          });
          await db.pool.query(
            "UPDATE turns SET status='waiting',waiting_reason='credentials' WHERE id=$1",
            [credentialTurn.turnId],
          );
          const approvalTurn = await running('Old approval task');
          await approvals.request(approvalTurn, 'FIXTURE_WRITE', {});
          const confirmationMessageId = (
            await db.pool.query('SELECT confirmation_message_id FROM approvals WHERE turn_id=$1', [
              approvalTurn.turnId,
            ])
          ).rows[0].confirmation_message_id;
          await db.pool.query(
            "UPDATE turns SET status='waiting',waiting_reason='approval' WHERE id=$1",
            [approvalTurn.turnId],
          );

          const reset = await request('POST', '/api/conversation/reset', {});
          assert.equal(reset.statusCode, 200, reset.body);
          freshThread = reset.json<{ ok: boolean; threadId: string }>().threadId;
          assert.notEqual(freshThread, firstThreadId);
          assert.deepEqual(
            (
              await db.pool.query(
                'SELECT archived_at IS NOT NULL AS archived FROM threads WHERE id=$1',
                [firstThreadId],
              )
            ).rows[0],
            { archived: true },
          );
          assert.equal(heldContext.signal.aborted, true);
          await assert.rejects(heldContext.reply('Late old answer'), /no longer active/);
          await assert.rejects(
            heldContext.publishScreenshot!(Buffer.from('Late screen')),
            /no longer active/,
          );
          const before = deltas.length;
          heldContext.delta('Late old stream', randomUUID());
          assert.equal(deltas.length, before);
          const state = (await request('GET', '/api/state')).json();
          assert.equal(state.threadId, freshThread);
          assert.deepEqual(state.messages, []);
          assert.equal(
            (await request('GET', `/api/messages?threadId=${firstThreadId}`)).statusCode,
            409,
          );
          assert.equal(
            (
              await request('POST', '/api/messages', {
                text: 'Stale draft',
                threadId: firstThreadId,
              })
            ).statusCode,
            409,
          );
          assert.equal(
            (await request('POST', '/api/onboarding', { threadId: firstThreadId })).statusCode,
            409,
          );
          for (const threadId of [undefined, freshThread])
            assert.equal(
              (
                await sendJson({
                  clientMessageId: firstClientMessageId,
                  text: 'Prepare the synthetic report',
                  threadId,
                })
              ).statusCode,
              409,
            );
          assert.equal(
            (
              await request('POST', '/api/messages', {
                text: 'Old reply',
                replyToMessageId: oldMessage,
              })
            ).statusCode,
            404,
          );
          assert.deepEqual(await personal.manage('history_search', { query: 'Archived' }), {
            turns: [],
            messages: [],
          });
          assert.equal(
            (
              await request('POST', '/api/messages', {
                text: 'yes',
                replyToMessageId: confirmationMessageId,
                threadId: freshThread,
              })
            ).statusCode,
            404,
          );
          assert.equal(
            (
              await request(
                'POST',
                credential.url.replace('/vault/', '/api/credential-requests/'),
                { password: 'must-not-inject' },
              )
            ).statusCode,
            409,
          );
          assert.equal(executed, 0);
          assert.equal(injected, 0);
          assert.equal((await request('GET', '/api/goals')).json().length, 1);
          assert.equal((await request('GET', '/api/schedules')).json().length, 1);
          assert.equal((await request('GET', '/api/vault')).json().length, 1);
          assert.equal((await request('GET', '/api/profile')).json().name, 'Fixture name');
          assert.equal(
            (await db.pool.query('SELECT account_id FROM app_connections')).rows[0].account_id,
            'saved-fixture-account',
          );
          await waitFor(async () => (await turnStatus(held.turnId)) === 'cancelled');
          const fresh = await request('POST', '/api/messages', {
            text: 'Fresh conversation',
            threadId: freshThread,
          });
          assert.equal(fresh.statusCode, 200, fresh.body);
          assert.equal(fresh.json().threadId, freshThread);
          await waitFor(async () => (await turnStatus(fresh.json().turnId)) === 'succeeded');
          const current = ran(fresh.json().turnId)!;
          assert.equal(current.threadId, freshThread);
          assert.equal(current.workspacePath, join(root, 'workspaces', freshThread));
          assert.notEqual(current.workspacePath, heldContext.workspacePath);
          assert.deepEqual(current.history, []);
          assert.equal(current.personalContext?.profile.name, 'Fixture name');
          assert.equal(
            deltas.find((event) => event.turnId === held.turnId)?.threadId,
            firstThreadId,
          );
          assert.equal(
            deltas.find((event) => event.turnId === fresh.json().turnId)?.threadId,
            freshThread,
          );
          assert.equal(
            (await db.pool.query("SELECT id FROM messages WHERE text='Late old answer'")).rowCount,
            0,
          );
        },
      );

      await t.test(
        'history paging and reactions stay inside the owner’s active thread',
        async () => {
          const turn = randomUUID();
          await db.pool.query(
            "INSERT INTO turns(id,owner_id,thread_id,source,prompt,status) VALUES($1,$2,$3,'user','Fixture','succeeded')",
            [turn, ownerId, freshThread],
          );
          for (let i = 0; i < 65; i++)
            await db.pool.query(
              "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id,created_at) VALUES($1,$2,'assistant',$3,$4,$5,'2026-09-20 12:00:00.123456+00'::timestamptz)",
              [randomUUID(), ownerId, `Fixture ${i}`, freshThread, turn],
            );
          const foreignThread = randomUUID(),
            foreign = randomUUID(),
            foreignTurn = randomUUID();
          await db.pool.query("INSERT INTO threads(id,owner_id) VALUES($1,'other-owner')", [
            foreignThread,
          ]);
          await db.pool.query(
            "INSERT INTO turns(id,owner_id,thread_id,source,prompt,status) VALUES($1,'other-owner',$2,'user','Foreign fixture','succeeded')",
            [foreignTurn, foreignThread],
          );
          await db.pool.query(
            "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id) VALUES($1,'other-owner','assistant','private content',$2,$3)",
            [foreign, foreignThread, foreignTurn],
          );
          const archived = (
            await db.pool.query(
              'SELECT id,turn_id FROM messages WHERE thread_id=$1 AND turn_id IS NOT NULL LIMIT 1',
              [firstThreadId],
            )
          ).rows[0] as { id: string; turn_id: string };
          const backgroundTurns: string[] = Array.from({ length: 51 }, () => randomUUID());
          await db.pool.query(
            "INSERT INTO turns(id,owner_id,thread_id,source,prompt,status,background) SELECT id,$2,$3,'schedule','Background fixture','succeeded',true FROM unnest($1::uuid[]) AS id",
            [backgroundTurns, ownerId, freshThread],
          );
          const state = (await request('GET', '/api/state')).json<{
            messages: Array<{ id: string; turnId: string | null }>;
            turns: Array<{ id: string; status: string }>;
          }>();
          assert.ok(state.messages.some((message) => message.turnId === turn));
          assert.deepEqual(
            state.turns
              .filter((entry) => entry.id === turn)
              .map(({ id, status }) => ({ id, status })),
            [{ id: turn, status: 'succeeded' }],
          );
          assert.equal(
            state.turns.filter((entry) => backgroundTurns.includes(entry.id)).length,
            50,
          );
          for (const id of [foreign, archived.id])
            assert.equal(
              state.messages.some((message) => message.id === id),
              false,
            );
          for (const id of [foreignTurn, archived.turn_id])
            assert.equal(
              state.turns.some((entry) => entry.id === id),
              false,
            );
          const expected = new Set(
            (
              await db.pool.query('SELECT id FROM messages WHERE thread_id=$1', [freshThread])
            ).rows.map((row) => row.id as string),
          );
          const seen = new Set<string>();
          let cursor = '';
          for (let hasMore = true; hasMore;) {
            const response = await request('GET', `/api/messages${cursor}`);
            assert.equal(response.statusCode, 200);
            const page = response.json<{
              messages: Array<{ id: string; createdAt: string }>;
              hasMore: boolean;
            }>();
            for (const row of page.messages) {
              assert.ok(!seen.has(row.id));
              seen.add(row.id);
            }
            hasMore = page.hasMore;
            cursor = `?before=${encodeURIComponent(page.messages[0].createdAt)}&beforeId=${page.messages[0].id}&threadId=${freshThread}`;
          }
          assert.deepEqual(seen, expected);
          const message = [...seen][0];
          const react = (id: string, reaction: string) =>
            request('POST', `/api/messages/${id}/reaction`, { reaction });
          assert.equal((await react(message, 'heart')).statusCode, 200);
          for (const id of [foreign, archived.id])
            assert.equal((await react(id, 'heart')).statusCode, 404);
          assert.equal(
            (
              await app.inject({
                url: '/api/messages',
                headers: { ...headers, 'sec-fetch-site': 'cross-site' },
              })
            ).statusCode,
            403,
          );
        },
      );
      await t.test(
        'events and saved updates run quietly without an hourly quota, replay or empty reviews',
        async () => {
          const threadId = (await thread.activeThread()).id;
          await waitFor(
            async () =>
              !(
                await db.pool.query(
                  "SELECT id FROM turns WHERE thread_id=$1 AND status IN ('queued','running')",
                  [threadId],
                )
              ).rowCount,
          );
          await db.pool.query('DELETE FROM goals WHERE owner_id=$1', [ownerId]);
          const preferences = createPreferencesStore(db.pool, ownerId);
          const original = await preferences.get();
          let classified = 0;
          const classifiedApps: unknown[] = [];
          const triage = createTriage({
            classifier: {
              id: 'fixture',
              configured: true,
              async classify(context) {
                classified++;
                classifiedApps.push((context as { connectedApps: unknown }).connectedApps);
                return 'digest';
              },
            },
            getProfile: async () => ({ location: '', preferences: '' }),
            listGoals: async () => [],
            connectedApps: readConnectedApps,
          });
          const ids = Array.from({ length: 4 }, () => randomUUID());
          try {
            quietBackgroundWork = true;
            await preferences.update({ quietHoursEnabled: false });
            const emptyReads = integrationReads.length;
            await triage.reviewHeartbeat(randomUUID());
            assert.equal(classified, 0);
            assert.equal(integrationReads.length, emptyReads);
            assert.equal((await db.pool.query('SELECT id FROM notifications')).rowCount, 0);
            currentApps = [
              {
                slug: 'slack',
                name: 'Slack',
                status: 'connected',
                connectionId: randomUUID(),
                accountName: 'Work',
                access: ['api'],
                supportsTriggers: true,
                triggersEnabled: true,
                triggerStatus: 'active',
              },
            ];
            const ordinaryId = randomUUID();
            await triage.triageEvent('A synthetic calendar update', ordinaryId);
            assert.equal(classified, 1);
            assert.deepEqual(classifiedApps.at(-1), currentApps);
            let currentSource = true;
            let enterSourceCheck = () => {};
            let releaseSourceCheck = () => {};
            const sourceCheckEntered = new Promise<void>((resolve) => {
              enterSourceCheck = resolve;
            });
            const sourceCheckReleased = new Promise<void>((resolve) => {
              releaseSourceCheck = resolve;
            });
            const guardedTriage = createTriage({
              classifier: { id: 'fixture', configured: true, classify: async () => 'wake' },
              getProfile: async () => {
                enterSourceCheck();
                await sourceCheckReleased;
                return { location: '', preferences: '' };
              },
              listGoals: async () => [],
              connectedApps: readConnectedApps,
            });
            const revokedEvent = randomUUID();
            const revokedTriage = guardedTriage.triageEvent(
              'Synthetic event disconnected during triage',
              revokedEvent,
              'inspect_message',
              async () => currentSource,
            );
            try {
              await sourceCheckEntered;
              currentSource = false;
            } finally {
              releaseSourceCheck();
            }
            await revokedTriage;
            assert.equal(
              (
                await db.pool.query('SELECT id FROM notifications WHERE event_id=$1', [
                  revokedEvent,
                ])
              ).rowCount,
              0,
            );
            block('Hold for app inventory change');
            const held = await thread.submitUserMessage('Hold for app inventory change');
            await waitFor(() => Boolean(ran(held.turnId)));
            const readsBeforeInspection = integrationReads.length;
            await Promise.all(
              [...ids, ids[0], ids[0]].map((id) =>
                triage.triageEvent(`Synthetic inbox message ${id}`, id, 'inspect_message'),
              ),
            );
            currentApps = [];
            release('Hold for app inventory change');
            assert.equal(classified, 1);
            const dispatched = await db.pool.query(
              `SELECT n.decision,n.turn_id,u.background,u.source,u.thread_id FROM notifications n
             LEFT JOIN turns u ON u.id=n.turn_id WHERE n.event_id=ANY($1::text[]) AND n.owner_id=$2`,
              [ids, ownerId],
            );
            assert.equal(dispatched.rowCount, 4);
            for (const row of dispatched.rows) {
              assert.equal(row.decision, 'wake');
              assert.equal(row.background, true);
              assert.equal(row.source, 'event');
              assert.equal(row.thread_id, threadId);
              await waitFor(settled(row.turn_id));
              assert.equal(await turnStatus(row.turn_id), 'succeeded');
              assert.deepEqual(ran(row.turn_id)?.connectedApps, []);
            }
            const turnIds = dispatched.rows.map((row) => row.turn_id);
            await triage.triageEvent('Synthetic inbox duplicate', ids[0], 'inspect_message');
            assert.equal(runs.filter((run) => turnIds.includes(run.turnId)).length, 4);
            assert.equal(integrationReads.length - readsBeforeInspection, 4);
            assert.equal(
              (
                await db.pool.query('SELECT id FROM messages WHERE turn_id=ANY($1::uuid[])', [
                  turnIds,
                ])
              ).rowCount,
              0,
            );
            assert.equal(deltas.filter((event) => turnIds.includes(event.turnId)).length, 0);
            const hour = new Date().getUTCHours();
            await preferences.update({
              timeZone: 'UTC',
              quietHoursEnabled: true,
              quietStart: `${String(hour).padStart(2, '0')}:00`,
              quietEnd: `${String((hour + 1) % 24).padStart(2, '0')}:00`,
            });
            const quietId = randomUUID();
            await triage.triageEvent('Synthetic inbox quiet hours', quietId, 'inspect_message');
            const callsBeforeOptOut = classified;
            await preferences.update({ notificationRule: '', quietHoursEnabled: false });
            const disabledId = randomUUID();
            await triage.triageEvent('Synthetic inbox disabled', disabledId, 'inspect_message');
            assert.equal(classified, callsBeforeOptOut);
            assert.deepEqual(
              (
                await db.pool.query(
                  'SELECT decision,turn_id FROM notifications WHERE event_id=ANY($1::text[]) AND owner_id=$2',
                  [[quietId, disabledId], ownerId],
                )
              ).rows,
              [
                { decision: 'digest', turn_id: null },
                { decision: 'digest', turn_id: null },
              ],
            );
            await preferences.update({ ...original, quietHoursEnabled: false });
            currentApps = [
              {
                slug: 'notion',
                name: 'Notion',
                status: 'connected',
                connectionId: randomUUID(),
                accountName: 'Research',
                access: ['api'],
                supportsTriggers: true,
                triggersEnabled: true,
                triggerStatus: 'active',
              },
            ];
            for (let index = 0; index < 8; index++)
              await triage.triageEvent(`Synthetic informational update ${index}`, randomUUID());
            assert.deepEqual(classifiedApps.at(-1), currentApps);
            const callsBeforeReview = classified;
            const reviewId = randomUUID();
            await Promise.all([
              triage.reviewHeartbeat(reviewId),
              triage.reviewHeartbeat(randomUUID()),
            ]);
            assert.equal(classified, callsBeforeReview);
            const review = (
              await db.pool.query(
                "SELECT turn_id FROM notifications WHERE owner_id=$1 AND kind='review' AND turn_id IS NOT NULL",
                [ownerId],
              )
            ).rows;
            assert.equal(review.length, 1);
            await waitFor(settled(review[0].turn_id));
            assert.equal(await turnStatus(review[0].turn_id), 'succeeded');
            assert.deepEqual(ran(review[0].turn_id)?.connectedApps, currentApps);
            assert.deepEqual(
              (
                await db.pool.query(
                  'SELECT DISTINCT turn_id FROM notifications WHERE event_id=ANY($1::text[]) AND owner_id=$2',
                  [[quietId, disabledId], ownerId],
                )
              ).rows,
              review,
            );
            const callsAfterReview = classified;
            await triage.reviewHeartbeat(reviewId);
            assert.equal(classified, callsAfterReview);
            await triage.reviewHeartbeat(randomUUID());
            assert.equal(classified, callsAfterReview + 1);
            assert.equal(
              (
                await db.pool.query(
                  "SELECT id FROM notifications WHERE owner_id=$1 AND kind='review' AND turn_id IS NOT NULL",
                  [ownerId],
                )
              ).rowCount,
              1,
            );
            turnIds.push(review[0].turn_id);
            assert.equal(runs.filter((run) => turnIds.includes(run.turnId)).length, 5);
            assert.equal(
              (
                await db.pool.query('SELECT id FROM messages WHERE turn_id=ANY($1::uuid[])', [
                  turnIds,
                ])
              ).rowCount,
              0,
            );
          } finally {
            quietBackgroundWork = false;
            currentApps = [];
            await preferences.update(original);
          }
        },
      );
      await t.test(
        'bounded app checks claim one owned account, persist verified reads and hand off each finding once',
        async () => {
          const preferences = createPreferencesStore(db.pool, ownerId);
          const original = await preferences.get();
          await db.pool.query('DELETE FROM notifications WHERE owner_id=$1', [ownerId]);
          const connectionId = randomUUID();
          const app: ConnectedApp = {
            slug: 'notion',
            name: 'Notion',
            status: 'connected',
            connectionId,
            access: ['api'],
            supportsTriggers: false,
            triggersEnabled: false,
          };
          const optedOut: ConnectedApp = {
            ...app,
            connectionId: randomUUID(),
            supportsTriggers: true,
            triggersEnabled: false,
            triggerStatus: 'disabled',
          };
          const manual: ConnectedApp = { ...app, connectionId: randomUUID(), access: ['browser'] };
          const cli: ConnectedApp = { ...app, connectionId: randomUUID(), access: ['cli'] };
          const unavailable: ConnectedApp = {
            ...app,
            connectionId: randomUUID(),
            status: 'disconnected',
          };
          const triage = createTriage({
            classifier: {
              id: 'fixture',
              configured: true,
              async classify() {
                assert.fail('An empty review must not call a model.');
              },
            },
            getProfile: async () => ({ location: '', preferences: '' }),
            listGoals: async () => [],
            connectedApps: readConnectedApps,
          });
          const scheduleCount = (await personal.listSchedules()).length;
          let releaseCheck = () => {};
          const checking = new Promise<void>((resolve) => {
            releaseCheck = resolve;
          });
          let entered = false;
          const receipt = async () =>
            (
              await db.pool.query(
                'SELECT * FROM app_activity_checks WHERE owner_id=$1 AND connection_id=$2',
                [ownerId, connectionId],
              )
            ).rows[0];
          const recordedContexts: RuntimeContext[] = [];
          let findingVersion = 'version-1';
          try {
            activityLookup = triage.activityCheck;
            quietBackgroundWork = true;
            await preferences.update({ quietHoursEnabled: false });
            currentApps = [app, optedOut, manual, cli, unavailable];
            activityRun = async (context) => {
              recordedContexts.push(context);
              assert.equal(context.readOnly, true);
              assert.equal(context.background, true);
              assert.equal(context.activityCheck?.connectionId, connectionId);
              entered = true;
              await checking;
              if (recordedContexts.length === 1) {
                const previousIntegration = dependencies.integration;
                const previousWrite = dependencies.writeArtifact;
                const cancelled = new AbortController();
                const page = { data: { items: [{ id: 'stable-item-1' }], next_cursor: 'page-2' } };
                const files = await readdir(context.workspacePath);
                let writes = 0;
                dependencies.integration = async (_turn, _action, args, options) => {
                  assert.equal(options.checkConnectionId, connectionId);
                  assert.equal(options.readOnly, true);
                  if (args.abort) cancelled.abort(new Error('Synthetic read deadline'));
                  return args.page_size === 1 ? page : largeAppResult;
                };
                dependencies.writeArtifact = async () => {
                  writes++;
                  throw new Error('Activity checks must not stage app results.');
                };
                try {
                  await assert.rejects(
                    context.integration('NOTION_RETRIEVE_PAGE', { connectionId }),
                    /smaller page|narrower query/i,
                  );
                  await assert.rejects(
                    context.integration(
                      'NOTION_RETRIEVE_PAGE',
                      { connectionId, abort: true },
                      cancelled.signal,
                    ),
                    /Synthetic read deadline/,
                  );
                  assert.deepEqual(
                    await context.integration('NOTION_RETRIEVE_PAGE', {
                      connectionId,
                      page_size: 1,
                    }),
                    page,
                  );
                  assert.equal(writes, 0);
                  assert.deepEqual(await readdir(context.workspacePath), files);
                } finally {
                  dependencies.integration = previousIntegration;
                  dependencies.writeArtifact = previousWrite;
                }
              }
              await context.integration('NOTION_RETRIEVE_PAGE', { connectionId });
              await context.activityCheck!.record({
                status: 'verified',
                value: 'revision-1',
                summary: 'One recent item reviewed.',
                finding: {
                  id: 'stable-item-1',
                  version: findingVersion,
                  url: 'https://example.test/items/1',
                  summary: 'A question needs a supported response.',
                },
              });
              await assert.rejects(
                context.activityCheck!.record({
                  status: 'unavailable',
                  summary: 'Duplicate report.',
                }),
                /already ended/,
              );
            };
            await Promise.all([
              triage.reviewHeartbeat(randomUUID()),
              triage.reviewHeartbeat(randomUUID()),
            ]);
            await waitFor(() => entered);
            const first = await receipt();
            assert.ok(first.attempted_at);
            assert.equal(first.checked_at, null);
            assert.equal((await db.pool.query('SELECT * FROM app_activity_checks')).rowCount, 1);
            currentApps.push({ ...app, connectionId: randomUUID() });
            await triage.reviewHeartbeat(randomUUID());
            assert.equal((await db.pool.query('SELECT * FROM app_activity_checks')).rowCount, 1);
            currentApps.pop();
            releaseCheck();
            await waitFor(settled(first.turn_id));
            assert.equal(await turnStatus(first.turn_id), 'succeeded');
            assert.equal(recordedContexts[0].activityCheck?.previous, undefined);
            const verified = await receipt();
            assert.ok(verified.checked_at);
            assert.equal(verified.value, 'revision-1');
            const finding = (
              await db.pool.query(
                "SELECT n.event_id,u.* FROM notifications n JOIN turns u ON u.id=n.turn_id WHERE n.owner_id=$1 AND n.event_id LIKE 'activity:%'",
                [ownerId],
              )
            ).rows;
            assert.equal(finding.length, 1);
            assert.equal(finding[0].source, 'event');
            assert.equal(finding[0].read_only, false);
            assert.equal(finding[0].background, true);
            await waitFor(settled(finding[0].id));
            await assert.rejects(
              recordedContexts[0].activityCheck!.record({
                status: 'unavailable',
                summary: 'Late report.',
              }),
              /no longer active/,
            );
            assert.equal(
              await triage.activityCheck({ threadId: randomUUID(), turnId: first.turn_id }),
              undefined,
            );
            await triage.reviewHeartbeat(randomUUID());
            assert.equal((await receipt()).turn_id, first.turn_id);
            await db.pool.query(
              "UPDATE app_activity_checks SET attempted_at=now()-interval '31 minutes' WHERE owner_id=$1",
              [ownerId],
            );
            await triage.reviewHeartbeat(randomUUID());
            const second = await receipt();
            assert.notEqual(second.turn_id, first.turn_id);
            await waitFor(settled(second.turn_id));
            assert.equal(recordedContexts[1].activityCheck?.previous?.value, 'revision-1');
            assert.ok(recordedContexts[1].activityCheck?.previous?.checkedAt);
            assert.equal(
              (await db.pool.query("SELECT * FROM notifications WHERE event_id LIKE 'activity:%'"))
                .rowCount,
              1,
            );
            findingVersion = 'version-2';
            await db.pool.query(
              "UPDATE app_activity_checks SET attempted_at=now()-interval '31 minutes' WHERE owner_id=$1",
              [ownerId],
            );
            await triage.reviewHeartbeat(randomUUID());
            await waitFor(settled((await receipt()).turn_id));
            const versioned = (
              await db.pool.query(
                "SELECT turn_id FROM notifications WHERE event_id LIKE 'activity:%' ORDER BY created_at",
              )
            ).rows;
            assert.equal(versioned.length, 2);
            await waitFor(settled(versioned[1].turn_id));
            const previousCheck = (await receipt()).checked_at;
            await db.pool.query(
              "UPDATE app_activity_checks SET attempted_at=now()-interval '31 minutes' WHERE owner_id=$1",
              [ownerId],
            );
            activityRun = async () => {
              throw new Error('Synthetic connection unavailable.');
            };
            await triage.reviewHeartbeat(randomUUID());
            const failed = await receipt();
            await waitFor(settled(failed.turn_id));
            assert.equal(await turnStatus(failed.turn_id), 'failed');
            assert.deepEqual((await receipt()).checked_at, previousCheck);
            await triage.reviewHeartbeat(randomUUID());
            assert.equal((await receipt()).turn_id, failed.turn_id);
            activityRun = async (context) => {
              const controller = new AbortController();
              let releaseInventory = () => {};
              inventoryGate = new Promise<void>((resolve) => {
                releaseInventory = resolve;
              });
              inventoryWaiting = false;
              const recording = context.activityCheck!.record(
                {
                  status: 'verified',
                  value: 'must-not-save',
                  summary: 'Late observation.',
                  finding: { id: 'must-not-notify', summary: 'Late finding.' },
                },
                controller.signal,
              );
              await waitFor(() => inventoryWaiting);
              controller.abort(new Error('Synthetic deadline'));
              inventoryGate = undefined;
              releaseInventory();
              await assert.rejects(recording, /Synthetic deadline/);
            };
            await db.pool.query(
              "UPDATE app_activity_checks SET attempted_at=now()-interval '31 minutes' WHERE owner_id=$1",
              [ownerId],
            );
            await triage.reviewHeartbeat(randomUUID());
            const aborted = await receipt();
            await waitFor(settled(aborted.turn_id));
            assert.equal((await receipt()).recorded_at, null);
            assert.deepEqual((await receipt()).checked_at, previousCheck);
            assert.equal(
              (await db.pool.query("SELECT * FROM notifications WHERE event_id LIKE 'activity:%'"))
                .rowCount,
              2,
            );
            assert.equal(
              (
                await db.pool.query('SELECT * FROM messages WHERE turn_id=ANY($1::uuid[])', [
                  [first.turn_id, second.turn_id, failed.turn_id],
                ])
              ).rowCount,
              0,
            );
            currentApps = [optedOut, manual, cli, unavailable];
            await db.pool.query(
              "UPDATE app_activity_checks SET attempted_at=now()-interval '31 minutes' WHERE owner_id=$1",
              [ownerId],
            );
            await triage.reviewHeartbeat(randomUUID());
            assert.equal((await receipt()).turn_id, aborted.turn_id);
            for (const change of ['revoked', 'disabled', 'replaced']) {
              currentApps = [app];
              await preferences.update({ ...original, quietHoursEnabled: false });
              await db.pool.query(
                "UPDATE app_activity_checks SET attempted_at=now()-interval '31 minutes' WHERE owner_id=$1",
                [ownerId],
              );
              const prompt = `Hold queued check ${change}`;
              block(prompt);
              const held = await thread.submitUserMessage(prompt);
              await waitFor(() => Boolean(ran(held.turnId)));
              await triage.reviewHeartbeat(randomUUID());
              const queued = await receipt();
              const reads = integrationReads.length;
              if (change === 'revoked') currentApps = [];
              if (change === 'disabled') await preferences.update({ notificationRule: '' });
              if (change === 'replaced')
                await db.transaction((client) =>
                  triage.invalidateActivityCheck(connectionId, client),
                );
              release(prompt);
              await waitFor(settled(queued.turn_id));
              assert.equal(await turnStatus(queued.turn_id), 'failed');
              assert.equal(ran(queued.turn_id), undefined);
              assert.equal(integrationReads.length, reads);
            }
            assert.equal((await personal.listSchedules()).length, scheduleCount);
          } finally {
            releaseCheck();
            activityRun = undefined;
            activityLookup = undefined;
            quietBackgroundWork = false;
            currentApps = [];
            inventoryGate = undefined;
            await preferences.update(original);
          }
        },
      );
      await t.test(
        'background research stages private artifacts and resumed preparation stays quiet',
        async () => {
          const previousRead = dependencies.readArtifact;
          const previousDownload = dependencies.downloadIntegrationFile;
          try {
            dependencies.readArtifact = async (threadId, path) =>
              readFile(join(root, 'workspaces', threadId, path));
            dependencies.downloadIntegrationFile = async () => ({
              name: 'source.txt',
              mimeType: 'text/plain',
              bytes: Buffer.from('synthetic source'),
            });
            const research = await thread.enqueueTurn('background-research-fixture', {
              source: 'event',
              background: true,
            });
            await waitFor(settled(research));
            assert.equal(await turnStatus(research), 'succeeded');
            assert.equal(ran(research)?.takeMessages, undefined);
            const messages = (
              await db.pool.query('SELECT attachments FROM messages WHERE turn_id=$1', [research])
            ).rows;
            assert.equal(messages.length, 1);
            assert.equal(messages[0].attachments[0].name, 'finished.txt');
            quietBackgroundWork = true;
            await thread.resumeAfterCredentials(research);
            const resumed = (
              await db.pool.query('SELECT id,background FROM turns WHERE source_id=$1', [
                `credentials:${research}`,
              ])
            ).rows[0];
            assert.equal(resumed.background, true);
            await waitFor(settled(resumed.id));
            assert.equal(
              (await db.pool.query('SELECT id FROM messages WHERE turn_id=$1', [resumed.id]))
                .rowCount,
              0,
            );
            assert.equal(deltas.filter((event) => event.turnId === resumed.id).length, 0);
          } finally {
            quietBackgroundWork = false;
            dependencies.readArtifact = previousRead;
            dependencies.downloadIntegrationFile = previousDownload;
          }
        },
      );
      await t.test('bug report includes the active thread and masks saved secrets', async () => {
        savedPiEntries = [
          {
            type: 'message',
            id: 'pi-assistant',
            parentId: null,
            timestamp: '2026-01-01T00:00:00.000Z',
            message: {
              role: 'assistant',
              model: 'fixture',
              content: [
                {
                  type: 'thinking',
                  thinking:
                    'The page gave me fixture-login-value, so I should inspect the next step.',
                  thinkingSignature: 'opaque-fixture-signature',
                },
                {
                  type: 'toolCall',
                  id: 'credential-call',
                  name: 'get_credential',
                  arguments: { id: 'fixture-account', origin: 'https://example.test' },
                },
              ],
            },
          },
          {
            type: 'message',
            id: 'pi-result',
            parentId: 'pi-assistant',
            timestamp: '2026-01-01T00:00:01.000Z',
            message: {
              role: 'toolResult',
              toolCallId: 'credential-call',
              toolName: 'get_credential',
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    username: 'fixture-login-user',
                    password: 'fixture-login-value',
                  }),
                },
              ],
              details: { password: 'fixture-login-value' },
            },
          },
          {
            type: 'compaction',
            id: 'pi-compaction',
            parentId: 'pi-result',
            timestamp: '2026-01-01T00:00:02.000Z',
            summary: 'The assistant chose the saved account.',
            tokensBefore: 1000,
            systemMessage: { content: 'Saved fixture system instruction' },
          },
          {
            type: 'context_edit',
            id: 'pi-credential-edit',
            parentId: 'pi-compaction',
            timestamp: '2026-01-01T00:00:03.000Z',
            targetId: 'pi-result',
            replacement: { content: 'fixture-login-value' },
          },
          {
            type: 'context_edit',
            id: 'pi-safe-edit',
            parentId: 'pi-credential-edit',
            timestamp: '2026-01-01T00:00:04.000Z',
            targetId: 'pi-assistant',
            replacement: { content: 'Safe context update' },
          },
        ];
        const turnId = randomUUID();
        await db.pool.query(
          "INSERT INTO turns(id,owner_id,thread_id,source,prompt,status) VALUES($1,$2,$3,'user','Inspect this action','succeeded')",
          [turnId, ownerId, freshThread],
        );
        await db.pool.query(
          "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id) VALUES($1,$2,'user','password=fixture-secret',$3,$4)",
          [randomUUID(), ownerId, freshThread, turnId],
        );
        await db.pool.query(
          "INSERT INTO inspector_records(id,owner_id,thread_id,turn_id,kind,name,status,input,started_at) VALUES($1,$2,$3,$4,'tool','browser','succeeded',$5,now())",
          [randomUUID(), ownerId, freshThread, turnId, { token: 'fixture-token', step: 'read' }],
        );
        await db.pool.query(
          'INSERT INTO inspector_prompts(id,owner_id,thread_id,turn_id,payload,provider,model) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            randomUUID(),
            ownerId,
            freshThread,
            turnId,
            { system: 'Fixture system' },
            'fixture',
            'fixture',
          ],
        );
        const result = await request('GET', '/api/conversation/bug-report');
        assert.equal(result.statusCode, 200);
        assert.equal(result.headers['cache-control'], 'no-store');
        const report = result.json<{
          threadId: string;
          messages: Array<{ text: string }>;
          turns: Array<{ id: string }>;
          trace: Array<{ name: string; input: { token: string } }>;
          prompts: Array<{ turn_id: string }>;
          piSession: {
            available: boolean;
            entries: Array<{ type: string; message?: unknown; summaryOmitted?: boolean }>;
          };
        }>();
        assert.equal(report.threadId, freshThread);
        assert.equal(reportedPiThread, freshThread);
        assert.equal(report.piSession.available, true);
        assert.ok(report.piSession.entries.some((entry) => entry.summaryOmitted === true));
        assert.match(JSON.stringify(report.piSession), /inspect the next step/);
        assert.match(JSON.stringify(report.piSession), /credential-call/);
        assert.ok(!JSON.stringify(report.piSession).includes('Saved fixture system instruction'));
        assert.match(JSON.stringify(report.piSession), /Safe context update/);
        assert.ok(report.turns.some((turn) => turn.id === turnId));
        assert.ok(report.trace.some((record) => record.name === 'browser'));
        assert.ok(report.prompts.some((prompt) => prompt.turn_id === turnId));
        assert.ok(report.messages.length > 60);
        assert.ok(!JSON.stringify(report).includes('fixture-secret'));
        assert.ok(!JSON.stringify(report).includes('fixture-token'));
        assert.ok(!JSON.stringify(report).includes('fixture-login-value'));
        assert.ok(!JSON.stringify(report).includes('fixture-login-user'));
        assert.ok(!JSON.stringify(report).includes('opaque-fixture-signature'));
        assert.ok(!JSON.stringify(report).includes('private content'));
        assert.ok(!JSON.stringify(report).includes('Late old answer'));
        savedPiEntries = [
          {
            type: 'compaction',
            id: 'rebased-summary',
            parentId: null,
            timestamp: '2026-01-01T00:00:00.000Z',
            summary: 'The old login was orphaned-fixture-password.',
            details: { summary: 'orphaned-fixture-password' },
            systemMessage: { content: 'orphaned-fixture-password' },
          },
        ];
        const rebased = (await request('GET', '/api/conversation/bug-report')).json();
        assert.ok(!JSON.stringify(rebased).includes('orphaned-fixture-password'));
      });
    } finally {
      for (const resolve of gates.values()) resolve();
      releaseFence();
      events.off('event', onEvent);
      await thread.stopThreadWorkers();
      await readOnlyRuntime.dispose();
      await quietRuntime.dispose();
      await app.close();
      await promptInspector.close();
      await db.pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'owner memory keeps evidence, revisions and every note across sessions',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async () => {
    const schema = `test_memory_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const root = await mkdtemp(join(tmpdir(), 'memory-test-'));
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const pool = new pg.Pool({ connectionString: url.href });
    try {
      await pool.query(
        'CREATE TABLE messages (id uuid PRIMARY KEY, owner_id text NOT NULL, role text NOT NULL, text text NOT NULL, turn_id uuid NOT NULL)',
      );
      const ownerId = 'memory-fixture-owner';
      const store = createFilesystemObjectStore(root);
      const memory = createMemoryService({ pool, ownerId, store });
      const source = async (message: string, owner = ownerId) => {
        const messageId = randomUUID();
        const turnId = randomUUID();
        await pool.query(
          "INSERT INTO messages(id,owner_id,role,text,turn_id) VALUES($1,$2,'user',$3,$4)",
          [messageId, owner, message, turnId],
        );
        return { sourceMessageId: messageId, turnId };
      };
      const first = await source('Keep progress reports short.');
      const saved = await memory.save(
        {
          kind: 'preference',
          text: 'Prefers short progress reports.',
        },
        first,
      );
      assert.equal(saved.status, 'stated');
      assert.deepEqual(await memory.context(), [
        { id: saved.id, kind: 'preference', text: saved.text, status: 'stated' },
      ]);
      const reopened = createMemoryService({ pool, ownerId, store });
      assert.equal((await reopened.list())[0].text, saved.text);
      const correction = await source('Make progress reports detailed from now on.');
      const revised = await reopened.save(
        {
          id: saved.id,
          kind: 'preference',
          text: 'Prefers detailed progress reports.',
          replace: true,
        },
        correction,
      );
      assert.deepEqual(revised.sources, [correction.sourceMessageId]);
      assert.equal((await memory.context())[0].text, revised.text);
      await assert.rejects(
        memory.save(
          { kind: 'fact', text: 'Prefers a private account.' },
          { ...correction, turnId: randomUUID() },
        ),
        /current owned user message/,
      );
      const other = await source('A different owner likes long notes.', 'other-owner');
      await assert.rejects(
        memory.save(
          {
            kind: 'preference',
            text: 'Likes long notes.',
          },
          other,
        ),
        /current owned user message/,
      );
      const secret = await source('I prefer email updates. Also reset my password on the store.');
      await assert.rejects(
        memory.save({ kind: 'fact', text: 'Store password is hunter2.' }, secret),
        /cannot be remembered/,
      );
      const email = await memory.save(
        { kind: 'preference', text: 'Prefers email updates.' },
        secret,
      );
      const patternA = await source('Please show the design first.');
      const pattern = await memory.save(
        {
          kind: 'pattern',
          text: 'Often asks to see a design first.',
        },
        patternA,
      );
      assert.equal(pattern.status, 'tentative');
      const patternB = await source('Show the design before you build it.');
      const observed = await memory.save(
        {
          id: pattern.id,
          kind: 'pattern',
          text: pattern.text,
        },
        patternB,
      );
      assert.equal(observed.status, 'observed');
      assert.equal(observed.sources.length, 2);
      const factSource = await source('The museum opens on Tuesday.');
      await memory.save(
        {
          kind: 'fact',
          text: 'The museum opens on Tuesday.',
        },
        factSource,
      );
      assert.equal((await memory.context()).length, 4);
      const approved = await memory.save(
        { kind: 'fact', text: 'Lives in Lisbon.' },
        { sourceMessageId: factSource.sourceMessageId, approved: true },
      );
      assert.deepEqual(approved.sources, [factSource.sourceMessageId]);
      await assert.rejects(
        memory.save(
          { kind: 'fact', text: 'Lives in Porto.' },
          { sourceMessageId: other.sourceMessageId, approved: true },
        ),
        /current owned user message/,
      );
      const existingThread = randomUUID();
      await pool.query('CREATE TABLE threads (id uuid PRIMARY KEY, owner_id text NOT NULL)');
      await pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [existingThread, ownerId]);
      await memory.initialize();
      assert.equal(await memory.untrusted(existingThread), true);
      await memory.initialize();
      const threadId = randomUUID();
      await pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [threadId, ownerId]);
      await memory.initialize();
      assert.equal(await memory.untrusted(threadId), false);
      await memory.markUntrusted(threadId);
      await memory.markUntrusted(threadId);
      assert.equal(await memory.untrusted(threadId), true);
      assert.equal(
        await createMemoryService({ pool, ownerId: 'other-owner', store }).untrusted(threadId),
        false,
      );
      await memory.forget(saved.id);
      const path = join(root, 'memory', 'MEMORY.md');
      await writeFile(
        path,
        `${await readFile(path, 'utf8')}\n## not-an-id\nKind: fact\n\nBroken entry.\n`,
      );
      assert.deepEqual((await memory.context()).map((entry) => entry.id).includes(email.id), true);
      await memory.save({ id: email.id, kind: 'preference', text: email.text }, patternB);
      assert.equal(
        (await reopened.list()).some((entry) => entry.id === saved.id),
        false,
      );
      const file = await readFile(path, 'utf8');
      assert.doesNotMatch(file, /Broken entry/);
      assert.match(file, /# Memory/);
      assert.match(file, /Often asks to see a design first/);
      assert.doesNotMatch(file, /Keep progress reports short/);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
