import { actionTarget, approvalTitle } from '../src/server/action-presentation.ts';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import pg from 'pg';
import { z } from 'zod';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MemoryCurator } from '../src/ports/memory-curator.ts';
import type { AgentToolResult, AgentSessionOptions } from '../src/ports/agent.ts';
import type { MessagingTransport } from '../src/ports/messaging.ts';
import type { IntegrationBackoff, IntegrationSession } from '../src/ports/integrations.ts';
import { createIntegrationFixture } from '../scripts/e2e-fixtures.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';
import { accessCookie, accessKey } from '../src/server/access.ts';
import { createDecisionModel } from '../src/providers/decisions.ts';
import {
  BrowserActionError,
  type BrowserAction,
  type BrowserPage,
  type Computer,
  type CredentialInput,
} from '../src/ports/computer.ts';
import { authenticatorKey } from '../src/shared/authenticator-key.ts';
import { authenticatorCode } from '../src/server/authenticator.ts';
import { transaction } from '../src/server/transaction.ts';
import { createChannels } from '../src/server/channels.ts';
import type { AppState, Task } from '../src/shared/contracts.ts';
import { modelPricingSignature, type WorkUsageResponse } from '../src/shared/models.ts';
import { mergeMessages } from '../src/web/lib/chat-messages.ts';
import { ApprovalCard, ApprovalChoiceCard } from '../src/web/components/action-card.tsx';

function syntheticConfirmation(input: Record<string, unknown>) {
  const data = input.data as {
    action: string;
    args: Record<string, unknown>;
    details?: Record<string, unknown>;
    work?: { title?: string };
  };
  const { action, args } = data;
  const details = data.details ?? {};
  const target =
    details.target && typeof details.target === 'object' && !Array.isArray(details.target)
      ? (details.target as Record<string, unknown>)
      : {};
  const value = (item: unknown) => (typeof item === 'string' ? item.trim() : '');
  const accountDetails =
    details.account && typeof details.account === 'object' && !Array.isArray(details.account)
      ? (details.account as Record<string, unknown>)
      : {};
  const account = value(accountDetails.identity || accountDetails.name || details.account);
  const subject = value(args.subject || target.subject);
  const recipient = value(args.recipient_email || args.to);
  const title = approvalTitle(action).title;
  let text: string;
  let label = title;
  if (action === 'GMAIL_SEND_EMAIL') {
    text = `Can I send a Gmail email to ${recipient || 'the selected recipient'}${subject ? ` with subject “${subject}”` : ''}${account ? ` from ${account}` : ''}?`;
  } else if (action === 'GMAIL_CREATE_EMAIL_DRAFT') {
    text = `Can I save a Gmail draft to ${recipient || 'the selected recipient'}${subject ? ` with subject “${subject}”` : ''}${account ? ` in ${account}` : ''}?`;
    label = 'Save this draft';
  } else if (action === 'GMAIL_DELETE_MESSAGE') {
    const from = value(target.from);
    text = `Can I permanently delete the Gmail email${subject ? ` “${subject}”` : ''}${from ? ` from ${from}` : ''}${account ? ` in ${account}` : ''}?`;
  } else if (action === 'GMAIL_DELETE_DRAFT') {
    const to = value(target.to);
    text = `Can I permanently delete the unsent Gmail draft${subject ? ` “${subject}”` : ''}${to ? ` addressed to ${to}` : ''}${account ? ` in ${account}` : ''}?`;
  } else if (action === 'NOD_browser') {
    const control = Array.isArray(args.control)
      ? value((args.control as Array<{ name?: unknown }>).find((item) => value(item.name))?.name)
      : '';
    text = `Can I ${actionTarget(action, args, details) || 'continue on the website'}?`;
    if (args.step === 'click' && control) label = `Click “${control.slice(0, 45)}”`;
  } else if (action.startsWith('GOOGLECALENDAR_')) {
    text = target.title
      ? `Can I change ${value(target.title)} on ${value(target.startsAt)} ${value(target.timeZone)} to response ${value(args.rsvp_response)}?`
      : 'Can I change this calendar event?';
  } else if (action === 'NOD_vault_allow') {
    text = `Can I use the saved sign-in for ${account || 'this account'} at ${value(args.origin)}?`;
  } else if (action === 'NOD_memory_forget') {
    text = `Can I forget the memory note ${value(args.path)}?`;
    label = 'Forget note';
  } else if (action === 'NOD_memory_control') {
    text = `Can I turn memory saving ${args.enabled === false ? 'off' : 'on'}?`;
  } else {
    const operation = `${title[0]?.toLowerCase() ?? ''}${title.slice(1)}`;
    const destination = actionTarget(action, args, details);
    text = `Can I ${operation}${destination ? ` for ${destination}` : ''}${account ? ` in ${account}` : ''}?`;
  }
  if (data.work?.title)
    text = `For ${data.work.title}, ${text[0]?.toLowerCase() ?? ''}${text.slice(1)}`;
  if (Array.isArray(input.withheld) && input.withheld.length)
    text += ' Some details are hidden. This description is incomplete.';
  return { text, action: label };
}

const inParts =
  (name: string, options: object, cases: (t: TestContext, part: number) => Promise<void>) =>
  (part: 1 | 2 | 3) => {
    test(`${name} (${part}/3)`, options, (t) => cases(t, part));
  };

export const approvalCases = inParts(
  'personal approvals revalidate targets before execution',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 240_000 },
  async (t, part) => {
    let section = 1;
    const inPart = async (name: string, run: (t: TestContext) => Promise<void>) => {
      if (section === part) await t.test(name, run);
    };
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
    const localHome = await realpath(await mkdtemp(join(tmpdir(), 'nod-test-home-')));
    t.after(() => rm(localHome, { recursive: true, force: true }));
    const { createApplication } = await import('../src/server/composition.ts');
    const { pool } = await import('../src/server/db.ts');
    const { dataRoot, ownerId, port } = await import('../src/server/config.ts');
    const { enqueueTurn, submitUserMessage } = await import('../src/server/thread.ts');
    const phases = new Map<string, number>();
    const results = new Map<string, AgentToolResult>();
    const plans = new Map<
      string,
      { tool?: string; action: string; args: Record<string, unknown> }
    >();
    type FixtureCall = { tool?: string; action: string; args: Record<string, unknown> };
    const activePlan = new AsyncLocalStorage<string>();
    const batches = new Map<
      string,
      {
        subagents: boolean;
        sequential?: boolean;
        chatOnly?: boolean;
        calls: FixtureCall[];
        taskCalls?: FixtureCall[];
        taskResult?: string;
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
    const desktopSteps: string[] = [];
    const cleared = new Set<string>();
    const ownerWords: string[] = [];
    let decisionsEnabled = true;
    let replyCost: number | undefined;
    let checkCost: number | undefined;
    const connectionLabels: unknown[] = [];
    let confirmationValid = true;
    let confirmationModel:
      | ((input: Record<string, unknown>, responseSchema?: Record<string, unknown>) => unknown)
      | undefined;
    let httpReview: ((input: Record<string, unknown>) => Promise<unknown>) | undefined;
    let heldReview:
      | {
          purpose?: string;
          entered(signal?: AbortSignal): void;
          release: Promise<void>;
        }
      | undefined;
    const decisionInputs: Array<{ name: string; input: Record<string, any> }> = [];
    const fallbackChecks: object[] = [];
    const smallReplies: object[] = [];
    const executedApps: string[] = [];
    const draftReadArgs: Array<Record<string, unknown>> = [];
    const workspaceDispatches: string[] = [];
    let workspaceReview: ((input: object) => Promise<unknown>) | undefined;
    const uploads: string[] = [];
    let uploadFailure: Error | undefined;
    let uploadAttempts = 0;
    const workspaceFiles = new Map<string, Uint8Array>();
    const browserActs: Array<Record<string, unknown>> = [];
    const injected: CredentialInput[] = [];
    const filledCards: object[] = [];
    let privateEntryWait:
      | {
          entered(signal?: AbortSignal): void;
          release: Promise<void>;
        }
      | undefined;
    let browserUrl = 'https://bank.example.test/transfer';
    let browserOrigin = 'https://bank.example.test';
    let browserControls = [{ role: 'button', name: 'Authorize payment' }];
    let calendarBrowser: Pick<Computer, 'act' | 'currentPage'> | undefined;
    let calendarReview: ((input: object) => unknown) | undefined;
    let browserWording: ((input: Record<string, any>) => unknown) | undefined;
    let allowMethodBrowser = false;
    let methodBindings = 0;
    let dialogOpen = false;
    let formTarget = 'https://bank.example.test/transfer/send';
    const sourceRevision = 'v1';
    let sourceReads = 0;
    let toolSearch: Record<string, unknown> | undefined;
    const readOnlyActions = new Set<string>();
    let appOutage = false;
    let connectionWait: IntegrationBackoff | undefined;
    let appSessions = 0;
    let unoffered: string | undefined;
    let appResult: unknown;
    let calendarExecute: IntegrationSession['execute'] | undefined;
    let calendarSession: (() => Promise<void>) | undefined;
    let calendarReadReview: (() => Promise<void>) | undefined;
    const calendarWording: Array<Record<string, any>> = [];
    const calendarTrust: Array<Record<string, any>> = [];
    let changeRulesOnDraftRead = false;
    let changedRulesDuringDraftRead = 0;
    let repeatAfterConfirm: FixtureCall | FixtureCall[] | undefined;
    let questionAfterConfirm: string | undefined;
    let repeatDecision: 'new' | 'same' | 'uncertain' = 'same';
    let holdRepeatCheck: (() => Promise<void>) | undefined;
    let parallelRepeatWork: ((options: AgentSessionOptions) => Promise<void>) | undefined;
    let workflowUpdate: { workflowId: string; threshold: number } | undefined;
    const repeatChecks: Record<string, unknown>[] = [];
    const prompts = new Map<string, string>();
    const runtimeCommands = new Map<string, AgentSessionOptions['runTool']>();
    const advertisedMcp = new Map<string, string>();
    const opened: Array<{ turnId: string; model?: string; helper: boolean }> = [];
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
    const closingUsageId = randomUUID();
    let recordClosingUsage = false;
    let reportClosingUsage = () => {};
    const fixtureCurator: MemoryCurator = {
      id: 'fixture',
      configured: true,
      curate: async ({ task, input, instructions, responseSchema }, _signal, report) => {
        if (task === 'review' && Object(input).action?.name === 'GOOGLECALENDAR_EVENTS_GET')
          await calendarReadReview?.();
        if (String(Object(input).action?.name).startsWith('GOOGLECALENDAR_'))
          calendarTrust.push(structuredClone(input));
        if (task === 'review' && heldReview?.purpose === Object(input).purpose && heldReview) {
          const held = heldReview;
          held.entered(_signal);
          await held.release;
          _signal?.throwIfAborted();
        }
        if (
          ['confirmation', 'confirmation_review'].includes(String(Object(input).purpose)) &&
          String(Object(Object(input).data).action).startsWith('GOOGLECALENDAR_')
        )
          calendarWording.push(structuredClone(input));
        if (
          browserWording &&
          'purpose' in input &&
          ['confirmation', 'confirmation_review'].includes(String(input.purpose)) &&
          Object(Object(input).data).action === 'NOD_browser'
        )
          return browserWording(input as Record<string, any>);
        if (
          confirmationModel &&
          'purpose' in input &&
          ['confirmation', 'confirmation_review'].includes(String(input.purpose))
        )
          return confirmationModel(input as Record<string, unknown>, responseSchema);
        if (task === 'review' && 'reply' in input && 'question' in input && 'args' in input) {
          assert.match(instructions, /"probability"/);
          repeatChecks.push(input);
          await holdRepeatCheck?.();
          return { repeatedAction: repeatDecision, probability: 1 };
        }
        if ('purpose' in input && input.purpose === 'connection' && connectionLabels.length)
          return connectionLabels.shift();
        if ('purpose' in input && input.purpose === 'payment')
          return {
            text: 'Approve the synthetic payment with the private code.',
            action: 'Approve payment',
          };
        if ('purpose' in input && input.purpose === 'confirmation_review')
          return confirmationValid
            ? { valid: true }
            : { valid: false, reason: 'Synthetic action mismatch.' };
        if ('purpose' in input && input.purpose === 'confirmation') {
          return syntheticConfirmation(input as Record<string, unknown>);
        }
        if (task === 'review' && !('purpose' in input) && !('reply' in input))
          fallbackChecks.push(input);
        if (
          task === 'review' &&
          httpReview &&
          'action' in input &&
          Object(input.action).name === 'CONNECTED_HTTP'
        )
          return httpReview(input as Record<string, unknown>);
        if (
          task === 'review' &&
          calendarReview &&
          'action' in input &&
          Object(input.action).name === 'NOD_browser'
        )
          return calendarReview(input);
        if (
          task === 'review' &&
          workspaceReview &&
          'action' in input &&
          Object(input.action).name === 'NOD_workspace_command'
        )
          return workspaceReview(input);
        if (task === 'review' && 'reply' in input) {
          smallReplies.push(input);
          report?.({
            id: randomUUID(),
            model: 'fixture-small',
            inputTokens: 1000,
            costUsd: replyCost ?? 0.0001,
          });
        }
        if (task === 'review' && 'action' in input && 'schema' in Object(input.action))
          return { readOnly: readOnlyActions.has(String(Object(input.action).name)) };
        if (
          changeRulesOnDraftRead &&
          task === 'review' &&
          'action' in input &&
          Object(input.action).name === 'GMAIL_GET_DRAFT'
        ) {
          changeRulesOnDraftRead = false;
          changedRulesDuringDraftRead++;
          await pool.query('UPDATE preferences SET rules=$2 WHERE owner_id=$1', [
            ownerId,
            'Synthetic read rule changed during Trust check.',
          ]);
        }
        if (task === 'review' && 'action' in input && checkCost !== undefined)
          report?.({ id: randomUUID(), model: 'fixture', costUsd: checkCost });
        return task === 'review' && 'reply' in input
          ? {
              answer: ({ Yes: 'yes', No: 'no' } as Record<string, string>)[String(input.reply)],
            }
          : task === 'review'
            ? (() => {
                const words = input as {
                  userMessages?: Array<{ text: string; canAuthorize?: boolean }>;
                  userRules?: string;
                  action?: { name?: string; arguments?: { recipient_email?: unknown } };
                };
                ownerWords.push(...(words.userMessages ?? []).map((message) => message.text));
                const said = words.userMessages ?? [];
                const fileIndex =
                  words.action?.name?.startsWith('LOCAL_FILES_') &&
                  asked.has(said.at(-1)?.text ?? '')
                    ? said.length - 1
                    : -1;
                const fileRequest = fileIndex >= 0;
                const metadataRead = [
                  'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
                  'GMAIL_GET_DRAFT',
                  'GOOGLECALENDAR_EVENTS_GET',
                ].includes(words.action?.name ?? '');
                const readRequiresConsent =
                  metadataRead &&
                  (words.action?.name === 'GOOGLECALENDAR_EVENTS_GET'
                    ? words.userRules === 'Ask before reading Calendar.'
                    : words.userRules === 'Ask before reading Gmail.');
                const run =
                  !readRequiresConsent &&
                  (Boolean(fileRequest) ||
                    (allowMethodBrowser && words.action?.name === 'NOD_browser') ||
                    (words.action?.name !== 'COMPUTER_PRESS' &&
                      asked.has(words.userMessages?.at(-1)?.text ?? '')) ||
                    cleared.has(String(words.action?.arguments?.recipient_email)) ||
                    metadataRead);
                return run
                  ? {
                      run,
                      source:
                        words.action?.name === 'GMAIL_FETCH_EMAILS' || metadataRead
                          ? 'read'
                          : fileRequest
                            ? `message:${fileIndex}`
                            : said.length
                              ? `message:${said.length - 1}`
                              : 'read',
                      terms: [],
                    }
                  : { run, ...(readRequiresConsent ? { rule: true } : {}) };
              })()
            : undefined;
      },
    };
    const application = await createApplication(
      {
        models,
        agent: {
          async open(options) {
            runtimeCommands.set(options.turnId, options.runTool);
            for (const tool of options.tools)
              if (tool.name.startsWith('mcp__')) advertisedMcp.set(tool.name, tool.description);
            opened.push({
              turnId: options.turnId,
              model: options.model?.modelId,
              helper: options.ephemeral === true,
            });
            reportClosingUsage = () =>
              options.onEvent({
                type: 'provider_usage',
                usage: {
                  id: closingUsageId,
                  provider: 'fixture',
                  model: 'fixture',
                  category: 'agent',
                  operation: 'cache_warm',
                  status: 'cancelled',
                  durationMs: 1,
                  costUsd: 0.125,
                  pricing: 'sdk_estimate',
                },
              });
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
                if (
                  repeatAfterConfirm &&
                  (text.includes('executed once by the trusted worker') ||
                    text.includes('confirmed failed or was interrupted') ||
                    text.includes('confirmed did not run, so nothing was done'))
                ) {
                  const calls = repeatAfterConfirm;
                  repeatAfterConfirm = undefined;
                  for (const call of Array.isArray(calls) ? calls : [calls]) {
                    const name =
                      call.tool === 'synthetic_mcp'
                        ? options.tools.find((item) => item.name.endsWith('__execute_workflow'))!
                            .name
                        : (call.tool ?? 'apps');
                    results.set(
                      options.turnId,
                      await tool(name).execute(
                        call.tool === 'synthetic_mcp'
                          ? call.args
                          : call.tool === 'files' || call.tool === 'sign_in'
                            ? { action: call.action, ...call.args }
                            : call,
                      ),
                    );
                  }
                  if (!questionAfterConfirm) return;
                }
                if (questionAfterConfirm && text.includes('executed once by the trusted worker')) {
                  const question = questionAfterConfirm;
                  questionAfterConfirm = undefined;
                  await tool('ask_user').execute({ question });
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
                const planned =
                  phase === 0
                    ? batches.get(
                        JSON.parse(text.split('Request data (JSON):\n')[1]!.split('\n')[0]!)
                          .currentInstruction,
                      )
                    : undefined;
                const calls =
                  planned?.chatOnly && options.sessionId !== options.threadId
                    ? planned.taskCalls
                    : planned?.calls;
                if (planned && calls) {
                  if (planned.sequential) {
                    for (const call of calls)
                      await (call.tool
                        ? tool(call.tool).execute({ action: call.action, ...call.args })
                        : tool('apps').execute(call));
                    if (calls === planned.taskCalls && planned.taskResult)
                      options.onEvent({ type: 'final', text: planned.taskResult });
                    return;
                  }
                  await Promise.allSettled(
                    calls.map((call, index) => {
                      if (call.tool)
                        return tool(call.tool)
                          .execute({ action: call.action, ...call.args })
                          .catch((error: Error) => batchErrors.push(error.message));
                      if (!planned.subagents) return tool('apps').execute(call);
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
                const instruction =
                  phase === 0
                    ? (JSON.parse(text.split('Request data (JSON):\n')[1]!.split('\n')[0]!)
                        .currentInstruction as string)
                    : undefined;
                const plan = instruction === undefined ? undefined : plans.get(instruction);
                if (plan && instruction !== undefined) {
                  if (plan.tool === 'bash') {
                    const result = await options
                      .runTool('bash', plan.args, async () => {
                        workspaceDispatches.push(String(plan.args.command));
                        return {
                          content: [{ type: 'text', text: 'Synthetic workspace output' }],
                          exitCode: 0,
                        };
                      })
                      .catch((error: Error) => ({
                        content: [
                          { type: 'text' as const, text: JSON.stringify({ error: error.message }) },
                        ],
                      }));
                    results.set(options.turnId, result);
                    return;
                  }

                  if (plan.tool === 'synthetic_mcp' && workflowUpdate) {
                    const update = workflowUpdate;
                    workflowUpdate = undefined;
                    await options.tools
                      .find((item) => item.name.endsWith('__update_workflow'))!
                      .execute(update);
                  }
                  const name =
                    plan.tool === 'synthetic_mcp'
                      ? options.tools.find((item) => item.name.endsWith('__execute_workflow'))!.name
                      : (plan.tool ??
                        (/^(memory_|history_search|notification_preferences_)/.test(plan.action)
                          ? 'memory'
                          : 'nod'));
                  const pending = activePlan.run(instruction, () =>
                    options.tools
                      .find((tool) => tool.name === name)!
                      .execute(
                        plan.tool?.startsWith('mcp__')
                          ? (plan.args.input as Record<string, unknown>)
                          : plan.tool === 'synthetic_mcp' ||
                              plan.tool === 'send_message' ||
                              plan.tool === 'pay'
                            ? plan.args
                            : plan.tool === 'read_source'
                              ? { input: plan.args }
                              : plan.tool === 'browser' ||
                                  plan.tool === 'sign_in' ||
                                  plan.tool === 'files' ||
                                  plan.tool === 'task'
                                ? { action: plan.action, ...plan.args }
                                : { action: plan.action, args: plan.args },
                      ),
                  );
                  await parallelRepeatWork?.(options);
                  const result = await pending;
                  results.set(options.turnId, result);
                  return;
                }
                options.onEvent({ type: 'final', text: 'Synthetic personal request handled.' });
              },
            };
          },
          dispose() {
            if (recordClosingUsage) reportClosingUsage();
          },
        },
        localFilesHome: localHome,
        desktop: {
          request: async (input: { op: string } & Record<string, unknown>) => {
            const app = {
              pid: 41,
              bundle: 'com.apple.TextEdit',
              name: 'TextEdit',
              windows: [{ id: 'w-41', title: 'Notes' }],
            };
            if (input.op === 'locate') return { bundle: app.bundle, name: app.name };
            if (input.op === 'apps') return { apps: [app] };
            if (input.op === 'windows') return { windows: app.windows };
            if (input.op === 'permissions') return {};
            const tree = {
              role: 'window',
              name: 'Notes',
              children: [{ role: 'button', name: 'Delete', ref_id: '@snotes01:e7' }],
            };
            if (input.op === 'snapshot') return { tree: input.ref ? tree.children[0] : tree };
            if (input.op === 'inspect')
              return {
                tree,
                context: JSON.stringify(tree),
                state: createHash('sha256').update(JSON.stringify(tree)).digest('hex'),
              };
            desktopSteps.push(input.op);
            return { disposition: { delivery: 'delivered_verified' } };
          },
        },
        trash: {
          ready: async () => true,
          put: (path: string) => rm(path, { recursive: true }),
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
          checkoutImage: async () =>
            Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=',
              'base64',
            ),
          cardDestinations: async () => ({
            document: 'synthetic-card-document',
            destinations: {
              number: 'https://bank.example.test',
              expiry: 'https://bank.example.test',
            },
          }),
          fillCard: async (input, signal) => {
            const held = privateEntryWait;
            if (held) {
              held.entered(signal);
              await held.release;
              signal?.throwIfAborted();
            }
            filledCards.push(input);
          },
          injectCredentials: async (input, signal) => {
            const held = privateEntryWait;
            if (held) {
              held.entered(signal);
              await held.release;
              signal?.throwIfAborted();
            }
            injected.push(input);
            return { status: 'submitted' };
          },
          act: async (_id, input) => {
            if (calendarBrowser) return calendarBrowser.act(_id, input);
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
            if (calendarBrowser) return calendarBrowser.currentPage(_id, step);
            if (dialogOpen && step?.action !== 'accept_dialog')
              throw new Error('A JavaScript dialog blocks the page.');
            return {
              origin: browserOrigin,
              url: browserUrl,
              ...(step?.action === 'accept_dialog'
                ? { dialog: 'Send 120 EUR to the synthetic payee?' }
                : step
                  ? {
                      controls: browserControls,
                      ...(step.action === 'click'
                        ? { submits: { method: 'POST', to: formTarget } }
                        : {}),
                    }
                  : {}),
            };
          },
        }),
        workspace: fakeWorkspace({
          writeArtifact: async (_threadId, path, bytes) => {
            workspaceFiles.set(path, bytes);
          },
          readArtifact: async (_threadId, path) => {
            const bytes = workspaceFiles.get(path);
            if (!bytes) throw new Error('The workspace file is unavailable.');
            return bytes;
          },
        }),
        integrations: {
          ...integrationFixture.provider,
          connectionBackoff: () => connectionWait,
          createSession: async (...args) => {
            appSessions++;
            const session = await integrationFixture.provider.createSession(...args);
            await calendarSession?.();
            session.upload = async (_action, file) => {
              uploadAttempts++;
              if (uploadFailure) throw uploadFailure;
              uploads.push(Buffer.from(file.bytes).toString());
              return { name: file.name, mimetype: file.mimeType, s3key: randomUUID() };
            };
            if (unoffered) session.offers = async (action) => action !== unoffered;
            const search = session.search.bind(session);
            session.search = async (...input) =>
              toolSearch ? { tools: toolSearch, suggestions: [] } : search(...input);
            const execute = session.execute.bind(session);
            session.execute = async (...input) => {
              executedApps.push(input[0]);
              if (input[0] === 'GMAIL_GET_DRAFT') draftReadArgs.push({ ...input[1] });
              if (appOutage) throw new Error('Synthetic provider outage.');
              if (calendarExecute && input[0].startsWith('GOOGLECALENDAR_'))
                return calendarExecute(...input);
              if (appResult) return appResult;
              return execute(...input);
            };
            return session;
          },
        },
        observations: [
          {
            id: 'fixture',
            sources: async () => [
              {
                id: 'notes',
                label: 'Synthetic notes',
                description: 'Read current synthetic notes.',
                revision: sourceRevision,
                readable: true,
              },
            ],
            read: async () => {
              sourceReads++;
              return { records: [] };
            },
          },
        ],
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
            assert.notEqual(name, 'answer');
            const choice =
              ({ Yes: 'yes', No: 'no' } as Record<string, string>)[String(input.reply)] ?? 'other';
            return Response.json({
              answers: [{ name, type: 'choice', choice }],
              usage: { input_tokens: 1000, cost: replyCost },
            });
          },
        }),
        onboardingCurator: fixtureCurator,
        trustModel: 'llm',
        trustCurator: {
          ...fixtureCurator,
          id: 'fixture-small',
          curate: async (request, signal, report) => {
            assert.equal('purpose' in request.input, false);
            return fixtureCurator.curate(request, signal, report);
          },
        },
      },
      { channels: false, rateLimit: false },
    );
    integrationFixture.register(application.app);
    const headers = {
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
      cookie: `${accessCookie(port)}=${await accessKey(dataRoot)}`,
    };
    const request = (
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
      const turn = (await pool.query('SELECT status,error FROM turns WHERE id=$1', [id])).rows[0];
      assert.fail(
        `Synthetic turn did not become ${status}; status=${turn.status}, error=${turn.error ?? 'none'}.`,
      );
    }
    async function taskTurn(
      text: string,
      taskCalls?: FixtureCall[],
      options: { sequential?: boolean; wait?: string | false } = {},
    ) {
      const title = `Synthetic task ${randomUUID()}`;
      batches.set(text, {
        subagents: false,
        sequential: options.sequential ?? true,
        chatOnly: true,
        calls: [
          {
            tool: 'task',
            action: 'start',
            args: {
              title,
              message: `I’ll handle ${title}.`,
              doneWhen: 'The synthetic step is handled.',
              now: 'Working on it',
            },
          },
        ],
        ...(taskCalls ? { taskCalls } : {}),
      });
      const response = await request('POST', '/api/messages', { text });
      assert.equal(response.statusCode, 200, response.body);
      ids.push(response.json().threadId as string);
      await waitFor(response.json().turnId, 'succeeded');
      const task = (
        await pool.query<{ turn_id: string }>(
          'SELECT turn_id FROM tasks WHERE owner_id=$1 AND title=$2',
          [ownerId, title],
        )
      ).rows[0];
      assert.ok(task);
      const { session_id: sessionId } = (
        await pool.query<{ session_id: string }>('SELECT session_id FROM turns WHERE id=$1', [
          task.turn_id,
        ])
      ).rows[0]!;
      if (options.wait !== false) await waitFor(task.turn_id, options.wait ?? 'waiting|succeeded');
      return { turnId: task.turn_id, sessionId, rootTurnId: response.json().turnId as string };
    }
    const taskTools = new Set(['browser', 'sign_in', 'pay', 'computer']);
    async function propose(
      action: string,
      args: Record<string, unknown>,
      tool?: string,
      text = `Synthetic proposal ${randomUUID()}`,
    ) {
      plans.set(text, { tool, action, args });
      if (tool && taskTools.has(tool)) return (await taskTurn(text)).turnId;
      const response = await request('POST', '/api/messages', { text });
      assert.equal(response.statusCode, 200);
      const id = response.json().turnId as string;
      ids.push(response.json().threadId as string);
      await waitFor(id, tool ? 'waiting|succeeded' : 'waiting');
      return id;
    }
    const approvalsFor = async (id: string) =>
      (await pool.query('SELECT * FROM approvals WHERE turn_id=$1', [id])).rows;
    const confirmationFor = async (approval: { confirmation_message_id: string }) => {
      const text = (
        await pool.query<{ text: string }>(
          'SELECT text FROM messages WHERE id=$1 AND owner_id=$2',
          [approval.confirmation_message_id, ownerId],
        )
      ).rows[0]?.text;
      assert.ok(text);
      return text;
    };
    async function reminder(input: Record<string, unknown> = {}) {
      const response = await request('POST', '/api/schedules', {
        title: 'Synthetic cancellation reminder',
        prompt: 'Review the synthetic checklist.',
        kind: 'once',
        runAt: '2099-01-01T09:00:00Z',
        timeZone: 'UTC',
        ...input,
      });
      assert.equal(response.statusCode, 200, response.body);
      const id = response.json().id as string;
      const { job_id: jobId } = (
        await pool.query('SELECT job_id FROM schedules WHERE id=$1 AND owner_id=$2', [id, ownerId])
      ).rows[0];
      assert.ok(jobId);
      return { id, jobId: jobId as string };
    }
    async function assertPaused(schedule: { id: string; jobId: string }) {
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
            "SELECT id FROM approvals WHERE owner_id=$1 AND action IN ('NOD_schedule_pause','NOD_schedule_cancel') AND args=$2::jsonb AND status<>'expired'",
            [ownerId, { id: schedule.id }],
          )
        ).rows,
        [],
      );
    }
    const calendarRetry = () =>
      inPart(
        'an iCloud calendar retry checks the app and saves the requested event once (LAB-1467)',
        async (t) => {
          const origin = 'https://calendar.example.test';
          const title = 'Studio planning';
          const time = 'November 24, 2030, 9:00–9:30 AM';
          const ownerRequest = `Create “${title}” in my iCloud calendar at ${origin} on ${time}.`;
          const retry = 'Then try it again';
          const unverified = `I could not verify that ${title} was saved.`;
          const verified = `${title} is on the calendar on ${time}.`;
          const calendar = `${origin}/calendar`;
          const editor = [
            ['Create', { action: 'click', selector: '@e1' }],
            ['AM', { action: 'click', selector: '@e2' }],
            ['Add', { action: 'click', selector: '@e3' }],
            ['Enter', { action: 'press', key: 'Enter' }],
          ] as const;
          const checks: string[] = [];
          const actions: string[] = [];
          const events: Array<{ title?: string; time?: string }> = [];
          const fields: { title?: string; time?: string } = {};
          let index = 0;
          const url = () => (index > 0 && index < editor.length ? `${calendar}/new` : calendar);
          calendarBrowser = {
            currentPage: async (_id, step) => ({
              origin,
              url: url(),
              ...(step && editor[index]
                ? { controls: [{ role: 'button', name: editor[index][0] }], submits: 'unknown' }
                : {}),
            }),
            act: async (_id, step) => {
              if (step.action === 'open') index = 0;
              else if (step.action === 'snapshot') actions.push('snapshot');
              else if (step.action === 'fill') {
                if (step.selector === '#title') fields.title = step.text;
                if (step.selector === '#time') fields.time = step.text;
              } else if (step.action === 'click' || step.action === 'press') {
                const [name, command] = editor[index++]!;
                assert.equal(step.action, command.action);
                assert.equal(
                  step.selector ?? step.key,
                  'selector' in command ? command.selector : command.key,
                );
                actions.push(name);
                if (index === editor.length) events.push({ ...fields });
              }
              return { url: url(), text: JSON.stringify(events) };
            },
          };
          calendarReview = (input) => {
            const { action, userMessages } = input as {
              action: { arguments: { website: string; control?: { name: string }[] } };
              userMessages?: { text: string }[];
            };
            const label = action.arguments.control?.[0]?.name ?? '';
            checks.push(label);
            const index = (userMessages ?? []).findLastIndex(({ text }) => text === ownerRequest);
            return action.arguments.website === origin &&
              editor.some(([name]) => label === name) &&
              index >= 0
              ? { run: true, source: `message:${index}`, terms: [] }
              : { run: false };
          };
          t.after(() => {
            calendarBrowser = undefined;
            calendarReview = undefined;
            batches.delete(ownerRequest);
            batches.delete(retry);
          });
          const browser = ({ action, ...args }: { action: string } & Record<string, unknown>) => ({
            tool: 'browser',
            action,
            args,
          });
          const snapshot = browser({ action: 'snapshot' });
          const inspect = [browser({ action: 'open', url: calendar }), snapshot];
          const [create, am, add, enter] = editor.map(([, command]) => browser(command));
          const taskOf = async () =>
            (
              await pool.query<{ id: string; turn_id: string; result: string }>(
                'SELECT id,turn_id,result FROM tasks WHERE owner_id=$1 AND title=$2',
                [ownerId, title],
              )
            ).rows[0]!;
          const submit = async (
            text: string,
            call: FixtureCall,
            taskCalls: FixtureCall[],
            taskResult: string,
          ) => {
            batches.set(text, {
              subagents: false,
              sequential: true,
              chatOnly: true,
              calls: [call],
              taskCalls,
              taskResult,
            });
            await waitFor((await submitUserMessage(text)).turnId, 'succeeded');
            const task = await taskOf();
            await waitFor(task.turn_id, 'succeeded');
            assert.deepEqual(await approvalsFor(task.turn_id), []);
            return task;
          };
          const first = await submit(
            ownerRequest,
            {
              tool: 'task',
              action: 'start',
              args: {
                title,
                message: `I’ll create ${title}.`,
                doneWhen: verified,
                now: 'Checking the calendar',
              },
            },
            [...inspect, create!],
            unverified,
          );
          assert.equal((await taskOf()).result, unverified);
          assert.deepEqual(events, []);
          const resumed = await submit(
            retry,
            { tool: 'task', action: 'reply', args: { ids: [first.id], retry: true } },
            [
              ...inspect,
              create!,
              am!,
              browser({ action: 'fill', selector: '#title', text: title }),
              browser({ action: 'fill', selector: '#time', text: time }),
              add!,
              enter!,
              snapshot,
            ],
            verified,
          );
          assert.equal(resumed.id, first.id);
          assert.notEqual(resumed.turn_id, first.turn_id);
          const controls = editor.map(([name]) => name);
          assert.deepEqual(checks, ['Create', ...controls]);
          assert.deepEqual(actions, ['snapshot', 'Create', 'snapshot', ...controls, 'snapshot']);
          assert.deepEqual(events, [{ title, time }]);
          assert.equal((await taskOf()).result, verified);
        },
      );

    try {
      await inPart(
        'Stop cancels schedule reviews before a confirmation or schedule is saved',
        async () => {
          for (const purpose of [undefined]) {
            let release!: () => void;
            let entered!: (signal?: AbortSignal) => void;
            const reviewing = new Promise<AbortSignal | undefined>(
              (resolve) => (entered = resolve),
            );
            heldReview = {
              purpose,
              entered,
              release: new Promise<void>((resolve) => (release = resolve)),
            };
            const text = `Create a synthetic stopped schedule ${randomUUID()}`;
            const title = `Stopped review ${randomUUID()}`;
            plans.set(text, {
              action: 'schedule_create',
              args: {
                title,
                prompt: 'Read the synthetic note.',
                kind: 'once',
                runAt: '2099-01-01T09:00:00Z',
                timeZone: 'UTC',
              },
            });
            try {
              const response = await request('POST', '/api/messages', { text });
              assert.equal(response.statusCode, 200, response.body);
              const turnId = response.json().turnId as string;
              const signal = await reviewing;
              assert.equal((await request('POST', '/api/thread/stop')).statusCode, 200);
              assert.ok(signal);
              assert.equal(signal.aborted, true);
              release();
              await waitFor(turnId, 'cancelled');
              assert.equal(
                (await pool.query('SELECT 1 FROM schedules WHERE title=$1', [title])).rowCount,
                0,
              );
              assert.deepEqual(await approvalsFor(turnId), []);
            } finally {
              heldReview = undefined;
              plans.delete(text);
              release();
            }
          }
        },
      );

      await inPart(
        'schedule approval displays and saves the complete checked instruction once',
        async () => {
          const title = `Synthetic checked schedule ${randomUUID()}`;
          const prompt = [
            'Review inbox@example.test at the scheduled time.',
            'Read the full threads and attachments.',
            'Include linked summaries.',
            'Never send email or change sources.',
          ].join('\n');
          const args = {
            title,
            prompt,
            kind: 'recurring',
            cron: '0 15 * * *',
            timeZone: 'Europe/London',
          };
          let expectedPrompt = prompt;
          let drafts = 0;
          confirmationModel = (value) => {
            const input = value as Record<string, any>;
            assert.equal(input.data.details.scheduleDefinition.prompt, expectedPrompt);
            drafts++;
            return { text: 'Save this schedule?', action: 'Save schedule' };
          };
          const click = (card: { id: string; confirmation_message_id: string }) =>
            request('POST', '/api/messages', {
              text: 'Save schedule',
              replyToMessageId: card.confirmation_message_id,
              clientMessageId: randomUUID(),
              approvalAnswer: { approvalId: card.id, approved: true },
            });
          try {
            const proposed = await propose('schedule_create', args);
            const [first] = await approvalsFor(proposed);
            assert.equal(first.status, 'pending');
            assert.equal(
              (await pool.query('SELECT 1 FROM schedules WHERE title=$1', [title])).rowCount,
              0,
            );
            const firstQuestion = await confirmationFor(first);
            assert.ok(firstQuestion.includes(prompt));
            assert.ok(firstQuestion.includes('Every day at 15:00'));
            const page = (await request('GET', '/api/messages')).json().messages;
            const visible = page.find(
              (message: { id: string }) => message.id === first.confirmation_message_id,
            );
            assert.equal(visible.text, firstQuestion);
            assert.equal(visible.approval.state, 'pending');
            const accepted = await click(first);
            assert.equal(accepted.statusCode, 200, accepted.body);
            await waitFor(accepted.json().turnId, 'succeeded');
            const original = (await approvalsFor(proposed))[0];
            const saved = (
              await pool.query(
                'SELECT id,prompt,authority,revision FROM schedules WHERE title=$1',
                [title],
              )
            ).rows[0];
            assert.equal(saved.prompt, prompt);
            assert.deepEqual(
              saved.authority.approvals.at(-1).definition,
              first.instruction_change.after,
            );
            assert.equal((await click(first)).statusCode, 409);
            assert.equal(
              (await pool.query('SELECT 1 FROM schedules WHERE title=$1', [title])).rowCount,
              1,
            );
            const reloaded = (await request('GET', '/api/messages')).json().messages;
            const completed = reloaded.find(
              (message: { id: string }) => message.id === first.confirmation_message_id,
            );
            assert.equal(completed.text, firstQuestion);
            assert.equal(completed.approval.state, 'done');

            expectedPrompt = prompt.replace(
              'Include linked summaries.',
              'Include linked summaries and dates.',
            );
            const updated = await propose('schedule_update', {
              id: saved.id,
              prompt: expectedPrompt,
            });
            const [second] = await approvalsFor(updated);
            assert.equal(second.status, 'pending');
            assert.equal(
              (await pool.query('SELECT prompt FROM schedules WHERE id=$1', [saved.id])).rows[0]
                .prompt,
              prompt,
            );
            const secondQuestion = await confirmationFor(second);
            assert.ok(secondQuestion.includes(expectedPrompt));
            assert.ok(secondQuestion.includes('Every day at 15:00'));
            assert.ok(!secondQuestion.includes(saved.id));
            const changed = await click(second);
            assert.equal(changed.statusCode, 200, changed.body);
            await waitFor(changed.json().turnId, 'succeeded');
            const final = (
              await pool.query('SELECT prompt,authority,revision FROM schedules WHERE id=$1', [
                saved.id,
              ])
            ).rows[0];
            assert.equal(final.prompt, expectedPrompt);
            assert.equal(final.revision, saved.revision + 1);
            assert.deepEqual(
              final.authority.approvals.at(-1).definition,
              second.instruction_change.after,
            );
            assert.equal((await click(second)).statusCode, 409);
            assert.deepEqual((await approvalsFor(proposed))[0].result, original.result);
            assert.equal(drafts, 2);
          } finally {
            confirmationModel = undefined;
          }
        },
      );

      await inPart(
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
          const light = { connectionId: connection.id, modelId: 'gpt-6-luna' };
          const directText =
            'Use the first connected model again, your light model for your own checks, and the light model for the routed research.';
          asked.add(directText);
          batches.set(directText, {
            subagents: false,
            sequential: true,
            chatOnly: true,
            calls: [
              { tool: 'nod', action: 'model_select', args: { args: before! } },
              {
                tool: 'nod',
                action: 'model_select',
                args: { args: { scope: 'background', use: 'light' } },
              },
              {
                tool: 'task',
                action: 'start',
                args: {
                  title: 'Routed research',
                  doneWhen: 'Synthetic research is done.',
                  now: 'Starting synthetic research.',
                  message: 'Starting the synthetic research.',
                  model: light,
                },
              },
            ],
          });
          const errors = batchErrors.length;
          const direct = await request('POST', '/api/messages', { text: directText });
          await waitFor(direct.json().turnId, 'succeeded');
          assert.deepEqual(batchErrors.slice(errors), []);
          assert.deepEqual(models.view().selection, before);
          assert.equal((await approvalsFor(direct.json().turnId)).length, 0);
          assert.deepEqual(models.view().routes, { background: 'light' });
          assert.equal(models.view().light?.modelId, 'gpt-6-luna');
          assert.ok(
            fallbackChecks.some((input) =>
              JSON.stringify(input).includes('work Nod starts on its own'),
            ),
          );
          assert.equal((await models.resolve()).definition.choice.id, 'gpt-6.1-sol');

          const modelsOf = (turnId: string) =>
            opened.filter((entry) => entry.turnId === turnId).map((entry) => entry.model);
          const put = (url: string, payload: object) =>
            application.app.inject({ method: 'PUT', url, headers, payload });
          const task = (
            await pool.query<{ id: string; model: { modelId: string } }>(
              "SELECT id,model FROM tasks WHERE title='Routed research'",
            )
          ).rows[0]!;
          assert.equal(task.model.modelId, 'gpt-6-luna');
          const taskTurn = (
            await pool.query<{ id: string }>('SELECT id FROM turns WHERE session_id=$1', [task.id])
          ).rows[0]!;
          await waitFor(taskTurn.id, 'succeeded|waiting');
          assert.deepEqual(modelsOf(taskTurn.id), ['gpt-6-luna']);
          const listed = (await request('GET', '/api/tasks'))
            .json<Task[]>()
            .find((item) => item.id === task.id)!;
          assert.equal(listed.work, 'chat');

          const unasked = `Synthetic unasked task model ${randomUUID()}`;
          plans.set(unasked, {
            tool: 'task',
            action: 'start',
            args: {
              title: 'Unasked routed research',
              doneWhen: 'Synthetic research is done.',
              now: 'Starting synthetic research.',
              message: 'Starting the synthetic research.',
              model: light,
            },
          });
          const refused = await enqueueTurn(unasked, { source: 'task', background: false });
          await waitFor(refused, 'succeeded|failed');
          assert.match(
            (await pool.query('SELECT error FROM turns WHERE id=$1', [refused])).rows[0].error ??
              JSON.stringify(results.get(refused)),
            /did not ask for a model/,
          );
          assert.equal(
            (await pool.query("SELECT 1 FROM tasks WHERE title='Unasked routed research'"))
              .rowCount,
            0,
          );

          const eventPrompt = `Synthetic app event ${randomUUID()}`;
          batches.set(eventPrompt, {
            subagents: true,
            calls: [{ action: 'GMAIL_FETCH_EMAILS', args: { max_results: 1 } }],
          });
          const event = await enqueueTurn(eventPrompt, { source: 'event', background: true });
          await waitFor(event, 'succeeded');
          const eventOpens = opened.filter((entry) => entry.turnId === event);
          assert.ok(eventOpens.some((entry) => entry.helper));
          assert.ok(eventOpens.every((entry) => entry.model === 'gpt-6-luna'));

          const created = await request('POST', '/api/schedules', {
            title: 'Synthetic routed schedule',
            prompt: 'Return the synthetic routed summary.',
            kind: 'once',
            runAt: '2099-01-01T09:00:00Z',
            timeZone: 'UTC',
          });
          assert.equal(created.statusCode, 200, created.body);
          const schedule = created.json();
          const run = async () => {
            const revision = (await request('GET', '/api/schedules'))
              .json()
              .find((item: { id: string }) => item.id === schedule.id).revision;
            const response = await request('POST', `/api/schedules/${schedule.id}/run`, {
              requestId: randomUUID(),
              expectedRevision: revision,
            });
            assert.equal(response.statusCode, 200, response.body);
            await waitFor(response.json().turnId, 'succeeded');
            return response.json().turnId as string;
          };
          assert.deepEqual(modelsOf(await run()), ['gpt-6.1-sol']);
          const lightChoice = models.view().light!;
          const retired = await put(`/api/schedules/${schedule.id}/model`, {
            model: { ...lightChoice, modelId: 'gpt-retired' },
          });
          assert.equal(retired.statusCode, 400, retired.body);
          assert.match(retired.json<{ error: string }>().error, /available text model/);
          const pinned = await put(`/api/schedules/${schedule.id}/model`, { model: lightChoice });
          assert.equal(pinned.statusCode, 200, pinned.body);
          const second = await run();
          assert.deepEqual(modelsOf(second), ['gpt-6-luna']);

          const before30 = (await request('GET', '/api/usage/work')).json<WorkUsageResponse>();
          for (const [turnId, model, input] of [
            [direct.json().turnId, 'gpt-6.1-sol', 1000],
            [event, 'gpt-6-luna', 2000],
            [second, 'gpt-6-luna', 4000],
            [taskTurn.id, 'gpt-6-luna', 8000],
          ] as const)
            await pool.query(
              'INSERT INTO model_usage(id,owner_id,turn_id,cost_usd,details) VALUES($1,$2,$3,$4,$5)',
              [
                randomUUID(),
                ownerId,
                turnId,
                input / 1e6,
                { category: 'agent', model, inputTokens: input, outputTokens: 0 },
              ],
            );
          const after30 = (await request('GET', '/api/usage/work')).json<WorkUsageResponse>();
          const grew = (now?: { input: number }, then?: { input: number }) =>
            (now?.input ?? 0) - (then?.input ?? 0);
          assert.equal(grew(after30.lanes.chat, before30.lanes.chat), 1000);
          assert.equal(grew(after30.lanes.background, before30.lanes.background), 2000);
          assert.equal(grew(after30.lanes.schedule, before30.lanes.schedule), 0);
          assert.equal(grew(after30.schedules[schedule.id], before30.schedules[schedule.id]), 4000);
          assert.equal(grew(after30.tasks[task.id], before30.tasks[task.id]), 8000);
          const onLuna = (usage: WorkUsageResponse, kind: string) =>
            usage.own
              .filter(
                (entry) =>
                  entry.kind === kind && (entry.task ?? entry.schedule)?.modelId === 'gpt-6-luna',
              )
              .reduce((sum, entry) => sum + entry.input, 0);
          assert.equal(onLuna(after30, 'schedule') - onLuna(before30, 'schedule'), 4000);
          assert.equal(onLuna(after30, 'chat') - onLuna(before30, 'chat'), 8000);

          const followUp = randomUUID();
          const followTurn = randomUUID();
          await pool.query(
            `INSERT INTO turns(id,owner_id,thread_id,session_id,parent_turn_id,source,prompt,status,background)
             SELECT $1,owner_id,thread_id,$2,id,'task','Synthetic schedule follow-up','succeeded',true FROM turns WHERE id=$3`,
            [followTurn, followUp, second],
          );
          await pool.query(
            `INSERT INTO tasks(id,owner_id,turn_id,title,done_when,now_text,session_id)
             VALUES($1,$2,$3,'Synthetic schedule follow-up','Synthetic follow-up is done.','Waiting.',$1)`,
            [followUp, ownerId, followTurn],
          );
          await pool.query(
            'INSERT INTO model_usage(id,owner_id,turn_id,cost_usd,details) VALUES($1,$2,$3,$4,$5)',
            [
              randomUUID(),
              ownerId,
              followTurn,
              0.01,
              { category: 'agent', model: 'gpt-6.1-sol', inputTokens: 1000, outputTokens: 0 },
            ],
          );
          const inherited = (await request('GET', '/api/tasks'))
            .json<Task[]>()
            .find((item) => item.id === followUp)!;
          assert.equal(inherited.work, 'schedule');
          assert.equal(inherited.scheduleModel?.modelId, 'gpt-6-luna');
          const lunaPrice = models
            .view()
            .connections[0]!.models.find((item) => item.id === 'gpt-6-luna')!.pricing as {
            input: number;
          };
          const followDefault = (await application.personal.manage('model_select', {
            scope: 'task',
            id: followUp,
            use: 'same',
          })) as { last30Days?: { withChoiceUsd: number | null } };
          assert.equal(followDefault.last30Days?.withChoiceUsd, (1000 * lunaPrice.input) / 1e6);
          const mainPrice = models
            .view()
            .connections[0]!.models.find((item) => item.id === before!.modelId)!.pricing;
          assert.ok(mainPrice && mainPrice !== 'variable');
          const projectMain = async () =>
            (await application.personal.manage('model_select', {
              scope: 'task',
              id: followUp,
              ...before,
            })) as { last30Days?: { last30Usd: number; withChoiceUsd: number | null } };
          assert.deepEqual((await projectMain()).last30Days, {
            last30Usd: 0.01,
            withChoiceUsd: (1000 * mainPrice.input) / 1e6,
          });

          await pool.query(
            "UPDATE model_usage SET details=details || jsonb_build_object('pricingSignature',$2::text) WHERE turn_id=$1",
            [followTurn, modelPricingSignature(mainPrice)],
          );
          assert.deepEqual((await projectMain()).last30Days, {
            last30Usd: 0.01,
            withChoiceUsd: 0.01,
          });
          await pool.query(
            'INSERT INTO model_usage(id,owner_id,turn_id,cost_usd,details) VALUES($1,$2,$3,$4,$5)',
            [
              randomUUID(),
              ownerId,
              followTurn,
              0.02,
              {
                category: 'agent',
                model: before!.modelId,
                cacheReadTokens: 2_000,
                pricingSignature: modelPricingSignature({ ...mainPrice, cacheRead: 20 }),
              },
            ],
          );
          const mixed = (await projectMain()).last30Days!;
          assert.equal(mixed.last30Usd, 0.03);
          const estimated =
            (1_000 * mainPrice.input + 2_000 * (mainPrice.cacheRead ?? mainPrice.input)) / 1e6;
          assert.equal(mixed.withChoiceUsd, estimated);
          await pool.query(
            "UPDATE model_usage SET cost_usd=NULL,details=details || jsonb_build_object('pricingSignature',$2::text) WHERE turn_id=$1 AND details ? 'cacheReadTokens'",
            [followTurn, modelPricingSignature(mainPrice)],
          );
          assert.deepEqual((await projectMain()).last30Days, {
            last30Usd: 0.01,
            withChoiceUsd: estimated,
          });
          await pool.query('DELETE FROM tasks WHERE id=$1', [followUp]);

          const back = await put(`/api/tasks/${task.id}/model`, { model: null });
          assert.equal(back.statusCode, 200, back.body);
          assert.equal(back.json<Task>().model, null);
          assert.equal(
            (await put(`/api/tasks/${randomUUID()}/model`, { model: null })).statusCode,
            404,
          );
          await request('POST', `/api/tasks/${task.id}/stop`);
          await pool.query('UPDATE turns SET task_id=NULL WHERE task_id=$1', [task.id]);
          await pool.query('DELETE FROM tasks WHERE id=$1', [task.id]);
          await request('DELETE', `/api/schedules/${schedule.id}`);
          const reset = await put('/api/models/routes', { lane: 'background', route: null });
          assert.equal(reset.statusCode, 200, reset.body);
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
      {
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
      }
      await inPart(
        'a compromised agent cannot send outside the account until the owner confirms',
        async () => {
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
          const question = await confirmationFor(card);
          assert.match(question, /collector@example\.test/);
          assert.match(question, /Synthetic invoices/);
          assert.doesNotMatch(question, /GMAIL_SEND_EMAIL|recipient_email|\{"args"/);
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

          const clicked = await propose('GMAIL_SEND_EMAIL', email('click@example.test'), 'apps');
          const [clickCard] = await approvalsFor(clicked);
          const listed = async (id: string) =>
            (await request('GET', `/api/messages/around/${id}`))
              .json()
              .find((message: { id: string }) => message.id === id);
          assert.deepEqual((await listed(clickCard.confirmation_message_id)).approval, {
            id: clickCard.id,
            state: 'pending',
            title: 'Send email',
            app: 'Gmail',
            slug: 'gmail',
            fields: [
              { label: 'To', value: 'click@example.test' },
              { label: 'Subject', value: 'Synthetic invoices' },
            ],
            body: 'Synthetic forwarded content.',
          });
          const click = (approvalId: string) =>
            request('POST', '/api/messages', {
              text: 'Send',
              replyToMessageId: clickCard.confirmation_message_id,
              clientMessageId: randomUUID(),
              approvalAnswer: { approvalId, approved: true },
            });
          const stale = await click(randomUUID());
          assert.equal(stale.statusCode, 409, stale.body);
          assert.equal((await approvalsFor(clicked))[0].status, 'pending');
          assert.equal(sends(), 0);
          const accepted = await click(clickCard.id);
          assert.equal(accepted.statusCode, 200, accepted.body);
          await waitFor(accepted.json().turnId, 'succeeded');
          assert.equal((await approvalsFor(clicked))[0].status, 'completed');
          assert.equal(sends(), 1);
          const answer = await pool.query(
            'SELECT approval_answer FROM messages WHERE id=$1 AND owner_id=$2',
            [accepted.json().messageId, ownerId],
          );
          assert.equal(answer.rows[0]?.approval_answer, true);
          assert.equal((await listed(accepted.json().messageId)).cardAnswer, true);
          ownerWords.length = 0;
          const afterClick = await propose(
            'GMAIL_SEND_EMAIL',
            email('after-click@example.test'),
            'apps',
          );
          assert.doesNotMatch(prompts.get(afterClick) ?? '', /"role":"user","text":"Send"/);
          assert.ok(
            !(await application.personal.recall('Send', undefined, null)).some(
              (message) => message.id === accepted.json().messageId,
            ),
          );
          assert.ok(ownerWords.length > 0);
          assert.ok(!ownerWords.includes('Send'));
          const again = await click(clickCard.id);
          assert.equal(again.statusCode, 409, again.body);
          assert.equal(sends(), 1);
        },
      );

      await inPart(
        'an unwritable question falls back to a fixed one, keeps earlier receipts and dispatches nothing',
        async (t) => {
          const completed = (
            await pool.query(
              "SELECT id,status,result,args FROM approvals WHERE action='GMAIL_SEND_EMAIL' AND status='completed' ORDER BY id",
            )
          ).rows;
          assert.ok(completed.length);
          for (const kind of ['send', 'fetch'])
            await t.test(kind, async () => {
              let drafts = 0;
              const action = kind === 'fetch' ? 'GMAIL_FETCH_EMAILS' : 'GMAIL_SEND_EMAIL';
              const before = executedApps.filter((value) => value === action).length;
              const text = `Check the synthetic Gmail format failure ${randomUUID()}.`;
              confirmationModel = () => {
                drafts++;
                return { text: 'Run the synthetic Gmail action?' };
              };
              try {
                plans.set(text, {
                  tool: 'apps',
                  action,
                  args:
                    kind === 'fetch'
                      ? { query: `is:unread synthetic-${randomUUID()}` }
                      : {
                          recipient_email: 'format-failure@example.test',
                          subject: `Synthetic failed question ${randomUUID()}`,
                          body: 'Synthetic content that must not be sent.',
                        },
                });
                const submitted = await request('POST', '/api/messages', { text });
                assert.equal(submitted.statusCode, 200, submitted.body);
                const turn = submitted.json().turnId;
                await waitFor(turn, 'waiting');
                const [fallback] = await approvalsFor(turn);
                assert.equal(fallback?.status, 'pending');
                assert.ok((await confirmationFor(fallback)).trim());
                assert.equal(executedApps.filter((value) => value === action).length, before);
                assert.equal(drafts, 2);
                assert.deepEqual(
                  (
                    await pool.query(
                      'SELECT id,status,result,args FROM approvals WHERE id=ANY($1::uuid[]) ORDER BY id',
                      [completed.map((row) => row.id)],
                    )
                  ).rows,
                  completed,
                );
              } finally {
                confirmationModel = undefined;
                plans.delete(text);
                await request('POST', '/api/thread/stop');
              }
            });
        },
      );

      await inPart(
        'an action the connection service does not offer asks for no approval',
        async () => {
          const writes = integrationFixture.writes.length;
          unoffered = 'GMAIL_SEND_MESSAGE';
          const text = `Synthetic proposal ${randomUUID()}`;
          plans.set(text, {
            tool: 'apps',
            action: 'GMAIL_SEND_MESSAGE',
            args: { recipient_email: 'collector@example.test' },
          });
          const refused = (await submitUserMessage(text)).turnId;
          await waitFor(refused, 'failed').finally(() => {
            unoffered = undefined;
          });
          assert.match(
            (await pool.query('SELECT error FROM turns WHERE id=$1', [refused])).rows[0].error,
            /GMAIL_SEND_MESSAGE/,
          );
          assert.deepEqual(await approvalsFor(refused), []);
          assert.equal(integrationFixture.writes.length, writes);
        },
      );

      await inPart(
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

      await inPart(
        'an unidentified coordinate returns to inspection without an approval',
        async () => {
          const text = `Synthetic unidentified click ${randomUUID()}`;
          const before = browserActs.filter((act) => act.action === 'click').length;
          const errors = batchErrors.length;
          browserControls = [{ role: 'RootWebArea', name: 'Synthetic bank' }];
          try {
            const { turnId } = await taskTurn(
              text,
              [{ tool: 'browser', action: 'click', args: { x: 0.5, y: 0.5 } }],
              { sequential: false, wait: 'succeeded' },
            );
            assert.deepEqual(await approvalsFor(turnId), []);
            assert.equal(browserActs.filter((act) => act.action === 'click').length, before);
            assert.match(batchErrors.slice(errors).join('\n'), /click target is not identified/);
          } finally {
            browserControls = [{ role: 'button', name: 'Authorize payment' }];
          }
        },
      );

      await inPart(
        'a task browser repeat needs a new approval before its second click',
        async () => {
          const title = `Synthetic bank task ${randomUUID()}`;
          const ownerRequest = `Start a task to inspect the synthetic bank page ${title}.`;
          const reply = `Click Authorize payment again for ${title}.`;
          const question = `Should I click Authorize payment again for ${title}?`;
          const click = { tool: 'browser', action: 'click', args: { selector: '@e7' } };
          const clicks = () => browserActs.filter((act) => act.action === 'click').length;
          const before = clicks();
          try {
            batches.set(ownerRequest, {
              subagents: false,
              sequential: true,
              chatOnly: true,
              calls: [
                {
                  tool: 'task',
                  action: 'start',
                  args: {
                    title,
                    message: 'I will inspect the synthetic bank page.',
                    doneWhen: 'The synthetic page has been checked.',
                    now: 'Checking the page',
                  },
                },
              ],
              taskCalls: [click],
            });
            await waitFor((await submitUserMessage(ownerRequest)).turnId, 'succeeded');
            const task = (
              await pool.query('SELECT id,turn_id FROM tasks WHERE owner_id=$1 AND title=$2', [
                ownerId,
                title,
              ])
            ).rows[0];
            assert.ok(task);
            await waitFor(task.turn_id, 'waiting');
            const [first] = await approvalsFor(task.turn_id);
            assert.equal(first.action, 'NOD_browser');
            assert.equal(first.status, 'pending');
            assert.equal(clicks(), before);
            questionAfterConfirm = question;
            const accepted = await request('POST', '/api/messages', {
              text: 'Click Authorize payment',
              replyToMessageId: first.confirmation_message_id,
              approvalAnswer: { approvalId: first.id, approved: true },
            });
            assert.equal(accepted.statusCode, 200, accepted.body);
            await waitFor(accepted.json().turnId, 'waiting');
            assert.equal(clicks(), before + 1);
            const savedFirst = (await approvalsFor(task.turn_id))[0];
            assert.equal(savedFirst.status, 'completed');
            const savedQuestion = (
              await pool.query(
                "SELECT id FROM messages WHERE turn_id=$1 AND role='assistant' AND text=$2",
                [accepted.json().turnId, question],
              )
            ).rows[0];
            assert.ok(savedQuestion);
            asked.add(reply);
            plans.set(reply, click);
            repeatDecision = 'new';
            const repeated = await request('POST', '/api/messages', {
              text: reply,
              replyToMessageId: savedQuestion.id,
            });
            assert.equal(repeated.statusCode, 200, repeated.body);
            await waitFor(repeated.json().turnId, 'waiting|succeeded');
            const repeatedTurn = (
              await pool.query('SELECT session_id FROM turns WHERE id=$1', [repeated.json().turnId])
            ).rows[0];
            const taskSession = (
              await pool.query('SELECT session_id FROM turns WHERE id=$1', [task.turn_id])
            ).rows[0];
            assert.equal(repeatedTurn.session_id, taskSession.session_id);
            const [second] = await approvalsFor(repeated.json().turnId);
            assert.ok(second, 'A repeated task browser action must save a new approval.');
            assert.ok(
              repeatChecks.some(
                (input) => Object(input).reply === reply && Object(input).question === question,
              ),
            );
            assert.equal(second.status, 'pending');
            assert.equal(second.source_message_id, repeated.json().messageId);
            assert.deepEqual(second.args, first.args);
            assert.equal(clicks(), before + 1);
            assert.deepEqual((await approvalsFor(task.turn_id))[0].result, savedFirst.result);
            const confirmed = await request('POST', '/api/messages', {
              text: 'Click Authorize payment',
              replyToMessageId: second.confirmation_message_id,
              approvalAnswer: { approvalId: second.id, approved: true },
            });
            assert.equal(confirmed.statusCode, 200, confirmed.body);
            await waitFor(confirmed.json().turnId, 'succeeded');
            assert.equal(clicks(), before + 2);
            assert.equal((await approvalsFor(repeated.json().turnId))[0].status, 'completed');
            assert.deepEqual((await approvalsFor(task.turn_id))[0].result, savedFirst.result);
          } finally {
            questionAfterConfirm = undefined;
            repeatDecision = 'same';
            batches.delete(ownerRequest);
            plans.delete(reply);
            asked.delete(reply);
          }
        },
      );

      await inPart('a legacy browser repeat checks its target before wording', async (t) => {
        for (const [kind, command] of [
          ['y coordinate', { y: 0.5 }],
          [
            'points',
            {
              points: [
                { x: 0.5, y: 0.5 },
                { x: 0.5, y: 0.5 },
              ],
            },
          ],
        ] as const)
          await t.test(kind, async () => {
            const question = `Should I repeat the synthetic ${kind} click?`;
            const reply = `Repeat the synthetic ${kind} click ${randomUUID()}.`;
            const clicks = () => browserActs.filter((act) => act.action === 'click').length;
            const before = clicks();
            try {
              const initial = await propose('click', { selector: '@e7' }, 'browser');
              const [first] = await approvalsFor(initial);
              assert.equal(first.action, 'NOD_browser');
              questionAfterConfirm = question;
              const accepted = await request('POST', '/api/messages', {
                text: 'Click Authorize payment',
                replyToMessageId: first.confirmation_message_id,
                approvalAnswer: { approvalId: first.id, approved: true },
              });
              assert.equal(accepted.statusCode, 200, accepted.body);
              await waitFor(accepted.json().turnId, 'waiting');
              const saved = (await approvalsFor(initial))[0];
              assert.equal(saved.status, 'completed');
              assert.equal(clicks(), before + 1);
              const savedQuestion = (
                await pool.query(
                  "SELECT id FROM messages WHERE turn_id=$1 AND role='assistant' AND text=$2",
                  [accepted.json().turnId, question],
                )
              ).rows[0];
              assert.ok(savedQuestion);
              browserControls = [
                { role: 'RootWebArea', name: 'Synthetic bank' },
                { role: 'button', name: 'Secondary control' },
              ];
              const legacy = {
                ...first.args,
                control: browserControls,
                command: { action: 'click', ...command },
              };
              await pool.query('UPDATE approvals SET args=$2::jsonb WHERE id=$1', [
                first.id,
                legacy,
              ]);
              let wording = 0;
              browserWording = (input) => {
                wording++;
                return input.purpose === 'confirmation_review'
                  ? { valid: true }
                  : syntheticConfirmation(input);
              };
              asked.add(reply);
              plans.set(reply, { tool: 'browser', action: 'click', args: { ...command } });
              repeatDecision = 'new';
              const repeated = await request('POST', '/api/messages', {
                text: reply,
                replyToMessageId: savedQuestion.id,
              });
              assert.equal(repeated.statusCode, 200, repeated.body);
              await waitFor(repeated.json().turnId, 'waiting|failed');
              assert.deepEqual(repeatChecks.at(-1), {
                action: 'NOD_browser',
                args: legacy,
                reply,
                question,
              });
              const turn = (
                await pool.query('SELECT status,error FROM turns WHERE id=$1', [
                  repeated.json().turnId,
                ])
              ).rows[0];
              assert.equal(turn.status, 'failed');
              assert.match(turn.error, /click target is not identified/);
              assert.deepEqual(await approvalsFor(repeated.json().turnId), []);
              assert.equal(wording, 0);
              assert.equal(clicks(), before + 1);
              const retained = (await approvalsFor(initial))[0];
              assert.equal(retained.status, 'completed');
              assert.deepEqual(retained.args, legacy);
              assert.deepEqual(retained.result, saved.result);
            } finally {
              browserControls = [{ role: 'button', name: 'Authorize payment' }];
              browserWording = undefined;
              questionAfterConfirm = undefined;
              repeatDecision = 'same';
              plans.delete(reply);
              asked.delete(reply);
            }
          });
      });

      await inPart('a reply to a task that is not an answer closes its open approval', async () => {
        const held = await propose('click', { selector: '@e7' }, 'browser');
        const [card] = await approvalsFor(held);
        assert.equal(card?.status, 'pending');
        const reply = await request('POST', '/api/messages', {
          text: `Use the savings account instead ${randomUUID()}.`,
          replyToMessageId: card.confirmation_message_id,
        });
        assert.equal(reply.statusCode, 200, reply.body);
        assert.equal((await approvalsFor(held))[0]?.status, 'expired');
      });

      await inPart(
        'a labeled click keeps its replay command out of wording and waits for approval',
        async () => {
          const before = browserActs.filter((act) => act.action === 'click').length;
          const wording: Array<Record<string, any>> = [];
          browserWording = (input) => {
            wording.push(structuredClone(input));
            if (input.purpose === 'confirmation_review')
              return input.data.args.command
                ? { valid: false, reason: 'The proposed operation contains a raw browser command.' }
                : { valid: true };
            return syntheticConfirmation(input);
          };
          try {
            const held = await propose('click', { selector: '@e7' }, 'browser');
            const [card] = await approvalsFor(held);
            assert.ok(card);
            assert.equal(card.status, 'pending');
            assert.deepEqual(card.args.command, { action: 'click', selector: '@e7' });
            assert.equal(browserActs.filter((act) => act.action === 'click').length, before);
            assert.deepEqual(
              wording.map((input) => input.purpose),
              ['confirmation'],
            );
            for (const input of wording) {
              assert.equal(input.data.args.command, undefined);
              assert.equal(input.data.args.step, 'click');
              assert.deepEqual(input.data.args.control, [
                { role: 'button', name: 'Authorize payment' },
              ]);
              assert.deepEqual(input.data.args.submits, {
                method: 'POST',
                to: 'https://bank.example.test/transfer/send',
              });
            }
            const reviewed = (fallbackChecks as Array<Record<string, any>>).findLast(
              (input) => input.action?.name === 'NOD_browser',
            );
            assert.deepEqual(reviewed?.action.arguments.command, {
              action: 'click',
              selector: '@e7',
            });
            const approved = await request('POST', '/api/messages', {
              text: 'Yes',
              replyToMessageId: card.confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            assert.equal(approved.statusCode, 200, approved.body);
            await waitFor(approved.json().turnId, 'succeeded');
            assert.equal(browserActs.filter((act) => act.action === 'click').length, before + 1);
            assert.equal((await approvalsFor(held))[0].status, 'completed');
          } finally {
            browserWording = undefined;
          }
        },
      );

      await inPart(
        'unidentified coordinate, selector and Enter steps return to inspection before approval',
        async () => {
          const seen: BrowserAction[] = [];
          let page: BrowserPage = {
            origin: 'https://review.example.test',
            url: 'https://review.example.test/request',
          };
          calendarBrowser = {
            currentPage: async () => page,
            act: async (_id, step) => {
              seen.push(step);
              return {
                text: `Result:\n${JSON.stringify('Submit the synthetic request for review.')}`,
                url: page.url,
              };
            },
          };
          const controls = [{ role: 'RootWebArea', name: 'Synthetic review page' }];
          const cases: Array<{
            step: BrowserAction;
            controls?: BrowserPage['controls'];
            submits?: BrowserPage['submits'];
          }> = [
            {
              step: { action: 'click', selector: '#blank-button' },
              controls: [
                { role: 'button', name: '' },
                { role: 'form', name: 'Payment form' },
              ],
            },
            {
              step: { action: 'press', key: 'Enter' },
              controls: [
                { role: 'textbox', name: '' },
                { role: 'region', name: 'Account settings' },
              ],
              submits: 'unknown',
            },
            {
              step: { action: 'type', text: 'synthetic\n' },
              controls: [
                { role: 'textbox', name: ' ' },
                { role: 'button', name: 'Submit request' },
              ],
            },
            {
              step: { action: 'click', x: 0.5, y: 0.5 },
              controls: [
                { role: 'generic', name: '' },
                { role: 'region', name: 'Payment details' },
              ],
              submits: { method: 'POST', to: 'https://review.example.test/submit' },
            },
            {
              step: {
                action: 'click',
                points: [
                  { x: 0.5, y: 0.5 },
                  { x: 0.5, y: 0.5 },
                ],
              },
              controls,
              submits: { method: 'POST', to: 'https://review.example.test/submit' },
            },
            {
              step: { action: 'click', x: 0.5, y: 0.5 },
              controls: [{ role: 'button', name: ' ' }],
              submits: { method: 'POST', to: 'https://review.example.test/submit' },
            },
            {
              step: { action: 'click', y: 0.5 },
              controls,
              submits: { method: 'POST', to: 'https://review.example.test/submit' },
            },
            { step: { action: 'click', selector: '@e7' }, controls },
            {
              step: { action: 'click', selector: '#unnamed' },
              controls: [{ role: 'button', name: ' \t ' }],
              submits: 'unknown',
            },
            { step: { action: 'press', key: 'Enter' }, controls },
            { step: { action: 'press', key: 'Enter' }, submits: 'unknown' },
            { step: { action: 'type', text: 'synthetic\n' }, controls, submits: 'unknown' },
            {
              step: { action: 'type', text: 'synthetic\r' },
              controls: [{ role: 'textbox', name: ' ' }],
            },
            { step: { action: 'press', key: 'Shift+Enter' }, controls, submits: 'unknown' },
            { step: { action: 'press', key: 'Control+Enter' }, controls },
            { step: { action: 'press', key: 'NumpadEnter' }, controls },
            { step: { action: 'press', key: 'Return' }, controls },
            { step: { action: 'press', key: 'Enter+Shift' }, controls },
            { step: { action: 'press', key: '\r' }, controls },
            { step: { action: 'press', key: '\n' }, controls },
          ];
          try {
            for (const entry of cases) {
              page = {
                origin: page.origin,
                url: page.url,
                controls: entry.controls,
                submits: entry.submits,
              };
              const text = `Synthetic unidentified step ${randomUUID()}`;
              const { action, ...args } = entry.step;
              const errors = batchErrors.length;
              const before = seen.length;
              const { turnId } = await taskTurn(text, [{ tool: 'browser', action, args }], {
                sequential: false,
              });
              assert.deepEqual(await approvalsFor(turnId), []);
              assert.equal(seen.length, before);
              assert.match(batchErrors.slice(errors).join('\n'), /target is not identified/);
              if (entry.step.action === 'type')
                assert.match(batchErrors.slice(errors).join('\n'), /typed line break/);
            }
            for (const entry of [
              {
                step: { action: 'click', selector: '#named-custom' },
                controls: [
                  { role: 'generic', name: 'Submit custom request' },
                  { role: 'region', name: 'Request details' },
                ],
              },
              {
                step: { action: 'click', x: 0.5, y: 0.5 },
                controls: [{ role: 'button', name: 'Submit request' }],
                submits: { method: 'POST', to: 'https://review.example.test/submit' },
              },
              {
                step: { action: 'click', selector: '#submit' },
                controls: [{ role: 'button', name: 'Submit request' }],
                submits: 'unknown',
              },
              {
                step: { action: 'click', selector: '#submit-form' },
                controls,
                submits: { method: 'POST', to: 'https://review.example.test/submit' },
              },
              {
                step: { action: 'press', key: 'Enter' },
                controls: [],
                submits: { method: 'POST', to: 'https://review.example.test/submit' },
              },
              {
                step: { action: 'type', text: 'synthetic\n' },
                controls: [{ role: 'textbox', name: ' Request ' }],
              },
            ] satisfies typeof cases) {
              page = {
                origin: page.origin,
                url: page.url,
                controls: entry.controls,
                submits: entry.submits,
              };
              const { action, ...args } = entry.step;
              const before = seen.filter((step) => step.action !== 'evaluate').length;
              const held = await propose(action, args, 'browser');
              const [card] = await approvalsFor(held);
              assert.equal(card.status, 'pending');
              assert.deepEqual(card.args.command, entry.step);
              assert.deepEqual(card.args.submits, entry.submits);
              assert.equal(seen.filter((step) => step.action !== 'evaluate').length, before);
              const answer = await request('POST', '/api/messages', {
                text: 'Yes',
                replyToMessageId: card.confirmation_message_id,
                approvalAnswer: { approvalId: card.id, approved: true },
              });
              assert.equal(answer.statusCode, 200, answer.body);
              await waitFor(answer.json().turnId, 'succeeded');
              assert.equal((await approvalsFor(held))[0].status, 'completed');
              assert.deepEqual(seen.filter((step) => step.action !== 'evaluate').slice(before), [
                { ...entry.step, expectOrigin: page.origin, expectUrl: page.url },
              ]);
            }
            page = { origin: page.origin, url: page.url, controls, submits: 'unknown' };
            for (const args of [{ selector: '#owner-approved' }, { x: 0.5, y: 0.5 }]) {
              const text = `Click the synthetic owner-approved control ${randomUUID()}`;
              asked.add(text);
              const before = seen.filter((step) => step.action === 'click').length;
              try {
                const id = await propose('click', args, 'browser', text);
                assert.deepEqual(await approvalsFor(id), []);
                assert.equal(seen.filter((step) => step.action === 'click').length, before + 1);
              } finally {
                asked.delete(text);
              }
            }
          } finally {
            calendarBrowser = undefined;
          }
        },
      );

      await inPart(
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
          const since = new Date();
          const held = await propose('click', { selector: '@e7' }, 'browser');
          const [card] = await approvalsFor(held);
          assert.equal(card.status, 'pending');
          assert.equal(card.action, 'NOD_browser');
          assert.equal(card.args.website, 'https://bank.example.test');
          assert.deepEqual(card.args.control, [{ role: 'button', name: 'Authorize payment' }]);
          const question = await confirmationFor(card);
          assert.match(question, /Authorize payment/);
          assert.match(question, /bank\\?\.example\\?\.test/);
          assert.doesNotMatch(question, /NOD_browser|@e7|"command"|\{"args"/);
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
          assert.deepEqual(
            (
              await pool.query(
                `SELECT target,basis->>'kind' AS kind FROM app_actions
                 WHERE action='NOD_browser' AND created_at>=$1 ORDER BY created_at`,
                [since],
              )
            ).rows,
            [
              { target: 'click “Authorize payment” on bank.example.test', kind: 'approved' },
              { target: 'click “Authorize payment” on bank.example.test', kind: 'message' },
            ],
          );
          const log = JSON.stringify(
            results.get(
              await propose('usage_get', { from: '2000-01-01', to: '2099-12-31' }, 'nod'),
            ),
          );
          assert.match(log, /untrusted_tool_result source=\\"usage\\"/);
          assert.ok(log.includes('Browser: click “Authorize payment” on bank.example.test'));
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

      await inPart(
        'connection service waits stop automatic app reads and preserve owner reads',
        async () => {
          const schedule = await reminder({ prompt: 'Synthetic automatic parent' });
          connectionWait = { until: Date.now() + 120_000, status: 429, code: 'installation_busy' };
          appResult = { id: 'synthetic-draft', message: { id: 'synthetic-message' } };
          const calls = [
            { action: 'SEARCH_TOOLS', args: { query: 'gmail' } },
            { action: 'GMAIL_GET_DRAFT', args: { draft_id: 'synthetic-draft' } },
          ];
          try {
            for (const source of ['event', 'schedule'] as const) {
              let parent: string;
              if (source === 'schedule') {
                const response = await request('POST', `/api/schedules/${schedule.id}/run`, {
                  requestId: randomUUID(),
                  expectedRevision: 0,
                });
                assert.equal(response.statusCode, 200, response.body);
                parent = response.json().turnId;
              } else {
                parent = await enqueueTurn('Synthetic automatic parent', {
                  source,
                  background: true,
                });
              }
              await waitFor(parent, 'succeeded');
              for (const call of calls) {
                const before = appSessions;
                const prompt = `Synthetic automatic app read ${randomUUID()}`;
                plans.set(prompt, { tool: 'apps', ...call });
                const turn = await enqueueTurn(prompt, {
                  source: 'task',
                  parentTurnId: parent,
                  background: true,
                });
                await waitFor(turn, 'succeeded|failed');
                const saved = (await pool.query('SELECT error FROM turns WHERE id=$1', [turn]))
                  .rows[0];
                assert.match(
                  JSON.stringify(results.get(turn)) ?? saved.error,
                  /installation_busy.*HTTP 429/,
                );
                assert.equal(appSessions, before);
                assert.deepEqual(await approvalsFor(turn), []);
              }
            }
            for (const call of calls) {
              const before = appSessions;
              const owner = await propose(call.action, call.args, 'apps');
              assert.equal(appSessions, before + 1);
              assert.deepEqual(await approvalsFor(owner), []);
              if (call.action === 'GMAIL_GET_DRAFT') {
                const prompt = `Synthetic owner task read ${randomUUID()}`;
                plans.set(prompt, { tool: 'apps', ...call });
                const task = await enqueueTurn(prompt, {
                  source: 'task',
                  parentTurnId: owner,
                  background: true,
                });
                await waitFor(task, 'succeeded');
                assert.equal(appSessions, before + 2);
              }
            }
          } finally {
            connectionWait = undefined;
            appResult = undefined;
            await request('DELETE', `/api/schedules/${schedule.id}`);
          }
        },
      );

      {
        const automaticDue = application.proactivity.due;
        application.proactivity.due = async () => undefined;
        try {
          await inPart(
            'a proactive read the checker would hold asks nobody and reads nothing',
            async () => {
              const previous = await application.triage.getPreferences();
              const previousCheckCost = checkCost;
              const previousDecisionCost = replyCost;
              checkCost = 0;
              replyCost = 0;
              const prompt = 'Synthetic source read check ' + randomUUID();
              plans.set(prompt, {
                tool: 'read_source',
                action: 'read',
                args: { sourceId: 'fixture:notes', ids: ['record/1'] },
              });
              try {
                await application.triage.updatePreferences({
                  notificationRule: '',
                  rules: '',
                  proactivePaused: false,
                });
                const turnId = await enqueueTurn(prompt, {
                  source: 'event',
                  background: true,
                  proactive: true,
                });
                let status = '';
                for (let attempt = 0; attempt < 300; attempt++) {
                  status = (await pool.query('SELECT status FROM turns WHERE id=$1', [turnId]))
                    .rows[0].status;
                  if (status === 'succeeded' || status === 'failed') break;
                  await delay(20);
                }
                assert.ok(['succeeded', 'failed'].includes(status));
                assert.ok(
                  fallbackChecks.some(
                    (input) => Object(Object(input).action).name === 'NOD_read_source',
                  ),
                );
                assert.deepEqual(await approvalsFor(turnId), []);
                assert.equal(sourceReads, 0);
              } finally {
                checkCost = previousCheckCost;
                replyCost = previousDecisionCost;
                await application.triage.updatePreferences(previous);
              }
            },
          );
          await inPart(
            'a proactive app read runs only what the read-only check calls a read',
            async () => {
              const previous = await application.triage.getPreferences();
              const connection = (
                await pool.query(
                  "SELECT id FROM app_connections WHERE owner_id=$1 AND slug='gmail' AND NOT revoked",
                  [ownerId],
                )
              ).rows[0];
              const sourceId = `connections:${connection.id}`;
              const schema = (field: string) => ({
                type: 'object',
                properties: { [field]: { type: 'string' } },
                additionalProperties: false,
              });
              toolSearch = {
                GMAIL_FETCH_EMAILS: { description: 'Read messages.', inputSchema: schema('query') },
                GMAIL_SEND_EMAIL: {
                  description: 'Send a message.',
                  inputSchema: schema('recipient_email'),
                },
              };
              readOnlyActions.add('GMAIL_FETCH_EMAILS');
              const writes = integrationFixture.writes.length;
              const executed = executedApps.length;
              const read = async (args: Record<string, unknown>) => {
                const prompt = 'Synthetic app read ' + randomUUID();
                plans.set(prompt, {
                  tool: 'read_source',
                  action: 'read',
                  args: { sourceId, ...args },
                });
                const turnId = await enqueueTurn(prompt, {
                  source: 'event',
                  background: true,
                  proactive: true,
                });
                let turn = { status: '', error: '' };
                for (let attempt = 0; attempt < 300; attempt++) {
                  turn = (await pool.query('SELECT status,error FROM turns WHERE id=$1', [turnId]))
                    .rows[0];
                  if (turn.status === 'succeeded' || turn.status === 'failed') break;
                  await delay(20);
                }
                assert.deepEqual(await approvalsFor(turnId), []);
                return turn.status === 'succeeded'
                  ? JSON.stringify(results.get(turnId))
                  : turn.error;
              };
              try {
                await application.triage.updatePreferences({ proactivePaused: false });
                assert.match(
                  await read({ tool: 'GMAIL_FETCH_EMAILS', args: { query: 'invoice' } }),
                  /Search this source/,
                );
                assert.match(await read({ query: 'email' }), /GMAIL_SEND_EMAIL/);
                assert.match(
                  await read({
                    tool: 'GMAIL_SEND_EMAIL',
                    args: { recipient_email: 'x@example.test' },
                  }),
                  /not a read/,
                );
                assert.equal(executedApps.length, executed);
                await read({ tool: 'GMAIL_FETCH_EMAILS', args: { query: 'invoice' } });
                assert.deepEqual(executedApps.slice(executed), ['GMAIL_FETCH_EMAILS']);
                assert.equal(integrationFixture.writes.length, writes);
                assert.equal(
                  (
                    await pool.query(
                      "SELECT count(*)::int AS count FROM proactive_evidence WHERE owner_id=$1 AND source_id=$2 AND resource_id<>'tools'",
                      [ownerId, sourceId],
                    )
                  ).rows[0].count,
                  1,
                );
                toolSearch = {
                  ...Object.fromEntries(
                    Array.from({ length: 6 }, (_, i) => [
                      `GMAIL_SYNTHETIC_READ_${i}`,
                      { description: 'Read a synthetic record.', inputSchema: schema('query') },
                    ]),
                  ),
                  GMAIL_FETCH_EMAILS: {
                    description: 'Read messages.',
                    inputSchema: schema('query'),
                  },
                };
                assert.match(await read({ query: 'email' }), /GMAIL_FETCH_EMAILS/);
                const beforeLookup = executedApps.length;
                assert.match(
                  await read({ tool: 'GMAIL_FETCH_EMAILS', args: { query: 'indexed' } }),
                  /Search this source/,
                );
                assert.equal(executedApps.length, beforeLookup);
                await read({ query: 'GMAIL_FETCH_EMAILS' });
                await read({ tool: 'GMAIL_FETCH_EMAILS', args: { query: 'indexed' } });
                assert.deepEqual(executedApps.slice(beforeLookup), ['GMAIL_FETCH_EMAILS']);
              } finally {
                toolSearch = undefined;
                readOnlyActions.clear();
                await application.triage.updatePreferences(previous);
              }
            },
          );
        } finally {
          application.proactivity.due = automaticDue;
        }
      }
      await inPart('an old proactive approval cannot enable a connected write', async () => {
        const before = integrationFixture.writes.length;
        const held = await propose(
          'GMAIL_SEND_EMAIL',
          {
            recipient_email: 'blocked@example.test',
            subject: 'Synthetic old approval',
            body: 'This must stay private.',
          },
          'apps',
        );
        const [card] = await approvalsFor(held);
        assert.equal(card.status, 'pending');
        await pool.query('UPDATE turns SET proactive=true WHERE id=$1', [held]);
        const approved = await request('POST', '/api/messages', {
          text: 'Yes',
          replyToMessageId: card.confirmation_message_id,
          clientMessageId: randomUUID(),
        });
        assert.equal(approved.statusCode, 200, approved.body);
        await waitFor(approved.json().turnId, 'succeeded');
        assert.equal(integrationFixture.writes.length, before);
        assert.equal((await approvalsFor(held))[0].status, 'expired');
      });
      await inPart(
        'a server-owned confirmation stays bound to an email draft before consent',
        async () => {
          const writes = integrationFixture.writes.length;
          const turn = await propose(
            'GMAIL_CREATE_EMAIL_DRAFT',
            {
              recipient_email: 'blocked@example.test',
              subject: 'Synthetic reviewed email',
              body: 'Synthetic body awaiting confirmation.',
            },
            'apps',
          );
          const [approval] = await approvalsFor(turn);
          assert.equal(approval.status, 'pending');
          assert.equal(approval.action, 'GMAIL_CREATE_EMAIL_DRAFT');
          assert.equal(approval.title, 'Save this draft');
          const { connectionId: _connectionId, ...savedArgs } = approval.args;
          assert.deepEqual(savedArgs, {
            recipient_email: 'blocked@example.test',
            subject: 'Synthetic reviewed email',
            body: 'Synthetic body awaiting confirmation.',
          });
          const state = await request('GET', '/api/state');
          const displayed = state
            .json<AppState>()
            .messages.find((message) => message.id === approval.confirmation_message_id);
          assert.equal(displayed?.approval?.title, approval.title);
          const question = await confirmationFor(approval);
          assert.match(question, /save a Gmail draft/i);
          assert.match(question, /blocked@example.test/);
          assert.match(question, /Synthetic reviewed email/);
          assert.doesNotMatch(question, /GMAIL_CREATE_EMAIL_DRAFT|recipient_email|\{"args"/);
          assert.doesNotMatch(question, /send.*email/i);
          assert.equal(integrationFixture.writes.length, writes);
          const declined = await request('POST', '/api/messages', {
            text: 'No',
            replyToMessageId: approval.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          assert.equal(declined.statusCode, 200, declined.body);
          await waitFor(declined.json().turnId, 'succeeded');
          assert.equal(integrationFixture.writes.length, writes);
        },
      );

      await inPart(
        'a rule-save confirmation keeps its schema through repair and saves only after approval',
        async () => {
          const previous = (
            await pool.query('SELECT rules FROM preferences WHERE owner_id=$1', [ownerId])
          ).rows[0].rules;
          const rules = 'Ask me before a synthetic development workflow changes a shared service.';
          let drafts = 0;
          confirmationModel = (_input, schema) => {
            drafts++;
            assert.deepEqual(schema?.required, ['text', 'action', 'question', 'decline']);
            assert.equal(schema?.additionalProperties, false);
            return drafts === 1
              ? { text: 'Save the synthetic development rule?' }
              : { text: `Save this rule: ${rules}`, action: 'Save rule', decline: 'Keep my rules' };
          };
          try {
            const turn = await propose('notification_preferences_update', { rules });
            const [approval] = await approvalsFor(turn);
            assert.equal(approval.status, 'pending');
            assert.equal(approval.decline, 'Keep my rules');
            assert.equal(drafts, 2);
            assert.equal(
              (await pool.query('SELECT rules FROM preferences WHERE owner_id=$1', [ownerId]))
                .rows[0].rules,
              previous,
            );
            const answer = {
              text: 'Save rule',
              replyToMessageId: approval.confirmation_message_id,
              clientMessageId: randomUUID(),
              approvalAnswer: { approvalId: approval.id, approved: true },
            };
            const accepted = await request('POST', '/api/messages', answer);
            assert.equal(accepted.statusCode, 200, accepted.body);
            await waitFor(accepted.json().turnId, 'succeeded');
            assert.equal(
              (await pool.query('SELECT rules FROM preferences WHERE owner_id=$1', [ownerId]))
                .rows[0].rules,
              rules,
            );
            assert.equal((await approvalsFor(turn))[0].status, 'completed');
            const duplicate = await request('POST', '/api/messages', {
              ...answer,
              clientMessageId: randomUUID(),
            });
            assert.equal(duplicate.statusCode, 409, duplicate.body);
          } finally {
            confirmationModel = undefined;
            await pool.query('UPDATE preferences SET rules=$2 WHERE owner_id=$1', [
              ownerId,
              previous,
            ]);
          }
        },
      );

      await inPart('Gmail deletion confirmation names the verified email', async () => {
        const writes = integrationFixture.writes.length;
        const reads = executedApps.filter(
          (action) => action === 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
        ).length;
        const turn = await propose(
          'GMAIL_DELETE_MESSAGE',
          { message_id: 'fixture-mail-1' },
          'apps',
        );
        const [approval] = await approvalsFor(turn);
        assert.equal(approval.status, 'pending');
        assert.equal(approval.action, 'GMAIL_DELETE_MESSAGE');
        assert.equal(approval.details.earlierActions, undefined);
        const question = await confirmationFor(approval);
        assert.doesNotMatch(question, /fixture-mail-1/);
        assert.match(question, /permanently delete/i);
        assert.match(question, /Northstar review/);
        assert.match(question, /alex@example.test/);
        assert.doesNotMatch(question, /GMAIL_DELETE_MESSAGE|message_id|\{"args"/);
        assert.equal(
          executedApps.filter((action) => action === 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID').length,
          reads + 1,
        );
        const recordedRead = await pool.query<{ basis: { kind: string } }>(
          'SELECT basis FROM app_actions WHERE owner_id=$1 AND turn_id=$2 AND action=$3',
          [ownerId, turn, 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID'],
        );
        assert.equal(recordedRead.rows[0]?.basis.kind, 'read');
        assert.equal(integrationFixture.writes.length, writes);
        const declined = await request('POST', '/api/messages', {
          text: 'No',
          replyToMessageId: approval.confirmation_message_id,
          clientMessageId: randomUUID(),
        });
        assert.equal(declined.statusCode, 200, declined.body);
        await waitFor(declined.json().turnId, 'succeeded');
        assert.equal(integrationFixture.writes.length, writes);
      });
      await inPart(
        'a failed Gmail send followed by draft cleanup identifies the unsent draft before consent',
        async () => {
          const email = {
            recipient_email: 'cleanup@example.test',
            subject: 'Synthetic team summary',
            body: 'Synthetic unsent summary.',
          };
          const sendPrompt = `Send synthetic summary ${randomUUID()}`;
          const sends = integrationFixture.writes.filter(
            (write) => write.action === 'GMAIL_SEND_EMAIL',
          ).length;
          asked.add(sendPrompt);
          appOutage = true;
          try {
            plans.set(sendPrompt, { tool: 'apps', action: 'GMAIL_SEND_EMAIL', args: email });
            const response = await request('POST', '/api/messages', { text: sendPrompt });
            assert.equal(response.statusCode, 200, response.body);
            const failed = response.json().turnId as string;
            ids.push(response.json().threadId as string);
            await waitFor(failed, 'failed');
            const error = (await pool.query('SELECT error FROM turns WHERE id=$1', [failed]))
              .rows[0].error as string;
            assert.match(error, /Synthetic provider outage/);
            assert.equal(
              integrationFixture.writes.filter((write) => write.action === 'GMAIL_SEND_EMAIL')
                .length,
              sends,
            );
          } finally {
            appOutage = false;
            asked.delete(sendPrompt);
          }
          const createPrompt = `Prepare synthetic draft ${randomUUID()}`;
          asked.add(createPrompt);
          let created: string;
          try {
            const turn = await propose('GMAIL_CREATE_EMAIL_DRAFT', email, 'apps', createPrompt);
            await waitFor(turn, 'succeeded');
            const createdWrite = integrationFixture.writes.at(-1);
            assert.ok(createdWrite);
            assert.equal(createdWrite.action, 'GMAIL_CREATE_EMAIL_DRAFT');
            created = createdWrite.id;
          } finally {
            asked.delete(createPrompt);
          }
          const writes = integrationFixture.writes.length;
          const reads = executedApps.filter((action) => action === 'GMAIL_GET_DRAFT').length;
          const turn = await propose('GMAIL_DELETE_DRAFT', { draft_id: created }, 'apps');
          const [approval] = await approvalsFor(turn);
          assert.equal(approval.status, 'pending');
          assert.equal(approval.action, 'GMAIL_DELETE_DRAFT');
          assert.deepEqual(approval.details.earlierActions, [
            {
              action: 'Gmail: create email draft',
              target: 'cleanup@example.test · Synthetic team summary',
            },
          ]);
          const question = await confirmationFor(approval);
          assert.equal(question.includes(created), false);
          assert.match(question, /permanently delete.*unsent Gmail draft/i);
          assert.match(question, /Synthetic team summary/);
          assert.match(question, /cleanup@example.test/);
          assert.doesNotMatch(question, /GMAIL_DELETE_DRAFT|draft_id|\{"args"/);
          assert.equal(
            executedApps.filter((action) => action === 'GMAIL_GET_DRAFT').length,
            reads + 1,
          );
          assert.equal(draftReadArgs.at(-1)?.draft_id, created);
          assert.equal(draftReadArgs.at(-1)?.format, 'metadata');
          assert.equal(integrationFixture.writes.length, writes);
          const declined = await request('POST', '/api/messages', {
            text: 'No',
            replyToMessageId: approval.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          assert.equal(declined.statusCode, 200, declined.body);
          await waitFor(declined.json().turnId, 'succeeded');
          assert.equal(integrationFixture.writes.length, writes);

          const ruleTurn = await propose('GMAIL_DELETE_DRAFT', { draft_id: created }, 'apps');
          const [ruleApproval] = await approvalsFor(ruleTurn);
          const ruleReads = executedApps.filter((action) => action === 'GMAIL_GET_DRAFT').length;
          const priorRules = (
            await pool.query<{ rules: string }>('SELECT rules FROM preferences WHERE owner_id=$1', [
              ownerId,
            ])
          ).rows[0].rules;
          await pool.query('UPDATE preferences SET rules=$2 WHERE owner_id=$1', [
            ownerId,
            'Ask before reading Gmail.',
          ]);
          try {
            const accepted = await request('POST', '/api/messages', {
              text: 'Yes',
              replyToMessageId: ruleApproval.confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            assert.equal(accepted.statusCode, 200, accepted.body);
            await waitFor(accepted.json().turnId, 'succeeded|failed');
          } finally {
            await pool.query('UPDATE preferences SET rules=$2 WHERE owner_id=$1', [
              ownerId,
              priorRules,
            ]);
          }
          assert.equal((await approvalsFor(ruleTurn))[0].status, 'expired');
          assert.equal(
            executedApps.filter((action) => action === 'GMAIL_GET_DRAFT').length,
            ruleReads,
          );
          assert.equal(integrationFixture.writes.length, writes);

          const trustTurn = await propose('GMAIL_DELETE_DRAFT', { draft_id: created }, 'apps');
          const [trustApproval] = await approvalsFor(trustTurn);
          const trustReads = executedApps.filter((action) => action === 'GMAIL_GET_DRAFT').length;
          const changes = changedRulesDuringDraftRead;
          const savedRules = (
            await pool.query<{ rules: string }>('SELECT rules FROM preferences WHERE owner_id=$1', [
              ownerId,
            ])
          ).rows[0].rules;
          changeRulesOnDraftRead = true;
          try {
            const accepted = await request('POST', '/api/messages', {
              text: 'Yes',
              replyToMessageId: trustApproval.confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            assert.equal(accepted.statusCode, 200, accepted.body);
            await waitFor(accepted.json().turnId, 'succeeded|failed');
          } finally {
            changeRulesOnDraftRead = false;
            await pool.query('UPDATE preferences SET rules=$2 WHERE owner_id=$1', [
              ownerId,
              savedRules,
            ]);
          }
          assert.equal(changedRulesDuringDraftRead, changes + 1);
          assert.equal((await approvalsFor(trustTurn))[0].status, 'expired');
          assert.equal(
            executedApps.filter((action) => action === 'GMAIL_GET_DRAFT').length,
            trustReads,
          );
          assert.equal(integrationFixture.writes.length, writes);

          const changedTurn = await propose('GMAIL_DELETE_DRAFT', { draft_id: created }, 'apps');
          const [changedApproval] = await approvalsFor(changedTurn);
          const deletes = executedApps.filter((action) => action === 'GMAIL_DELETE_DRAFT').length;
          appResult = {
            id: created,
            message: {
              id: 'synthetic-replaced-draft-message',
              subject: 'Synthetic changed summary',
              to: 'other@example.test',
            },
          };
          try {
            const accepted = await request('POST', '/api/messages', {
              text: 'Yes',
              replyToMessageId: changedApproval.confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            assert.equal(accepted.statusCode, 200, accepted.body);
            await waitFor(accepted.json().turnId, 'succeeded|failed');
          } finally {
            appResult = undefined;
          }
          assert.equal((await approvalsFor(changedTurn))[0].status, 'expired');
          assert.equal(
            executedApps.filter((action) => action === 'GMAIL_DELETE_DRAFT').length,
            deletes,
          );
          assert.equal(integrationFixture.writes.length, writes);

          const currentReadArgs = draftReadArgs.length;
          const currentTurn = await propose('GMAIL_DELETE_DRAFT', { draft_id: created }, 'apps');
          const [currentApproval] = await approvalsFor(currentTurn);
          const accepted = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: currentApproval.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          assert.equal(accepted.statusCode, 200, accepted.body);
          await waitFor(accepted.json().turnId, 'succeeded');
          assert.equal((await approvalsFor(currentTurn))[0].status, 'completed');
          assert.equal(integrationFixture.writes.length, writes + 1);
          assert.equal(integrationFixture.writes.at(-1)?.action, 'GMAIL_DELETE_DRAFT');
          assert.deepEqual(
            draftReadArgs.slice(currentReadArgs).map((args) => args.format),
            ['metadata', 'metadata'],
          );
        },
      );
      await inPart('Gmail deletion stops when the target cannot be verified', async () => {
        const writes = integrationFixture.writes.length;
        const prompt = `Synthetic missing message ${randomUUID()}`;
        plans.set(prompt, {
          tool: 'apps',
          action: 'GMAIL_DELETE_MESSAGE',
          args: { message_id: 'missing-synthetic-message' },
        });
        const response = await request('POST', '/api/messages', { text: prompt });
        assert.equal(response.statusCode, 200, response.body);
        const turnId = response.json().turnId as string;
        ids.push(response.json().threadId as string);
        await waitFor(turnId, 'failed');
        assert.deepEqual(await approvalsFor(turnId), []);
        assert.equal(integrationFixture.writes.length, writes);
      });
      await inPart('Gmail deletion reports the specific metadata-read failure', async () => {
        const writes = integrationFixture.writes.length;
        const prompt = `Synthetic Gmail metadata outage ${randomUUID()}`;
        plans.set(prompt, {
          tool: 'apps',
          action: 'GMAIL_DELETE_MESSAGE',
          args: { message_id: 'fixture-mail-1' },
        });
        appOutage = true;
        try {
          const response = await request('POST', '/api/messages', { text: prompt });
          assert.equal(response.statusCode, 200, response.body);
          const turnId = response.json().turnId as string;
          ids.push(response.json().threadId as string);
          await waitFor(turnId, 'failed');
          const turn = (await pool.query('SELECT error FROM turns WHERE id=$1', [turnId])).rows[0];
          assert.match(turn.error, /Synthetic provider outage/);
          assert.match(turn.error, /did not ask for approval or delete the message/);
          assert.deepEqual(await approvalsFor(turnId), []);
          assert.equal(integrationFixture.writes.length, writes);
        } finally {
          appOutage = false;
        }
      });
      await inPart('an exact owner-authorized Gmail message ID keeps the direct path', async () => {
        const deletes = executedApps.filter((action) => action === 'GMAIL_DELETE_MESSAGE').length;
        const reads = executedApps.filter(
          (action) => action === 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
        ).length;
        const prompt = `Delete Gmail message missing-synthetic-message ${randomUUID()}`;
        asked.add(prompt);
        try {
          plans.set(prompt, {
            tool: 'apps',
            action: 'GMAIL_DELETE_MESSAGE',
            args: { message_id: 'missing-synthetic-message' },
          });
          const response = await request('POST', '/api/messages', { text: prompt });
          assert.equal(response.statusCode, 200, response.body);
          const turnId = response.json().turnId as string;
          ids.push(response.json().threadId as string);
          await waitFor(turnId, 'failed|succeeded');
          assert.deepEqual(await approvalsFor(turnId), []);
          assert.equal(
            executedApps.filter((action) => action === 'GMAIL_DELETE_MESSAGE').length,
            deletes + 1,
          );
          assert.equal(
            executedApps.filter((action) => action === 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID').length,
            reads,
          );
        } finally {
          asked.delete(prompt);
        }
      });
      await inPart('Gmail deletion does not read targets against an ask-first rule', async () => {
        const writes = integrationFixture.writes.length;
        const reads = executedApps.filter(
          (action) => action === 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
        ).length;
        const draftReads = executedApps.filter((action) => action === 'GMAIL_GET_DRAFT').length;
        const priorRules = (
          await pool.query<{ rules: string }>('SELECT rules FROM preferences WHERE owner_id=$1', [
            ownerId,
          ])
        ).rows[0].rules;
        await pool.query('UPDATE preferences SET rules=$2 WHERE owner_id=$1', [
          ownerId,
          'Ask before reading Gmail.',
        ]);
        try {
          const prompt = `Synthetic ask-first delete ${randomUUID()}`;
          plans.set(prompt, {
            tool: 'apps',
            action: 'GMAIL_DELETE_MESSAGE',
            args: { message_id: 'fixture-mail-1' },
          });
          const response = await request('POST', '/api/messages', { text: prompt });
          assert.equal(response.statusCode, 200, response.body);
          const turnId = response.json().turnId as string;
          ids.push(response.json().threadId as string);
          await waitFor(turnId, 'failed');
          assert.deepEqual(await approvalsFor(turnId), []);
          assert.equal(
            executedApps.filter((action) => action === 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID').length,
            reads,
          );
          const draftPrompt = `Synthetic ask-first draft deletion ${randomUUID()}`;
          plans.set(draftPrompt, {
            tool: 'apps',
            action: 'GMAIL_DELETE_DRAFT',
            args: { draft_id: 'synthetic-draft' },
          });
          const draftResponse = await request('POST', '/api/messages', { text: draftPrompt });
          assert.equal(draftResponse.statusCode, 200, draftResponse.body);
          const draftTurnId = draftResponse.json().turnId as string;
          ids.push(draftResponse.json().threadId as string);
          await waitFor(draftTurnId, 'failed');
          assert.deepEqual(await approvalsFor(draftTurnId), []);
          assert.equal(
            executedApps.filter((action) => action === 'GMAIL_GET_DRAFT').length,
            draftReads,
          );
          assert.equal(integrationFixture.writes.length, writes);
        } finally {
          await pool.query('UPDATE preferences SET rules=$2 WHERE owner_id=$1', [
            ownerId,
            priorRules,
          ]);
        }
      });
      await inPart('Gmail deletion stops if the verified account binding changes', async () => {
        const writes = integrationFixture.writes.length;
        const turn = await propose(
          'GMAIL_DELETE_MESSAGE',
          { message_id: 'fixture-mail-1' },
          'apps',
        );
        const [approval] = await approvalsFor(turn);
        assert.equal(approval.status, 'pending');
        const connectionId = approval.args.connectionId as string;
        const revision = (
          await pool.query<{ watch_revision: number }>(
            'SELECT watch_revision FROM app_connections WHERE id=$1 AND owner_id=$2',
            [connectionId, ownerId],
          )
        ).rows[0].watch_revision;
        await pool.query(
          'UPDATE app_connections SET watch_revision=watch_revision+1 WHERE id=$1 AND owner_id=$2',
          [connectionId, ownerId],
        );
        try {
          const accepted = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: approval.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          assert.equal(accepted.statusCode, 200, accepted.body);
          await waitFor(accepted.json().turnId, 'waiting|succeeded|failed');
          assert.equal(integrationFixture.writes.length, writes);
          assert.equal((await approvalsFor(turn))[0].status, 'expired');
        } finally {
          await pool.query(
            'UPDATE app_connections SET watch_revision=$3 WHERE id=$1 AND owner_id=$2',
            [connectionId, ownerId, revision],
          );
        }
      });
      await inPart(
        'Gmail deletion refuses an account rebound while building its confirmation',
        async () => {
          const primary = (
            await pool.query<{
              id: string;
              account_id: string;
              account_name: string | null;
              account_email: string | null;
              watch_revision: number;
            }>(
              "SELECT id,account_id,account_name,account_email,watch_revision FROM app_connections WHERE owner_id=$1 AND slug='gmail' AND NOT revoked ORDER BY created_at LIMIT 1",
              [ownerId],
            )
          ).rows[0];
          assert.ok(primary?.account_id);
          const session = await integrationFixture.provider.createSession(ownerId, {});
          let secondaryAccountId: string | undefined;
          const originalQuery = pool.query.bind(pool) as (...args: any[]) => Promise<any>;
          const restore = () =>
            originalQuery(
              'UPDATE app_connections SET account_id=$3,account_name=$4,account_email=$5,watch_revision=$6 WHERE id=$1 AND owner_id=$2',
              [
                primary.id,
                ownerId,
                primary.account_id,
                primary.account_name,
                primary.account_email,
                primary.watch_revision,
              ],
            );
          try {
            const secondary = await session.authorize(
              'gmail',
              `http://localhost:${port}/api/apps/callback?state=synthetic`,
            );
            secondaryAccountId = secondary.accountId;
            const consent = await application.app.inject({
              method: 'POST',
              url: `/e2e/connect/${secondary.accountId}`,
              headers,
            });
            assert.equal(consent.statusCode, 302);
            const alternate = await integrationFixture.provider.inspectAccount(
              secondary.accountId,
              ownerId,
            );
            assert.equal(alternate.active, true);
            const draft = (await session.execute(
              'GMAIL_CREATE_EMAIL_DRAFT',
              {
                recipient_email: 'alternate@example.test',
                subject: 'Synthetic alternate draft',
                body: 'Synthetic unsent draft.',
              },
              secondary.accountId,
            )) as { id: string };
            for (const [action, target] of [
              ['GMAIL_DELETE_MESSAGE', { message_id: 'fixture-mail-1' }],
              ['GMAIL_DELETE_DRAFT', { draft_id: draft.id }],
            ] as const) {
              const prompt = `Synthetic account race ${randomUUID()}`;
              let rebound = false;
              const reads = executedApps.length;
              const deletes = integrationFixture.writes.filter((write) =>
                ['GMAIL_DELETE_MESSAGE', 'GMAIL_DELETE_DRAFT'].includes(write.action),
              ).length;
              pool.query = (async (...args: any[]) => {
                if (
                  !rebound &&
                  activePlan.getStore() === prompt &&
                  typeof args[0] === 'string' &&
                  args[0].startsWith('SELECT * FROM app_connections WHERE owner_id=$1 AND id=$2') &&
                  args[1]?.[1] === primary.id
                ) {
                  rebound = true;
                  await originalQuery(
                    'UPDATE app_connections SET account_id=$3,account_name=$4,account_email=$5,watch_revision=watch_revision+1 WHERE id=$1 AND owner_id=$2',
                    [
                      primary.id,
                      ownerId,
                      secondary.accountId,
                      alternate.accountName,
                      alternate.accountEmail,
                    ],
                  );
                }
                return originalQuery(...args);
              }) as typeof pool.query;
              try {
                plans.set(prompt, {
                  tool: 'apps',
                  action,
                  args: { connectionId: primary.id, ...target },
                });
                const response = await request('POST', '/api/messages', { text: prompt });
                assert.equal(response.statusCode, 200, response.body);
                const turnId = response.json().turnId as string;
                ids.push(response.json().threadId as string);
                await waitFor(turnId, 'failed');
                assert.equal(rebound, true);
                const failure = (
                  await pool.query<{ error: string }>('SELECT error FROM turns WHERE id=$1', [
                    turnId,
                  ])
                ).rows[0].error;
                assert.match(
                  failure,
                  /selected Gmail account changed before deletion was proposed/,
                );
                assert.deepEqual(await approvalsFor(turnId), []);
                assert.equal(executedApps.length, reads);
                assert.equal(
                  integrationFixture.writes.filter((write) =>
                    ['GMAIL_DELETE_MESSAGE', 'GMAIL_DELETE_DRAFT'].includes(write.action),
                  ).length,
                  deletes,
                );
              } finally {
                pool.query = originalQuery as typeof pool.query;
                await restore();
              }
            }
          } finally {
            pool.query = originalQuery as typeof pool.query;
            try {
              await restore();
            } finally {
              try {
                if (secondaryAccountId)
                  await integrationFixture.provider.deleteAccount(secondaryAccountId, ownerId);
              } finally {
                await integrationFixture.provider.deleteSession(session.id);
              }
            }
          }
        },
      );

      await inPart(
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
          assert.deepEqual(
            (
              await pool.query(
                "SELECT target,basis->>'kind' AS kind FROM app_actions WHERE action='NOD_limits_update'",
              )
            ).rows,
            [{ target: 'monthly limit $500, no task check-in', kind: 'approved' }],
          );
        },
      );

      section = 2;
      await inPart(
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

      await inPart(
        'schedule pause and edit confirmations cannot mutate a revision edited after the question was saved',
        async () => {
          for (const action of ['schedule_pause', 'schedule_update']) {
            const schedule = await reminder();
            const args = {
              id: schedule.id,
              ...(action === 'schedule_update' ? { title: 'The proposed synthetic title' } : {}),
            };
            const turn = await propose(action, args);
            const [approval] = await approvalsFor(turn);
            assert.equal(approval.action, `NOD_${action}`);
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
              await pool.query(
                'SELECT revision,title,enabled,authority FROM schedules WHERE id=$1',
                [schedule.id],
              )
            ).rows[0];
            assert.equal(applied.revision, saved.revision + 1);
            assert.equal(applied.enabled, action !== 'schedule_pause');
            assert.deepEqual(applied.authority.approvals ?? [], saved.authority.approvals ?? []);
            assert.equal(applied.authority.messages.at(-1).approvalId, reviewed.id);
            assert.deepEqual(
              applied.authority.messages.at(-1).fields,
              action === 'schedule_pause' ? { enabled: false } : { title: args.title },
            );

            assert.equal(applied.title, args.title ?? saved.title);
            if (action === 'schedule_pause') {
              const listed = (await request('GET', '/api/schedules'))
                .json()
                .find((item: { id: string }) => item.id === schedule.id);
              assert.equal(listed.enabled, false);
              assert.equal(listed.nextRun, null);
            }
          }
        },
      );

      await inPart('manual schedule runs deliver once and cannot create schedules', async () => {
        const schedule = await reminder();
        const input = { requestId: randomUUID(), expectedRevision: 0 };
        const response = await request('POST', `/api/schedules/${schedule.id}/run`, input);
        assert.equal(response.statusCode, 200, response.body);
        const turnId = response.json().turnId;
        await waitFor(turnId, 'succeeded');
        const { prompt } = (await pool.query('SELECT prompt FROM turns WHERE id=$1', [turnId]))
          .rows[0];
        plans.set(prompt, {
          tool: 'send_message',
          action: '',
          args: { text: 'The synthetic schedule finished.' },
        });
        const deliveryInput = { ...input, requestId: randomUUID() };
        const delivered = await request('POST', `/api/schedules/${schedule.id}/run`, deliveryInput);
        assert.equal(delivered.statusCode, 200, delivered.body);
        const deliveredTurn = delivered.json().turnId;
        await waitFor(deliveredTurn, 'succeeded');
        const messages = await pool.query(
          "SELECT text FROM messages WHERE turn_id=$1 AND role='assistant'",
          [deliveredTurn],
        );
        assert.equal(messages.rowCount, 1);
        assert.equal(messages.rows[0].text, 'The synthetic schedule finished.');
        const repeated = await request('POST', `/api/schedules/${schedule.id}/run`, deliveryInput);
        assert.equal(repeated.statusCode, 200, repeated.body);
        assert.deepEqual(repeated.json(), { turnId: deliveredTurn, activeRun: null });
        assert.equal(
          (await pool.query('SELECT 1 FROM schedule_runs WHERE schedule_id=$1', [schedule.id]))
            .rowCount,
          2,
        );
        plans.set(prompt, {
          action: 'schedule_create',
          args: {
            title: 'Another synthetic reminder',
            prompt: 'Return a synthetic result.',
            kind: 'once',
            runAt: '2099-01-02T09:00:00Z',
            timeZone: 'UTC',
          },
        });
        const before = (await pool.query('SELECT count(*)::int AS count FROM schedules')).rows[0]
          .count;
        const refused = await request('POST', `/api/schedules/${schedule.id}/run`, {
          ...input,
          requestId: randomUUID(),
        });
        assert.equal(refused.statusCode, 200, refused.body);
        await waitFor(refused.json().turnId, 'failed');
        const failure = (
          await pool.query('SELECT error FROM turns WHERE id=$1', [refused.json().turnId])
        ).rows[0];
        assert.match(failure.error, /scheduled run cannot create schedules/i);
        assert.equal(
          (await pool.query('SELECT count(*)::int AS count FROM schedules')).rows[0].count,
          before,
        );
        plans.delete(prompt);
        await request('DELETE', `/api/schedules/${schedule.id}`);
      });

      await inPart(
        'unusable schedule evidence fails before the model and posts the named failure, and a later withdrawn request does not',
        async () => {
          const title = 'Synthetic unavailable schedule';
          const schedule = await reminder({ title });
          const threadId = (await request('GET', '/api/state')).json().threadId;
          const sourceTurn = randomUUID();
          const sourceMessage = randomUUID();
          const text = 'Read the synthetic board. Never send email.';
          await pool.query(
            "INSERT INTO turns(id,owner_id,thread_id,session_id,source,prompt,status,withdrawn) VALUES($1,$2,$3,$3,'user',$4,'succeeded',true)",
            [sourceTurn, ownerId, threadId, text],
          );
          await pool.query(
            "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,'user',$5)",
            [sourceMessage, ownerId, threadId, sourceTurn, text],
          );
          for (const [authority, reason] of [
            [null, /no saved owner instruction/],
            [{ messages: [] }, /no saved owner instruction/],
            [
              {
                messages: [
                  {
                    id: null,
                    at: new Date().toISOString(),
                    text: 'Background only.',
                    canAuthorize: false,
                  },
                ],
              },
              /no saved owner instruction/,
            ],
            [{ messages: [], requiresReplacement: true }, /changes without source records/],
          ] as const) {
            await pool.query('UPDATE schedules SET authority=$2 WHERE id=$1', [
              schedule.id,
              authority === null ? null : JSON.stringify(authority),
            ]);
            const response = await request('POST', `/api/schedules/${schedule.id}/run`, {
              requestId: randomUUID(),
              expectedRevision: 0,
            });
            assert.equal(response.statusCode, 200, response.body);
            const turnId = response.json().turnId;
            await waitFor(turnId, 'failed');
            assert.equal(prompts.has(turnId), false);
            const failure = (await pool.query('SELECT error FROM turns WHERE id=$1', [turnId]))
              .rows[0];
            assert.match(failure.error, reason);
            let notices: { text: string }[] = [];
            for (let attempt = 0; attempt < 250 && !notices.length; attempt++) {
              notices = (
                await pool.query(
                  "SELECT text FROM messages WHERE turn_id=$1 AND role='assistant'",
                  [turnId],
                )
              ).rows;
              if (!notices.length) await delay(20);
            }
            assert.equal(notices.length, 1);
            assert.ok(notices[0].text.includes(title));
            assert.match(notices[0].text, reason);
          }
          await pool.query('UPDATE schedules SET authority=$2 WHERE id=$1', [
            schedule.id,
            JSON.stringify({
              messages: [{ id: sourceMessage, at: new Date().toISOString(), text }],
            }),
          ]);
          const withdrawn = await request('POST', `/api/schedules/${schedule.id}/run`, {
            requestId: randomUUID(),
            expectedRevision: 0,
          });
          assert.equal(withdrawn.statusCode, 200, withdrawn.body);
          await waitFor(withdrawn.json().turnId, 'succeeded');
          await request('DELETE', `/api/schedules/${schedule.id}`);
        },
      );

      await inPart(
        'direct schedule pause or deletion retires an outstanding chat confirmation',
        async () => {
          for (const method of ['PATCH', 'DELETE'] as const) {
            const schedule = await reminder({
              kind: 'recurring',
              cron: '0 0 * * 0',
              runAt: null,
            });
            const prompt = `Synthetic scheduled cancellation ${randomUUID()}`;
            const requestedId = method === 'PATCH' ? schedule.id.toUpperCase() : schedule.id;
            plans.set(prompt, { action: 'schedule_pause', args: { id: requestedId } });
            const turn = await transaction(async (client) => {
              const turnId = await enqueueTurn(prompt, {
                source: 'schedule',
                sourceId: `schedule-fixture:${randomUUID()}`,
                background: true,
                client,
              });
              await client.query(
                `INSERT INTO schedule_runs(id,owner_id,schedule_id,schedule_revision,job_id,title,turn_id,scheduled_for,time_zone,authority)
                 VALUES($1,$2,$3,0,$4,$5,$6,$7,'UTC',jsonb_build_object('messages',jsonb_build_array(jsonb_build_object('id',null,'at',now(),'text',$8::text))))`,
                [
                  randomUUID(),
                  ownerId,
                  schedule.id,
                  randomUUID(),
                  'Synthetic cancellation reminder',
                  turnId,
                  new Date().toISOString(),
                  'Check the synthetic schedule status.',
                ],
              );
              return turnId;
            }, pool);
            await waitFor(turn, 'waiting');
            const [approval] = await approvalsFor(turn);
            assert.equal(approval.status, 'pending');
            assert.equal(approval.action, 'NOD_schedule_pause');
            assert.deepEqual(approval.args, { id: requestedId });
            const before = await request('GET', '/api/state');
            assert.equal(before.statusCode, 200, before.body);
            const beforeState = before.json<AppState>();
            const confirmation = await confirmationFor(approval);
            assert.match(confirmation, /pause a schedule/i);
            assert.match(confirmation, /Synthetic cancellation reminder/);
            assert.doesNotMatch(confirmation, /NOD_schedule_pause|\{"args"/);
            assert.equal(
              beforeState.messages.find(
                (message) => message.id === approval.confirmation_message_id,
              )?.text,
              confirmation,
            );
            const response = await request(
              method,
              `/api/schedules/${schedule.id}`,
              method === 'PATCH' ? { enabled: false } : undefined,
            );
            assert.equal(response.statusCode, 200, response.body);
            if (method === 'PATCH') await assertPaused(schedule);
            else {
              assert.equal(
                (
                  await pool.query('SELECT id FROM schedules WHERE id=$1 AND owner_id=$2', [
                    schedule.id,
                    ownerId,
                  ])
                ).rowCount,
                0,
              );
              assert.equal(
                (
                  await pool.query(`SELECT state FROM ${bossSchema}.job WHERE id=$1`, [
                    schedule.jobId,
                  ])
                ).rows[0].state,
                'cancelled',
              );
            }
            assert.equal((await approvalsFor(turn))[0].status, 'expired');
            const waiting = (
              await pool.query('SELECT status FROM turns WHERE id=$1 AND owner_id=$2', [
                turn,
                ownerId,
              ])
            ).rows[0];
            assert.notEqual(waiting.status, 'waiting');
            const state = await request('GET', '/api/state');
            assert.equal(state.statusCode, 200, state.body);
            const afterState = state.json<AppState>();
            assert.ok(afterState.hiddenMessageIds?.includes(approval.confirmation_message_id));
            assert.equal(
              afterState.messages.some(
                (message) => message.id === approval.confirmation_message_id,
              ),
              false,
            );
            assert.equal(
              mergeMessages(
                beforeState.messages,
                afterState.messages,
                new Set(afterState.hiddenMessageIds),
              ).some((message) => message.id === approval.confirmation_message_id),
              false,
            );
            const staleReply = await request('POST', '/api/messages', {
              text: 'Yes',
              replyToMessageId: approval.confirmation_message_id,
              clientMessageId: randomUUID(),
            });
            assert.equal(staleReply.statusCode, 404, staleReply.body);
          }
        },
      );

      await inPart(
        'retiring a schedule confirmation leaves its saved task open with a reply target',
        async () => {
          const schedule = await reminder({ kind: 'recurring', cron: '0 0 * * 0', runAt: null });
          const taskId = randomUUID();
          const parentId = randomUUID();
          const ownerMessageId = randomUUID();
          const prompt = `Synthetic saved task cancellation ${randomUUID()}`;
          const threadId = (await request('GET', '/api/state')).json<AppState>().threadId;
          plans.set(prompt, { action: 'schedule_pause', args: { id: schedule.id } });
          const turn = await transaction(async (client) => {
            await client.query(
              `INSERT INTO turns(id,owner_id,thread_id,session_id,source,message_id,prompt,status,finished_at)
               VALUES($1,$2,$3,$3,'user',$4,$5,'succeeded',now())`,
              [parentId, ownerId, threadId, ownerMessageId, 'Cancel the synthetic reminder.'],
            );
            await client.query(
              `INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text)
               VALUES($1,$2,$3,$4,'user',$5)`,
              [ownerMessageId, ownerId, threadId, parentId, 'Cancel the synthetic reminder.'],
            );
            const id = await enqueueTurn(prompt, {
              source: 'task',
              sessionId: taskId,
              parentTurnId: parentId,
              background: true,
              client,
            });
            await client.query(
              `INSERT INTO tasks(id,owner_id,turn_id,session_id,source_message_id,title,done_when,now_text,applied_revision)
               VALUES($1,$2,$3,$1,$4,'Synthetic saved task','Other work completed','Waiting for approval',1)`,
              [taskId, ownerId, id, ownerMessageId],
            );
            await client.query('UPDATE turns SET task_id=$1,task_revision=1 WHERE id=$2', [
              taskId,
              id,
            ]);
            return id;
          }, pool);
          await waitFor(turn, 'waiting');
          const [approval] = await approvalsFor(turn);
          assert.equal(approval.status, 'pending');
          assert.equal(approval.action, 'NOD_schedule_pause');
          const before = (await request('GET', '/api/tasks'))
            .json<Task[]>()
            .find((task) => task.id === taskId);
          assert.ok(before);
          assert.equal(before.status, 'needs_you');
          const confirmation = await confirmationFor(approval);
          assert.equal(before.question, confirmation);
          assert.equal(before.messageId, null);
          const turnCount = (
            await pool.query(
              'SELECT count(*)::int AS count FROM turns WHERE owner_id=$1 AND session_id=$2',
              [ownerId, taskId],
            )
          ).rows[0].count;
          for (const [table, rowId] of [
            ['turns', turn],
            ['tasks', taskId],
          ] as const) {
            const blocker = await pool.connect();
            try {
              await blocker.query('BEGIN');
              await blocker.query(
                `SELECT id FROM ${table} WHERE id=$1 AND owner_id=$2 FOR NO KEY UPDATE`,
                [rowId, ownerId],
              );
              const blocked = await request('PATCH', `/api/schedules/${schedule.id}`, {
                enabled: false,
              });
              assert.equal(blocked.statusCode, 409, blocked.body);
              assert.match(blocked.body, /still being updated/);
              assert.equal((await approvalsFor(turn))[0].status, 'pending');
              assert.equal(
                (await pool.query('SELECT enabled FROM schedules WHERE id=$1', [schedule.id]))
                  .rows[0].enabled,
                true,
              );
            } finally {
              await blocker.query('ROLLBACK');
              blocker.release();
            }
          }
          const paused = await request('PATCH', `/api/schedules/${schedule.id}`, {
            enabled: false,
          });
          assert.equal(paused.statusCode, 200, paused.body);
          assert.equal((await approvalsFor(turn))[0].status, 'expired');
          assert.equal(
            (await pool.query('SELECT status FROM turns WHERE id=$1', [turn])).rows[0].status,
            'cancelled',
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS count FROM turns WHERE owner_id=$1 AND session_id=$2',
                [ownerId, taskId],
              )
            ).rows[0].count,
            turnCount,
          );
          const detail = (await request('GET', `/api/tasks/${taskId}`)).json<{
            task: Task;
            events: Array<{ type: string; summary: string }>;
          }>();
          assert.equal(detail.task.status, 'needs_you');
          assert.match(detail.task.question ?? '', /This task is still open/);
          assert.ok(detail.task.questionMessageId);
          assert.notEqual(detail.task.questionMessageId, approval.confirmation_message_id);
          assert.equal(
            detail.events.some((event) => event.summary === confirmation),
            false,
          );
          assert.ok(detail.events.some((event) => event.summary === detail.task.question));
          const state = (await request('GET', '/api/state')).json<AppState>();
          assert.equal(
            state.messages.some((message) => message.id === approval.confirmation_message_id),
            false,
          );
          assert.ok(state.messages.some((message) => message.id === detail.task.questionMessageId));
          const reply = await request('POST', '/api/messages', {
            text: 'Continue the remaining synthetic work.',
            replyToMessageId: detail.task.questionMessageId,
            clientMessageId: randomUUID(),
          });
          assert.equal(reply.statusCode, 200, reply.body);
          await waitFor(reply.json().turnId, 'succeeded');
          const resumed = (
            await pool.query('SELECT session_id,parent_turn_id,task_id FROM turns WHERE id=$1', [
              reply.json().turnId,
            ])
          ).rows[0];
          assert.deepEqual(resumed, {
            session_id: taskId,
            parent_turn_id: turn,
            task_id: taskId,
          });
          assert.equal((await approvalsFor(turn))[0].status, 'expired');
        },
      );

      await inPart('state counts all hidden messages while bounding recent IDs', async () => {
        const beforeResponse = await request('GET', '/api/state');
        assert.equal(beforeResponse.statusCode, 200, beforeResponse.body);
        const before = beforeResponse.json<AppState>();
        assert.ok(Number.isInteger(before.hiddenMessageCount));
        const hiddenIds: string[] = Array.from({ length: 161 }, () => randomUUID());
        const visibleId = randomUUID();
        const foreignId = randomUUID();
        const archivedId = randomUUID();
        const archivedThreadId = randomUUID();
        await pool.query('INSERT INTO threads(id,owner_id,archived_at) VALUES($1,$2,now())', [
          archivedThreadId,
          ownerId,
        ]);
        try {
          await pool.query(
            `INSERT INTO messages(id,owner_id,thread_id,role,text,hidden_at)
             SELECT source.id,$2,$3,'assistant','Retired state fixture',
               clock_timestamp()+make_interval(mins => source.position::int)
             FROM unnest($1::uuid[]) WITH ORDINALITY AS source(id,position)`,
            [hiddenIds, ownerId, before.threadId],
          );
          await pool.query(
            `INSERT INTO messages(id,owner_id,thread_id,role,text,hidden_at) VALUES
             ($1,$2,$3,'assistant','Visible state fixture',NULL),
             ($4,'foreign-owner',$3,'assistant','Foreign retired fixture',now()+interval '1 day'),
             ($5,$2,$6,'assistant','Archived retired fixture',now()+interval '1 day')`,
            [visibleId, ownerId, before.threadId, foreignId, archivedId, archivedThreadId],
          );
          const response = await request('GET', '/api/state');
          assert.equal(response.statusCode, 200, response.body);
          const state = response.json<AppState>();
          assert.equal(state.hiddenMessageCount, before.hiddenMessageCount! + hiddenIds.length);
          assert.equal(state.hiddenMessageIds?.length, 150);
          assert.deepEqual(state.hiddenMessageIds, hiddenIds.slice(-150).reverse());
          assert.ok(state.messages.some(({ id }) => id === visibleId));
          assert.ok(state.messages.every(({ id }) => !hiddenIds.includes(id)));
          const originalQuery = pool.query;
          const query = originalQuery.bind(pool) as unknown as (
            ...args: unknown[]
          ) => Promise<unknown>;
          let visibleRead: Promise<unknown> | undefined;
          pool.query = ((...args: unknown[]) => {
            const sql = args[0];
            if (typeof sql !== 'string') return query(...args);
            if (sql.includes('FROM (SELECT m.* FROM messages m WHERE m.owner_id=$1')) {
              const result = query(...args);
              visibleRead = result;
              return result;
            }
            if (sql.includes('ARRAY(SELECT id FROM messages WHERE owner_id=$1'))
              return (async () => {
                assert.ok(visibleRead);
                await visibleRead;
                await query('UPDATE messages SET hidden_at=now() WHERE id=$1 AND owner_id=$2', [
                  visibleId,
                  ownerId,
                ]);
                return query(...args);
              })();
            return query(...args);
          }) as typeof pool.query;
          try {
            const racedResponse = await request('GET', '/api/state');
            assert.equal(racedResponse.statusCode, 200, racedResponse.body);
            const racedState = racedResponse.json<AppState>();
            assert.equal(racedState.hiddenMessageCount, state.hiddenMessageCount! + 1);
            assert.equal(racedState.hiddenMessageIds?.includes(visibleId), false);
            assert.equal(
              racedState.messages.some(({ id }) => id === visibleId),
              false,
            );
          } finally {
            pool.query = originalQuery;
          }
        } finally {
          await pool.query('DELETE FROM messages WHERE id=ANY($1::uuid[])', [
            [...hiddenIds, visibleId, foreignId, archivedId],
          ]);
          await pool.query('DELETE FROM threads WHERE id=$1 AND owner_id=$2', [
            archivedThreadId,
            ownerId,
          ]);
        }
      });

      await inPart(
        'direct schedule pause waits for a channel confirmation already in flight',
        async () => {
          const schedule = await reminder({ kind: 'recurring', cron: '0 0 * * 0', runAt: null });
          const prompt = `Synthetic channel cancellation ${randomUUID()}`;
          const sourceId = `channel:telegram:bot:${randomUUID()}`;
          const channel = 'telegram:synthetic';
          plans.set(prompt, { action: 'schedule_pause', args: { id: schedule.id } });
          const turn = await transaction(async (client) => {
            const turnId = await enqueueTurn(prompt, {
              source: 'schedule',
              sourceId: `schedule-fixture:${randomUUID()}`,
              background: true,
              channel,
              channelSourceId: sourceId,
              client,
            });
            await client.query(
              `INSERT INTO schedule_runs(id,owner_id,schedule_id,schedule_revision,job_id,title,turn_id,scheduled_for,time_zone,authority)
             VALUES($1,$2,$3,0,$4,$5,$6,$7,'UTC',jsonb_build_object('messages',jsonb_build_array(jsonb_build_object('id',null,'at',now(),'text',$8::text))))`,
              [
                randomUUID(),
                ownerId,
                schedule.id,
                randomUUID(),
                'Synthetic cancellation reminder',
                turnId,
                new Date().toISOString(),
                'Check the synthetic schedule status.',
              ],
            );
            return turnId;
          }, pool);
          await waitFor(turn, 'waiting');
          const [approval] = await approvalsFor(turn);
          assert.equal(approval.status, 'pending');
          const messageId = approval.confirmation_message_id as string;
          const confirmation = await confirmationFor(approval);
          const taskId = randomUUID();
          await transaction(async (client) => {
            await client.query(
              `INSERT INTO tasks(id,owner_id,turn_id,session_id,title,done_when,now_text,applied_revision)
               VALUES($1,$2,$3,$3,'Synthetic channel task','Synthetic work finished','Waiting for approval',1)`,
              [taskId, ownerId, turn],
            );
            await client.query('UPDATE turns SET task_id=$1 WHERE id=$2 AND owner_id=$3', [
              taskId,
              turn,
              ownerId,
            ]);
          }, pool);
          const channelPool = new pg.Pool({
            connectionString: process.env.DATABASE_URL,
            max: 1,
            connectionTimeoutMillis: 10_000,
          });
          const posts: Array<{ threadId: string; text: string }> = [];
          let postEntered = false;
          let releasePost = () => {};
          const postReleased = new Promise<void>((resolve) => {
            releasePost = resolve;
          });
          const transport: MessagingTransport = {
            channels: [
              {
                id: 'telegram',
                status: 'configured',
                missing: [],
                accountId: 'bot',
                allowedSenderIds: ['111'],
              },
            ],
            receive: async () => ({ status: 200, body: {} }),
            post: async (input) => {
              postEntered = true;
              await postReleased;
              await channelPool.query('SELECT 1');
              posts.push({ threadId: input.threadId, text: input.text });
              return { id: 'synthetic-channel-message' };
            },
            close: async () => {},
          };
          let channels: Awaited<ReturnType<typeof createChannels>> | undefined;
          let sending: Promise<void> | undefined;
          let pausing: ReturnType<typeof request> | undefined;
          try {
            channels = await createChannels(channelPool, {
              ownerId,
              transport,
              subscribe: () => () => {},
              intervalMs: 600_000,
              submit: async () => {
                throw new Error('Synthetic channel did not receive a message.');
              },
              isRetirableScheduleConfirmation: async (id) =>
                Boolean(
                  (
                    await pool.query(
                      "SELECT 1 FROM approvals WHERE owner_id=$1 AND confirmation_message_id=$2 AND action='NOD_schedule_pause'",
                      [ownerId, id],
                    )
                  ).rowCount,
                ),
            });
            await channelPool.query(
              `INSERT INTO channel_inbox(source_id,provider,account_id,sender_id,thread_id,text,received_at,turn_id,state,created_at,owner_id,channel)
             VALUES($1,'telegram','bot','111','synthetic-chat','Synthetic channel request',now()-interval '1 minute',$2,'submitted',now()-interval '1 minute',$3,$4)`,
              [sourceId, turn, ownerId, channel],
            );
            sending = channels.drain();
            for (let attempt = 0; attempt < 300 && !postEntered; attempt++) await delay(20);
            assert.equal(postEntered, true);
            pausing = request('PATCH', `/api/schedules/${schedule.id}`, { enabled: false });
            let waiting = false;
            for (let attempt = 0; attempt < 300 && !waiting; attempt++) {
              waiting = Boolean(
                (
                  await admin.query(
                    `SELECT 1 FROM pg_stat_activity a WHERE a.wait_event_type='Lock'
                   AND a.query LIKE 'SELECT id FROM messages WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE%'
                   AND EXISTS (
                     SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
                     JOIN pg_namespace n ON n.oid=c.relnamespace
                     WHERE l.pid=a.pid AND l.granted AND c.relname='schedules' AND n.nspname=$1
                   ) LIMIT 1`,
                    [schema],
                  )
                ).rowCount,
              );
              if (!waiting) await delay(20);
            }
            assert.equal(waiting, true);
            assert.equal(
              (await pool.query('SELECT enabled FROM schedules WHERE id=$1', [schedule.id])).rows[0]
                .enabled,
              true,
            );
            releasePost();
            const response = await pausing;
            await sending;
            await channels.drain();
            assert.equal(response.statusCode, 200, response.body);
            await assertPaused(schedule);
            assert.equal((await approvalsFor(turn))[0].status, 'expired');
            assert.equal(posts.length, 2);
            assert.deepEqual(posts[0], { threadId: 'synthetic-chat', text: confirmation });
            assert.equal(posts[1]?.threadId, 'synthetic-chat');
            assert.match(posts[1]?.text ?? '', /This task is still open/);
            assert.notEqual(posts[1]?.text, confirmation);
            const noticeId = (
              await pool.query('SELECT continuation_message_id FROM tasks WHERE id=$1', [taskId])
            ).rows[0].continuation_message_id as string;
            assert.ok(noticeId);
            assert.deepEqual(
              (
                await channelPool.query('SELECT state FROM channel_outbox WHERE message_id=$1', [
                  messageId,
                ])
              ).rows,
              [{ state: 'sent' }],
            );
            assert.deepEqual(
              (
                await channelPool.query('SELECT state FROM channel_outbox WHERE message_id=$1', [
                  noticeId,
                ])
              ).rows,
              [{ state: 'sent' }],
            );
            assert.ok(
              (await pool.query('SELECT hidden_at FROM messages WHERE id=$1', [messageId])).rows[0]
                .hidden_at,
            );
          } finally {
            releasePost();
            await Promise.allSettled([sending, pausing]);
            await channels?.close();
            await channelPool.end();
          }
        },
      );

      await inPart(
        'legacy schedule approvals without a saved revision cannot execute',
        async () => {
          const schedule = await reminder();
          const turn = await propose('schedule_pause', { id: schedule.id });
          const [approval] = await approvalsFor(turn);
          await pool.query(
            "UPDATE approvals SET action='NOD_schedule_cancel',expected_revision=NULL WHERE id=$1",
            [approval.id],
          );
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

      await inPart(
        'legacy schedule cancellation approval still pauses the saved schedule',
        async () => {
          const schedule = await reminder({ kind: 'recurring', cron: '0 0 * * 0', runAt: null });
          const turn = await propose('schedule_pause', { id: schedule.id });
          const [approval] = await approvalsFor(turn);
          await pool.query("UPDATE approvals SET action='NOD_schedule_cancel' WHERE id=$1", [
            approval.id,
          ]);
          const response = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: approval.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          assert.equal(response.statusCode, 200, response.body);
          const resumed = response.json().turnId as string;
          await waitFor(resumed, 'succeeded');
          assert.equal((await approvalsFor(turn))[0].status, 'completed');
          assert.match(prompts.get(resumed) ?? '', /The schedule is paused/);
          const paused = (await request('GET', '/api/schedules'))
            .json()
            .find((item: { id: string }) => item.id === schedule.id);
          assert.equal(paused.enabled, false);
          assert.equal(paused.nextRun, null);
        },
      );

      await inPart(
        'legacy approval does not call a completed one-time schedule paused',
        async () => {
          const schedule = await reminder();
          const turn = await propose('schedule_pause', { id: schedule.id });
          const [approval] = await approvalsFor(turn);
          const threadId = (await request('GET', '/api/state')).json<AppState>().threadId;
          const finishedTurn = randomUUID();
          const runAt = '2020-01-01T09:00:00Z';
          await pool.query(
            `INSERT INTO turns(id,owner_id,thread_id,session_id,source,prompt,status,finished_at)
             VALUES($1,$2,$3,$3,'schedule','Synthetic completed reminder.','succeeded',now())`,
            [finishedTurn, ownerId, threadId],
          );
          await pool.query(
            `INSERT INTO schedule_runs(id,owner_id,schedule_id,schedule_revision,job_id,title,turn_id,scheduled_for,time_zone)
             VALUES($1,$2,$3,0,$4,'Synthetic cancellation reminder',$5,$6,'UTC')`,
            [randomUUID(), ownerId, schedule.id, randomUUID(), finishedTurn, runAt],
          );
          await pool.query(
            'UPDATE schedules SET enabled=false,run_at=$2,next_run_at=NULL,job_id=NULL WHERE id=$1',
            [schedule.id, runAt],
          );
          await pool.query("UPDATE approvals SET action='NOD_schedule_cancel' WHERE id=$1", [
            approval.id,
          ]);
          const response = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: approval.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          assert.equal(response.statusCode, 200, response.body);
          const resumed = response.json().turnId as string;
          await waitFor(resumed, 'succeeded');
          assert.equal((await approvalsFor(turn))[0].status, 'completed');
          assert.doesNotMatch(prompts.get(resumed) ?? '', /The schedule is paused/);
          const saved = (await request('GET', '/api/schedules'))
            .json()
            .find((item: { id: string }) => item.id === schedule.id);
          assert.equal(saved.enabled, false);
          assert.equal(saved.lastRun.scheduledFor, new Date(runAt).toISOString());
          assert.equal(saved.lastRun.status, 'succeeded');
        },
      );

      await inPart(
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

      await inPart('tool discovery runs without waiting for the checker', async () => {
        const turn = await propose('SEARCH_TOOLS', { query: 'gmail email' }, 'apps');
        const result = results.get(turn);
        assert.ok(result);
        assert.equal((await approvalsFor(turn)).length, 0);
      });

      await inPart(
        'large tool catalogs retain exact schema lookup without an action check',
        async () => {
          const schema = { type: 'object', properties: { value: { type: 'string' } } };
          toolSearch = Object.fromEntries(
            Array.from({ length: 8 }, (_, index) => [
              `GMAIL_SYNTHETIC_READ_${index}`,
              { description: `Synthetic read ${index}`, inputSchema: schema, hasFullSchema: true },
            ]),
          );
          const checks = fallbackChecks.length;
          try {
            const indexed = (await application.integrations.execute(ownerId, 'SEARCH_TOOLS', {
              query: 'Gmail tools',
            })) as { tools: Record<string, { inputSchema?: unknown; hasFullSchema?: boolean }> };
            assert.equal(Object.keys(indexed.tools).length, 8);
            assert.deepEqual(indexed.tools.GMAIL_SYNTHETIC_READ_0.inputSchema, schema);
            assert.equal(indexed.tools.GMAIL_SYNTHETIC_READ_7.hasFullSchema, false);
            assert.equal(indexed.tools.GMAIL_SYNTHETIC_READ_7.inputSchema, undefined);
            const exact = (await application.integrations.execute(ownerId, 'SEARCH_TOOLS', {
              query: 'GMAIL_SYNTHETIC_READ_7',
            })) as { tools: Record<string, { inputSchema?: unknown }> };
            assert.deepEqual(Object.keys(exact.tools), ['GMAIL_SYNTHETIC_READ_7']);
            assert.deepEqual(exact.tools.GMAIL_SYNTHETIC_READ_7.inputSchema, schema);
            const grouped = (await application.integrations.execute(ownerId, 'SEARCH_TOOLS', {
              query: 'GMAIL_SYNTHETIC_READ_3, GMAIL_SYNTHETIC_READ_7',
            })) as { tools: Record<string, { inputSchema?: unknown }> };
            assert.deepEqual(Object.keys(grouped.tools), [
              'GMAIL_SYNTHETIC_READ_3',
              'GMAIL_SYNTHETIC_READ_7',
            ]);
            assert.deepEqual(grouped.tools.GMAIL_SYNTHETIC_READ_3.inputSchema, schema);
            assert.deepEqual(grouped.tools.GMAIL_SYNTHETIC_READ_7.inputSchema, schema);
            const missing = (await application.integrations.execute(ownerId, 'SEARCH_TOOLS', {
              query: 'GMAIL_MISSING_ACTION',
            })) as { schemaError: string; tools: Record<string, unknown> };
            assert.match(missing.schemaError, /No tool named GMAIL_MISSING_ACTION/);
            assert.ok(Object.keys(missing.tools).includes('GMAIL_SYNTHETIC_READ_7'));
            const turn = await propose('SEARCH_TOOLS', { query: 'GMAIL_SYNTHETIC_READ_7' }, 'apps');
            assert.ok(results.get(turn));
            assert.deepEqual(await approvalsFor(turn), []);
            assert.equal(fallbackChecks.length, checks);
          } finally {
            toolSearch = undefined;
          }
        },
      );

      await inPart(
        'a schedule pause steered into a confirmed turn uses the fresh owner request',
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
            plans.set(text, { action: 'schedule_pause', args: { id: schedule.id } });
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
            await assertPaused(schedule);
          } finally {
            steering = undefined;
            release();
          }
        },
      );

      await inPart(
        'the small LLM checks actions and replies while the server writes confirmations',
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
          const fallbackBody = 'Synthetic fallback.';
          const sendChecks = () =>
            (fallbackChecks.slice(fallback) as Array<Record<string, any>>).filter((input) => {
              const checkedBody = input.action?.arguments?.body ?? input.data?.args?.body;
              return checkedBody === body || checkedBody === fallbackBody;
            });
          const turn = await propose(
            'GMAIL_SEND_EMAIL',
            { recipient_email: 'decision@example.test', body },
            'apps',
          );
          const [pending] = await approvalsFor(turn);
          assert.equal(pending.status, 'pending');
          assert.equal(integrationFixture.writes.length, writes);
          assert.deepEqual(decisionInputs.slice(before), []);
          const checked = sendChecks();
          assert.equal(checked.length, 1);
          assert.equal(checked[0].action.arguments.body, body);
          const confirmation = await confirmationFor(pending);
          assert.match(confirmation, /send a Gmail email/i);
          assert.match(confirmation, /decision@example.test/);
          assert.doesNotMatch(confirmation, /GMAIL_SEND_EMAIL|recipient_email|\{"args"/);
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
          assert.deepEqual(decisionInputs.slice(before), []);
          assert.deepEqual(smallReplies.at(-1), { reply: 'Yes' });
          assert.equal(sendChecks().length, 1);
          const rows = (
            await pool.query(
              'SELECT id,turn_id,cost_usd,details FROM model_usage WHERE owner_id=$1 AND NOT(id=ANY($2::text[])) ORDER BY created_at,id',
              [ownerId, previousUsage],
            )
          ).rows;
          assert.equal(rows.length, 1);
          assert.equal(rows.find((row) => row.details.model === 'fixture-small').turn_id, null);
          assert.deepEqual(
            rows.map((row) => row.details.operation),
            ['review'],
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
              { recipient_email: 'fallback@example.test', body: fallbackBody },
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
            assert.equal(sendChecks().length, 2);
          } finally {
            decisionsEnabled = true;
          }
        },
      );

      await inPart(
        'one authorization review per action stops later tools at the task check-in',
        async () => {
          for (const item of [
            {
              action: 'GMAIL_FETCH_EMAILS',
              args: { max_results: 1 },
              instruction: 'Read the synthetic inbox three times',
              completed: 2,
              mailChecks: 2,
            },
            {
              action: 'GMAIL_SEND_EMAIL',
              args: {
                recipient_email: 'budget@example.test',
                subject: 'Synthetic update',
                body: 'Synthetic budget check.',
              },
              instruction: 'Send the synthetic update three times to budget@example.test',
              completed: 2,
              mailChecks: 0,
            },
          ]) {
            const reset = await request('POST', '/api/conversation/reset', {
              threadId: ids.at(-1),
            });
            assert.equal(reset.statusCode, 200, reset.body);
            const before = executedApps.filter((action) => action === item.action).length;
            const checks = fallbackChecks.length;
            const text = `${item.instruction} ${randomUUID()}`;
            asked.add(text);
            batches.set(text, {
              subagents: false,
              sequential: true,
              calls: Array.from({ length: 3 }, () => ({ action: item.action, args: item.args })),
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
              ids.push(response.json().threadId);
              await waitFor(turnId, 'failed|succeeded');
              assert.equal(
                executedApps.filter((action) => action === item.action).length,
                before + item.completed,
              );
              assert.equal(fallbackChecks.length, checks + item.completed);
              assert.deepEqual(await approvalsFor(turnId), []);
              const rows = (
                await pool.query(
                  "SELECT id,cost_usd,details->>'operation' AS operation FROM model_usage WHERE turn_id=$1",
                  [turnId],
                )
              ).rows;
              const reviews = rows.filter((row) => row.operation === 'review');
              assert.deepEqual(
                reviews.map((row) => row.cost_usd),
                [0.6, 0.6],
              );
              assert.equal(
                rows.filter((row) => row.operation === 'access').length,
                item.mailChecks,
              );
              assert.equal(rows.length, 2 + item.mailChecks);
            } finally {
              checkCost = undefined;
              asked.delete(text);
              await pool.query('DELETE FROM spending_limits WHERE owner_id=$1', [ownerId]);
            }
          }
        },
      );

      await inPart(
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
      await inPart(
        'a failed approved attachment upload keeps its safe reason on the original card',
        async (t) => {
          t.after(() => {
            uploadFailure = undefined;
            workspaceFiles.delete('failed-report.pdf');
          });
          const sends = () =>
            integrationFixture.writes.filter((write) => write.action === 'GMAIL_SEND_EMAIL').length;
          const beforeSends = sends();
          const beforeAttempts = uploadAttempts;
          const beforeUploads = uploads.length;
          workspaceFiles.set('failed-report.pdf', Buffer.from('%PDF-1.7 synthetic failed report'));
          const held = await propose(
            'GMAIL_SEND_EMAIL',
            {
              recipient_email: 'collector@example.test',
              subject: 'Synthetic failed report',
              body: 'Synthetic attachment.',
              attachment: { workspaceFile: 'failed-report.pdf', mimeType: 'application/pdf' },
            },
            'apps',
          );
          const [card] = await approvalsFor(held);
          assert.equal(card.status, 'pending');
          assert.equal(uploadAttempts, beforeAttempts);
          uploadFailure = new Error(
            'The attachment upload failed (HTTP 503): synthetic provider unavailable; api_key=PRIVATE_UPLOAD_CANARY',
          );
          const clicked = {
            text: 'Send',
            replyToMessageId: card.confirmation_message_id,
            clientMessageId: randomUUID(),
            approvalAnswer: { approvalId: card.id, approved: true },
          };
          const approved = await request('POST', '/api/messages', clicked);
          assert.equal(approved.statusCode, 200, approved.body);
          await waitFor(approved.json().turnId, 'succeeded');
          const saved = (await approvalsFor(held))[0];
          assert.equal(saved.status, 'expired');
          assert.equal(uploadAttempts, beforeAttempts + 1);
          assert.equal(uploads.length, beforeUploads);
          assert.equal(sends(), beforeSends);
          for (let read = 0; read < 2; read++) {
            const response = await request(
              'GET',
              '/api/messages/around/' + card.confirmation_message_id,
            );
            assert.equal(response.statusCode, 200, response.body);
            const message = response
              .json()
              .find((item: { id: string }) => item.id === card.confirmation_message_id);
            assert.equal(message.approval.id, card.id);
            assert.equal(message.approval.state, 'expired');
            assert.match(message.approval.failure ?? '', /HTTP 503/);
            assert.match(message.approval.failure, /synthetic provider unavailable/);
            assert.equal(saved.result.error, message.approval.failure);
            assert.doesNotMatch(JSON.stringify({ saved, message }), /PRIVATE_UPLOAD_CANARY/);
            for (const Component of [ApprovalCard, ApprovalChoiceCard]) {
              const html = renderToStaticMarkup(
                createElement(Component, {
                  approval: message.approval,
                  children: 'Synthetic attachment approval',
                }),
              );
              assert.match(html, /Not run/);
              assert.match(html, /HTTP 503/);
              assert.doesNotMatch(html, /PRIVATE_UPLOAD_CANARY/);
            }
          }
          assert.equal(uploadAttempts, beforeAttempts + 1);
          assert.equal(sends(), beforeSends);
        },
      );

      await inPart(
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
      await inPart(
        'HTTP confirmations describe the exact request and bind it to the selected account',
        async () => {
          const { createAppGrantVault } = await import('../src/server/vault-app-grants.ts');
          const calls: Array<{ method: string; url: string; body: string }> = [];
          const server = createServer(async (incoming, outgoing) => {
            const chunks: Buffer[] = [];
            for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
            assert.equal(incoming.headers.authorization, 'Bearer synthetic-http-context-token');
            calls.push({
              method: incoming.method!,
              url: incoming.url!,
              body: Buffer.concat(chunks).toString(),
            });
            outgoing.setHeader('content-type', 'application/json');
            outgoing.end(JSON.stringify({ value: 'Synthetic signals' }));
          });
          await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
          const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
          const connectionId = randomUUID();
          const pathId = randomUUID();
          const paths = [
            { id: pathId, kind: 'http', endpoint: `${origin}/v2`, auth: 'bearer', local: true },
          ];
          const route = '/signals?label=Caf%C3%A9&route=one%2Ftwo';
          const url = `${origin}/v2${route}`;
          const wording: Array<Record<string, any>> = [];
          let expected: Record<string, unknown>;
          let duringWording: (() => Promise<void>) | undefined;
          try {
            await pool.query(
              'INSERT INTO discovered_connections(id,owner_id,service,name,account_name,paths) VALUES($1,$2,$3,$4,$5,$6)',
              [
                connectionId,
                ownerId,
                'http-context-fixture',
                'Synthetic HTTP API',
                'Synthetic account',
                JSON.stringify(paths),
              ],
            );
            const grants = await createAppGrantVault(pool, {
              ownerId,
              keyStore: {
                id: 'fixture',
                configured: true,
                getKey: async () => Buffer.alloc(32, 7),
              },
            });
            await grants.put(connectionId, 'synthetic-http-context-token');
            confirmationModel = async (input) => {
              const current = input as Record<string, any>;
              wording.push(structuredClone(current));
              if (duringWording) {
                const change = duringWording;
                duringWording = undefined;
                await change();
              }
              if (current.purpose === 'confirmation_review')
                return current.data.action === 'HTTP request'
                  ? { valid: true }
                  : {
                      valid: false,
                      reason: 'The proposed operation is a raw connected HTTP wrapper.',
                    };
              return {
                text: `Can I make the ${expected.method} request to ${url}?`,
                action: 'Make request',
              };
            };
            for (const method of ['GET', 'POST'] as const) {
              const body = { label: 'Synthetic record', count: 2 };
              expected = { method, url, ...(method === 'POST' ? { body } : {}) };
              const args = {
                connectionId,
                pathId,
                method,
                path: route,
                body: method === 'GET' ? { ignored: 'synthetic-ignored-body' } : body,
              };
              const before = calls.length;
              wording.length = 0;
              const held = await propose('CONNECTED_HTTP', args, 'apps');
              const [card] = await approvalsFor(held);
              assert.equal(card.status, 'pending');
              assert.deepEqual(card.args, args);
              assert.equal(typeof card.details.verifiedBinding, 'string');
              assert.equal(calls.length, before);
              assert.deepEqual(
                wording.map((input) => input.purpose),
                ['confirmation'],
              );
              for (const input of wording) {
                assert.equal(input.data.action, 'HTTP request');
                assert.deepEqual(input.data.args, expected);
                assert.doesNotMatch(
                  JSON.stringify(input),
                  /synthetic-http-context-token|verifiedBinding|connectionId|pathId|synthetic-ignored-body/,
                );
              }
              const question = await confirmationFor(card);
              assert.ok(question.includes(method));
              assert.ok(question.includes('/v2/signals'));
              assert.ok(question.includes(String((server.address() as { port: number }).port)));
              const response = await request('POST', '/api/messages', {
                text: 'Yes',
                replyToMessageId: card.confirmation_message_id,
                approvalAnswer: { approvalId: card.id, approved: true },
              });
              assert.equal(response.statusCode, 200, response.body);
              await waitFor(response.json().turnId, 'succeeded');
              assert.equal((await approvalsFor(held))[0].status, 'completed');
              const saved = await request(
                'GET',
                `/api/messages/around/${card.confirmation_message_id}`,
              );
              assert.equal(saved.statusCode, 200, saved.body);
              const message = saved
                .json()
                .find((item: { id: string }) => item.id === card.confirmation_message_id);
              assert.equal(message.approval.state, 'done');
              assert.equal(message.text, question);
              const html = renderToStaticMarkup(
                createElement(ApprovalCard, {
                  approval: message.approval,
                  children: message.text,
                }),
              );
              assert.ok(html.includes('/v2/signals'));
              assert.ok(html.includes(method));
              assert.doesNotMatch(html, /CONNECTED_HTTP|synthetic-http-context-token/);
              assert.deepEqual(
                calls.slice(before).map((call) => ({
                  ...call,
                  body: call.body ? JSON.parse(call.body) : undefined,
                })),
                [{ method, url: `/v2${route}`, body: method === 'GET' ? undefined : body }],
              );
              const repeated = await request('POST', '/api/messages', {
                text: 'Yes',
                replyToMessageId: card.confirmation_message_id,
                approvalAnswer: { approvalId: card.id, approved: true },
              });
              assert.equal(repeated.statusCode, 409, repeated.body);
              assert.equal(calls.length, before + 1);
            }
            expected = { method: 'GET', url };
            const nextArgs = () => ({ connectionId, pathId, method: 'GET', path: route });
            for (const changed of [false, true]) {
              httpReview = async () => {
                if (changed)
                  await pool.query('UPDATE discovered_connections SET paths=$2 WHERE id=$1', [
                    connectionId,
                    JSON.stringify([{ ...paths[0], endpoint: `${origin}/replacement` }]),
                  ]);
                return { run: true, source: 'read' };
              };
              const prompt = `Synthetic HTTP direct request ${randomUUID()}`;
              plans.set(prompt, {
                tool: 'apps',
                action: 'CONNECTED_HTTP',
                args: {
                  ...nextArgs(),
                  path: `/auto-allowed?case=${changed ? 'changed' : 'unchanged'}`,
                },
              });
              const response = await request('POST', '/api/messages', { text: prompt });
              assert.equal(response.statusCode, 200, response.body);
              const immediate = response.json().turnId;
              await waitFor(immediate, 'succeeded|failed');
              assert.deepEqual(await approvalsFor(immediate), []);
              assert.equal(calls.length, 3);
              if (changed) {
                const turn = (await pool.query('SELECT error FROM turns WHERE id=$1', [immediate]))
                  .rows[0];
                assert.match(
                  JSON.stringify(results.get(immediate)) ?? turn.error,
                  /connected account changed/,
                );
              } else
                assert.deepEqual(calls.at(-1), {
                  method: 'GET',
                  url: '/v2/auto-allowed?case=unchanged',
                  body: '',
                });
              httpReview = undefined;
              await pool.query('UPDATE discovered_connections SET paths=$2 WHERE id=$1', [
                connectionId,
                JSON.stringify(paths),
              ]);
            }
            for (const reason of ['rebind', 'legacy', 'stop']) {
              const held = await propose('CONNECTED_HTTP', nextArgs(), 'apps');
              const [card] = await approvalsFor(held);
              if (reason === 'rebind')
                await pool.query('UPDATE discovered_connections SET paths=$2 WHERE id=$1', [
                  connectionId,
                  JSON.stringify([{ ...paths[0], endpoint: `${origin}/replacement` }]),
                ]);
              else if (reason === 'legacy')
                await pool.query(
                  "UPDATE approvals SET details=details-'verifiedBinding' WHERE id=$1",
                  [card.id],
                );
              else assert.equal((await request('POST', '/api/thread/stop')).statusCode, 200);
              const response = await request('POST', '/api/messages', {
                text: 'Yes',
                replyToMessageId: card.confirmation_message_id,
                approvalAnswer: { approvalId: card.id, approved: true },
              });
              if (reason === 'stop') assert.equal(response.statusCode, 409, response.body);
              else {
                assert.equal(response.statusCode, 200, response.body);
                await waitFor(response.json().turnId, 'succeeded|failed');
                const [expired] = await approvalsFor(held);
                assert.equal(expired.status, 'expired');
                assert.match(
                  JSON.stringify(expired.result),
                  reason === 'rebind' ? /connected account changed/ : /no saved account binding/,
                );
              }
              assert.equal(calls.length, 3);
              await pool.query('UPDATE discovered_connections SET paths=$2 WHERE id=$1', [
                connectionId,
                JSON.stringify(paths),
              ]);
            }
            duringWording = async () => {
              await pool.query(
                'UPDATE discovered_connections SET account_id=gen_random_uuid() WHERE id=$1',
                [connectionId],
              );
            };
            const prompt = `Synthetic HTTP account change ${randomUUID()}`;
            plans.set(prompt, { tool: 'apps', action: 'CONNECTED_HTTP', args: nextArgs() });
            const changed = await request('POST', '/api/messages', { text: prompt });
            assert.equal(changed.statusCode, 200, changed.body);
            await waitFor(changed.json().turnId, 'succeeded|failed');
            assert.equal(duringWording, undefined);
            assert.deepEqual(await approvalsFor(changed.json().turnId), []);
            const changedTurn = (
              await pool.query('SELECT error FROM turns WHERE id=$1', [changed.json().turnId])
            ).rows[0];
            assert.match(
              JSON.stringify(results.get(changed.json().turnId)) ?? changedTurn.error,
              /connected account changed before confirmation/,
            );
            assert.equal(calls.length, 3);

            const body = { label: 'Synthetic repeated record', count: 4 };
            const args = { ...nextArgs(), method: 'POST', body };
            expected = { method: 'POST', url, body };
            const initial = await propose('CONNECTED_HTTP', args, 'apps');
            const [first] = await approvalsFor(initial);
            const question = 'Should I send the same synthetic request again?';
            questionAfterConfirm = question;
            const accepted = await request('POST', '/api/messages', {
              text: 'Make request',
              replyToMessageId: first.confirmation_message_id,
              approvalAnswer: { approvalId: first.id, approved: true },
            });
            assert.equal(accepted.statusCode, 200, accepted.body);
            await waitFor(accepted.json().turnId, 'waiting');
            assert.equal(calls.length, 4);
            const savedQuestion = (
              await pool.query(
                "SELECT id FROM messages WHERE turn_id=$1 AND role='assistant' AND text=$2",
                [accepted.json().turnId, question],
              )
            ).rows[0];
            assert.ok(savedQuestion);
            const reply = 'Send the same synthetic request again.';
            plans.set(reply, { tool: 'apps', action: 'CONNECTED_HTTP', args });
            repeatDecision = 'new';
            httpReview = async () => ({ run: true, source: 'read' });
            wording.length = 0;
            const repeated = await request('POST', '/api/messages', {
              text: reply,
              replyToMessageId: savedQuestion.id,
            });
            assert.equal(repeated.statusCode, 200, repeated.body);
            await waitFor(repeated.json().turnId, 'waiting');
            const [second] = await approvalsFor(repeated.json().turnId);
            assert.equal(second.status, 'pending');
            assert.equal(second.source_message_id, repeated.json().messageId);
            assert.deepEqual(second.details.request, expected);
            assert.equal(second.details.verifiedBinding, first.details.verifiedBinding);
            assert.equal(calls.length, 4);
            assert.deepEqual(
              wording.map((input) => input.purpose),
              ['confirmation'],
            );
            for (const input of wording) {
              assert.equal(input.data.action, 'HTTP request');
              assert.deepEqual(input.data.args, expected);
            }
            const confirmed = await request('POST', '/api/messages', {
              text: 'Make request',
              replyToMessageId: second.confirmation_message_id,
              approvalAnswer: { approvalId: second.id, approved: true },
            });
            assert.equal(confirmed.statusCode, 200, confirmed.body);
            await waitFor(confirmed.json().turnId, 'succeeded');
            assert.equal(calls.length, 5);
            assert.deepEqual(
              { ...calls.at(-1), body: JSON.parse(calls.at(-1)!.body) },
              {
                method: 'POST',
                url: `/v2${route}`,
                body,
              },
            );
          } finally {
            questionAfterConfirm = undefined;
            repeatDecision = 'same';
            httpReview = undefined;
            confirmationModel = undefined;
            await pool.query('DELETE FROM vault_app_grants WHERE owner_id=$1 AND id=$2', [
              ownerId,
              connectionId,
            ]);
            await pool.query('DELETE FROM discovered_connections WHERE owner_id=$1 AND id=$2', [
              ownerId,
              connectionId,
            ]);
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
        },
      );

      await inPart(
        'MCP confirmations use the selected tool definition and exact input',
        async () => {
          const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
          const { StreamableHTTPServerTransport } =
            await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
          const rowsDescription = 'Read the current rows from the selected table.';
          const executionDescription =
            'Read an execution. includeData true returns node inputs and outputs; false returns status only.';
          const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
          const server = createServer(async (incoming, outgoing) => {
            const mcp = new McpServer({ name: 'synthetic-review-context', version: '1' });
            mcp.registerTool(
              'data_table_rows',
              {
                description: rowsDescription,
                inputSchema: { tableId: z.string().describe('The exact table ID.') },
              },
              async (input) => {
                calls.push({ tool: 'data_table_rows', input });
                return { content: [{ type: 'text', text: 'Synthetic rows: 3.' }] };
              },
            );
            mcp.registerTool(
              'get_workflow_execution',
              {
                description: executionDescription,
                inputSchema: {
                  executionId: z.string(),
                  includeData: z
                    .boolean()
                    .default(false)
                    .describe('Include node inputs and outputs when true.'),
                },
              },
              async (input) => {
                calls.push({ tool: 'get_workflow_execution', input });
                return {
                  content: [
                    {
                      type: 'text',
                      text: input.includeData
                        ? 'Synthetic node inputs and outputs.'
                        : 'Synthetic execution status.',
                    },
                  ],
                };
              },
            );
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            outgoing.on('close', () => void transport.close());
            await mcp.connect(transport);
            await transport.handleRequest(incoming, outgoing);
          });
          await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
          const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
          let connection: { id: string; service: string; paths: Array<{ id: string }> } | undefined;
          let executionId = 'synthetic-execution';
          let duringWording: (() => Promise<void>) | undefined;
          try {
            const started = await request('POST', '/api/apps/mcp', {
              name: 'Synthetic review context',
              endpoint,
              auth: 'bearer',
            });
            assert.equal(started.statusCode, 200, started.body);
            const completed = await request(
              'POST',
              `/api/apps/discovery/${started.json().id}/complete`,
              { token: 'synthetic-review-context-token', accountName: 'Synthetic review account' },
            );
            assert.equal(completed.statusCode, 200, completed.body);
            connection = (
              await pool.query(
                'SELECT id,service,paths FROM discovered_connections WHERE owner_id=$1 AND name=$2',
                [ownerId, 'Synthetic review context'],
              )
            ).rows[0];
            assert.ok(connection);
            confirmationModel = async (input) => {
              const data = input.data as {
                action: string;
                args: { tool: string; input: Record<string, unknown> };
                details: {
                  account: { endpoint: string };
                  tool?: {
                    name: string;
                    description: string;
                    inputSchema: {
                      properties: Record<string, { type: string; default?: unknown }>;
                    };
                  };
                };
              };
              assert.equal(data.action, 'CONNECTED_MCP_CALL');
              assert.equal('connectionId' in data.args, false);
              assert.equal('pathId' in data.args, false);
              assert.equal('verifiedBinding' in data.details, false);
              assert.equal(JSON.stringify(input).includes('synthetic-review-context-token'), false);
              assert.equal(data.details.account.endpoint, endpoint);
              const definition = data.details.tool;
              assert.ok(definition, 'The selected MCP tool definition is missing.');
              assert.equal(definition.name, data.args.tool);
              let text: string;
              if (definition.name === 'data_table_rows') {
                assert.equal(definition.description, rowsDescription);
                assert.equal(definition.inputSchema.properties.tableId!.type, 'string');
                assert.deepEqual(data.args.input, { tableId: 'synthetic-table' });
                text = 'Can I read the current rows from the synthetic table?';
              } else {
                assert.equal(definition.description, executionDescription);
                assert.equal(definition.inputSchema.properties.includeData!.type, 'boolean');
                assert.equal(definition.inputSchema.properties.includeData!.default, false);
                assert.deepEqual(data.args.input, {
                  executionId,
                  includeData: true,
                });
                text = 'Can I read the node inputs and outputs for the synthetic execution?';
              }
              if (duringWording) {
                const change = duringWording;
                duringWording = undefined;
                await change();
              }
              return {
                text,
                action: 'Read data',
              };
            };
            for (const [tool, input, result] of [
              ['data_table_rows', { tableId: 'synthetic-table' }, /Synthetic rows: 3/],
              [
                'get_workflow_execution',
                { executionId, includeData: true },
                /Synthetic node inputs and outputs/,
              ],
            ] as const) {
              const before = calls.length;
              const args: Record<string, unknown> = {
                connectionId: connection.id,
                pathId: connection.paths[0]!.id,
                tool,
                input,
              };
              const native =
                tool === 'get_workflow_execution'
                  ? [...advertisedMcp].find(([, description]) =>
                      description.includes(executionDescription),
                    )?.[0]
                  : undefined;
              if (tool === 'get_workflow_execution')
                assert.ok(native, 'The native MCP tool must be offered.');
              const held = await propose('CONNECTED_MCP_CALL', args, native ?? 'apps');
              const [card] = await approvalsFor(held);
              assert.equal(card.status, 'pending');
              assert.deepEqual(card.args, args);
              assert.equal(calls.length, before);
              const response = await request('POST', '/api/messages', {
                text: 'Yes',
                replyToMessageId: card.confirmation_message_id,
                approvalAnswer: { approvalId: card.id, approved: true },
              });
              assert.equal(response.statusCode, 200, response.body);
              await waitFor(response.json().turnId, 'succeeded');
              const saved = (await approvalsFor(held))[0];
              assert.equal(saved.status, 'completed');
              assert.match(JSON.stringify(saved.result), result);
              assert.deepEqual(calls.slice(before), [{ tool, input }]);
            }
            assert.equal(calls.length, 2);
            const nextArgs = () => ({
              connectionId: connection!.id,
              pathId: connection!.paths[0]!.id,
              tool: 'get_workflow_execution',
              input: { executionId, includeData: true },
            });
            for (const reason of ['rebind', 'legacy']) {
              executionId = `synthetic-pending-${reason}`;
              const pending = await propose('CONNECTED_MCP_CALL', nextArgs(), 'apps');
              const [pendingCard] = await approvalsFor(pending);
              assert.equal(typeof pendingCard.details.verifiedBinding, 'string');
              if (reason === 'rebind')
                await pool.query(
                  'UPDATE discovered_connections SET account_id=gen_random_uuid() WHERE id=$1',
                  [connection.id],
                );
              else
                await pool.query(
                  "UPDATE approvals SET details=details-'verifiedBinding' WHERE id=$1",
                  [pendingCard.id],
                );
              const answer = await request('POST', '/api/messages', {
                text: 'Yes',
                replyToMessageId: pendingCard.confirmation_message_id,
                approvalAnswer: { approvalId: pendingCard.id, approved: true },
              });
              assert.equal(answer.statusCode, 200, answer.body);
              await waitFor(answer.json().turnId, 'succeeded|failed');
              const [expired] = await approvalsFor(pending);
              assert.equal(expired.status, 'expired');
              assert.match(
                JSON.stringify(expired.result),
                reason === 'rebind' ? /connected account changed/ : /no saved account binding/,
              );
              assert.equal(calls.length, 2);
            }

            executionId = 'synthetic-wording-rebind';
            duringWording = async () => {
              await pool.query(
                'UPDATE discovered_connections SET account_id=gen_random_uuid() WHERE id=$1',
                [connection!.id],
              );
            };
            const changedPrompt = `Synthetic wording change ${randomUUID()}`;
            plans.set(changedPrompt, {
              tool: 'apps',
              action: 'CONNECTED_MCP_CALL',
              args: nextArgs(),
            });
            const changed = await request('POST', '/api/messages', { text: changedPrompt });
            assert.equal(changed.statusCode, 200, changed.body);
            await waitFor(changed.json().turnId, 'succeeded|failed');
            assert.deepEqual(await approvalsFor(changed.json().turnId), []);
            assert.equal(duringWording, undefined);
            const changedTurn = (
              await pool.query('SELECT error FROM turns WHERE id=$1', [changed.json().turnId])
            ).rows[0];
            assert.match(
              JSON.stringify(results.get(changed.json().turnId)) ?? changedTurn.error,
              /connected account changed before confirmation/,
            );
            assert.equal(calls.length, 2);
            assert.equal(
              decisionInputs.some((entry) => JSON.stringify(entry).includes(executionDescription)),
              false,
            );
          } finally {
            confirmationModel = undefined;
            if (connection)
              await request(
                'POST',
                `/api/apps/${connection.service}/accounts/${connection.id}/disconnect`,
              );
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
        },
      );
      await inPart('sign-in approval preserves its exact displayed origin', async () => {
        const origin = 'https://bank.example.test';
        const input = {
          origin,
          label: 'Synthetic bank',
          kind: 'method',
          methods: [{ label: 'Continue with Identity', selector: '@identity' }],
          message: 'Choose a sign-in method.',
        };
        const before = methodBindings;
        allowMethodBrowser = true;
        confirmationModel = (request) => {
          const data = request.data as { action: string; args: { origin: string } };
          assert.equal(data.action, 'NOD_vault_allow');
          assert.equal(data.args.origin, origin);
          return request.purpose === 'confirmation_review'
            ? {
                valid:
                  request.text === `Can I use ${origin}?` &&
                  JSON.stringify(request.literalValues) === JSON.stringify([origin]),
              }
            : { text: `Can I use ${origin}?`, action: 'Use saved sign-in' };
        };
        try {
          const held = await propose('Choose sign-in', input, 'sign_in');
          const [card] = await approvalsFor(held);
          assert.equal(card.action, 'NOD_vault_allow');
          assert.deepEqual(card.args, { origin, kind: 'sign_in' });
          assert.equal(methodBindings, before);
          repeatAfterConfirm = { tool: 'sign_in', action: 'Choose sign-in', args: input };
          const response = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: card.confirmation_message_id,
            approvalAnswer: { approvalId: card.id, approved: true },
          });
          assert.equal(response.statusCode, 200, response.body);
          await waitFor(response.json().turnId, 'waiting|succeeded');
          assert.equal((await approvalsFor(held))[0].status, 'completed');
          assert.equal(methodBindings, before + 1);
          const form = (
            await pool.query(
              'SELECT origin,kind,status FROM credential_requests WHERE turn_id=$1',
              [response.json().turnId],
            )
          ).rows[0];
          assert.deepEqual(form, { origin, kind: 'method', status: 'pending' });
        } finally {
          confirmationModel = undefined;
          allowMethodBrowser = false;
          repeatAfterConfirm = undefined;
        }
      });
      await inPart('MCP approval preserves the saved endpoint and dispatches once', async () => {
        const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
        const { StreamableHTTPServerTransport } =
          await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
        let calls = 0;
        const requestPaths = new Set<string>();
        const server = createServer(async (incoming, outgoing) => {
          const path = new URL(incoming.url ?? '/', 'http://localhost').pathname;
          requestPaths.add(path);
          if (path !== '/tools(v2)') {
            outgoing.writeHead(404);
            outgoing.end('Synthetic MCP endpoint not found.');
            return;
          }
          const mcp = new McpServer({ name: 'synthetic-readiness', version: '1' });
          mcp.registerTool(
            'readiness_check',
            { description: 'Check the synthetic service.' },
            async () => {
              calls++;
              return { content: [{ type: 'text', text: 'Synthetic service is ready.' }] };
            },
          );
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          outgoing.on('close', () => void transport.close());
          await mcp.connect(transport);
          await transport.handleRequest(incoming, outgoing);
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/tools(v2)`;
        let connection:
          | { id: string; service: string; paths: Array<{ id: string; endpoint: string }> }
          | undefined;
        try {
          const started = await request('POST', '/api/apps/mcp', {
            name: 'Synthetic readiness',
            endpoint,
            auth: 'bearer',
          });
          assert.equal(started.statusCode, 200, started.body);
          const completed = await request(
            'POST',
            `/api/apps/discovery/${started.json().id}/complete`,
            { token: 'synthetic-readiness-token', accountName: 'Synthetic readiness' },
          );
          assert.equal(completed.statusCode, 200, completed.body);
          connection = (
            await pool.query(
              'SELECT id,service,paths FROM discovered_connections WHERE owner_id=$1 AND name=$2',
              [ownerId, 'Synthetic readiness'],
            )
          ).rows[0];
          assert.ok(connection);
          assert.equal(connection.paths[0]!.endpoint, endpoint);
          confirmationModel = (input) => {
            const data = input.data as {
              action: string;
              details: { account: { endpoint: string } };
            };
            assert.equal(data.action, 'CONNECTED_MCP_CALL');
            assert.equal(data.details.account.endpoint, endpoint);
            return input.purpose === 'confirmation_review'
              ? {
                  valid:
                    input.text === `Can I check ${endpoint}?` &&
                    JSON.stringify(input.literalValues) === JSON.stringify([endpoint]),
                }
              : { text: `Can I check ${endpoint}?`, action: 'Check service' };
          };
          const args = {
            connectionId: connection.id,
            pathId: connection.paths[0]!.id,
            tool: 'readiness_check',
            input: {},
          };
          const held = await propose('CONNECTED_MCP_CALL', args, 'apps');
          const [card] = await approvalsFor(held);
          assert.equal(card.status, 'pending');
          assert.deepEqual(card.args, args);
          assert.equal(calls, 0);
          repeatAfterConfirm = { action: 'CONNECTED_MCP_CALL', args };
          const response = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: card.confirmation_message_id,
            approvalAnswer: { approvalId: card.id, approved: true },
          });
          assert.equal(response.statusCode, 200, response.body);
          await waitFor(response.json().turnId, 'succeeded');
          const saved = (await approvalsFor(held))[0];
          assert.equal(saved.status, 'completed');
          assert.match(JSON.stringify(saved.result), /Synthetic service is ready/);
          assert.equal(calls, 1);
          assert.deepEqual([...requestPaths], ['/tools(v2)']);
          assert.deepEqual(saved.args, args);
        } finally {
          confirmationModel = undefined;
          repeatAfterConfirm = undefined;
          if (connection)
            await request(
              'POST',
              `/api/apps/${connection.service}/accounts/${connection.id}/disconnect`,
            );
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      });
      await inPart('Stop cancels private entry in running and waiting turns', async () => {
        const origin = 'https://bank.example.test';
        const input = {
          origin,
          label: 'Synthetic cancellation login',
          passwordSelector: '@password',
          submitSelector: '@submit',
          message: 'Enter the synthetic password.',
        };
        const before = injected.length;
        let login: string | undefined;
        for (const source of ['form', 'saved', 'card']) {
          if (source === 'saved') {
            const saved = await request('POST', '/api/vault', {
              origin,
              label: 'Synthetic cancellation login',
              username: 'synthetic@example.test',
              password: 'Synthetic cancellation password',
            });
            assert.equal(saved.statusCode, 200, saved.body);
            login = saved.json().id;
          }
          let card: string | undefined;
          if (source === 'card') {
            const saved = await request('POST', '/api/vault', {
              kind: 'card',
              label: 'Synthetic cancellation card',
              cardholder: 'Synthetic owner',
              cardNumber: '4111111111111111',
              expiryMonth: 12,
              expiryYear: new Date().getUTCFullYear() + 3,
            });
            assert.equal(saved.statusCode, 200, saved.body);
            card = saved.json().id;
          }
          const cardsBefore = filledCards.length;
          let release!: () => void;
          let entered = false;
          let signal: AbortSignal | undefined;
          privateEntryWait = {
            entered(value) {
              signal = value;
              entered = true;
            },
            release: new Promise<void>((resolve) => {
              release = resolve;
            }),
          };
          let consumption:
            ReturnType<typeof request> | Promise<Awaited<ReturnType<typeof request>>> | undefined;
          let token: string | undefined;
          try {
            const text = `Sign in with the synthetic ${source} login ${randomUUID()}`;
            asked.add(text);
            plans.set(text, {
              tool: source === 'card' ? 'pay' : 'sign_in',
              action: 'Enter saved login',
              args:
                source === 'card'
                  ? {
                      amount: '12.34',
                      currency: 'EUR',
                      card,
                      fields: { number: '@number', expiry: '@expiry' },
                      submitSelector: '@submit',
                    }
                  : { ...input, ...(login ? { savedLoginId: login } : {}) },
            });
            const { turnId, rootTurnId } = await taskTurn(text, undefined, {
              wait: source === 'saved' ? false : 'waiting',
            });
            if (source !== 'saved') {
              const messages = JSON.stringify(
                (
                  await pool.query('SELECT text,presentation FROM messages WHERE turn_id=$1', [
                    turnId,
                  ])
                ).rows,
              );
              token = (
                source === 'card' ? /\/payments\/([a-f0-9-]{36})/ : /\/vault\/([A-Za-z0-9_-]{43})/
              ).exec(messages)?.[1];
              assert.ok(token);
              consumption = request(
                'POST',
                source === 'card'
                  ? `/api/payment-requests/${token}`
                  : `/api/credential-requests/${token}`,
                source === 'card'
                  ? { code: '737' }
                  : { password: 'Synthetic cancellation password' },
              ).then((result) => result);
            }
            for (let attempt = 0; !entered && attempt < 300; attempt++) await delay(20);
            assert.equal(entered, true);
            assert.ok(signal);
            assert.equal(signal.aborted, false);
            assert.equal((await request('POST', '/api/thread/stop')).statusCode, 200);
            assert.equal(signal.aborted, true);
            release();
            if (consumption) {
              const result = await consumption;
              assert.equal(result.statusCode, source === 'card' ? 409 : 502, result.body);
              assert.equal(
                (
                  await request(
                    'POST',
                    source === 'card'
                      ? `/api/payment-requests/${token}`
                      : `/api/credential-requests/${token}`,
                    source === 'card'
                      ? { code: '737' }
                      : { password: 'Synthetic cancellation password' },
                  )
                ).statusCode,
                409,
              );
            }
            await waitFor(turnId, 'cancelled');
            let status: string | undefined;
            for (let attempt = 0; status !== 'uncertain' && attempt < 300; attempt++) {
              status = (
                await pool.query(
                  source === 'card'
                    ? 'SELECT status FROM vault_uses WHERE id=$1'
                    : 'SELECT status FROM vault_uses WHERE root_turn_id=$1',
                  [source === 'card' ? token : rootTurnId],
                )
              ).rows[0]?.status;
              if (status !== 'uncertain') await delay(20);
            }
            assert.equal(status, 'uncertain');
            assert.equal(injected.length, before);
            assert.equal(filledCards.length, cardsBefore);
            assert.equal(
              (await pool.query('SELECT 1 FROM turns WHERE parent_turn_id=$1', [turnId])).rowCount,
              0,
            );
          } finally {
            release();
            await consumption;
            privateEntryWait = undefined;
          }
        }
        const text = `Use the synthetic saved login again ${randomUUID()}`;
        asked.add(text);
        await propose('Enter saved login', { ...input, savedLoginId: login }, 'sign_in', text);
        assert.equal(injected.length, before + 1);
      });
      await inPart(
        'saved login consent keeps the account name and enters a code only with exact-origin consent',
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
          for (const kind of ['password', 'otp']) {
            const checksFrom = fallbackChecks.length;
            const held = await propose(
              'Enter saved login',
              kind === 'password'
                ? {
                    origin: input.origin,
                    submitSelector: input.submitSelector,
                    message: input.message,
                    label: 'Model-supplied account name',
                    savedLoginId: login,
                    usernameSelector: '@username',
                    passwordSelector: '@password',
                  }
                : input,
              'sign_in',
            );
            const [card] = await approvalsFor(held);
            assert.equal(card?.action, 'NOD_vault_allow');
            assert.equal(card.status, 'pending');
            assert.deepEqual(card.args, { origin, kind: 'sign_in', itemId: login });
            assert.equal(injected.length, before);
            const checks = fallbackChecks.slice(checksFrom) as Array<Record<string, any>>;
            const account = checks.find((check) => check.action?.name === 'NOD_sign_in')?.action
              .arguments.account;
            assert.equal(typeof account, 'string');
            assert.ok(account.includes(saved.json().label));
            assert.ok(account.includes(saved.json().usernameHint));
            assert.equal(account.includes('Model-supplied account name'), false);
            const confirmation = await confirmationFor(card);
            assert.ok(confirmation.includes(saved.json().label));
            assert.ok(confirmation.includes(saved.json().usernameHint));
            assert.equal(confirmation.includes('Model-supplied account name'), false);
            assert.doesNotMatch(
              JSON.stringify({ checks, confirmation }),
              /synthetic-bank-password|JBSWY3DP|otpauth/i,
            );
            if (kind === 'password') {
              const declined = await request('POST', '/api/messages', {
                text: 'No',
                replyToMessageId: card.confirmation_message_id,
                clientMessageId: randomUUID(),
              });
              await waitFor(declined.json().turnId, 'succeeded');
            }
          }
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
                'SELECT action,item_id,reason FROM vault_activity WHERE owner_id=$1 AND item_id=$2',
                [ownerId, login],
              )
            ).rows,
            [{ action: 'code', item_id: login, reason: 'asked' }],
          );
        },
      );

      await inPart('a root login approval does not approve its www destination', async (t) => {
        const previousOrigin = browserOrigin;
        const previousUrl = browserUrl;
        t.after(() => {
          browserOrigin = previousOrigin;
          browserUrl = previousUrl;
          repeatAfterConfirm = undefined;
        });
        const origin = 'https://example.org:8443';
        const destination = 'https://www.example.org:8443';
        const saved = await request('POST', '/api/vault', {
          label: 'Synthetic www account',
          origin,
          username: 'synthetic-owner@example.test',
          password: 'synthetic-www-private-password',
        });
        assert.equal(saved.statusCode, 200, saved.body);
        const login = saved.json().id as string;
        const original = (
          await pool.query('SELECT origin,ciphertext FROM vault_entries WHERE id=$1', [login])
        ).rows[0];
        const input = {
          origin,
          label: 'Synthetic www account',
          message: 'Sign in to the synthetic website.',
          usernameSelector: '@username',
          passwordSelector: '@password',
          submitSelector: '@submit',
        };
        browserOrigin = origin;
        browserUrl = `${origin}/login`;
        const before = injected.length;
        const held = await propose('Enter saved login', input, 'sign_in');
        const [rootCard] = await approvalsFor(held);
        assert.deepEqual(rootCard.args, { origin, kind: 'sign_in', itemId: login });
        assert.equal(injected.length, before);
        browserOrigin = destination;
        browserUrl = `${destination}/login`;
        const wwwInput = { ...input, origin: destination };
        repeatAfterConfirm = { tool: 'sign_in', action: 'Enter saved login', args: wwwInput };
        const rootApproval = await request('POST', '/api/messages', {
          text: 'Sign in',
          replyToMessageId: rootCard.confirmation_message_id,
          clientMessageId: randomUUID(),
          approvalAnswer: { approvalId: rootCard.id, approved: true },
        });
        assert.equal(rootApproval.statusCode, 200, rootApproval.body);
        await waitFor(rootApproval.json().turnId, 'waiting');
        const [wwwCard] = await approvalsFor(rootApproval.json().turnId);
        assert.equal(wwwCard?.action, 'NOD_vault_allow');
        assert.deepEqual(wwwCard.args, { origin: destination, kind: 'sign_in', itemId: login });
        assert.equal((await approvalsFor(held))[0].status, 'completed');
        assert.equal(injected.length, before);
        const destinations = [
          ...(await confirmationFor(wwwCard)).matchAll(/https?:\/\/[^\s`]+/g),
        ].map(([url]) => new URL(url).origin);
        assert.deepEqual(destinations, [destination]);
        repeatAfterConfirm = { tool: 'sign_in', action: 'Enter saved login', args: wwwInput };
        const answer = {
          text: 'Sign in',
          replyToMessageId: wwwCard.confirmation_message_id,
          clientMessageId: randomUUID(),
          approvalAnswer: { approvalId: wwwCard.id, approved: true },
        };
        const wwwApproval = await request('POST', '/api/messages', answer);
        assert.equal(wwwApproval.statusCode, 200, wwwApproval.body);
        await waitFor(wwwApproval.json().turnId, 'succeeded');
        assert.deepEqual(
          (await request('POST', '/api/messages', answer)).json(),
          wwwApproval.json(),
        );
        assert.equal(injected.length, before + 1);
        assert.equal(injected.at(-1)?.origin, destination);
        assert.equal(injected.at(-1)?.password, 'synthetic-www-private-password');
        assert.doesNotMatch(
          JSON.stringify(results.get(wwwApproval.json().turnId)),
          /synthetic-www-private-password/,
        );
        assert.deepEqual(
          (await pool.query('SELECT origin,kind,status FROM vault_uses WHERE item_id=$1', [login]))
            .rows,
          [{ origin: destination, kind: 'password', status: 'submitted' }],
        );
        assert.deepEqual(
          (await pool.query('SELECT origin,ciphertext FROM vault_entries WHERE id=$1', [login]))
            .rows[0],
          original,
        );
      });

      await inPart(
        'an explicit MCP workflow repeat asks again and returns the new execution',
        async () => {
          const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
          const { StreamableHTTPServerTransport } =
            await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
          const { z } = await import('zod');
          let threshold = 3;
          const updates: number[] = [];
          const executions: Array<{ executionId: string; threshold: number }> = [];
          const server = createServer(async (request, response) => {
            const mcp = new McpServer({ name: 'synthetic-workflow', version: '1' });
            mcp.registerTool(
              'update_workflow',
              {
                description: 'Set the threshold in the named synthetic workflow.',
                inputSchema: { workflowId: z.string(), threshold: z.number() },
              },
              async (input) => {
                assert.equal(input.workflowId, 'synthetic-workflow');
                threshold = input.threshold;
                updates.push(threshold);
                return { content: [{ type: 'text', text: JSON.stringify({ threshold }) }] };
              },
            );
            mcp.registerTool(
              'execute_workflow',
              {
                description: 'Run the named synthetic workflow once.',
                inputSchema: { workflowId: z.string() },
              },
              async ({ workflowId }) => {
                assert.equal(workflowId, 'synthetic-workflow');
                const result = { executionId: `synthetic-${executions.length + 1}`, threshold };
                executions.push(result);
                return { content: [{ type: 'text', text: JSON.stringify(result) }] };
              },
            );
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            response.on('close', () => void transport.close());
            await mcp.connect(transport);
            await transport.handleRequest(request, response);
          });
          await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
          let connectionId: string | undefined;
          let connectionService: string | undefined;
          try {
            const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
            const setup = await request('POST', '/api/apps/mcp', {
              name: 'Synthetic workflow',
              endpoint,
              auth: 'bearer',
            });
            assert.equal(setup.statusCode, 200, setup.body);
            const connected = await request(
              'POST',
              `/api/apps/discovery/${setup.json().id}/complete`,
              { token: 'synthetic-mcp-token', accountName: 'Synthetic workspace' },
            );
            assert.equal(connected.statusCode, 200, connected.body);
            const account = (
              await pool.query(
                'SELECT id,service FROM discovered_connections WHERE owner_id=$1 AND name=$2',
                [ownerId, 'Synthetic workflow'],
              )
            ).rows[0];
            connectionId = account.id;
            connectionService = account.service;
            const input = { workflowId: 'synthetic-workflow' };
            const initial = await propose(
              'execute_workflow',
              input,
              'synthetic_mcp',
              'Run the synthetic workflow for the first time.',
            );
            const [first] = await approvalsFor(initial);
            assert.equal(first.action, 'CONNECTED_MCP_CALL');
            assert.equal(executions.length, 0);
            const question =
              'Which threshold should I use for a new run of the synthetic workflow?';
            questionAfterConfirm = question;
            const accepted = await request('POST', '/api/messages', {
              text: 'Run workflow',
              replyToMessageId: first.confirmation_message_id,
              approvalAnswer: { approvalId: first.id, approved: true },
            });
            assert.equal(accepted.statusCode, 200, accepted.body);
            await waitFor(accepted.json().turnId, 'waiting');
            assert.deepEqual(executions, [{ executionId: 'synthetic-1', threshold: 3 }]);
            const savedFirst = (await approvalsFor(initial))[0];
            assert.equal(savedFirst.status, 'completed');
            const savedQuestion = (
              await pool.query(
                "SELECT id FROM messages WHERE turn_id=$1 AND role='assistant' AND text=$2",
                [accepted.json().turnId, question],
              )
            ).rows[0];
            assert.ok(savedQuestion);
            const reply = 'Set the threshold to 7 and run the synthetic workflow again.';
            workflowUpdate = { workflowId: 'synthetic-workflow', threshold: 7 };
            asked.add(reply);
            plans.set(reply, { tool: 'synthetic_mcp', action: 'execute_workflow', args: input });
            repeatDecision = 'new';
            let repeatEntered!: () => void;
            const checkingRepeat = new Promise<void>((resolve) => {
              repeatEntered = resolve;
            });
            let releaseRepeat!: () => void;
            const repeatReady = new Promise<void>((resolve) => {
              releaseRepeat = resolve;
            });
            holdRepeatCheck = async () => {
              repeatEntered();
              await repeatReady;
            };
            const commandsBefore = workspaceDispatches.length;
            parallelRepeatWork = async (options) => {
              parallelRepeatWork = undefined;
              await checkingRepeat;
              const queued = options.runTool(
                'bash',
                { command: 'cat synthetic-repeat.txt' },
                async () => {
                  workspaceDispatches.push('synthetic-repeat');
                  return { content: [] };
                },
              );
              try {
                await delay(30);
                assert.equal(workspaceDispatches.length, commandsBefore);
              } finally {
                releaseRepeat();
                holdRepeatCheck = undefined;
                await queued.catch(() => {});
              }
            };
            const repeated = await request('POST', '/api/messages', {
              text: reply,
              replyToMessageId: savedQuestion.id,
            });
            assert.equal(repeated.statusCode, 200, repeated.body);
            await waitFor(repeated.json().turnId, 'waiting|succeeded');
            const [second] = await approvalsFor(repeated.json().turnId);
            assert.ok(second, 'A new explicit run must save a new confirmation.');
            assert.equal(second.status, 'pending');
            assert.equal(second.source_message_id, repeated.json().messageId);
            assert.deepEqual(second.args, first.args);
            assert.equal(executions.length, 1);
            assert.equal(workspaceDispatches.length, commandsBefore);
            assert.deepEqual(updates, [7]);
            assert.equal(threshold, 7);
            assert.deepEqual(second.details.account, {
              name: 'Synthetic workflow',
              identity: 'Synthetic workspace',
              method: 'mcp',
              endpoint,
            });
            assert.equal(second.details.tool.name, 'execute_workflow');
            assert.deepEqual(second.details.tool, first.details.tool);
            assert.equal(second.details.verifiedBinding, first.details.verifiedBinding);
            assert.deepEqual(repeatChecks.at(-1), {
              action: 'CONNECTED_MCP_CALL',
              args: first.args,
              reply,
              question,
            });
            assert.ok(ownerWords.includes(reply));
            repeatAfterConfirm = { tool: 'synthetic_mcp', action: 'execute_workflow', args: input };
            const thirdQuestion = 'Should I run the synthetic workflow a third time?';
            questionAfterConfirm = thirdQuestion;
            const answer = {
              text: 'Run workflow',
              replyToMessageId: second.confirmation_message_id,
              clientMessageId: randomUUID(),
              approvalAnswer: { approvalId: second.id, approved: true },
            };
            const approved = await request('POST', '/api/messages', answer);
            assert.equal(approved.statusCode, 200, approved.body);
            await waitFor(approved.json().turnId, 'waiting');
            assert.deepEqual(
              (await request('POST', '/api/messages', answer)).json(),
              approved.json(),
            );
            assert.deepEqual(executions, [
              { executionId: 'synthetic-1', threshold: 3 },
              { executionId: 'synthetic-2', threshold: 7 },
            ]);
            assert.match(JSON.stringify(results.get(approved.json().turnId)), /synthetic-2/);
            assert.doesNotMatch(JSON.stringify(results.get(approved.json().turnId)), /synthetic-1/);
            assert.deepEqual((await approvalsFor(initial))[0].result, savedFirst.result);
            assert.match(
              JSON.stringify((await approvalsFor(repeated.json().turnId))[0].result),
              /synthetic-2/,
            );
            const ledger = (
              await pool.query(
                "SELECT basis FROM app_actions WHERE owner_id=$2 AND turn_id=ANY($1::uuid[]) AND action='CONNECTED_MCP_CALL'",
                [[accepted.json().turnId, approved.json().turnId], ownerId],
              )
            ).rows;
            assert.equal(ledger.length, 2);
            assert.deepEqual(
              ledger.map((row) => row.basis),
              [{ kind: 'approved' }, { kind: 'approved' }],
            );
            const cards = await request(
              'GET',
              `/api/messages/around/${second.confirmation_message_id}`,
            );
            assert.equal(cards.statusCode, 200, cards.body);
            assert.equal(
              cards
                .json()
                .find((message: { id: string }) => message.id === second.confirmation_message_id)
                .approval.state,
              'done',
            );
            const thirdQuestionId = (
              await pool.query(
                "SELECT id FROM messages WHERE turn_id=$1 AND role='assistant' AND text=$2",
                [approved.json().turnId, thirdQuestion],
              )
            ).rows[0].id;
            const thirdReply = 'Run the synthetic workflow a third time.';
            plans.set(thirdReply, {
              tool: 'synthetic_mcp',
              action: 'execute_workflow',
              args: input,
            });
            asked.add(thirdReply);
            repeatDecision = 'uncertain';
            const third = await request('POST', '/api/messages', {
              text: thirdReply,
              replyToMessageId: thirdQuestionId,
            });
            assert.equal(third.statusCode, 200, third.body);
            await waitFor(third.json().turnId, 'failed');
            const failed = (
              await pool.query('SELECT error FROM turns WHERE id=$1', [third.json().turnId])
            ).rows[0];
            assert.match(failed.error, /did not run again/);
            assert.equal(results.has(third.json().turnId), false);
            assert.deepEqual(await approvalsFor(third.json().turnId), []);
            assert.equal(executions.length, 2);
            assert.deepEqual(updates, [7]);
            assert.deepEqual((await approvalsFor(initial))[0].result, savedFirst.result);
            let visibleError = false;
            for (let attempt = 0; attempt < 300; attempt++) {
              const visible = await request(
                'GET',
                `/api/messages/around/${third.json().messageId}`,
              );
              assert.equal(visible.statusCode, 200, visible.body);
              visibleError = visible
                .json()
                .some(
                  (message: { role: string; turnId: string; text: string }) =>
                    message.role === 'assistant' &&
                    message.turnId === third.json().turnId &&
                    message.text.includes('did not run again'),
                );
              if (visibleError) break;
              await delay(20);
            }
            assert.equal(visibleError, true, 'The chat must show the specific repeat refusal.');
            assert.equal(
              (
                await pool.query('SELECT 1 FROM app_actions WHERE turn_id=$1', [
                  third.json().turnId,
                ])
              ).rowCount,
              0,
            );
          } finally {
            holdRepeatCheck = undefined;
            parallelRepeatWork = undefined;
            questionAfterConfirm = undefined;
            workflowUpdate = undefined;
            repeatAfterConfirm = undefined;
            repeatDecision = 'same';
            if (connectionId)
              assert.equal(
                (
                  await request(
                    'POST',
                    `/api/apps/${connectionService}/accounts/${connectionId}/disconnect`,
                    {},
                  )
                ).statusCode,
                200,
              );
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
          }
        },
      );
      await inPart(
        'a connect whose sign-in label cannot be written leaves no attempt behind',
        async () => {
          const pending = async () =>
            (
              await pool.query(
                "SELECT count(*)::int AS count FROM app_connections WHERE owner_id=$1 AND slug='slack' AND account_id IS NULL",
                [ownerId],
              )
            ).rows[0].count;
          const connect = async (labels: unknown[]) => {
            connectionLabels.splice(0, connectionLabels.length, ...labels);
            const text = `Connect synthetic Slack ${randomUUID()}`;
            batches.set(text, {
              subagents: false,
              calls: [{ tool: 'manage_apps', action: 'connect', args: { service: 'slack' } }],
            });
            const response = await request('POST', '/api/messages', { text });
            assert.equal(response.statusCode, 200, response.body);
            ids.push(response.json().threadId as string);
            return response.json().turnId as string;
          };
          const errors = batchErrors.length;
          await waitFor(
            await connect([{ label: 'Connect Slack' }, { label: 'Connect Slack' }]),
            'succeeded',
          );
          assert.match(batchErrors.slice(errors).join('\n'), /could not write this message/);
          assert.equal(await pending(), 0);
          await waitFor(
            await connect([{ label: 'Connect Slack' }, { text: 'Connect Slack' }]),
            'waiting',
          );
          assert.equal(await pending(), 1);
        },
      );
      await inPart(
        'local files open only in work the owner started, and opening needs their words',
        async () => {
          const folder = await mkdtemp(join(localHome, 'files-'));
          await mkdir(join(folder, 'sorted'));
          await writeFile(join(folder, 'a.txt'), 'a');
          await writeFile(join(folder, 'contract.txt'), 'Synthetic contract');
          const text = (id: string) => JSON.stringify(results.get(id));
          const eventPrompt = `Synthetic event ${randomUUID()}`;
          plans.set(eventPrompt, { tool: 'files', action: 'list', args: { path: folder } });
          const event = await enqueueTurn(eventPrompt, { source: 'event', background: true });
          await waitFor(event, 'succeeded|failed');
          assert.match(
            text(event) ??
              (await pool.query('SELECT error FROM turns WHERE id=$1', [event])).rows[0].error,
            /work the owner started/,
          );
          assert.deepEqual(await approvalsFor(event), []);
          const observer = await enqueueTurn(`Synthetic observer ${randomUUID()}`, {
            source: 'event',
            background: true,
            proactive: true,
          });
          await waitFor(observer, 'succeeded|failed');
          const taskPrompt = `Synthetic observer task ${randomUUID()}`;
          plans.set(taskPrompt, { tool: 'files', action: 'list', args: { path: folder } });
          const task = await enqueueTurn(taskPrompt, {
            source: 'task',
            background: true,
            parentTurnId: observer,
            proactive: false,
          });
          await waitFor(task, 'succeeded|failed');
          assert.match(
            text(task) ??
              (await pool.query('SELECT error FROM turns WHERE id=$1', [task])).rows[0].error,
            /work the owner started/,
          );
          const readText = `Summarize contract.txt ${randomUUID()}`;
          assert.equal((await request('GET', '/api/preferences')).json().localFilesEnabled, false);
          const opening = await propose(
            'read',
            { path: join(folder, 'contract.txt') },
            'files',
            readText,
          );
          const [access] = await approvalsFor(opening);
          assert.equal(access.action, 'NOD_notification_preferences_update');
          assert.deepEqual(access.args, { localFilesEnabled: true });
          assert.doesNotMatch(text(opening), /Synthetic contract/);
          asked.add(readText);
          repeatAfterConfirm = {
            tool: 'files',
            action: 'read',
            args: { path: join(folder, 'contract.txt') },
          };
          const accepted = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: access.confirmation_message_id,
            approvalAnswer: { approvalId: access.id, approved: true },
          });
          assert.equal(accepted.statusCode, 200, accepted.body);
          await waitFor(accepted.json().turnId, 'succeeded');
          assert.equal((await request('GET', '/api/preferences')).json().localFilesEnabled, true);
          assert.match(text(accepted.json().turnId), /Synthetic contract/);
          await request('PATCH', '/api/preferences', { localFilesEnabled: false });
          const enableText = `Enable local file access and read contract.txt ${randomUUID()}`;
          asked.add(enableText);
          plans.set(enableText, {
            tool: 'files',
            action: 'read',
            args: { path: join(folder, 'contract.txt') },
          });
          const enabled = await submitUserMessage(enableText);
          await waitFor(enabled.turnId, 'succeeded');
          assert.deepEqual(await approvalsFor(enabled.turnId), []);
          assert.equal((await request('GET', '/api/preferences')).json().localFilesEnabled, true);
          const unnamed = await propose(
            'read',
            { path: `${folder}/sorted/../contract.txt` },
            'files',
          );
          const [held] = await approvalsFor(unnamed);
          assert.equal(held.status, 'pending');
          assert.equal(held.action, 'LOCAL_FILES_READ');
          assert.equal(held.args.path, join(folder, 'contract.txt'));
          const schedule = await reminder();
          const scheduledPrompt = `Synthetic scheduled listing ${randomUUID()}`;
          plans.set(scheduledPrompt, { tool: 'files', action: 'list', args: { path: folder } });
          const scheduled = await transaction(async (client) => {
            const turnId = await enqueueTurn(scheduledPrompt, {
              source: 'schedule',
              sourceId: `schedule-fixture:${randomUUID()}`,
              background: true,
              client,
            });
            await client.query(
              `INSERT INTO schedule_runs(id,owner_id,schedule_id,schedule_revision,job_id,title,turn_id,scheduled_for,time_zone,authority)
               VALUES($1,$2,$3,0,$4,$5,$6,$7,'UTC',jsonb_build_object('messages',jsonb_build_array(jsonb_build_object('id',null,'at',now(),'text',$8::text))))`,
              [
                randomUUID(),
                ownerId,
                schedule.id,
                randomUUID(),
                'Synthetic listing',
                turnId,
                new Date().toISOString(),
                'List the synthetic folder.',
              ],
            );
            return turnId;
          }, pool);
          await waitFor(scheduled, 'waiting|succeeded');
          assert.doesNotMatch(text(scheduled), /work the owner started/);
          const keepText = `Never touch the sorted folder ${randomUUID()}`;
          const keptOut = await propose(
            'keep_out',
            { path: join(folder, 'sorted') },
            'files',
            keepText,
          );
          assert.deepEqual(await approvalsFor(keptOut), []);
          const moveText = `Move a.txt into sorted ${randomUUID()}`;
          asked.add(moveText);
          plans.set(moveText, {
            tool: 'files',
            action: 'move',
            args: { moves: [{ from: join(folder, 'a.txt'), to: join(folder, 'sorted', 'a.txt') }] },
          });
          const moved = (await request('POST', '/api/messages', { text: moveText })).json()
            .turnId as string;
          await waitFor(moved, 'succeeded|failed');
          assert.match(
            text(moved) ??
              (await pool.query('SELECT error FROM turns WHERE id=$1', [moved])).rows[0].error,
            /keep out of .*sorted/,
          );
          assert.equal(await readFile(join(folder, 'a.txt'), 'utf8'), 'a');
          assert.equal(
            (
              await application.app.inject({
                method: 'DELETE',
                url: '/api/local-files/keep-out',
                headers: { host: headers.host },
                payload: { path: join(folder, 'sorted') },
              })
            ).statusCode,
            401,
          );
          const letIn = await request('DELETE', '/api/local-files/keep-out', {
            path: join(folder, 'sorted'),
          });
          assert.equal(letIn.statusCode, 200, letIn.body);
          assert.ok(!letIn.json().paths.includes(join(folder, 'sorted')));
        },
      );
      await inPart(
        'changed and legacy local reads return no result and permit a fresh checked read',
        async () => {
          await request('PATCH', '/api/preferences', { localFilesEnabled: true });
          const folder = await mkdtemp(join(localHome, 'changed-read-'));
          for (const action of ['read', 'import'])
            for (const legacy of [false, true]) {
              const path = join(folder, `${randomUUID()}.txt`);
              await writeFile(path, 'Original synthetic bytes');
              const text = `Read the synthetic file ${randomUUID()}`;
              const opening = await propose(action, { path }, 'files', text);
              const [approval] = await approvalsFor(opening);
              if (legacy)
                await pool.query("UPDATE approvals SET args=args-'version' WHERE id=$1", [
                  approval.id,
                ]);
              await writeFile(path, 'Current synthetic bytes');
              const beforeFiles = new Set(workspaceFiles.keys());
              asked.add(text);
              repeatAfterConfirm = { tool: 'files', action, args: { path } };
              const accepted = await request('POST', '/api/messages', {
                text: 'Yes',
                replyToMessageId: approval.confirmation_message_id,
                approvalAnswer: { approvalId: approval.id, approved: true },
              });
              assert.equal(accepted.statusCode, 200, accepted.body);
              const resumed = accepted.json().turnId;
              await waitFor(resumed, 'succeeded');
              const [saved] = await approvalsFor(opening);
              assert.equal(saved.status, 'expired');
              assert.match(saved.result.error, legacy ? /no checked version/ : /changed after/);
              assert.doesNotMatch(
                JSON.stringify(saved.result),
                /Original synthetic bytes|Current synthetic bytes/,
              );
              assert.equal(repeatAfterConfirm, undefined);
              if (action === 'read')
                assert.ok(JSON.stringify(results.get(resumed)).includes('Current synthetic bytes'));
              else {
                const imported = [...workspaceFiles.keys()].filter((key) => !beforeFiles.has(key));
                assert.equal(imported.length, 1);
                assert.equal(
                  Buffer.from(workspaceFiles.get(imported[0]!)!).toString(),
                  'Current synthetic bytes',
                );
              }
              assert.deepEqual(await approvalsFor(resumed), []);
            }
        },
      );
      await inPart(
        'a failed approved file open permits a fresh read in the same request',
        async () => {
          const folder = await mkdtemp(join(localHome, 'failed-open-'));
          for (const action of ['read', 'import']) {
            const path = join(folder, `${action}.txt`);
            await writeFile(path, 'Original synthetic bytes');
            const text = `Open the synthetic file ${randomUUID()}`;
            const opening = await propose(action, { path }, 'files', text);
            const [approval] = await approvalsFor(opening);
            const originalOpen = fs.open;
            let failed = false;
            const intercepted = t.mock.method(
              fs,
              'open',
              async (...args: Parameters<typeof fs.open>) => {
                if (args[0] === path && !failed) {
                  failed = true;
                  await writeFile(path, 'Current synthetic bytes');
                  throw Object.assign(new Error('EIO: synthetic file open failed'), {
                    statusCode: 503,
                  });
                }
                return Reflect.apply(originalOpen, fs, args);
              },
            );
            syncBuiltinESMExports();
            const beforeFiles = new Set(workspaceFiles.keys());
            try {
              asked.add(text);
              repeatAfterConfirm = { tool: 'files', action, args: { path } };
              const accepted = await request('POST', '/api/messages', {
                text: 'Yes',
                replyToMessageId: approval.confirmation_message_id,
                approvalAnswer: { approvalId: approval.id, approved: true },
              });
              assert.equal(accepted.statusCode, 200, accepted.body);
              const resumed = accepted.json().turnId;
              await waitFor(resumed, 'succeeded');
              const [saved] = await approvalsFor(opening);
              assert.equal(failed, true);
              assert.equal(saved.status, 'expired');
              assert.match(saved.result.error, /EIO: synthetic file open failed/);
              assert.doesNotMatch(JSON.stringify(saved.result), /synthetic bytes/);
              assert.equal(repeatAfterConfirm, undefined);
              if (action === 'read')
                assert.match(JSON.stringify(results.get(resumed)), /Current synthetic bytes/);
              else {
                const imported = [...workspaceFiles.keys()].filter((key) => !beforeFiles.has(key));
                assert.equal(imported.length, 1);
                assert.equal(
                  Buffer.from(workspaceFiles.get(imported[0]!)!).toString(),
                  'Current synthetic bytes',
                );
              }
              assert.deepEqual(await approvalsFor(resumed), []);
            } finally {
              repeatAfterConfirm = undefined;
              intercepted.mock.restore();
              syncBuiltinESMExports();
            }
          }
        },
      );
      await inPart(
        'a file path check failure after reading keeps the uncertain repeat fence',
        async () => {
          const enabled = await request('PATCH', '/api/preferences', { localFilesEnabled: true });
          assert.equal(enabled.statusCode, 200, enabled.body);
          const folder = await mkdtemp(join(localHome, 'uncertain-read-'));
          for (const action of ['read', 'import']) {
            const path = join(folder, `${action}.txt`);
            await writeFile(path, 'Original synthetic bytes');
            const text = `Open the synthetic file ${randomUUID()}`;
            const opening = await propose(action, { path }, 'files', text);
            const [approval] = await approvalsFor(opening);
            assert.equal(
              approval.action,
              action === 'read' ? 'LOCAL_FILES_READ' : 'LOCAL_FILES_IMPORT',
            );
            const originalOpen = fs.open;
            const originalLstat = fs.lstat;
            let reads = 0;
            let failed = false;
            const restoreReads: Array<() => void> = [];
            const opened = t.mock.method(
              fs,
              'open',
              async (...args: Parameters<typeof fs.open>) => {
                const file = await Reflect.apply(originalOpen, fs, args);
                if (args[0] === path) {
                  const originalRead = file.read;
                  const intercepted = t.mock.method(
                    file,
                    'read',
                    async (...input: Parameters<typeof file.read>) => {
                      const result = await Reflect.apply(originalRead, file, input);
                      reads++;
                      return result;
                    },
                  );
                  restoreReads.push(() => intercepted.mock.restore());
                }
                return file;
              },
            );
            const checked = t.mock.method(
              fs,
              'lstat',
              async (...args: Parameters<typeof fs.lstat>) => {
                if (args[0] === path && args[1]?.bigint && reads === 1 && !failed) {
                  failed = true;
                  await writeFile(path, 'Current synthetic bytes');
                  throw Object.assign(new Error('EIO: synthetic post-read path check failed'), {
                    statusCode: 503,
                  });
                }
                return Reflect.apply(originalLstat, fs, args);
              },
            );
            syncBuiltinESMExports();
            const beforeFiles = new Set(workspaceFiles.keys());
            try {
              asked.add(text);
              repeatAfterConfirm = { tool: 'files', action, args: { path } };
              const accepted = await request('POST', '/api/messages', {
                text: 'Yes',
                replyToMessageId: approval.confirmation_message_id,
                approvalAnswer: { approvalId: approval.id, approved: true },
              });
              assert.equal(accepted.statusCode, 200, accepted.body);
              const resumed = accepted.json().turnId;
              await waitFor(resumed, 'failed');
              const [saved] = await approvalsFor(opening);
              assert.equal(failed, true);
              assert.equal(saved.status, 'uncertain');
              assert.match(saved.result.error, /EIO: synthetic post-read path check failed/);
              assert.doesNotMatch(JSON.stringify(saved.result), /synthetic bytes/);
              assert.equal(repeatAfterConfirm, undefined);
              const failedTurn = (
                await pool.query('SELECT error FROM turns WHERE id=$1', [resumed])
              ).rows[0];
              assert.match(failedTurn.error, /pending or uncertain outcome/);
              assert.equal(reads, 1);
              assert.deepEqual(
                [...workspaceFiles.keys()].filter((key) => !beforeFiles.has(key)),
                [],
              );
              assert.deepEqual(await approvalsFor(resumed), []);
            } finally {
              repeatAfterConfirm = undefined;
              restoreReads.forEach((restore) => restore());
              opened.mock.restore();
              checked.mock.restore();
              syncBuiltinESMExports();
            }
          }
        },
      );
      await inPart('confirmed local reads observe edits in the same request', async () => {
        await request('PATCH', '/api/preferences', { localFilesEnabled: true });
        const folder = await mkdtemp(join(localHome, 'reread-'));
        for (const replacement of ['b'.repeat(859), 'a'.repeat(280)]) {
          const path = join(folder, `${randomUUID()}.md`);
          const original = 'a'.repeat(280) + '\nRemove this synthetic line after the table.\n';
          await writeFile(path, original);
          const text = `Check the synthetic note ${randomUUID()}`;
          const opening = await propose('read', { path }, 'files', text);
          const [approval] = await approvalsFor(opening);
          assert.equal(approval.action, 'LOCAL_FILES_READ');
          asked.add(text);
          repeatAfterConfirm = [
            {
              tool: 'files',
              action: 'edit',
              args: { path, edits: [{ oldText: original, newText: replacement }] },
            },
            { tool: 'files', action: 'read', args: { path } },
          ];
          const accepted = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: approval.confirmation_message_id,
            approvalAnswer: { approvalId: approval.id, approved: true },
          });
          assert.equal(accepted.statusCode, 200, accepted.body);
          const resumed = accepted.json().turnId;
          await waitFor(resumed, 'succeeded');
          assert.equal(await readFile(path, 'utf8'), replacement);
          const result = JSON.stringify(results.get(resumed));
          assert.ok(result.includes(replacement), result);
          assert.ok(!result.includes('Remove this synthetic line'), result);
          const [saved] = await approvalsFor(opening);
          assert.equal(saved.id, approval.id);
          assert.equal(saved.status, 'completed');
          assert.equal(saved.result.text, original);
          assert.deepEqual(await approvalsFor(resumed), []);
        }
      });
      await inPart(
        'local Markdown approvals preserve the reviewed path through execution',
        async () => {
          const folder = await mkdtemp(join(localHome, 'markdown-'));
          const path = join(folder, 'Next Actions.md');
          const contents = 'Synthetic next action: review the fixture.';
          await writeFile(path, contents);
          let reviewedArgs: { path: string; version: string } | undefined;
          confirmationModel = (input) => {
            const data = input.data as { action: string; args: { path: string; version: string } };
            assert.ok(['LOCAL_FILES_READ', 'LOCAL_FILES_IMPORT'].includes(data.action));
            assert.equal(data.args.path, path);
            assert.match(data.args.version, /^[a-f0-9]{64}$/);
            assert.deepEqual(Object.keys(data.args).sort(), ['path', 'version']);
            const operation = data.action === 'LOCAL_FILES_READ' ? 'read' : 'import';
            reviewedArgs = structuredClone(data.args);
            return { text: `Can I ${operation} ${path}?`, action: 'Open file' };
          };
          try {
            for (const action of ['read', 'import']) {
              const before = new Set(workspaceFiles.keys());
              const opening = await propose(action, { path }, 'files');
              const [approval] = await approvalsFor(opening);
              assert.equal(approval.status, 'pending');
              assert.deepEqual(approval.args, reviewedArgs);
              assert.doesNotMatch(JSON.stringify(results.get(opening)), /Synthetic next action/);
              assert.deepEqual([...workspaceFiles.keys()], [...before]);
              const response = await request('POST', '/api/messages', {
                text: 'Yes',
                replyToMessageId: approval.confirmation_message_id,
                approvalAnswer: { approvalId: approval.id, approved: true },
              });
              assert.equal(response.statusCode, 200, response.body);
              await waitFor(response.json().turnId, 'succeeded');
              assert.equal((await approvalsFor(opening))[0].status, 'completed');
              const stored = (await approvalsFor(opening))[0].result;
              if (action === 'read') assert.match(JSON.stringify(stored), /Synthetic next action/);
              else {
                const imported = [...workspaceFiles.keys()].filter((file) => !before.has(file));
                assert.equal(imported.length, 1);
                assert.equal(Buffer.from(workspaceFiles.get(imported[0]!)!).toString(), contents);
              }
              assert.equal(await readFile(path, 'utf8'), contents);
            }
          } finally {
            confirmationModel = undefined;
          }
        },
      );
      await inPart(
        'local files export imported workspace files and refuse changed approved bytes',
        async () => {
          const folder = await mkdtemp(join(localHome, 'exports-'));
          const source = join(folder, 'source.txt');
          await writeFile(source, 'Synthetic local report');
          const before = new Set(workspaceFiles.keys());
          const importText = `Import the synthetic local report ${randomUUID()}`;
          asked.add(importText);
          await propose('import', { path: source }, 'files', importText);
          const workspaceFile = [...workspaceFiles.keys()].find((path) => !before.has(path));
          assert.ok(workspaceFile);
          const file = { workspaceFile, mimeType: 'text/plain' };
          const path = join(folder, 'exported.txt');
          const exportText = `Save the synthetic local report ${randomUUID()}`;
          asked.add(exportText);
          const exported = await propose('export', { file, path }, 'files', exportText);
          assert.deepEqual(await approvalsFor(exported), []);
          assert.equal(await readFile(path, 'utf8'), 'Synthetic local report');

          const heldPath = join(folder, 'held.txt');
          const held = await propose('export', { file, path: heldPath }, 'files');
          const [approval] = await approvalsFor(held);
          assert.equal(approval.status, 'pending');
          workspaceFiles.set(workspaceFile, Buffer.from('Changed synthetic local report'));
          const response = await request('POST', '/api/messages', {
            text: 'Yes',
            replyToMessageId: approval.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          await waitFor(response.json().turnId, 'succeeded');
          assert.equal((await approvalsFor(held))[0].status, 'expired');
          assert.equal(existsSync(heldPath), false);
          assert.equal(await readFile(source, 'utf8'), 'Synthetic local report');
        },
      );
      await inPart(
        'computer use opens a named app and runs an approved step only after the owner answers',
        async () => {
          const send = async (body: Record<string, unknown>) => {
            for (;;) {
              const sent = await request('POST', '/api/messages', body);
              if (sent.statusCode !== 429) return sent;
              await delay(Number(sent.headers['retry-after'] ?? 1) * 1000);
            }
          };
          const enabled = await request('PATCH', '/api/computer-use', { enabled: true });
          assert.equal(enabled.statusCode, 200, enabled.body);
          assert.equal(enabled.json().enabled, true);
          const text = `Open TextEdit and clear the notes ${randomUUID()}`;
          asked.add(text);
          const { turnId: turn } = await taskTurn(
            text,
            [
              { tool: 'computer', action: 'open', args: { bundle: 'com.apple.TextEdit' } },
              { tool: 'computer', action: 'snapshot', args: { pid: 41 } },
              { tool: 'computer', action: 'press', args: { ref: '@snotes01:e7' } },
            ],
            { wait: 'waiting' },
          );
          assert.deepEqual(desktopSteps, []);
          const [held] = await approvalsFor(turn);
          assert.equal(held.action, 'COMPUTER_PRESS');
          assert.equal(held.status, 'pending');
          assert.deepEqual(held.args.control, {
            role: 'button',
            name: 'Delete',
            window: 'Notes',
          });
          const accepted = await send({
            text: 'Yes',
            replyToMessageId: held.confirmation_message_id,
            clientMessageId: randomUUID(),
            approvalAnswer: { approvalId: held.id, approved: true },
          });
          assert.equal(accepted.statusCode, 200, accepted.body);
          await waitFor(accepted.json().turnId, 'succeeded');
          assert.equal((await approvalsFor(turn))[0].status, 'completed');
          assert.deepEqual(desktopSteps, ['press']);
          const disabled = await request('PATCH', '/api/computer-use', { enabled: false });
          assert.equal(disabled.json().enabled, false);
        },
      );
      section = 3;
      await inPart('calendar approvals identify the exact occurrence before consent', async (t) => {
        await pool.query(
          'INSERT INTO preferences(owner_id) VALUES($1) ON CONFLICT (owner_id) DO NOTHING',
          [ownerId],
        );
        const event = {
          id: 'abc123def456_20301124T090000Z',
          etag: '"synthetic-calendar-version-1"',
          summary: 'Synthetic planning',
          start: { dateTime: '2030-11-24T10:00:00+01:00', timeZone: 'Europe/Paris' },
          end: { dateTime: '2030-11-24T10:30:00+01:00', timeZone: 'Europe/Paris' },
          recurringEventId: 'abc123def456',
          originalStartTime: { dateTime: '2030-11-24T10:00:00+01:00', timeZone: 'Europe/Paris' },
          description: 'Synthetic private description that is not target metadata.',
          attendees: [{ email: 'hidden-attendee@example.test', responseStatus: 'accepted' }],
          htmlLink: 'https://calendar.example.test/private-event',
        };
        const calls: Array<{ action: string; args: Record<string, unknown>; accountId?: string }> =
          [];
        let observed: unknown = { data: structuredClone(event), successful: true };
        let readFailure: Error | undefined;
        let onRead: ((signal?: AbortSignal) => Promise<void>) | undefined;
        calendarExecute = async (action, args, accountId, signal) => {
          calls.push({ action, args: structuredClone(args), accountId });
          const result = structuredClone(observed);
          if (action === 'GOOGLECALENDAR_EVENTS_GET') {
            await onRead?.(signal);
            if (readFailure) throw readFailure;
          }
          return result;
        };
        let connectionId: string | undefined;
        let turn: string | undefined;
        const decline = async (id: string) => {
          const [pending] = await approvalsFor(id);
          if (pending?.status !== 'pending') return;
          const declined = await request('POST', '/api/messages', {
            text: 'No',
            replyToMessageId: pending.confirmation_message_id,
            clientMessageId: randomUUID(),
          });
          assert.equal(declined.statusCode, 200, declined.body);
          await waitFor(declined.json().turnId, 'succeeded');
        };
        try {
          const connect = await request('POST', '/api/apps/googlecalendar/connect', {});
          assert.equal(connect.statusCode, 200, connect.body);
          const accountId = new URL(connect.json().url).pathname.split('/').pop();
          const consent = await application.app.inject({
            method: 'POST',
            url: `/e2e/connect/${accountId}`,
            headers,
          });
          const callback = new URL(String(consent.headers.location));
          await application.app.inject({ url: `${callback.pathname}${callback.search}`, headers });
          connectionId = (
            await pool.query(
              "SELECT id FROM app_connections WHERE owner_id=$1 AND slug='googlecalendar' AND NOT revoked",
              [ownerId],
            )
          ).rows[0].id;
          const args = {
            connectionId,
            calendar_id: 'primary',
            event_id: event.id,
            rsvp_response: 'accepted',
            send_updates: 'none',
          };
          const submit = async (
            action = 'GOOGLECALENDAR_PATCH_EVENT',
            input: Record<string, unknown> = args,
          ) => {
            const text = `Synthetic Calendar change ${randomUUID()}`;
            plans.set(text, { tool: 'apps', action, args: input });
            const response = await request('POST', '/api/messages', { text });
            assert.equal(response.statusCode, 200, response.body);
            turn = response.json().turnId as string;
            ids.push(response.json().threadId as string);
            await waitFor(turn, 'waiting|succeeded|failed|cancelled');
            return { turn, approval: (await approvalsFor(turn))[0] };
          };
          const accept = (approval: any) =>
            request('POST', '/api/messages', {
              text: approval.title,
              replyToMessageId: approval.confirmation_message_id,
              clientMessageId: randomUUID(),
              approvalAnswer: { approvalId: approval.id, approved: true },
            });
          const submitEvent = async () => {
            const text = `Synthetic Calendar event ${randomUUID()}`;
            plans.set(text, { tool: 'apps', action: 'GOOGLECALENDAR_PATCH_EVENT', args });
            const id = await enqueueTurn(text, { source: 'event', background: true });
            turn = id;
            await waitFor(id, 'waiting|succeeded|failed');
            return { turn: id, approval: (await approvalsFor(id))[0] };
          };
          const submitSchedule = async (approvalBacked = false) => {
            const schedule = await reminder({
              title: 'Synthetic Calendar schedule',
              prompt: `Review the synthetic Calendar ${randomUUID()}.`,
            });
            const warm = await request('POST', `/api/schedules/${schedule.id}/run`, {
              requestId: randomUUID(),
              expectedRevision: 0,
            });
            assert.equal(warm.statusCode, 200, warm.body);
            await waitFor(warm.json().turnId, 'succeeded');
            const prompt = (
              await pool.query('SELECT prompt FROM turns WHERE id=$1', [warm.json().turnId])
            ).rows[0].prompt;
            plans.set(prompt, { tool: 'apps', action: 'GOOGLECALENDAR_PATCH_EVENT', args });
            const sourceTurn = randomUUID();
            const sourceMessage = randomUUID();
            const contextMessage = randomUUID();
            const threadId = (await request('GET', '/api/state')).json().threadId;
            const text =
              'Read the synthetic Calendar. Never send an event update without approval.';
            await pool.query(
              "INSERT INTO turns(id,owner_id,thread_id,session_id,source,prompt,status,finished_at) VALUES($1,$2,$3,$3,'user',$4,'succeeded',now())",
              [sourceTurn, ownerId, threadId, text],
            );
            await pool.query(
              "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,'user',$5),($6,$2,$3,$4,'assistant','Synthetic schedule proposal')",
              [sourceMessage, ownerId, threadId, sourceTurn, text, contextMessage],
            );
            const authority = approvalBacked
              ? {
                  messages: [],
                  approvals: [
                    {
                      id: randomUUID(),
                      at: new Date().toISOString(),
                      definition: {
                        title: 'Synthetic Calendar schedule',
                        prompt: text,
                        kind: 'once',
                        runAt: '2099-01-01T09:00:00Z',
                        timeZone: 'UTC',
                        enabled: true,
                      },
                    },
                  ],
                }
              : {
                  messages: [
                    {
                      id: sourceMessage,
                      at: new Date().toISOString(),
                      text,
                      replyTo: { id: contextMessage, text: 'Synthetic schedule proposal' },
                    },
                  ],
                };
            await pool.query('UPDATE schedules SET authority=$2 WHERE id=$1', [
              schedule.id,
              JSON.stringify(authority),
            ]);
            const run = await request('POST', `/api/schedules/${schedule.id}/run`, {
              requestId: randomUUID(),
              expectedRevision: 0,
            });
            assert.equal(run.statusCode, 200, run.body);
            const id = run.json().turnId;
            turn = id;
            await waitFor(id, 'waiting|succeeded|failed');
            return {
              turn: id,
              approval: (await approvalsFor(id))[0],
              schedule,
              sourceTurn,
              sourceMessage,
              contextMessage,
              authority,
              prompt,
            };
          };
          const writeCount = () =>
            calls.filter((call) => call.action !== 'GOOGLECALENDAR_EVENTS_GET').length;
          const readCount = () =>
            calls.filter((call) => call.action === 'GOOGLECALENDAR_EVENTS_GET').length;
          const settledApproval = async (id: string) => {
            for (let attempt = 0; attempt < 100; attempt++) {
              const [saved] = await approvalsFor(id);
              if (!['pending', 'confirmed', 'executing'].includes(saved.status)) return saved;
              await delay(20);
            }
            return (await approvalsFor(id))[0];
          };
          const failure = async (id: string) =>
            (await pool.query('SELECT error FROM turns WHERE id=$1', [id])).rows[0].error;
          await t.test(
            'an unavailable Calendar metadata action is refused before its read',
            async () => {
              unoffered = 'GOOGLECALENDAR_EVENTS_GET';
              const before = calendarWording.length;
              try {
                const { turn: id, approval: card } = await submit();
                assert.equal(card, undefined);
                assert.match(await failure(id), /not an action the connection service offers/);
                assert.equal(calls.length, 0);
                assert.equal(calendarWording.length, before);
              } finally {
                unoffered = undefined;
              }
            },
          );
          const before = calendarWording.length;
          turn = await propose('GOOGLECALENDAR_PATCH_EVENT', args, 'apps');
          const [approval] = await approvalsFor(turn);
          assert.equal(approval.status, 'pending');
          assert.deepEqual(approval.args, args);
          assert.equal(approval.details.target?.eventId, event.id);
          const wording = calendarWording.slice(before);
          assert.deepEqual(
            wording.map((item) => item.purpose),
            ['confirmation'],
          );
          for (const item of wording) {
            assert.equal(item.data.details?.target?.title, event.summary);
            assert.equal(item.data.details?.target?.startsAt, event.start.dateTime);
            assert.equal(item.data.details?.target?.timeZone, event.start.timeZone);
            assert.equal(JSON.stringify(item).includes(event.description), false);
            assert.equal(JSON.stringify(item).includes(event.attendees[0]!.email), false);
            assert.equal(JSON.stringify(item).includes(event.htmlLink), false);
            assert.equal('verifiedCalendarRevision' in item.data.details, false);
            assert.equal('verifiedInstructionRevision' in item.data.details, false);
          }
          assert.deepEqual(
            [...calls],
            [
              {
                action: 'GOOGLECALENDAR_EVENTS_GET',
                args: { calendar_id: 'primary', event_id: event.id, max_attendees: 1 },
                accountId,
              },
            ],
          );
          assert.equal(
            calls.some((call) => call.action === 'GOOGLECALENDAR_PATCH_EVENT'),
            false,
          );
          assert.equal(
            (
              await pool.query('SELECT basis FROM app_actions WHERE turn_id=$1 AND action=$2', [
                turn,
                'GOOGLECALENDAR_EVENTS_GET',
              ])
            ).rows[0]?.basis.kind,
            'read',
          );
          await decline(turn);

          for (const [action, fields] of [
            [
              'GOOGLECALENDAR_UPDATE_EVENT',
              { start_datetime: event.start.dateTime, summary: 'A new synthetic title' },
            ],
            ['GOOGLECALENDAR_DELETE_EVENT', {}],
            ['GOOGLECALENDAR_REMOVE_ATTENDEE', { attendee_email: 'guest@example.test' }],
            ['GOOGLECALENDAR_EVENTS_MOVE', { destination: 'secondary@example.test' }],
          ] as const)
            await t.test(
              `${action} keeps the proposed arguments and reads the current target`,
              async () => {
                const input = {
                  connectionId,
                  event_id: event.id,
                  ...(action === 'GOOGLECALENDAR_DELETE_EVENT' ? {} : { calendar_id: 'primary' }),
                  ...fields,
                };
                const writes = writeCount();
                const reads = readCount();
                const { turn: id, approval: card } = await submit(action, input);
                assert.equal(card.status, 'pending');
                assert.deepEqual(card.args, input);
                assert.equal(card.details.target.title, event.summary);
                assert.equal(card.details.target.scope, 'occurrence');
                assert.equal(readCount(), reads + 1);
                assert.equal(writeCount(), writes);
                const accepted = await accept(card);
                assert.equal(accepted.statusCode, 200, accepted.body);
                await waitFor(accepted.json().turnId, 'succeeded');
                assert.equal((await approvalsFor(id))[0].status, 'completed');
                assert.equal(readCount(), reads + 2);
                assert.equal(writeCount(), writes + 1);
                const { connectionId: _connectionId, ...providerArgs } = input;
                assert.deepEqual(calls.at(-1), { action, args: providerArgs, accountId });
                assert.equal((await accept(card)).statusCode, 409);
                assert.equal(writeCount(), writes + 1);
              },
            );

          for (const [name, data, expected] of [
            [
              'all-day event',
              {
                id: event.id,
                summary: 'Synthetic all-day plan',
                start: { date: '2030-11-24' },
                end: { date: '2030-11-25' },
              },
              { allDay: true, startsAt: '2030-11-24', endsAt: '2030-11-25', scope: 'event' },
            ],
            [
              'timed event without a named zone',
              {
                id: event.id,
                summary: 'Synthetic timed plan',
                start: { dateTime: '2030-11-24T10:00:00-05:00' },
                end: { dateTime: '2030-11-24T10:30:00-05:00' },
              },
              { allDay: false, startsAt: '2030-11-24T10:00:00-05:00', scope: 'event' },
            ],
            [
              'local recurring occurrence',
              {
                id: event.id,
                summary: 'Synthetic local plan',
                start: { dateTime: '2030-11-24T10:00:00', timeZone: 'Europe/Paris' },
                end: { dateTime: '2030-11-24T10:30:00', timeZone: 'Europe/Paris' },
                recurringEventId: 'abc123def456',
                originalStartTime: { dateTime: '2030-11-24T10:00:00', timeZone: 'Europe/Paris' },
              },
              {
                startsAt: '2030-11-24T09:00:00.000Z',
                endsAt: '2030-11-24T09:30:00.000Z',
                originalStartsAt: '2030-11-24T09:00:00.000Z',
                timeZone: 'Europe/Paris',
                originalTimeZone: 'Europe/Paris',
                scope: 'occurrence',
              },
            ],
            [
              'recurring series',
              {
                id: event.id,
                summary: 'Synthetic recurring plan',
                start: event.start,
                end: event.end,
                recurrence: ['RRULE:FREQ=WEEKLY'],
              },
              { scope: 'series' },
            ],
            [
              'untitled event',
              { id: event.id, start: event.start, end: event.end },
              { title: 'Untitled event', scope: 'event' },
            ],
          ] as const)
            await t.test(`Calendar metadata keeps the meaning of an ${name}`, async () => {
              observed = { data: { etag: event.etag, ...structuredClone(data) }, successful: true };
              try {
                const { turn: id, approval: card } = await submit();
                assert.equal(card.status, 'pending');
                assert.equal(card.details.target.endExclusive, true);
                for (const item of calendarWording.slice(-2))
                  assert.equal(item.data.details.target.endExclusive, true);
                for (const [key, value] of Object.entries(expected))
                  assert.equal(card.details.target[key], value);
                if (name === 'all-day event')
                  assert.equal('timeZone' in card.details.target, false);
                await decline(id);
              } finally {
                observed = { data: structuredClone(event), successful: true };
              }
            });

          for (const [name, data] of [
            ['another event', { ...event, id: 'abc999' }],
            ['missing event version', { ...event, etag: undefined }],
            ['empty event version', { ...event, etag: '' }],
            ['invalid event version', { ...event, etag: 17 }],
            ['oversize event version', { ...event, etag: 'x'.repeat(1025) }],
            ['missing start', { ...event, start: {} }],
            ['missing end', { ...event, end: {} }],
            ['invalid title', { ...event, summary: 17 }],
            ['unspecified end', { ...event, endTimeUnspecified: true }],
            ['invalid end flag', { ...event, endTimeUnspecified: 'false' }],
            ['mixed date forms', { ...event, start: { date: '2030-11-24' } }],
            ['reversed dates', { ...event, end: { dateTime: '2030-11-23T10:00:00+01:00' } }],
            [
              'invalid zone',
              { ...event, start: { ...event.start, timeZone: 'Invalid/Synthetic' } },
            ],
            ['invalid zone type', { ...event, start: { ...event.start, timeZone: 17 } }],
            ['invalid series ID', { ...event, recurringEventId: 'x'.repeat(1025) }],
            ['cancelled event', { ...event, status: 'cancelled' }],
            ['missing occurrence anchor', { ...event, originalStartTime: undefined }],
            ['conflicting recurrence', { ...event, recurrence: ['RRULE:FREQ=WEEKLY'] }],
          ] as const)
            await t.test(`Calendar metadata refuses ${name} before asking`, async () => {
              observed = { data: structuredClone(data), successful: true };
              const writes = writeCount();
              const before = calendarWording.length;
              try {
                const { turn: id, approval: card } = await submit();
                assert.equal(card, undefined);
                assert.match(await failure(id), /cannot verify the Calendar event/);
                assert.equal(writeCount(), writes);
                assert.equal(calendarWording.length, before);
              } finally {
                observed = { data: structuredClone(event), successful: true };
              }
            });

          await t.test('Calendar read failures keep the provider status and reason', async () => {
            readFailure = Object.assign(new Error('Synthetic Calendar service unavailable.'), {
              status: 503,
            });
            const writes = writeCount();
            try {
              const { turn: id, approval: card } = await submit();
              assert.equal(card, undefined);
              const reason = await failure(id);
              assert.match(reason, /503/);
              assert.match(reason, /Synthetic Calendar service unavailable/);
              assert.equal(writeCount(), writes);
            } finally {
              readFailure = undefined;
            }
          });

          await t.test('Calendar metadata reads obey an ask-first rule', async () => {
            const rules = (
              await pool.query('SELECT rules FROM preferences WHERE owner_id=$1', [ownerId])
            ).rows[0].rules;
            const reads = readCount();
            const writes = writeCount();
            await pool.query('UPDATE preferences SET rules=$2 WHERE owner_id=$1', [
              ownerId,
              'Ask before reading Calendar.',
            ]);
            try {
              const { turn: id, approval: card } = await submit();
              assert.equal(card, undefined);
              assert.match(await failure(id), /rules require confirmation before reading/);
              assert.equal(readCount(), reads);
              assert.equal(writeCount(), writes);
            } finally {
              await pool.query('UPDATE preferences SET rules=$2 WHERE owner_id=$1', [
                ownerId,
                rules,
              ]);
            }
          });

          for (const phase of ['preparation', 'execution'])
            for (const [before, after] of [
              ['', 'Read Calendar only. Never change an event.'],
              ['Read Calendar only. Never change an event.', ''],
            ])
              await t.test(
                `Calendar event ${phase} binds a changed standing instruction ${Boolean(before)}`,
                async () => {
                  const original = (
                    await pool.query(
                      'SELECT notification_rule FROM preferences WHERE owner_id=$1',
                      [ownerId],
                    )
                  ).rows[0].notification_rule;
                  const writes = writeCount();
                  let changed = false;
                  const change = async () => {
                    changed = true;
                    await pool.query(
                      'UPDATE preferences SET notification_rule=$2 WHERE owner_id=$1',
                      [ownerId, after],
                    );
                  };
                  await pool.query(
                    'UPDATE preferences SET notification_rule=$2 WHERE owner_id=$1',
                    [ownerId, before],
                  );
                  if (phase === 'preparation') onRead = change;
                  try {
                    const { turn: id, approval: card } = await submitEvent();
                    if (phase === 'preparation') {
                      assert.equal(card, undefined);
                      assert.match(await failure(id), /standing instruction changed/);
                    } else {
                      assert.equal(card.status, 'pending');
                      assert.equal(
                        card.details.verifiedInstructionRevision.standingInstruction,
                        before,
                      );
                      onRead = change;
                      const accepted = await accept(card);
                      assert.equal(accepted.statusCode, 200, accepted.body);
                      await waitFor(accepted.json().turnId, 'waiting|succeeded|failed');
                      const [saved] = await approvalsFor(id);
                      assert.equal(saved.status, 'expired');
                      assert.match(JSON.stringify(saved), /standing instruction changed/);
                    }
                    assert.equal(changed, true);
                    assert.equal(writeCount(), writes);
                  } finally {
                    onRead = undefined;
                    await pool.query(
                      'UPDATE preferences SET notification_rule=$2 WHERE owner_id=$1',
                      [ownerId, original],
                    );
                  }
                },
              );

          for (const background of [false, true])
            await t.test(
              `Calendar final read keeps ${background ? 'background' : 'foreground'} service-wait policy`,
              async () => {
                const { turn: id, approval: card } = await (background ? submitEvent() : submit());
                assert.equal(card.status, 'pending');
                const writes = writeCount();
                const reads = readCount();
                let held = false;
                calendarReadReview = async () => {
                  held = true;
                  connectionWait = {
                    until: Date.now() + 120_000,
                    status: 429,
                    code: 'installation_busy',
                  };
                };
                try {
                  const accepted = await accept(card);
                  assert.equal(accepted.statusCode, 200, accepted.body);
                  await waitFor(accepted.json().turnId, 'waiting|succeeded|failed');
                  const [saved] = await approvalsFor(id);
                  assert.equal(held, true);
                  assert.equal(saved.status, background ? 'expired' : 'completed');
                  assert.equal(readCount(), reads + (background ? 0 : 1));
                  assert.equal(writeCount(), writes + (background ? 0 : 1));
                  if (background)
                    assert.match(JSON.stringify(saved), /Nod did not read this source/);
                } finally {
                  calendarReadReview = undefined;
                  connectionWait = undefined;
                }
              },
            );

          await t.test(
            'an event Calendar approval without its standing snapshot cannot dispatch',
            async () => {
              const { turn: id, approval: card } = await submitEvent();
              assert.equal(card.status, 'pending');
              const reads = readCount();
              const writes = writeCount();
              await pool.query(
                "UPDATE approvals SET details=jsonb_set(details,'{verifiedInstructionRevision}',(details->'verifiedInstructionRevision')-'standingInstruction') WHERE id=$1",
                [card.id],
              );
              const accepted = await accept(card);
              assert.equal(accepted.statusCode, 200, accepted.body);
              await waitFor(accepted.json().turnId, 'waiting|succeeded|failed');
              assert.equal((await approvalsFor(id))[0].status, 'expired');
              assert.equal(readCount(), reads);
              assert.equal(writeCount(), writes);
            },
          );

          for (const change of [
            'source withdrawn',
            'context hidden',
            'parent edit',
            'approval-backed',
          ])
            await t.test(
              `Calendar schedule approval keeps its frozen authority after ${change}`,
              async () => {
                const fixture = await submitSchedule(change === 'approval-backed');
                const { turn: id, approval: card } = fixture;
                assert.equal(card.status, 'pending');
                const writes = writeCount();
                const reads = readCount();
                onRead = async () => {
                  if (change === 'source withdrawn')
                    await pool.query('UPDATE turns SET withdrawn=true WHERE id=$1', [
                      fixture.sourceTurn,
                    ]);
                  else if (change === 'context hidden')
                    await pool.query('UPDATE messages SET hidden_at=now() WHERE id=$1', [
                      fixture.contextMessage,
                    ]);
                  else if (change === 'parent edit') {
                    const edited = await request('PATCH', `/api/schedules/${fixture.schedule.id}`, {
                      prompt: 'A different future instruction.',
                      expectedRevision: 0,
                    });
                    assert.equal(edited.statusCode, 200, edited.body);
                  }
                };
                try {
                  const accepted = await accept(card);
                  assert.equal(accepted.statusCode, 200, accepted.body);
                  await waitFor(accepted.json().turnId, 'waiting|succeeded|failed');
                  const [saved] = await approvalsFor(id);
                  assert.equal(saved.status, 'completed');
                  assert.equal(writeCount(), writes + 1);
                  assert.equal(readCount(), reads + 1);
                  const frozen = (
                    await pool.query('SELECT authority FROM schedule_runs WHERE turn_id=$1', [id])
                  ).rows[0].authority;
                  assert.deepEqual(frozen, fixture.authority);
                } finally {
                  onRead = undefined;
                  await pool.query('UPDATE turns SET withdrawn=false WHERE id=$1', [
                    fixture.sourceTurn,
                  ]);
                  await pool.query('UPDATE messages SET hidden_at=NULL WHERE id=$1', [
                    fixture.contextMessage,
                  ]);
                  plans.delete(fixture.prompt);
                  await request('DELETE', `/api/schedules/${fixture.schedule.id}`);
                }
              },
            );

          for (const changeRules of [false, true])
            await t.test(
              changeRules
                ? 'Calendar repeat keeps the instruction revision captured before its read'
                : 'Calendar repeat reads a fresh target before its new approval',
              async () => {
                const writes = writeCount();
                const reads = readCount();
                const rules = (
                  await pool.query('SELECT rules FROM preferences WHERE owner_id=$1', [ownerId])
                ).rows[0].rules;
                const reply = `Repeat the synthetic Calendar update ${randomUUID()}.`;
                const question = `Should I repeat the same synthetic Calendar update ${randomUUID()}?`;
                try {
                  const { turn: firstTurn, approval: first } = await submit();
                  assert.equal(first.status, 'pending');
                  questionAfterConfirm = question;
                  const accepted = await accept(first);
                  assert.equal(accepted.statusCode, 200, accepted.body);
                  await waitFor(accepted.json().turnId, 'waiting');
                  assert.equal(writeCount(), writes + 1);
                  assert.equal(readCount(), reads + 2);
                  const original = (await approvalsFor(firstTurn))[0];
                  assert.equal(original.status, 'completed');
                  const askedQuestion = (
                    await pool.query(
                      "SELECT id FROM messages WHERE turn_id=$1 AND role='assistant' AND text=$2",
                      [accepted.json().turnId, question],
                    )
                  ).rows[0];
                  assert.ok(askedQuestion);
                  observed = {
                    data: {
                      ...structuredClone(event),
                      etag: '"synthetic-calendar-repeat-version"',
                      summary: 'Synthetic revised planning',
                    },
                    successful: true,
                  };
                  asked.add(reply);
                  plans.set(reply, { tool: 'apps', action: 'GOOGLECALENDAR_PATCH_EVENT', args });
                  repeatDecision = 'new';
                  let ruleChanges = 0;
                  if (changeRules)
                    onRead = async () => {
                      ruleChanges++;
                      await pool.query('UPDATE preferences SET rules=$2 WHERE owner_id=$1', [
                        ownerId,
                        'Do not change the synthetic Calendar event.',
                      ]);
                    };
                  const wording = calendarWording.length;
                  const repeated = await request('POST', '/api/messages', {
                    text: reply,
                    replyToMessageId: askedQuestion.id,
                  });
                  assert.equal(repeated.statusCode, 200, repeated.body);
                  const repeatedTurn = repeated.json().turnId;
                  turn = repeatedTurn;
                  await waitFor(repeatedTurn, 'waiting|succeeded|failed');
                  assert.ok(
                    repeatChecks.some(
                      (input) =>
                        Object(input).reply === reply && Object(input).question === question,
                    ),
                  );
                  assert.equal(readCount(), reads + 3);
                  assert.equal(writeCount(), writes + 1);
                  const [second] = await approvalsFor(repeatedTurn);
                  if (changeRules) {
                    assert.equal(ruleChanges, 1);
                    assert.equal(second, undefined);
                    assert.match(await failure(repeatedTurn), /owner rules changed/);
                  } else {
                    assert.ok(second);
                    assert.equal(second.status, 'pending');
                    assert.equal(second.details.reason, undefined);
                    assert.equal(second.source_message_id, repeated.json().messageId);
                    assert.deepEqual(second.args, first.args);
                    assert.equal(second.details.target.title, 'Synthetic revised planning');
                    assert.match(await confirmationFor(second), /Synthetic revised planning/);
                    assert.equal(second.details.target.eventId, event.id);
                    assert.notEqual(
                      second.details.verifiedCalendarRevision,
                      first.details.verifiedCalendarRevision,
                    );
                    assert.equal(
                      second.details.verifiedInstructionRevision.chat.id,
                      repeated.json().messageId,
                    );
                    for (const item of calendarWording.slice(wording)) {
                      assert.equal(item.data.details.target.title, 'Synthetic revised planning');
                      assert.equal('verifiedCalendarRevision' in item.data.details, false);
                      assert.equal('verifiedInstructionRevision' in item.data.details, false);
                      assert.equal(JSON.stringify(item).includes(event.description), false);
                    }
                    const confirmed = await accept(second);
                    assert.equal(confirmed.statusCode, 200, confirmed.body);
                    await waitFor(confirmed.json().turnId, 'succeeded');
                    assert.equal(readCount(), reads + 4);
                    assert.equal(writeCount(), writes + 2);
                    assert.equal((await approvalsFor(repeatedTurn))[0].status, 'completed');
                    assert.equal((await accept(second)).statusCode, 409);
                    assert.equal(writeCount(), writes + 2);
                  }
                  assert.deepEqual((await approvalsFor(firstTurn))[0].result, original.result);
                  assert.equal((await approvalsFor(firstTurn))[0].status, 'completed');
                } finally {
                  onRead = undefined;
                  observed = { data: structuredClone(event), successful: true };
                  questionAfterConfirm = undefined;
                  repeatDecision = 'same';
                  plans.delete(reply);
                  asked.delete(reply);
                  await pool.query('UPDATE preferences SET rules=$2 WHERE owner_id=$1', [
                    ownerId,
                    rules,
                  ]);
                }
              },
            );

          await t.test(
            'Calendar approval rechecks the target and dispatches once after yes',
            async () => {
              const writes = writeCount();
              const reads = readCount();
              const { turn: id, approval: card } = await submit();
              assert.equal(writeCount(), writes);
              const accepted = await accept(card);
              assert.equal(accepted.statusCode, 200, accepted.body);
              await waitFor(accepted.json().turnId, 'succeeded');
              assert.equal(readCount(), reads + 2);
              assert.equal(writeCount(), writes + 1);
              assert.equal((await approvalsFor(id))[0].status, 'completed');
              assert.deepEqual(calls.at(-1), {
                action: 'GOOGLECALENDAR_PATCH_EVENT',
                args: {
                  calendar_id: 'primary',
                  event_id: event.id,
                  rsvp_response: 'accepted',
                  send_updates: 'none',
                },
                accountId,
              });
              const repeated = await accept(card);
              assert.equal(repeated.statusCode, 409);
              assert.equal(writeCount(), writes + 1);
            },
          );

          for (const changed of [false, true])
            await t.test(
              changed
                ? 'Calendar approval preserves a guest added while consent waits'
                : 'Calendar approval applies the checked guest list exactly once',
              async () => {
                const execute = calendarExecute;
                const writes = writeCount();
                const trustStart = calendarTrust.length;
                const ledgerWrites = async () =>
                  Number(
                    (
                      await pool.query(
                        "SELECT count(*) FROM app_actions WHERE action='GOOGLECALENDAR_PATCH_EVENT'",
                      )
                    ).rows[0].count,
                  );
                const recorded = await ledgerWrites();
                const current = {
                  ...structuredClone(event),
                  attendees: [
                    { email: 'owner@example.test', self: true, responseStatus: 'accepted' },
                    { email: 'existing-guest@example.test', responseStatus: 'accepted' },
                  ],
                };
                const added = { email: 'later-guest@example.test', responseStatus: 'needsAction' };
                const input = {
                  connectionId,
                  calendar_id: 'primary',
                  event_id: event.id,
                  attendees: [
                    ...structuredClone(current.attendees),
                    { email: 'requested-guest@example.test', responseStatus: 'needsAction' },
                  ],
                  send_updates: 'all',
                };
                calendarExecute = async (action, args, account, signal) => {
                  signal?.throwIfAborted();
                  calls.push({ action, args: structuredClone(args), accountId: account });
                  if (action === 'GOOGLECALENDAR_EVENTS_GET') {
                    assert.equal(args.max_attendees, 1);
                    return {
                      data: {
                        ...structuredClone(current),
                        attendees: [current.attendees[0]],
                        attendeesOmitted: true,
                      },
                      successful: true,
                    };
                  }
                  assert.equal(action, 'GOOGLECALENDAR_PATCH_EVENT');
                  assert.deepEqual(args.attendees, input.attendees);
                  current.attendees = structuredClone(args.attendees as typeof current.attendees);
                  current.etag = '"synthetic-calendar-written"';
                  return { data: structuredClone(current), successful: true };
                };
                try {
                  const { turn: id, approval: card } = await submit(
                    'GOOGLECALENDAR_PATCH_EVENT',
                    input,
                  );
                  assert.equal(card.status, 'pending');
                  assert.deepEqual(card.args, input);
                  assert.equal(writeCount(), writes);
                  const shown = JSON.stringify(calendarWording.slice(-2));
                  assert.equal(shown.includes('synthetic-calendar-version'), false);
                  assert.equal(shown.includes('attendeesOmitted'), false);
                  if (changed) {
                    current.attendees.push(added);
                    current.etag = '"synthetic-calendar-guest-added"';
                  }
                  const accepted = await accept(card);
                  assert.equal(accepted.statusCode, 200, accepted.body);
                  await waitFor(accepted.json().turnId, 'waiting|succeeded|failed');
                  const saved = (await approvalsFor(id))[0];
                  assert.equal((await approvalsFor(id)).length, 1);
                  assert.equal(await ledgerWrites(), recorded + (changed ? 0 : 1));
                  const trust = calendarTrust.slice(trustStart);
                  assert.ok(
                    trust.some((input) => input.action.name === 'GOOGLECALENDAR_PATCH_EVENT'),
                  );
                  assert.ok(
                    trust.some((input) => input.action.name === 'GOOGLECALENDAR_EVENTS_GET'),
                  );
                  const checked = JSON.stringify(trust);
                  assert.equal(checked.includes('synthetic-calendar-version'), false);
                  assert.equal(checked.includes('synthetic-calendar-guest-added'), false);
                  assert.equal(checked.includes(added.email), false);
                  const messages = await pool.query(
                    'SELECT text FROM messages WHERE turn_id = ANY($1::uuid[])',
                    [[id, accepted.json().turnId]],
                  );
                  assert.equal(JSON.stringify(messages.rows).includes(added.email), false);
                  assert.equal(
                    JSON.stringify(messages.rows).includes('synthetic-calendar-version'),
                    false,
                  );
                  assert.deepEqual(
                    {
                      status: saved.status,
                      writes: writeCount() - writes,
                      laterGuestKept: current.attendees.some(
                        (guest) => guest.email === added.email,
                      ),
                    },
                    changed
                      ? { status: 'expired', writes: 0, laterGuestKept: true }
                      : { status: 'completed', writes: 1, laterGuestKept: false },
                  );
                  if (changed) assert.match(JSON.stringify(saved), /Calendar event changed/);
                  else assert.deepEqual(current.attendees, input.attendees);
                  assert.equal((await accept(card)).statusCode, 409);
                  assert.equal(writeCount(), writes + (changed ? 0 : 1));
                } finally {
                  calendarExecute = execute;
                }
              },
            );

          for (const [name, data] of [
            ['missing event version', { ...event, etag: undefined }],
            ['blank event version', { ...event, etag: '' }],
            ['unspecified end', { ...event, endTimeUnspecified: true }],
          ] as const)
            await t.test(`Calendar approval refuses ${name} on its final read`, async () => {
              const writes = writeCount();
              const { turn: id, approval: card } = await submit();
              assert.equal(card.status, 'pending');
              observed = { data: structuredClone(data), successful: true };
              try {
                const accepted = await accept(card);
                assert.equal(accepted.statusCode, 200, accepted.body);
                await waitFor(accepted.json().turnId, 'waiting|succeeded|failed');
                const [saved] = await approvalsFor(id);
                assert.equal(saved.status, 'expired');
                assert.match(JSON.stringify(saved), /cannot verify the Calendar event/);
                assert.equal(writeCount(), writes);
              } finally {
                observed = { data: structuredClone(event), successful: true };
              }
            });

          await t.test('Calendar approval refuses a changed target before dispatch', async () => {
            const writes = writeCount();
            const { turn: id, approval: card } = await submit();
            observed = {
              data: {
                ...event,
                start: { ...event.start, dateTime: '2030-11-25T10:00:00+01:00' },
                end: { ...event.end, dateTime: '2030-11-25T10:30:00+01:00' },
              },
              successful: true,
            };
            try {
              const accepted = await accept(card);
              assert.equal(accepted.statusCode, 200, accepted.body);
              await waitFor(accepted.json().turnId, 'waiting|succeeded|failed');
              const [saved] = await approvalsFor(id);
              assert.equal(saved.status, 'expired');
              assert.equal(JSON.stringify(saved).includes('Calendar event changed'), true);
              assert.equal(writeCount(), writes);
            } finally {
              observed = { data: structuredClone(event), successful: true };
            }
          });

          for (const [name, before, after] of [
            [
              'recurrence',
              {
                ...event,
                recurringEventId: undefined,
                originalStartTime: undefined,
                recurrence: ['RRULE:FREQ=WEEKLY;COUNT=2'],
              },
              {
                ...event,
                recurringEventId: undefined,
                originalStartTime: undefined,
                recurrence: ['RRULE:FREQ=DAILY;COUNT=100'],
              },
            ],
            [
              'title after its display limit',
              { ...event, summary: `${'Synthetic plan '.repeat(24)}before` },
              { ...event, summary: `${'Synthetic plan '.repeat(24)}after` },
            ],
          ] as const)
            await t.test(`Calendar approval refuses changed ${name}`, async () => {
              const writes = writeCount();
              observed = { data: structuredClone(before), successful: true };
              try {
                const { turn: id, approval: card } = await submit('GOOGLECALENDAR_DELETE_EVENT', {
                  connectionId,
                  event_id: event.id,
                });
                observed = { data: structuredClone(after), successful: true };
                const accepted = await accept(card);
                assert.equal(accepted.statusCode, 200, accepted.body);
                await waitFor(accepted.json().turnId, 'waiting|succeeded|failed');
                assert.equal((await approvalsFor(id))[0].status, 'expired');
                assert.equal(writeCount(), writes);
              } finally {
                observed = { data: structuredClone(event), successful: true };
              }
            });

          await t.test(
            'an owner correction during the final Calendar read prevents dispatch',
            async () => {
              const writes = writeCount();
              const { turn: id, approval: card } = await submit();
              let entered!: () => void;
              const reading = new Promise<void>((resolve) => {
                entered = resolve;
              });
              let release!: () => void;
              const held = new Promise<void>((resolve) => {
                release = resolve;
              });
              onRead = async () => {
                entered();
                await held;
              };
              let accepted: any;
              let correction: any;
              try {
                accepted = await accept(card);
                assert.equal(accepted.statusCode, 200, accepted.body);
                await reading;
                correction = await request('POST', '/api/messages', {
                  text: 'Do not change the Calendar event.',
                });
                assert.equal(correction.statusCode, 200, correction.body);
                release();
                await waitFor(accepted.json().turnId, 'waiting|succeeded|failed');
                assert.equal((await approvalsFor(id))[0].status, 'expired');
                assert.equal(writeCount(), writes);
              } finally {
                release();
                onRead = undefined;
                if (correction?.statusCode === 200)
                  await waitFor(correction.json().turnId, 'succeeded');
              }
            },
          );

          await t.test(
            'Stop during the final Calendar read records that the write did not run',
            async () => {
              const { turn: id, approval: card } = await submit();
              const writes = writeCount();
              let entered!: (signal?: AbortSignal) => void;
              const reading = new Promise<AbortSignal | undefined>((resolve) => {
                entered = resolve;
              });
              let release!: () => void;
              const held = new Promise<void>((resolve) => {
                release = resolve;
              });
              onRead = async (signal) => {
                entered(signal);
                await held;
              };
              try {
                const accepted = await accept(card);
                assert.equal(accepted.statusCode, 200, accepted.body);
                const signal = await reading;
                assert.equal((await request('POST', '/api/thread/stop', {})).statusCode, 200);
                assert.equal(signal?.aborted, true);
                release();
                await waitFor(accepted.json().turnId, 'cancelled');
                assert.equal((await settledApproval(id)).status, 'expired');
                assert.equal(writeCount(), writes);
                assert.equal((await approvalsFor(id)).length, 1);
              } finally {
                release();
                onRead = undefined;
              }
            },
          );

          const createCalendarTask = async (taskId: string, progressId = randomUUID()) => {
            const parentId = randomUUID();
            const ownerMessageId = randomUUID();
            const prompt = `Synthetic task Calendar change ${randomUUID()}`;
            const threadId = (await request('GET', '/api/state')).json<AppState>().threadId;
            plans.set(prompt, { tool: 'apps', action: 'GOOGLECALENDAR_PATCH_EVENT', args });
            const id = await transaction(async (client) => {
              await client.query(
                `INSERT INTO turns(id,owner_id,thread_id,session_id,source,message_id,prompt,status,finished_at) VALUES($1,$2,$3,$3,'user',$4,$5,'succeeded',now())`,
                [
                  parentId,
                  ownerId,
                  threadId,
                  ownerMessageId,
                  'Review the synthetic Calendar response.',
                ],
              );
              await client.query(
                `INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,'user',$5)`,
                [
                  ownerMessageId,
                  ownerId,
                  threadId,
                  parentId,
                  'Review the synthetic Calendar response.',
                ],
              );
              const id = await enqueueTurn(prompt, {
                source: 'task',
                sessionId: taskId,
                parentTurnId: parentId,
                background: true,
                client,
              });
              await client.query(
                `INSERT INTO tasks(id,owner_id,turn_id,session_id,source_message_id,title,done_when,now_text,applied_revision) VALUES($1,$2,$3,$1,$4,'Synthetic Calendar task','Response checked','Waiting for approval',1)`,
                [taskId, ownerId, id, ownerMessageId],
              );
              await client.query('UPDATE turns SET task_id=$1,task_revision=1 WHERE id=$2', [
                taskId,
                id,
              ]);
              await client.query(
                "INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text) VALUES($1,$2,$3,$4,'assistant','Synthetic Calendar progress')",
                [progressId, ownerId, threadId, id],
              );
              return id;
            }, pool);
            return { id, progressId };
          };

          for (const taskCorrection of [false, true])
            await t.test(
              taskCorrection
                ? 'a task correction during the final Calendar read prevents dispatch'
                : 'main chat does not change a task Calendar approval',
              async () => {
                const taskId = randomUUID();
                const { id } = await createCalendarTask(taskId);
                await waitFor(id, 'waiting');
                const [card] = await approvalsFor(id);
                assert.equal(card.status, 'pending');
                assert.equal(card.details.verifiedInstructionRevision.task.id, taskId);
                assert.equal(card.details.verifiedInstructionRevision.chat, undefined);
                let entered!: () => void;
                const reading = new Promise<void>((resolve) => {
                  entered = resolve;
                });
                let release!: () => void;
                const held = new Promise<void>((resolve) => {
                  release = resolve;
                });
                onRead = async () => {
                  entered();
                  await held;
                };
                const writes = writeCount();
                let correction: any;
                try {
                  const accepted = await accept(card);
                  assert.equal(accepted.statusCode, 200, accepted.body);
                  await reading;
                  correction = await request('POST', '/api/messages', {
                    text: taskCorrection
                      ? 'Do not change the Calendar event.'
                      : 'Tell me the synthetic local status.',
                    ...(taskCorrection ? { replyToMessageId: card.confirmation_message_id } : {}),
                  });
                  assert.equal(correction.statusCode, 200, correction.body);
                  release();
                  await waitFor(accepted.json().turnId, 'waiting|succeeded|failed');
                  assert.equal(
                    (await approvalsFor(id))[0].status,
                    taskCorrection ? 'expired' : 'completed',
                  );
                  assert.equal(writeCount(), writes + (taskCorrection ? 0 : 1));
                  await waitFor(correction.json().turnId, 'succeeded');
                } finally {
                  release();
                  onRead = undefined;
                  await pool.query("UPDATE tasks SET state='done',closed_at=now() WHERE id=$1", [
                    taskId,
                  ]);
                }
              },
            );

          await t.test(
            'Calendar authority cannot join old task words to a new revision',
            async () => {
              const taskId = randomUUID();
              const query = pool.query.bind(pool) as (...args: any[]) => Promise<any>;
              const progressId = randomUUID();
              let changed = false;
              let correction: any;
              const writes = writeCount();
              pool.query = (async (...input: any[]) => {
                const result = await query(...input);
                if (
                  !changed &&
                  typeof input[0] === 'string' &&
                  input[0].startsWith('WITH cleared AS') &&
                  input[1]?.[3] === taskId
                ) {
                  changed = true;
                  assert.ok(progressId);
                  correction = await request('POST', '/api/messages', {
                    text: 'Do not change the Calendar event.',
                    replyToMessageId: progressId,
                  });
                  assert.equal(correction.statusCode, 200, correction.body);
                }
                return result;
              }) as typeof pool.query;
              try {
                const task = await createCalendarTask(taskId, progressId);
                await waitFor(task.id, 'waiting|succeeded|failed');
                assert.equal(changed, true);
                assert.deepEqual(await approvalsFor(task.id), []);
                assert.equal(writeCount(), writes);
              } finally {
                pool.query = query as typeof pool.query;
                if (correction?.statusCode === 200)
                  await waitFor(correction.json().turnId, 'succeeded');
                await pool.query("UPDATE tasks SET state='done',closed_at=now() WHERE id=$1", [
                  taskId,
                ]);
              }
            },
          );

          for (const change of ['rules', 'account', 'Stop'])
            await t.test(`Calendar dispatch refuses ${change} during session startup`, async () => {
              const { turn: id, approval: card } = await submit();
              const writes = writeCount();
              const reads = readCount();
              const original = (
                await pool.query('SELECT rules FROM preferences WHERE owner_id=$1', [ownerId])
              ).rows[0].rules;
              let changed = false;
              calendarSession = async () => {
                if (changed || readCount() !== reads + 1) return;
                changed = true;
                if (change === 'rules')
                  await pool.query('UPDATE preferences SET rules=$2 WHERE owner_id=$1', [
                    ownerId,
                    'Do not change Calendar events.',
                  ]);
                else if (change === 'account')
                  await pool.query('UPDATE app_connections SET account_id=$2 WHERE id=$1', [
                    connectionId,
                    randomUUID(),
                  ]);
                else assert.equal((await request('POST', '/api/thread/stop', {})).statusCode, 200);
              };
              try {
                const accepted = await accept(card);
                assert.equal(accepted.statusCode, 200, accepted.body);
                await waitFor(accepted.json().turnId, 'waiting|succeeded|failed|cancelled');
                assert.equal(changed, true);
                assert.equal((await settledApproval(id)).status, 'expired');
                assert.equal(writeCount(), writes);
              } finally {
                calendarSession = undefined;
                await pool.query('UPDATE preferences SET rules=$2 WHERE owner_id=$1', [
                  ownerId,
                  original,
                ]);
                await pool.query('UPDATE app_connections SET account_id=$2 WHERE id=$1', [
                  connectionId,
                  accountId,
                ]);
              }
            });

          for (const field of [
            'target',
            'verifiedBinding',
            'verifiedCalendarRevision',
            'verifiedInstructionRevision',
          ])
            await t.test(`an old Calendar approval without ${field} cannot dispatch`, async () => {
              const writes = writeCount();
              const { turn: id, approval: card } = await submit();
              await pool.query('UPDATE approvals SET details=details-$2 WHERE id=$1', [
                card.id,
                field,
              ]);
              const reads = readCount();
              const accepted = await accept(card);
              assert.equal(accepted.statusCode, 200, accepted.body);
              await waitFor(accepted.json().turnId, 'waiting|succeeded|failed');
              assert.equal((await approvalsFor(id))[0].status, 'expired');
              assert.equal(readCount(), reads);
              assert.equal(writeCount(), writes);
            });

          await t.test('Calendar metadata refuses an account changed during the read', async () => {
            const original = (
              await pool.query('SELECT account_id FROM app_connections WHERE id=$1', [connectionId])
            ).rows[0].account_id;
            const writes = writeCount();
            onRead = async () => {
              await pool.query('UPDATE app_connections SET account_id=$2 WHERE id=$1', [
                connectionId,
                randomUUID(),
              ]);
            };
            try {
              const { turn: id, approval: card } = await submit();
              assert.equal(card, undefined);
              assert.match(await failure(id), /Calendar account changed/);
              assert.equal(writeCount(), writes);
            } finally {
              onRead = undefined;
              await pool.query('UPDATE app_connections SET account_id=$2 WHERE id=$1', [
                connectionId,
                original,
              ]);
            }
          });

          await t.test(
            'Calendar dispatch keeps the binding after its final metadata read',
            async () => {
              const writes = writeCount();
              const { turn: id, approval: card } = await submit();
              const original = (
                await pool.query('SELECT account_id FROM app_connections WHERE id=$1', [
                  connectionId,
                ])
              ).rows[0].account_id;
              const query = pool.query.bind(pool) as (...args: any[]) => Promise<any>;
              let swap = false;
              let swapped = false;
              onRead = async () => {
                swap = true;
              };
              pool.query = (async (...input: any[]) => {
                const result = await query(...input);
                if (
                  swap &&
                  typeof input[0] === 'string' &&
                  input[0].startsWith('INSERT INTO app_actions') &&
                  input[1]?.[2] === 'GOOGLECALENDAR_EVENTS_GET'
                ) {
                  swap = false;
                  swapped = true;
                  await query('UPDATE app_connections SET account_id=$2 WHERE id=$1', [
                    connectionId,
                    randomUUID(),
                  ]);
                }
                return result;
              }) as typeof pool.query;
              try {
                const accepted = await accept(card);
                assert.equal(accepted.statusCode, 200, accepted.body);
                await waitFor(accepted.json().turnId, 'waiting|succeeded|failed');
                assert.equal(swapped, true);
                assert.equal((await approvalsFor(id))[0].status, 'expired');
                assert.equal(writeCount(), writes);
              } finally {
                pool.query = query as typeof pool.query;
                onRead = undefined;
                await pool.query('UPDATE app_connections SET account_id=$2 WHERE id=$1', [
                  connectionId,
                  original,
                ]);
              }
            },
          );

          await t.test('Calendar approval obeys a read rule added after the question', async () => {
            const { turn: id, approval: card } = await submit();
            const rules = (
              await pool.query('SELECT rules FROM preferences WHERE owner_id=$1', [ownerId])
            ).rows[0].rules;
            const writes = writeCount();
            const reads = readCount();
            await pool.query('UPDATE preferences SET rules=$2 WHERE owner_id=$1', [
              ownerId,
              'Ask before reading Calendar.',
            ]);
            try {
              const accepted = await accept(card);
              assert.equal(accepted.statusCode, 200, accepted.body);
              await waitFor(accepted.json().turnId, 'waiting|succeeded|failed');
              assert.equal((await approvalsFor(id))[0].status, 'expired');
              assert.equal(readCount(), reads);
              assert.equal(writeCount(), writes);
            } finally {
              await pool.query('UPDATE preferences SET rules=$2 WHERE owner_id=$1', [
                ownerId,
                rules,
              ]);
            }
          });

          for (const stop of [false, true])
            await t.test(
              stop
                ? 'Stop refuses a late Calendar metadata result'
                : 'an owner correction during Calendar metadata cannot save the old question',
              async () => {
                let entered!: (signal?: AbortSignal) => void;
                const reading = new Promise<AbortSignal | undefined>((resolve) => {
                  entered = resolve;
                });
                let release!: () => void;
                const held = new Promise<void>((resolve) => {
                  release = resolve;
                });
                onRead = async (signal) => {
                  entered(signal);
                  await held;
                };
                const writes = writeCount();
                const pending = submit();
                const signal = await reading;
                try {
                  const response = stop
                    ? await request('POST', '/api/thread/stop', {})
                    : await request('POST', '/api/messages', {
                        text: 'Do not change the Calendar event.',
                      });
                  assert.equal(response.statusCode, 200, response.body);
                  if (stop) assert.equal(signal?.aborted, true);
                  release();
                  const { turn: id, approval: card } = await pending;
                  assert.equal(card, undefined);
                  if (!stop) await waitFor(response.json().turnId, 'succeeded');
                  await delay(30);
                  assert.deepEqual(await approvalsFor(id), []);
                  assert.equal(writeCount(), writes);
                } finally {
                  release();
                  onRead = undefined;
                  await pending.catch(() => {});
                }
              },
            );

          await t.test('an authorized Calendar change keeps its direct path', async () => {
            const text = `Accept the synthetic planning invitation ${randomUUID()}`;
            const reads = readCount();
            const writes = writeCount();
            asked.add(text);
            plans.set(text, { tool: 'apps', action: 'GOOGLECALENDAR_PATCH_EVENT', args });
            try {
              const response = await request('POST', '/api/messages', { text });
              assert.equal(response.statusCode, 200, response.body);
              await waitFor(response.json().turnId, 'succeeded');
              assert.deepEqual(await approvalsFor(response.json().turnId), []);
              assert.equal(readCount(), reads);
              assert.equal(writeCount(), writes + 1);
            } finally {
              asked.delete(text);
            }
          });
        } finally {
          if (turn) await decline(turn);
          if (connectionId)
            await request(
              'POST',
              `/api/apps/googlecalendar/accounts/${connectionId}/disconnect`,
              {},
            );
          calendarExecute = undefined;
        }
      });

      section = 2;
      await calendarRetry();
      await inPart(
        'shutdown cancels private entry before cleanup and saves final usage',
        async () => {
          await pool.query(`
          CREATE FUNCTION delay_closing_usage() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN PERFORM pg_sleep(1); RETURN NEW; END;
          $$;
          CREATE TRIGGER delay_closing_usage BEFORE INSERT ON model_usage
            FOR EACH ROW WHEN (NEW.id='${closingUsageId}') EXECUTE FUNCTION delay_closing_usage()`);
          const closeModels = models.close;
          let releaseModels!: () => void;
          let modelsClosing!: () => void;
          const modelCleanup = new Promise<void>((resolve) => {
            releaseModels = resolve;
          });
          const cleanupEntered = new Promise<void>((resolve) => {
            modelsClosing = resolve;
          });
          models.close = async () => {
            modelsClosing();
            await modelCleanup;
            await closeModels();
          };
          let releaseEntry!: () => void;
          let entryStarted = false;
          let entrySignal: AbortSignal | undefined;
          privateEntryWait = {
            entered(signal) {
              entryStarted = true;
              entrySignal = signal;
            },
            release: new Promise<void>((resolve) => {
              releaseEntry = resolve;
            }),
          };
          let closingApplication: Promise<void> | undefined;
          const before = injected.length;
          recordClosingUsage = true;
          try {
            const saved = await request('POST', '/api/vault', {
              origin: 'https://bank.example.test',
              label: 'Synthetic shutdown login',
              username: 'shutdown@example.test',
              password: 'Synthetic shutdown password',
            });
            assert.equal(saved.statusCode, 200, saved.body);
            const text = `Use the synthetic shutdown login ${randomUUID()}`;
            asked.add(text);
            plans.set(text, {
              tool: 'sign_in',
              action: 'Enter saved login',
              args: {
                origin: 'https://bank.example.test',
                label: 'Synthetic shutdown login',
                savedLoginId: saved.json().id,
                passwordSelector: '@password',
                submitSelector: '@submit',
                message: 'Use the synthetic login.',
              },
            });
            await taskTurn(text, undefined, { wait: false });
            for (let attempt = 0; !entryStarted && attempt < 300; attempt++) await delay(20);
            assert.equal(entryStarted, true);
            assert.ok(entrySignal);
            assert.equal(entrySignal.aborted, false);
            closingApplication = application.app.close();
            await cleanupEntered;
            assert.equal(entrySignal.aborted, true);
            releaseEntry();
            releaseModels();
            await closingApplication;
            assert.equal(injected.length, before);
            assert.deepEqual(
              (await pool.query('SELECT cost_usd FROM model_usage WHERE id=$1', [closingUsageId]))
                .rows,
              [{ cost_usd: 0.125 }],
            );
          } finally {
            releaseEntry();
            releaseModels();
            await closingApplication;
            models.close = closeModels;
            privateEntryWait = undefined;
            recordClosingUsage = false;
            await pool.query('DROP FUNCTION delay_closing_usage() CASCADE');
          }
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
