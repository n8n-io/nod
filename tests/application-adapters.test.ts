import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { Agent } from '../src/ports/agent.ts';
import type { IntegrationProvider, IntegrationSession } from '../src/ports/integrations.ts';
import { createPiUsageTracker } from '../src/providers/pi/usage.ts';
import { initialStreamState, streamReducer } from '../src/web/lib/streams.ts';
import { fakeComputer } from './runtime-fixtures.ts';

test(
  'replacement adapters preserve artifacts, streaming, chat confirmation and memory provenance through the full application',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 45_000 },
  async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_adapters_${suffix}`;
    const bossSchema = `test_adapters_boss_${suffix}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = databaseUrl.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    process.env.DEV_INSPECTOR = 'true';
    const { createApplication } = await import('../src/server/composition.ts');
    const { pool } = await import('../src/server/db.ts');
    const { dataRoot, ownerId, port } = await import('../src/server/config.ts');
    const { events } = await import('../src/server/events.ts');
    const { welcomeGreeting } = await import('../src/server/welcome.ts');
    const integrationCalls: Array<{ action: string; args: Record<string, unknown> }> = [];
    const spoken: string[] = [];
    const browserTasks: string[] = [];
    const phases = new Map<string, number>();
    const taskIds: string[] = [];
    const streams: Array<{ taskId: string; streamId?: string; done?: boolean; text: string }> = [];
    const screen = Buffer.from('fixture-screen');
    let callback = '';
    let disposed = false;
    let prepared = 0;
    let computerDisposed = false;
    let workspaceDisposed = false;
    let shutdownConfirmed = false;
    const session: IntegrationSession = {
      id: 'replacement-session',
      authorize: async (_service, url) => {
        callback = url;
        return { accountId: 'replacement-account', url: 'https://fixture.example/connect' };
      },
      search: async () => ({
        tools: { GMAIL_FETCH_EMAILS: {}, GMAIL_SEND_EMAIL: {} },
        suggestions: [],
      }),
      execute: async (action, args) => {
        integrationCalls.push({ action, args });
        return { successful: true, data: { messages: [] } };
      },
    };
    const integrations: IntegrationProvider = {
      id: 'replacement',
      configured: true,
      webhooksConfigured: false,
      supportsSubscriptions: [],
      createSession: async () => session,
      restoreSession: async () => session,
      deleteSession: async () => {},
      inspectAccount: async () => ({ active: true, service: 'gmail' }),
      deleteAccount: async () => {},
      parseCallback: (raw) => {
        const query = raw as Record<string, string>;
        return {
          state: query.state,
          accountId: query.account_ref,
          success: query.outcome === 'ok',
        };
      },
      subscribe: async () => {
        throw new Error('No subscriptions in this fixture.');
      },
      unsubscribe: async () => {},
      verifyWebhook: async () => {
        throw new Error('No webhooks in this fixture.');
      },
      matchesSubscription: () => false,
    };
    const agent: Agent = {
      open: async (input) => {
        const phase = phases.get(input.taskId) ?? 0;
        phases.set(input.taskId, phase + 1);
        return {
          resumed: phase > 0,
          abort: () => {},
          dispose: () => {},
          prompt: async (text) => {
            const marker = 'Request data (JSON):\n';
            const markerIndex = text.indexOf(marker);
            assert.ok(markerIndex >= 0);
            const { currentInstruction } = JSON.parse(text.slice(markerIndex + marker.length));
            assert.equal(typeof currentInstruction, 'string');
            const tools = new Map(input.tools.map((tool) => [tool.name, tool]));
            const call = (name: string, args: Record<string, unknown>) =>
              tools.get(name)!.execute(args);
            if (
              currentInstruction.endsWith(
                'Use what you already know about me without repeating setup questions.',
              )
            ) {
              const connections = await call('manage_apps', { action: 'list' });
              assert.equal(connections.content[0].type, 'text');
              if (connections.content[0].type === 'text') {
                const accounts = JSON.parse(connections.content[0].text);
                assert.ok(
                  accounts.some(
                    (account: { slug: string; status: string }) =>
                      account.slug === 'gmail' && account.status === 'connected',
                  ),
                );
                assert.equal(
                  accounts.some((account: Record<string, unknown>) => 'accountId' in account),
                  false,
                );
              }
              await call('apps', { action: 'GMAIL_FETCH_EMAILS', args: { max_results: 2 } });
              const refused = await call('apps', {
                action: 'GMAIL_SEND_EMAIL',
                args: {
                  recipient_email: 'fixture@example.test',
                  subject: 'Must not send during setup',
                },
              });
              assert.deepEqual(
                refused.content[0].type === 'text' && JSON.parse(refused.content[0].text),
                {
                  status: 'rejected',
                  code: 'read_only',
                  message: 'This task can only read connected apps. It cannot change their data.',
                },
              );
              input.onEvent({
                type: 'final',
                text: 'Your inbox is connected. I can help prepare a reply.',
              });
              return;
            }
            if (phase > 0) {
              assert.match(currentInstruction, /Do not repeat/);
              input.onEvent({ type: 'message_start' });
              input.onEvent({ type: 'final', text: 'Approved action completed.' });
              input.onEvent({ type: 'message_end' });
              return;
            }
            if (
              currentInstruction === 'Fixture memory task: Review whether I prefer concise replies.'
            ) {
              await call('manage_personal_context', {
                action: 'memory_propose',
                args: { text: 'I prefer concise replies.' },
              });
              assert.equal(input.shouldStop(), true);
              return;
            }
            if (currentInstruction === 'I prefer short messages.') {
              await call('remember', { quote: 'I prefer short messages.' });
              assert.equal(input.shouldStop(), false);
              input.onEvent({ type: 'message_start' });
              input.onEvent({ type: 'final', text: 'Understood.' });
              input.onEvent({ type: 'message_end' });
              return;
            }
            if (currentInstruction === 'Fixture unrelated message') {
              input.onEvent({ type: 'message_start' });
              input.onEvent({ type: 'final', text: 'Unrelated request completed.' });
              input.onEvent({ type: 'message_end' });
              return;
            }
            if (currentInstruction === 'Fixture write task') {
              await call('apps', {
                action: 'GMAIL_SEND_EMAIL',
                args: { recipient_email: 'fixture@example.test', subject: 'Approved fixture' },
              });
              assert.equal(input.shouldStop(), true);
              return;
            }
            await call('browser', { action: 'open', url: 'https://example.com' });
            await call('browser_screenshot', {});
            await call('send_screenshot', {});
            const command = await call('shell', { command: 'fixture calculation' });
            assert.equal(command.content[0].type === 'text' && command.content[0].text, '42');
            await call('write_file', {
              path: 'result.txt',
              content: 'Replacement workspace output.',
            });
            await call('publish_artifact', { path: 'result.txt' });
            await call('apps', { action: 'GMAIL_FETCH_EMAILS', args: { max_results: 1 } });
            await call('create_audio', { text: 'Replacement speech output.' });
            input.onEvent({ type: 'message_start' });
            input.onEvent({ type: 'text_delta', text: 'Replacement providers ' });
            input.onEvent({ type: 'text_delta', text: 'completed the request.' });
            input.onEvent({ type: 'final', text: 'Replacement providers completed the request.' });
            input.onEvent({ type: 'message_end' });
            const usage = createPiUsageTracker({
              sessionId: input.taskId,
              provider: 'replacement',
              model: 'fixture',
              history: [],
            })({
              role: 'assistant',
              api: 'openai-responses',
              provider: 'replacement',
              model: 'fixture',
              responseId: 'fixture-response',
              timestamp: Date.now(),
              stopReason: 'stop',
              content: [{ type: 'text', text: 'Replacement providers completed the request.' }],
              usage: {
                input: 10,
                output: 5,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 15,
                cost: { input: 0.0005, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.001 },
              },
            });
            assert.ok(usage);
            input.onEvent(usage);
            input.onEvent(structuredClone(usage));
          },
        };
      },
      dispose: () => {
        disposed = true;
      },
    };
    const application = await createApplication(
      {
        agent,
        integrations,
        prepareComputer: async () => {
          prepared++;
        },
        confirmComputerShutdown: async () => {
          assert.equal(computerDisposed, true);
          assert.equal(workspaceDisposed, true);
          shutdownConfirmed = true;
        },
        computer: fakeComputer({
          dispose: async () => {
            computerDisposed = true;
          },
          act: async (id) => {
            browserTasks.push(id);
            return { text: 'Replacement page body', url: 'https://example.com', candidates: [] };
          },
          screenshot: async (id) => (browserTasks.includes(id) ? screen : null),
        }),
        workspace: {
          status: () => 'replacement workspace',
          dispose: () => {
            workspaceDisposed = true;
          },
          readArtifact: async (id, path) => readFile(join(dataRoot, 'workspaces', id, path)),
          open: (input) => ({
            path: `/replacement/${input.taskId}`,
            instructions: 'Synthetic replacement workspace.',
            execute: async () => '42',
            readFile: (path) => readFile(join(input.workspacePath, path), 'utf8'),
            writeFile: async (path, text) => {
              await writeFile(join(input.workspacePath, path), text);
              return 'Saved.';
            },
          }),
        },
        speech: {
          id: 'replacement',
          configured: true,
          transcribe: async () => 'Replacement transcription.',
          synthesize: async (text) => {
            spoken.push(text);
            return {
              bytes: Buffer.from('fixture-audio'),
              mimeType: 'audio/mpeg',
              fileName: 'reply.mp3',
            };
          },
        },
        keyStore: { id: 'replacement', configured: true, getKey: async () => Buffer.alloc(32, 7) },
        relevance: { id: 'replacement', configured: true, classify: async () => 'ignore' },
        model: { provider: 'replacement', name: 'Synthetic fixture agent', configured: true },
      },
      { channels: false },
    );
    const headers = { host: `localhost:${port}`, origin: `http://localhost:${port}` };
    const request = (
      method: 'GET' | 'POST' | 'PATCH',
      url: string,
      payload?: Record<string, unknown>,
    ) => application.app.inject({ method, url, headers, payload });
    const onEvent = (
      event: { type: 'refresh' } | ({ type: 'delta' } & (typeof streams)[number]),
    ) => {
      if (event.type === 'delta') streams.push(event);
    };
    const waitFor = async (id: string, status: string) => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const row = (await pool.query('SELECT status,error FROM tasks WHERE id=$1', [id])).rows[0];
        if (row?.status === status) return;
        assert.notEqual(row?.status, 'failed', row?.error);
        await delay(20);
      }
      assert.fail(`Task did not reach ${status}.`);
    };
    events.on('event', onEvent);
    try {
      assert.equal(prepared, 0);
      assert.equal((await request('POST', '/api/account/prepare', {})).statusCode, 200);
      assert.equal(prepared, 1);
      assert.equal(
        (await request('PATCH', '/api/account', { onboardingCompleted: true })).statusCode,
        200,
      );
      assert.equal(prepared, 2);
      const welcome = (
        await pool.query("SELECT id FROM tasks WHERE source_id='onboarding:welcome'")
      ).rows[0].id as string;
      taskIds.push(welcome);
      await waitFor(welcome, 'succeeded');
      assert.deepEqual(
        (await pool.query('SELECT role,text FROM messages WHERE task_id=$1', [welcome])).rows,
        [{ role: 'assistant', text: welcomeGreeting(undefined, []) }],
      );
      assert.equal((await request('POST', '/api/apps/gmail/connect')).statusCode, 200);
      const connected = new URL(callback);
      connected.searchParams.set('account_ref', 'replacement-account');
      connected.searchParams.set('outcome', 'ok');
      assert.equal((await request('GET', connected.pathname + connected.search)).statusCode, 302);
      const submitted = await request('POST', '/api/messages', { text: 'Fixture read task' });
      assert.equal(submitted.statusCode, 200);
      const id = submitted.json().taskId as string;
      taskIds.push(id);
      await waitFor(id, 'succeeded');
      assert.deepEqual(integrationCalls, [
        { action: 'GMAIL_FETCH_EMAILS', args: { max_results: 1 } },
      ]);
      assert.deepEqual(spoken, ['Replacement speech output.']);
      assert.deepEqual(browserTasks, [id, id]);
      const screenResponse = await request('GET', `/api/inspector/screen?taskId=${id}`);
      assert.equal(screenResponse.statusCode, 200);
      assert.deepEqual(screenResponse.rawPayload, screen);
      const catalog = (await request('GET', '/api/inspector/tools')).json();
      assert.equal(catalog.captureEnabled, true);
      assert.ok(catalog.tools.some((tool: { name: string }) => tool.name === 'apps'));
      const observations = (
        await request('GET', `/api/inspector/observations?taskId=${id}`)
      ).json();
      assert.ok(
        observations.calls.some(
          (call: { name: string; status: string }) =>
            call.name === 'shell' && call.status === 'succeeded',
        ),
      );
      assert.equal(observations.usage.length, 1);
      assert.equal(observations.usage[0].provider, 'replacement');
      assert.equal(observations.summary.totalTokens, 15);
      assert.equal(observations.summary.knownCostUsd, 0.001);
      const state = (await request('GET', '/api/state')).json();
      assert.equal(state.configuration.provider, 'replacement');
      const final = state.messages.find(
        (message: { text: string }) =>
          message.text === 'Replacement providers completed the request.',
      );
      assert.ok(final.streamId);
      assert.equal(
        streams
          .filter((event) => !event.done)
          .map((event) => event.text)
          .join(''),
        'Replacement providers completed the request.',
      );
      assert.ok(streams.every((event) => event.streamId === final.streamId));
      assert.equal(
        streams.some((event) => event.done),
        false,
      );
      const transient = streams.reduce(
        (current, event) => streamReducer(current, { type: 'delta', ...event }),
        initialStreamState,
      );
      assert.equal(transient.active[final.streamId]?.text, final.text);
      const reconciled = streamReducer(transient, {
        type: 'persisted',
        streamIds: [final.streamId],
      });
      assert.equal(reconciled.active[final.streamId], undefined);
      assert.ok(reconciled.completed.includes(final.streamId));
      assert.equal(
        state.messages.filter(
          (message: { streamId?: string }) => message.streamId === final.streamId,
        ).length,
        1,
      );
      const artifacts = (
        await pool.query(
          'SELECT id,name FROM artifacts WHERE owner_id=$1 AND task_id=$2 ORDER BY name',
          [ownerId, id],
        )
      ).rows;
      assert.deepEqual(
        artifacts.map((row) => row.name),
        ['reply.mp3', 'result.txt', 'screenshot.png'],
      );
      const screenshotArtifact = artifacts.find((row) => row.name === 'screenshot.png');
      const screenshotResponse = await request('GET', `/api/artifacts/${screenshotArtifact.id}`);
      assert.equal(screenshotResponse.headers['content-type'], 'image/png');
      assert.deepEqual(screenshotResponse.rawPayload, screen);
      assert.ok(
        state.messages.some((message: { attachments: Array<{ id: string }> }) =>
          message.attachments.some((attachment) => attachment.id === screenshotArtifact.id),
        ),
      );
      const artifact = artifacts.find((row) => row.name === 'result.txt');
      assert.equal(
        (await request('GET', `/api/artifacts/${artifact.id}`)).body,
        'Replacement workspace output.',
      );
      const next = await request('POST', '/api/messages', { text: 'Fixture write task' });
      assert.equal(next.statusCode, 200);
      const nextId = next.json().taskId as string;
      taskIds.push(nextId);
      await waitFor(nextId, 'waiting_user');
      assert.equal(integrationCalls.length, 1);
      const approval = (
        await pool.query('SELECT id,confirmation_message_id FROM approvals WHERE task_id=$1', [
          nextId,
        ])
      ).rows[0];
      const confirmation = {
        text: 'Yes',
        replyToMessageId: approval.confirmation_message_id,
        clientMessageId: randomUUID(),
      };
      assert.equal((await request('POST', '/api/messages', confirmation)).statusCode, 200);
      await waitFor(nextId, 'succeeded');
      assert.deepEqual(integrationCalls.at(-1), {
        action: 'GMAIL_SEND_EMAIL',
        args: { recipient_email: 'fixture@example.test', subject: 'Approved fixture' },
      });
      assert.equal(integrationCalls.length, 2);
      assert.equal((await request('POST', '/api/messages', confirmation)).json().taskId, nextId);
      assert.equal(integrationCalls.length, 2);
      assert.equal(
        (await pool.query('SELECT status FROM approvals WHERE id=$1', [approval.id])).rows[0]
          .status,
        'completed',
      );
      assert.equal(phases.get(nextId), 2);
      const memoryRequest = await request('POST', '/api/messages', {
        text: 'Fixture memory task: Review whether I prefer concise replies.',
      });
      assert.equal(memoryRequest.statusCode, 200);
      const memoryTaskId = memoryRequest.json().taskId as string;
      taskIds.push(memoryTaskId);
      await waitFor(memoryTaskId, 'waiting_user');
      const source = (
        await pool.query("SELECT id FROM messages WHERE task_id=$1 AND role='user'", [memoryTaskId])
      ).rows[0];
      const memoryApproval = (
        await pool.query(
          'SELECT id,action,args,source_message_id,confirmation_message_id FROM approvals WHERE task_id=$1',
          [memoryTaskId],
        )
      ).rows[0];
      assert.equal(memoryApproval.action, 'OTTO_memory_propose');
      assert.deepEqual(memoryApproval.args, { text: 'I prefer concise replies.' });
      assert.equal(memoryApproval.source_message_id, source.id);
      assert.equal((await pool.query('SELECT id FROM memory_facts')).rowCount, 0);
      const unrelated = await request('POST', '/api/messages', {
        text: 'Fixture unrelated message',
      });
      assert.equal(unrelated.statusCode, 200);
      const unrelatedTaskId = unrelated.json().taskId as string;
      taskIds.push(unrelatedTaskId);
      await waitFor(unrelatedTaskId, 'succeeded');
      const latestUser = (
        await pool.query(
          "SELECT id FROM messages WHERE role='user' ORDER BY created_at DESC LIMIT 1",
        )
      ).rows[0];
      assert.notEqual(latestUser.id, source.id);
      assert.equal(
        (
          await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: memoryApproval.confirmation_message_id,
            clientMessageId: randomUUID(),
          })
        ).statusCode,
        200,
      );
      await waitFor(memoryTaskId, 'succeeded');
      const memories = (await pool.query('SELECT text,source_message_id FROM memory_facts')).rows;
      assert.deepEqual(memories, [
        { text: 'I prefer concise replies.', source_message_id: source.id },
      ]);
      const savedMemory = (await request('GET', '/api/memory')).json();
      assert.equal(savedMemory[0].sourceMessageId, source.id);
      assert.equal(phases.get(memoryTaskId), 2);
      const learnedRequest = await request('POST', '/api/messages', {
        text: 'I prefer short messages.',
      });
      assert.equal(learnedRequest.statusCode, 200);
      const learnedTaskId = learnedRequest.json().taskId as string;
      taskIds.push(learnedTaskId);
      await waitFor(learnedTaskId, 'succeeded');
      assert.equal(
        (await pool.query('SELECT id FROM approvals WHERE task_id=$1', [learnedTaskId])).rowCount,
        0,
      );
      const learnedSource = (
        await pool.query("SELECT id FROM messages WHERE task_id=$1 AND role='user'", [
          learnedTaskId,
        ])
      ).rows[0];
      assert.equal(
        (
          await pool.query('SELECT source_message_id FROM memory_facts WHERE text=$1', [
            'I prefer short messages.',
          ])
        ).rows[0].source_message_id,
        learnedSource.id,
      );
      assert.equal(phases.get(learnedTaskId), 1);
      const onboarding = await request('POST', '/api/onboarding', {});
      assert.equal(onboarding.statusCode, 200);
      const onboardingId = onboarding.json().taskId as string;
      taskIds.push(onboardingId);
      await waitFor(onboardingId, 'succeeded');
      assert.equal(
        (
          await pool.query("SELECT text FROM messages WHERE task_id=$1 AND role='user'", [
            onboardingId,
          ])
        ).rows[0].text,
        'Help me get started.',
      );
      assert.deepEqual(integrationCalls.at(-1), {
        action: 'GMAIL_FETCH_EMAILS',
        args: { max_results: 2 },
      });
      assert.equal(
        integrationCalls.some(
          (call) => 'subject' in call.args && call.args.subject === 'Must not send during setup',
        ),
        false,
      );
      assert.equal(
        (await pool.query('SELECT id FROM approvals WHERE task_id=$1', [onboardingId])).rowCount,
        0,
      );
    } finally {
      events.off('event', onEvent);
      await application.app.close();
      assert.equal(disposed, true);
      assert.equal(shutdownConfirmed, true);
      const files = (await pool.query('SELECT storage_path FROM artifacts')).rows;
      await Promise.all(files.map((file) => rm(String(file.storage_path), { force: true })));
      await Promise.all(
        taskIds.map((id) => rm(join(dataRoot, 'workspaces', id), { recursive: true, force: true })),
      );
      await pool.end();
      await admin.query(`DROP SCHEMA ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
