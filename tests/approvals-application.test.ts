import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { AgentToolResult } from '../src/ports/agent.ts';
import { createIntegrationFixture } from '../scripts/e2e-fixtures.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';
import { accessCookie, accessKey } from '../src/server/access.ts';
import { createDecisionModel } from '../src/providers/decisions.ts';
import { BrowserActionError, type CredentialInput } from '../src/ports/computer.ts';
import { authenticatorKey } from '../src/shared/authenticator-key.ts';
import { authenticatorCode } from '../src/server/authenticator.ts';

test(
  'personal approvals revalidate targets before execution',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 120_000 },
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
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'nod-test-runtime-'));
    t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
    process.env.NOD_DATA_ROOT = runtimeRoot;
    const { createApplication } = await import('../src/server/composition.ts');
    const { pool } = await import('../src/server/db.ts');
    const { dataRoot, ownerId, port } = await import('../src/server/config.ts');
    const { enqueueTurn } = await import('../src/server/thread.ts');
    const phases = new Map<string, number>();
    const results = new Map<string, AgentToolResult>();
    const plans = new Map<
      string,
      { tool?: string; action: string; args: Record<string, unknown> }
    >();
    const batches = new Map<
      string,
      {
        subagents: boolean;
        sequential?: boolean;
        calls: Array<{ tool?: string; action: string; args: Record<string, unknown> }>;
      }
    >();
    const batchErrors: string[] = [];
    const parts = new Map<string, { action: string; args: Record<string, unknown> }>();
    let partsWaiting = 0;
    let partsArrived = () => {};
    let partsReady = Promise.resolve();
    let steering:
      { entered(turnId: string): void; wait: Promise<void>; messages: string[] } | undefined;
    const ids: string[] = [];
    const asked = new Set<string>();
    const cleared = new Set<string>();
    const confirmationText = 'Proceed with the saved synthetic action?';
    let confirmationValid = true;
    let beforeConfirmation = async () => {};
    let decisionsEnabled = true;
    let decisionCost: number | undefined;
    let checkCost: number | undefined;
    let refusedDecision = '';
    const decisionInputs: Array<{ name: string; input: Record<string, any> }> = [];
    const fallbackChecks: object[] = [];
    const executedApps: string[] = [];
    const uploads: string[] = [];
    const workspaceFiles = new Map<string, Uint8Array>();
    const browserActs: Array<Record<string, unknown>> = [];
    const injected: CredentialInput[] = [];
    let browserUrl = 'https://bank.example.test/transfer';
    let allowMethodBrowser = false;
    let methodBindings = 0;
    let dialogOpen = false;
    let formTarget = 'https://bank.example.test/transfer/send';
    let appOutage = false;
    let appResult: unknown;
    let repeatAfterConfirm: { action: string; args: Record<string, unknown> } | undefined;
    const prompts = new Map<string, string>();
    const integrationFixture = createIntegrationFixture(`http://localhost:${port}`);
    const { createModelService } = await import('../src/server/models.ts');
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    const models = createModelService({
      database: pool,
      ownerId,
      origin: `http://localhost:${port}`,
      keyStore: { id: 'fixture', configured: true, getKey: async () => Buffer.alloc(32, 7) },
      backend: createPiModelBackend({
        fetch: async (input) => {
          assert.equal(String(input), 'https://api.openai.com/v1/models');
          return Response.json({ data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna' }] });
        },
      }),
    });
    await models.initialize();
    await models.addKey('openai', 'synthetic-model-key');
    t.after(() => models.close());
    const application = await createApplication(
      {
        models,
        agent: {
          async open(options) {
            const phase = phases.get(options.turnId) ?? 0;
            phases.set(options.turnId, phase + 1);
            const held = steering;
            steering = undefined;
            return {
              resumed: phase > 0,
              abort() {},
              dispose() {},
              async prompt(text) {
                prompts.set(options.turnId, text);
                const tool = (name: string) => options.tools.find((item) => item.name === name)!;
                if (repeatAfterConfirm && text.includes('executed once by the trusted worker')) {
                  const call = repeatAfterConfirm;
                  repeatAfterConfirm = undefined;
                  results.set(options.turnId, await tool('apps').execute(call));
                  return;
                }
                const part = parts.get(
                  /one part of the owner's request: (\S+)/.exec(text)?.[1] ?? '',
                );
                if (part) {
                  if (--partsWaiting === 0) partsArrived();
                  await partsReady;
                  await tool('apps')
                    .execute(part)
                    .catch(() => {});
                  return;
                }
                const batch =
                  phase === 0
                    ? batches.get(
                        JSON.parse(text.split('Request data (JSON):\n')[1]!.split('\n')[0]!)
                          .currentInstruction,
                      )
                    : undefined;
                if (batch) {
                  if (batch.sequential) {
                    for (const call of batch.calls) await tool('apps').execute(call);
                    return;
                  }
                  await Promise.allSettled(
                    batch.calls.map((call, index) => {
                      if (call.tool)
                        return tool(call.tool)
                          .execute({ action: call.action, ...call.args })
                          .catch((error: Error) => batchErrors.push(error.message));
                      if (!batch.subagents) return tool('apps').execute(call);
                      const title = `${options.turnId}-${index}`;
                      parts.set(title, call);
                      return tool('delegate').execute({ title, instruction: 'Run this part.' });
                    }),
                  );
                  return;
                }
                if (held) {
                  held.entered(options.turnId);
                  await held.wait;
                  const messages = (await options.nextMessages?.()) ?? [];
                  held.messages.push(...messages.map((message) => message.text));
                  assert.equal(messages.length, 1);
                  text = messages[0]!.text;
                }
                const plan =
                  phase === 0
                    ? plans.get(
                        JSON.parse(text.split('Request data (JSON):\n')[1]!.split('\n')[0]!)
                          .currentInstruction,
                      )
                    : undefined;
                if (plan) {
                  const result = await options.tools
                    .find((tool) => tool.name === (plan.tool ?? 'manage_personal_context'))!
                    .execute(
                      plan.tool === 'browser' || plan.tool === 'sign_in'
                        ? { action: plan.action, ...plan.args }
                        : { action: plan.action, args: plan.args },
                    );
                  results.set(options.turnId, result);
                  return;
                }
                options.onEvent({ type: 'final', text: 'Synthetic personal request handled.' });
              },
            };
          },
          dispose() {},
        },
        computer: fakeComputer({
          signInMethods: async (_browser, origin, methods) => {
            methodBindings++;
            return {
              document: 'synthetic-sign-in-document',
              methods: methods.map((method) => ({
                id: randomUUID(),
                label: method.label,
                page: {
                  origin,
                  url: `${origin}/sign-in`,
                  controls: [{ role: 'button', name: method.label }],
                },
              })),
            };
          },
          selectSignInMethod: async () => {
            throw new Error('This fixture never selects a method.');
          },
          injectCredentials: async (input) => {
            injected.push(input);
            return { status: 'submitted' };
          },
          act: async (_id, input) => {
            browserActs.push({ ...input });
            return { text: 'Synthetic bank page', url: 'https://bank.example.test/transfer' };
          },
          download: async (_id, input) => {
            if (input.selector && !input.expectOrigin)
              throw new BrowserActionError('browser_download_control');
            return {
              bytes: Buffer.from('synthetic'),
              name: 'synthetic.pdf',
              mimeType: 'application/pdf',
            };
          },
          currentPage: async (_id, step) => {
            if (dialogOpen && step?.action !== 'accept_dialog')
              throw new Error('A JavaScript dialog blocks the page.');
            return {
              origin: 'https://bank.example.test',
              url: browserUrl,
              ...(step?.action === 'accept_dialog'
                ? { dialog: 'Send 120 EUR to the synthetic payee?' }
                : step
                  ? {
                      controls: [{ role: 'button', name: 'Authorize payment' }],
                      ...(step.action === 'click'
                        ? { submits: { method: 'POST', to: formTarget } }
                        : {}),
                    }
                  : {}),
            };
          },
        }),
        workspace: fakeWorkspace({
          readArtifact: async (_threadId, path) => {
            const bytes = workspaceFiles.get(path);
            if (!bytes) throw new Error('The workspace file is unavailable.');
            return bytes;
          },
        }),
        integrations: {
          ...integrationFixture.provider,
          createSession: async (...args) => {
            const session = await integrationFixture.provider.createSession(...args);
            session.upload = async (_action, file) => {
              uploads.push(Buffer.from(file.bytes).toString());
              return { name: file.name, mimetype: file.mimeType, s3key: randomUUID() };
            };
            const execute = session.execute.bind(session);
            session.execute = async (...input) => {
              executedApps.push(input[0]);
              if (appOutage) throw new Error('Synthetic provider outage.');
              if (appResult) return appResult;
              return execute(...input);
            };
            return session;
          },
        },
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
        model: { provider: 'fixture', name: 'fixture', configured: true },
        decisions: createDecisionModel({
          resolve: async () =>
            decisionsEnabled ? { provider: 'openai', key: 'fixture-decision-key' } : undefined,
          fetch: async (_url, options) => {
            const body = JSON.parse(String(options?.body));
            const name = body.questions[0].name as string;
            const input = JSON.parse(body.input);
            decisionInputs.push({ name, input });
            if (name === refusedDecision)
              return Response.json({
                answers: [{ name, type: 'refusal' }],
                usage: { input_tokens: 1000 },
              });
            const choice =
              ({ Yes: 'yes', No: 'no' } as Record<string, string>)[String(input.reply)] ?? 'other';
            return Response.json({
              answers: [{ name, type: 'choice', choice }],
              usage: { input_tokens: 1000, cost: decisionCost },
            });
          },
        }),
        onboardingCurator: {
          id: 'fixture',
          configured: true,
          curate: async ({ task, input }, _signal, report) => {
            if ('purpose' in input && input.purpose === 'confirmation') {
              await beforeConfirmation();
              return { text: confirmationText };
            }
            if ('purpose' in input && input.purpose === 'confirmation_review') {
              fallbackChecks.push(input);
              return { valid: confirmationValid };
            }
            if (task === 'review' && !('purpose' in input)) fallbackChecks.push(input);
            if (task === 'review' && 'action' in input && checkCost !== undefined)
              report?.({ id: randomUUID(), model: 'fixture', costUsd: checkCost });
            return task === 'review' && 'reply' in input
              ? {
                  answer: ({ Yes: 'yes', No: 'no' } as Record<string, string>)[String(input.reply)],
                }
              : task === 'review'
                ? (() => {
                    const words = input as {
                      userMessages?: Array<{ text: string }>;
                      action?: { name?: string; arguments?: { recipient_email?: unknown } };
                    };
                    const run =
                      (allowMethodBrowser && words.action?.name === 'NOD_browser') ||
                      asked.has(words.userMessages?.at(-1)?.text ?? '') ||
                      cleared.has(String(words.action?.arguments?.recipient_email));
                    return run
                      ? { run, because: words.userMessages?.at(-1)?.text ?? 'read' }
                      : { run };
                  })()
                : undefined;
          },
        },
      },
      { channels: false },
    );
    integrationFixture.register(application.app);
    const headers = {
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
      cookie: `${accessCookie(port)}=${await accessKey(dataRoot)}`,
    };
    const request = (
      method: 'GET' | 'POST' | 'PATCH',
      path: string,
      payload?: Record<string, unknown>,
    ) => application.app.inject({ method, url: path, headers, payload });
    async function waitFor(id: string, status: string) {
      for (let attempt = 0; attempt < 300; attempt++) {
        const turn = (await pool.query('SELECT status,error FROM turns WHERE id=$1', [id])).rows[0];
        if (status.split('|').includes(turn.status)) return;
        assert.notEqual(turn.status, 'failed', turn.error);
        await delay(20);
      }
      assert.fail(`Synthetic turn did not become ${status}.`);
    }
    async function propose(
      action: string,
      args: Record<string, unknown>,
      tool?: string,
      text = `Synthetic proposal ${randomUUID()}`,
    ) {
      plans.set(text, { tool, action, args });
      const response = await request('POST', '/api/messages', { text });
      assert.equal(response.statusCode, 200);
      const id = response.json().turnId as string;
      ids.push(response.json().threadId as string);
      await waitFor(id, tool ? 'waiting|succeeded' : 'waiting');
      return id;
    }
    const approvalsFor = async (id: string) =>
      (await pool.query('SELECT * FROM approvals WHERE turn_id=$1', [id])).rows;
    async function reminder() {
      const response = await request('POST', '/api/schedules', {
        title: 'Synthetic cancellation reminder',
        prompt: 'Review the synthetic checklist.',
        kind: 'once',
        runAt: '2099-01-01T09:00:00Z',
        timeZone: 'UTC',
      });
      assert.equal(response.statusCode, 200, response.body);
      const id = response.json().id as string;
      const { job_id: jobId } = (
        await pool.query('SELECT job_id FROM schedules WHERE id=$1 AND owner_id=$2', [id, ownerId])
      ).rows[0];
      assert.ok(jobId);
      return { id, jobId: jobId as string };
    }
    async function assertCancelled(schedule: { id: string; jobId: string }) {
      assert.deepEqual(
        (
          await pool.query(
            'SELECT enabled,job_id,next_run_at FROM schedules WHERE id=$1 AND owner_id=$2',
            [schedule.id, ownerId],
          )
        ).rows[0],
        { enabled: false, job_id: null, next_run_at: null },
      );
      assert.equal(
        (await pool.query(`SELECT state FROM ${bossSchema}.job WHERE id=$1`, [schedule.jobId]))
          .rows[0].state,
        'cancelled',
      );
      assert.deepEqual(
        (
          await pool.query(
            "SELECT id FROM approvals WHERE owner_id=$1 AND action='NOD_schedule_cancel' AND args=$2::jsonb AND status<>'expired'",
            [ownerId, { id: schedule.id }],
          )
        ).rows,
        [],
      );
    }
    try {
      await t.test(
        'model settings use the trust check and save only the approved selection',
        async () => {
          const before = models.view().selection;
          const connection = models.view().connections[0]!;
          const model = connection.models.find((item) => item.id !== before?.modelId)!;
          const input = {
            connectionId: connection.id,
            modelId: model.id,
            effort: model.efforts[0]!,
          };
          const turn = await propose('model_select', input);
          const [card] = await approvalsFor(turn);
          assert.equal(card.action, 'NOD_model_select');
          assert.deepEqual(models.view().selection, before);
          const response = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: card.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          await waitFor(response.json().turnId, 'succeeded');
          assert.deepEqual(models.view().selection, input);
          assert.equal((await approvalsFor(turn))[0].status, 'completed');
          const directText = 'Use the first connected model again.';
          asked.add(directText);
          plans.set(directText, { action: 'model_select', args: { ...before! } });
          const direct = await request('POST', '/api/messages', { text: directText });
          await waitFor(direct.json().turnId, 'succeeded');
          assert.deepEqual(models.view().selection, before);
          assert.equal((await approvalsFor(direct.json().turnId)).length, 0);
          await assert.rejects(
            application.personal.manage('model_select', {
              ...input,
              connectionId: randomUUID(),
            }),
          );
          assert.deepEqual(models.view().selection, before);
          assert.equal(models.view().connections[0]!.keyEnding, '-key');
          assert.doesNotMatch(
            JSON.stringify(await application.personal.manage('models_get', {})),
            /synthetic-model-key|keyEnding|-key/,
          );
        },
      );
      await t.test(
        'a compromised agent cannot send outside the account until the owner confirms',
        async () => {
          const connect = await request('POST', '/api/apps/gmail/connect', {});
          assert.equal(connect.statusCode, 200, connect.body);
          const accountId = new URL(connect.json().url).pathname.split('/').pop();
          const consent = await application.app.inject({
            method: 'POST',
            url: `/e2e/connect/${accountId}`,
            headers,
          });
          const callback = new URL(String(consent.headers.location));
          await application.app.inject({ url: `${callback.pathname}${callback.search}`, headers });
          const email = (to: string) => ({
            recipient_email: to,
            subject: 'Synthetic invoices',
            body: 'Synthetic forwarded content.',
          });
          const sends = () =>
            integrationFixture.writes.filter((write) => write.action === 'GMAIL_SEND_EMAIL').length;
          const held = await propose('GMAIL_SEND_EMAIL', email('collector@example.test'), 'apps');
          const cards = await approvalsFor(held);
          assert.equal(cards.length, 1, 'the send to a stranger was not held for confirmation');
          const [card] = cards;
          assert.equal(card.status, 'pending');
          assert.equal(card.args.recipient_email, 'collector@example.test');
          assert.equal(sends(), 0);
          const declined = await request('POST', '/api/messages', {
            text: 'No',
            replyToMessageId: card.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          assert.equal(declined.statusCode, 200, declined.body);
          await waitFor(declined.json().turnId, 'succeeded');
          assert.equal((await approvalsFor(held))[0].status, 'declined');
          assert.equal(sends(), 0);
        },
      );

      await t.test(
        'an approved action runs once, a failure returns to its task, and an unsaved access path is never asked about',
        async () => {
          const held = await propose(
            'GMAIL_SEND_EMAIL',
            { recipient_email: 'outage@example.test', subject: 'Synthetic', body: 'Synthetic.' },
            'apps',
          );
          const [card] = await approvalsFor(held);
          const attempts = executedApps.length;
          appOutage = true;
          try {
            const approved = await request('POST', '/api/messages', {
              text: 'Yes',
              replyToMessageId: card.confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            assert.equal(approved.statusCode, 200, approved.body);
            await waitFor(approved.json().turnId, 'succeeded');
            assert.match(
              prompts.get(approved.json().turnId) ?? '',
              /will not be retried\.[\s\S]*Synthetic provider outage/,
            );
          } finally {
            appOutage = false;
          }
          assert.equal(executedApps.length, attempts + 1);
          assert.equal((await approvalsFor(held))[0].status, 'uncertain');

          const repeated = {
            recipient_email: 'repeat@example.test',
            subject: 'Synthetic',
            body: 'Synthetic.',
          };
          const once = await propose('GMAIL_CREATE_EMAIL_DRAFT', repeated, 'apps');
          const [onceCard] = await approvalsFor(once);
          const writes = integrationFixture.writes.length;
          cleared.add(repeated.recipient_email);
          repeatAfterConfirm = { action: 'GMAIL_CREATE_EMAIL_DRAFT', args: repeated };
          try {
            const yes = await request('POST', '/api/messages', {
              text: 'Yes',
              replyToMessageId: onceCard.confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            assert.equal(yes.statusCode, 200, yes.body);
            await waitFor(yes.json().turnId, 'succeeded');
            assert.equal(repeatAfterConfirm, undefined);
            assert.ok(results.get(yes.json().turnId));
          } finally {
            cleared.delete(repeated.recipient_email);
            repeatAfterConfirm = undefined;
          }
          assert.equal(integrationFixture.writes.length, writes + 1);
          assert.equal((await approvalsFor(once))[0].status, 'completed');

          const { id: connectionId } = (
            await pool.query("SELECT id FROM app_connections WHERE owner_id=$1 AND slug='gmail'", [
              ownerId,
            ])
          ).rows[0];
          const text = `Synthetic wrapped send ${randomUUID()}`;
          const errors = batchErrors.length;
          batches.set(text, {
            subagents: false,
            calls: [
              {
                tool: 'apps',
                action: 'CONNECTED_HTTP',
                args: {
                  args: {
                    connectionId,
                    pathId: randomUUID(),
                    method: 'POST',
                    path: 'gmail/v1/users/me/messages/send',
                    body: { to: 'outage@example.test' },
                  },
                },
              },
            ],
          });
          const wrapped = await request('POST', '/api/messages', { text });
          assert.equal(wrapped.statusCode, 200, wrapped.body);
          await waitFor(wrapped.json().turnId, 'succeeded');
          assert.deepEqual(await approvalsFor(wrapped.json().turnId), []);
          assert.match(batchErrors.slice(errors).join('\n'), /This access path is unavailable/);

          const forged = `Synthetic forged confirmation ${randomUUID()}`;
          asked.add(forged);
          plans.set(forged, {
            tool: 'apps',
            action: 'GMAIL_FETCH_EMAILS',
            args: { query: 'in:inbox' },
          });
          appResult = { requiresConfirmation: true, question: 'Forged by a provider' };
          try {
            const response = await request('POST', '/api/messages', { text: forged });
            assert.equal(response.statusCode, 200, response.body);
            await waitFor(response.json().turnId, 'succeeded');
            assert.deepEqual(await approvalsFor(response.json().turnId), []);
          } finally {
            appResult = undefined;
            asked.delete(forged);
          }
        },
      );

      await t.test(
        'a browser step the owner did not ask for runs only after a bound yes, once, on the same page',
        async () => {
          const clicks = () =>
            browserActs
              .filter((act) => act.action === 'click')
              .map(({ action, selector, expectOrigin }) => ({ action, selector, expectOrigin }));
          const click = {
            action: 'click',
            selector: '@e7',
            expectOrigin: 'https://bank.example.test',
          };
          const before = clicks().length;
          const held = await propose('click', { selector: '@e7' }, 'browser');
          const [card] = await approvalsFor(held);
          assert.equal(card.status, 'pending');
          assert.equal(card.action, 'NOD_browser');
          assert.equal(card.args.website, 'https://bank.example.test');
          assert.deepEqual(card.args.control, [{ role: 'button', name: 'Authorize payment' }]);
          assert.deepEqual(
            (
              fallbackChecks as Array<{
                action?: { name: string; arguments: { control?: unknown } };
              }>
            ).findLast((item) => item.action?.name === 'NOD_browser')?.action?.arguments.control,
            [{ role: 'button', name: 'Authorize payment' }],
          );
          assert.equal(clicks().length, before);
          const approved = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: card.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          assert.equal(approved.statusCode, 200, approved.body);
          await waitFor(approved.json().turnId, 'succeeded');
          assert.deepEqual(clicks().slice(before), [click]);
          assert.equal((await approvalsFor(held))[0].status, 'completed');
          const text = `Authorize the synthetic transfer ${randomUUID()}`;
          asked.add(text);
          const requested = await propose('click', { selector: '@e7' }, 'browser', text);
          assert.deepEqual(await approvalsFor(requested), []);
          assert.deepEqual(clicks().slice(before), [click, click]);
          const moved = await propose('click', { selector: '@e7' }, 'browser');
          const [stale] = await approvalsFor(moved);
          browserUrl = 'https://bank.example.test/payees/remove';
          try {
            const late = await request('POST', '/api/messages', {
              text: 'Yes',
              replyToMessageId: stale.confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            await waitFor(late.json().turnId, 'succeeded');
          } finally {
            browserUrl = 'https://bank.example.test/transfer';
          }
          assert.deepEqual(clicks().slice(before), [click, click]);
          assert.equal((await approvalsFor(moved))[0].status, 'expired');
          const retargeted = await propose('click', { selector: '@e7' }, 'browser');
          const [sent] = await approvalsFor(retargeted);
          assert.deepEqual(sent.args.submits, {
            method: 'POST',
            to: 'https://bank.example.test/transfer/send',
          });
          formTarget = 'https://bank.example.test/payees/remove';
          try {
            const late = await request('POST', '/api/messages', {
              text: 'Yes',
              replyToMessageId: sent.confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            await waitFor(late.json().turnId, 'succeeded');
          } finally {
            formTarget = 'https://bank.example.test/transfer/send';
          }
          assert.deepEqual(clicks().slice(before), [click, click]);
          assert.equal((await approvalsFor(retargeted))[0].status, 'expired');
          const download = await propose('download', { selector: '@e7' }, 'browser');
          const [unclicked] = await approvalsFor(download);
          assert.equal(unclicked.status, 'pending');
          const declined = await request('POST', '/api/messages', {
            text: 'No',
            replyToMessageId: unclicked.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          await waitFor(declined.json().turnId, 'succeeded');
          assert.deepEqual(clicks().slice(before), [click, click]);
          dialogOpen = true;
          try {
            const dialog = await propose('accept_dialog', {}, 'browser');
            const [card] = await approvalsFor(dialog);
            assert.equal(card.args.dialog, 'Send 120 EUR to the synthetic payee?');
            assert.equal(browserActs.filter((act) => act.action === 'accept_dialog').length, 0);
            const accepted = await request('POST', '/api/messages', {
              text: 'Yes',
              replyToMessageId: card.confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            await waitFor(accepted.json().turnId, 'succeeded');
            assert.equal((await approvalsFor(dialog))[0].status, 'completed');
          } finally {
            dialogOpen = false;
          }
          assert.equal(browserActs.filter((act) => act.action === 'accept_dialog').length, 1);
        },
      );

      await t.test(
        'a rejected generated confirmation cannot create an approval or send an email',
        async () => {
          const writes = integrationFixture.writes.length;
          const text = `Synthetic rejected confirmation ${randomUUID()}`;
          plans.set(text, {
            tool: 'apps',
            action: 'GMAIL_SEND_EMAIL',
            args: {
              recipient_email: 'blocked@example.test',
              subject: 'Synthetic reviewed email',
              body: 'Synthetic body awaiting confirmation.',
            },
          });
          confirmationValid = false;
          try {
            const response = await request('POST', '/api/messages', { text });
            assert.equal(response.statusCode, 200, response.body);
            const turn = response.json().turnId as string;
            ids.push(response.json().threadId as string);
            await waitFor(turn, 'failed|succeeded|waiting');
            assert.deepEqual(await approvalsFor(turn), []);
            assert.equal(
              (
                await pool.query(
                  "SELECT id FROM messages WHERE turn_id=$1 AND role='assistant' AND text=$2",
                  [turn, confirmationText],
                )
              ).rowCount,
              0,
            );
            assert.equal(integrationFixture.writes.length, writes);
          } finally {
            confirmationValid = true;
          }
        },
      );

      await t.test(
        'a schedule changed during confirmation generation cannot save a stale approval',
        async () => {
          const schedule = await reminder();
          const text = `Synthetic stale schedule confirmation ${randomUUID()}`;
          plans.set(text, { action: 'schedule_cancel', args: { id: schedule.id } });
          beforeConfirmation = async () => {
            const changed = await request('PATCH', `/api/schedules/${schedule.id}`, {
              title: 'A different synthetic reminder',
              prompt: 'Review a different synthetic checklist.',
            });
            assert.equal(changed.statusCode, 200, changed.body);
          };
          try {
            const response = await request('POST', '/api/messages', { text });
            assert.equal(response.statusCode, 200, response.body);
            const turn = response.json().turnId as string;
            await waitFor(turn, 'failed|succeeded|waiting');
            assert.deepEqual(await approvalsFor(turn), []);
            assert.equal(
              (
                await pool.query(
                  "SELECT id FROM messages WHERE turn_id=$1 AND role='assistant' AND text=$2",
                  [turn, confirmationText],
                )
              ).rowCount,
              0,
            );
            const current = (
              await pool.query('SELECT title,enabled FROM schedules WHERE id=$1', [schedule.id])
            ).rows[0];
            assert.equal(current.title, 'A different synthetic reminder');
            assert.equal(current.enabled, true);
          } finally {
            beforeConfirmation = async () => {};
          }
        },
      );

      await t.test(
        "spending limits the owner didn't ask for change only after their yes",
        async () => {
          const limits = async () => {
            const view = (await request('GET', '/api/trust')).json();
            return { limit: view.limit, taskUsd: view.taskUsd };
          };
          const before = await limits();
          const unasked = await propose('limits_update', { monthlyUsd: 500, taskUsd: null });
          const [approval] = await approvalsFor(unasked);
          assert.equal(approval.status, 'pending');
          assert.deepEqual(await limits(), before);
          const confirmed = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: approval.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          assert.equal(confirmed.statusCode, 200, confirmed.body);
          await waitFor(confirmed.json().turnId, 'succeeded');
          assert.equal((await approvalsFor(unasked))[0].status, 'completed');
          assert.deepEqual(await limits(), {
            limit: { monthlyUsd: 500, reached: false },
            taskUsd: null,
          });
        },
      );

      await t.test(
        "memory forgets a note or stops saving only after the owner's yes when they didn't ask",
        async () => {
          const memory = async () => (await request('GET', '/api/memory')).json();
          const saved = await request('POST', '/api/memory/notes', {
            area: 'preferences',
            text: 'Prefers synthetic green tea.',
          });
          assert.equal(saved.statusCode, 200, saved.body);
          const path = saved.json().path as string;
          const listed = async () =>
            (await memory()).notes.some((note: { path: string }) => note.path === path);
          const stale = await propose('memory_forget', { path });
          const [asked] = await approvalsFor(stale);
          assert.equal(asked.status, 'pending');
          const edited = await request('PATCH', `/api/memory/notes/${path}`, {
            text: 'Prefers synthetic jasmine tea.',
          });
          assert.equal(edited.statusCode, 200, edited.body);
          const refused = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: asked.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          assert.equal(refused.statusCode, 200, refused.body);
          await waitFor(refused.json().turnId, 'succeeded');
          assert.match(prompts.get(refused.json().turnId) ?? '', /did not run/);
          assert.equal((await approvalsFor(stale))[0].status, 'expired');
          assert.equal(await listed(), true);
          const forget = await propose('memory_forget', { path });
          const [approval] = await approvalsFor(forget);
          assert.equal(approval.status, 'pending');
          const confirmed = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: approval.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          assert.equal(confirmed.statusCode, 200, confirmed.body);
          await waitFor(confirmed.json().turnId, 'succeeded');
          assert.equal((await approvalsFor(forget))[0].status, 'completed');
          assert.equal(await listed(), false);

          const text = `Synthetic proposal ${randomUUID()}`;
          const off = await propose(
            'memory_control',
            { enabled: false, quote: text },
            undefined,
            text,
          );
          const [held] = await approvalsFor(off);
          assert.equal(held.status, 'pending');
          assert.equal((await memory()).saving, true);
          const stopped = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: held.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          assert.equal(stopped.statusCode, 200, stopped.body);
          await waitFor(stopped.json().turnId, 'succeeded');
          assert.equal((await approvalsFor(off))[0].status, 'completed');
          assert.equal((await memory()).saving, false);
          await request('PATCH', '/api/memory', { saving: true });
        },
      );

      await t.test(
        'schedule confirmations cannot mutate a revision edited after the question was saved',
        async () => {
          for (const action of ['schedule_cancel', 'schedule_update']) {
            const schedule = await reminder();
            const args = {
              id: schedule.id,
              ...(action === 'schedule_update' ? { title: 'The proposed synthetic title' } : {}),
            };
            const turn = await propose(action, args);
            const [approval] = await approvalsFor(turn);
            assert.equal(approval.expected_revision, 0);
            const changed = await request('PATCH', `/api/schedules/${schedule.id}`, {
              title: 'A newer synthetic reminder',
              prompt: 'Review the newer synthetic checklist.',
            });
            assert.equal(changed.statusCode, 200, changed.body);
            const saved = (
              await pool.query('SELECT * FROM schedules WHERE id=$1 AND owner_id=$2', [
                schedule.id,
                ownerId,
              ])
            ).rows[0];
            const job = (
              await pool.query(`SELECT * FROM ${bossSchema}.job WHERE id=$1`, [saved.job_id])
            ).rows[0];
            const response = await request('POST', '/api/messages', {
              text: 'Yes',
              replyToMessageId: approval.confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            assert.equal(response.statusCode, 200, response.body);
            await waitFor(response.json().turnId, 'succeeded');
            assert.match(prompts.get(response.json().turnId) ?? '', /did not run/);
            assert.equal((await approvalsFor(turn))[0].status, 'expired');
            assert.deepEqual(
              (await pool.query('SELECT * FROM schedules WHERE id=$1', [schedule.id])).rows[0],
              saved,
            );
            assert.deepEqual(
              (await pool.query(`SELECT * FROM ${bossSchema}.job WHERE id=$1`, [saved.job_id]))
                .rows[0],
              job,
            );
            assert.deepEqual(approval.args, args);
            const fresh = await propose(action, args);
            const [reviewed] = await approvalsFor(fresh);
            assert.equal(reviewed.expected_revision, saved.revision);
            const confirmed = await request('POST', '/api/messages', {
              text: 'Yes',
              replyToMessageId: reviewed.confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            assert.equal(confirmed.statusCode, 200, confirmed.body);
            await waitFor(confirmed.json().turnId, 'succeeded');
            assert.equal((await approvalsFor(fresh))[0].status, 'completed');
            const applied = (
              await pool.query('SELECT revision,title,enabled FROM schedules WHERE id=$1', [
                schedule.id,
              ])
            ).rows[0];
            assert.equal(applied.revision, saved.revision + 1);
            assert.equal(applied.enabled, action !== 'schedule_cancel');
            assert.equal(applied.title, args.title ?? saved.title);
          }
        },
      );

      await t.test(
        'legacy schedule approvals without a saved revision cannot execute',
        async () => {
          const schedule = await reminder();
          const turn = await propose('schedule_cancel', { id: schedule.id });
          const [approval] = await approvalsFor(turn);
          await pool.query('UPDATE approvals SET expected_revision=NULL WHERE id=$1', [
            approval.id,
          ]);
          const response = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: approval.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          assert.equal(response.statusCode, 200, response.body);
          await waitFor(response.json().turnId, 'succeeded');
          assert.equal((await approvalsFor(turn))[0].status, 'expired');
          assert.deepEqual(
            (
              await pool.query('SELECT revision,enabled,job_id FROM schedules WHERE id=$1', [
                schedule.id,
              ])
            ).rows[0],
            { revision: 0, enabled: true, job_id: schedule.jobId },
          );
        },
      );

      await t.test(
        'schedule execution rechecks the saved revision after waiting for its row lock',
        async () => {
          const schedule = await reminder();
          const turn = await propose('schedule_cancel', { id: schedule.id });
          const [approval] = await approvalsFor(turn);
          const job = (
            await pool.query(`SELECT * FROM ${bossSchema}.job WHERE id=$1`, [schedule.jobId])
          ).rows[0];
          const editor = await pool.connect();
          let execution: string | undefined;
          try {
            await editor.query('BEGIN');
            await editor.query('SELECT id FROM schedules WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
              schedule.id,
              ownerId,
            ]);
            const response = await request('POST', '/api/messages', {
              text: 'Yes',
              replyToMessageId: approval.confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            assert.equal(response.statusCode, 200, response.body);
            execution = response.json().turnId as string;
            for (let attempt = 0; attempt < 300; attempt++) {
              if ((await approvalsFor(turn))[0].status === 'executing') break;
              await delay(20);
            }
            assert.equal((await approvalsFor(turn))[0].status, 'executing');
            await editor.query(
              'UPDATE schedules SET title=$3,revision=revision+1 WHERE id=$1 AND owner_id=$2',
              [schedule.id, ownerId, 'Concurrently edited synthetic reminder'],
            );
            await editor.query('COMMIT');
            await waitFor(execution, 'succeeded');
            assert.match(prompts.get(execution) ?? '', /will not be retried/);
            assert.equal((await approvalsFor(turn))[0].status, 'uncertain');
            assert.deepEqual(
              (
                await pool.query('SELECT title,enabled,job_id FROM schedules WHERE id=$1', [
                  schedule.id,
                ])
              ).rows[0],
              {
                title: 'Concurrently edited synthetic reminder',
                enabled: true,
                job_id: schedule.jobId,
              },
            );
            assert.deepEqual(
              (await pool.query(`SELECT * FROM ${bossSchema}.job WHERE id=$1`, [schedule.jobId]))
                .rows[0],
              job,
            );
          } finally {
            await editor.query('ROLLBACK');
            editor.release();
            if (execution) await waitFor(execution, 'failed|succeeded');
          }
        },
      );

      await t.test(
        'a read the checker holds runs only after the bound approval is accepted',
        async () => {
          const before = executedApps.filter((action) => action === 'GMAIL_FETCH_EMAILS').length;
          const turn = await propose(
            'GMAIL_FETCH_EMAILS',
            { query: 'in:inbox' },
            'apps',
            'Ask before reading my synthetic inbox.',
          );
          const [pending] = await approvalsFor(turn);
          assert.equal(pending.status, 'pending');
          assert.equal(pending.action, 'GMAIL_FETCH_EMAILS');
          assert.equal(
            executedApps.filter((action) => action === 'GMAIL_FETCH_EMAILS').length,
            before,
          );
          const response = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: pending.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          assert.equal(response.statusCode, 200, response.body);
          await waitFor(response.json().turnId, 'succeeded');
          assert.equal((await approvalsFor(turn))[0].status, 'completed');
          assert.equal(
            executedApps.filter((action) => action === 'GMAIL_FETCH_EMAILS').length,
            before + 1,
          );
        },
      );

      await t.test('tool discovery runs without waiting for the checker', async () => {
        const turn = await propose('SEARCH_TOOLS', { query: 'gmail email' }, 'apps');
        const result = results.get(turn);
        assert.ok(result);
        assert.equal((await approvalsFor(turn)).length, 0);
      });

      await t.test(
        'parallel app calls in one turn open one confirmation, in a batch or across subagents',
        async () => {
          const sends = () =>
            integrationFixture.writes.filter((write) => write.action === 'GMAIL_SEND_EMAIL').length;
          for (const subagents of [false, true]) {
            partsWaiting = 2;
            partsReady = new Promise<void>((resolve) => {
              partsArrived = resolve;
            });
            const text = `Synthetic parallel sends ${randomUUID()}`;
            batches.set(text, {
              subagents,
              calls: ['first', 'second'].map((name) => ({
                action: 'GMAIL_SEND_EMAIL',
                args: {
                  recipient_email: `${name}@example.test`,
                  subject: 'Synthetic invoices',
                  body: 'Synthetic content.',
                },
              })),
            });
            const response = await request('POST', '/api/messages', { text });
            assert.equal(response.statusCode, 200, response.body);
            const turn = response.json().turnId as string;
            if (subagents) {
              const reached = await Promise.race([
                partsReady.then(() => true),
                delay(5000, false, { ref: false }),
              ]);
              partsArrived();
              assert.ok(reached, 'Both synthetic subagents must start before either uses an app.');
            }
            await waitFor(turn, 'waiting');
            const cards = await approvalsFor(turn);
            assert.deepEqual(
              cards.map((card) => card.status),
              ['pending'],
            );
            assert.equal(
              (
                await pool.query("SELECT id FROM messages WHERE turn_id=$1 AND role='assistant'", [
                  turn,
                ])
              ).rowCount,
              1,
            );
            assert.equal(sends(), 0);
            const declined = await request('POST', '/api/messages', {
              text: 'No',
              replyToMessageId: cards[0].confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            assert.equal(declined.statusCode, 200, declined.body);
            await waitFor(declined.json().turnId, 'succeeded');
          }
        },
      );

      await t.test('an allowed send issued after one that asks never runs', async () => {
        cleared.add('allowed@example.test');
        const text = `Synthetic ordered sends ${randomUUID()}`;
        batches.set(text, {
          subagents: false,
          calls: ['asked', 'allowed'].map((name) => ({
            action: 'GMAIL_SEND_EMAIL',
            args: {
              recipient_email: `${name}@example.test`,
              subject: 'Synthetic invoices',
              body: 'Synthetic content.',
            },
          })),
        });
        const response = await request('POST', '/api/messages', { text });
        assert.equal(response.statusCode, 200, response.body);
        const turn = response.json().turnId as string;
        await waitFor(turn, 'waiting');
        const cards = await approvalsFor(turn);
        assert.deepEqual(
          cards.map((card) => [card.status, card.args.recipient_email]),
          [['pending', 'asked@example.test']],
        );
        assert.equal(
          integrationFixture.writes.filter((write) => write.action === 'GMAIL_SEND_EMAIL').length,
          0,
        );
        const declined = await request('POST', '/api/messages', {
          text: 'No',
          replyToMessageId: cards[0].confirmation_message_id,
          clientMessageId: randomUUID(),
        });
        assert.equal(declined.statusCode, 200, declined.body);
        await waitFor(declined.json().turnId, 'succeeded');
        cleared.clear();
      });

      await t.test('a skill save issued after a call that asks never runs', async () => {
        const text = `Synthetic skill after an ask ${randomUUID()}`;
        batches.set(text, {
          subagents: false,
          calls: [
            {
              action: 'GMAIL_SEND_EMAIL',
              args: {
                recipient_email: 'asked@example.test',
                subject: 'Synthetic invoices',
                body: 'Synthetic content.',
              },
            },
            {
              tool: 'skills',
              action: 'save',
              args: {
                name: 'synthetic-portal-export',
                description: 'Use when exporting from the synthetic portal.',
                body: 'Open Synthetic Exports.',
              },
            },
          ],
        });
        batchErrors.length = 0;
        const response = await request('POST', '/api/messages', { text });
        assert.equal(response.statusCode, 200, response.body);
        const turn = response.json().turnId as string;
        await waitFor(turn, 'waiting');
        assert.deepEqual(batchErrors, [
          "This turn is waiting for the owner's answer. Ask again after it.",
        ]);
        const [card] = await approvalsFor(turn);
        const declined = await request('POST', '/api/messages', {
          text: 'No',
          replyToMessageId: card.confirmation_message_id,
          clientMessageId: randomUUID(),
        });
        assert.equal(declined.statusCode, 200, declined.body);
        await waitFor(declined.json().turnId, 'succeeded');
      });

      await t.test(
        'a schedule cancellation steered into a confirmed turn uses the fresh owner request',
        async () => {
          const schedule = await reminder();
          const proposed = await propose('notification_preferences_update', {
            notificationRule: 'Synthetic confirmed preference',
          });
          const [approval] = await approvalsFor(proposed);
          let enter!: (turnId: string) => void;
          const entered = new Promise<string>((resolve) => {
            enter = resolve;
          });
          let release!: () => void;
          const wait = new Promise<void>((resolve) => {
            release = resolve;
          });
          const messages: string[] = [];
          steering = { entered: enter, wait, messages };
          try {
            const confirmed = await request('POST', '/api/messages', {
              text: 'Yes',
              replyToMessageId: approval.confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            assert.equal(confirmed.statusCode, 200, confirmed.body);
            const resumed = confirmed.json().turnId as string;
            assert.equal(
              await Promise.race([
                entered,
                delay(6000, undefined, { ref: false }).then(() => {
                  throw new Error('Synthetic confirmed turn did not start.');
                }),
              ]),
              resumed,
            );
            assert.equal((await approvalsFor(proposed))[0].status, 'completed');
            const text = 'Cancel the synthetic reminder now.';
            asked.add(text);
            plans.set(text, { action: 'schedule_cancel', args: { id: schedule.id } });
            const cancellation = await request('POST', '/api/messages', {
              text,
              clientMessageId: randomUUID(),
            });
            assert.equal(cancellation.statusCode, 200, cancellation.body);
            release();
            await waitFor(resumed, 'succeeded');
            assert.equal(messages.length, 1);
            assert.equal(
              (
                await pool.query('SELECT turn_id FROM messages WHERE id=$1', [
                  cancellation.json().messageId,
                ])
              ).rows[0].turn_id,
              resumed,
            );
            await assertCancelled(schedule);
          } finally {
            steering = undefined;
            release();
          }
        },
      );

      await t.test(
        'a fresh owner cancellation supersedes a background pause proposal without another approval',
        async () => {
          const schedule = await reminder();
          const trigger = 'Inspect the synthetic reminder.';
          plans.set(trigger, { action: 'schedule_cancel', args: { id: schedule.id } });
          const background = await enqueueTurn(trigger, { source: 'event' });
          await waitFor(background, 'waiting');
          const [approval] = await approvalsFor(background);
          assert.equal(approval.status, 'pending');
          const text = 'Cancel that synthetic reminder.';
          asked.add(text);
          plans.set(text, { action: 'schedule_cancel', args: { id: schedule.id } });
          const cancellation = await request('POST', '/api/messages', {
            text,
            clientMessageId: randomUUID(),
          });
          assert.equal(cancellation.statusCode, 200, cancellation.body);
          await waitFor(cancellation.json().turnId, 'succeeded');
          assert.equal((await approvalsFor(background))[0].status, 'expired');
          await assertCancelled(schedule);
        },
      );
      await t.test(
        'decision checks keep separate evidence, record usage once, and preserve the LLM path',
        async () => {
          const reset = await request('POST', '/api/conversation/reset', { threadId: ids.at(-1) });
          assert.equal(reset.statusCode, 200, reset.body);
          const before = decisionInputs.length;
          const fallback = fallbackChecks.length;
          const writes = integrationFixture.writes.length;
          const previousUsage = (
            await pool.query('SELECT id FROM model_usage WHERE owner_id=$1', [ownerId])
          ).rows.map((row) => row.id);
          const body = `${'Synthetic report. '.repeat(3500)}Final owner condition.`;
          const turn = await propose(
            'GMAIL_SEND_EMAIL',
            { recipient_email: 'decision@example.test', body },
            'apps',
          );
          const [pending] = await approvalsFor(turn);
          assert.equal(pending.status, 'pending');
          assert.equal(integrationFixture.writes.length, writes);
          assert.deepEqual(decisionInputs.slice(before), []);
          const checked = fallbackChecks.slice(fallback) as Array<Record<string, any>>;
          assert.equal(checked.length, 2);
          assert.equal(checked[0].action.arguments.body, body);
          assert.deepEqual(Object.keys(checked[1]).sort(), ['data', 'purpose', 'text']);
          assert.equal(checked[1].data.args.body, body);
          assert.equal(checked[1].text, confirmationText);
          const replyId = randomUUID();
          const accepted = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: pending.confirmation_message_id,
            clientMessageId: replyId,
          });
          assert.equal(accepted.statusCode, 200, accepted.body);
          const resumed = accepted.json().turnId;
          await waitFor(resumed, 'succeeded');
          assert.equal((await approvalsFor(turn))[0].status, 'completed');
          assert.equal(integrationFixture.writes.length, writes + 1);
          assert.deepEqual(decisionInputs.at(-1), { name: 'answer', input: { reply: 'Yes' } });
          assert.equal(fallbackChecks.length, fallback + 2);
          const rows = (
            await pool.query(
              'SELECT id,turn_id,cost_usd,details FROM model_usage WHERE owner_id=$1 AND NOT(id=ANY($2::text[])) ORDER BY created_at,id',
              [ownerId, previousUsage],
            )
          ).rows;
          assert.equal(rows.length, 1);
          assert.equal(
            rows.find((row) => row.details.operation === 'approval_reply').turn_id,
            null,
          );
          assert.deepEqual(
            rows.map((row) => row.details.operation),
            ['approval_reply'],
          );
          assert.ok(
            rows.every(
              (row) =>
                row.cost_usd === 0.0001 &&
                row.details.inputTokens === 1000 &&
                row.details.status === 'succeeded',
            ),
          );
          assert.doesNotMatch(
            JSON.stringify(rows),
            /fixture-decision-key|Synthetic report|decision@example/,
          );
          await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: pending.confirmation_message_id,
            clientMessageId: replyId,
          });
          assert.equal(integrationFixture.writes.length, writes + 1);
          decisionsEnabled = false;
          try {
            const count = decisionInputs.length;
            const held = await propose(
              'GMAIL_SEND_EMAIL',
              { recipient_email: 'fallback@example.test', body: 'Synthetic fallback.' },
              'apps',
            );
            const [card] = await approvalsFor(held);
            assert.equal(card.status, 'pending');
            const declined = await request('POST', '/api/messages', {
              text: 'No',
              replyToMessageId: card.confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            assert.equal(declined.statusCode, 200, declined.body);
            await waitFor(declined.json().turnId, 'succeeded');
            assert.equal((await approvalsFor(held))[0].status, 'declined');
            assert.equal(decisionInputs.length, count);
            assert.equal(fallbackChecks.length, fallback + 5);
          } finally {
            decisionsEnabled = true;
          }
        },
      );

      await t.test('a refused reply check never approves', async () => {
        const writes = integrationFixture.writes.length;
        const turn = await propose(
          'GMAIL_SEND_EMAIL',
          { recipient_email: 'refused@example.test', body: 'Synthetic refused reply.' },
          'apps',
        );
        const [card] = await approvalsFor(turn);
        assert.equal(card.status, 'pending');
        refusedDecision = 'answer';
        try {
          const reply = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: card.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          assert.equal(reply.statusCode, 200, reply.body);
          const next = reply.json().turnId;
          assert.ok(next);
          await waitFor(next, 'failed|succeeded|waiting');
        } finally {
          refusedDecision = '';
        }
        assert.notEqual((await approvalsFor(turn))[0].status, 'completed');
        assert.equal(integrationFixture.writes.length, writes);
      });

      await t.test('trust check costs stop later tools at the task check-in', async () => {
        const reset = await request('POST', '/api/conversation/reset', { threadId: ids.at(-1) });
        assert.equal(reset.statusCode, 200, reset.body);
        const before = executedApps.filter((action) => action === 'GMAIL_FETCH_EMAILS').length;
        const checks = fallbackChecks.length;
        const text = `Read the synthetic inbox three times ${randomUUID()}`;
        asked.add(text);
        batches.set(text, {
          subagents: false,
          sequential: true,
          calls: Array.from({ length: 3 }, () => ({
            action: 'GMAIL_FETCH_EMAILS',
            args: { max_results: 1 },
          })),
        });
        await pool.query(
          'INSERT INTO spending_limits(owner_id,task_usd) VALUES($1,1) ON CONFLICT(owner_id) DO UPDATE SET task_usd=excluded.task_usd',
          [ownerId],
        );
        checkCost = 0.6;
        try {
          const response = await request('POST', '/api/messages', { text });
          assert.equal(response.statusCode, 200, response.body);
          const turnId = response.json().turnId;
          await waitFor(turnId, 'failed|succeeded');
          assert.equal(
            executedApps.filter((action) => action === 'GMAIL_FETCH_EMAILS').length,
            before + 2,
          );
          assert.equal(fallbackChecks.length, checks + 2);
          const rows = (
            await pool.query(
              "SELECT cost_usd,details->>'operation' AS operation FROM model_usage WHERE turn_id=$1",
              [turnId],
            )
          ).rows;
          assert.deepEqual(
            rows.filter((row) => row.operation !== 'access').map((row) => row.cost_usd),
            [0.6, 0.6],
          );
          assert.equal(rows.filter((row) => row.operation === 'access').length, 2);
        } finally {
          checkCost = undefined;
          await pool.query('DELETE FROM spending_limits WHERE owner_id=$1', [ownerId]);
        }
      });

      await t.test(
        'the spending limit blocks decision requests before provider access',
        async () => {
          const { createLedger } = await import('../src/server/ledger.ts');
          let calls = 0;
          const checked = createLedger({ pool, ownerId }).decisions(
            createDecisionModel({
              resolve: async () => {
                calls++;
                return { provider: 'openai', key: 'fixture-unused-key' };
              },
              fetch: async () => {
                throw new Error('Unexpected provider access.');
              },
            }),
          );
          const usageId = randomUUID();
          await pool.query('INSERT INTO model_usage(id,owner_id,cost_usd) VALUES($1,$2,1)', [
            usageId,
            ownerId,
          ]);
          await pool.query(
            'INSERT INTO spending_limits(owner_id,monthly_usd) VALUES($1,0.000001) ON CONFLICT(owner_id) DO UPDATE SET monthly_usd=excluded.monthly_usd',
            [ownerId],
          );
          try {
            await assert.rejects(
              checked.check({
                instructions: 'Apply policy.',
                input: {},
                question: {
                  name: 'answer',
                  choices: [
                    { value: 'yes', description: 'Approves.' },
                    { value: 'no', description: 'Declines.' },
                  ],
                },
              }),
              /spending limit was reached/,
            );
            assert.equal(calls, 0);
          } finally {
            await pool.query('DELETE FROM spending_limits WHERE owner_id=$1', [ownerId]);
            await pool.query('DELETE FROM model_usage WHERE id=$1', [usageId]);
          }
        },
      );

      await t.test(
        'a file attached to an action that asks is uploaded only after the owner approves it',
        async () => {
          const sends = () =>
            integrationFixture.writes.filter((write) => write.action === 'GMAIL_SEND_EMAIL').length;
          const before = sends();
          const send = {
            recipient_email: 'collector@example.test',
            subject: 'Synthetic report',
            body: 'Synthetic attachment.',
            attachment: { workspaceFile: 'report.pdf', mimeType: 'application/pdf' },
          };
          workspaceFiles.set('report.pdf', Buffer.from('%PDF-1.7 synthetic report'));
          const held = await propose('GMAIL_SEND_EMAIL', send, 'apps');
          const [card] = await approvalsFor(held);
          assert.equal(card.status, 'pending');
          assert.equal(card.args.attachment.workspaceFile, 'report.pdf');
          assert.deepEqual(uploads, []);
          const approved = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: card.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          await waitFor(approved.json().turnId, 'succeeded');
          assert.equal((await approvalsFor(held))[0].status, 'completed');
          assert.deepEqual(uploads, ['%PDF-1.7 synthetic report']);
          assert.equal(sends(), before + 1);
          const changed = await propose('GMAIL_SEND_EMAIL', send, 'apps');
          const [stale] = await approvalsFor(changed);
          workspaceFiles.set('report.pdf', Buffer.from('%PDF-1.7 changed report'));
          const late = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: stale.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          await waitFor(late.json().turnId, 'succeeded');
          assert.equal((await approvalsFor(changed))[0].status, 'expired');
          assert.equal(uploads.length, 1);
          assert.equal(sends(), before + 1);
        },
      );
      await t.test(
        'sign-in method selection needs exact-origin consent before binding controls',
        async () => {
          const input = {
            origin: 'https://bank.example.test',
            label: 'Synthetic bank',
            kind: 'method',
            methods: [{ label: 'Continue with Identity', selector: '@identity' }],
            message: 'Choose a sign-in method.',
          };
          allowMethodBrowser = true;
          try {
            const checks = fallbackChecks.length;
            const held = await propose('Choose sign-in', input, 'sign_in');
            const [card] = await approvalsFor(held);
            assert.ok(card);
            assert.equal(card.action, 'NOD_vault_allow');
            assert.equal(card.status, 'pending');
            assert.deepEqual(card.args, { origin: input.origin, kind: 'sign_in' });
            assert.equal(methodBindings, 0);
            assert.equal(
              (await pool.query('SELECT 1 FROM credential_requests WHERE turn_id=$1', [held]))
                .rowCount,
              0,
            );
            assert.ok(
              fallbackChecks
                .slice(checks)
                .some(
                  (check) =>
                    (check as { action?: { name?: string } }).action?.name === 'NOD_sign_in',
                ),
            );
            const declined = await request('POST', '/api/messages', {
              text: 'No',
              replyToMessageId: card.confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            await waitFor(declined.json().turnId, 'succeeded');
            assert.equal((await approvalsFor(held))[0].status, 'declined');
            const text = `Sign in to the synthetic bank ${randomUUID()}`;
            asked.add(text);
            const permitted = await propose('Choose sign-in', input, 'sign_in', text);
            assert.deepEqual(await approvalsFor(permitted), []);
            assert.equal(methodBindings, 1);
            const [form] = (
              await pool.query(
                'SELECT origin,kind,status FROM credential_requests WHERE turn_id=$1',
                [permitted],
              )
            ).rows;
            assert.deepEqual(form, { origin: input.origin, kind: 'method', status: 'pending' });
          } finally {
            allowMethodBrowser = false;
          }
        },
      );
      await t.test(
        'a saved authenticator key enters the current code only with exact-origin consent',
        async () => {
          const origin = 'https://bank.example.test';
          const authenticator =
            'otpauth://totp/Bank:owner?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Bank';
          const saved = await request('POST', '/api/vault', {
            label: 'Synthetic bank',
            origin,
            username: 'owner@bank.example.test',
            password: 'synthetic-bank-password',
            authenticatorKey: authenticator,
          });
          assert.equal(saved.statusCode, 200, saved.body);
          const login = saved.json().id as string;
          const input = {
            origin,
            label: 'Synthetic bank',
            kind: 'otp',
            passwordSelector: '@code',
            submitSelector: '@verify',
            message: 'Enter your sign-in code.',
          };
          const before = injected.length;
          const held = await propose('Enter code', input, 'sign_in');
          const [card] = await approvalsFor(held);
          assert.equal(card?.action, 'NOD_vault_allow');
          assert.equal(card.status, 'pending');
          assert.deepEqual(card.args, { origin, kind: 'sign_in', itemId: login });
          assert.equal(injected.length, before);
          const text = `Sign in to the synthetic bank ${randomUUID()}`;
          asked.add(text);
          const earliest = authenticatorCode(authenticatorKey(authenticator)!);
          const entered = await propose('Enter code', input, 'sign_in', text);
          const latest = authenticatorCode(authenticatorKey(authenticator)!);
          assert.deepEqual(await approvalsFor(entered), []);
          assert.equal(injected.length, before + 1);
          const entry = injected.at(-1)!;
          assert.equal(entry.kind, 'otp');
          assert.equal(entry.origin, origin);
          assert.ok([earliest, latest].includes(entry.code!));
          assert.equal(JSON.stringify(results.get(entered)).includes(entry.code!), false);
          assert.doesNotMatch(JSON.stringify(results.get(entered)), /JBSWY3DP|otpauth/i);
          assert.equal(
            (await pool.query('SELECT 1 FROM credential_requests WHERE turn_id=$1', [entered]))
              .rowCount,
            0,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT action,item_id,reason FROM vault_activity WHERE turn_id=$1',
                [entered],
              )
            ).rows,
            [{ action: 'code', item_id: login, reason: 'asked' }],
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
