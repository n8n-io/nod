import {
  startupErrorFacts,
  startupStatusFacts,
  startupEventFacts,
  startupLogFacts,
  startupFailureMessage,
  startupReceiptFacts,
  StartupFeedbackError,
} from '../src/shared/startup-feedback-facts.mjs';
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import Fastify from 'fastify';
import type { AccountStore } from '../src/server/account-store.ts';
import type { AccountSettings } from '../src/shared/account.ts';
import { createAccountSession } from '../src/server/account.ts';
import { registerLocalAccess } from '../src/server/access.ts';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import { createKeychainKeyStore } from '../src/providers/keychain/key-store.ts';
import { createFilesystemKeyStore } from '../src/providers/filesystem/key-store.ts';
import { openCredential, sealCredential } from '../src/server/vault.ts';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProductAnalytics } from '../src/ports/analytics.ts';
import { createAnalytics, type Analytics, type CaptureAnalytics } from '../src/server/analytics.ts';
import { createLedger } from '../src/server/ledger.ts';
import {
  createDecisionModel,
  createOpenRouterDecisionCatalog,
  type DecisionConnection,
} from '../src/providers/decisions.ts';
import { createMailCheck } from '../src/server/mail-check.ts';
import { privateEmailResult } from '../src/server/integration-result.ts';
import { withFailureLog } from '../src/ports/failure-log.ts';
import type { DecisionQuestion } from '../src/ports/decisions.ts';
import { createModelTraces } from '../src/server/traces.ts';
import type { ModelTrace } from '../src/ports/traces.ts';
import type { ProviderUsageEvent } from '../src/ports/provider-usage.ts';
import { setRequestAccount } from '../src/web/lib/api.ts';
import { createOtlpTelemetry } from '../src/providers/otlp/telemetry.ts';
import { trustBasis, trustDecision } from '../src/server/trust-basis.ts';
import { createTrust } from '../src/server/trust.ts';
import { createTrustReview } from '../src/server/trust-review.ts';
import { trustFacts } from '../src/server/trust-facts.ts';
import {
  createErrorRedactor,
  environmentSecrets,
  createRedactor,
  createTextRedactor,
  redactSecretText,
} from '../src/server/redaction.ts';

test('decision failures retain bounded HTTP and response details', async (t) => {
  const question: DecisionQuestion = {
    name: 'access',
    choices: [
      { value: false, description: 'Ordinary mail.' },
      { value: true, description: 'Access secret.' },
    ],
  };
  const canary = 'synthetic-private-value@example.test/private-response';
  for (const provider of ['openrouter', 'typesafe'] as const)
    for (const status of [401, 403, 429, 503])
      await t.test(`${provider} HTTP ${status}`, async () => {
        const usage: ProviderUsageEvent[] = [];
        let calls = 0;
        let cancelled = false;
        const model = createDecisionModel({
          resolve: async () => ({ provider, key: canary }),
          fetch: async () => {
            calls++;
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode(canary));
                },
                cancel() {
                  cancelled = true;
                  return new Promise(() => {});
                },
              }),
              { status, statusText: canary },
            );
          },
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await assert.rejects(
            Promise.race([
              model.check(
                { instructions: 'Check synthetic mail.', input: {}, question },
                undefined,
                (event) => usage.push(event),
              ),
              new Promise((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error('The HTTP failure waited for its body.')),
                  500,
                );
              }),
            ]),
            (error: Error & { code?: string; status?: number }) => {
              assert.equal(error.code, 'decision_http');
              assert.equal(error.status, status);
              assert.equal(error.cause, undefined);
              assert.ok(!error.message.includes(canary));
              return true;
            },
          );
        } finally {
          clearTimeout(timer);
        }
        assert.equal(calls, 1);
        assert.equal(cancelled, true);
        assert.equal(usage.length, 1);
        assert.equal(usage[0].status, 'failed');
      });
  const cases = [
    [
      'transport',
      'decision_transport',
      () => {
        throw Object.assign(new Error(canary), { cause: canary, code: canary });
      },
    ],
    [
      'response body',
      'decision_response',
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(canary));
            },
          }),
          { status: 200 },
        ),
    ],
    ['JSON', 'decision_json', () => new Response(`{"private":"${canary}"`, { status: 200 })],
    [
      'missing answer',
      'decision_validation',
      () => Response.json({ answers: {}, usage: { input_tokens: 1 } }),
    ],
    [
      'unknown choice',
      'decision_validation',
      () =>
        Response.json({
          answers: { access: { type: 'choice', choice: canary } },
          usage: { input_tokens: 1 },
        }),
    ],
    [
      'invalid probabilities',
      'decision_validation',
      () =>
        Response.json({
          answers: {
            access: { type: 'choice', choice: 'false', probabilities: { false: -1, true: 2 } },
          },
          usage: { input_tokens: 1 },
        }),
    ],
    [
      'invalid usage',
      'decision_validation',
      () =>
        Response.json({
          answers: { access: { type: 'choice', choice: false } },
          usage: { input_tokens: -1 },
        }),
    ],
  ] as const;
  for (const [name, code, response] of cases)
    await t.test(name, async () => {
      const model = createDecisionModel({
        resolve: async () => ({ provider: 'openrouter', key: canary }),
        fetch: async () => response(),
      });
      await assert.rejects(
        model.check({
          instructions: 'Check synthetic mail.',
          input: {},
          question: { ...question, minProbability: 0.99 },
        }),
        (error: Error & { code?: string; status?: number; issues?: unknown }) => {
          assert.equal(error.code, code);
          assert.equal(error.status, code === 'decision_transport' ? undefined : 200);
          assert.equal(error.cause, undefined);
          assert.equal(error.issues, undefined);
          assert.ok(
            !JSON.stringify(
              Object.getOwnPropertyNames(error).map(
                (key) => (error as unknown as Record<string, unknown>)[key],
              ),
            ).includes(canary),
          );
          return true;
        },
      );
    });
  const valid = createDecisionModel({
    resolve: async () => ({ provider: 'openrouter', key: canary }),
    fetch: async () =>
      Response.json({
        answers: {
          access: { type: 'choice', choice: 'false', probabilities: { false: 0.999, true: 0.001 } },
        },
        usage: { input_tokens: 1 },
      }),
  });
  const accepted = await valid.check({
    instructions: 'Check synthetic mail.',
    input: {},
    question: { ...question, minProbability: 0.99 },
  });
  assert.equal(Object(accepted).access, false);
});

test('mail withholding and failure logs expose only known phases and valid HTTP statuses', async () => {
  const canary = 'synthetic-private-body-and-provider-value';
  const failures: Array<Record<string, unknown>> = [];
  const checks = [
    ['decision_http', 503, 'request failed (HTTP 503)'],
    ['decision_response', 200, 'response could not be read (HTTP 200)'],
    ['decision_json', 200, 'returned invalid JSON (HTTP 200)'],
    ['decision_validation', 200, 'returned an invalid response (HTTP 200)'],
    ['decision_transport', undefined, 'connection failed'],
    [canary, 429, 'request failed (HTTP 429)'],
    ...[NaN, Infinity, 99, 600, 200.5, '503'].map((status) => [canary, status, 'request failed']),
  ];
  for (const [code, status, expected] of checks) {
    let requests = 0;
    const check = createMailCheck({
      curator: {
        id: 'unused',
        configured: false,
        async curate() {
          assert.fail('No fallback is allowed.');
        },
      },
      decisions: {
        async check() {
          requests++;
          throw Object.assign(new Error(canary), { code, status, cause: canary, issues: [canary] });
        },
      },
    });
    const result = await withFailureLog(
      (event, error) => {
        const value = error as Error & { code?: unknown; status?: unknown; issues?: unknown };
        assert.equal(value.cause, undefined);
        assert.equal(value.issues, undefined);
        failures.push({
          event,
          name: value.name,
          message: value.message,
          code: value.code,
          status: value.status,
        });
      },
      () =>
        privateEmailResult(
          {
            messages: [
              { id: 'synthetic-mail', from: 'sender@example.test', subject: canary, body: canary },
            ],
          },
          check,
        ),
    );
    const encoded = JSON.stringify(result);
    assert.ok(encoded.includes(String(expected)), encoded);
    assert.ok(!encoded.includes(canary));
    assert.equal(requests, 1);
  }
  assert.equal(failures.length, checks.length);
  assert.ok(!JSON.stringify(failures).includes(canary));
  assert.deepEqual(
    failures.map((failure) => failure.status),
    [503, 200, 200, 200, undefined, 429, ...Array(6).fill(undefined)],
  );
  assert.ok(failures.every((failure) => failure.event === 'mail_check_failed'));
});

test('mail checks retain the native curator HTTP status without provider content', async (t) => {
  const { createServer } = await import('node:http');
  const { createPiMemoryCurator } = await import('../src/providers/pi/memory-curator.ts');
  const canary = 'synthetic-private-provider-body';
  let calls = 0;
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(body.model, 'fixture-mail-check');
    assert.equal(body.response_format, undefined);
    calls++;
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: canary } }));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const curator = createPiMemoryCurator({
    provider: 'compatible',
    configured: () => true,
    resolve: async () => ({
      provider: 'compatible',
      method: 'api_key',
      effort: 'off',
      definition: {
        choice: {
          id: 'fixture-mail-check',
          name: 'Synthetic mail',
          images: false,
          efforts: ['off'],
          contextWindow: 128000,
        },
        spec: {
          id: 'fixture-mail-check',
          name: 'Synthetic mail',
          provider: 'compatible',
          api: 'openai-completions',
          baseUrl,
          reasoning: false,
          input: ['text'],
          contextWindow: 128000,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      },
      read: async () => ({ type: 'endpoint', url: baseUrl, key: 'fixture-native-mail-key' }),
    }),
  });
  const failures: unknown[] = [];
  const result = await withFailureLog(
    (event, error) => failures.push({ event, ...Object(error) }),
    () =>
      privateEmailResult(
        { from: 'sender@example.test', subject: canary, body: canary },
        createMailCheck({ curator }),
      ),
  );
  assert.equal(calls, 1);
  assert.match(JSON.stringify(result), /HTTP 403/);
  assert.ok(!JSON.stringify(result).includes(canary));
  assert.deepEqual(failures, [
    { event: 'mail_check_failed', code: 'mail_check_request', status: 403 },
  ]);
});

test('invalid decision settings fail before reserving a budget or sending a request', async () => {
  let reservations = 0;
  let requests = 0;
  const usage: ProviderUsageEvent[] = [];
  const model = createDecisionModel({
    resolve: async () => ({ provider: 'openai', key: 'fixture-key', region: 'invalid' as never }),
    reserve: async () => {
      reservations++;
      return async () => {};
    },
    fetch: async () => {
      requests++;
      assert.fail('An invalid connection must not send a request.');
    },
  });
  await assert.rejects(
    model.check(
      {
        instructions: 'Check synthetic mail.',
        input: {},
        question: { name: 'access', choices: [{ value: false, description: 'Ordinary mail.' }] },
      },
      undefined,
      (event) => usage.push(event),
    ),
    /Choose an OpenAI API region/,
  );
  assert.equal(reservations, 0);
  assert.equal(requests, 0);
  assert.equal(usage.length, 0);
});

test('decision reservations release only requests that did not reach dispatch', async () => {
  for (const phase of ['before dispatch', 'provider error', 'transport error']) {
    const controller = new AbortController();
    const settled: Array<number | null> = [];
    const usage: ProviderUsageEvent[] = [];
    let calls = 0;
    const model = createDecisionModel({
      resolve: async () => ({ provider: 'openai', key: 'synthetic-decision-key' }),
      reserve: async () => {
        if (phase === 'before dispatch') controller.abort();
        return async (cost) => {
          settled.push(cost);
        };
      },
      fetch: async () => {
        calls++;
        if (phase === 'transport error')
          throw new Error('Synthetic connection lost after dispatch.');
        return new Response('', { status: 503 });
      },
    });
    await assert.rejects(
      model.check(
        {
          instructions: 'Check synthetic access.',
          input: {},
          question: {
            name: 'access',
            choices: [
              { value: false, description: 'Ordinary mail.' },
              { value: true, description: 'Access secret.' },
            ],
          },
        },
        controller.signal,
        (event) => usage.push(event),
      ),
    );
    assert.equal(calls, phase === 'before dispatch' ? 0 : 1);
    assert.deepEqual(settled, [phase === 'before dispatch' ? 0 : null]);
    assert.equal(usage[0]?.costUsd, phase === 'before dispatch' ? 0 : null);
  }
});

test('decision selection uses the LLM only when no decision connection is available', async () => {
  let resolutions = 0;
  let llm = 0;
  let state = 'absent';
  const decisions = createDecisionModel({
    resolve: async () => {
      resolutions++;
      if (state === 'absent') return undefined;
      if (state === 'lookup error') throw new Error('Synthetic lookup failure.');
      return { provider: 'openai', key: 'fixture-key' };
    },
    fetch: async () => {
      if (state === 'request error') return new Response('', { status: 503 });
      return Response.json({
        answers: [
          {
            name: 'answer',
            type: 'choice',
            choice: 'yes',
            probabilities: [
              { value: 'yes', probability: 1 },
              { value: 'other', probability: 0 },
            ],
          },
        ],
        usage: { input_tokens: 1 },
      });
    },
  });
  const question: DecisionQuestion = {
    name: 'answer',
    minProbability: 0.99,
    choices: [
      { value: 'yes', description: 'Approve.' },
      { value: 'other', description: 'No approval.' },
    ],
  };
  const review = createTrustReview({
    decisions,
    review: async (instructions, input, signal, selected) => {
      llm++;
      assert.equal(instructions, 'Apply policy.');
      assert.deepEqual(input, { reply: 'Yes.' });
      assert.equal(signal, undefined);
      assert.deepEqual(selected, { name: question.name, choices: question.choices });
      return { answer: 'yes' };
    },
  });
  const check = (signal?: AbortSignal) =>
    review('Apply policy.', { reply: 'Yes.' }, signal, question);
  assert.deepEqual(await check(), { answer: 'yes' });
  assert.equal(llm, 1);
  state = 'available';
  const selected = await decisions.select!();
  const count = resolutions;
  state = 'lookup error';
  assert.equal(
    ((await selected!.check({ instructions: '', input: {}, question })) as { answer: string })
      .answer,
    'yes',
  );
  assert.equal(resolutions, count);
  await assert.rejects(check(), /lookup failure/);
  state = 'request error';
  await assert.rejects(check());
  await assert.rejects(check(AbortSignal.abort()));
  assert.equal(llm, 1);
});

test('OpenAI decision failures keep the region and provider reason without exposing the key', async () => {
  const key = 'fixture-decision-"key';
  let calls = 0;
  const decisions = createDecisionModel({
    resolve: async () => ({ provider: 'openai', key, region: 'eu' }),
    fetch: async (input, init) => {
      calls++;
      assert.equal(String(input), 'https://eu.api.openai.com/v1/decisions');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`);
      return Response.json(
        { error: { message: `Synthetic project geography EU error ${key}` } },
        { status: 401 },
      );
    },
  });
  await assert.rejects(
    decisions.check({
      instructions: 'Apply the synthetic rule.',
      input: {},
      question: { name: 'answer', choices: [{ value: false, description: 'Ask.' }] },
    }),
    (error: Error & { status?: number; code?: string }) => {
      assert.equal(error.status, 401);
      assert.equal(error.code, 'decision_http');
      assert.match(error.message, /401/);
      assert.match(error.message, /project geography EU/);
      assert.ok(!error.message.includes(key));
      assert.ok(!error.message.includes(JSON.stringify(key).slice(1, -1)));
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('About accepts multiple choices and records only confirmed sharing', async (t) => {
  const { JSDOM } = await import('jsdom');
  const { act, createElement } = await import('react');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://nod.example.test/onboarding',
  });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: true }) });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  let root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, value] of originals)
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
  });
  const { About } = await import('../src/web/pages/onboarding/steps/about.tsx');
  const { readStored } = await import('../src/web/pages/onboarding/storage.ts');
  const { profileScopes, profileRoles, profileWhoFor, profileCompanySizes, profileJobs } =
    await import('../src/shared/onboarding.ts');
  let status = 200;
  let shared = true;
  const submissions: { roles: string[]; jobs: string[] }[] = [];
  t.mock.method(globalThis, 'fetch', async (path: RequestInfo | URL, options?: RequestInit) => {
    assert.equal(String(path), '/api/onboarding/profile');
    submissions.push(JSON.parse(String(options?.body)));
    return Response.json(
      status === 200 ? { ok: true, shared } : { error: 'Could not share your choices.' },
      { status },
    );
  });
  let completed = 0;
  await act(async () =>
    root.render(
      createElement(About, {
        arrived: 'forward',
        quiet: true,
        onNext: () => completed++,
        onBack() {},
        usageShared: true,
      }),
    ),
  );
  const clickChoice = async (options: readonly { id: string }[], id: string) => {
    const index = options.findIndex((option) => option.id === id);
    assert.notEqual(index, -1);
    const button = dom.window.document.querySelectorAll<HTMLButtonElement>(
      '.ob-chips .ob-chip[aria-pressed]',
    )[index];
    assert.ok(button, id);
    await act(async () => button.click());
  };
  const primary = async () => {
    const button = dom.window.document.querySelector<HTMLButtonElement>('.ob-next');
    assert.ok(button);
    await act(async () => button.click());
  };
  const remount = async () => {
    await act(async () => root.unmount());
    root = createRoot(dom.window.document.getElementById('root')!);
    await act(async () =>
      root.render(
        createElement(About, {
          arrived: 'back',
          quiet: true,
          onNext: () => completed++,
          onBack() {},
          usageShared: true,
        }),
      ),
    );
  };
  const workRoles = profileRoles.filter((option) => !('personal' in option));
  await clickChoice(profileScopes, 'work');
  await clickChoice(workRoles, 'agency');
  await clickChoice(workRoles, 'engineering');
  await primary();
  await clickChoice(profileWhoFor, 'clients');
  await clickChoice(profileCompanySizes, '2_10');
  await clickChoice(profileJobs, 'email');
  await clickChoice(profileJobs, 'meetings');
  await primary();
  assert.deepEqual(submissions[0]?.roles, ['agency', 'engineering']);
  assert.deepEqual(submissions[0]?.jobs, ['email', 'meetings']);
  assert.equal(submissions.length, 1);
  assert.equal(completed, 1);
  const sharedChoices = {
    onboarding_profile_completed: true,
    onboarding_scope: 'work',
    onboarding_roles: ['agency', 'engineering'],
    onboarding_who_for: 'clients',
    onboarding_company_size: '2_10',
    onboarding_jobs: ['email', 'meetings'],
  };
  assert.deepEqual(readStored('about-shared'), sharedChoices);
  assert.equal(readStored<{ current: string }>('about')?.current, 'done');
  await remount();
  await primary();
  assert.equal(completed, 2);
  assert.equal(submissions.length, 2);
  assert.deepEqual(readStored('about-shared'), sharedChoices);
  shared = false;
  await primary();
  assert.equal(readStored('about-shared'), null);
  assert.equal(completed, 3);
  status = 502;
  await primary();
  assert.equal(readStored('about-shared'), null);
  const retry = dom.window.document.querySelector<HTMLButtonElement>(
    '.ob-footer-end button:not(.ob-next)',
  );
  assert.ok(retry);
  await act(async () => retry.click());
  assert.equal(completed, 3);
  assert.equal(submissions.length, 5);
  await primary();
  assert.equal(readStored('about-shared'), null);
  assert.equal(completed, 4);
  assert.equal(submissions.length, 5);
  assert.equal(readStored<{ current: string }>('about')?.current, 'done');
  status = 200;
  shared = true;
  await remount();
  await primary();
  assert.equal(completed, 5);
  assert.equal(submissions.length, 5);
  assert.equal(readStored('about-shared'), null);
});

test('Join sends fixed answers only with a matching confirmed share', async (t) => {
  const { JSDOM } = await import('jsdom');
  const { act, createElement } = await import('react');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://nod.example.test/onboarding',
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, value] of originals)
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
  });
  const { Join } = await import('../src/web/pages/onboarding/steps/join.tsx');
  const { writeStored } = await import('../src/web/pages/onboarding/storage.ts');
  const profile = {
    scope: 'work',
    roles: ['engineering'],
    roleText: 'Private synthetic role',
    companySize: '11_100',
    jobs: ['research'],
    jobsText: 'Private synthetic task',
  };
  writeStored('about', { current: 'done', profile });
  const fixed = {
    onboarding_profile_completed: true,
    onboarding_scope: 'work',
    onboarding_roles: ['engineering', 'other'],
    onboarding_who_for: 'not_asked',
    onboarding_company_size: '11_100',
    onboarding_jobs: ['research', 'other'],
  };
  const posted: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (path: RequestInfo | URL, options?: RequestInit) => {
    assert.equal(String(path), '/api/onboarding/updates-email');
    assert.equal(options?.method, 'POST');
    posted.push(JSON.parse(String(options?.body)));
    return Response.json({ ok: true });
  });
  let completed = 0;
  const render = (usageShared: boolean) =>
    act(async () =>
      root.render(
        createElement(Join, {
          arrived: 'forward',
          onNext: () => completed++,
          onBack() {},
          updatesEmail: true,
          usageShared,
        }),
      ),
    );
  await render(false);
  assert.equal(dom.window.document.querySelector('#ob-join-email'), null);
  await render(true);
  const email = dom.window.document.querySelector<HTMLInputElement>('#ob-join-email');
  const consent = dom.window.document.querySelector<HTMLInputElement>('.ob-join-consent input');
  const next = dom.window.document.querySelector<HTMLButtonElement>('.ob-next');
  assert.ok(email);
  assert.ok(consent);
  assert.ok(next);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
      email,
      'owner@example.test',
    );
    email.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await act(async () => next.click());
  assert.deepEqual(posted, []);
  assert.equal(completed, 0);
  await act(async () => consent.click());
  await act(async () => next.click());
  assert.deepEqual(posted[0], { email: 'owner@example.test', consent: true });
  writeStored('about-shared', fixed);
  await act(async () => next.click());
  assert.deepEqual(posted[1], { email: 'owner@example.test', consent: true, profile: fixed });
  assert.equal(JSON.stringify(posted).includes('Private synthetic'), false);
  assert.equal(completed, 2);
  writeStored('about', { current: 'roles', profile });
  await act(async () => next.click());
  assert.deepEqual(posted[2], { email: 'owner@example.test', consent: true });
  writeStored('about', { current: 'done', profile: { ...profile, jobs: ['email'] } });
  await act(async () => next.click());
  assert.deepEqual(posted[3], { email: 'owner@example.test', consent: true });
  assert.equal(completed, 4);
});

test('decision catalog filters native text decisions, expires and refuses failed lookups', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  let calls = 0;
  let fail = false;
  let malformed = false;
  t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    assert.equal(init?.redirect, 'error');
    if (fail) return new Response('', { status: 503 });
    if (malformed) return Response.json({ data: null });
    return Response.json({
      data: [
        {
          id: 'typesafe/jev-1.14',
          architecture: { input_modalities: ['text'], output_modalities: ['decisions'] },
          endpoints: ['/api/alpha/decisions'],
        },
        {
          id: 'typesafe/jev-router',
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          endpoints: ['/api/v1/chat/completions'],
        },
        {
          id: 'fixture/extraction',
          architecture: { input_modalities: ['text'], output_modalities: ['decisions'] },
          endpoints: ['/api/alpha/extractions'],
        },
        {
          id: 'fixture/image',
          architecture: { input_modalities: ['image'], output_modalities: ['decisions'] },
          endpoints: ['/api/alpha/decisions'],
        },
      ],
    });
  });
  const catalog = createOpenRouterDecisionCatalog();
  assert.deepEqual([...(await catalog('fixture-key'))], ['typesafe/jev-1.14']);
  await catalog('fixture-key');
  assert.equal(calls, 1);
  t.mock.timers.tick(300_000);
  fail = true;
  await assert.rejects(catalog('fixture-key'));
  assert.equal(calls, 2);
  fail = false;
  await catalog('fixture-key');
  await catalog('fixture-rotated-key');
  assert.equal(calls, 4);
  malformed = true;
  await assert.rejects(catalog('fixture-invalid-key'));
  await assert.rejects(catalog('fixture-rotated-key', AbortSignal.abort()));
  assert.equal(calls, 5);
});

test('decision trust never calls an LLM for uncertainty, missing results or failure', async () => {
  let calls = 0;
  let choice = 'message:0';
  let probability = 0.995;
  let fail = false;
  const decisions = createDecisionModel({
    resolve: async () => ({ provider: 'openrouter', key: 'synthetic-decision-key' }),
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      if (fail) return new Response('', { status: 503 });
      return Response.json({
        answers: {
          ...Object.fromEntries(
            Object.keys(request.questions)
              .filter((name) => !['trust', 'preparation', 'permission'].includes(name))
              .map((name) => [
                name,
                {
                  type: 'choice',
                  choice: String(name === 'scope'),
                  probabilities: {
                    true: Number(name === 'scope'),
                    false: Number(name !== 'scope'),
                  },
                },
              ]),
          ),
          trust: {
            type: 'choice',
            choice,
            probabilities: {
              'message:0': choice === 'message:0' ? probability : 1 - probability,
              read: 0,
              ask: choice === 'ask' ? probability : 1 - probability,
            },
          },
          preparation: { type: 'choice', choice: 'false', probabilities: { true: 0, false: 1 } },
          permission: {
            type: 'choice',
            choice: choice === 'ask' ? 'false' : 'true',
            probabilities: {
              true: choice === 'ask' ? 1 - probability : probability,
              false: choice === 'ask' ? probability : 1 - probability,
            },
          },
        },
        usage: { input_tokens: 10, cost: 0.000001 },
      });
    },
  });
  const words = { userMessages: [{ at: '2026-11-03T09:00:00Z', text: 'Send the report to Ana.' }] };
  const input = {
    ...words,
    action: { name: 'send_email', arguments: { recipient: 'ana@example.test' } },
  };
  const instructions = 'Apply the unchanged permission policy.';
  const review = createTrustReview({
    decisions,
    review: async () => {
      calls++;
      assert.fail('Decision checks must not call an LLM.');
    },
  });
  assert.equal(
    trustBasis(await review(instructions, input), withOwnerIds(words, ['message']))?.kind,
    'message',
  );
  assert.equal(calls, 0);
  probability = 0.8;
  assert.equal(
    trustBasis(await review(instructions, input), withOwnerIds(words, ['message'])),
    undefined,
  );
  assert.equal(calls, 0);
  choice = 'ask';
  probability = 0.995;
  assert.equal(
    trustBasis(await review(instructions, input), withOwnerIds(words, ['message'])),
    undefined,
  );
  assert.equal(calls, 0);
  fail = true;
  await assert.rejects(review(instructions, input));
  assert.equal(calls, 0);
  const unavailable = createTrustReview({
    decisions: {
      configured: false,
      check: async () => assert.fail('Do not send an unavailable request.'),
    },
    review: async () => assert.fail('Missing configuration must not start an LLM request.'),
  });
  assert.equal(await unavailable(instructions, input), undefined);
  for (const output of [
    undefined,
    {},
    {
      trust: 'message:0',
      probability: 1,
      additional: { permission: { permission: true, probability: 1 } },
    },
  ]) {
    const missing = createTrustReview({
      decisions: { check: async () => output },
      review: async () => assert.fail('Missing results must not select another model.'),
    });
    assert.equal(await missing(instructions, input), undefined);
  }
  const unscored = createTrustReview({
    decisions: { check: async () => ({ answer: 'yes' }) },
    review: async () => assert.fail('An answer without confidence must not start another model.'),
  });
  assert.equal(
    await unscored(instructions, input, undefined, {
      name: 'answer',
      minProbability: 0.99,
      choices: [
        { value: 'yes', description: 'Approve.' },
        { value: 'other', description: 'No approval.' },
      ],
    }),
    undefined,
  );
  await assert.rejects(review(instructions, input, AbortSignal.abort()));
  assert.equal(calls, 0);
});

test('uncertain effects cannot authorize a change through confident permission', async () => {
  const input = { userMessages: [{ at: '2026-11-03T09:00:00Z', text: 'Update my meeting.' }] };
  const decisions = {
    check: async () => ({
      trust: 'message:0',
      probability: 0.93,
      additional: {
        preparation: { preparation: false, choice: false, probability: 0.96 },
        permission: { permission: true, choice: true, probability: 0.99 },
      },
    }),
  };
  let calls = 0;
  const review = async (instructions: string, data: object) => {
    calls++;
    assert.equal(instructions, 'Original policy');
    assert.equal(data, input);
    return { run: false };
  };
  assert.equal(
    trustBasis(
      await createTrustReview({ decisions, review })('Original policy', input),
      withOwnerIds(input, ['message']),
    ),
    undefined,
  );
  assert.equal(calls, 0);
});

test('batched trust validates all answers, records one request, and refuses conflicts', async (t) => {
  for (const provider of ['openai', 'typesafe', 'openrouter'] as const)
    await t.test(provider, async () => {
      let primary = 0.8;
      let conflict = false;
      let missing = false;
      let duplicate = false;
      const usage: ProviderUsageEvent[] = [];
      const words = {
        userMessages: [{ at: '2026-11-03T09:00:00Z', text: 'Read my project list.' }],
      };
      const model = createDecisionModel({
        resolve: async () => ({ provider, key: 'synthetic-batch-key' }),
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          const questions = provider === 'openai' ? body.questions : Object.values(body.questions);
          assert.equal(questions.length, 11);
          assert.doesNotMatch(questions[0].instructions, /Complete permission policy/);
          assert.match(questions[2].instructions, /Complete permission policy/);
          assert.doesNotMatch(questions[1].instructions, /Complete permission policy/);
          const answers = [
            {
              name: 'trust',
              type: 'choice',
              choice: 'message:0',
              probabilities: { 'message:0': primary, ask: 1 - primary, read: 0 },
            },
            {
              name: duplicate ? 'trust' : 'preparation',
              type: 'choice',
              choice: provider === 'openai' ? true : 'true',
              probabilities: { true: 1, false: 0 },
            },
            {
              name: 'permission',
              type: 'choice',
              choice: provider === 'openai' ? !conflict : String(!conflict),
              probabilities: { true: conflict ? 0 : 1, false: conflict ? 1 : 0 },
            },
            ...[
              'scope',
              'constraints',
              'time',
              'numbers',
              'conditions',
              'targets',
              'bans',
              'costs',
            ].map((name) => ({
              name,
              type: 'choice',
              choice: provider === 'openai' ? false : 'false',
              probabilities: { true: 0, false: 1 },
            })),
          ].slice(0, missing ? 1 : 11);
          return Response.json({
            answers:
              provider === 'openai'
                ? answers.map(({ probabilities, ...answer }) => ({
                    ...answer,
                    probabilities: Object.entries(probabilities).map(([value, probability]) => ({
                      value: value === 'true' ? true : value === 'false' ? false : value,
                      probability,
                    })),
                  }))
                : Object.fromEntries(answers.map(({ name, ...answer }) => [name, answer])),
            usage: { input_tokens: 100, cost: 0.00001 },
          });
        },
      });
      const decisions = {
        check: (request: Parameters<typeof model.check>[0], signal?: AbortSignal) =>
          model.check(request, signal, (event) => usage.push(event)),
      };
      const review = createTrustReview({
        decisions,
        review: async () => assert.fail('A proven read needs no LLM.'),
      });
      const input = { ...words, action: { name: 'list_projects', arguments: {} } };
      assert.equal(
        trustBasis(
          await review('Complete permission policy', input),
          withOwnerIds(words, ['message']),
        )?.kind,
        'read',
      );
      assert.equal(usage.length, 1);
      assert.equal(usage[0]?.costUsd, 0.00001);
      primary = 0.995;
      conflict = true;
      assert.equal(
        trustBasis(
          await review('Complete permission policy', input),
          withOwnerIds(words, ['message']),
        ),
        undefined,
      );
      assert.equal(usage.length, 2);
      missing = true;
      await assert.rejects(review('Complete permission policy', input));
      assert.equal(usage.at(-1)?.status, 'failed');
      assert.equal(usage.length, 3);
      missing = false;
      duplicate = true;
      await assert.rejects(review('Complete permission policy', input));
      assert.equal(usage.at(-1)?.status, 'failed');
      assert.equal(usage.length, 4);
    });
});

test('pure decision checks bind the evaluated model, preserve target checks and never call an LLM', async () => {
  const input = {
    userMessages: [{ at: '2026-11-03T09:00:00Z', text: 'Send the report to Ana.' }],
    action: { name: 'send_email', arguments: { recipient: 'ana@example.test' } },
  };
  let served: string | undefined = 'perplexity/pplx-decider-v1.2-20261016';
  let omit = '';
  let probabilities: Record<string, number> = {};
  let source = 'message:0';
  const events: ProviderUsageEvent[] = [];
  const model = createDecisionModel({
    resolve: async () => ({
      provider: 'openrouter',
      key: 'synthetic-key',
      model: 'perplexity/pplx-decider-v1.2',
    }),
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      assert.equal(Object.keys(request.questions).length, 11);
      assert.deepEqual(request.state.action, input.action);
      assert.deepEqual(request.state.userMessages, input.userMessages);
      assert.equal(request.provider.allow_fallbacks, false);
      const answers: Record<string, object> = {
        trust: {
          type: 'choice',
          choice: source,
          probabilities: Object.fromEntries(
            Object.keys(request.questions.trust.criteria).map((key) => [
              key,
              key === source ? 1 : 0,
            ]),
          ),
        },
      };
      for (const name of Object.keys(request.questions).slice(1)) {
        const p = probabilities[name] ?? (['permission', 'scope'].includes(name) ? 0.995 : 0.005);
        answers[name] = {
          type: 'choice',
          choice: String(p >= 0.5),
          probabilities: { true: p, false: 1 - p },
        };
      }
      delete answers[omit];
      return Response.json({
        model: served,
        answers,
        usage: { input_tokens: 100, cost: 0.000002 },
      });
    },
  });
  const review = createTrustReview({
    decisions: {
      check: (request, signal) => model.check(request, signal, (event) => events.push(event)),
    },
    review: async () => assert.fail('Pure decision mode must never call an LLM.'),
  });
  const allowed = () =>
    review('Apply the permission policy.', input).then((answer) =>
      trustBasis(answer, withOwnerIds(input, ['message'])),
    );
  assert.equal((await allowed())?.kind, 'message');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.costUsd, 0.000002);
  for (const veto of ['targets', 'time', 'numbers', 'conditions', 'constraints', 'bans', 'costs']) {
    probabilities = { [veto]: 0.99 };
    assert.equal(await allowed(), undefined);
  }
  probabilities = { scope: 0.01 };
  assert.equal(await allowed(), undefined);
  probabilities = { permission: 0.995, preparation: 0.995, scope: 0.97, bans: 0.2 };
  source = 'read';
  assert.equal((await allowed())?.kind, 'read');
  input.action.name = 'NOD_sign_in';
  assert.equal(await allowed(), undefined);
  input.action.name = 'send_email';
  source = 'message:0';
  probabilities = { permission: 0.995, scope: 0.995 };
  assert.equal((await allowed())?.kind, 'message');
  probabilities = { permission: 0.93 };
  assert.equal(await allowed(), undefined);
  Object.assign(input, { standingInstruction: 'Set the monthly limit to EUR 100.' });
  source = 'standing';
  probabilities = { preparation: 0.99 };
  input.action.name = 'NOD_limits_update';
  assert.equal(await allowed(), undefined);
  source = 'message:0';
  input.action.name = 'send_email';
  probabilities = {};
  served = 'perplexity/pplx-decider-v1.3';
  assert.equal(await allowed(), undefined);
  served = undefined;
  assert.equal(await allowed(), undefined);
  served = 'perplexity/pplx-decider-v1.2-20261016';
  omit = 'targets';
  await assert.rejects(allowed());
  assert.equal(events.at(-1)?.status, 'failed');
  assert.equal(events.at(-1)?.costUsd, 0.000002);
  await assert.rejects(review('Apply the permission policy.', input, AbortSignal.abort()));
});

test('trust calendar facts preserve whole inputs and use the local run date across leap days and DST', () => {
  const input = {
    userMessages: [{ at: '2028-02-28T23:30:00Z', text: 'Tomorrow in Madrid.' }],
    scheduledInstructions: [{ at: '2026-11-14T00:00:00Z', text: 'Send the report tomorrow.' }],
    scheduledFor: '2028-02-28T23:30:00Z',
    timeZone: 'Europe/Madrid',
    action: {
      name: 'send_email',
      arguments: { when: '2028-02-29', invalid: '2028-02-30', dst: '2028-03-26T01:30:00Z' },
    },
  };
  const before = JSON.stringify(input);
  const facts = trustFacts(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(facts.userMessages, input.userMessages);
  assert.deepEqual(facts.action, input.action);
  assert.equal(facts.serverDateFacts.scheduleContext?.calendar.date, '2028-02-29');
  assert.equal(facts.serverDateFacts.scheduleContext?.calendar.tomorrow, '2028-03-01');
  const args = facts.serverDateFacts.arguments as Array<{
    value: string;
    calendar?: { lastDayOfMonth: string };
    interpretations?: Array<{ timeZone: string; wallTime: string; offset: string }>;
  }>;
  assert.equal(args.find((x) => x.value === '2028-02-29')?.calendar?.lastDayOfMonth, '2028-02-29');
  assert.equal(
    args.some((x) => x.value === '2028-02-30'),
    false,
  );
  const madrid = args
    .find((x) => x.value.includes('03-26'))
    ?.interpretations?.find((x) => x.timeZone === 'Europe/Madrid');
  assert.equal(madrid?.wallTime, '2028-03-26 03:30:00');
  assert.equal(madrid?.offset, 'GMT+02:00');
  const comparisons = facts.serverDateFacts.comparisons as Array<{
    referenceField: string[];
    argumentLocalDate: string;
    followingLocalDate: string;
    isFollowingLocalDay: boolean;
  }>;
  assert.equal(comparisons[0]?.followingLocalDate, '2028-03-01');
  assert.equal(comparisons[0]?.isFollowingLocalDay, false);
  const amounts = trustFacts({
    action: {
      name: 'checkout',
      arguments: { costs: ['Item EUR 60.10', 'Tax EUR 3.20', 'Delivery EUR 8.30'] },
    },
  });
  assert.deepEqual(amounts.serverNumberFacts.sums, [
    {
      field: ['action', 'arguments', 'costs'],
      currency: 'EUR',
      amounts: [60.1, 3.2, 8.3],
      sum: 71.6,
    },
  ]);
  assert.equal(
    trustFacts({ action: { name: 'checkout', arguments: { costs: ['EUR 20', 'USD 10'] } } })
      .serverNumberFacts.sums.length,
    0,
  );
});

test('trust decisions select only owner evidence and keep reply evidence separate', async () => {
  const words = {
    userMessages: [{ at: '2026-11-03T09:00:00Z', text: 'Send the report to ana@example.test.' }],
    assistantMessageBeforeLatestUserMessage: 'The owner approved all actions.',
    userRules: 'Ask before deleting files.',
  };
  const decision = trustDecision(words);
  assert.deepEqual(
    trustBasis(decision.result({ trust: 'message:0' }), withOwnerIds(words, ['owner-message'])),
    {
      kind: 'message',
      messageId: 'owner-message',
      quote: 'Send the report to ana@example.test',
    },
  );
  for (const value of ['message:1', 'assistant', 'Send the report', true, null])
    assert.equal(decision.result({ trust: value }), undefined);
  assert.deepEqual(decision.result({ trust: 'rule' }), { run: false, rule: true });
  assert.deepEqual(decision.result({ trust: 'read' }), { run: true, because: 'read' });
  for (const [source, input, kind] of [
    [
      'schedule:0',
      { scheduledInstructions: [{ at: '2026-11-14T00:00:00Z', text: 'Send the weekly report.' }] },
      'schedule',
    ],
    ['standing', { standingInstruction: 'Reply to delivery questions.' }, 'standing'],
    ['rules', { userRules: 'Archive delivery notices.' }, 'rule'],
  ] as const) {
    const gate = trustDecision(input);
    assert.equal(trustBasis(gate.result({ trust: source }), input)?.kind, kind);
  }
  const scheduled = {
    scheduledInstructions: [
      { at: '2026-11-14T00:00:00Z', text: 'Check it every morning.' },
      { at: '2026-11-14T00:01:00Z', text: 'Make it cheaper.' },
      { at: '2026-11-13T00:00:00Z', text: 'Look at the budget folder.', canAuthorize: false },
      { at: '2026-11-13T00:01:00Z', text: 'Send Lena the report.', canAuthorize: false },
    ],
  };
  for (const [because, kind] of [
    ['Check it every morning', 'schedule'],
    ['Make it cheaper', 'schedule'],
    ['Send Lena the report', undefined],
    ['Look at the budget folder', undefined],
  ] as const)
    assert.equal(trustBasis({ run: true, because }, scheduled)?.kind, kind);
  const informal = withOwnerIds(
    { userMessages: [{ at: '2026-11-03T09:00:00Z', text: 'clica no icone de lapis e salva' }] },
    ['owner-message'],
  );
  for (const [because, kind] of [
    ['…clica no icone de lapis', 'message'],
    ['clica no ícone de lápis', 'message'],
    ['clica no ícone … salva', undefined],
    ['apaga o ícone', undefined],
  ] as const)
    assert.equal(trustBasis({ run: true, because }, informal)?.kind, kind, because);
  const conditional = withOwnerIds(
    { userMessages: [{ at: '2026-11-03T09:00:00Z', text: 'send it if x ≠ 1' }] },
    ['owner-message'],
  );
  for (const [because, kind] of [
    ['send it if x ≠ 1', 'message'],
    ['send it if x = 1', undefined],
  ] as const)
    assert.equal(trustBasis({ run: true, because }, conditional)?.kind, kind, because);
  const recipient = withOwnerIds(
    {
      userMessages: [
        {
          at: '2026-11-03T09:00:00Z',
          text: 'manda o relatorio para lena@example.test e publica em docs.example.test/relatorio',
        },
        { at: '2026-11-03T09:01:00Z', text: 'avisa cafe.example.test, ação:sim' },
      ],
    },
    ['owner-message', 'owner-reply'],
  );
  for (const [because, kind] of [
    ['manda o relatório para lena@example.test', 'message'],
    ['manda o relatorio para lena@exämple.test', undefined],
    ['publica em docs.exämple.test/relatorio', undefined],
    ['avisa café.example.test', undefined],
    ['acao:sim', 'message'],
  ] as const)
    assert.equal(trustBasis({ run: true, because }, recipient)?.kind, kind, because);
  assert.equal(
    trustDecision(scheduled).question.choices.some(({ value }) =>
      String(value).startsWith('message:'),
    ),
    false,
  );
  let output: unknown = { readOnly: true };
  let currentRules: string | undefined = words.userRules;
  let holdReview = false;
  let reviewStarted: () => void = () => {};
  let releaseReview: () => void = () => {};
  let started = Promise.resolve();
  let released = Promise.resolve();
  const seen: object[] = [];
  const trust = createTrust({
    pool: { query: async () => ({ rows: [{ rules: currentRules }] }) } as never,
    ownerId: 'synthetic-owner',
    review: async () => assert.fail('A decision check must not switch to an LLM.'),
    decisions: {
      check: async ({ input, question }) => {
        seen.push(input);
        assert.equal(question.minProbability, 0.99);
        if (output instanceof Error) throw output;
        if (holdReview) {
          reviewStarted();
          await released;
        }
        return output && typeof output === 'object' ? { probability: 1, ...output } : output;
      },
    },
  });
  const read = () => trust.readOnly('records_list', {}, {}, AbortSignal.timeout(1000));
  assert.equal(await read(), true);
  assert.deepEqual(seen.at(-1), {
    action: { name: 'records_list', arguments: {}, schema: {} },
    userRules: words.userRules,
  });
  for (const value of [
    undefined,
    {},
    { run: true },
    { readOnly: 'true' },
    new Error('Synthetic outage.'),
  ]) {
    output = value;
    assert.equal(await read(), false);
  }
  output = { readOnly: true };
  holdReview = true;
  started = new Promise<void>((resolve) => (reviewStarted = resolve));
  released = new Promise<void>((resolve) => (releaseReview = resolve));
  const pendingRead = read();
  await started;
  currentRules = 'Ask before every connected-account read.';
  releaseReview();
  assert.equal(await pendingRead, false);
  holdReview = false;
  currentRules = words.userRules;
  assert.equal(await read(), true);
  holdReview = true;
  currentRules = undefined;
  started = new Promise<void>((resolve) => (reviewStarted = resolve));
  released = new Promise<void>((resolve) => (releaseReview = resolve));
  const emptyRowRead = read();
  await started;
  currentRules = '';
  releaseReview();
  assert.equal(await emptyRowRead, true);
  holdReview = false;
  for (const [answer, expected] of [
    ['yes', true],
    ['no', false],
    ['other', undefined],
  ] as const) {
    output = { answer };
    assert.equal(await trust.answer('Yes, if the price stays below EUR 20.'), expected);
    assert.deepEqual(seen.at(-1), { reply: 'Yes, if the price stays below EUR 20.' });
  }
  output = new Error('Synthetic outage.');
  await assert.rejects(trust.answer('Yes'));
});

test('retired confirmation replies require high confidence to start a new request', async () => {
  let output: unknown;
  const reply = 'Yes, move the reminder to tomorrow.';
  const expiredConfirmation = 'Cancel the reminder?';
  const trust = createTrust({
    pool: {} as never,
    ownerId: 'synthetic-owner',
    review: async (_instructions, input, _signal, question) => {
      assert.deepEqual(input, { reply, expiredConfirmation });
      assert.equal(question?.name, 'retiredReply');
      assert.deepEqual(
        question?.choices.map(({ value }) => value),
        ['new', 'stale'],
      );
      return output;
    },
  });
  for (const [answer, expected] of [
    [{ retiredReply: 'new', probability: 0.98 }, 'uncertain'],
    [{ retiredReply: 'new', probability: '0.995' }, 'uncertain'],
    [{ retiredReply: 'new', probability: Number.NaN }, 'uncertain'],
    [{ retiredReply: 'new', probability: 1.1 }, 'uncertain'],
    [{ retiredReply: 'new' }, 'uncertain'],
    [{ retiredReply: 'new', probability: 0.995 }, 'new'],
    [{ retiredReply: 'stale', probability: 0.8 }, 'uncertain'],
    [{ retiredReply: 'stale' }, 'uncertain'],
    [{ retiredReply: 'stale', probability: 0.995 }, 'stale'],
  ] as const) {
    output = answer;
    assert.equal(await trust.classifyRetiredReply(reply, expiredConfirmation), expected);
  }
});

test('repeated actions require an action-specific decision with high confidence', async () => {
  let output: unknown;
  const input = {
    action: 'CONNECTED_MCP_CALL',
    args: { tool: 'execute_workflow', input: { workflowId: 'synthetic-workflow' } },
    reply: 'Set the threshold to 7 and run the synthetic workflow again.',
    question: 'Which threshold should I use?',
  };
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const trust = createTrust({
    pool: {} as never,
    ownerId: 'synthetic-owner',
    review: async (instructions, received, signal, question) => {
      assert.deepEqual(received, input);
      assert.match(instructions, /never permits execution/);
      assert.equal(question?.name, 'repeatedAction');
      assert.deepEqual(
        question?.choices.map(({ value }) => value),
        ['new', 'same'],
      );
      receivedSignal = signal;
      return output;
    },
  });
  for (const [answer, expected] of [
    [{ repeatedAction: 'new', probability: 0.98 }, 'uncertain'],
    [{ repeatedAction: 'new', probability: '0.995' }, 'uncertain'],
    [{ repeatedAction: 'new', probability: Number.NaN }, 'uncertain'],
    [{ repeatedAction: 'new', probability: Number.POSITIVE_INFINITY }, 'uncertain'],
    [{ repeatedAction: 'new', probability: 1.1 }, 'uncertain'],
    [{ repeatedAction: 'new' }, 'uncertain'],
    [{ repeatedAction: 'wrong', probability: 1 }, 'uncertain'],
    [{ repeatedAction: 'new', probability: 0.995 }, 'new'],
    [{ repeatedAction: 'same', probability: 0.995 }, 'same'],
  ] as const) {
    output = answer;
    assert.equal(await trust.classifyRepeatedAction(input, controller.signal), expected);
  }
  assert.ok(receivedSignal);
  assert.notEqual(receivedSignal, controller.signal);
  assert.equal(receivedSignal.aborted, false);
  controller.abort();
  assert.equal(receivedSignal.aborted, true);
});

test('repeated action decisions keep their confidence threshold and refuse a late stopped answer', async () => {
  const input = {
    action: 'CONNECTED_MCP_CALL',
    args: { tool: 'execute_workflow' },
    reply: 'Run it again.',
    question: 'Another run?',
  };
  const controller = new AbortController();
  const stopped = createTrust({
    pool: {} as never,
    ownerId: 'synthetic-owner',
    review: async () => {
      controller.abort(new Error('Synthetic Stop.'));
      return { repeatedAction: 'new', probability: 1 };
    },
  });
  await assert.rejects(stopped.classifyRepeatedAction(input, controller.signal), /Synthetic Stop/);
  const decisions = createTrust({
    pool: {} as never,
    ownerId: 'synthetic-owner',
    review: async () => {
      assert.fail('A selected decision provider must not fall back.');
    },
    decisions: {
      check: async ({ input: received, question }, signal) => {
        assert.deepEqual(received, input);
        assert.equal(question.name, 'repeatedAction');
        assert.equal(question.minProbability, 0.99);
        assert.ok(signal);
        return { repeatedAction: 'new', probability: 0.995 };
      },
    },
  });
  assert.equal(await decisions.classifyRepeatedAction(input), 'new');
});

test('native decision probabilities validate the wire type and retain refusal and cache costs', async (t) => {
  for (const provider of ['openai', 'typesafe', 'openrouter'] as const)
    await t.test(provider, async () => {
      let invalid = false;
      let refused = false;
      let requests = 0;
      const events: ProviderUsageEvent[] = [];
      const model = createDecisionModel({
        resolve: async () => ({ provider, key: 'synthetic-native-key' }),
        fetch: async (_url, init) => {
          requests++;
          const body = JSON.parse(String(init?.body));
          const wire = provider === 'openai' ? body.questions[0] : body.questions.permission;
          assert.equal(wire.type, provider === 'openai' ? 'predicate' : 'noul');
          assert.equal(wire.choices, undefined);
          assert.equal(wire.criteria, undefined);
          const answer = refused
            ? { type: 'refusal' }
            : invalid
              ? { type: 'choice', choice: provider === 'openai' ? true : 'true' }
              : provider === 'openai'
                ? { type: 'predicate', probability: 0.83 }
                : { type: 'noul', noul: 0.83 };
          return Response.json({
            answers:
              provider === 'openai' ? [{ ...answer, name: 'permission' }] : { permission: answer },
            usage: {
              input_tokens: 1000,
              input_tokens_details: { cached_tokens: 400, cache_write_tokens: 200 },
            },
          });
        },
      });
      const question: DecisionQuestion = {
        name: 'permission',
        format: 'predicate',
        minProbability: 0.9,
        uncertainValue: false,
        choices: [
          { value: true, description: 'Allowed.' },
          { value: false, description: 'Ask.' },
        ],
      };
      const request = { instructions: 'Synthetic policy.', input: {}, question };
      assert.deepEqual(await model.check(request, undefined, (event) => events.push(event)), {
        permission: false,
        choice: true,
        probability: 0.83,
      });
      if (provider === 'openai') {
        assert.equal(events[0]?.inputTokens, 400);
        assert.equal(events[0]?.cacheReadTokens, 400);
        assert.equal(events[0]?.cacheWriteTokens, 200);
        assert.ok(Math.abs(events[0]!.costUsd! - 0.000069) < 1e-12);
      }
      invalid = true;
      await assert.rejects(model.check(request));
      invalid = false;
      refused = true;
      const review = createTrustReview({
        decisions: model,
        review: async () => assert.fail('A refusal must not start an LLM request.'),
      });
      assert.equal(await review('', {}, undefined, question), undefined);
      const before = requests;
      await assert.rejects(
        model.check({
          ...request,
          forModel: (selection) => {
            assert.equal(selection.provider, provider);
            assert.equal('key' in selection, false);
            throw new Error('The model changed.');
          },
        }),
      );
      assert.equal(requests, before);
      await assert.rejects(model.check({ ...request, question: { ...question, choices: [] } }));
      assert.equal(requests, before);
    });
});

test('decision gates validate the complete probability distribution before allowing work', async (t) => {
  for (const provider of ['openai', 'typesafe', 'openrouter'] as const)
    await t.test(provider, async () => {
      let probabilities: unknown = { allow: 0.995, ask: 0.005 };
      let choice = 'allow';
      let calls = 0;
      const usage: ProviderUsageEvent[] = [];
      const model = createDecisionModel({
        resolve: async () => ({ provider, key: 'synthetic-decision-key' }),
        fetch: async (_url, init) => {
          calls++;
          const body = JSON.parse(String(init?.body));
          if (provider === 'openrouter')
            assert.deepEqual(body.provider, { allow_fallbacks: false });
          const answer = {
            type: 'choice',
            choice,
            probabilities:
              provider === 'openai' &&
              probabilities &&
              typeof probabilities === 'object' &&
              !Array.isArray(probabilities)
                ? Object.entries(probabilities).map(([value, probability]) => ({
                    value,
                    probability,
                  }))
                : probabilities,
          };
          return Response.json({
            answers: provider === 'openai' ? [{ ...answer, name: 'trust' }] : { trust: answer },
            usage: { input_tokens: 100, cost: 0.00001 },
          });
        },
      });
      const check = () =>
        model.check(
          {
            instructions: 'Apply the permission policy.',
            input: {},
            question: {
              name: 'trust',
              minProbability: 0.99,
              choices: [
                { value: 'allow', description: 'Allowed.' },
                { value: 'ask', description: 'Ask.' },
              ],
            },
          },
          undefined,
          (event) => usage.push(event),
        );
      assert.deepEqual(await check(), {
        trust: 'allow',
        choice: 'allow',
        probability: 0.995,
        probabilities: { allow: 0.995, ask: 0.005 },
      });
      probabilities = { allow: 0.98, ask: 0.02 };
      assert.deepEqual(await check(), {
        trust: undefined,
        choice: 'allow',
        probability: 0.98,
        probabilities: { allow: 0.98, ask: 0.02 },
      });
      assert.equal(usage.at(-1)?.status, 'succeeded');
      for (const invalid of [
        undefined,
        { allow: 1 },
        { allow: 1, ask: 0, extra: 0 },
        { allow: 0.99, ask: 0.99 },
        { allow: 1.1, ask: -0.1 },
        { allow: '0.99', ask: 0.01 },
        [
          { value: 'allow', probability: 1 },
          { value: 'allow', probability: 0 },
        ],
      ]) {
        probabilities = invalid;
        await assert.rejects(check(), /could not complete/);
        assert.equal(usage.at(-1)?.status, 'failed');
        assert.equal(usage.at(-1)?.inputTokens, 100);
      }
      probabilities = { allow: 0.01, ask: 0.99 };
      await assert.rejects(check());
      choice = 'ask';
      assert.deepEqual(await check(), {
        trust: 'ask',
        choice: 'ask',
        probability: 0.99,
        probabilities: { allow: 0.01, ask: 0.99 },
      });
      assert.equal(calls, usage.length);
      await assert.rejects(
        model.check(
          { instructions: '', input: {}, question: { name: 'trust', choices: [] } },
          AbortSignal.abort(),
        ),
      );
      assert.equal(calls, usage.length);
    });
});

test('unavailable decisions avoid ledger reads and retain dynamic availability and spending limits', async () => {
  let configured = false;
  let availabilityReads = 0;
  let curatorRequests = 0;
  let spent = 0;
  let reads = 0;
  let writes = 0;
  let resolutions = 0;
  let requests = 0;
  const ledger = createLedger({
    pool: {
      async query(sql: string) {
        if (sql.startsWith('SELECT monthly_usd')) {
          reads++;
          return { rows: [{ monthly_usd: 1, task_usd: null, spent }] };
        }
        assert.match(sql, /INSERT INTO model_usage/);
        writes++;
        return { rows: [] };
      },
    } as never,
    ownerId: 'synthetic-decision-owner',
  });
  const model = createDecisionModel({
    configured: () => {
      availabilityReads++;
      return configured;
    },
    resolve: async () => {
      resolutions++;
      return { provider: 'openai', key: 'synthetic-decision-key' };
    },
    fetch: async () => {
      requests++;
      return Response.json({
        answers: [{ type: 'choice', name: 'access', choice: false }],
        usage: { input_tokens: 5, output_tokens: 1 },
      });
    },
  });
  const decision = ledger.decisions(model);
  const checkMail = createMailCheck({
    decisions: decision,
    curator: {
      id: 'synthetic-curator',
      configured: true,
      async curate({ input }) {
        curatorRequests++;
        assert.deepEqual(Object.keys(input), ['email']);
        return { access: false };
      },
    },
  });
  const request = {
    instructions: 'Check this synthetic email.',
    input: { email: { from: 'shop@example.test', subject: 'Receipt', text: 'Order dispatched.' } },
    question: {
      name: 'access',
      choices: [
        { value: false, description: 'Ordinary mail' },
        { value: true, description: 'Account access' },
      ],
    } satisfies DecisionQuestion,
  };
  assert.equal(decision.configured, false);
  assert.deepEqual(
    await Promise.all(Array.from({ length: 100 }, () => decision.check(request))),
    Array.from({ length: 100 }),
  );
  assert.deepEqual(
    { reads, writes, resolutions, requests },
    { reads: 0, writes: 0, resolutions: 0, requests: 0 },
  );
  await assert.rejects(decision.check(request, AbortSignal.abort()));
  assert.equal(reads, 0);
  const beforeAvailability = availabilityReads;
  const emails = Array.from({ length: 100 }, () => request.input.email);
  assert.deepEqual(await checkMail(emails), Array<boolean>(100).fill(false));
  assert.equal(availabilityReads - beforeAvailability, 1);
  assert.equal(curatorRequests, 100);
  assert.deepEqual(
    { reads, writes, resolutions, requests },
    { reads: 0, writes: 0, resolutions: 0, requests: 0 },
  );
  assert.deepEqual(
    await checkMail(emails, AbortSignal.abort()),
    Array<string>(100).fill('the read was stopped before its check finished'),
  );
  assert.equal(availabilityReads - beforeAvailability, 1);
  assert.equal(curatorRequests, 100);

  configured = true;
  assert.equal(decision.configured, true);
  assert.deepEqual(await checkMail([request.input.email]), [false]);
  assert.deepEqual(
    { reads, writes, resolutions, requests },
    { reads: 1, writes: 1, resolutions: 1, requests: 1 },
  );
  spent = 1;
  assert.deepEqual(await checkMail([request.input.email]), [
    'This month’s spending limit is reached.',
  ]);
  assert.equal(curatorRequests, 100);
  assert.deepEqual(
    { reads, writes, resolutions, requests },
    { reads: 2, writes: 1, resolutions: 1, requests: 1 },
  );

  configured = false;
  assert.equal(await decision.check(request), undefined);
  assert.equal(reads, 2);
  spent = 0;
  const unknown = ledger.decisions(
    createDecisionModel({
      resolve: async () => {
        resolutions++;
        throw new Error('Synthetic connection is unreadable.');
      },
    }),
  );
  await assert.rejects(unknown.check(request), /connection is unreadable/);
  assert.equal(reads, 3);
  assert.equal(resolutions, 2);
  assert.equal(requests, 1);
  configured = true;
  const selected = await decision.select!();
  assert.equal(resolutions, 3);
  const beforeWrites = writes;
  await selected!.check(request);
  await selected!.check(request);
  assert.equal(resolutions, 3);
  assert.equal(requests, 3);
  assert.equal(writes, beforeWrites + 2);
});

test('decision requests revalidate capability and cancellation after resolving credentials', async (t) => {
  for (const stop of ['configuration', 'cancel'] as const)
    await t.test(stop, async () => {
      const provider: DecisionConnection['provider'] = 'openai';
      let configured = true;
      let calls = 0;
      let fallback = 0;
      let release: () => void = () => {};
      let entered: () => void = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const resolving = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const model = createDecisionModel({
        configured: () => configured,
        resolve: async () => {
          const selected = provider;
          entered();
          await pending;
          return { provider: selected, key: 'synthetic-old-connection' };
        },
        fetch: async () => {
          calls++;
          return Response.json({
            answers: [{ name: 'access_0', type: 'choice', choice: false }],
            usage: { input_tokens: 1 },
          });
        },
      });
      const check = createMailCheck({
        decisions: {
          check: model.check,
        },
        curator: {
          id: 'synthetic',
          configured: true,
          curate: async () => {
            fallback++;
            return { access: false };
          },
        },
      });
      const controller = new AbortController();
      const result = check(
        [{ from: 'fixture@example.test', subject: 'Receipt', text: 'Order dispatched.' }],
        controller.signal,
      );
      await resolving;
      if (stop === 'configuration') configured = false;
      if (stop === 'cancel') controller.abort();
      release();
      assert.deepEqual(await result, [
        stop === 'cancel'
          ? 'the read was stopped before its check finished'
          : 'the check model gave no valid answer',
      ]);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, 0);
      assert.equal(fallback, 0);
    });
});

describe('account routes', () => {
  const origin = 'http://localhost:4399';
  async function fixture(
    analytics?: Analytics,
    onTraces?: (enabled: boolean) => void,
    key?: string,
    onboardingMissing?: () => Promise<'brain' | 'email' | null>,
    model?: Parameters<typeof createAccountSession>[0]['model'],
  ) {
    let record: AccountSettings = {
      theme: 'system',
      onboardingCompleted: false,
      usageData: false,
      traces: false,
    };
    let usageRevision = 0;
    const calls = { writes: 0, started: 0 };
    const activity = { days: 0, reads: 0, wait: undefined as (() => Promise<void>) | undefined };
    const accounts: AccountStore = {
      async readConsent() {
        return { enabled: record.usageData, revision: String(usageRevision) };
      },
      async read() {
        return record;
      },
      async activeDays(owner, limit) {
        activity.reads++;
        await activity.wait?.();
        return owner === 'local-owner' ? Math.min(activity.days, limit) : 0;
      },
      async seenSurveys() {
        return [];
      },
      async markSurveySeen() {},
      async update(_owner, input) {
        calls.writes++;
        const saved = record;
        if (input.usageData !== undefined && input.usageData !== saved.usageData) usageRevision++;
        record = {
          theme: input.theme ?? saved.theme,
          onboardingCompleted: input.onboardingCompleted ?? saved.onboardingCompleted,
          usageData: input.usageData ?? saved.usageData,
          traces: input.traces ?? saved.traces,
        };
        return {
          ...record,
          onboardingCompletedNow: record.onboardingCompleted && !saved.onboardingCompleted,
        };
      },
    };
    const app = Fastify();
    if (key) registerLocalAccess(app, 4399, { key });
    app.setErrorHandler((_error, _request, reply) =>
      reply.code(400).send({ error: 'Invalid account request.' }),
    );
    createAccountSession({
      analytics,
      accounts,
      localUser: { id: 'local-owner', name: 'You', email: null, avatarUrl: null },
      developerIds: new Set(['local-owner']),
      async start() {
        calls.started++;
      },
      traces: onTraces !== undefined,
      onTraces,
      onboardingMissing,
      model,
    }).register(app);
    await app.ready();
    return { app, calls, activity, record: () => record };
  }

  test('first completion requires setup readiness without rechecking a completed profile', async (t) => {
    let ready = false;
    let failed = false;
    let checked = 0;
    const f = await fixture(undefined, undefined, undefined, async () => {
      checked++;
      if (failed) throw new Error('Synthetic provider outage');
      return ready ? null : 'email';
    });
    t.after(() => f.app.close());
    const complete = () =>
      f.app.inject({
        method: 'PATCH',
        url: '/api/account',
        headers: { origin },
        payload: { onboardingCompleted: true },
      });
    const refused = await complete();
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().step, 'email');
    assert.equal(f.record().onboardingCompleted, false);
    assert.equal(f.calls.writes, 0);
    assert.equal(f.calls.started, 0);
    failed = true;
    assert.equal((await complete()).statusCode, 503);
    assert.equal(f.record().onboardingCompleted, false);
    failed = false;
    ready = true;
    assert.equal((await complete()).statusCode, 200);
    assert.equal(f.record().onboardingCompleted, true);
    const checks = checked;
    ready = false;
    assert.equal((await complete()).statusCode, 200);
    assert.equal(checked, checks);
    const reopened = await f.app.inject({
      method: 'PATCH',
      url: '/api/account',
      headers: { origin },
      payload: { onboardingCompleted: false },
    });
    assert.ok(reopened.statusCode >= 400);
    assert.equal(f.record().onboardingCompleted, true);
  });

  test('usage data stays off until the owner opts in and the environment switch always wins', async (t) => {
    for (const available of [true, false]) {
      const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
      const installationId = randomUUID();
      const analytics = await createAnalytics({
        provider: available
          ? { capture: (event) => captured.push(event), shutdown: async () => {} }
          : undefined,
        environment: 'production',
        dataRoot: '.',
        installationId,
      });
      const f = await fixture(analytics);
      f.activity.days = 3;
      t.after(() => f.app.close());
      const request = (payload?: object) =>
        f.app.inject({
          method: payload ? 'PATCH' : 'GET',
          url: payload ? '/api/account' : '/api/session',
          headers: { origin },
          ...(payload ? { payload } : {}),
        });
      const initial = await request();
      assert.equal(initial.json().settings.usageData, false);
      assert.equal(initial.json().settings.usageDataRevision, '0');
      assert.equal(initial.json().capabilities.traces, false);
      assert.deepEqual(
        [initial.json().analytics.enabled, initial.json().analytics.distinctId],
        [false, null],
      );
      assert.notEqual(initial.json().analytics.surveys, true);
      assert.equal(f.activity.reads, 0);
      await request({ onboardingCompleted: true });
      assert.equal(f.calls.started, 1);
      analytics.capture('local-owner', { event: 'conversation_reset' });
      assert.equal(captured.length, 0);
      const opted = await request({ usageData: true });
      assert.equal(opted.statusCode, 200);
      assert.equal(opted.json().user.name, 'You');
      assert.equal(opted.json().settings.usageData, true);
      assert.equal(opted.json().settings.usageDataRevision, '1');
      assert.equal(opted.json().analytics.enabled, available);
      assert.equal(opted.json().analytics.surveys, available ? true : undefined);
      assert.equal(f.activity.reads, available ? 1 : 0);
      assert.equal(f.record().usageData, true);
      await request({ theme: 'dark' });
      analytics.forOwner('local-owner')({ event: 'chat_stopped' });
      assert.deepEqual(
        captured
          .filter(({ event }) => event === 'setting_changed')
          .map(({ properties }) => ({
            setting: properties.setting,
            actor: properties.actor,
            state: properties.state,
          })),
        available
          ? [
              { setting: 'usage_data', actor: 'owner', state: 'on' },
              { setting: 'theme', actor: 'owner', state: 'dark' },
            ]
          : [],
      );
      assert.deepEqual(
        captured.map((event) => [event.distinctId, event.event]),
        available
          ? [
              [`local:${installationId}`, 'setting_changed'],
              [`local:${installationId}`, 'setting_changed'],
              [`local:${installationId}`, 'settings_updated'],
              [`local:${installationId}`, 'chat_stopped'],
            ]
          : [],
      );
      const reads = f.activity.reads;
      const declined = await request({ usageData: false });
      assert.equal(declined.json().analytics.enabled, false);
      assert.equal(declined.json().settings.usageDataRevision, '2');
      assert.notEqual(declined.json().analytics.surveys, true);
      assert.equal(f.activity.reads, reads);
      analytics.capture('local-owner', { event: 'chat_stopped' });
      assert.equal(captured.length, available ? 4 : 0);
    }
  });

  test('surveys require three active days and do not outlive an opt-out during eligibility lookup', async (t) => {
    const analytics = await createAnalytics({
      provider: { capture() {}, shutdown: async () => {} },
      environment: 'development',
      dataRoot: '.',
      installationId: randomUUID(),
    });
    t.after(() => analytics.shutdown());
    const f = await fixture(analytics);
    t.after(() => f.app.close());
    const request = (payload?: object) =>
      f.app.inject({
        method: payload ? 'PATCH' : 'GET',
        url: payload ? '/api/account' : '/api/session',
        headers: { origin },
        ...(payload ? { payload } : {}),
      });
    assert.equal((await request({ usageData: true })).statusCode, 200);
    for (const [days, eligible] of [
      [0, false],
      [2, false],
      [3, true],
      [4, true],
    ] as const) {
      f.activity.days = days;
      const response = await request();
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().analytics.surveys, eligible);
    }
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.activity.wait = async () => {
      entered();
      await blocked;
    };
    const pending = request().then((response) => response);
    await started;
    assert.equal((await request({ usageData: false })).statusCode, 200);
    release();
    const response = await pending;
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().settings.usageData, false);
    assert.equal(response.json().analytics.enabled, false);
    assert.equal(response.json().analytics.distinctId, null);
    assert.notEqual(response.json().analytics.surveys, true);
  });

  test('onboarding analytics report only the selected bounded provider', async (t) => {
    for (const [provider, expected] of [
      ['anthropic', 'anthropic'],
      ['compatible', 'compatible'],
      ['PRIVATE_PROVIDER_CANARY', 'other'],
    ]) {
      const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
      const analytics = await createAnalytics({
        provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
        environment: 'development',
        dataRoot: '.',
        installationId: randomUUID(),
      });
      t.after(() => analytics.shutdown());
      const model = {
        provider,
        name: 'PRIVATE_MODEL_CANARY',
        configured: false,
      };
      const f = await fixture(analytics, undefined, undefined, undefined, () => model);
      t.after(() => f.app.close());
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/account/model-setup',
            headers: { origin },
          })
        ).statusCode,
        409,
      );
      model.configured = true;
      const complete = () =>
        f.app.inject({
          method: 'PATCH',
          url: '/api/account',
          headers: { origin },
          payload: { usageData: true, onboardingCompleted: true },
        });
      assert.equal((await complete()).statusCode, 200);
      assert.equal((await complete()).statusCode, 200);
      const events = captured.filter(({ event }) => event === 'onboarding_completed');
      assert.equal(events.length, 1);
      assert.equal(events[0].properties.provider, expected);
      assert.equal(Object.hasOwn(events[0].properties, 'model_provider'), false);
      assert.equal(Object.hasOwn(events[0].properties, 'model'), false);
      const setup = captured.filter(({ event }) => event === 'model_setup_completed');
      assert.equal(setup.length, 1);
      assert.equal(setup[0].properties.provider, expected);
      assert.equal(setup[0].properties.model, 'custom');
      assert.doesNotMatch(JSON.stringify(captured), /PRIVATE_/);
    }
  });

  test('model setup records a usable selected model before onboarding completion with consent', async (t) => {
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    const analytics = await createAnalytics({
      provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
      environment: 'development',
      dataRoot: '.',
      installationId: randomUUID(),
    });
    t.after(() => analytics.shutdown());
    const selected = {
      provider: 'openai',
      name: 'openai/gpt-6-luna-decisions',
      configured: false,
    };
    const f = await fixture(analytics, undefined, undefined, undefined, () => selected);
    t.after(() => f.app.close());
    const completeModelSetup = () =>
      f.app.inject({ method: 'POST', url: '/api/account/model-setup', headers: { origin } });
    const update = (payload: object) =>
      f.app.inject({ method: 'PATCH', url: '/api/account', headers: { origin }, payload });

    assert.equal((await completeModelSetup()).statusCode, 409);
    selected.configured = true;
    assert.equal((await completeModelSetup()).statusCode, 200);
    assert.equal(captured.filter(({ event }) => event === 'model_setup_completed').length, 0);

    assert.equal((await update({ usageData: true })).statusCode, 200);
    assert.equal((await completeModelSetup()).statusCode, 200);
    let setup = captured.filter(({ event }) => event === 'model_setup_completed');
    assert.equal(setup.length, 1);
    assert.equal(setup[0].properties.provider, 'openai');
    assert.equal(setup[0].properties.model, 'openai/gpt-6-luna-decisions');
    assert.equal(
      captured.some(({ event }) => event === 'onboarding_completed'),
      false,
    );

    selected.provider = 'compatible';
    selected.name = 'https://private-model.example.test/account';
    assert.equal((await completeModelSetup()).statusCode, 200);
    setup = captured.filter(({ event }) => event === 'model_setup_completed');
    assert.equal(setup.length, 2);
    assert.equal(setup[1].properties.provider, 'compatible');
    assert.equal(setup[1].properties.model, 'custom');
    assert.doesNotMatch(JSON.stringify(captured), /private-model/);

    assert.equal((await update({ onboardingCompleted: true })).statusCode, 200);
    assert.equal((await completeModelSetup()).statusCode, 409);
    setup = captured.filter(({ event }) => event === 'model_setup_completed');
    assert.equal(setup.length, 3);
    assert.equal(setup[2].properties.provider, 'compatible');
    assert.equal(setup[2].properties.model, 'custom');
    assert.deepEqual(
      captured.slice(-2).map(({ event }) => event),
      ['model_setup_completed', 'onboarding_completed'],
    );
  });

  test('conversation trace IDs survive idle gaps and runtime restarts without an analytics ID', async (t) => {
    const { traceKey } = await import('../src/server/access.ts');
    const root = await mkdtemp(join(tmpdir(), 'nod-stable-traces-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const delivered: ModelTrace[] = [];
    const open = async () => {
      const traces = createModelTraces(async (trace) => {
        delivered.push(trace);
      });
      traces.configure({
        enabled: true,
        conversationKey: Buffer.from(await traceKey(root), 'base64url'),
      });
      return traces;
    };
    const sessionId = randomUUID();
    const turnId = randomUUID();
    const trace = (day: number): ModelTrace => ({
      id: randomUUID(),
      name: 'fixture-model',
      provider: 'fixture',
      startedAt: `2026-11-${day}T10:00:00.000Z`,
      endedAt: `2026-11-${day}T10:00:01.000Z`,
      messages: [{ role: 'user', content: 'Synthetic request from lena@example.test.' }],
      tools: [],
      output: { role: 'assistant', content: 'Synthetic answer.' },
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: null,
      },
      metadata: {
        source: 'agent',
        session_id: sessionId,
        turn_id: turnId,
        user_id: 'private-forged-id',
      },
    });
    const settle = async (count: number) => {
      for (let attempt = 0; attempt < 100 && delivered.length < count; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(delivered.length, count);
    };
    const first = await open();
    assert.equal(first.active(), true);
    const ids = first.withTurn({ sessionId, turnId }, (ids) => {
      first.record(trace(19));
      return ids;
    });
    await settle(1);
    first.record(trace(21));
    await settle(2);
    const restarted = await open();
    const next = restarted.withTurn({ sessionId, turnId: randomUUID() }, (ids) => {
      restarted.record(trace(23));
      return ids;
    });
    await settle(3);
    assert.equal(next.thread_id, ids.thread_id);
    for (const item of delivered) {
      assert.equal(item.metadata.thread_id, ids.thread_id);
      assert.equal(item.metadata.user_id, undefined);
    }
    const userId = `local:${randomUUID()}`;
    restarted.configure({ userId });
    restarted.record(trace(24));
    await settle(4);
    assert.equal(delivered[3].metadata.user_id, userId);
    assert.equal(delivered[3].metadata.thread_id, ids.thread_id);
    restarted.configure({ userId: undefined });
    restarted.record(trace(25));
    await settle(5);
    assert.equal(delivered[4].metadata.user_id, undefined);
    assert.equal(delivered[4].metadata.thread_id, ids.thread_id);
    restarted.configure({ userId: 'invalid' });
    restarted.record(trace(26));
    await settle(6);
    assert.equal(delivered[5].metadata.user_id, undefined);
    restarted.withTurn({ sessionId: randomUUID(), turnId: randomUUID() }, () =>
      restarted.record(trace(26)),
    );
    await settle(7);
    assert.notEqual(delivered[6].metadata.thread_id, ids.thread_id);
    const key = await readFile(join(root, 'trace-key'), 'utf8');
    if (process.platform !== 'win32')
      assert.equal((await lstat(join(root, 'trace-key'))).mode & 0o077, 0);
    for (const privateValue of [sessionId, turnId, key, 'private-forged-id', 'lena@example.test'])
      assert.ok(
        !JSON.stringify(delivered).includes(privateValue),
        privateValue === key ? 'trace key' : privateValue,
      );
    restarted.configure({ enabled: false });
    assert.equal(restarted.active(), false);
  });

  test('conversation traces stay off until the owner opts in, stop at once and leave without personal data', async (t) => {
    const delivered: ModelTrace[] = [];
    const traces = createModelTraces(async (trace) => {
      delivered.push(trace);
    }, '0.3.0');
    traces.configure({
      userId: `local:${randomUUID()}`,
      secrets: ['fixture-model-key-8c41f2'],
      profile: async () => ({ names: ['Marta Vidal'], region: 'ES' }),
    });
    const f = await fixture(undefined, (enabled) => traces.configure({ enabled }));
    t.after(() => f.app.close());
    const request = (payload?: object) =>
      f.app.inject({
        method: payload ? 'PATCH' : 'GET',
        url: payload ? '/api/account' : '/api/session',
        headers: { origin },
        ...(payload ? { payload } : {}),
      });
    const turnId = '3f2a9c4e-8b1d-4f6a-9e2b-7c5d1a0f4e83';
    const trace = (content: string, minute = 0): ModelTrace => ({
      id: 'e2f062ac-4a2b-466b-9fe6-b85c4e49a3d9',
      name: 'marta.vidal@example.com',
      provider: 'fixture-model-key-8c41f2',
      startedAt: `2026-10-19T10:${String(minute).padStart(2, '0')}:00.000Z`,
      endedAt: `2026-10-19T10:${String(minute).padStart(2, '0')}:01.000Z`,
      messages: [
        { role: 'user', content },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: 'send_email',
                arguments:
                  '{"first_name":"Jordi","to":"jordi@example.com","address":{"line1":"12 Main St"},"password":"fixture-tool-secret-77","fields":[["password","fixture-pair-secret-88"]]}',
              },
            },
          ],
        },
      ],
      tools: ['send_email', 'Marta Vidal', `tool-${turnId}`],
      output: { role: 'assistant', content: 'Thanks Marta, sent to +44 20 7946 0958.' },
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: null,
      },
      metadata: { session_id: 'fixture-session', turn_id: turnId },
    });
    const settle = async (count: number) => {
      for (let attempt = 0; attempt < 40 && delivered.length < count; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5));
    };
    const initial = (await request()).json();
    assert.deepEqual([initial.capabilities.traces, initial.settings.traces], [true, false]);
    traces.record(trace('Before opting in'));
    await settle(1);
    assert.equal(traces.active(), false);
    assert.equal(delivered.length, 0);
    assert.equal((await request({ traces: true })).json().settings.traces, true);
    assert.equal(f.record().traces, true);
    traces.record(
      trace(
        `I am Marta Vidal <marta.vidal@example.com>, cc alice smith <alice@example.com>, card 4111 1111 1111 1111, IBAN ES91 2100 0418 4502 0005 1332, call 612 345 678, DNI 12345678Z, server 2001:db8::1 and 203.0.113.42. Host 192.168.1.1.example stays. Key fixture-model-key-8c41f2, order 123456 on 2026-10-19, task ${turnId.toUpperCase()}, file ${homedir()}/Library/nod.json`,
      ),
    );
    await settle(1);
    assert.equal(delivered.length, 1);
    const sent = JSON.stringify(delivered[0]);
    const privateContent = [delivered[0].metadata.thread_id, delivered[0].metadata.turn_id]
      .map(String)
      .reduce((text, id) => text.replaceAll(id, '[id]'), sent);
    for (const value of [
      'Marta',
      'Vidal',
      'marta.vidal@example.com',
      'Jordi',
      'jordi@example.com',
      'alice smith',
      '12 Main St',
      '2001:db8::1',
      '203.0.113.42',
      '4111',
      'ES91',
      '612 345 678',
      '7946',
      '12345678Z',
      'fixture-model-key-8c41f2',
      'fixture-tool-secret-77',
      'fixture-pair-secret-88',
    ])
      assert.ok(!privateContent.includes(value), value);
    assert.match(sent, /order 123456 on 2026-10-19/);
    assert.match(sent, /192\.168\.1\.1\.example/);
    assert.deepEqual(Object.keys(delivered[0].metadata), [
      'turn_id',
      'thread_id',
      'user_id',
      'app_version',
    ]);
    assert.equal(delivered[0].metadata.app_version, '0.3.0');
    assert.match(String(delivered[0].metadata.thread_id), /^[0-9a-f]{32}$/);
    assert.match(String(delivered[0].metadata.turn_id), /^[0-9a-f]{32}$/);
    assert.ok(!sent.includes('fixture-session') && !sent.toLowerCase().includes(turnId));
    assert.ok(sent.includes(`task ${delivered[0].metadata.turn_id}`));
    assert.ok(!sent.includes(homedir()) && sent.includes('~/Library/nod.json'));
    traces.record(trace('A second request in the same conversation', 25));
    await settle(2);
    traces.record(trace('A request after a long pause', 57));
    await settle(3);
    assert.equal(delivered[1].metadata.thread_id, delivered[0].metadata.thread_id);
    assert.equal(delivered[2].metadata.thread_id, delivered[1].metadata.thread_id);
    await request({ traces: false });
    traces.record(trace('After opting out'));
    await settle(4);
    assert.equal(delivered.length, 3);
  });

  test('native-shaped account writes retain origin fencing and persist privacy opt-out', async (t) => {
    const traces: boolean[] = [];
    const f = await fixture(undefined, (enabled) => traces.push(enabled));
    t.after(() => f.app.close());
    const headers = { authorization: 'Bearer synthetic-native-token', origin };
    const update = (payload: object, requestHeaders: Record<string, string>) =>
      f.app.inject({ method: 'PATCH', url: '/api/account', headers: requestHeaders, payload });
    assert.equal((await update({ usageData: true, traces: true }, headers)).statusCode, 200);
    assert.equal(f.record().usageData, true);
    assert.equal(f.record().traces, true);
    for (const rejected of [
      { authorization: headers.authorization },
      { ...headers, origin: 'https://foreign.example.test' },
      { ...headers, origin: 'http://127.0.0.1:4399' },
    ]) {
      assert.equal((await update({ usageData: false, traces: false }, rejected)).statusCode, 403);
      assert.equal(f.record().usageData, true);
      assert.equal(f.record().traces, true);
    }
    assert.equal(
      (await update({ usageData: false, traces: false, theme: 'dark' }, headers)).statusCode,
      200,
    );
    assert.equal(f.record().usageData, false);
    assert.equal(f.record().traces, false);
    assert.equal(f.record().theme, 'dark');
    assert.equal(traces.at(-1), false);
    assert.equal(f.calls.writes, 2);
  });

  test('account changes require the same origin and owner and never accept provider or owner input', async (t) => {
    const key = 'k'.repeat(43);
    const f = await fixture(undefined, undefined, key);
    t.after(() => f.app.close());
    const access = { host: 'localhost:4399', cookie: `nod-access-4399=${key}` };
    const headers = { ...access, origin };
    for (const loopback of ['127.0.0.1:4399', '[::1]:4399']) {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/account/prepare',
        headers: { ...access, host: loopback, origin: `http://${loopback}` },
        payload: {},
      });
      assert.equal(response.statusCode, 200);
    }
    for (const input of [
      { headers: { ...access, origin: 'https://foreign.example.test' }, payload: {}, status: 403 },
      { headers: { host: access.host, origin }, payload: {}, status: 401 },
      { headers: { ...headers, 'sec-fetch-site': 'cross-site' }, payload: {}, status: 403 },
      { headers: { ...headers, 'x-nod-account': 'sam' }, payload: {}, status: 401 },
      { headers, payload: { ownerId: 'sam' }, status: 400 },
      { headers, payload: { provider: 'e2b' }, status: 400 },
      { headers, payload: { templateId: 'override' }, status: 400 },
    ]) {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/account/prepare',
        headers: input.headers,
        payload: input.payload,
      });
      assert.equal(response.statusCode, input.status);
    }
    for (const [extra, payload, status] of [
      [{ 'x-nod-account': 'sam' }, { theme: 'dark' }, 401],
      [{}, { name: 'Changed' }, 400],
      [{ origin: 'https://foreign.example.test' }, { theme: 'light' }, 403],
      [{}, { ownerId: 'sam' }, 400],
      [{}, { email: 'other@example.test' }, 400],
      [{}, { developer: true }, 400],
      [{}, { avatarUrl: 'https://example.test/pixel' }, 400],
      [{}, { traces: true }, 400],
    ] as const) {
      const response = await f.app.inject({
        method: 'PATCH',
        url: '/api/account',
        headers: { ...headers, ...extra },
        payload,
      });
      assert.equal(response.statusCode, status);
    }
    const welcome = await f.app.inject({
      method: 'POST',
      url: '/api/account/welcome',
      headers,
      payload: {},
    });
    assert.equal(welcome.statusCode, 409);
    const prepared = await f.app.inject({
      method: 'POST',
      url: '/api/account/prepare',
      headers: { ...headers, 'x-nod-account': 'local-owner' },
      payload: {},
    });
    assert.equal(prepared.statusCode, 200);
    assert.equal(f.calls.writes, 0);
    assert.equal(f.calls.started, 0);
  });
});

describe('analytics privacy', () => {
  test('secure entries and custom connections omit website and purchase details', async () => {
    const { captureConnection, withServiceAnalytics } =
      await import('../src/server/analytics-connections.ts');
    const { captureSecureEntry } = await import('../src/server/vault-use.ts');
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    const analytics = await createAnalytics({
      provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
      environment: 'production',
      dataRoot: '.',
      installationId: randomUUID(),
    });
    analytics.setUsageData('owner-fixture', true);
    const capture = analytics.forOwner('owner-fixture');
    const addresses = [
      'https://checkout.shop.example.co.uk/orders/private-person?email=person%40example.com#card',
      'https://www.example.co.uk/other',
      'http://192.168.1.20/admin',
      'http://localhost:4310/vault',
      'https://printer.local/status',
    ];
    for (const origin of addresses) {
      captureSecureEntry(capture, { kind: 'password', origin }, 'requested');
      captureSecureEntry(
        capture,
        { kind: 'card', origin, payment: { amount: 1234.5678, currency: 'EUR' } },
        'submitted',
      );
      captureSecureEntry(capture, { kind: 'otp', origin }, 'requested');
      const connection = {
        app: 'private_customer',
        endpoint: origin,
        connection_method: 'mcp' as const,
      };
      captureConnection(capture, connection, 'connected');
      await withServiceAnalytics(capture, connection, async () => ({ private: origin }));
    }
    const entries = captured.filter(({ event }) => event === 'secure_entry_changed');
    assert.equal(entries.length, 15);
    assert.deepEqual(
      new Set(entries.map(({ properties: { kind, status } }) => JSON.stringify({ kind, status }))),
      new Set(
        [
          { kind: 'sign_in', status: 'requested' },
          { kind: 'payment', status: 'submitted' },
          { kind: 'code', status: 'requested' },
        ].map((entry) => JSON.stringify(entry)),
      ),
    );
    const connections = captured.filter(({ event }) => event === 'connection_changed');
    assert.equal(connections.length, addresses.length);
    assert.ok(connections.every(({ properties }) => properties.app === 'custom'));
    const services = captured.filter(({ event }) => event === 'service_used');
    assert.equal(services.length, addresses.length);
    assert.ok(
      services.every(
        ({ properties }) =>
          properties.outcome === 'succeeded' && Number(properties.duration_ms) >= 0,
      ),
    );
    for (const value of [
      ...addresses,
      'example.co.uk',
      'private_customer',
      '1234',
      'EUR',
      'domain',
      'endpoint',
    ])
      assert.ok(!JSON.stringify(captured).includes(value), value);
    const count = captured.length;
    for (const event of [
      {
        event: 'nod_website_visited',
        properties: { domain: 'example.com', via: 'browser', subagent: false },
      },
      {
        event: 'secure_entry_changed',
        properties: { kind: 'payment', status: 'submitted', amount: 42 },
      },
      {
        event: 'connection_changed',
        properties: {
          app: 'custom',
          connection_method: 'mcp',
          status: 'connected',
          domain: 'example.com',
        },
      },
      { event: 'vault_imported', properties: { count: 1, domains: ['example.com'] } },
    ])
      capture(event as never);
    assert.equal(captured.length, count);
    analytics.setUsageData('owner-fixture', false);
    captureSecureEntry(capture, { kind: 'password', origin: addresses[0]! }, 'requested');
    captureConnection(
      capture,
      { connection_method: 'managed_app', app: 'gmail', publicApp: true },
      'connected',
    );
    assert.equal(captured.length, count);
  });

  test('system work attributes model and service costs without creating owner run activity', async () => {
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    const analytics = await createAnalytics({
      provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
      environment: 'development',
      dataRoot: '.',
      installationId: randomUUID(),
    });
    const owner = 'system-work-owner';
    analytics.setUsageData(owner, true);
    analytics.setUsageData('foreign-system-owner', true);
    const ledger = createLedger({
      pool: { query: async () => ({ rows: [] }) } as never,
      ownerId: owner,
      analytics: analytics.forOwner(owner),
    });
    const curator = ledger.curator({
      id: 'fixture',
      configured: true,
      async curate(_request, _signal, report) {
        await Promise.resolve();
        report?.({
          id: randomUUID(),
          provider: 'openai',
          model: 'fixture-small',
          costUsd: 0.02,
          inputTokens: 10,
          outputTokens: 2,
          durationMs: 8,
        });
        return {};
      },
    });
    const model = () =>
      curator.curate({ task: 'reflect', instructions: 'Synthetic task', input: {} });
    await Promise.all(
      (['memory_learning', 'onboarding', 'writing_style'] as const).map((activity) =>
        analytics.withSystemWork(owner, activity, async () => {
          await model();
          analytics.capture(owner, {
            event: 'service_used',
            properties: {
              app: 'gmail',
              connection_method: 'managed_app',
              outcome: 'succeeded',
              duration_ms: 4,
            },
          });
        }),
      ),
    );
    for (const activity of ['memory_learning', 'onboarding', 'writing_style']) {
      const events = captured.filter((event) => event.properties.system_activity === activity);
      assert.deepEqual(events.map((event) => event.event).sort(), ['model_used', 'service_used']);
      assert.ok(
        events.every(
          (event) =>
            event.properties.work_type === 'background' &&
            event.properties.owner_requested === false &&
            event.properties.run_id === undefined,
        ),
      );
    }
    await model();
    assert.equal(captured.at(-1)!.properties.work_type, 'unclassified');
    await analytics.withRun(owner, async () => {
      analytics.capture(owner, {
        event: 'turn_started',
        properties: {
          source: 'user',
          channel: 'web',
          background: false,
          work_type: 'immediate',
          owner_requested: true,
        },
      });
      await analytics.withSystemWork(owner, 'memory_learning', model);
    });
    assert.equal(captured.at(-1)!.properties.work_type, 'immediate');
    assert.equal(captured.at(-1)!.properties.owner_requested, true);
    assert.equal(captured.at(-1)!.properties.system_activity, undefined);
    assert.ok(captured.at(-1)!.properties.run_id);
    const before = captured.length;
    await analytics.withSystemWork(owner, 'onboarding', async () => {
      analytics.capture('foreign-system-owner', { event: 'chat_stopped' });
      analytics.setUsageData(owner, false);
      analytics.setUsageData(owner, true);
      await model();
    });
    assert.equal(captured.length, before);
    assert.equal(captured.filter((event) => event.event === 'turn_started').length, 1);
    assert.equal(captured.filter((event) => event.event === 'turn_completed').length, 0);
  });

  test('agent model usage analytics carry the request duration and cached input', async (t) => {
    const collector = Fastify();
    const spans: any[] = [];
    collector.post('/v1/traces', (request) => {
      spans.push(...(request.body as any).resourceSpans[0].scopeSpans[0].spans);
      return {};
    });
    const telemetry = createOtlpTelemetry(await collector.listen({ host: '127.0.0.1', port: 0 }))!;
    t.after(() => collector.close());
    t.after(() => telemetry.shutdown());
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    const analytics = await createAnalytics({
      provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
      environment: 'production',
      dataRoot: '.',
      installationId: randomUUID(),
    });
    analytics.setUsageData('owner-fixture', true);
    const ledger = createLedger({
      pool: { query: async () => ({ rows: [] }) } as never,
      ownerId: 'owner-fixture',
      analytics: analytics.forOwner('owner-fixture'),
      telemetry,
    });
    let subscription = false;
    const agent = ledger.agent({
      open: async (session) => ({
        resumed: false,
        abort() {},
        dispose() {},
        prompt: async () =>
          session.onEvent({
            type: 'model_usage',
            id: randomUUID(),
            provider: 'openai',
            model: 'gpt-6-luna',
            inputTokens: 20,
            outputTokens: 5,
            cacheReadTokens: 2000,
            cacheWriteTokens: 0,
            totalTokens: 2025,
            costUsd: subscription ? null : 0.001,
            ...(subscription ? { estimateUsd: 0.001 } : {}),
            costSource: subscription ? 'unavailable' : 'sdk_estimate',
            createdAt: new Date(Date.now() - 1_500).toISOString(),
          }),
      }),
      dispose() {},
    });
    const opened = await agent.open({ turnId: randomUUID(), onEvent() {} } as never);
    await analytics.withRun('owner-fixture', async () => {
      analytics.capture('owner-fixture', {
        event: 'turn_started',
        properties: {
          source: 'event',
          channel: 'web',
          background: true,
          work_type: 'background',
          owner_requested: false,
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
        },
      });
      await opened.prompt('Synthetic', []);
      analytics.capture('owner-fixture', {
        event: 'turn_completed',
        properties: {
          source: 'event',
          channel: 'web',
          background: true,
          work_type: 'background',
          owner_requested: false,
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          outcome: 'succeeded',
          duration_ms: 1_500,
        },
      });
    });
    const used = captured.find((event) => event.event === 'model_used')!;
    const started = captured.find((event) => event.event === 'turn_started')!;
    const completed = captured.find((event) => event.event === 'turn_completed')!;
    assert.ok(started);
    assert.ok(completed);
    assert.equal(started.properties.provider, 'anthropic');
    assert.equal(used.properties.provider, 'openai');
    assert.equal(completed.properties.provider, 'openai');
    assert.equal(completed.properties.model, 'gpt-6-luna');
    assert.equal(completed.properties.run_id, started.properties.run_id);
    assert.ok(captured.every(({ properties }) => !Object.hasOwn(properties, 'model_provider')));
    assert.equal(used.properties.run_id, started.properties.run_id);
    assert.equal(used.properties.work_type, 'background');
    assert.equal(used.properties.owner_requested, false);
    assert.equal(used.properties.input_tokens, 2020);
    assert.equal(used.properties.cached_input_tokens, 2000);
    assert.ok(Number(used.properties.duration_ms) >= 1_500);
    assert.equal(used.properties.pricing, 'api');
    subscription = true;
    await opened.prompt('Synthetic subscription usage', []);
    const plan = captured.filter(({ event }) => event === 'model_used').at(-1)!;
    assert.equal(plan.properties.pricing, 'plan_estimate');
    assert.equal(plan.properties.cost_usd, 0.001);
    analytics.setUsageData('owner-fixture', false);
    await opened.prompt('Synthetic private content', []);
    await telemetry.shutdown();
    assert.equal(spans.length, 3);
    assert.equal(spans[0].traceId, spans[1].traceId);
    assert.equal(captured.filter((event) => event.event === 'model_used').length, 2);
  });

  test('model usage analytics distinguish evidenced prices from unknown zero costs', async (t) => {
    const cases: {
      name: string;
      usage: Pick<ProviderUsageEvent, 'costUsd' | 'estimateUsd' | 'pricing'>;
      pricing: 'api' | 'plan_estimate' | 'unavailable';
      cost?: number;
    }[] = [
      {
        name: 'positive API estimate',
        usage: { costUsd: 0.0123456, pricing: 'sdk_estimate' },
        pricing: 'api',
        cost: 0.012346,
      },
      {
        name: 'positive API without pricing metadata',
        usage: { costUsd: 0.02 },
        pricing: 'api',
        cost: 0.02,
      },
      {
        name: 'positive plan estimate',
        usage: { costUsd: null, estimateUsd: 0.03, pricing: 'sdk_estimate' },
        pricing: 'plan_estimate',
        cost: 0.03,
      },
      { name: 'missing cost', usage: {}, pricing: 'unavailable' },
      { name: 'null cost', usage: { costUsd: null, estimateUsd: null }, pricing: 'unavailable' },
      { name: 'negative cost', usage: { costUsd: -1, estimateUsd: -2 }, pricing: 'unavailable' },
      {
        name: 'infinite cost',
        usage: { costUsd: Infinity, estimateUsd: Infinity },
        pricing: 'unavailable',
      },
      { name: 'NaN cost', usage: { costUsd: NaN, estimateUsd: NaN }, pricing: 'unavailable' },
      { name: 'unknown zero', usage: { costUsd: 0 }, pricing: 'unavailable' },
      { name: 'SDK zero', usage: { costUsd: 0, pricing: 'sdk_estimate' }, pricing: 'unavailable' },
      {
        name: 'reported zero',
        usage: { costUsd: 0, pricing: 'reported' },
        pricing: 'api',
        cost: 0,
      },
      {
        name: 'zero plan estimate',
        usage: { costUsd: null, estimateUsd: 0, pricing: 'sdk_estimate' },
        pricing: 'unavailable',
      },
      {
        name: 'reported zero plan estimate',
        usage: { costUsd: null, estimateUsd: 0, pricing: 'reported' },
        pricing: 'unavailable',
      },
      {
        name: 'unavailable zero',
        usage: { costUsd: 0, pricing: 'unavailable' },
        pricing: 'unavailable',
      },
      {
        name: 'unavailable positive API cost',
        usage: { costUsd: 0.04, pricing: 'unavailable' },
        pricing: 'unavailable',
      },
      {
        name: 'subscription plan estimate with unavailable API price',
        usage: { costUsd: null, estimateUsd: 0.05, pricing: 'unavailable' },
        pricing: 'plan_estimate',
        cost: 0.05,
      },
      {
        name: 'subscription zero plan estimate',
        usage: { costUsd: null, estimateUsd: 0, pricing: 'unavailable' },
        pricing: 'unavailable',
      },
      {
        name: 'tiny positive API cost',
        usage: { costUsd: 0.0000001, pricing: 'sdk_estimate' },
        pricing: 'api',
        cost: 0,
      },
      {
        name: 'tiny positive subscription estimate',
        usage: { costUsd: null, estimateUsd: 0.0000001, pricing: 'unavailable' },
        pricing: 'plan_estimate',
        cost: 0,
      },
    ];
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    const saved: unknown[][] = [];
    const analytics = await createAnalytics({
      provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
      environment: 'development',
      dataRoot: '.',
      installationId: randomUUID(),
    });
    t.after(() => analytics.shutdown());
    analytics.setUsageData('owner-fixture', true);
    const ledger = createLedger({
      pool: {
        query: async (sql: string, values: unknown[]) => {
          if (sql.startsWith('INSERT INTO model_usage')) saved.push(values);
          return { rows: [] };
        },
      } as never,
      ownerId: 'owner-fixture',
      analytics: analytics.forOwner('owner-fixture'),
    });
    let usage: ProviderUsageEvent;
    const agent = ledger.agent({
      open: async (session) => ({
        resumed: false,
        abort() {},
        dispose() {},
        prompt: async () => session.onEvent({ type: 'provider_usage', usage }),
      }),
      dispose() {},
    });
    const opened = await agent.open({ turnId: randomUUID(), onEvent() {} } as never);
    t.after(() => opened.dispose());
    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        usage = {
          id: randomUUID(),
          provider: 'openai',
          model: 'gpt-6-luna',
          category: 'agent',
          operation: 'request',
          status: 'succeeded',
          durationMs: 1,
          inputTokens: 20,
          outputTokens: 5,
          ...scenario.usage,
        };
        const before = captured.length;
        await opened.prompt('Synthetic usage fixture', []);
        assert.equal(captured.length, before + 1);
        const event = captured.at(-1)!;
        assert.equal(event.event, 'model_used');
        assert.equal(event.properties.provider, 'openai');
        assert.equal(event.properties.pricing, scenario.pricing);
        assert.equal(event.properties.cost_usd, scenario.cost);
        assert.equal(Object.hasOwn(event.properties, 'cost_usd'), scenario.cost !== undefined);
        const charge = scenario.usage.costUsd;
        assert.equal(
          saved.at(-1)![3],
          typeof charge === 'number' && Number.isFinite(charge) && charge >= 0 ? charge : null,
        );
      });
    }
  });
});

describe('keychain', () => {
  test('never creates a replacement Keychain key while sealed data exists', async () => {
    let adds = 0;
    let sealed = true;
    const store = createKeychainKeyStore({
      platform: 'darwin',
      canCreate: async () => !sealed,
      run: async (_command, args) => {
        if (args[0] === 'find-generic-password')
          throw Object.assign(new Error('not found'), { code: 44 });
        adds++;
        return { stdout: '' };
      },
    });
    await assert.rejects(store.getKey(), /missing/);
    assert.equal(adds, 0);
    sealed = false;
    assert.equal((await store.getKey()).length, 32);
    assert.equal(adds, 1);
  });
});

describe('filesystem Vault key', { skip: process.platform === 'win32' }, () => {
  test('concurrent instances publish one private key and decrypt after restart', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nod-vault-key-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await chmod(root, 0o755);
    const stores = Array.from({ length: 12 }, () =>
      createFilesystemKeyStore({ dataRoot: root, canCreate: async () => true }),
    );
    const keys = await Promise.all(stores.map((store) => store.getKey()));
    const path = join(root, 'vault', 'master-key');
    const saved = await readFile(path, 'utf8');
    assert.equal(Buffer.from(saved, 'base64').length, 32);
    for (const key of keys) assert.equal(key.toString('base64'), saved);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.equal((await lstat(join(root, 'vault'))).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(join(root, 'vault')), ['master-key']);
    const entry = { id: randomUUID(), owner_id: 'synthetic-owner', origin: 'https://example.test' };
    const secret = { username: 'synthetic@example.test', password: 'synthetic-secret' };
    const ciphertext = sealCredential(keys[0], entry, secret);
    keys[0].fill(0);
    assert.equal(keys[1].toString('base64'), saved);
    const alias = join(root, 'trusted-alias');
    await symlink(root, alias);
    const restored = createFilesystemKeyStore({
      dataRoot: alias,
      canCreate: async () => {
        throw new Error('An existing key must not need creation permission.');
      },
    });
    assert.deepEqual(openCredential(await restored.getKey(), { ...entry, ciphertext }), secret);
    assert.deepEqual(openCredential(await stores[0].getKey(), { ...entry, ciphertext }), secret);
  });
});

test('server model credentials reject invalid destinations and cloud accounts before startup', async () => {
  const { modelEnvironment } = await import('../src/server/composition.ts');
  const key = 'fixture-environment-key';
  const invalid: Record<string, string>[] = [
    { OPENAI_API_KEY: key, OPENAI_API_REGION: 'eu.example.test' },
    { OPENAI_API_KEY: key, OPENAI_API_REGION: '__proto__' },
    { AWS_BEARER_TOKEN_BEDROCK: key },
    { AWS_BEARER_TOKEN_BEDROCK: key, AWS_REGION: 'eu-west-1.example.test/path' },
    { AZURE_OPENAI_API_KEY: key },
    { AZURE_OPENAI_API_KEY: key, AZURE_OPENAI_ENDPOINT: 'https://fixture.example.test' },
    ...[
      'http://fixture.example.test',
      'https://user:secret@fixture.example.test',
      'https://fixture.example.test?key=other',
    ].map((endpoint) => ({
      AZURE_OPENAI_API_KEY: key,
      AZURE_OPENAI_ENDPOINT: endpoint,
      AZURE_OPENAI_MODEL: 'gpt-6.1-sol',
    })),
    {
      AZURE_OPENAI_API_KEY: key,
      AZURE_OPENAI_ENDPOINT: 'https://fixture.example.test',
      AZURE_OPENAI_MODEL: 'gpt-6.1-sol',
      AZURE_OPENAI_DEPLOYMENT: '../other-deployment',
    },
    { CLOUDFLARE_WORKERS_AI_API_KEY: key },
    { CLOUDFLARE_WORKERS_AI_API_KEY: key, CLOUDFLARE_ACCOUNT_ID: '../other-account' },
    { CLOUDFLARE_AI_GATEWAY_API_KEY: key, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) },
    {
      CLOUDFLARE_AI_GATEWAY_API_KEY: key,
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
      CLOUDFLARE_GATEWAY_ID: '../other-gateway',
    },
    { OPENAI_COMPATIBLE_BASE_URL: 'https://user:secret@fixture.example.test/v1' },
    { OPENAI_COMPATIBLE_BASE_URL: 'https://fixture.example.test/v1?key=other' },
  ];
  for (const environment of invalid)
    assert.throws(
      () => modelEnvironment(environment),
      (error: unknown) => error instanceof Error && !error.message.includes(key),
    );
  assert.deepEqual(
    modelEnvironment({
      OPENAI_API_KEY: ' ',
      HF_TOKEN: '\t',
      AWS_BEARER_TOKEN_BEDROCK: '',
      AWS_REGION: '../unused',
      OPENAI_COMPATIBLE_API_KEY: key,
    }).credentials,
    {},
  );
  assert.deepEqual(
    modelEnvironment({
      LLM_PROVIDER: 'compatible',
      OPENAI_COMPATIBLE_BASE_URL: 'http://192.168.1.5:8080/v1/',
      OPENAI_COMPATIBLE_API_KEY: key,
    }).credentials.compatible,
    { type: 'endpoint', url: 'http://192.168.1.5:8080/v1', key },
  );
});

test('adding a model key keeps the service reason and removes the key', async () => {
  const { createModelService } = await import('../src/server/models.ts');
  const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
  const key = 'fixture-add-key-reason';
  const secret = randomBytes(32);
  for (const [provider, status] of [
    ['openrouter', 429],
    ['mistral', 503],
  ] as const) {
    const service = createModelService({
      database: {} as pg.Pool,
      ownerId: 'fixture-add-key-owner',
      keyStore: { id: 'fixture', configured: true, getKey: async () => secret },
      backend: createPiModelBackend({
        fetch: async () =>
          Response.json(
            { message: `Synthetic ${key}` },
            { status, headers: { 'content-type': 'application/json' } },
          ),
      }),
      origin: 'http://127.0.0.1:4310',
    });
    await assert.rejects(service.addKey(provider, key), (error: Error) => {
      assert.ok(!error.message.includes(key));
      assert.ok(error.message.includes(`HTTP ${status}`));
      assert.match(error.message, /Synthetic \[redacted\]/);
      return true;
    });
  }
});

test('secret redaction finishes for long malformed Basic credentials', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { redactSecretText } from ${JSON.stringify(new URL('../src/server/redaction.ts', import.meta.url).href)};
       const tail = '='.repeat(300_000) + 'a';
       for (const token of [tail, Buffer.from('synthetic:synthetic').toString('base64') + tail]) {
         redactSecretText('Basic ' + token);
       }`,
    ],
    { timeout: 5000 },
  );
});

test('secret redaction hides every bearer token character', () => {
  assert.equal(
    redactSecretText('Rejected Bearer synthetic~private+token/1== for this client'),
    'Rejected [redacted] for this client',
  );
  const basic = Buffer.from('synthetic-user:synthetic-password').toString('base64');
  assert.equal(redactSecretText(`Rejected Basic ${basic}~tail`), 'Rejected [redacted]~tail');
});

test('secret redaction keeps valid tokens when another token is missing', () => {
  const secrets = [' fixture-access-token ', undefined, null, 42] as unknown as string[];
  const text = createTextRedactor(secrets);
  const error = createErrorRedactor(secrets);
  const redact = createRedactor(secrets);
  assert.equal(text('Using fixture-access-token.'), 'Using [redacted].');
  assert.equal(error('Failed for fixture-access-token.'), 'Failed for [redacted].');
  assert.equal(
    JSON.stringify(redact({ detail: 'fixture-access-token' })),
    '{"detail":"[redacted]"}',
  );
  secrets.push('fixture-refresh-token', undefined as unknown as string);
  assert.equal(text('fixture-access-token fixture-refresh-token'), '[redacted] [redacted]');
  assert.equal(error('fixture-refresh-token'), '[redacted]');
  assert.equal(
    JSON.stringify(redact({ detail: 'fixture-refresh-token' })),
    '{"detail":"[redacted]"}',
  );
});

test('compatible model discovery retains HTTP failures and private values through the connection route', async (t) => {
  const { createServer } = await import('node:http');
  const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
  const { createModelService } = await import('../src/server/models.ts');
  const key = String.raw`synthetic-discovery-key/with+private\value`;
  let expectedKey = key;
  const privateField = 'synthetic-private-unselected-response';
  const paths: string[] = [];
  let respond: (path: string) => { status: number; body: string; type?: string };
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${expectedKey}`);
    paths.push(request.url!);
    const result = respond(request.url!);
    response.writeHead(result.status, { 'content-type': result.type ?? 'application/json' });
    response.end(result.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const address = `${origin}/synthetic-private-server/v1`;
  const echoes = [key, encodeURIComponent(key), address, encodeURIComponent(address)];
  let transportFailure = false;
  let transportMessage = `Synthetic transport unavailable. ${echoes.join(' ')}`;
  const backend = createPiModelBackend({
    fetch: async (input, init) => {
      assert.equal(new URL(String(input)).origin, origin);
      if (transportFailure) throw new Error(transportMessage);
      return fetch(input, init);
    },
  });
  const database = new pg.Pool();
  const queries = t.mock.method(database, 'query', () => assert.fail('Unexpected database query.'));
  const connects = t.mock.method(database, 'connect', () =>
    assert.fail('Unexpected database connection.'),
  );
  const owner = createModelService({
    database,
    ownerId: 'synthetic-discovery-owner',
    keyStore: {
      id: 'synthetic-discovery-key-store',
      configured: true,
      getKey: async () => Buffer.alloc(32),
    },
    backend,
    origin,
  });
  const app = Fastify();
  owner.register(app);
  t.after(async () => {
    await app.close();
    await owner.close();
    await database.end();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    assert.equal(server.listening, false);
    assert.equal(queries.mock.callCount(), 0);
    assert.equal(connects.mock.callCount(), 0);
    assert.equal(database.totalCount, 0);
  });
  const cases = [
    {
      name: 'HTTP 401 object',
      status: 401,
      body: JSON.stringify({
        error: {
          message: `The credential was rejected. ${echoes.join(' ')}`,
          type: 'authentication_error',
          code: 'invalid_api_key',
          param: 'authorization',
          private: privateField,
        },
      }),
      expected: [/HTTP 401/, /authentication_error/, /invalid_api_key/, /authorization/],
    },
    {
      name: 'HTTP 503 string',
      status: 503,
      body: JSON.stringify({ error: `Synthetic catalog unavailable. ${echoes.join(' ')}` }),
      expected: [/HTTP 503/, /Synthetic catalog unavailable/],
    },
    {
      name: 'HTTP 429',
      status: 429,
      body: JSON.stringify({
        error: { message: 'Synthetic rate limit.', code: 'rate_limit_exceeded' },
      }),
      expected: [/HTTP 429/, /rate_limit_exceeded/],
    },
    {
      name: 'non-JSON HTTP failure',
      status: 503,
      body: `<html>${privateField} ${echoes.join(' ')}</html>`,
      type: 'text/html',
      expected: [/HTTP 503/, /Service Unavailable/],
    },
    {
      name: 'oversized HTTP JSON',
      status: 503,
      body: JSON.stringify({ error: { message: 'x'.repeat(17000) + privateField } }),
      expected: [/HTTP 503/],
    },
    {
      name: 'malformed HTTP 200 JSON',
      status: 200,
      body: `{"private":"${privateField}"`,
      expected: [/HTTP 200/, /invalid model list/i],
    },
    {
      name: 'wrong HTTP 200 shape',
      status: 200,
      body: JSON.stringify({ data: { private: privateField } }),
      expected: [/HTTP 200/, /invalid model list/i],
    },
  ];
  for (const item of cases)
    await t.test(item.name, async () => {
      paths.length = 0;
      respond = () => item;
      const result = await app.inject({
        method: 'POST',
        url: '/api/models/endpoints',
        payload: { url: address, key },
      });
      assert.equal(result.statusCode, 400);
      const error = result.json().error;
      for (const expected of item.expected) assert.match(error, expected);
      for (const value of [...echoes, privateField]) assert.ok(!error.includes(value));
      assert.doesNotMatch(error, /billing/i);
      assert.ok(error.length <= 2000);
      assert.deepEqual(paths, ['/synthetic-private-server/v1/models']);
      assert.equal(owner.view().connections.length, 0);
    });
  await t.test(
    'an endpoint key matching the HTTP status does not erase that trusted status',
    async () => {
      paths.length = 0;
      expectedKey = '401';
      respond = () => ({
        status: 401,
        body: JSON.stringify({
          error: { message: 'Synthetic credential rejected. marked-key: 401.' },
        }),
      });
      const result = await app.inject({
        method: 'POST',
        url: '/api/models/endpoints',
        payload: { url: address, key: expectedKey },
      });
      expectedKey = key;
      assert.equal(result.statusCode, 400);
      assert.match(result.json().error, /HTTP 401/);
      assert.match(result.json().error, /Synthetic credential rejected/);
      assert.doesNotMatch(result.json().error, /marked-key: 401/);
      assert.deepEqual(paths, ['/synthetic-private-server/v1/models']);
    },
  );
  await t.test('HTTP failures redact nested JSON key text before error bounds', async () => {
    paths.length = 0;
    respond = (path) => ({
      status: path.endsWith('/v1/models') ? 404 : 401,
      body: JSON.stringify({ error: { message: 'x'.repeat(870) + JSON.stringify({ echo: key }) } }),
    });
    const result = await app.inject({
      method: 'POST',
      url: '/api/models/endpoints',
      payload: { url: address.replace(/\/v1$/, ''), key },
    });
    assert.equal(result.statusCode, 400);
    assert.match(result.json().error, /HTTP 401/);
    assert.match(result.json().error, /HTTP 404/);
    assert.ok(!result.json().error.includes(key.slice(0, 16)));
    assert.ok(result.json().error.length <= 2000);
    assert.deepEqual(paths, [
      '/synthetic-private-server/models',
      '/synthetic-private-server/v1/models',
    ]);
  });
  for (const statuses of [
    [401, 404],
    [404, 503],
  ])
    await t.test(`two routes ${statuses.join('/')}`, async () => {
      paths.length = 0;
      respond = (path) => ({
        status: path.endsWith('/v1/models') ? statuses[1]! : statuses[0]!,
        body: JSON.stringify({ error: { message: 'Synthetic route failure.' } }),
      });
      const result = await app.inject({
        method: 'POST',
        url: '/api/models/endpoints',
        payload: { url: address.replace(/\/v1$/, ''), key },
      });
      assert.equal(result.statusCode, 400);
      for (const status of statuses)
        assert.match(result.json().error, new RegExp(`HTTP ${status}`));
      assert.deepEqual(paths, [
        '/synthetic-private-server/models',
        '/synthetic-private-server/v1/models',
      ]);
      assert.equal(owner.view().connections.length, 0);
    });
  await t.test(
    'transport failures retain their reason without submitted private values',
    async () => {
      paths.length = 0;
      transportFailure = true;
      const result = await app.inject({
        method: 'POST',
        url: '/api/models/endpoints',
        payload: { url: address, key },
      });
      transportFailure = false;
      assert.equal(result.statusCode, 400);
      assert.match(result.json().error, /Synthetic transport unavailable/);
      for (const value of echoes) assert.ok(!result.json().error.includes(value));
      assert.deepEqual(paths, []);
    },
  );
  for (const [index, currentKey] of [key, 'q/+', 'q"\\'].entries())
    await t.test(`transport masks every form of current endpoint key ${index + 1}`, async () => {
      paths.length = 0;
      const variants = [
        currentKey,
        JSON.stringify(currentKey).slice(1, -1),
        encodeURIComponent(currentKey),
      ];
      transportMessage = `Synthetic transport unavailable. ${variants.join(' ')}`;
      transportFailure = true;
      const result = await app.inject({
        method: 'POST',
        url: '/api/models/endpoints',
        payload: { url: address, key: currentKey },
      });
      transportFailure = false;
      assert.equal(result.statusCode, 400);
      assert.match(result.json().error, /Synthetic transport unavailable/);
      for (const value of variants) assert.ok(!result.json().error.includes(value));
      assert.deepEqual(paths, []);
    });
  await t.test(
    'a short key overlapping the endpoint URL cannot reveal its private path',
    async () => {
      paths.length = 0;
      const marker = 'synthetic-overlap-private-marker';
      const url = `${origin}/${marker}/v1`;
      transportMessage = `Synthetic transport unavailable. ${url} ${encodeURIComponent(url)}`;
      transportFailure = true;
      const result = await app.inject({
        method: 'POST',
        url: '/api/models/endpoints',
        payload: { url, key: 'http' },
      });
      transportFailure = false;
      assert.equal(result.statusCode, 400);
      assert.match(result.json().error, /Synthetic transport unavailable/);
      assert.ok(!result.json().error.includes(marker));
      assert.deepEqual(paths, []);
    },
  );
  await t.test('remembered text cannot split the current JSON key redaction', async () => {
    paths.length = 0;
    const prior = 'synthetic-prior-private-value';
    transportMessage = 'Synthetic transport unavailable.';
    transportFailure = true;
    const setup = await app.inject({
      method: 'POST',
      url: '/api/models/endpoints',
      payload: { url: address, key: prior },
    });
    const marker = 'synthetic-current-private-marker';
    const currentKey = `${marker}"${prior}\\tail`;
    transportMessage = `Synthetic transport unavailable. ${JSON.stringify(currentKey)}`;
    const result = await app.inject({
      method: 'POST',
      url: '/api/models/endpoints',
      payload: { url: address, key: currentKey },
    });
    transportFailure = false;
    assert.equal(setup.statusCode, 400);
    assert.equal(result.statusCode, 400);
    assert.match(result.json().error, /Synthetic transport unavailable/);
    assert.ok(!result.json().error.includes(marker));
    assert.deepEqual(paths, []);
  });
  await t.test('HTTP-looking transport prose does not acquire a trusted status', async () => {
    paths.length = 0;
    transportMessage = 'Synthetic transport unavailable. HTTP 401; marked-key: 401.';
    transportFailure = true;
    const result = await app.inject({
      method: 'POST',
      url: '/api/models/endpoints',
      payload: { url: address, key: '401' },
    });
    transportFailure = false;
    assert.equal(result.statusCode, 400);
    assert.match(result.json().error, /Synthetic transport unavailable/);
    assert.doesNotMatch(result.json().error, /HTTP 401|marked-key: 401/);
    assert.deepEqual(paths, []);
  });
  await t.test('concurrent catalogs keep each response status with its request', async () => {
    paths.length = 0;
    respond = (path) => ({
      status: path.includes('/first/') ? 401 : 503,
      body: JSON.stringify({ error: { message: 'Synthetic concurrent failure.' } }),
    });
    const results = await Promise.all(
      ['first', 'second'].map((name) =>
        app.inject({
          method: 'POST',
          url: '/api/models/endpoints',
          payload: { url: `${origin}/${name}/v1`, key },
        }),
      ),
    );
    assert.match(results[0]!.json().error, /HTTP 401/);
    assert.doesNotMatch(results[0]!.json().error, /HTTP 503/);
    assert.match(results[1]!.json().error, /HTTP 503/);
    assert.doesNotMatch(results[1]!.json().error, /HTTP 401/);
    assert.deepEqual(paths.sort(), ['/first/v1/models', '/second/v1/models']);
  });
  for (const firstStatus of [200, 404, 503])
    await t.test(`alternate catalog after HTTP ${firstStatus}`, async () => {
      paths.length = 0;
      respond = (path) =>
        path === '/synthetic-private-server/v1/models'
          ? {
              status: 200,
              body: JSON.stringify({
                data: [{ id: 'synthetic-local-model', context_length: 32768 }],
              }),
            }
          : { status: path === '/synthetic-private-server/models' ? firstStatus : 404, body: '{}' };
      const definitions = await backend.catalog('compatible', 'api_key', {
        type: 'endpoint',
        url: address.replace(/\/v1$/, ''),
        key,
      });
      assert.equal(definitions.length, 1);
      assert.equal(definitions[0]!.choice.id, 'synthetic-local-model');
      assert.equal(definitions[0]!.choice.contextWindow, 32768);
      assert.equal(definitions[0]!.spec.baseUrl, address);
      assert.deepEqual(paths.slice(0, 2), [
        '/synthetic-private-server/models',
        '/synthetic-private-server/v1/models',
      ]);
      assert.deepEqual(paths.slice(2).sort(), [
        '/synthetic-private-server/api/v1/models',
        '/synthetic-private-server/api/version',
      ]);
    });
});

describe('model connections', { skip: !process.env.TEST_DATABASE_URL }, () => {
  async function fixture(t: import('node:test').TestContext) {
    const { createModelService } = await import('../src/server/models.ts');
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    const schema = `test_models_${randomUUID().replaceAll('-', '')}`;
    const root = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await root.query(`CREATE SCHEMA ${schema}`);
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
      max: 2,
    });
    const key = randomBytes(32);
    const keyStore = { id: 'fixture', configured: true, getKey: async () => key };
    const backend = createPiModelBackend({
      fetch: async (input) => {
        assert.equal(String(input), 'https://api.openai.com/v1/models');
        return Response.json({ data: ['gpt-6.1-sol', 'gpt-6-luna'].map((id) => ({ id })) });
      },
    });
    const services: ReturnType<typeof createModelService>[] = [];
    const create = async (
      ownerId: string,
      selectedBackend = backend,
      bootstrap?: Parameters<typeof createModelService>[0]['bootstrap'],
    ) => {
      const service = createModelService({
        database,
        ownerId,
        keyStore,
        backend: selectedBackend,
        origin: 'http://127.0.0.1:4310',
        bootstrap,
      });
      await service.initialize();
      services.push(service);
      return service;
    };
    t.after(async () => {
      for (const service of services) await service.close();
      await database.end();
      await root.query(`DROP SCHEMA ${schema} CASCADE`);
      await root.end();
    });
    return { create, database, backend, keyStore };
  }

  function subscriptionCredential(expires = Date.now() + 3600000) {
    return {
      type: 'oauth' as const,
      access: 'fixture-access',
      refresh: 'fixture-refresh',
      expires,
      accountId: 'fixture-account',
      clientId: 'fixture-client',
      idToken: 'fixture-id-token',
    };
  }

  test(
    'model setup returns while checks run and shows only the current result',
    { timeout: 10_000 },
    async (t) => {
      const f = await fixture(t);
      const definitions = await f.backend.catalog('openai', 'api_key');
      const key = 'fixture-background-model-key';
      const state = 'fixture-background-sign-in-state-12345';
      const owner = await f.create('fixture-background-model-owner', {
        ...f.backend,
        catalog: async () => definitions,
        connectKey: async (_provider, credential) => ({ credential, models: definitions }),
        authorize: () => ({ url: 'https://model.example/sign-in', state, secret: {} }),
        exchange: async () => ({ type: 'api_key', key: 'fixture-background-oauth-key' }),
      });
      const checks: { resolve(): void; reject(error: Error): void }[] = [];
      await owner.setSelectionCheck(() => {
        return new Promise<void>((resolve, reject) => checks.push({ resolve, reject }));
      });
      const app = Fastify();
      owner.register(app);
      t.after(async () => {
        for (const check of checks) check.resolve();
        await app.close();
      });
      const saved = await app.inject({
        method: 'POST',
        url: '/api/models/keys',
        payload: { provider: 'openai', key },
      });
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(owner.current.checking, true);
      assert.equal(checks.length, 1);

      const endpoint = await app.inject({
        method: 'POST',
        url: '/api/models/endpoints',
        payload: { url: 'http://localhost:11434/v1' },
      });
      assert.equal(endpoint.statusCode, 200, endpoint.body);
      const selection = owner.view().selection!;
      const selected = await app.inject({
        method: 'PUT',
        url: '/api/models/selection',
        payload: selection,
      });
      assert.equal(selected.statusCode, 200, selected.body);
      assert.equal(checks.length, 2);
      checks[0]!.reject(new Error('Synthetic old model failure.'));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(owner.current.checking, true);
      assert.equal(owner.current.issue, undefined);

      checks[1]!.reject(new Error(`HTTP 503: Synthetic service unavailable. ${key}`));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(owner.current.checking, false);
      assert.match(owner.current.issue!.reason, /HTTP 503: Synthetic service unavailable/);
      assert.doesNotMatch(owner.current.issue!.reason, /fixture-background-model-key/);
      assert.deepEqual(owner.view().selectionIssue, owner.current.issue);
      const access = await owner.resolve();
      const complete = await access.prepareRequest!(selection.modelId, false);
      await complete();
      assert.equal(owner.current.issue, undefined);

      await owner.select(selection);
      const signIn = await app.inject({
        method: 'POST',
        url: '/api/models/oauth',
        payload: { provider: 'openrouter' },
      });
      assert.equal(signIn.statusCode, 200, signIn.body);
      const signedIn = await app.inject({
        method: 'POST',
        url: '/api/models/oauth/complete',
        payload: {
          url: `http://127.0.0.1:4310/api/models/oauth/callback?state=${state}&code=fixture-code`,
        },
      });
      assert.equal(signedIn.statusCode, 200, signedIn.body);
      assert.equal(owner.current.checking, true);
      checks.at(-1)!.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(owner.current.checking, false);
      assert.equal(owner.current.issue, undefined);

      const connectionId = owner
        .view()
        .connections.find((row) => row.provider === 'compatible')!.id;
      await owner.select({ ...selection, connectionId });
      const previous = await owner.resolve();
      const completePrevious = await previous.prepareRequest!(selection.modelId, false);
      assert.equal(
        await owner.addEndpoint('http://localhost:11434/v1', 'fixture-replacement-endpoint-key'),
        connectionId,
      );
      checks.at(-1)!.reject(new Error('Synthetic new credential failure.'));
      await new Promise((resolve) => setImmediate(resolve));
      const issue = owner.view().selectionIssue;
      assert.match(issue!.reason, /Synthetic new credential failure/);
      await completePrevious('HTTP 401; Synthetic expired key.', 401);
      assert.equal(
        owner.view().connections.find((row) => row.id === connectionId)!.status,
        'connected',
      );
      await completePrevious();
      assert.deepEqual(owner.current.issue, issue);
      const current = await owner.resolve();
      const completeCurrent = await current.prepareRequest!(selection.modelId, false);
      await completeCurrent();
      assert.equal(owner.current.issue, undefined);
    },
  );

  test('OpenAI connections keep their regions through selection, refresh and restart', async (t) => {
    const f = await fixture(t);
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    const { keyConnection, noKeySettings } = await import('../src/web/hooks/use-models.ts');
    const key = 'fixture-regional-openai-key';
    const requests: string[] = [];
    const backend = createPiModelBackend({
      fetch: async (input, init) => {
        requests.push(String(input));
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`);
        return Response.json({
          data: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-audio-1.5'].map((id) => ({ id })),
        });
      },
    });
    const owner = await f.create('fixture-openai-region-owner', backend);
    const app = Fastify();
    owner.register(app);
    t.after(() => app.close());
    for (const region of ['global', 'eu']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/models/keys',
        payload: keyConnection('openai', key, { ...noKeySettings, region }),
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(!response.body.includes(key));
    }
    assert.equal(owner.view().connections.length, 2);
    const eu = owner.view().connections.find((row) => row.label.includes('Europe'))!;
    assert.ok(eu);
    await owner.select({ connectionId: eu.id, modelId: 'gpt-6.1-sol', effort: 'high' });
    assert.equal((await owner.resolve()).definition.spec.baseUrl, 'https://eu.api.openai.com/v1');
    assert.equal(
      (await owner.resolve(true)).definition.spec.baseUrl,
      'https://eu.api.openai.com/v1',
    );
    assert.deepEqual(await owner.apiCredential('openai'), { type: 'api_key', key, region: 'eu' });
    await owner.refreshCatalog(eu.id);
    await owner.select({ connectionId: eu.id, modelId: 'gpt-audio-1.5', effort: 'off' });
    const audio = await owner.resolve();
    assert.equal(audio.textModel?.definition.spec.baseUrl, 'https://eu.api.openai.com/v1');
    const restored = await f.create('fixture-openai-region-owner', backend);
    assert.deepEqual(await restored.apiCredential('openai'), {
      type: 'api_key',
      key,
      region: 'eu',
    });
    assert.equal(
      (await restored.resolve()).definition.spec.baseUrl,
      'https://eu.api.openai.com/v1',
    );
    await restored.addKey('openai', key, { region: 'eu' });
    assert.equal(restored.view().connections.length, 2);
    const other = await f.create('fixture-openai-other-owner', backend);
    assert.equal(await other.apiCredential('openai'), undefined);
    const rows = (await f.database.query('SELECT * FROM model_connections')).rows;
    assert.ok(!JSON.stringify(rows).includes(key));
    assert.deepEqual(requests, [
      'https://api.openai.com/v1/models',
      'https://eu.api.openai.com/v1/models',
      'https://eu.api.openai.com/v1/models',
      'https://eu.api.openai.com/v1/models',
    ]);
  });

  test('incomplete saved credentials do not break redaction for the selected connection', async (t) => {
    const f = await fixture(t);
    const ownerId = 'fixture-incomplete-subscription';
    const owner = await f.create(ownerId);
    await owner.addKey('openai', 'fixture-selected-model-key');
    const { createDatabaseModelStore } = await import('../src/server/model-store.ts');
    const store = createDatabaseModelStore({
      database: f.database,
      ownerId,
      keyStore: f.keyStore,
    });
    await store.initialize();
    const { idToken: _, ...saved } = subscriptionCredential();
    await store.change((state) => {
      state.connections.push({
        id: randomUUID(),
        provider: 'openai',
        method: 'subscription',
        label: 'Synthetic older subscription',
        status: 'reconnect',
        models: [],
        managed: false,
        credential: saved as import('../src/ports/models.ts').ModelCredential,
      });
      for (const [type, provider] of [
        ['api_key', 'openai'],
        ['endpoint', 'compatible'],
        ['bedrock', 'amazon-bedrock'],
        ['cloudflare', 'cloudflare-workers-ai'],
        ['azure', 'azure'],
      ] as const)
        for (const key of [undefined, null, 42, '', 'a', 'ab', 'abc', 'abcd'])
          state.connections.push({
            id: randomUUID(),
            provider,
            method: 'api_key',
            label: 'Synthetic incomplete key',
            status: 'reconnect',
            models: [],
            managed: false,
            credential: {
              type,
              key,
            } as unknown as import('../src/ports/models.ts').ModelCredential,
          });
      for (const [provider, credential] of [
        [
          'compatible',
          { type: 'endpoint', url: 'http://127.0.0.1:1/v1', key: 'fixture-endpoint-key-ab12' },
        ],
        [
          'azure',
          {
            type: 'azure',
            url: 'https://fixture.example.test/openai/v1',
            model: 'fixture-model',
            deployment: 'fixture-deployment',
            key: 'fixture-azure-key-cd34',
          },
        ],
      ] as const)
        state.connections.push({
          id: randomUUID(),
          provider,
          method: 'api_key',
          label: `Synthetic keyed ${credential.type}`,
          status: 'reconnect',
          models: [],
          managed: false,
          credential,
        });
    });
    const restored = await f.create(ownerId);
    assert.ok(
      restored
        .view()
        .connections.filter((row) => row.label === 'Synthetic incomplete key')
        .every((row) => row.keyEnding === undefined),
    );
    for (const [label, ending] of [
      ['Synthetic keyed endpoint', 'ab12'],
      ['Synthetic keyed azure', 'cd34'],
    ])
      assert.equal(
        restored.view().connections.find((row) => row.label === label)?.keyEnding,
        ending,
      );
    const secrets: string[] = [];
    restored.onSecrets((values) => secrets.push(...values));
    assert.equal(
      createTextRedactor(secrets)('Using fixture-selected-model-key and fixture-access.'),
      'Using [redacted] and [redacted].',
    );
    assert.ok(secrets.every((secret) => typeof secret === 'string' && secret.length > 0));
    assert.deepEqual(await (await restored.resolve()).read(), {
      type: 'api_key',
      key: 'fixture-selected-model-key',
    });
  });

  function stubSignIn(
    exchange: () => Promise<import('../src/ports/models.ts').ModelCredential>,
    aborted?: () => void,
  ): import('../src/ports/models.ts').ModelBackend['signIn'] {
    return async ({ signal }) => {
      const state = randomBytes(16).toString('hex');
      let resolve!: (value: import('../src/ports/models.ts').ModelCredential) => void;
      let reject!: (error: Error) => void;
      const result = new Promise<import('../src/ports/models.ts').ModelCredential>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      signal.addEventListener(
        'abort',
        () => {
          aborted?.();
          reject(new Error('Sign-in cancelled.'));
        },
        { once: true },
      );
      return {
        url: `https://auth.openai.com/authorize?state=${state}`,
        state,
        result,
        complete(callback) {
          assert.equal(callback.searchParams.get('state'), state);
          void exchange().then(resolve, reject);
        },
      };
    };
  }

  test('OpenRouter lists token rates from the saved catalog without exposing its model configuration', async (t) => {
    const f = await fixture(t);
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    const ownerId = 'fixture-router-prices';
    const backend = createPiModelBackend({
      fetch: async (input) => {
        if (String(input) === 'https://openrouter.ai/api/v1/key')
          return Response.json({ data: { is_management_key: false } });
        assert.equal(String(input), 'https://openrouter.ai/api/v1/models');
        return Response.json({
          data: [
            ['fixture/paid', '0.00000125', '0.000005'],
            ['fixture/small', '0.00000000001', '0.00000000002'],
            ['fixture/free', '0', '0'],
            ['openrouter/auto', '0', '0'],
            ['fixture/variable', '-1', '-1'],
          ].map(([id, prompt, completion]) => ({
            id,
            name: id,
            context_length: 128000,
            supported_parameters: ['tools'],
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
            pricing: { prompt, completion },
          })),
        });
      },
    });
    const owner = await f.create(ownerId, backend);
    const id = await owner.addKey('openrouter', 'fixture-router-price-key');
    const saved = await f.create(ownerId, backend);
    const models = saved.view().connections[0].models;
    assert.deepEqual(
      models.filter((model) => model.id !== 'fixture/small').map((model) => model.pricing),
      [
        { input: 1.25, output: 5, cacheRead: 0, cacheWrite: 0 },
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        'variable',
        'variable',
      ],
    );
    const small = models[1].pricing;
    assert.ok(small && small !== 'variable');
    assert.ok(Math.abs(small.input - 0.00001) < 1e-12);
    assert.ok(Math.abs(small.output - 0.00002) < 1e-12);
    assert.ok(models.every((model) => !('spec' in model)));
    const tier = { inputTokensAbove: 100_000, input: 3, output: 6, cacheRead: 1, cacheWrite: 3 };
    await f.database.query(
      `UPDATE model_connections SET models=jsonb_set(
        jsonb_set(models,'{0,spec,cost,tiers}',$3),'{1,spec,cost,tiers}',$4
      ) WHERE id=$1 AND owner_id=$2`,
      [
        id,
        ownerId,
        JSON.stringify([tier]),
        JSON.stringify([
          tier,
          {
            ...tier,
            inputTokensAbove: 120_000,
            cacheWrite: -1,
          },
        ]),
      ],
    );
    const tiered = await f.create(ownerId, backend);
    const [paidTier, variableTier] = tiered.view().connections[0].models;
    assert.deepEqual(paidTier.pricing, {
      input: 1.25,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      tiers: [tier],
    });
    assert.equal(variableTier.pricing, 'variable');
    await f.database.query(
      `UPDATE model_connections SET models=jsonb_set(models,'{0,spec,cost,input}','"invalid"') WHERE id=$1 AND owner_id=$2`,
      [id, ownerId],
    );
    const invalid = await f.create(ownerId, backend);
    assert.equal(invalid.view().connections[0].models[0].pricing, undefined);
  });

  test('ElevenLabs keys stay encrypted and owned without becoming a selectable chat model', async (t) => {
    const f = await fixture(t);
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    const { modelEnvironment } = await import('../src/server/composition.ts');
    const secret = 'fixture-elevenlabs-owned-secret';
    const backend = createPiModelBackend({
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.origin === 'https://api.elevenlabs.io') {
          assert.equal(new Headers(init?.headers).get('xi-api-key'), secret);
          return Response.json({
            voices: [{ voice_id: 'fixture_custom_voice', name: 'Synthetic custom voice' }],
            has_more: false,
          });
        }
        assert.equal(url.href, 'https://api.openai.com/v1/models');
        return Response.json({ data: [{ id: 'gpt-6.1-sol' }] });
      },
    });
    const owner = await f.create('fixture-speech-owner', backend);
    const speechId = await owner.addKey('elevenlabs', secret);
    assert.equal(owner.hasApiKey('elevenlabs'), true);
    assert.equal(await owner.apiKey('elevenlabs'), secret);
    assert.equal(owner.configured, false);
    assert.equal(owner.current.configured, false);
    assert.equal(owner.view().selection, null);
    assert.deepEqual(owner.view().connections[0].models, []);
    assert.deepEqual(owner.analyticsConnections(), []);
    await assert.rejects(owner.resolve());
    await assert.rejects(
      owner.select({ connectionId: speechId, modelId: 'eleven_v4', effort: 'off' }),
    );
    assert.doesNotMatch(JSON.stringify(owner.view()), /fixture-elevenlabs-owned-secret/);
    assert.doesNotMatch(
      JSON.stringify((await f.database.query('SELECT * FROM model_connections')).rows),
      /fixture-elevenlabs-owned-secret/,
    );
    assert.doesNotMatch(
      JSON.stringify((await f.database.query('SELECT * FROM vault_app_grants')).rows),
      /fixture-elevenlabs-owned-secret/,
    );
    const other = await f.create('fixture-other-speech-owner', backend);
    assert.equal(await other.apiKey('elevenlabs'), undefined);
    await other.remove(speechId);
    assert.equal(await owner.apiKey('elevenlabs'), secret);
    const chatId = await owner.addKey('openai', 'fixture-openai-key');
    const selected = owner.view().selection;
    assert.equal(selected?.connectionId, chatId);
    await owner.refreshCatalog(speechId);
    assert.deepEqual(owner.view().selection, selected);
    assert.equal(owner.configured, true);
    const reloaded = await f.create('fixture-speech-owner', backend);
    assert.equal(await reloaded.apiKey('elevenlabs'), secret);
    assert.deepEqual(reloaded.view().selection, selected);
    await reloaded.remove(speechId);
    assert.equal(await reloaded.apiKey('elevenlabs'), undefined);
    assert.deepEqual(reloaded.view().selection, selected);
    assert.throws(() => modelEnvironment({ LLM_PROVIDER: 'elevenlabs' }));
    const managed = await f.create(
      'fixture-managed-speech-owner',
      backend,
      modelEnvironment({ ELEVENLABS_API_KEY: secret }),
    );
    assert.equal(managed.hasApiKey('elevenlabs'), true);
    assert.equal(managed.view().connections[0].managed, true);
    assert.equal(managed.configured, false);
    assert.equal(managed.view().selection, null);
  });

  test('every environment model connection resolves only its managed credential and loses access after removal', async (t) => {
    const f = await fixture(t);
    const { modelEnvironment } = await import('../src/server/composition.ts');
    const { apiKeyModelProviders, modelProviderInfo } = await import('../src/shared/models.ts');
    const environment = {
      ...Object.fromEntries(
        apiKeyModelProviders.map((provider) => [
          modelProviderInfo[provider].env,
          `  fixture-environment-${provider}-key  `,
        ]),
      ),
      ANTHROPIC_WORKSPACE_ID: '  wrkspc_Managed123  ',
      AWS_REGION: 'eu-west-1',
      AZURE_OPENAI_ENDPOINT: 'https://fixture.example.test',
      AZURE_OPENAI_MODEL: 'gpt-6.1-sol',
      AZURE_OPENAI_DEPLOYMENT: 'fixture-deployment',
      CLOUDFLARE_ACCOUNT_ID: 'ABCDEF0123456789ABCDEF0123456789',
      CLOUDFLARE_GATEWAY_ID: 'fixture-gateway',
    };
    const backend = {
      ...f.backend,
      catalog: (provider: import('../src/shared/models.ts').ModelProvider) =>
        f.backend.catalog(provider, 'api_key'),
    };
    const owner = await f.create(
      'fixture-environment-owner',
      backend,
      modelEnvironment(environment),
    );
    const captured: import('../src/ports/models.ts').ModelAccess[] = [];
    assert.equal(owner.view().connections.length, apiKeyModelProviders.length);
    assert.equal((await owner.resolve()).provider, 'openai');
    for (const provider of apiKeyModelProviders) {
      const row = owner.view().connections.find((item) => item.provider === provider)!;
      assert.equal(row.managed, true, provider);
      assert.equal(row.status, 'connected', provider);
      const choice = row.models[0];
      await owner.select({ connectionId: row.id, modelId: choice.id, effort: choice.efforts[0] });
      const access = await owner.resolve();
      captured.push(access);
      const credential = await access.read();
      const key = `fixture-environment-${provider}-key`;
      assert.equal(access.provider, provider);
      assert.deepEqual(
        credential,
        provider === 'amazon-bedrock'
          ? { type: 'bedrock', key, region: 'eu-west-1' }
          : provider === 'azure'
            ? {
                type: 'azure',
                key,
                url: 'https://fixture.example.test/openai/v1',
                model: 'gpt-6.1-sol',
                deployment: 'fixture-deployment',
              }
            : provider.startsWith('cloudflare-')
              ? {
                  type: 'cloudflare',
                  key,
                  accountId: 'abcdef0123456789abcdef0123456789',
                  ...(provider === 'cloudflare-ai-gateway' ? { gatewayId: 'fixture-gateway' } : {}),
                }
              : {
                  type: 'api_key',
                  key,
                  ...(provider === 'anthropic' ? { workspaceId: 'wrkspc_Managed123' } : {}),
                },
      );
    }
    assert.doesNotMatch(JSON.stringify(owner.view()), /fixture-environment-/);
    assert.doesNotMatch(
      JSON.stringify((await f.database.query('SELECT * FROM model_connections')).rows),
      /fixture-environment-.*-key/,
    );
    assert.equal((await f.database.query('SELECT * FROM vault_app_grants')).rowCount, 0);
    const removed = await f.create('fixture-environment-owner', backend, modelEnvironment({}));
    assert.deepEqual(removed.view(), { connections: [], selection: null, routes: {}, light: null });
    await assert.rejects(removed.resolve());
    for (const access of captured) assert.equal(await access.read(), undefined);
  });

  test('model refresh and saved connections repair unsupported efforts and keep valid selections', async (t) => {
    const f = await fixture(t);
    const definition = (await f.backend.catalog('openrouter', 'api_key')).find(
      (model) => model.choice.id === 'openrouter/free',
    )!;
    let updated = false;
    let empty = false;
    const owner = await f.create('fixture-refreshed-effort', {
      ...f.backend,
      catalog: async () => [
        {
          ...definition,
          choice: {
            ...definition.choice,
            efforts: empty ? [] : updated ? ['minimal', 'low', 'medium', 'high'] : ['off', 'high'],
          },
        },
      ],
    });
    const id = await owner.addKey('openrouter', 'fixture-refreshed-key');
    for (const replace of [
      () => owner.refreshCatalog(id),
      () => owner.addKey('openrouter', 'fixture-refreshed-key'),
    ]) {
      updated = false;
      await replace();
      await owner.select({ connectionId: id, modelId: 'openrouter/free', effort: 'off' });
      updated = true;
      await replace();
      assert.deepEqual(owner.view().selection, {
        connectionId: id,
        modelId: 'openrouter/free',
        effort: 'minimal',
      });
      assert.equal((await owner.resolve()).effort, 'minimal');
      await owner.select({ connectionId: id, modelId: 'openrouter/free', effort: 'high' });
      await replace();
      assert.equal((await owner.resolve()).effort, 'high');
    }
    empty = true;
    await owner.refreshCatalog(id);
    assert.equal(owner.view().selection?.effort, 'high');
    await assert.rejects(owner.resolve());
  });

  test('a model request failure that Pi does not retry pauses automatic requests to that model, tries again after a growing wait, clears on success, and a rejected key needs reconnecting', async (t) => {
    const f = await fixture(t);
    const { createPiMemoryCurator } = await import('../src/providers/pi/memory-curator.ts');
    const { createPiModelRuntime } = await import('../src/providers/pi/models.ts');
    const { lightestEffort } = await import('../src/shared/models.ts');
    const definitions = (await f.backend.catalog('mistral', 'api_key')).map((item) => ({
      ...item,
      spec: { ...item.spec, api: 'openai-completions', baseUrl: 'https://model.example/v1' },
    }));
    const backend = { ...f.backend, catalog: async () => definitions };
    let service = await f.create('fixture-failing-owner', backend);
    service.setRequestBudget(async () => async () => {});
    let checks = 0;
    await service.setSelectionCheck(async () => {
      checks++;
    });
    const connectionId = await service.addKey('mistral', 'fixture-failing-key');
    assert.equal(checks, 1);
    const other = await f.create('fixture-healthy-owner', backend);
    other.setRequestBudget(async () => async () => {});
    await other.addKey('mistral', 'fixture-healthy-key');
    const original = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = original;
    });
    const healthy = () =>
      new Response(
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"{\\"ready\\":true}"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    let reply = (): Response =>
      Response.json({ error: { message: 'Synthetic outage.' } }, { status: 503 });
    let calls = 0;
    globalThis.fetch = async (input) => {
      assert.ok(String(input).startsWith('https://model.example/'));
      calls++;
      return reply();
    };
    const ask = async () => {
      const { runtime, model } = await createPiModelRuntime(await service.resolve());
      return runtime.completeSimple(model, {
        messages: [{ role: 'user', content: 'Synthetic question.', timestamp: 1 }],
      });
    };
    const curator = createPiMemoryCurator({
      provider: 'mistral',
      resolve: () => service.resolve(),
    });
    const request = {
      task: 'plan' as const,
      instructions: 'Prepare the synthetic task.',
      input: {},
    };
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const first = service.view().selection!;
    const definition = definitions.find((item) => item.choice.id !== first.modelId)!;
    const second = {
      connectionId,
      modelId: definition.choice.id,
      effort: lightestEffort(definition.choice.efforts),
    };
    const allowed = (schedule = first) =>
      service.automaticRequestsAllowed({ kind: 'schedule', schedule });

    assert.equal((await ask()).stopReason, 'error');
    assert.equal(calls, 1);
    assert.equal(service.view().connections[0]!.issue, undefined);
    assert.equal(await allowed(), true);

    reply = () =>
      Response.json(
        { error: { code: 402, message: 'This request requires more credits.' } },
        { status: 402 },
      );
    const noCredits = reply;
    assert.equal((await ask()).stopReason, 'error');
    assert.equal(calls, 2);
    assert.match(
      service.view().connections[0]!.issue!.reason,
      /HTTP 402; This request requires more credits\./,
    );
    assert.match(service.current.issue!.reason, /requires more credits/);
    assert.deepEqual(service.view().selectionIssue, service.current.issue);
    assert.equal(service.view().connections[0]!.status, 'connected');
    assert.equal(await allowed(), false);
    assert.equal(await allowed(second), true);
    assert.equal(service.paused({ kind: 'schedule', schedule: first }), true);
    assert.equal(service.paused({ kind: 'schedule', schedule: second }), false);
    assert.equal(
      service.paused({ kind: 'schedule', schedule: { ...first, modelId: 'fixture-missing' } }),
      false,
    );
    await assert.rejects(curator.curate(request), /Automatic requests to this model are paused/);
    assert.equal(calls, 2);
    const ledger = createLedger({
      pool: { query: async () => ({ rows: [] }) } as never,
      ownerId: 'fixture-failing-owner',
    });
    await assert.rejects(ledger.curator(curator).curate(request), /paused/);
    assert.equal(calls, 2);
    await assert.rejects(
      ledger.forOwner(() => ledger.curator(curator).curate(request)),
      /requires more credits/,
    );
    assert.equal(calls, 3);
    assert.equal(await allowed(), false);
    assert.equal(await other.automaticRequestsAllowed({ kind: 'background' }, true), true);
    assert.doesNotMatch(
      JSON.stringify(service.view()),
      /credentialTag|requestFailures|fixture-failing-key/,
    );

    await service.close();
    service = await f.create('fixture-failing-owner', backend);
    service.setRequestBudget(async () => async () => {});
    await service.setSelectionCheck(async () => {
      checks++;
    });
    assert.equal(await allowed(), false);
    t.mock.timers.tick(120_001);
    assert.equal(await allowed(), true);
    await assert.rejects(curator.curate(request), /requires more credits/);
    assert.equal(calls, 4);
    t.mock.timers.tick(120_001);
    assert.equal(await allowed(), false);
    t.mock.timers.tick(240_000);
    assert.equal(await allowed(), true);
    await assert.rejects(curator.curate(request), /requires more credits/);
    assert.equal(calls, 5);
    assert.equal(await allowed(), false);

    assert.equal(checks, 2);
    await service.select(second);
    assert.equal(checks, 3);
    assert.equal(service.current.issue, undefined);
    assert.equal(service.view().selectionIssue, undefined);
    assert.match(service.view().connections[0]!.issue!.reason, /requires more credits/);
    reply = healthy;
    assert.equal((await ask()).stopReason, 'stop');
    assert.equal(calls, 6);
    assert.equal(await allowed(), false);
    reply = noCredits;
    assert.equal((await ask()).stopReason, 'error');
    assert.equal(calls, 7);
    assert.match(service.current.issue!.reason, /requires more credits/);
    reply = healthy;
    assert.equal((await ask()).stopReason, 'stop');
    assert.equal(calls, 8);
    assert.equal(service.current.issue, undefined);
    assert.equal(await allowed(), true);
    assert.match(service.view().connections[0]!.issue!.reason, /requires more credits/);
    await service.select(first);
    assert.equal(checks, 4);
    await service.select(first);
    assert.equal(checks, 5);
    assert.deepEqual(await curator.curate(request), { ready: true });
    assert.equal(calls, 9);
    assert.equal(service.view().connections[0]!.issue, undefined);
    assert.equal(service.current.issue, undefined);

    reply = () => Response.json({ error: { message: 'API key expired.' } }, { status: 401 });
    assert.equal((await ask()).stopReason, 'error');
    assert.equal(calls, 10);
    assert.equal(service.view().connections[0]!.status, 'reconnect');
    assert.match(service.current.issue!.reason, /API key expired/);
    assert.equal(service.configured, false);
    await assert.rejects(ask(), /add it again/);
    assert.equal(calls, 10);
  });

  test('model setup chooses capable defaults, preserves explicit choices and requires valid cloud accounts', async (t) => {
    const f = await fixture(t);
    const backend = {
      ...f.backend,
      catalog: (provider: import('../src/shared/models.ts').ModelProvider) =>
        f.backend.catalog(provider, 'api_key'),
    };
    const google = await f.create('fixture-google-default', backend);
    await google.addKey('google', 'fixture-google-key');
    assert.equal(google.view().selection?.modelId, 'gemini-4-argon');
    assert.equal(google.view().selection?.effort, 'medium');
    const chosen = google.view().selection!;
    await google.addKey('mistral', 'fixture-mistral-key');
    assert.deepEqual(google.view().selection, chosen);
    const freeGoogle = await f.create('fixture-google-free-choice', {
      ...backend,
      catalog: async () =>
        (await backend.catalog('google')).filter(
          (definition) => definition.choice.id === 'gemini-3.8-flash',
        ),
    });
    const freeConnection = await freeGoogle.addKey('google', 'fixture-google-free-key');
    assert.equal(freeGoogle.view().selection, null);
    assert.equal(freeGoogle.configured, false);
    await freeGoogle.select({
      connectionId: freeConnection,
      modelId: 'gemini-3.8-flash',
      effort: 'medium',
    });
    assert.equal(freeGoogle.configured, true);
    assert.equal((await freeGoogle.resolve()).definition.choice.id, 'gemini-3.8-flash');
    const bedrock = await f.create('fixture-bedrock-default', backend);
    await bedrock.addKey('amazon-bedrock', 'fixture-bedrock-key', { region: 'eu-west-1' });
    assert.equal(bedrock.view().selection, null);
    const explicit = await f.create('fixture-explicit-default', backend, {
      provider: 'google',
      model: 'fixture-unavailable-model',
      credentials: { google: { type: 'api_key', key: 'fixture-managed-key' } },
    });
    assert.equal(explicit.configured, false);
    assert.equal(explicit.view().selection, null);
    const fallbackBackend = {
      ...backend,
      catalog: async () =>
        [
          {
            choice: {
              id: 'fixture-small',
              name: 'Small',
              efforts: ['off'] as const,
              images: false,
              contextWindow: 8000,
            },
            spec: {},
          },
          {
            choice: {
              id: 'fixture-capable',
              name: 'Capable',
              efforts: ['low', 'high'] as const,
              images: true,
              contextWindow: 262144,
            },
            spec: {},
          },
        ].map((definition) => ({
          ...definition,
          choice: { ...definition.choice, efforts: [...definition.choice.efforts] },
        })),
    };
    const fallback = await f.create('fixture-fallback-default', fallbackBackend);
    await fallback.addKey('deepseek', 'fixture-fallback-key');
    assert.equal(fallback.view().selection?.modelId, 'fixture-small');
    assert.equal(fallback.view().selection?.effort, 'off');
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    let offered = ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.2-sol'];
    const openaiBackend = {
      ...createPiModelBackend({
        fetch: async () =>
          Response.json({
            data: offered.map((id) => ({ id })),
            models: offered.map((slug) => ({ slug, visibility: 'list' })),
          }),
      }),
      signIn: stubSignIn(async () => subscriptionCredential()),
    };
    for (const method of ['api_key', 'subscription'] as const) {
      const connect = async (owner: Awaited<ReturnType<typeof f.create>>) => {
        if (method === 'api_key') await owner.addKey('openai', 'fixture-openai-default-key');
        else {
          const signIn = await owner.start('openai');
          await owner.complete(
            new URL(`http://127.0.0.1:1455/auth/callback?state=${signIn.attempt}&code=fixture`),
          );
        }
      };
      offered = ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.2-sol'];
      const ownerId = `fixture-openai-default-${method}`;
      const openai = await f.create(ownerId, openaiBackend);
      await connect(openai);
      assert.equal(openai.view().selection?.modelId, 'gpt-6.2-sol');
      assert.equal(openai.view().selection?.effort, 'high');
      const selected = { ...openai.view().selection!, modelId: 'gpt-6.1-sol' };
      await openai.select(selected);
      await openai.refreshCatalog(selected.connectionId);
      assert.deepEqual(openai.view().selection, selected);
      const restarted = await f.create(ownerId, openaiBackend);
      assert.deepEqual(restarted.view().selection, selected);
      offered = ['gpt-6-sol', 'gpt-6.1-sol'];
      const legacy = await f.create(`${ownerId}-legacy`, openaiBackend);
      await connect(legacy);
      assert.equal(
        legacy.view().selection?.modelId,
        method === 'subscription' ? 'gpt-6-sol' : 'gpt-6.1-sol',
      );
    }
    const count = google.view().connections.length;
    for (const settings of [
      {},
      { accountId: 'not-an-account', gatewayId: 'fixture-gateway' },
      { accountId: '0123456789abcdef0123456789abcdef' },
      { accountId: '0123456789abcdef0123456789abcdef', gatewayId: '../other-gateway' },
    ])
      await assert.rejects(
        google.addKey('cloudflare-ai-gateway', 'fixture-rejected-key', settings),
      );
    assert.equal(google.view().connections.length, count);
  });

  test('image fallback uses owned connected models without changing the chat selection and reads current credentials', async (t) => {
    const f = await fixture(t);
    const backend = {
      ...f.backend,
      catalog: async (
        provider: import('../src/shared/models.ts').ModelProvider,
        method: import('../src/shared/models.ts').ModelMethod,
        credential?: import('../src/ports/models.ts').ModelCredential,
      ) => {
        const definitions = await f.backend.catalog('openai', method, credential);
        return definitions.map((definition) => ({
          ...definition,
          choice: {
            ...definition.choice,
            images: credential?.type === 'api_key' && credential.key === 'fixture-vision',
          },
        }));
      },
    };
    const owner = await f.create('fixture-images', backend);
    const other = await f.create('fixture-images-other', backend);
    await other.addKey('openai', 'fixture-vision');
    const textId = await owner.addKey('openai', 'fixture-text');
    const selection = owner.view().selection!;
    assert.equal(owner.hasImageModel(), false);
    await assert.rejects(owner.resolveImage(), /Connect a model that accepts images/);
    const visionId = await owner.addKey('openai', 'fixture-vision');
    await owner.select({ ...selection, connectionId: textId });
    assert.equal(owner.hasImageModel(), true);
    const access = await owner.resolveImage();
    assert.equal(access.definition.choice.images, true);
    assert.deepEqual(await access.read(), { type: 'api_key', key: 'fixture-vision' });
    assert.deepEqual(owner.view().selection, { ...selection, connectionId: textId });
    const { createDatabaseModelStore } = await import('../src/server/model-store.ts');
    const store = createDatabaseModelStore({
      database: f.database,
      ownerId: 'fixture-images',
      keyStore: f.keyStore,
    });
    await store.initialize();
    await store.change((state) => {
      state.connections.find((row) => row.id === visionId)!.credential = {
        type: 'api_key',
        key: 'fixture-updated',
      };
    });
    assert.deepEqual(await access.read(), { type: 'api_key', key: 'fixture-updated' });
    await owner.remove(visionId);
    assert.equal(await access.read(), undefined);
    assert.equal(owner.hasImageModel(), false);
    assert.equal((await owner.resolve()).definition.choice.images, false);
  });

  test('work models follow own choices and lanes while checks keep the owner model', async (t) => {
    const f = await fixture(t);
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    let listed = ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-audio-1.5'];
    const backend = createPiModelBackend({
      fetch: async () => Response.json({ data: listed.map((id) => ({ id })) }),
    });
    const owner = await f.create('fixture-work-model-owner', backend);
    const events: Array<{ event: string; properties?: Record<string, unknown> }> = [];
    const app = Fastify();
    owner.register(app, (event) => void events.push(event));
    t.after(() => app.close());
    const route = (lane: string, value: unknown) =>
      app.inject({ method: 'PUT', url: '/api/models/routes', payload: { lane, route: value } });
    const connectionId = await owner.addKey('openai', 'fixture-work-model-key');
    const main = { connectionId, modelId: 'gpt-6.1-sol', effort: 'high' as const };
    await owner.select(main);
    const light = owner.view().light!;
    assert.equal(light.modelId, 'gpt-6-luna');
    for (const kind of ['chat', 'schedule', 'background'] as const)
      assert.deepEqual(owner.workModel({ kind }), { selection: main, follows: 'chat' });

    assert.equal((await route('background', 'light')).statusCode, 200);
    assert.deepEqual(owner.workModel({ kind: 'background' }), {
      selection: light,
      follows: 'light',
    });
    assert.deepEqual(owner.workModel({ kind: 'schedule' }).selection, main);
    assert.equal((await owner.resolve()).definition.choice.id, 'gpt-6.1-sol');
    assert.equal(
      (await owner.resolve(false, owner.workModel({ kind: 'background' }).selection)).definition
        .choice.id,
      'gpt-6-luna',
    );
    assert.equal(await owner.automaticRequestsAllowed({ kind: 'background' }, true), true);

    const pinned = { ...main, effort: 'low' as const };
    assert.deepEqual(owner.workModel({ kind: 'background', task: pinned }), {
      selection: pinned,
      follows: 'task',
    });
    assert.deepEqual(owner.workModel({ kind: 'schedule', schedule: light }), {
      selection: light,
      follows: 'schedule',
    });
    assert.deepEqual(owner.workModel({ kind: 'chat', schedule: light }).selection, main);

    const audio = owner
      .view()
      .connections[0]!.models.find((model) => model.id === 'gpt-audio-1.5')!;
    for (const invalid of [
      { ...main, modelId: audio.id, effort: audio.efforts[0] ?? 'high' },
      { ...main, modelId: 'fixture-missing-model' },
      { ...main, effort: 'off' },
      { ...main, connectionId: randomUUID() },
      'heavy',
    ])
      assert.equal((await route('schedule', invalid)).statusCode, 400, JSON.stringify(invalid));
    assert.deepEqual(owner.view().routes, { background: 'light' });

    assert.equal((await route('schedule', light)).statusCode, 200);
    assert.deepEqual(owner.workModel({ kind: 'schedule' }), { selection: light, follows: 'lane' });

    listed = ['gpt-6.1-sol'];
    await owner.refreshCatalog(connectionId);
    assert.equal(owner.view().light, null);
    assert.deepEqual(owner.workModel({ kind: 'background' }), { selection: main, follows: 'chat' });
    assert.throws(() => owner.workModel({ kind: 'schedule' }), /gpt-6-luna/);
    assert.throws(() => owner.workModel({ kind: 'chat', task: light }), /gpt-6-luna/);
    assert.equal(await owner.automaticRequestsAllowed({ kind: 'background' }, true), true);
    listed = ['gpt-6.1-sol', 'gpt-6-luna'];
    await owner.refreshCatalog(connectionId);

    await f.database.query('UPDATE model_settings SET routes=$2 WHERE owner_id=$1', [
      'fixture-work-model-owner',
      JSON.stringify({ background: 'light', schedule: { ...main, effort: 'off' } }),
    ]);
    const restarted = await f.create('fixture-work-model-owner', backend);
    assert.deepEqual(restarted.workModel({ kind: 'schedule' }).selection, main);

    const second = await owner.addKey('openai', 'fixture-work-model-second');
    assert.equal((await route('schedule', { ...main, connectionId: second })).statusCode, 200);
    await owner.remove(second);
    assert.deepEqual(owner.view().routes, { background: 'light' });
    assert.deepEqual(
      owner.workModel({ kind: 'schedule', schedule: { ...main, connectionId: second } }),
      { selection: main, follows: 'chat' },
    );

    assert.equal((await route('background', null)).statusCode, 200);
    assert.deepEqual(owner.view().routes, { background: null });
    assert.deepEqual(owner.workModel({ kind: 'background' }).selection, main);
    const routeEvents = events
      .filter(({ event }) => event === 'setting_changed')
      .map(({ properties }) => properties)
      .filter((properties) => String(properties?.setting).startsWith('model_route'));
    assert.deepEqual(routeEvents, [
      { setting: 'model_route_background', actor: 'owner', state: 'light' },
      { setting: 'model_route_schedule', actor: 'owner', state: 'configured' },
      { setting: 'model_route_schedule', actor: 'owner', state: 'configured' },
      { setting: 'model_route_background', actor: 'owner', state: 'default' },
    ]);
    assert.doesNotMatch(JSON.stringify(routeEvents), /gpt-|[0-9a-f]{8}-/);
  });

  test('classification resolves an approved small model only on the selected owned connection', async (t) => {
    const f = await fixture(t);
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    let smallAvailable = true;
    const backend = createPiModelBackend({
      fetch: async (_input, init) => {
        const key = new Headers(init?.headers).get('authorization');
        const models =
          key === 'Bearer fixture-classification-main-only' || !smallAvailable
            ? ['gpt-6.1-sol']
            : ['gpt-6.1-sol', 'gpt-6-luna'];
        return Response.json({ data: models.map((id) => ({ id })) });
      },
    });
    const owner = await f.create('fixture-classification-owner', backend);
    const other = await f.create('fixture-classification-other', backend);
    assert.equal(owner.hasClassificationModel(), false);
    assert.equal(await owner.resolveClassification(), undefined);
    await other.addKey('openai', 'fixture-classification-other-key');
    assert.equal(owner.hasClassificationModel(true), false);
    assert.equal(await owner.resolveClassification(true), undefined);
    const connectionId = await owner.addKey('openai', 'fixture-classification-small-key');
    const selection = { connectionId, modelId: 'gpt-6.1-sol', effort: 'high' as const };
    await owner.select(selection);
    assert.equal(owner.hasClassificationModel(), true);
    const access = await owner.resolveClassification();
    assert.ok(access);
    assert.equal(access.provider, 'openai');
    assert.equal(access.definition.choice.id, 'gpt-6-luna');
    assert.equal(access.effort, 'off');
    assert.deepEqual(await access.read(), {
      type: 'api_key',
      key: 'fixture-classification-small-key',
    });
    assert.deepEqual(owner.view().selection, selection);
    await owner.select({ ...selection, modelId: 'gpt-6-luna', effort: 'off' });
    assert.equal((await owner.resolveClassification())?.definition.choice.id, 'gpt-6-luna');
    const mainOnly = await owner.addKey('openai', 'fixture-classification-main-only');
    await owner.select({ ...selection, connectionId: mainOnly });
    assert.equal(owner.hasClassificationModel(), false);
    assert.equal(await owner.resolveClassification(), undefined);
    assert.equal(owner.hasClassificationModel(true), true);
    const trustModel = await owner.resolveClassification(true);
    assert.equal(trustModel?.definition.choice.id, 'gpt-6-luna');
    assert.deepEqual(await trustModel?.read(), {
      type: 'api_key',
      key: 'fixture-classification-small-key',
    });
    assert.deepEqual(owner.view().selection, { ...selection, connectionId: mainOnly });
    const secondSmall = await owner.addKey('openai', 'fixture-classification-second-small');
    await owner.select({ ...selection, connectionId: mainOnly });
    assert.equal(owner.hasClassificationModel(true), false);
    assert.equal(await owner.resolveClassification(true), undefined);
    await owner.remove(secondSmall);
    assert.equal(owner.hasClassificationModel(true), true);
    await owner.select(selection);
    smallAvailable = false;
    await owner.refreshCatalog(connectionId);
    assert.equal(owner.hasClassificationModel(), false);
    assert.equal(await owner.resolveClassification(), undefined);
    assert.deepEqual(owner.view().selection, selection);
    assert.equal((await owner.resolve(true)).definition.choice.id, 'gpt-6.1-sol');
  });

  test('classification rejects missing, unpriced and more expensive small models', async (t) => {
    const f = await fixture(t);
    const original = await f.backend.catalog('openai', 'api_key', {
      type: 'api_key',
      key: 'fixture-classification-catalog',
    });
    const variants = [
      { name: 'missing price', cost: undefined },
      { name: 'synthetic zero', cost: { input: 0, output: 0 } },
      { name: 'variable price', cost: { input: -1, output: 0.5 } },
      { name: 'invalid price', cost: { input: 'private-value', output: 0.5 } },
      { name: 'higher input', cost: { input: 3, output: 0.5 } },
      { name: 'higher output', cost: { input: 0.1, output: 11 } },
    ];
    for (const [index, variant] of variants.entries())
      await t.test(variant.name, async () => {
        const backend = {
          ...f.backend,
          catalog: async () =>
            original.map((definition) =>
              definition.choice.id === 'gpt-6-luna'
                ? { ...definition, spec: { ...definition.spec, cost: variant.cost } }
                : definition,
            ),
        };
        const owner = await f.create(`fixture-classification-price-${index}`, backend);
        await owner.addKey('openai', 'fixture-classification-price-key');
        assert.equal(owner.hasClassificationModel(), false);
        assert.equal(await owner.resolveClassification(), undefined);
      });
    for (const [index, variant] of variants.slice(0, 4).entries())
      await t.test(`selected model ${variant.name}`, async () => {
        const owner = await f.create(`fixture-classification-selected-price-${index}`, {
          ...f.backend,
          catalog: async () =>
            original.map((definition) =>
              definition.choice.id === 'gpt-6.1-sol'
                ? { ...definition, spec: { ...definition.spec, cost: variant.cost } }
                : definition,
            ),
        });
        await owner.addKey('openai', 'fixture-classification-selected-price-key');
        assert.equal(owner.hasClassificationModel(), false);
        assert.equal(await owner.resolveClassification(), undefined);
      });
    await t.test('free OpenRouter selection never incurs paid classification', async () => {
      const owner = await f.create('fixture-classification-openrouter-free', {
        ...f.backend,
        catalog: async (provider) =>
          provider === 'openai'
            ? original
            : original.map((definition) => {
                const id =
                  definition.choice.id === 'gpt-6-luna' ? 'openai/gpt-6-luna' : 'openrouter/free';
                return {
                  choice: {
                    ...definition.choice,
                    id,
                    ...(id === 'openrouter/free' ? { efforts: ['off' as const] } : {}),
                  },
                  spec: {
                    ...definition.spec,
                    provider: 'openrouter',
                    id,
                    ...(id === 'openrouter/free' ? { cost: { input: 0, output: 0 } } : {}),
                  },
                };
              }),
      });
      const connectionId = await owner.addKey('openrouter', 'fixture-classification-free-key');
      await owner.addKey('openai', 'fixture-classification-paid-alternative');
      await owner.select({ connectionId, modelId: 'openrouter/free', effort: 'off' });
      assert.equal(owner.hasClassificationModel(), false);
      assert.equal(await owner.resolveClassification(), undefined);
      assert.equal(owner.hasClassificationModel(true), false);
      assert.equal(await owner.resolveClassification(true), undefined);
    });
  });

  test('automatic preparation names the model it cannot price until a priced model does the work', async (t) => {
    const f = await fixture(t);
    const original = await f.backend.catalog('openai', 'api_key', {
      type: 'api_key',
      key: 'fixture-preparation-price-catalog',
    });
    const owner = await f.create('fixture-preparation-price', {
      ...f.backend,
      catalog: async () =>
        original.map((definition) =>
          definition.choice.id === 'gpt-6.1-sol'
            ? { ...definition, spec: { ...definition.spec, cost: { input: 0, output: 0 } } }
            : definition,
        ),
    });
    const connectionId = await owner.addKey('openai', 'fixture-preparation-price-key');
    const unpriced = original.find((definition) => definition.choice.id === 'gpt-6.1-sol')!;
    assert.equal(owner.view().selection?.modelId, 'gpt-6.1-sol');
    assert.equal(owner.unpricedPreparationModel(), unpriced.choice.name);
    assert.equal(owner.view().unpricedPreparationModel, unpriced.choice.name);
    const priced = original.find((definition) => definition.choice.id === 'gpt-6-luna')!;
    await owner.setRoute('background', {
      connectionId,
      modelId: priced.choice.id,
      effort: priced.choice.efforts[0]!,
    });
    assert.equal(owner.unpricedPreparationModel(), undefined);
    assert.equal(owner.view().unpricedPreparationModel, undefined);
  });

  test('classification keeps subscription access on the approved small model', async (t) => {
    const f = await fixture(t);
    const catalog = await f.backend.catalog('openai', 'api_key', {
      type: 'api_key',
      key: 'fixture-classification-subscription-catalog',
    });
    const owner = await f.create('fixture-classification-subscription', {
      ...f.backend,
      catalog: async () => catalog,
      signIn: stubSignIn(async () => subscriptionCredential()),
    });
    const signIn = await owner.start('openai');
    await owner.complete(
      new URL(`http://127.0.0.1:1455/auth/callback?state=${signIn.attempt}&code=fixture`),
    );
    const selection = owner.view().selection;
    const access = await owner.resolveClassification();
    assert.ok(access);
    assert.equal(access.method, 'subscription');
    assert.equal(access.definition.choice.id, 'gpt-6-luna');
    const credential = await access.read();
    assert.equal(credential?.type, 'oauth');
    assert.ok(credential?.type === 'oauth');
    assert.deepEqual(credential, subscriptionCredential(credential.expires));
    assert.deepEqual(owner.view().selection, selection);
  });

  test('classification uses the same Anthropic workspace and refuses unsupported connection types', async (t) => {
    const f = await fixture(t);
    const definitions = (await f.backend.catalog('anthropic', 'api_key')).filter((model) =>
      ['claude-opus-5-5', 'claude-haiku-5-5'].includes(model.choice.id),
    );
    const owner = await f.create('fixture-classification-anthropic', {
      ...f.backend,
      catalog: async () => definitions,
    });
    const connectionId = await owner.addKey('anthropic', 'fixture-classification-anthropic-key', {
      workspaceId: 'wrkspc_synthetic',
    });
    await owner.select({ connectionId, modelId: 'claude-opus-5-5', effort: 'high' });
    const access = await owner.resolveClassification();
    assert.ok(access);
    assert.equal(access.provider, 'anthropic');
    assert.equal(access.definition.choice.id, 'claude-haiku-5-5');
    assert.deepEqual(await access.read(), {
      type: 'api_key',
      key: 'fixture-classification-anthropic-key',
      workspaceId: 'wrkspc_synthetic',
    });
    for (const provider of ['azure', 'amazon-bedrock', 'compatible'] as const)
      await t.test(provider, async () => {
        const unsupported = await f.create(`fixture-classification-${provider}`, {
          ...f.backend,
          catalog: async () => [definitions[0]],
        });
        if (provider === 'compatible') await unsupported.addEndpoint('http://127.0.0.1:1234/v1');
        else
          await unsupported.addKey(provider, 'fixture-classification-cloud-key', {
            region: 'eu-west-1',
            url: 'https://synthetic.openai.azure.com',
            model: definitions[0].choice.id,
            deployment: 'synthetic-deployment',
          });
        assert.equal(await unsupported.resolveClassification(), undefined);
      });
  });

  test('audio models pair with text support from the same owned connection without changing selection', async (t) => {
    const f = await fixture(t);
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    let pairedModels = ['gpt-audio-1.5', 'gpt-6-luna', 'gpt-6.1-sol'];
    const backend = createPiModelBackend({
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://api.openai.com/v1/models');
        const key = new Headers(init?.headers).get('authorization');
        const ids = key === 'Bearer fixture-audio-only' ? ['gpt-audio-1.5'] : pairedModels;
        return Response.json({ data: ids.map((id) => ({ id })) });
      },
    });
    const owner = await f.create('fixture-audio-pair', backend);
    const other = await f.create('fixture-audio-pair-other', backend);
    await other.addKey('openai', 'fixture-other-text');
    const audioOnly = await owner.addKey('openai', 'fixture-audio-only');
    const unavailable = {
      connectionId: audioOnly,
      modelId: 'gpt-audio-1.5',
      effort: 'off' as const,
    };
    assert.equal(owner.configured, false);
    await assert.rejects(owner.select(unavailable), /text model/i);
    await assert.rejects(owner.resolve(), /text model/i);
    assert.equal(owner.view().connections[0].models[0].textModelName, undefined);
    const paired = await owner.addKey('openai', 'fixture-paired-text');
    const selected = { ...unavailable, connectionId: paired };
    await owner.select(selected);
    assert.equal(owner.configured, true);
    const access = await owner.resolve();
    assert.equal(access.definition.choice.id, 'gpt-audio-1.5');
    assert.equal(access.textModel?.definition.choice.id, 'gpt-6.1-sol');
    assert.ok(access.textModel);
    assert.ok(access.textModel.definition.choice.efforts.includes(access.textModel.effort));
    assert.deepEqual(await access.read(), { type: 'api_key', key: 'fixture-paired-text' });
    const listed = owner.view().connections.find((row) => row.id === paired)!;
    assert.equal(
      listed.models.find((model) => model.audio)?.textModelName,
      access.textModel.definition.choice.name,
    );
    assert.equal(JSON.stringify(owner.view()).includes('fixture-paired-text'), false);
    assert.equal((await owner.resolve(true)).definition.choice.id, 'gpt-6-luna');
    assert.deepEqual(owner.view().selection, selected);
    pairedModels = ['gpt-audio-1.5', 'gpt-6.1-sol'];
    await owner.refreshCatalog(paired);
    const auxiliary = await owner.resolve(true);
    assert.equal(auxiliary.definition.choice.id, 'gpt-audio-1.5');
    assert.equal(auxiliary.textModel?.definition.choice.id, 'gpt-6.1-sol');
    pairedModels = ['gpt-audio-1.5', 'gpt-6-luna'];
    await owner.refreshCatalog(paired);
    assert.equal((await owner.resolve()).textModel?.definition.choice.id, 'gpt-6-luna');
    pairedModels = ['gpt-audio-1.5', 'gpt-4.1', 'gpt-6-luna'];
    await owner.refreshCatalog(paired);
    assert.equal((await owner.resolve()).textModel?.definition.choice.id, 'gpt-4.1');
    pairedModels = ['gpt-audio-1.5'];
    await owner.refreshCatalog(paired);
    assert.equal(owner.configured, false);
    await assert.rejects(owner.resolve(), /text model/i);
    await assert.rejects(owner.resolve(true), /text model/i);
    await assert.rejects(owner.select(unavailable), /text model/i);
    assert.deepEqual(owner.view().selection, selected);
  });

  test('API key validation refuses provider mismatches before transport or persistence without changing existing connections', async (t) => {
    const f = await fixture(t);
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    const savedKey = 'fixture-existing-openai-key';
    const requests: string[] = [];
    const owner = await f.create(
      'fixture-owner',
      createPiModelBackend({
        fetch: async (input, init) => {
          requests.push(String(input));
          if (
            String(input) === 'https://api.openai.com/v1/models' &&
            new Headers(init?.headers).get('authorization') === `Bearer ${savedKey}`
          )
            return Response.json({ data: [{ id: 'gpt-6.1-sol' }] });
          return Response.json({ error: 'Synthetic credential rejection.' }, { status: 401 });
        },
      }),
    );
    await owner.addKey('openai', savedKey);
    const app = Fastify();
    owner.register(app);
    t.after(() => app.close());
    const initial = owner.view();
    const stored = async () =>
      Promise.all(
        ['model_connections', 'model_settings', 'vault_app_grants'].map(
          async (table) => (await f.database.query(`SELECT * FROM ${table}`)).rows,
        ),
      );
    const initialRows = await stored();
    for (const [name, provider, key] of [
      ['Anthropic key in OpenAI', 'openai', 'sk-ant-api03-synthetic-foreign-key'],
      ['OpenRouter key in Anthropic', 'anthropic', 'sk-or-v1-synthetic-foreign-key'],
      ['OpenAI project key in OpenRouter', 'openrouter', 'sk-proj-synthetic-foreign-key'],
      ['long-term Bedrock key in OpenAI', 'openai', 'ABSKsynthetic-foreign-key'],
      ['short-term Bedrock key in Anthropic', 'anthropic', 'bedrock-api-key-synthetic-foreign-key'],
      ['embedded whitespace', 'openai', 'fixture invalid key'],
      ['embedded control character', 'openai', 'fixture-invalid\u0000key'],
      ['first C1 control character', 'openai', 'fixture-invalid\u0080key'],
      ['C1 next-line control character', 'openai', 'fixture-invalid\u0085key'],
      ['last C1 control character', 'openai', 'fixture-invalid\u009fkey'],
      ['incomplete Anthropic key', 'anthropic', 'sk-ant-api'],
      ['incomplete OpenRouter key', 'openrouter', 'sk-or-v1-'],
      ['bundled provider', 'baseten', 'sk-ant-api03-synthetic-bundled-key'],
    ] as const) {
      await t.test(name, async () => {
        const previousRequests = requests.length;
        const response = await app.inject({
          method: 'POST',
          url: '/api/models/keys',
          payload: { provider, key },
        });
        assert.equal(response.statusCode, 400);
        assert.equal(typeof response.json().error, 'string');
        assert.ok(!response.body.includes(key));
        assert.equal(requests.length, previousRequests);
        assert.deepEqual(owner.view(), initial);
        assert.deepEqual(await stored(), initialRows);
        assert.equal(await owner.apiKey('openai'), savedKey);
        assert.deepEqual(await (await owner.resolve()).read(), {
          type: 'api_key',
          key: savedKey,
        });
      });
    }
  });

  test('API key validation leaves unfamiliar formats, matching providers and owner-configured model endpoints usable', async (t) => {
    const f = await fixture(t);
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    const requests: Array<{ url: string; key: string | null }> = [];
    const bedrockKeys = ['ABSKsynthetic-bedrock-key', 'bedrock-api-key-synthetic-key'];
    const owner = await f.create(
      'fixture-owner',
      createPiModelBackend({
        fetch: async (input, init) => {
          const url = String(input);
          const headers = new Headers(init?.headers);
          requests.push({ url, key: headers.get('authorization') ?? headers.get('x-api-key') });
          if (url === 'https://api.openai.com/v1/models')
            return Response.json({ data: [{ id: 'gpt-6.1-sol' }] });
          if (url === 'https://api.anthropic.com/v1/models?limit=1000')
            return Response.json({ data: [{ id: 'claude-opus-5-5' }] });
          if (
            url ===
            'https://bedrock.us-east-1.amazonaws.com/foundation-models?byInferenceType=ON_DEMAND&byOutputModality=TEXT'
          )
            return Response.json({ modelSummaries: [{ modelId: 'amazon.nova-pro-v1:0' }] });
          if (
            url ===
            'https://bedrock.us-east-1.amazonaws.com/inference-profiles?type=SYSTEM_DEFINED&maxResults=1000'
          )
            return Response.json({ inferenceProfileSummaries: [] });
          if (url === 'http://127.0.0.1:11434/v1/models')
            return Response.json({ data: [{ id: 'fixture-local' }] });
          assert.ok(
            ['http://127.0.0.1:11434/api/version', 'http://127.0.0.1:11434/api/v1/models'].includes(
              url,
            ),
          );
          return Response.json({}, { status: 404 });
        },
      }),
    );
    const app = Fastify();
    owner.register(app);
    t.after(() => app.close());
    for (const [provider, key] of [
      ['openai', '  fixture-unfamiliar-openai-key  '],
      ['anthropic', 'sk-synthetic-shared-prefix'],
      ['baseten', 'fixture-unfamiliar-bundled-key'],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/models/keys',
        payload: { provider, key },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(await owner.apiKey(provider), key.trim());
      assert.ok(!response.body.includes(key.trim()));
    }
    for (const key of bedrockKeys) {
      const existing = new Set(owner.view().connections.map((row) => row.id));
      const response = await app.inject({
        method: 'POST',
        url: '/api/models/keys',
        payload: { provider: 'amazon-bedrock', key, region: 'us-east-1' },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(!response.body.includes(key));
      const connection = owner.view().connections.find((row) => !existing.has(row.id))!;
      const model = connection.models[0]!;
      await owner.select({
        connectionId: connection.id,
        modelId: model.id,
        effort: model.efforts[0]!,
      });
      assert.deepEqual(await (await owner.resolve()).read(), {
        type: 'bedrock',
        key,
        region: 'us-east-1',
      });
    }
    const proxyKey = 'sk-ant-api03-synthetic-proxy-key';
    const endpoint = await app.inject({
      method: 'POST',
      url: '/api/models/endpoints',
      payload: { url: 'http://127.0.0.1:11434/v1', key: proxyKey },
    });
    assert.equal(endpoint.statusCode, 200, endpoint.body);
    const endpointConnection = owner
      .view()
      .connections.find((row) => row.provider === 'compatible')!;
    await owner.select({
      connectionId: endpointConnection.id,
      modelId: 'fixture-local',
      effort: 'off',
    });
    assert.deepEqual(await (await owner.resolve()).read(), {
      type: 'endpoint',
      url: 'http://127.0.0.1:11434/v1',
      key: proxyKey,
    });
    assert.deepEqual(requests, [
      { url: 'https://api.openai.com/v1/models', key: 'Bearer fixture-unfamiliar-openai-key' },
      {
        url: 'https://api.anthropic.com/v1/models?limit=1000',
        key: 'sk-synthetic-shared-prefix',
      },
      ...bedrockKeys.flatMap((key) =>
        [
          '/foundation-models?byInferenceType=ON_DEMAND&byOutputModality=TEXT',
          '/inference-profiles?type=SYSTEM_DEFINED&maxResults=1000',
        ].map((path) => ({
          url: `https://bedrock.us-east-1.amazonaws.com${path}`,
          key: `Bearer ${key}`,
        })),
      ),
      ...['/v1/models', '/api/version', '/api/v1/models'].map((path) => ({
        url: `http://127.0.0.1:11434${path}`,
        key: `Bearer ${proxyKey}`,
      })),
    ]);
  });

  test('Anthropic workspace selection survives setup, encrypted reload and model refresh', async (t) => {
    const f = await fixture(t);
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    const sharedKey = 'fixture-anthropic-unscoped-key';
    const scopedKey = 'fixture-anthropic-scoped-key';
    const discoveredKey = 'fixture-anthropic-discovered-key';
    const deniedKey = 'fixture-anthropic-discovered-denied-key';
    const unavailableKey = 'fixture-anthropic-discovery-unavailable-key';
    const workspaces = ['wrkspc_First123', 'wrkspc_Second-456'];
    const requests: Array<{ key: string | null; workspaceId: string | null }> = [];
    const backend = createPiModelBackend({
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        const workspaceId = headers.get('anthropic-workspace-id');
        const key = headers.get('x-api-key') ?? headers.get('authorization');
        requests.push({ key, workspaceId });
        if (
          String(input) ===
          'https://api.anthropic.com/v1/organizations/workspaces?include_default=true&limit=1000'
        ) {
          assert.equal(workspaceId, null);
          if (key === unavailableKey)
            return Response.json({ error: { message: key } }, { status: 503 });
          return Response.json({
            data: (key === sharedKey ? workspaces : [workspaces[0]]).map((id) => ({
              id,
              name: id === workspaces[0] ? 'Development' : 'Production',
              archived_at: null,
            })),
            has_more: false,
          });
        }
        if (String(input) === 'https://api.openai.com/v1/models') {
          assert.equal(workspaceId, null);
          return Response.json({ data: [{ id: 'gpt-6.1-sol' }] });
        }
        assert.equal(String(input), 'https://api.anthropic.com/v1/models?limit=1000');
        assert.equal(headers.get('anthropic-version'), '2023-06-01');
        const failure: [number, string, string] | undefined =
          key === 'fixture-revoked-key'
            ? [401, 'authentication_error', 'Synthetic expired API key.']
            : key === 'fixture-forbidden-key'
              ? [403, 'permission_error', 'Synthetic resource access denied.']
              : workspaceId && (!workspaces.includes(workspaceId) || key === deniedKey)
                ? [404, 'not_found_error', 'Synthetic workspace not found.']
                : key !== scopedKey && !workspaceId
                  ? [400, 'invalid_request_error', 'Include the anthropic-workspace-id header.']
                  : undefined;
        if (failure)
          return Response.json(
            { type: 'error', error: { type: failure[1], message: failure[2] } },
            { status: failure[0] },
          );
        assert.ok(key === sharedKey || key === scopedKey || key === discoveredKey);
        return Response.json({ data: [{ id: 'claude-opus-5-5' }] });
      },
    });
    const owner = await f.create('fixture-workspace-owner', backend);
    const app = Fastify();
    owner.register(app);
    t.after(() => app.close());
    const connect = (key: string, workspaceId?: string, provider = 'anthropic') =>
      app.inject({
        method: 'POST',
        url: '/api/models/keys',
        payload: { provider, key, ...(workspaceId === undefined ? {} : { workspaceId }) },
      });
    const stored = async () =>
      Promise.all(
        ['model_connections', 'model_settings', 'vault_app_grants'].map(
          async (table) => (await f.database.query(`SELECT * FROM ${table} ORDER BY 1`)).rows,
        ),
      );
    assert.equal((await connect(scopedKey, '  ')).statusCode, 200);
    assert.deepEqual(requests.at(-1), { key: scopedKey, workspaceId: null });
    const initial = owner.view();
    const initialRows = await stored();
    for (const [key, workspaceId] of [
      [sharedKey, undefined],
      [deniedKey, undefined],
      [unavailableKey, undefined],
      [sharedKey, 'wrkspc_Inaccessible'],
      [sharedKey, 'org_wrong'],
      ['fixture-revoked-key', workspaces[0]],
      ['fixture-forbidden-key', workspaces[0]],
    ] as const) {
      const response = await connect(key, workspaceId);
      assert.equal(response.statusCode, 400);
      assert.ok(!response.body.includes(key));
      assert.deepEqual(
        response.json().workspaces,
        key === sharedKey && !workspaceId
          ? workspaces.map((id, index) => ({
              id,
              name: index === 0 ? 'Development' : 'Production',
            }))
          : undefined,
      );
      assert.deepEqual(owner.view(), initial);
      assert.deepEqual(await stored(), initialRows);
    }
    const previousRequests = requests.length;
    for (const workspaceId of [
      'wrkspc_bad workspace',
      'wrkspc_bad\u0000workspace',
      'wrkspc_bad\r\nheader',
      `wrkspc_${'a'.repeat(100)}`,
    ])
      assert.equal((await connect(sharedKey, workspaceId)).statusCode, 400);
    assert.equal(requests.length, previousRequests);
    assert.deepEqual(await stored(), initialRows);
    const ids: string[] = [];
    for (const workspaceId of workspaces) {
      const response = await connect(sharedKey, `  ${workspaceId}  `);
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(requests.at(-1), { key: sharedKey, workspaceId });
      const connection = owner.view().connections.find((row) => row.label === workspaceId)!;
      assert.ok(connection);
      ids.push(connection.id);
      assert.equal(await owner.addKey('anthropic', sharedKey, { workspaceId }), connection.id);
    }
    assert.notEqual(ids[0], ids[1]);
    assert.equal(owner.view().connections.length, 3);
    const reloaded = await f.create('fixture-workspace-owner', backend);
    for (const [index, workspaceId] of workspaces.entries()) {
      const connection = reloaded.view().connections.find((row) => row.id === ids[index])!;
      const choice = connection.models[0];
      await reloaded.select({
        connectionId: connection.id,
        modelId: choice.id,
        effort: choice.efforts[0],
      });
      const access = await reloaded.resolve();
      assert.deepEqual(await access.read(), { type: 'api_key', key: sharedKey, workspaceId });
      assert.ok(!JSON.stringify(access.definition.spec).includes(workspaceId));
      await reloaded.refreshCatalog(connection.id);
      assert.deepEqual(requests.at(-1), { key: sharedKey, workspaceId });
    }
    const discovered = await f.create('fixture-workspace-discovery-owner', backend);
    const discoveredId = await discovered.addKey('anthropic', discoveredKey);
    assert.equal(discovered.view().connections[0].label, workspaces[0]);
    const discoveredReload = await f.create('fixture-workspace-discovery-owner', backend);
    assert.deepEqual(await (await discoveredReload.resolve()).read(), {
      type: 'api_key',
      key: discoveredKey,
      workspaceId: workspaces[0],
    });
    await discoveredReload.refreshCatalog(discoveredId);
    assert.deepEqual(requests.at(-1), { key: discoveredKey, workspaceId: workspaces[0] });
    assert.equal(
      (await connect('fixture-openai-holdout', workspaces[0], 'openai')).statusCode,
      200,
    );
    const openai = owner.view().connections.find((row) => row.provider === 'openai')!;
    await owner.select({ connectionId: openai.id, modelId: 'gpt-6.1-sol', effort: 'medium' });
    assert.deepEqual(await (await owner.resolve()).read(), {
      type: 'api_key',
      key: 'fixture-openai-holdout',
    });
    assert.doesNotMatch(
      JSON.stringify(await stored()),
      /fixture-anthropic-(unscoped|scoped|discovered)-key|fixture-openai-holdout/,
    );
    assert.doesNotMatch(
      JSON.stringify((await f.database.query('SELECT * FROM vault_app_grants')).rows),
      /wrkspc_/,
    );
  });

  test('model connections verify credential storage before opening sign-in or calling a provider', async (t) => {
    const f = await fixture(t);
    const { createEnvironmentKeyStore } = await import('../src/providers/environment/key-store.ts');
    const invalidKey = 'a'.repeat(64);
    Object.assign(f.keyStore, createEnvironmentKeyStore(invalidKey));
    const calls = { signIn: 0, authorize: 0, catalog: 0 };
    let rejectSignIn = false;
    let rejectStart = false;
    const signIn = stubSignIn(async () => {
      if (rejectSignIn) throw new Error('Synthetic sign-in failure');
      return subscriptionCredential();
    });
    const owner = await f.create('fixture-owner', {
      ...f.backend,
      signIn(input) {
        calls.signIn++;
        if (rejectStart) throw new Error('Synthetic sign-in start failure');
        return signIn(input);
      },
      authorize(input) {
        calls.authorize++;
        if (rejectStart) throw new Error('Synthetic sign-in start failure');
        return f.backend.authorize(input);
      },
      catalog(provider, method) {
        calls.catalog++;
        return f.backend.catalog(provider, method);
      },
    });
    const app = Fastify();
    const captured: Parameters<CaptureAnalytics>[0][] = [];
    owner.register(app, (event) => captured.push(event));
    t.after(() => app.close());
    for (const [url, payload] of [
      ['/api/models/oauth', { provider: 'openai' }],
      ['/api/models/oauth', { provider: 'openrouter' }],
      ['/api/models/keys', { provider: 'openai', key: 'fixture-provider-key' }],
      ['/api/models/endpoints', { url: 'http://localhost:11434/v1' }],
    ] as const) {
      const response = await app.inject({ method: 'POST', url, payload });
      assert.equal(response.statusCode, 400);
      assert.ok(!response.body.includes(invalidKey));
      assert.deepEqual(calls, { signIn: 0, authorize: 0, catalog: 0 });
    }
    const failures = [
      { provider: 'openai', method: 'subscription' },
      { provider: 'openrouter', method: 'oauth' },
      { provider: 'openai', method: 'api_key' },
      { provider: 'compatible', method: 'api_key' },
    ].map((properties) => ({
      event: 'model_connection_changed',
      properties: { ...properties, status: 'failed' },
    }));
    assert.deepEqual(captured, failures);
    assert.equal((await f.database.query('SELECT id FROM model_connections')).rowCount, 0);
    assert.equal((await f.database.query('SELECT id FROM vault_app_grants')).rowCount, 0);
    Object.assign(f.keyStore, createEnvironmentKeyStore(Buffer.alloc(32, 77).toString('base64')));
    const started = await app.inject({
      method: 'POST',
      url: '/api/models/oauth',
      payload: { provider: 'openai' },
    });
    assert.equal(started.statusCode, 200);
    const { attempt } = started.json();
    const completed = await app.inject({
      method: 'POST',
      url: '/api/models/oauth/complete',
      payload: {
        url: `http://127.0.0.1:1455/auth/callback?state=${attempt}&code=fixture`,
      },
    });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.deepEqual(owner.signInStatus(attempt), { status: 'connected' });
    assert.deepEqual(calls, { signIn: 1, authorize: 0, catalog: 1 });
    assert.equal((await f.database.query('SELECT id FROM model_connections')).rowCount, 1);
    assert.equal((await f.database.query('SELECT id FROM vault_app_grants')).rowCount, 1);
    assert.equal((await (await owner.resolve()).read())?.type, 'oauth');
    assert.ok(!JSON.stringify(owner.view()).includes('fixture-access'));
    assert.deepEqual(captured, [
      ...failures,
      {
        event: 'model_connection_changed',
        properties: { provider: 'openai', method: 'subscription', status: 'connected' },
      },
    ]);
    rejectSignIn = true;
    const next = await owner.start('openai');
    await assert.rejects(
      owner.complete(
        new URL(`http://127.0.0.1:1455/auth/callback?state=${next.attempt}&code=fixture`),
      ),
    );
    assert.deepEqual(captured.slice(failures.length + 1), [failures[0]]);
    assert.deepEqual(calls, { signIn: 2, authorize: 0, catalog: 1 });
    rejectStart = true;
    for (const provider of ['openai', 'openrouter'] as const)
      await assert.rejects(owner.start(provider), /Synthetic sign-in start failure/);
    assert.deepEqual(captured.slice(failures.length + 2), [failures[0], failures[1]]);
    assert.deepEqual(calls, { signIn: 3, authorize: 1, catalog: 1 });
  });

  test('sign-in start failures keep the consent period that started the request', async (t) => {
    for (const boundary of ['provider', 'storage'])
      for (const changeConsent of [false, true]) {
        const f = await fixture(t);
        let entered!: () => void;
        let reject!: (error: Error) => void;
        const starting = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const result = new Promise<never>((_resolve, fail) => {
          reject = fail;
        });
        const ownerId = `fixture-sign-in-${boundary}-${changeConsent}`;
        const owner = await f.create(ownerId, {
          ...f.backend,
          signIn: async () => {
            entered();
            return result;
          },
        });
        if (boundary === 'storage')
          f.keyStore.getKey = async () => {
            entered();
            return result;
          };
        const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
        const analytics = await createAnalytics({
          provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
          environment: 'development',
          dataRoot: '.',
          installationId: randomUUID(),
        });
        t.after(() => analytics.shutdown());
        analytics.setUsageData(ownerId, true);
        const app = Fastify();
        owner.register(app, analytics.forOwner(ownerId));
        t.after(() => app.close());
        const failed = assert.rejects(owner.start('openai'));
        await starting;
        if (changeConsent) {
          analytics.setUsageData(ownerId, false);
          analytics.setUsageData(ownerId, true);
        }
        reject(new Error('Synthetic sign-in start failure'));
        await failed;
        assert.deepEqual(
          captured.map(({ event, properties }) => [
            event,
            properties.provider,
            properties.method,
            properties.status,
          ]),
          changeConsent ? [] : [['model_connection_changed', 'openai', 'subscription', 'failed']],
          `${boundary}: consent changed=${changeConsent}`,
        );
      }
  });

  test('removing a selected model records only committed clearing within its consent period', async (t) => {
    const { createDatabaseModelStore } = await import('../src/server/model-store.ts');
    const { lockKey } = await import('../src/server/locks.ts');
    const f = await fixture(t);
    let catalogs = 0;
    const backend = {
      ...f.backend,
      catalog: (...args: Parameters<typeof f.backend.catalog>) => {
        catalogs++;
        return f.backend.catalog(...args);
      },
    };
    const ownerId = 'fixture-remove-owner';
    const owner = await f.create(ownerId, backend);
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    const analytics = await createAnalytics({
      provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
      environment: 'development',
      dataRoot: '.',
      installationId: randomUUID(),
    });
    analytics.setUsageData(ownerId, true);
    owner.register(Fastify(), analytics.forOwner(ownerId));
    const selected = await owner.addKey('openai', 'fixture-removal-key');
    assert.equal(owner.view().selection?.connectionId, selected);
    const selection = owner.view().selection!;
    const alternative = owner
      .view()
      .connections.flatMap((connection) => connection.models)
      .find((model) => model.id === selection.modelId)!
      .efforts.find((effort) => effort !== selection.effort)!;
    assert.ok(alternative);
    await owner.select({ ...selection, effort: alternative });
    captured.length = 0;
    const store = createDatabaseModelStore({ database: f.database, ownerId, keyStore: f.keyStore });
    await store.initialize();
    const unselected = randomUUID();
    await store.change((state) => {
      state.connections.push({ ...structuredClone(state.connections[0]), id: unselected });
    });
    const calls = catalogs;
    const settings = () => captured.filter(({ event }) => event === 'setting_changed');
    await owner.remove(unselected);
    assert.equal(settings().length, 0);
    assert.equal(owner.view().selection?.connectionId, selected);
    await f.database.query(
      "ALTER TABLE model_settings ADD CONSTRAINT retain_fixture_selection CHECK (selection IS NOT NULL AND selection <> 'null'::jsonb)",
    );
    const beforeFailure = captured.length;
    await assert.rejects(owner.remove(selected));
    assert.equal(captured.length, beforeFailure);
    assert.equal((await store.read()).selection?.connectionId, selected);
    assert.ok((await store.read()).connections.some(({ id }) => id === selected));
    await f.database.query('ALTER TABLE model_settings DROP CONSTRAINT retain_fixture_selection');
    await owner.remove(selected);
    assert.equal((await store.read()).selection, null);
    assert.deepEqual(
      settings().map(({ properties }) => ({
        setting: properties.setting,
        actor: properties.actor,
        state: properties.state,
      })),
      [
        { setting: 'model_selection', actor: 'owner', state: 'cleared' },
        { setting: 'model_effort', actor: 'owner', state: 'cleared' },
      ],
    );
    await owner.remove(selected);
    assert.equal(settings().length, 2);
    assert.equal(catalogs, calls);
    const next = await owner.addKey('openai', 'fixture-removal-next-key');
    const beforeRevoke = captured.length;
    const beforeCatalogs = catalogs;
    const client = await f.database.connect();
    await client.query('BEGIN');
    await lockKey(client, `models:${ownerId}`);
    const pending = owner.remove(next);
    analytics.setUsageData(ownerId, false);
    analytics.setUsageData(ownerId, true);
    await client.query('COMMIT');
    client.release();
    await pending;
    assert.equal((await store.read()).selection, null);
    assert.equal(captured.length, beforeRevoke);
    assert.equal(catalogs, beforeCatalogs);
    assert.doesNotMatch(JSON.stringify(settings()), /fixture-|connectionId|modelId/);
  });

  test('OpenAI-compatible servers connect from Models or server settings, and keep their key out of storage', async (t) => {
    const f = await fixture(t);
    const { createServer } = await import('node:http');
    const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
    const server = createServer((request, response) => {
      const found = request.url === '/v1/models';
      response.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          found ? { data: [{ id: 'fixture-local' }, { id: 'fixture-alternate' }] } : {},
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const owner = await f.create('fixture-owner', createPiModelBackend());
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    const analytics = await createAnalytics({
      provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
      environment: 'production',
      dataRoot: '.',
      installationId: randomUUID(),
    });
    analytics.setUsageData('fixture-owner', true);
    owner.register(Fastify(), analytics.forOwner('fixture-owner'));
    const id = await owner.addEndpoint(
      `${address.slice('http://'.length)}/`,
      'fixture-endpoint-key',
    );
    await owner.select({ connectionId: id, modelId: 'fixture-local', effort: 'off' });
    const { captureConnectionInventory } = await import('../src/server/analytics-connections.ts');
    await captureConnectionInventory(
      analytics,
      'fixture-owner',
      async () => [],
      () => owner.analyticsConnections(),
      false,
    );
    assert.deepEqual(
      captured.map(({ event, properties }) => {
        const { analytics_schema, deployment, environment, capture_source, ...rest } = properties;
        return { event, ...rest };
      }),
      [
        {
          event: 'model_connection_changed',
          provider: 'compatible',
          method: 'api_key',
          status: 'connected',
        },
        {
          event: 'model_connection_observed',
          provider: 'compatible',
          method: 'api_key',
          selected: true,
          model: 'custom',
          effort: 'off',
        },
      ],
    );
    const access = await owner.resolve();
    assert.equal(access.definition.spec.baseUrl, `${address}/v1`);
    const endpointPrice = owner.priceOf(owner.view().selection);
    assert.ok(endpointPrice);
    assert.equal(endpointPrice.modelId, 'fixture-local');
    assert.equal(endpointPrice.pricing, undefined);
    assert.equal(owner.hasApiKey('openai'), false);
    assert.equal(await owner.apiKey('openai'), undefined);
    assert.deepEqual(await access.read(), {
      type: 'endpoint',
      url: address,
      key: 'fixture-endpoint-key',
    });
    assert.equal(await owner.addEndpoint(address, 'fixture-rotated-key'), id);
    assert.equal(owner.view().connections.length, 1);
    assert.deepEqual(await (await owner.resolve()).read(), {
      type: 'endpoint',
      url: address,
      key: 'fixture-rotated-key',
    });
    const settingEvents = () => captured.filter(({ event }) => event === 'setting_changed');
    await owner.select({ connectionId: id, modelId: 'fixture-alternate', effort: 'off' });
    assert.equal(settingEvents().length, 1);
    assert.deepEqual(
      Object.fromEntries(
        ['setting', 'actor', 'state'].map((key) => [key, settingEvents()[0].properties[key]]),
      ),
      { setting: 'model_selection', actor: 'owner', state: 'configured' },
    );
    assert.equal(owner.view().selection?.modelId, 'fixture-alternate');
    await owner.select({ connectionId: id, modelId: 'fixture-alternate', effort: 'off' });
    await assert.rejects(
      owner.select({ connectionId: id, modelId: 'fixture-unavailable', effort: 'off' }),
    );
    assert.equal(settingEvents().length, 1);
    assert.doesNotMatch(JSON.stringify(settingEvents()), /fixture-|127\.0\.0\.1/);
    analytics.setUsageData('fixture-owner', false);
    await owner.select({ connectionId: id, modelId: 'fixture-local', effort: 'off' });
    assert.equal(settingEvents().length, 1);
    const effortOwner = await f.create('fixture-effort-owner');
    analytics.setUsageData('fixture-effort-owner', true);
    effortOwner.register(Fastify(), analytics.forOwner('fixture-effort-owner'));
    await effortOwner.addKey('openai', 'fixture-effort-key');
    const selected = effortOwner.view().selection!;
    const alternative = effortOwner
      .view()
      .connections.flatMap((connection) => connection.models)
      .find((model) => model.id === selected.modelId)!
      .efforts.find((effort) => effort !== selected.effort)!;
    assert.ok(alternative);
    await effortOwner.select({ ...selected, effort: alternative }, 'agent');
    assert.equal(settingEvents().length, 2);
    assert.equal(settingEvents()[1].properties.setting, 'model_effort');
    assert.equal(settingEvents()[1].properties.state, alternative);
    assert.equal(settingEvents()[1].properties.actor, 'agent');
    const bootstrap = {
      provider: 'compatible' as const,
      credentials: {
        compatible: { type: 'endpoint' as const, url: address, key: 'fixture-server-key' },
      },
    };
    const configured = await f.create('fixture-server', createPiModelBackend(), bootstrap);
    const [managed] = configured.view().connections;
    assert.deepEqual(
      [managed.managed, managed.status, configured.view().selection?.modelId],
      [true, 'connected', 'fixture-local'],
    );
    assert.equal((await (await configured.resolve()).read())?.type, 'endpoint');
    await assert.rejects(configured.remove(managed.id));
    const stored = JSON.stringify([
      (await f.database.query('SELECT * FROM vault_app_grants')).rows,
      (await f.database.query('SELECT * FROM model_connections')).rows,
    ]);
    assert.ok(!stored.includes('fixture-endpoint-key'));
    assert.ok(!stored.includes('fixture-server-key'));
    assert.ok(!stored.includes('fixture-rotated-key'));
  });

  test('server-managed model keys rotate privately and disappear when removed without changing other connections', async (t) => {
    for (const selected of ['managed', 'saved'] as const) {
      await t.test(selected, async (t) => {
        const f = await fixture(t);
        const { createPiModelBackend } = await import('../src/providers/pi/models.ts');
        const backend = createPiModelBackend({
          fetch: async (input) => {
            if (String(input) === 'https://api.anthropic.com/v1/models?limit=1000')
              return Response.json({ data: [{ id: 'claude-opus-5-5' }] });
            assert.equal(String(input), 'https://api.openai.com/v1/models');
            return Response.json({ data: ['gpt-6.1-sol', 'gpt-6-luna'].map((id) => ({ id })) });
          },
        });
        const originalKey = 'fixture-managed-original-key';
        const rotatedKey = 'fixture-managed-rotated-key';
        const savedKey = 'fixture-saved-key';
        const otherKey = 'fixture-other-owner-key';
        const replacementKey = 'fixture-anthropic-key';
        const bootstrap = (key: string) => ({
          provider: 'openai' as const,
          credentials: { openai: { type: 'api_key' as const, key } },
        });
        const original = await f.create('fixture-owner', backend, bootstrap(originalKey));
        const managed = original.view().connections[0];
        const initialSelection = original.view().selection;
        assert.equal(managed.managed, true);
        assert.equal(initialSelection?.connectionId, managed.id);
        const savedId = await original.addKey('openai', savedKey);
        const other = await f.create('fixture-other', backend);
        await other.addKey('openai', otherKey);
        const otherView = other.view();
        await other.close();
        await original.close();

        const rotated = await f.create('fixture-owner', backend, bootstrap(rotatedKey));
        assert.equal(rotated.view().connections.find((row) => row.managed)?.id, managed.id);
        assert.deepEqual(rotated.view().selection, initialSelection);
        assert.deepEqual(await (await rotated.resolve()).read(), {
          type: 'api_key',
          key: rotatedKey,
        });
        const saved = rotated.view().connections.find((row) => row.id === savedId)!;
        const choice = saved.models.find((model) => model.id === 'gpt-6-luna')!;
        const savedSelection = {
          connectionId: savedId,
          modelId: choice.id,
          effort: choice.efforts[0],
        };
        if (selected === 'saved') await rotated.select(savedSelection);
        const visible = JSON.stringify([original.view(), rotated.view(), otherView]);
        const stored = JSON.stringify([
          (await f.database.query('SELECT * FROM model_connections')).rows,
          (await f.database.query('SELECT * FROM vault_app_grants')).rows,
        ]);
        for (const key of [originalKey, rotatedKey, savedKey, otherKey]) {
          assert.ok(!visible.includes(key));
          assert.ok(!stored.includes(key));
        }
        assert.equal(
          (await f.database.query('SELECT id FROM vault_app_grants WHERE id=$1', [managed.id]))
            .rowCount,
          0,
        );
        await rotated.close();

        const removed = await f.create('fixture-owner', backend, {
          provider: 'anthropic',
          credentials: { anthropic: { type: 'api_key', key: replacementKey } },
        });
        assert.equal(
          removed.view().connections.some((row) => row.id === managed.id),
          false,
        );
        assert.equal(
          (await f.database.query('SELECT id FROM model_connections WHERE id=$1', [managed.id]))
            .rowCount,
          0,
        );
        assert.deepEqual(
          removed.view().connections.find((row) => row.id === savedId),
          saved,
        );
        assert.ok(removed.view().connections.some((row) => row.provider === 'anthropic'));
        if (selected === 'saved') {
          assert.deepEqual(removed.view().selection, savedSelection);
          assert.deepEqual(await (await removed.resolve()).read(), {
            type: 'api_key',
            key: savedKey,
          });
        } else {
          assert.equal(removed.view().selection, null);
          assert.equal(removed.configured, false);
          await assert.rejects(removed.resolve());
        }
        const unchanged = await f.create('fixture-other', backend);
        assert.deepEqual(unchanged.view(), otherView);
        assert.deepEqual(await (await unchanged.resolve()).read(), {
          type: 'api_key',
          key: otherKey,
        });
      });
    }
  });

  test('sign-in is single-use; refresh and removal serialize across service instances without restoring a removed key', async (t) => {
    const f = await fixture(t);
    let exchanges = 0;
    let refreshes = 0;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend = {
      ...f.backend,
      catalog: (
        provider: Parameters<typeof f.backend.catalog>[0],
        method: Parameters<typeof f.backend.catalog>[1],
      ) => f.backend.catalog(provider, method),
      async exchange() {
        exchanges++;
        return {
          type: 'oauth' as const,
          access: 'fixture-old-access',
          refresh: 'fixture-old-refresh',
          expires: 0,
          accountId: 'fixture-account',
          clientId: 'fixture-client',
          idToken: 'fixture-id-token',
        };
      },
      async refresh(value: import('../src/ports/models.ts').ModelCredential) {
        if (value.type !== 'oauth') throw new Error('Expected an account credential.');
        refreshes++;
        entered();
        await gate;
        return {
          ...value,
          access: 'fixture-rotated-access',
          refresh: 'fixture-rotated-refresh',
          expires: Date.now() + 3600000,
        };
      },
    };
    backend.signIn = stubSignIn(() => backend.exchange());
    const owner = await f.create('fixture-owner', backend);
    const app = Fastify();
    owner.register(app);
    t.after(() => app.close());
    for (const payload of [
      { provider: 'anthropic' },
      { provider: 'openrouter', connectionId: randomUUID() },
    ]) {
      const rejected = await app.inject({ method: 'POST', url: '/api/models/oauth', payload });
      assert.equal(rejected.statusCode, 400);
    }
    const initiated = await app.inject({
      method: 'POST',
      url: '/api/models/oauth',
      payload: { provider: 'openai' },
    });
    assert.equal(initiated.statusCode, 200, initiated.body);
    const signIn = initiated.json();
    const auth = new URL(signIn.url);
    const status = () => app.inject({ url: `/api/models/oauth/status/${signIn.attempt}` });
    assert.deepEqual((await status()).json(), { status: 'waiting' });
    const other = await f.create('fixture-other', backend);
    const otherApp = Fastify();
    other.register(otherApp);
    t.after(() => otherApp.close());
    assert.equal(
      (await otherApp.inject({ url: `/api/models/oauth/status/${signIn.attempt}` })).json().status,
      'failed',
    );
    const callback = new URL(
      `http://127.0.0.1:1455/auth/callback?state=${auth.searchParams.get('state')}&code=fixture-code&client_id=fixture-client`,
    );
    const complete = () =>
      app.inject({
        method: 'POST',
        url: '/api/models/oauth/complete',
        payload: { url: callback.href },
      });
    assert.equal((await complete()).statusCode, 200);
    assert.deepEqual((await status()).json(), { status: 'connected' });
    assert.equal((await complete()).statusCode, 400);
    assert.deepEqual((await status()).json(), { status: 'connected' });
    const repeated = await app.inject({
      url: `/api/models/oauth/callback?state=${signIn.attempt}&code=fixture-code`,
    });
    assert.equal(repeated.statusCode, 200);
    assert.equal(exchanges, 1);
    const restored = await f.create('fixture-owner', backend);
    assert.equal(restored.hasApiKey('openai'), false);
    assert.equal(await restored.apiKey('openai'), undefined);
    const a = await owner.resolve();
    const b = await restored.resolve();
    const firstRead = a.read();
    await started;
    const secondRead = b.read();
    release();
    assert.equal(((await firstRead) as { access: string }).access, 'fixture-rotated-access');
    assert.equal(((await secondRead) as { access: string }).access, 'fixture-rotated-access');
    assert.equal(refreshes, 1);
    const id = owner.view().connections[0].id;
    const reconnectSignIn = await owner.start('openai', id);
    const reconnect = new URL(reconnectSignIn.url);
    await restored.remove(id);
    await assert.rejects(
      owner.complete(
        new URL(
          `http://127.0.0.1:1455/auth/callback?state=${reconnect.searchParams.get('state')}&code=fixture-code&client_id=fixture-client`,
        ),
      ),
    );
    assert.equal(owner.signInStatus(reconnectSignIn.attempt).status, 'failed');
    assert.equal(await a.read(), undefined);
    assert.equal((await f.database.query('SELECT id FROM model_connections')).rowCount, 0);
    assert.equal((await f.database.query('SELECT id FROM vault_app_grants')).rowCount, 0);
    assert.deepEqual((await status()).json(), { status: 'connected' });
    let exchanging!: () => void;
    let finishExchange!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => {
      exchanging = resolve;
    });
    const exchangeGate = new Promise<void>((resolve) => {
      finishExchange = resolve;
    });
    const slow = await f.create('fixture-slow', {
      ...backend,
      async exchange() {
        exchanging();
        await exchangeGate;
        exchanges++;
        return { type: 'api_key' as const, key: 'fixture-openrouter-key' };
      },
    });
    const slowApp = Fastify();
    slow.register(slowApp);
    t.after(() => slowApp.close());
    const slowSignIn = await slow.start('openrouter');
    const slowCallback = `/api/models/oauth/callback?state=${slowSignIn.attempt}&code=fixture-code`;
    const first = slowApp.inject({ url: slowCallback });
    await exchangeStarted;
    const second = slowApp.inject({ url: slowCallback });
    const exchangesBefore = exchanges;
    finishExchange();
    assert.deepEqual(
      (await Promise.all([first, second])).map((response) => response.statusCode),
      [200, 200],
    );
    assert.equal(exchanges, exchangesBefore + 1);
    assert.equal(slow.hasApiKey('openrouter'), true);
    assert.equal(await slow.apiKey('openrouter'), 'fixture-openrouter-key');
    assert.equal(slow.hasApiKey('openai'), false);
    const routerId = slow.view().connections[0].id;
    await slow.remove(routerId);
    assert.equal(slow.hasApiKey('openrouter'), false);
    assert.equal(await slow.apiKey('openrouter'), undefined);
    const failed = await f.create('fixture-failed', {
      ...backend,
      exchange: async () => {
        throw new Error('fixture-secret-must-stay-private');
      },
    });
    const rejected = await failed.start('openrouter');
    const rejectedCallback = new URL(
      `http://127.0.0.1:4310/api/models/oauth/callback?state=${rejected.attempt}&code=fixture-code`,
    );
    await assert.rejects(failed.complete(rejectedCallback));
    assert.equal(failed.signInStatus(rejected.attempt).status, 'failed');
    assert.ok(!JSON.stringify(failed.signInStatus(rejected.attempt)).includes('fixture-secret'));
    await assert.rejects(failed.complete(rejectedCallback));
  });

  test('cancelling and replacing pending ChatGPT sign-ins releases each flow and fences late completion', async (t) => {
    const f = await fixture(t);
    let aborted = 0;
    let release!: (value: import('../src/ports/models.ts').ModelCredential) => void;
    const pending = new Promise<import('../src/ports/models.ts').ModelCredential>((resolve) => {
      release = resolve;
    });
    const backend = {
      ...f.backend,
      signIn: stubSignIn(
        () => pending,
        () => aborted++,
      ),
    };
    const owner = await f.create('fixture-owner', backend);
    const other = await f.create('fixture-other', backend);
    const app = Fastify();
    const otherApp = Fastify();
    owner.register(app);
    other.register(otherApp);
    t.after(() => app.close());
    t.after(() => otherApp.close());
    const first = await owner.start('openai');
    await otherApp.inject({ method: 'DELETE', url: `/api/models/oauth/${first.attempt}` });
    assert.equal(owner.signInStatus(first.attempt).status, 'waiting');
    assert.equal(aborted, 0);
    const completing = owner.complete(
      new URL(`http://127.0.0.1:1455/auth/callback?state=${first.attempt}&code=fixture`),
    );
    const rejected = assert.rejects(completing);
    const cancelled = await app.inject({
      method: 'DELETE',
      url: `/api/models/oauth/${first.attempt}`,
    });
    assert.equal(cancelled.statusCode, 200);
    await rejected;
    release(subscriptionCredential());
    await Promise.resolve();
    assert.equal(aborted, 1);
    assert.equal(owner.view().connections.length, 0);
    assert.equal(
      (await f.database.query('SELECT count(*)::int AS count FROM vault_app_grants')).rows[0].count,
      0,
    );
    for (let count = 0; count < 7; count++) await owner.start('openai');
    assert.equal(aborted, 7);
    const parallel = await Promise.all([owner.start('openai'), owner.start('openai')]);
    assert.equal(owner.signInStatus(parallel[0].attempt).status, 'failed');
    assert.equal(owner.signInStatus(parallel[1].attempt).status, 'waiting');
    await owner.cancel(parallel[1].attempt);
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const expires = await owner.start('openai');
    t.mock.timers.tick(600001);
    const afterExpiry = await owner.start('openai');
    assert.equal(owner.signInStatus(expires.attempt).status, 'failed');
    t.mock.timers.reset();
    assert.equal(owner.signInStatus(afterExpiry.attempt).status, 'waiting');
    await owner.close();
    assert.equal(owner.signInStatus(afterExpiry.attempt).status, 'failed');
  });

  test('each account is one connection: an unusable one shows on its row, signing in again repairs it, and what the owner adds next takes over', async (t) => {
    const f = await fixture(t);
    const { createPiModelRuntime } = await import('../src/providers/pi/models.ts');
    const { createDatabaseModelStore } = await import('../src/server/model-store.ts');
    const { ModelAuthError } = await import('../src/ports/models.ts');
    let account = 'fixture-account';
    let down = false;
    let revoked = false;
    let hidden: string | undefined;
    let held: { access: string; entered(): void; release: Promise<void> } | undefined;
    const backend = {
      ...f.backend,
      signIn: stubSignIn(async () => ({
        ...subscriptionCredential(),
        access: `fixture-access-${randomUUID()}`,
        accountId: account,
        email: `${account}@example.test`,
      })),
      catalog: async (
        provider: Parameters<typeof f.backend.catalog>[0],
        method: Parameters<typeof f.backend.catalog>[1],
        credential?: Parameters<typeof f.backend.catalog>[2],
      ) => {
        if (credential?.type === 'oauth' && credential.access === held?.access) {
          held.entered();
          await held.release;
          throw new ModelAuthError('Reconnect your ChatGPT account in Settings > Models.', true);
        }
        if (down) throw new Error('fixture-catalog-outage');
        if (revoked && method === 'subscription')
          throw new ModelAuthError('Reconnect your ChatGPT account in Settings > Models.', true);
        return f.backend
          .catalog(provider, method, method === 'api_key' ? credential : undefined)
          .then((definitions) => definitions.filter(({ choice }) => choice.id !== hidden));
      },
    };
    const store = createDatabaseModelStore({
      database: f.database,
      ownerId: 'fixture-owner',
      keyStore: f.keyStore,
    });
    await store.initialize();
    const grants = async () =>
      (await f.database.query('SELECT count(*)::int AS count FROM vault_app_grants')).rows[0].count;
    async function signIn(service: Awaited<ReturnType<typeof f.create>>) {
      const started = await service.start('openai');
      await service.complete(
        new URL(`http://127.0.0.1:1455/auth/callback?state=${started.attempt}&code=fixture`),
      );
    }
    const owner = await f.create('fixture-owner', backend);
    await signIn(owner);
    const [chatgpt] = owner.view().connections;
    const selection = owner.view().selection!;
    assert.equal(selection.connectionId, chatgpt.id);
    await signIn(owner);
    assert.deepEqual(
      owner.view().connections.map(({ id, status }) => ({ id, status })),
      [{ id: chatgpt.id, status: 'connected' }],
    );
    assert.deepEqual(owner.view().selection, selection);
    down = true;
    await signIn(owner);
    down = false;
    assert.deepEqual(
      owner.view().connections.map(({ id, status }) => ({ id, status })),
      [{ id: chatgpt.id, status: 'connected' }],
    );
    assert.equal(owner.configured, true);
    assert.equal(await grants(), 1);

    await store.change((state) => {
      for (const model of state.connections[0].models)
        model.spec.baseUrl = 'https://chatgpt.com/backend-api';
    });
    const restarted = await f.create('fixture-owner', backend);
    const stale = await restarted.resolve();
    await assert.rejects(
      createPiModelRuntime(stale),
      /Reconnect your ChatGPT account in Settings > Models/,
    );
    assert.equal(restarted.view().connections[0].status, 'reconnect');
    assert.equal(restarted.configured, false);
    await assert.rejects(
      restarted.resolve(),
      /Reconnect the ChatGPT plan connection in Settings > Models/,
    );

    await signIn(restarted);
    assert.deepEqual(
      restarted.view().connections.map(({ id, status }) => ({ id, status })),
      [{ id: chatgpt.id, status: 'connected' }],
    );
    assert.deepEqual(restarted.view().selection, selection);
    await createPiModelRuntime(await restarted.resolve());
    await stale.needsReconnect!();
    assert.equal(restarted.view().connections[0].status, 'connected');

    await (
      await restarted.resolve()
    ).needsReconnect!();
    assert.equal(restarted.view().connections[0].status, 'reconnect');
    const key = await restarted.addKey('openai', 'fixture-api-1111');
    assert.equal(restarted.view().selection?.connectionId, key);
    assert.equal(restarted.configured, true);
    assert.equal(await restarted.addKey('openai', 'fixture-api-1111'), key);
    assert.equal(restarted.view().connections.length, 2);
    const chosen = restarted.view().selection!;
    hidden = chosen.modelId;
    await restarted.refreshCatalog(key);
    hidden = undefined;
    assert.deepEqual(restarted.view().selection, chosen);
    assert.equal(restarted.configured, false);
    await assert.rejects(restarted.resolve(), /selected model is unavailable/);
    await restarted.refreshCatalog(key);
    assert.equal(restarted.configured, true);

    await store.change((state) => {
      const [original] = state.connections;
      const copies = [randomUUID(), randomUUID()].map((id) => ({
        ...structuredClone(original),
        id,
        status: 'connected' as const,
      }));
      state.connections.push(...copies);
      state.selection = { ...selection, connectionId: copies[1].id };
    });
    const duplicated = await f.create('fixture-owner', backend);
    assert.equal(duplicated.view().connections.length, 4);
    await signIn(duplicated);
    assert.deepEqual(
      duplicated.view().connections.map(({ id, status }) => ({ id, status })),
      [
        { id: chatgpt.id, status: 'connected' },
        { id: key, status: 'connected' },
      ],
    );
    assert.deepEqual(duplicated.view().selection, selection);
    assert.equal(duplicated.configured, true);
    assert.equal(await grants(), 2);

    account = 'fixture-second-account';
    await signIn(duplicated);
    await signIn(duplicated);
    const work = await duplicated.addKey('openai', 'fixture-api-2222');
    assert.deepEqual(
      duplicated.view().connections.map(({ label, keyEnding }) => [label, keyEnding]),
      [
        ['fixture-account@example.test', undefined],
        ['OpenAI API', '1111'],
        ['fixture-second-account@example.test', undefined],
        ['OpenAI API', '2222'],
      ],
    );
    assert.deepEqual(duplicated.view().selection, selection);
    await duplicated.remove(work);
    assert.equal(duplicated.view().connections.length, 3);
    assert.deepEqual(duplicated.view().selection, selection);
    assert.equal(await grants(), 3);

    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (entered = resolve));
    held = {
      access: ((await (await duplicated.resolve()).read()) as { access: string }).access,
      entered,
      release: new Promise((resolve) => (release = resolve)),
    };
    const racing = duplicated.refreshCatalog(chatgpt.id);
    await reached;
    account = 'fixture-account';
    await signIn(duplicated);
    release();
    await assert.rejects(racing, /Reconnect/);
    assert.equal(
      duplicated.view().connections.find(({ id }) => id === chatgpt.id)?.status,
      'connected',
    );

    revoked = true;
    await assert.rejects(duplicated.refreshCatalog(chatgpt.id), /Reconnect/);
    revoked = false;
    assert.equal(
      duplicated.view().connections.find(({ id }) => id === chatgpt.id)?.status,
      'reconnect',
    );
    assert.equal(duplicated.configured, false);
  });
});

test('feedback activity keeps only bounded technical facts, expires locally and clears on owner changes', async (t) => {
  const { createFeedbackActivity, parseFeedbackActivity } =
    await import('../src/shared/feedback-activity.ts');
  const { feedbackActivity, feedbackActivitySnapshot } =
    await import('../src/web/lib/feedback-activity.ts');
  const { api } = await import('../src/web/lib/api.ts');
  const { captureAnalytics, capturePageview } = await import('../src/web/lib/analytics.ts');
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const history = createFeedbackActivity('runtime');
  const privateValue = 'A private person and their confidential project';
  history.record('connection_changed', {
    app: 'gmail',
    connection_method: 'managed_app',
    status: 'failed',
    failure_reason: 'authentication',
    domain: privateValue,
    account: privateValue,
  });
  history.record('service_used', {
    app: privateValue,
    connection_method: 'mcp',
    outcome: 'failed',
    duration_ms: 12,
    error: privateValue,
  });
  history.record(privateValue, { status: 'failed' });
  assert.deepEqual(
    history.snapshot().map((row) => row.properties),
    [
      {
        app: 'gmail',
        connection_method: 'managed_app',
        status: 'failed',
        failure_reason: 'authentication',
      },
      { app: 'custom', connection_method: 'mcp', outcome: 'failed', duration_ms: 12 },
    ],
  );
  assert.ok(!JSON.stringify(history.snapshot()).includes(privateValue));
  assert.deepEqual(
    parseFeedbackActivity([
      { source: 'app', ageMs: 0, event: '__proto__', properties: { status: privateValue } },
    ]),
    [],
  );
  t.mock.timers.tick(1_800_001);
  assert.deepEqual(history.snapshot(), []);
  for (let index = 0; index < 110; index++)
    history.record('request_failed', {
      area: 'chat',
      method: 'POST',
      status: 500,
      reason: 'http',
      path: privateValue,
    });
  assert.equal(history.snapshot().length, 100);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json({ error: privateValue }, { status: 503 });
  });
  setRequestAccount('diagnostic-owner-one');
  t.after(() => setRequestAccount(null));
  capturePageview('/vault/private-person?secret=private');
  captureAnalytics('ui_error', { area: 'chat', action: 'send' });
  assert.equal(requests, 0);
  await assert.rejects(api('/api/apps/private-account?secret=private'), /private person/);
  for (let index = 0; index < 110; index++)
    capturePageview(`/vault/private-person-${index}?secret=private`);
  assert.deepEqual(
    feedbackActivitySnapshot().map((row) => row.properties),
    [
      { screen: '/credentials' },
      { area: 'chat', action: 'send' },
      { area: 'apps', method: 'GET', status: 503, reason: 'http' },
    ],
  );
  assert.ok(!JSON.stringify(feedbackActivitySnapshot()).includes('private'));
  capturePageview('/apps');
  capturePageview('/vault/private-person');
  assert.equal(feedbackActivitySnapshot().filter((row) => row.event === 'screen').length, 3);
  t.mock.timers.tick(1_800_001);
  capturePageview('/vault/private-person');
  assert.equal(feedbackActivitySnapshot().filter((row) => row.event === 'screen').length, 1);
  setRequestAccount('diagnostic-owner-two');
  assert.deepEqual(feedbackActivitySnapshot(), []);
  capturePageview('/vault/private-person');
  assert.equal(feedbackActivitySnapshot().length, 1);
  feedbackActivity.clear();
  for (const [path, area] of [
    ['/api/thread/stop', 'chat'],
    ['/api/browser-handoff/private-session/complete', 'browser'],
    ['/api/channel-settings/private-channel', 'channels'],
    ['/api/schedule-runs?limit=20', 'tasks'],
    ['/api/credential-requests/private-request', 'vault'],
    ['/api/payment-requests/private-request', 'vault'],
  ]) {
    await assert.rejects(api(path, { method: 'POST' }), /private person/);
    assert.deepEqual(feedbackActivitySnapshot().at(-1)?.properties, {
      area,
      method: 'POST',
      status: 503,
      reason: 'http',
    });
  }
  assert.ok(!JSON.stringify(feedbackActivitySnapshot()).includes('private'));
  feedbackActivity.clear();
  t.mock.method(
    globalThis,
    'fetch',
    async (_path: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        options.signal!.addEventListener('abort', () => reject(options.signal!.reason), {
          once: true,
        }),
      ),
  );
  const timeout = new AbortController();
  const timedRequest = api('/api/channels/private-recipient', { signal: timeout.signal });
  timeout.abort(new DOMException(privateValue, 'TimeoutError'));
  await assert.rejects(timedRequest, { name: 'TimeoutError' });
  assert.deepEqual(
    feedbackActivitySnapshot().map((row) => row.properties),
    [{ area: 'channels', method: 'GET', status: 0, reason: 'timeout' }],
  );
  for (const changedOwner of [false, true]) {
    const cancellation = new AbortController();
    const cancelledRequest = api('/api/channels/private-recipient', {
      signal: cancellation.signal,
    });
    if (changedOwner) setRequestAccount('diagnostic-owner-three');
    else cancellation.abort();
    await assert.rejects(cancelledRequest, { name: 'AbortError' });
    assert.equal(feedbackActivitySnapshot().length, changedOwner ? 0 : 1);
  }
  feedbackActivity.record('ui_error', { area: 'settings', action: 'load' });
  setRequestAccount(null);
  assert.deepEqual(feedbackActivitySnapshot(), []);
  for (const path of ['/api/session', '/api/access']) {
    let respond: (response: Response) => void = () => {};
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Promise<Response>((resolve) => (respond = resolve)),
    );
    setRequestAccount('diagnostic-owner-one');
    const staleRequest = api(path);
    setRequestAccount('diagnostic-owner-two');
    respond(Response.json({ error: privateValue }, { status: 503 }));
    await assert.rejects(staleRequest, /private person/);
    assert.deepEqual(feedbackActivitySnapshot(), []);
  }
});

test('unread chat boundary crosses the badge cap and keeps equal-time visual replies, cancellation and read scopes intact', async (t) => {
  const {
    latestChatReadCursor,
    loadUnreadChatBoundary,
    mergeChatReadCursor,
    readChatReadCursor,
    writeChatReadCursor,
  } = await import('../src/web/lib/chat-unread.ts');
  const messages: import('../src/shared/contracts.ts').Message[] = Array.from(
    { length: 245 },
    (_, index) => ({
      id: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      role: 'assistant',
      text: index === 1 ? '' : `Synthetic reply ${index}`,
      createdAt: new Date(Date.UTC(2026, 9, 30, 12, Math.max(0, index - 1))).toISOString(),
      turnId: null,
      attachments: [],
      ...(index === 1
        ? {
            presentation: {
              version: 1 as const,
              type: 'chart' as const,
              chart: 'bar' as const,
              title: 'Synthetic values',
              sources: [],
              series: [{ id: 'sample', label: 'Sample', points: [{ label: 'One', value: 1 }] }],
            },
          }
        : {}),
    }),
  );
  const cursor = latestChatReadCursor(messages.slice(0, 1));
  const initial = messages.slice(-60);
  const calls: string[] = [];
  const load = async (before: { id: string }) => {
    calls.push(before.id);
    const end = messages.findIndex((message) => message.id === before.id);
    const start = Math.max(0, end - 60);
    return { messages: messages.slice(start, end), hasMore: start > 0 };
  };
  const result = await loadUnreadChatBoundary(
    initial,
    true,
    cursor,
    load,
    new AbortController().signal,
  );
  assert.equal(result.messageId, messages[1].id);
  assert.equal(result.messages.length, 245);
  assert.equal(result.hasMore, false);
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls).size, calls.length);
  assert.equal(result.messages[1].presentation?.type, 'chart');
  assert.deepEqual(cursor.messageIds, [messages[0].id]);
  const latest = latestChatReadCursor(messages);
  assert.equal(mergeChatReadCursor(latest, cursor), latest);
  const read = await loadUnreadChatBoundary(
    initial,
    true,
    latest,
    load,
    new AbortController().signal,
  );
  assert.equal(read.messageId, null);
  assert.equal(calls.length, 4);
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('', { url: 'https://nod.fixture.invalid' });
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    dom.window.close();
  });
  await writeChatReadCursor('one', 'thread', cursor);
  assert.equal(await readChatReadCursor('two', 'thread'), null);
  assert.equal(await readChatReadCursor('one', 'reset'), null);
  await writeChatReadCursor('two', 'thread', latest);
  await writeChatReadCursor('one', 'reset', latest);
  assert.deepEqual(await readChatReadCursor('one', 'thread'), cursor);
  assert.deepEqual(await readChatReadCursor('two', 'thread'), latest);
  assert.deepEqual(await readChatReadCursor('one', 'reset'), latest);
  await assert.rejects(
    loadUnreadChatBoundary(
      initial,
      true,
      cursor,
      async () => ({ messages: initial, hasMore: true }),
      new AbortController().signal,
    ),
    /did not advance/,
  );
  const controller = new AbortController();
  await assert.rejects(
    loadUnreadChatBoundary(
      initial,
      true,
      cursor,
      async (before) => {
        controller.abort();
        return load(before);
      },
      controller.signal,
    ),
    { name: 'AbortError' },
  );
});

async function notificationPage(t: import('node:test').TestContext) {
  const { JSDOM } = await import('jsdom');
  const { act, createElement } = await import('react');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'https://nod.example.test/',
    pretendToBeVisual: true,
  });
  let owner = 'notification-owner-one';
  let permission: NotificationPermission = 'default';
  let permissionRequests = 0;
  let permissionResponse = async (): Promise<NotificationPermission> => permission;
  let failConstruction = false;
  let delayedShow = false;
  let focused = false;
  let visible = true;
  let focusCalls = 0;
  const notifications: SyntheticNotification[] = [];
  const preferences = {
    notificationRule: '',
    rules: '',
    timeZone: 'UTC',
    locale: 'en-GB',
    hourCycle: 'h23',
    quietHoursEnabled: false,
    quietStart: '00:00',
    quietEnd: '23:59',
    proactivePaused: false,
  };
  let preferencesResponse = async () => Response.json(preferences);
  class SyntheticNotification {
    static get permission() {
      return permission;
    }
    static async requestPermission() {
      permissionRequests++;
      permission = await permissionResponse();
      return permission;
    }
    onclick: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onshow: (() => void) | null = null;
    closed = 0;
    shown = !delayedShow;
    visible = !delayedShow;
    constructor(
      readonly title: string,
      readonly options: NotificationOptions,
    ) {
      if (failConstruction) throw new TypeError('Synthetic browser cannot construct notifications');
      notifications.push(this);
    }
    close() {
      if (!this.shown) return;
      this.closed++;
      this.visible = false;
      this.onclose?.();
    }
    show() {
      this.shown = true;
      this.visible = true;
      this.onshow?.();
    }
  }
  Object.defineProperty(dom.window.navigator, 'locks', {
    configurable: true,
    value: navigator.locks,
  });
  Object.defineProperties(dom.window, {
    Notification: { configurable: true, value: SyntheticNotification },
    isSecureContext: { configurable: true, value: true },
    focus: { configurable: true, value: () => focusCalls++ },
    matchMedia: {
      configurable: true,
      value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    },
  });
  Object.defineProperties(dom.window.document, {
    visibilityState: { configurable: true, get: () => (visible ? 'visible' : 'hidden') },
    hasFocus: { configurable: true, value: () => focused },
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { sessionStore } = await import('../src/web/lib/session.ts');
  const { pageDataCache } = await import('../src/web/lib/page-data-cache.ts');
  t.mock.method(sessionStore, 'getSnapshot', () => ({
    session: {
      user: { id: owner, name: 'Synthetic owner', email: null, avatarUrl: null },
      settings: { theme: 'system', onboardingCompleted: true, usageData: false, traces: false },
      capabilities: { developer: false, traces: false },
    },
    loading: false,
    mutating: false,
    locked: false,
    error: '',
    epoch: 0,
  }));
  t.mock.method(globalThis, 'fetch', async (path: RequestInfo | URL) => {
    assert.equal(String(path), '/api/preferences');
    return preferencesResponse();
  });
  pageDataCache.clear();
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    pageDataCache.clear();
    dom.window.close();
    for (const [key, value] of originals)
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
  });
  return {
    act,
    createElement,
    window: dom.window,
    document: dom.window.document,
    notifications,
    preferences,
    respondPreferences: (response: () => Promise<Response>) => (preferencesResponse = response),
    owner: () => owner,
    setOwner: (value: string) => (owner = value),
    setPermission: (value: NotificationPermission) => (permission = value),
    permissionRequests: () => permissionRequests,
    respondPermission: (response: () => Promise<NotificationPermission>) =>
      (permissionResponse = response),
    failConstruction: (value: boolean) => (failConstruction = value),
    delayShow: (value: boolean) => (delayedShow = value),
    focus: (value: boolean) => (focused = value),
    visible: (value: boolean) => (visible = value),
    focusCalls: () => focusCalls,
    native: (bridge: unknown) => Reflect.set(dom.window, 'nodDesktop', bridge),
    async render(element: import('react').ReactNode) {
      await act(async () => root.render(element));
    },
    async click(index: number) {
      const button = dom.window.document.querySelectorAll('button')[index];
      assert.ok(button);
      await act(async () => button.click());
    },
    async refreshPreferences() {
      await act(async () => pageDataCache.refresh('/api/preferences', true));
    },
  };
}

test('browser notification permission requires an explicit owned choice and rejects denial, unsupported construction and stale consent', async (t) => {
  const f = await notificationPage(t);
  const { BrowserNotificationPrompt } =
    await import('../src/web/components/browser-notifications.tsx');
  const { browserNotificationStatus } = await import('../src/web/lib/browser-notifications.ts');
  const render = () =>
    f.render(f.createElement(BrowserNotificationPrompt, { key: f.owner(), ownerId: f.owner() }));
  await render();
  assert.equal(f.permissionRequests(), 0);
  assert.equal(f.notifications.length, 0);
  await f.click(1);
  assert.equal(f.permissionRequests(), 0);
  assert.equal(browserNotificationStatus(f.owner()).choice, 'dismissed');
  await f.render(null);
  await render();
  assert.equal(f.document.querySelectorAll('button').length, 0);
  f.setOwner('notification-owner-two');
  await render();
  assert.equal(f.document.querySelectorAll('button').length, 2);
  f.respondPermission(async () => 'default');
  await f.click(0);
  assert.equal(f.permissionRequests(), 1);
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(f.notifications.length, 0);
  f.respondPermission(async () => 'denied');
  await f.click(0);
  assert.equal(f.permissionRequests(), 2);
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(f.notifications.length, 0);
  f.setOwner('notification-owner-three');
  f.setPermission('default');
  let answer: (permission: NotificationPermission) => void = () => {};
  f.respondPermission(() => new Promise((resolve) => (answer = resolve)));
  await render();
  await f.click(0);
  f.setOwner('notification-owner-four');
  await render();
  await f.act(async () => answer('granted'));
  assert.equal(browserNotificationStatus('notification-owner-three').enabled, false);
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(f.notifications.length, 0);
  f.failConstruction(true);
  await f.click(0);
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(f.notifications.length, 0);
  assert.ok(f.document.querySelector('[role="alert"]'));
  f.failConstruction(false);
  await f.click(0);
  assert.equal(f.permissionRequests(), 3);
  assert.equal(browserNotificationStatus(f.owner()).enabled, true);
  assert.equal(f.notifications.length, 1);
  assert.equal(browserNotificationStatus('notification-owner-one').choice, 'dismissed');
});

test('browser notification delivery preserves owner consent, hides reply content and fences duplicate and stale alerts', async (t) => {
  const f = await notificationPage(t);
  const { browserNotificationStatus, deliverBrowserNotification, setBrowserNotifications } =
    await import('../src/web/lib/browser-notifications.ts');
  f.setPermission('granted');
  const message = {
    id: 'synthetic-message',
    createdAt: '2035-01-01T12:00:00.000Z',
    text: 'Synthetic private email content that must never appear in a browser notification',
  };
  let current = true;
  const send = () =>
    deliverBrowserNotification(f.owner(), 'synthetic-thread', message, () => current);
  assert.equal(await send(), null);
  assert.equal(f.notifications.length, 0);
  await setBrowserNotifications(f.owner(), true);
  assert.equal(f.notifications.length, 1);
  f.focus(true);
  assert.equal(await send(), null);
  f.focus(false);
  const [first, duplicate] = await Promise.all([send(), send()]);
  assert.ok(first);
  assert.equal(duplicate, null);
  assert.equal(f.notifications.length, 2);
  assert.equal(JSON.stringify(f.notifications.at(-1)).includes(message.text), false);
  assert.equal(new URL(f.notifications.at(-1)!.options.icon!).origin, f.window.location.origin);
  const targets: unknown[] = [];
  f.window.addEventListener('nod:focus-message', (event) =>
    targets.push((event as CustomEvent).detail),
  );
  f.notifications.at(-1)!.onclick?.();
  assert.equal(f.focusCalls(), 1);
  assert.deepEqual(targets, [{ messageId: message.id }]);
  current = false;
  f.notifications.at(-1)!.onclick?.();
  assert.equal(f.focusCalls(), 1);
  assert.equal(targets.length, 1);
  f.setOwner('notification-owner-next');
  current = true;
  assert.equal(await send(), null);
  await setBrowserNotifications(f.owner(), true);
  assert.ok(await send());
  await setBrowserNotifications(f.owner(), false);
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(await send(), null);
  f.native({ getSettings: async () => ({ notifications: true }) });
  const beforeNative = f.notifications.length;
  await setBrowserNotifications(f.owner(), true);
  assert.equal(await send(), null);
  assert.equal(f.notifications.length, beforeNative);
});

test('browser reply alerts skip initial history, replay, user messages, quiet time and retired thread scopes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2035, 0, 1, 12) });
  const f = await notificationPage(t);
  const { useBrowserNotifications } = await import('../src/web/hooks/use-browser-notifications.ts');
  const { setBrowserNotifications } = await import('../src/web/lib/browser-notifications.ts');
  type AppState = import('../src/shared/contracts.ts').AppState;
  const messages: AppState['messages'] = [];
  let threadId = 'notification-thread-one';
  function Watch() {
    useBrowserNotifications(f.owner(), { threadId, messages: [...messages] } as AppState);
    return null;
  }
  const render = () => f.render(f.createElement(Watch));
  const add = (role: 'assistant' | 'user' = 'assistant') => {
    const index = messages.length;
    messages.push({
      id: `message-${String(index).padStart(3, '0')}`,
      role,
      text: 'Synthetic private reply',
      turnId: null,
      createdAt: new Date(Date.UTC(2035, 0, 1, 0, 0, index)).toISOString(),
      attachments: [],
    });
  };
  f.setPermission('granted');
  await setBrowserNotifications(f.owner(), true);
  let finishPreferences: (response: Response) => void = () => {};
  f.respondPreferences(() => new Promise((resolve) => (finishPreferences = resolve)));
  add();
  await render();
  assert.equal(f.notifications.length, 1);
  add();
  await render();
  assert.equal(f.notifications.length, 1);
  await f.act(async () => finishPreferences(Response.json(f.preferences)));
  f.respondPreferences(async () => Response.json(f.preferences));
  assert.equal(f.notifications.length, 2);
  await render();
  add('user');
  await render();
  assert.equal(f.notifications.length, 2);
  f.preferences.quietHoursEnabled = true;
  await f.refreshPreferences();
  add();
  await render();
  assert.equal(f.notifications.length, 2);
  f.preferences.quietHoursEnabled = false;
  await f.refreshPreferences();
  f.focus(true);
  add();
  await render();
  assert.equal(f.notifications.length, 2);
  f.focus(false);
  add();
  await render();
  assert.equal(f.notifications.length, 3);
  threadId = 'notification-thread-next';
  add();
  await render();
  assert.equal(f.notifications.length, 3);
  assert.ok(f.notifications.slice(1).every((notification) => notification.closed > 0));
  add();
  await render();
  assert.equal(f.notifications.length, 4);
  await f.act(async () => setBrowserNotifications(f.owner(), false));
  assert.ok(f.notifications.at(-1)!.closed > 0);
  add();
  await render();
  assert.equal(f.notifications.length, 4);
});

test('native notification introduction waits for the owner choice and keeps dismissal scoped', async (t) => {
  const f = await notificationPage(t);
  const { ChatNotifications } = await import('../src/web/components/chat-notifications.tsx');
  let enabled = false;
  const writes: unknown[] = [];
  f.native({
    onPreferences: () => () => {},
    getSettings: async () => ({ notifications: enabled }),
    saveSettings: async (value: { notifications: boolean }) => {
      writes.push(value);
      enabled = value.notifications;
      return { notifications: enabled };
    },
  });
  const render = () =>
    f.render(
      f.createElement(ChatNotifications, {
        ownerId: f.owner(),
        messageId: '123e4567-e89b-42d3-a456-426614174000',
      }),
    );
  await render();
  assert.deepEqual(writes, []);
  assert.equal(f.permissionRequests(), 0);
  await f.click(1);
  await f.render(null);
  await render();
  assert.equal(f.document.querySelectorAll('button').length, 0);
  assert.deepEqual(writes, []);
  f.setOwner('notification-native-owner-next');
  await render();
  assert.equal(f.document.querySelectorAll('button').length, 2);
  await f.click(0);
  assert.deepEqual(writes, [{ notifications: true }]);
  assert.equal(f.document.querySelectorAll('button').length, 0);
  assert.equal(f.permissionRequests(), 0);
});

test('browser notification opt-in cannot replay a reply observed before consent while preferences load', async (t) => {
  const f = await notificationPage(t);
  const { useBrowserNotifications } = await import('../src/web/hooks/use-browser-notifications.ts');
  const { setBrowserNotifications } = await import('../src/web/lib/browser-notifications.ts');
  type AppState = import('../src/shared/contracts.ts').AppState;
  const messages: AppState['messages'] = [];
  function Watch() {
    useBrowserNotifications(f.owner(), {
      threadId: 'notification-consent-delay',
      messages: [...messages],
    } as AppState);
    return null;
  }
  const add = () =>
    messages.push({
      id: `message-${messages.length}`,
      role: 'assistant',
      text: 'Synthetic reply',
      turnId: null,
      createdAt: new Date(Date.UTC(2035, 0, 1, 12, 0, messages.length)).toISOString(),
      attachments: [],
    });
  let finishPreferences: (response: Response) => void = () => {};
  f.respondPreferences(() => new Promise((resolve) => (finishPreferences = resolve)));
  add();
  await f.render(f.createElement(Watch));
  add();
  await f.render(f.createElement(Watch));
  assert.equal(f.notifications.length, 0);
  f.setPermission('granted');
  await f.act(async () => setBrowserNotifications(f.owner(), true));
  assert.equal(f.notifications.length, 1);
  await f.act(async () => finishPreferences(Response.json(f.preferences)));
  assert.equal(f.notifications.length, 1);
  add();
  await f.render(f.createElement(Watch));
  assert.equal(f.notifications.length, 2);
});

test('browser notification re-enablement fails closed when an existing opt-in cannot construct alerts', async (t) => {
  const f = await notificationPage(t);
  const { browserNotificationStatus, setBrowserNotifications } =
    await import('../src/web/lib/browser-notifications.ts');
  f.setPermission('granted');
  await setBrowserNotifications(f.owner(), true);
  assert.equal(browserNotificationStatus(f.owner()).enabled, true);
  f.setPermission('default');
  f.respondPermission(async () => 'granted');
  f.failConstruction(true);
  await assert.rejects(setBrowserNotifications(f.owner(), true));
  assert.equal(f.permissionRequests(), 1);
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.notEqual(browserNotificationStatus(f.owner()).choice, 'enabled');
  assert.equal(f.notifications.length, 1);
});

test('browser notifications close after delayed display when consent or their owning scope ends', async (t) => {
  const f = await notificationPage(t);
  const { BrowserNotificationPrompt } =
    await import('../src/web/components/browser-notifications.tsx');
  const { useBrowserNotifications } = await import('../src/web/hooks/use-browser-notifications.ts');
  const { setBrowserNotifications } = await import('../src/web/lib/browser-notifications.ts');
  let grant: (permission: NotificationPermission) => void = () => {};
  f.respondPermission(() => new Promise((resolve) => (grant = resolve)));
  f.delayShow(true);
  const prompt = () =>
    f.render(f.createElement(BrowserNotificationPrompt, { key: f.owner(), ownerId: f.owner() }));
  await prompt();
  await f.click(0);
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  await f.act(async () => grant('granted'));
  assert.equal(f.permissionRequests(), 1);
  const disabledConfirmation = f.notifications.at(-1)!;
  assert.ok(disabledConfirmation);
  await f.act(async () => setBrowserNotifications(f.owner(), false));
  assert.equal(disabledConfirmation.closed, 0);
  await f.act(async () => setBrowserNotifications(f.owner(), true));
  const reenabledConfirmation = f.notifications.at(-1)!;
  disabledConfirmation.show();
  reenabledConfirmation.show();
  const confirmationVisibility = [disabledConfirmation.visible, reenabledConfirmation.visible];
  f.setOwner('notification-delayed-owner');
  await prompt();
  await f.click(0);
  const retiredConfirmation = f.notifications.at(-1)!;
  await f.render(null);
  assert.equal(retiredConfirmation.closed, 0);
  retiredConfirmation.show();
  assert.equal(retiredConfirmation.visible, false);
  f.setOwner('notification-active-owner');
  await prompt();
  await f.click(0);
  const activeConfirmation = f.notifications.at(-1)!;
  activeConfirmation.show();
  assert.equal(activeConfirmation.visible, true);
  type AppState = import('../src/shared/contracts.ts').AppState;
  const messages: AppState['messages'] = [];
  let threadId = 'notification-delayed-thread';
  function Watch() {
    useBrowserNotifications(f.owner(), { threadId, messages: [...messages] } as AppState);
    return null;
  }
  const render = () => f.render(f.createElement(Watch));
  const add = () =>
    messages.push({
      id: `message-${messages.length}`,
      role: 'assistant',
      text: 'Synthetic private reply',
      turnId: null,
      createdAt: new Date(Date.UTC(2035, 0, 1, 12, 0, messages.length)).toISOString(),
      attachments: [],
    });
  add();
  await render();
  add();
  await render();
  const retiredReply = f.notifications.at(-1)!;
  assert.notEqual(retiredReply, retiredConfirmation);
  threadId = 'notification-delayed-thread-next';
  await render();
  assert.equal(retiredReply.closed, 0);
  retiredReply.show();
  assert.equal(retiredReply.visible, false);
  add();
  await render();
  const activeReply = f.notifications.at(-1)!;
  activeReply.show();
  assert.equal(activeReply.visible, true);
  add();
  await render();
  const disabledReply = f.notifications.at(-1)!;
  await f.act(async () => setBrowserNotifications(f.owner(), false));
  assert.equal(disabledReply.closed, 0);
  await f.act(async () => setBrowserNotifications(f.owner(), true));
  const beforeReply = f.notifications.length;
  add();
  await render();
  assert.equal(f.notifications.length, beforeReply + 1);
  const reenabledReply = f.notifications.at(-1)!;
  assert.notEqual(reenabledReply, disabledReply);
  disabledReply.show();
  reenabledReply.show();
  assert.deepEqual(
    { confirmationVisibility, replyVisibility: [disabledReply.visible, reenabledReply.visible] },
    { confirmationVisibility: [false, true], replyVisibility: [false, true] },
  );
});

test('browser notification deduplication delivers distinct equal-time replies and rejects either replay', async (t) => {
  const f = await notificationPage(t);
  const { deliverBrowserNotification, setBrowserNotifications } =
    await import('../src/web/lib/browser-notifications.ts');
  f.setPermission('granted');
  await setBrowserNotifications(f.owner(), true);
  const first = {
    id: 'ffffffff-ffff-4fff-afff-ffffffffffff',
    createdAt: '2035-01-01T12:00:00.000Z',
  };
  const second = { id: '00000000-0000-4000-a000-000000000001', createdAt: first.createdAt };
  const deliver = (message: typeof first) =>
    deliverBrowserNotification(f.owner(), 'notification-timestamp-tie', message, () => true);
  assert.ok(await deliver(first));
  assert.ok(await deliver(second));
  assert.equal(await deliver(first), null);
  assert.equal(await deliver(second), null);
  assert.equal(f.notifications.length, 3);
});

test('browser notification support requires shared locking before asking for permission', async (t) => {
  const f = await notificationPage(t);
  f.setOwner('notification-unavailable-owner');
  const { BrowserNotificationSettings } =
    await import('../src/web/components/browser-notifications.tsx');
  const { browserNotificationStatus, deliverBrowserNotification, setBrowserNotifications } =
    await import('../src/web/lib/browser-notifications.ts');
  const locks = f.window.navigator.locks;
  f.window.localStorage.setItem(`nod.browser-notifications.${f.owner()}`, 'enabled');
  Object.defineProperty(f.window.navigator, 'locks', { configurable: true, value: undefined });
  await f.render(f.createElement(BrowserNotificationSettings, { ownerId: f.owner() }));
  assert.equal(browserNotificationStatus(f.owner()).available, false);
  const control = f.document.querySelector<HTMLButtonElement>('[role="switch"]');
  assert.ok(control);
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(control.disabled, true);
  await assert.rejects(setBrowserNotifications(f.owner(), true));
  assert.equal(f.permissionRequests(), 0);
  assert.equal(f.notifications.length, 0);
  f.setPermission('granted');
  assert.equal(
    await deliverBrowserNotification(
      f.owner(),
      'notification-no-locks',
      { id: 'message-no-locks', createdAt: '2035-01-01T12:00:00.000Z' },
      () => true,
    ),
    null,
  );
  assert.equal(f.notifications.length, 0);
  Object.defineProperty(f.window.navigator, 'locks', { configurable: true, value: locks });
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(control.disabled, false);
  assert.equal(browserNotificationStatus(f.owner()).choice, 'disabled');
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(f.permissionRequests(), 0);
  await f.act(async () => control.click());
  assert.equal(browserNotificationStatus(f.owner()).enabled, true);
  assert.equal(f.notifications.length, 1);
  assert.equal(f.permissionRequests(), 0);
  f.native({ getSettings: async () => ({ notifications: true }) });
  await f.render(f.createElement(BrowserNotificationSettings, { ownerId: f.owner() }));
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  assert.equal(f.document.querySelector('[role="switch"]'), null);
  assert.equal(browserNotificationStatus(f.owner()).choice, 'enabled');
  assert.equal(f.notifications.length, 1);
  assert.equal(f.permissionRequests(), 0);
});

test('native notification introduction recovers settings-read failures before saving opt-in', async (t) => {
  const f = await notificationPage(t);
  const { ChatNotifications } = await import('../src/web/components/chat-notifications.tsx');
  let reads = 0;
  const writes: unknown[] = [];
  f.native({
    onPreferences: () => () => {},
    getSettings: async () => {
      reads++;
      if (reads === 1) throw new Error('Synthetic settings read failed');
      return { notifications: false };
    },
    saveSettings: async (value: { notifications: boolean }) => {
      writes.push(value);
      return value;
    },
  });
  await f.render(
    f.createElement(ChatNotifications, {
      ownerId: f.owner(),
      messageId: 'notification-retry-introduction',
    }),
  );
  assert.ok(f.document.querySelector('[role="alert"]'));
  assert.equal(reads, 1);
  assert.deepEqual(writes, []);
  await f.click(0);
  assert.equal(reads, 2);
  assert.deepEqual(writes, []);
  assert.equal(f.document.querySelector('[role="alert"]'), null);
  await f.click(0);
  assert.deepEqual(writes, [{ notifications: true }]);
  assert.equal(f.permissionRequests(), 0);
});

test('browser notification settings revoke a saved opt-in after browser permission is denied', async (t) => {
  const f = await notificationPage(t);
  const { BrowserNotificationSettings } =
    await import('../src/web/components/browser-notifications.tsx');
  const { browserNotificationStatus, deliverBrowserNotification, setBrowserNotifications } =
    await import('../src/web/lib/browser-notifications.ts');
  f.setPermission('granted');
  await setBrowserNotifications(f.owner(), true);
  f.setPermission('denied');
  await f.render(f.createElement(BrowserNotificationSettings, { ownerId: f.owner() }));
  const control = f.document.querySelector<HTMLButtonElement>('[role="switch"]');
  assert.ok(control);
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(control.disabled, true);
  assert.equal(browserNotificationStatus(f.owner()).choice, 'disabled');
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  assert.equal(f.permissionRequests(), 0);
  assert.equal(f.notifications.length, 1);
  f.setPermission('granted');
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(control.disabled, false);
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(
    await deliverBrowserNotification(
      f.owner(),
      'notification-denied-settings',
      { id: 'reply-after-external-grant', createdAt: '2035-01-01T12:00:00.000Z' },
      () => true,
    ),
    null,
  );
  assert.equal(f.notifications.length, 1);
  await f.act(async () => control.click());
  assert.equal(control.getAttribute('aria-checked'), 'true');
  assert.equal(browserNotificationStatus(f.owner()).enabled, true);
  assert.equal(f.notifications.length, 2);
  assert.equal(f.permissionRequests(), 0);
  f.setPermission('denied');
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  assert.equal(browserNotificationStatus(f.owner()).choice, 'disabled');
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(control.disabled, true);
});

test('browser notification settings recover a reset permission only after an explicit choice', async (t) => {
  const f = await notificationPage(t);
  const { BrowserNotificationSettings } =
    await import('../src/web/components/browser-notifications.tsx');
  const { browserNotificationStatus, setBrowserNotifications } =
    await import('../src/web/lib/browser-notifications.ts');
  f.setPermission('granted');
  await setBrowserNotifications(f.owner(), true);
  f.setPermission('default');
  await f.render(f.createElement(BrowserNotificationSettings, { ownerId: f.owner() }));
  const control = f.document.querySelector<HTMLButtonElement>('[role="switch"]');
  assert.ok(control);
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(control.disabled, false);
  assert.equal(f.permissionRequests(), 0);
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(browserNotificationStatus(f.owner()).choice, 'disabled');
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  assert.equal(f.permissionRequests(), 0);
  f.setPermission('granted');
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(f.notifications.length, 1);
  f.setPermission('default');
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  let answer: (permission: NotificationPermission) => void = () => {};
  f.respondPermission(() => new Promise((resolve) => (answer = resolve)));
  await f.act(async () => control.click());
  assert.equal(f.permissionRequests(), 1);
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(control.disabled, true);
  assert.equal(f.notifications.length, 1);
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  assert.equal(f.permissionRequests(), 1);
  assert.equal(control.disabled, true);
  await f.act(async () => answer('default'));
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(control.disabled, false);
  assert.ok(f.document.querySelector('[role="alert"]'));
  await f.act(async () => control.click());
  assert.equal(f.permissionRequests(), 2);
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(control.disabled, true);
  await f.act(async () => answer('granted'));
  assert.equal(browserNotificationStatus(f.owner()).enabled, true);
  assert.equal(control.getAttribute('aria-checked'), 'true');
  assert.equal(control.disabled, false);
  assert.equal(f.notifications.length, 2);
  assert.equal(f.document.querySelector('[role="alert"]'), null);
  const testAction = [...f.document.querySelectorAll('button')].find(
    (button) => button.getAttribute('role') !== 'switch' && !button.disabled,
  );
  assert.ok(testAction);
  await f.act(async () => testAction.click());
  assert.equal(f.notifications.length, 3);
  assert.equal(f.permissionRequests(), 2);
  await f.act(async () => control.click());
  assert.equal(browserNotificationStatus(f.owner()).choice, 'disabled');
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.equal(
    [...f.document.querySelectorAll('button')].some(
      (button) => button.getAttribute('role') !== 'switch' && !button.disabled,
    ),
    false,
  );
  assert.equal(f.permissionRequests(), 2);
});

test('browser notifications revoke background consent without mounting settings and require a fresh opt-in', async (t) => {
  const f = await notificationPage(t);
  f.setOwner('notification-hook-revocation-owner');
  const { useBrowserNotifications } = await import('../src/web/hooks/use-browser-notifications.ts');
  const { browserNotificationStatus, setBrowserNotifications } =
    await import('../src/web/lib/browser-notifications.ts');
  type AppState = import('../src/shared/contracts.ts').AppState;
  const messages: AppState['messages'] = [];
  function Watch() {
    useBrowserNotifications(f.owner(), {
      threadId: 'notification-hook-revocation-thread',
      messages: [...messages],
    } as AppState);
    return null;
  }
  const render = () => f.render(f.createElement(Watch));
  const add = () =>
    messages.push({
      id: `message-${messages.length}`,
      role: 'assistant',
      text: 'Synthetic reply',
      turnId: null,
      createdAt: new Date(Date.UTC(2035, 0, 1, 12, 0, messages.length)).toISOString(),
      attachments: [],
    });
  f.setPermission('granted');
  await setBrowserNotifications(f.owner(), true);
  add();
  await render();
  assert.equal(f.notifications.length, 1);
  f.setPermission('default');
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  assert.equal(browserNotificationStatus(f.owner()).choice, 'disabled');
  assert.equal(f.permissionRequests(), 0);
  f.setPermission('granted');
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  add();
  await render();
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(f.notifications.length, 1);
  await f.act(async () => setBrowserNotifications(f.owner(), true));
  assert.equal(f.notifications.length, 2);
  add();
  await render();
  assert.equal(f.notifications.length, 3);
  assert.equal(f.notifications.at(-1)!.visible, true);
  assert.equal(f.permissionRequests(), 0);
});

test('browser notifications honor queued cross-tab revocations without cancelling another owner', async (t) => {
  const f = await notificationPage(t);
  f.setOwner('notification-storage-revocation-owner');
  const { BrowserNotificationSettings } =
    await import('../src/web/components/browser-notifications.tsx');
  const { useBrowserNotifications } = await import('../src/web/hooks/use-browser-notifications.ts');
  const { browserNotificationStatus } = await import('../src/web/lib/browser-notifications.ts');
  type AppState = import('../src/shared/contracts.ts').AppState;
  const messages: AppState['messages'] = [];
  function Watch() {
    useBrowserNotifications(f.owner(), {
      threadId: 'notification-storage-revocation-thread',
      messages: [...messages],
    } as AppState);
    return f.createElement(BrowserNotificationSettings, { ownerId: f.owner() });
  }
  const render = () => f.render(f.createElement(Watch));
  const add = () =>
    messages.push({
      id: `message-${messages.length}`,
      role: 'assistant',
      text: 'Synthetic reply',
      turnId: null,
      createdAt: new Date(Date.UTC(2035, 0, 1, 12, 0, messages.length)).toISOString(),
      attachments: [],
    });
  const revoke = (owner: string) =>
    f.act(async () =>
      f.window.dispatchEvent(
        new f.window.StorageEvent('storage', {
          key: `nod.browser-notifications.${owner}`,
          oldValue: 'enabled',
          newValue: 'disabled',
          storageArea: f.window.localStorage,
        }),
      ),
    );
  f.setPermission('granted');
  f.delayShow(true);
  add();
  await render();
  const control = f.document.querySelector<HTMLButtonElement>('[role="switch"]');
  assert.ok(control);
  await f.act(async () => control.click());
  assert.equal(f.notifications.length, 1);
  const confirmation = f.notifications[0]!;
  add();
  await render();
  assert.equal(f.notifications.length, 2);
  const shownReply = f.notifications[1]!;
  shownReply.show();
  await revoke('notification-unrelated-owner');
  confirmation.show();
  assert.equal(confirmation.visible, true);
  assert.equal(shownReply.visible, true);
  assert.equal(shownReply.closed, 0);
  const testAction = [...f.document.querySelectorAll('button')].find(
    (button) => button.getAttribute('role') !== 'switch' && !button.disabled,
  );
  assert.ok(testAction);
  await f.act(async () => testAction.click());
  assert.equal(f.notifications.length, 3);
  const queuedConfirmation = f.notifications[2]!;
  add();
  await render();
  assert.equal(f.notifications.length, 4);
  const queuedReply = f.notifications[3]!;
  assert.equal(f.window.localStorage.getItem(`nod.browser-notifications.${f.owner()}`), 'enabled');
  await revoke(f.owner());
  assert.equal(browserNotificationStatus(f.owner()).enabled, true);
  assert.equal(confirmation.visible, false);
  assert.equal(shownReply.visible, false);
  queuedConfirmation.show();
  queuedReply.show();
  assert.equal(queuedConfirmation.visible, false);
  assert.equal(queuedReply.visible, false);
  await f.act(async () => testAction.click());
  assert.equal(f.notifications.length, 5);
  const freshConfirmation = f.notifications[4]!;
  add();
  await render();
  assert.equal(f.notifications.length, 6);
  const freshReply = f.notifications[5]!;
  freshConfirmation.show();
  freshReply.show();
  assert.equal(freshConfirmation.visible, true);
  assert.equal(freshReply.visible, true);
  assert.equal(f.permissionRequests(), 0);
});

test('browser notifications remain revoked when persisting permission reconciliation fails', async (t) => {
  const f = await notificationPage(t);
  f.setOwner('notification-storage-failure-owner');
  const { useBrowserNotifications } = await import('../src/web/hooks/use-browser-notifications.ts');
  const { browserNotificationStatus, setBrowserNotifications } =
    await import('../src/web/lib/browser-notifications.ts');
  type AppState = import('../src/shared/contracts.ts').AppState;
  const messages: AppState['messages'] = [];
  function Watch() {
    useBrowserNotifications(f.owner(), {
      threadId: 'notification-storage-failure-thread',
      messages: [...messages],
    } as AppState);
    return null;
  }
  const render = () => f.render(f.createElement(Watch));
  const add = () =>
    messages.push({
      id: `message-${messages.length}`,
      role: 'assistant',
      text: 'Synthetic reply',
      turnId: null,
      createdAt: new Date(Date.UTC(2035, 0, 1, 12, 0, messages.length)).toISOString(),
      attachments: [],
    });
  f.setPermission('granted');
  await setBrowserNotifications(f.owner(), true);
  f.setPermission('default');
  const key = `nod.browser-notifications.${f.owner()}`;
  const prototype = Object.getPrototypeOf(f.window.localStorage) as Storage;
  const originalSetItem = prototype.setItem;
  const setItem = t.mock.method(
    prototype,
    'setItem',
    function (this: Storage, name: string, value: string) {
      if (name === key) throw new Error('Synthetic storage write failed');
      return originalSetItem.call(this, name, value);
    },
  );
  add();
  await render();
  assert.equal(f.window.localStorage.getItem(key), 'enabled');
  assert.equal(browserNotificationStatus(f.owner()).choice, 'disabled');
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  setItem.mock.restore();
  f.setPermission('granted');
  await f.act(async () => f.window.dispatchEvent(new f.window.Event('focus')));
  await f.act(async () =>
    f.window.dispatchEvent(
      new f.window.StorageEvent('storage', {
        key,
        oldValue: 'disabled',
        newValue: 'enabled',
        storageArea: f.window.localStorage,
      }),
    ),
  );
  add();
  await render();
  assert.equal(browserNotificationStatus(f.owner()).enabled, false);
  assert.equal(f.notifications.length, 1);
  await f.act(async () => setBrowserNotifications(f.owner(), true));
  assert.equal(browserNotificationStatus(f.owner()).enabled, true);
  assert.equal(f.notifications.length, 2);
  add();
  await render();
  assert.equal(f.notifications.length, 3);
  assert.equal(f.notifications.at(-1)!.visible, true);
  assert.equal(f.permissionRequests(), 0);
});

test('feedback capture runs once for a fresh owned draft and skips restored or pending submissions', async (t) => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { createFeedbackCapture } = await import('../src/web/lib/feedback-capture.ts');
  const { saveFeedbackDraft, writeFeedbackPending } =
    await import('../src/web/lib/feedback-draft.ts');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDatabase = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const storage = new Map<string, string>();
  let captures = 0;
  let refused = false;
  const bridge = {
    async captureFeedbackScreenshot() {
      captures++;
      return refused ? null : new Uint8Array([255, 216, 255, 217]);
    },
  };
  const window = {
    nodDesktop: bridge as typeof bridge | undefined,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalDatabase) Object.defineProperty(globalThis, 'indexedDB', originalDatabase);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  });
  const capture = createFeedbackCapture('capture-owner-one');
  const [first, simultaneous] = await Promise.all([capture.capture(), capture.capture()]);
  assert.equal(captures, 1);
  assert.equal(first?.type, 'image/jpeg');
  assert.equal(first?.name, 'nod-screenshot.jpg');
  assert.deepEqual(
    new Uint8Array(await simultaneous!.arrayBuffer()),
    new Uint8Array([255, 216, 255, 217]),
  );
  await capture.capture();
  assert.equal(captures, 1);
  await saveFeedbackDraft('capture-owner-one', {
    category: 'bug',
    feedback: 'Synthetic saved draft',
    attachments: [{ id: randomUUID(), file: first! }],
    pendingId: null,
    reportChoice: true,
  });
  assert.equal(await createFeedbackCapture('capture-owner-one').capture(), null);
  assert.equal(captures, 1);
  const otherOwner = createFeedbackCapture('capture-owner-two');
  assert.ok(await otherOwner.capture());
  assert.equal(captures, 2);
  writeFeedbackPending('nod.feedback.pending.capture-pending-owner', randomUUID());
  assert.equal(await createFeedbackCapture('capture-pending-owner').capture(), null);
  assert.equal(captures, 2);
  await saveFeedbackDraft('capture-owner-one', null);
  capture.reset();
  assert.ok(await capture.capture());
  assert.equal(captures, 3);
  refused = true;
  capture.reset();
  assert.equal(await capture.capture(), null);
  assert.equal(await capture.capture(), null);
  assert.equal(captures, 4);
  window.nodDesktop = undefined;
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    get() {
      assert.fail('Web feedback must not wait for native screenshot draft storage.');
    },
  });
  assert.equal(await createFeedbackCapture('web-owner').capture(), null);
  assert.equal(captures, 4);
});

describe('persisted setting analytics privacy', { skip: !process.env.TEST_DATABASE_URL }, () => {
  async function fixture(t: import('node:test').TestContext, timeZone = 'UTC') {
    const schema = `test_setting_analytics_${randomUUID().replaceAll('-', '')}`;
    const root = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await root.query(`CREATE SCHEMA ${schema}`);
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema} -c timezone=${timeZone}`,
      max: 4,
    });
    t.after(async () => {
      await database.end();
      await root.query(`DROP SCHEMA ${schema} CASCADE`);
      await root.end();
    });
    await database.query(`CREATE TABLE turns(id uuid PRIMARY KEY);
      CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text NOT NULL,role text NOT NULL,thread_id uuid,created_at timestamptz NOT NULL);
      CREATE TABLE preferences(owner_id text PRIMARY KEY,notification_rule text NOT NULL DEFAULT '',rules text NOT NULL DEFAULT '',
        time_zone text,quiet_start text NOT NULL DEFAULT '22:00',quiet_end text NOT NULL DEFAULT '08:00',
        quiet_hours_enabled boolean NOT NULL DEFAULT true,locale text,hour_cycle text NOT NULL DEFAULT 'auto',
        speech_voice text,speech_reply text NOT NULL DEFAULT 'auto',proactive_paused boolean NOT NULL DEFAULT false,
        local_files_enabled boolean NOT NULL DEFAULT false)`);
    const captured: Parameters<ProductAnalytics['capture']>[0][] = [];
    const analytics = await createAnalytics({
      provider: { capture: (event) => captured.push(event), shutdown: async () => {} },
      environment: 'development',
      dataRoot: '.',
      installationId: randomUUID(),
    });
    const owner = 'synthetic-settings-owner';
    analytics.setUsageData(owner, true);
    const changes = () =>
      captured
        .filter(({ event }) => event === 'setting_changed')
        .map(({ properties }) => ({
          setting: properties.setting,
          actor: properties.actor,
          state: properties.state,
        }));
    return { database, captured, analytics, owner, changes };
  }

  test("survey eligibility counts the owner's distinct UTC message days across conversations", async (t) => {
    const { createAccountStore } = await import('../src/server/account-store.ts');
    const f = await fixture(t, 'America/Los_Angeles');
    const accounts = createAccountStore(f.database);
    await accounts.initialize();
    const app = Fastify();
    t.after(() => app.close());
    createAccountSession({
      accounts,
      analytics: f.analytics,
      localUser: { id: f.owner, name: 'Synthetic Owner', email: null, avatarUrl: null },
    }).register(app);
    const session = async () => {
      const response = await app.inject({ method: 'GET', url: '/api/session' });
      assert.equal(response.statusCode, 200);
      return response.json();
    };
    const message = (owner: string, role: string, thread: string, at: string) =>
      f.database.query(
        'INSERT INTO messages(id,owner_id,role,thread_id,created_at) VALUES ($1,$2,$3,$4,$5)',
        [randomUUID(), owner, role, thread, at],
      );
    const previousThread = randomUUID();
    const currentThread = randomUUID();
    for (const day of ['2026-10-28', '2026-10-29', '2026-10-30']) {
      await message('foreign-survey-owner', 'user', previousThread, `${day}T12:00:00Z`);
      await message(f.owner, 'assistant', previousThread, `${day}T12:00:00Z`);
    }
    assert.equal(await accounts.activeDays(f.owner, 3), 0);
    assert.equal((await session()).analytics.surveys, false);
    await message(f.owner, 'user', previousThread, '2026-10-30T23:30:00-01:00');
    await message(f.owner, 'user', previousThread, '2026-11-01T00:30:00+01:00');
    assert.equal(await accounts.activeDays(f.owner, 3), 1);
    await message(f.owner, 'user', currentThread, '2026-11-01T00:30:00Z');
    assert.equal(await accounts.activeDays(f.owner, 3), 2);
    assert.equal((await session()).analytics.surveys, false);
    await message(f.owner, 'user', currentThread, '2026-11-02T00:01:00Z');
    assert.equal((await session()).analytics.surveys, true);
    await message(f.owner, 'user', currentThread, '2026-11-03T12:00:00Z');
    assert.equal(await createAccountStore(f.database).activeDays(f.owner, 3), 3);
    assert.equal(await accounts.activeDays('owner-without-messages', 3), 0);

    await accounts.update(f.owner, { onboardingCompleted: true });
    assert.deepEqual((await session()).analytics.seenSurveys, []);
    const survey = randomUUID();
    const seen = (key: string) =>
      app.inject({
        method: 'POST',
        url: '/api/account/survey-seen',
        headers: { origin: 'http://localhost:4399' },
        payload: { survey: key },
      });
    assert.notEqual((await seen('not-a-survey')).statusCode, 200);
    assert.notEqual((await seen(`${survey}_${'9'.repeat(10)}`)).statusCode, 200);
    assert.equal((await seen(survey)).statusCode, 200);
    assert.equal((await seen(survey)).statusCode, 200);
    assert.equal((await seen(`${survey}_2`)).statusCode, 200);
    const restarted = Fastify();
    t.after(() => restarted.close());
    createAccountSession({
      accounts: createAccountStore(f.database),
      analytics: f.analytics,
      localUser: { id: f.owner, name: 'Synthetic Owner', email: null, avatarUrl: null },
    }).register(restarted);
    const after = await restarted.inject({ method: 'GET', url: '/api/session' });
    assert.deepEqual(after.json().analytics.seenSurveys, [survey, `${survey}_2`]);
    await accounts.update('other-survey-owner', { onboardingCompleted: true });
    assert.deepEqual(await accounts.seenSurveys('other-survey-owner'), []);
    const keys = Array.from({ length: 101 }, () => randomUUID());
    for (const key of keys) await accounts.markSurveySeen('other-survey-owner', key);
    assert.deepEqual(await accounts.seenSurveys('other-survey-owner'), keys.slice(1));
  });

  test('preferences and spending expose committed bounded states across actors, owners and consent periods', async (t) => {
    const { createPreferencesStore } = await import('../src/server/preferences.ts');
    const f = await fixture(t);
    const preferences = createPreferencesStore(f.database, f.owner, f.analytics.forOwner(f.owner));
    await preferences.update({ proactivePaused: false });
    f.captured.length = 0;
    const privatePatch = {
      notificationRule: 'Synthetic private notification rule',
      rules: 'Synthetic private standing rule',
      timeZone: 'Europe/Lisbon',
      locale: 'pt-pt',
      quietStart: '20:15',
      quietEnd: '07:45',
      quietHoursEnabled: false,
      proactivePaused: true,
      speechReply: 'always' as const,
    };
    const saved = await preferences.update(privatePatch, 'agent');
    assert.equal(saved.locale, 'pt-PT');
    assert.equal((await preferences.get()).rules, privatePatch.rules);
    assert.equal(f.changes().length, 9);
    assert.ok(f.changes().every(({ actor }) => actor === 'agent'));
    for (const privateValue of ['Synthetic private', 'Europe/Lisbon', '20:15', 'pt-PT'])
      assert.ok(!JSON.stringify(f.captured).includes(privateValue));
    await preferences.update(privatePatch);
    await assert.rejects(preferences.update({ locale: 'not_a_locale' }));
    assert.equal(f.changes().length, 9);
    await f.database.query(
      "ALTER TABLE preferences ADD CONSTRAINT refuse_synthetic_rule CHECK(rules <> 'rejected synthetic rule')",
    );
    await assert.rejects(preferences.update({ rules: 'rejected synthetic rule' }));
    assert.equal((await preferences.get()).rules, privatePatch.rules);
    assert.equal(f.changes().length, 9);
    await Promise.all([
      preferences.update({ proactivePaused: false }),
      preferences.update({ proactivePaused: false }),
    ]);
    assert.equal(f.changes().length, 10);
    await Promise.all([
      preferences.update({ proactivePaused: true }),
      preferences.update({ proactivePaused: false }),
    ]);
    const paused = (await preferences.get()).proactivePaused;
    assert.deepEqual(
      f
        .changes()
        .slice(10)
        .map(({ state }) => state),
      paused ? ['on'] : ['on', 'off'],
    );
    const preferenceCount = f.changes().length;
    const foreign = createPreferencesStore(
      f.database,
      'foreign-owner',
      f.analytics.forOwner('foreign-owner'),
    );
    await foreign.update({ rules: 'Foreign private rule' });
    assert.equal(f.changes().length, preferenceCount);
    assert.equal((await preferences.get()).rules, privatePatch.rules);
    const lock = await f.database.connect();
    await lock.query('BEGIN');
    await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `preferences:${f.owner}`,
    ]);
    const late = preferences.update({ rules: 'Late synthetic private rule' });
    f.analytics.setUsageData(f.owner, false);
    f.analytics.setUsageData(f.owner, true);
    await lock.query('COMMIT');
    lock.release();
    await late;
    assert.equal((await preferences.get()).rules, 'Late synthetic private rule');
    assert.equal(f.changes().length, preferenceCount);
    const ledger = createLedger({
      pool: f.database,
      ownerId: f.owner,
      analytics: f.analytics.forOwner(f.owner),
    });
    await ledger.initialize();
    await ledger.setLimits({ monthlyUsd: 37.42, taskUsd: 8.53 }, 'agent');
    assert.deepEqual(f.changes().slice(-2), [
      { setting: 'monthly_spending_limit', actor: 'agent', state: 'configured' },
      { setting: 'task_spending_limit', actor: 'agent', state: 'configured' },
    ]);
    await ledger.setLimits({ preparationUsd: 3.17 }, 'owner');
    assert.deepEqual(f.changes().at(-1), {
      setting: 'preparation_spending_limit',
      actor: 'owner',
      state: 'configured',
    });
    const count = f.changes().length;
    await ledger.setLimits({ monthlyUsd: 37.42, taskUsd: 8.53, preparationUsd: 3.17 });
    await assert.rejects(ledger.setLimits({ monthlyUsd: -1 }));
    assert.equal(f.changes().length, count);
    await ledger.setLimits({ monthlyUsd: null, taskUsd: null });
    assert.deepEqual(
      f
        .changes()
        .slice(-2)
        .map(({ state }) => state),
      ['off', 'off'],
    );
    for (const privateValue of ['37.42', '8.53'])
      assert.ok(!JSON.stringify(f.captured).includes(privateValue));
    await preferences.update({ timeZone: null }, 'system');
    assert.deepEqual(f.changes().at(-1), {
      setting: 'time_zone',
      actor: 'system',
      state: 'default',
    });
  });

  test('shared transactions preserve preference authority, rollback and analytics consent', async (t) => {
    const { createPreferencesStore } = await import('../src/server/preferences.ts');
    const { transaction } = await import('../src/server/transaction.ts');
    const f = await fixture(t);
    const preferences = createPreferencesStore(f.database, f.owner, f.analytics.forOwner(f.owner));
    const rules = 'Synthetic reviewed standing rules';
    await preferences.update({ rules, notificationRule: 'Synthetic original notification' });
    f.captured.length = 0;
    await transaction(async (client) => {
      const saved = await preferences.update(
        { notificationRule: 'Synthetic accepted notification' },
        'agent',
        { expectedRules: rules, client },
      );
      assert.equal(saved.notificationRule, 'Synthetic accepted notification');
      assert.equal((await preferences.get()).notificationRule, 'Synthetic original notification');
      assert.deepEqual(f.changes(), []);
    }, f.database);
    assert.equal((await preferences.get()).notificationRule, 'Synthetic accepted notification');
    assert.deepEqual(f.changes(), [
      { setting: 'notification_rule', actor: 'agent', state: 'configured' },
    ]);
    await assert.rejects(
      transaction(async (client) => {
        await preferences.update({ rules: 'Synthetic rolled-back rules' }, 'agent', {
          expectedRules: rules,
          client,
        });
        assert.equal(f.changes().length, 1);
        throw new Error('Synthetic outer preference rollback');
      }, f.database),
      /Synthetic outer preference rollback/,
    );
    assert.equal((await preferences.get()).rules, rules);
    assert.equal(f.changes().length, 1);
    await assert.rejects(
      transaction(
        (client) =>
          preferences.update({ notificationRule: 'Synthetic unauthorized notification' }, 'agent', {
            expectedRules: 'Synthetic stale reviewed rules',
            client,
          }),
        f.database,
      ),
      {
        statusCode: 409,
        message: 'The saved owner instructions changed. Review them before asking again.',
      },
    );
    assert.equal((await preferences.get()).notificationRule, 'Synthetic accepted notification');
    assert.equal(f.changes().length, 1);
    await assert.rejects(
      preferences.update({ notificationRule: 'Synthetic stale replacement' }, 'agent', {
        expectedNotificationRule: 'Synthetic original notification',
      }),
      { statusCode: 409 },
    );
    assert.equal((await preferences.get()).notificationRule, 'Synthetic accepted notification');
    for (const enabled of [true, false]) {
      f.analytics.setUsageData(f.owner, enabled);
      await transaction(async (client) => {
        await preferences.update({ proactivePaused: enabled }, 'agent', {
          expectedRules: rules,
          client,
        });
        f.analytics.setUsageData(f.owner, false);
        f.analytics.setUsageData(f.owner, true);
        assert.equal(f.changes().length, 1);
      }, f.database);
      assert.equal((await preferences.get()).proactivePaused, enabled);
      assert.equal(f.changes().length, 1);
    }
    await transaction(
      (client) =>
        preferences.update({ proactivePaused: true }, 'agent', { expectedRules: rules, client }),
      f.database,
    );
    assert.deepEqual(f.changes().slice(1), [
      { setting: 'proactivity_paused', actor: 'agent', state: 'on' },
    ]);
    assert.ok(!JSON.stringify(f.captured).includes('Synthetic'));
  });

  test('shared transactions defer spending analytics until commit and fence consent changes', async (t) => {
    const { transaction } = await import('../src/server/transaction.ts');
    const f = await fixture(t);
    const ledger = createLedger({
      pool: f.database,
      ownerId: f.owner,
      analytics: f.analytics.forOwner(f.owner),
    });
    await ledger.initialize();
    await ledger.setLimits({ monthlyUsd: 37.42, taskUsd: 8.53 });
    f.captured.length = 0;
    await transaction(async (client) => {
      const saved = await ledger.setLimits({ monthlyUsd: 50.26, taskUsd: null }, 'agent', client);
      assert.deepEqual(saved, { limit: { monthlyUsd: 50.26, reached: false }, taskUsd: null });
      assert.deepEqual(await ledger.limits(), {
        limit: { monthlyUsd: 37.42, reached: false },
        taskUsd: 8.53,
      });
      assert.deepEqual(f.changes(), []);
    }, f.database);
    assert.deepEqual(await ledger.limits(), {
      limit: { monthlyUsd: 50.26, reached: false },
      taskUsd: null,
    });
    assert.deepEqual(f.changes(), [
      { setting: 'monthly_spending_limit', actor: 'agent', state: 'configured' },
      { setting: 'task_spending_limit', actor: 'agent', state: 'off' },
    ]);
    await assert.rejects(
      transaction(async (client) => {
        await ledger.setLimits({ monthlyUsd: null, taskUsd: 5 }, 'agent', client);
        assert.equal(f.changes().length, 2);
        throw new Error('Synthetic outer spending rollback');
      }, f.database),
      /Synthetic outer spending rollback/,
    );
    assert.deepEqual(await ledger.limits(), {
      limit: { monthlyUsd: 50.26, reached: false },
      taskUsd: null,
    });
    assert.equal(f.changes().length, 2);
    for (const enabled of [true, false]) {
      const monthlyUsd = enabled ? 60.19 : 70.31;
      f.analytics.setUsageData(f.owner, enabled);
      await transaction(async (client) => {
        await ledger.setLimits({ monthlyUsd }, 'agent', client);
        f.analytics.setUsageData(f.owner, false);
        f.analytics.setUsageData(f.owner, true);
        assert.equal(f.changes().length, 2);
      }, f.database);
      assert.equal((await ledger.limits()).limit?.monthlyUsd, monthlyUsd);
      assert.equal(f.changes().length, 2);
    }
    await transaction(
      (client) => ledger.setLimits({ monthlyUsd: null }, 'agent', client),
      f.database,
    );
    assert.deepEqual(f.changes().slice(2), [
      { setting: 'monthly_spending_limit', actor: 'agent', state: 'off' },
    ]);
    for (const amount of ['37.42', '8.53', '50.26', '60.19', '70.31'])
      assert.ok(!JSON.stringify(f.captured).includes(amount));
  });

  test('memory settings emit successful CAS transitions and retain the starting consent period', async (t) => {
    const { createMemoryService } = await import('../src/server/memory.ts');
    const { createPostgresObjectStore } = await import('../src/server/object-storage.ts');
    const f = await fixture(t);
    const store = createPostgresObjectStore({ database: f.database, ownerId: f.owner });
    await store.initialize();
    let fail = false;
    let hold: (() => Promise<void>) | undefined;
    const memory = createMemoryService({
      pool: f.database,
      ownerId: f.owner,
      analytics: f.analytics.forOwner(f.owner),
      store: {
        ...store,
        async write(...args) {
          if (fail) throw new Error('Synthetic private store failure');
          await hold?.();
          return store.write(...args);
        },
      },
    });
    await memory.settings({ saving: false, sensitive: true });
    assert.deepEqual(f.changes(), [
      { setting: 'memory_enabled', actor: 'owner', state: 'off' },
      { setting: 'memory_sensitive', actor: 'owner', state: 'on' },
    ]);
    await memory.settings({ saving: false, sensitive: true });
    assert.equal(f.changes().length, 2);
    fail = true;
    await assert.rejects(memory.settings({ saving: true }), /Synthetic private store failure/);
    assert.equal(f.changes().length, 2);
    fail = false;
    await Promise.all([memory.control({ enabled: true }), memory.control({ enabled: true })]);
    assert.deepEqual(f.changes().slice(2), [
      { setting: 'memory_enabled', actor: 'agent', state: 'on' },
    ]);
    const entered = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    })();
    const release = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    })();
    hold = async () => {
      entered.resolve();
      await release.promise;
    };
    const late = memory.settings({ sensitive: false });
    await entered.promise;
    f.analytics.setUsageData(f.owner, false);
    f.analytics.setUsageData(f.owner, true);
    release.resolve();
    await late;
    assert.equal(f.changes().length, 3);
  });

  test('finishing setup gives a new owner a monthly limit once and never restores a removed one', async (t) => {
    const { createAccountStore } = await import('../src/server/account-store.ts');
    const f = await fixture(t);
    const ledger = createLedger({ pool: f.database, ownerId: f.owner });
    await ledger.initialize();
    const accounts = createAccountStore(f.database, { onboard: ledger.onboard });
    await accounts.initialize();
    assert.equal((await ledger.limits()).limit, null);
    await accounts.update(f.owner, { onboardingCompleted: true });
    assert.equal((await ledger.limits()).limit?.reached, false);
    await ledger.setLimits({ monthlyUsd: null });
    await accounts.update(f.owner, { onboardingCompleted: true });
    assert.equal((await ledger.limits()).limit, null);
  });

  test('account changes follow saved values and do not cross queued opt-out or failed writes', async (t) => {
    const { createAccountStore } = await import('../src/server/account-store.ts');
    const f = await fixture(t);
    const accounts = createAccountStore(f.database);
    await accounts.initialize();
    await accounts.update(f.owner, { usageData: false });
    const initialConsent = await accounts.readConsent(f.owner);
    const origin = 'http://localhost:4399';
    const app = Fastify();
    t.after(() => app.close());
    let hold: (() => Promise<void>) | undefined;
    let holdAll = false;
    createAccountSession({
      accounts: {
        ...accounts,
        async update(owner, input) {
          if (holdAll || input.theme !== undefined) await hold?.();
          return accounts.update(owner, input);
        },
      },
      analytics: f.analytics,
      traces: true,
      localUser: { id: f.owner, name: 'Synthetic Owner', email: null, avatarUrl: null },
    }).register(app);
    await app.inject({ method: 'GET', url: '/api/session' });
    const update = (payload: object) =>
      app.inject({ method: 'PATCH', url: '/api/account', headers: { origin }, payload });
    assert.equal((await update({ usageData: true })).statusCode, 200);
    const enabledConsent = await accounts.readConsent(f.owner);
    assert.equal(enabledConsent.enabled, true);
    assert.equal(BigInt(enabledConsent.revision), BigInt(initialConsent.revision) + 1n);
    assert.deepEqual(f.changes(), [{ setting: 'usage_data', actor: 'owner', state: 'on' }]);
    await update({ theme: 'dark', traces: true });
    assert.equal((await accounts.readConsent(f.owner)).revision, enabledConsent.revision);
    assert.deepEqual(f.changes().slice(1), [
      { setting: 'theme', actor: 'owner', state: 'dark' },
      { setting: 'conversation_traces', actor: 'owner', state: 'on' },
    ]);
    await update({ theme: 'dark', traces: true });
    assert.equal(f.changes().length, 3);
    await f.database.query(
      "ALTER TABLE account_settings ADD CONSTRAINT refuse_synthetic_light CHECK(theme <> 'light')",
    );
    assert.equal((await update({ theme: 'light' })).statusCode, 500);
    assert.equal(f.changes().length, 3);
    const entered = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    })();
    const release = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    })();
    hold = async () => {
      entered.resolve();
      await release.promise;
    };
    const theme = update({ theme: 'system' }).then((response) => response);
    await entered.promise;
    const off = update({ usageData: false }).then((response) => response);
    for (let i = 0; i < 100 && f.analytics.consent(f.owner).enabled; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(f.analytics.consent(f.owner).enabled, false);
    const on = update({ usageData: true }).then((response) => response);
    await new Promise((resolve) => setTimeout(resolve, 5));
    release.resolve();
    await Promise.all([theme, off, on]);
    const restoredConsent = await accounts.readConsent(f.owner);
    assert.equal(restoredConsent.enabled, true);
    assert.equal(BigInt(restoredConsent.revision), BigInt(enabledConsent.revision) + 2n);
    assert.equal((await accounts.read(f.owner)).theme, 'system');
    assert.deepEqual(f.changes().slice(3), [
      { setting: 'usage_data', actor: 'owner', state: 'on' },
    ]);
    await update({ usageData: false, traces: false });
    const disabledConsent = await accounts.readConsent(f.owner);
    assert.equal(disabledConsent.enabled, false);
    assert.equal(BigInt(disabledConsent.revision), BigInt(restoredConsent.revision) + 1n);
    assert.equal(f.changes().length, 4);
    assert.equal(f.analytics.consent(f.owner).enabled, false);
    holdAll = true;
    for (const tail of [{ usageData: true }, { theme: 'light' }]) {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      hold = async () => {
        entered();
        await blocked;
      };
      const count = f.changes().length;
      const enable = update({ usageData: true }).then((response) => response);
      await started;
      const later = update(tail).then((response) => response);
      await new Promise((resolve) => setTimeout(resolve, 5));
      release();
      assert.equal((await enable).statusCode, 200);
      assert.equal((await later).statusCode, 'theme' in tail ? 500 : 200);
      assert.deepEqual(f.changes().slice(count), [
        { setting: 'usage_data', actor: 'owner', state: 'on' },
      ]);
      await update({ usageData: false });
    }
  });
});

function withOwnerIds<
  T extends { userMessages?: ReadonlyArray<{ at: string; text: string; canAuthorize?: boolean }> },
>(words: T, ids: readonly string[]) {
  return {
    ...words,
    userMessages: words.userMessages?.map((message, index) => ({ ...message, id: ids[index] })),
  };
}

test('startup reports require review and keep exact redacted content through send and restart', async (t) => {
  const { createStartupFeedback } = await import('../src/server/startup-feedback.ts');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'nod-startup-feedback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'logs'));
  const secret = 'synthetic-startup-private-key';
  const privateName = 'Synthetic Person';
  await writeFile(
    join(root, 'logs', 'startup.log'),
    `2026-11-19T00:00:00.000Z Startup failed ${secret} ${privateName} private@example.test /Users/private-person/record.txt https://private.example.test/account\n`,
  );
  const context = {
    appVersion: '0.9.0',
    appRelease: 'a'.repeat(40),
    appModified: false,
    platform: 'win32-x64',
    development: false,
    source: 'desktop' as const,
  };
  const submitted: import('../src/ports/feedback.ts').FeedbackEnvelope[] = [];
  const statusCalls: string[][] = [];
  let dispatchReady!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    dispatchReady = resolve;
  });
  let release!: (value: import('../src/shared/feedback.ts').FeedbackReceipt) => void;
  let nextStatus: import('../src/shared/feedback.ts').FeedbackReceipt['status'] = 'unknown';
  const options = {
    dataRoot: root,
    context,
    secrets: [secret],
    names: [privateName],
    startupLog: {
      entries: [
        {
          ageMs: 1000,
          line: `Startup failed ${secret} ${privateName} private@example.test /Users/private-person/record.txt https://private.example.test/account`,
        },
      ],
      truncated: false,
    },
    status: {
      phase: 'error',
      error: `Synthetic failure for ${privateName} ${secret}`,
      details: 'HTTP 503',
      failure: { class: 'Error', httpStatus: 503 },
    },
    delivery: {
      configured: true,
      recipient: 'n8n',
      async submit(envelope: import('../src/ports/feedback.ts').FeedbackEnvelope) {
        submitted.push(envelope);
        dispatchReady();
        return new Promise<import('../src/shared/feedback.ts').FeedbackReceipt>((resolve) => {
          release = resolve;
        });
      },
      async status(id: string, payloadHash: string) {
        statusCalls.push([id, payloadHash]);
        return { submissionId: id, status: nextStatus };
      },
    },
  };
  const service = createStartupFeedback(options);
  assert.equal((await service.context()).recipient, 'n8n');
  assert.equal(submitted.length, 0);
  await assert.rejects(service.send(randomUUID()), /Review the report again/);
  const first = await service.review({
    feedback: '  Synthetic startup does not finish.\n\n',
    includeReport: true,
  });
  assert.equal(submitted.length, 0);
  const content = first.content!;
  for (const value of [
    secret,
    privateName,
    'private@example.test',
    '/Users/private-person',
    'private.example.test',
  ])
    assert.ok(!content.includes(value), value);
  assert.match(content, /503/);
  assert.ok(!content.includes('2026-11-19T'));
  assert.equal(typeof JSON.parse(content).startupLog.entries[0].ageMs, 'number');
  options.startupLog.entries = [
    { ageMs: 500, line: `${'Synthetic detail '.repeat(234)}${secret} end` },
  ];
  const boundary = await service.review({
    feedback: 'Synthetic boundary check.',
    includeReport: true,
  });
  assert.ok(
    !boundary.content!.includes(secret.slice(0, 12)),
    'Startup prose must be omitted before text bounds.',
  );
  const changedSecret = 'synthetic-rotated-startup-key';
  options.secrets.push(changedSecret);
  options.startupLog.entries.push({ ageMs: 0, line: `Synthetic rotated key ${changedSecret}` });
  const current = await service.review({ feedback: first.feedback, includeReport: true });
  assert.ok(!current.content!.includes(changedSecret));
  assert.equal(JSON.parse(content).schema, 'nod-desktop-startup-report-v2');
  options.startupLog.entries = [{ ageMs: 0, line: 'Synthetic later event not reviewed' }];
  const sending = service.send(current.reviewId);
  await Promise.race([dispatched, sending]);
  assert.equal(submitted.length, 1);
  assert.equal(Buffer.from(submitted[0].report!.data, 'base64').toString(), current.content);
  assert.equal(first.feedback, '  Synthetic startup does not finish.\n\n');
  assert.equal(submitted[0].feedback, first.feedback);
  const duplicate = service.send(current.reviewId);
  await assert.rejects(
    service.review({ feedback: 'Changed', includeReport: false }),
    /Check the previous report/,
  );
  release({ submissionId: current.reviewId, status: 'unknown' });
  assert.equal((await sending).status, 'unknown');
  assert.equal((await duplicate).status, 'unknown');
  assert.equal(submitted.length, 1);
  const saved = await readFile(join(root, 'startup-feedback.json'), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(saved)).sort(), ['payloadHash', 'submissionId']);
  assert.ok(!saved.includes('Synthetic'));
  const restarted = createStartupFeedback(options);
  assert.equal((await restarted.context()).pending?.status, 'unknown');
  assert.equal((await restarted.send(current.reviewId)).status, 'unknown');
  assert.equal(submitted.length, 1);
  assert.equal(statusCalls.at(-1)?.[0], current.reviewId);
  assert.equal(statusCalls.at(-1)?.[1], submitted[0].payloadHash);
  await assert.rejects(
    restarted.review({ feedback: 'Changed', includeReport: false }),
    /Check the previous report/,
  );
  nextStatus = 'submitted';
  assert.equal((await restarted.status())?.status, 'submitted');
  const second = await restarted.review({
    feedback: 'A different startup report.',
    includeReport: false,
  });
  assert.equal(second.content, null);
  await assert.rejects(restarted.send(current.reviewId + 'x'));
  const third = await restarted.review({
    feedback: 'Latest exact description.',
    includeReport: false,
  });
  await assert.rejects(restarted.send(second.reviewId), /Review the report again/);
  assert.notEqual(third.reviewId, second.reviewId);
});

test('startup status keeps its original submission while a newer send runs or finishes', async (t) => {
  const { createStartupFeedback } = await import('../src/server/startup-feedback.ts');
  for (const finishNewSend of [false, true]) {
    await t.test(finishNewSend ? 'new send finished' : 'new send in flight', async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'nod-startup-status-race-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      let releaseStatus!: (value: import('../src/shared/feedback.ts').FeedbackReceipt) => void;
      let statusStarted!: () => void;
      const checking = new Promise<void>((resolve) => {
        statusStarted = resolve;
      });
      let releaseSend!: (value: import('../src/shared/feedback.ts').FeedbackReceipt) => void;
      let sendStarted!: () => void;
      const sending = new Promise<void>((resolve) => {
        sendStarted = resolve;
      });
      let submits = 0;
      const service = createStartupFeedback({
        dataRoot: root,
        context: {
          appVersion: null,
          appRelease: null,
          appModified: null,
          platform: null,
          development: false,
          source: 'desktop',
        },
        status: { phase: 'error' },
        delivery: {
          configured: true,
          recipient: 'n8n',
          async submit(envelope) {
            if (++submits === 1)
              return { submissionId: envelope.submissionId, status: 'submitted' };
            sendStarted();
            return new Promise((resolve) => {
              releaseSend = resolve;
            });
          },
          async status() {
            statusStarted();
            return new Promise((resolve) => {
              releaseStatus = resolve;
            });
          },
        },
      });
      const first = await service.review({
        feedback: 'Synthetic first report.',
        includeReport: false,
      });
      await service.send(first.reviewId);
      const oldStatus = service.status();
      await checking;
      const next = await service.review({
        feedback: 'Synthetic next report.',
        includeReport: true,
      });
      const newSend = service.send(next.reviewId);
      await sending;
      if (finishNewSend) {
        releaseSend({ submissionId: next.reviewId, status: 'partial' });
        await newSend;
      }
      releaseStatus({ submissionId: first.reviewId, status: 'rejected' });
      assert.deepEqual(await oldStatus, { submissionId: first.reviewId, status: 'rejected' });
      if (!finishNewSend) {
        releaseSend({ submissionId: next.reviewId, status: 'partial' });
        await newSend;
      }
      assert.deepEqual((await service.context()).pending, {
        submissionId: next.reviewId,
        status: 'partial',
        canRetryAttachments: true,
      });
      assert.equal(submits, 2);
    });
  }
});

test('startup reports omit unavailable event snapshots and refuse invalid input or failed durable saves', async (t) => {
  const { createStartupFeedback } = await import('../src/server/startup-feedback.ts');
  const { mkdir, writeFile, unlink } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'nod-startup-feedback-unsafe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, 'profile');
  await mkdir(join(dataRoot, 'logs'), { recursive: true });
  const target = join(root, 'private.log');
  await writeFile(target, 'Synthetic private target\n');
  await writeFile(join(dataRoot, 'logs', 'startup.log'), 'Synthetic disk history is excluded\n');
  let sends = 0;
  const options = {
    dataRoot,
    context: {
      appVersion: 'private version',
      appRelease: 'private release',
      appModified: null,
      platform: 'private device',
      development: true,
      source: 'desktop' as const,
    },
    secrets: [],
    names: [],
    status: { phase: 'error' },
    delivery: {
      configured: true,
      recipient: 'n8n',
      async submit(envelope: import('../src/ports/feedback.ts').FeedbackEnvelope) {
        sends++;
        return { submissionId: envelope.submissionId, status: 'submitted' as const };
      },
      async status(id: string) {
        return { submissionId: id, status: 'unknown' as const };
      },
    },
  };
  const service = createStartupFeedback(options);
  const reviewed = await service.review({ feedback: 'Synthetic failure.', includeReport: true });
  const report = JSON.parse(reviewed.content!);
  assert.equal(report.startupLog.status, 'unavailable');
  assert.deepEqual(report.startupLog.entries, []);
  assert.ok(!reviewed.content!.includes('private'));
  assert.equal(report.context.appVersion, null);
  assert.equal(report.context.platform, null);
  await assert.rejects(service.review({ feedback: 'x', includeReport: true, extra: true }));
  await assert.rejects(service.review({ feedback: '', includeReport: true }));
  await assert.rejects(service.review({ feedback: ' \n\t', includeReport: true }));
  const disabled = createStartupFeedback({
    ...options,
    delivery: { ...options.delivery, configured: false },
  });
  await assert.rejects(
    disabled.review({ feedback: 'Synthetic failure.', includeReport: false }),
    /turned off/,
  );
  await rm(dataRoot, { recursive: true });
  await writeFile(dataRoot, 'Synthetic blocking file');
  await assert.rejects(service.send(reviewed.reviewId));
  assert.equal(sends, 0);
  assert.equal((await service.context()).notSentSubmissionId, reviewed.reviewId);
  await unlink(dataRoot);
  await mkdir(dataRoot);
  await assert.rejects(service.send(reviewed.reviewId), /Review the report again/);
  const recoveredReview = await service.review({
    feedback: 'Synthetic recovery review.',
    includeReport: true,
  });
  assert.notEqual(recoveredReview.reviewId, reviewed.reviewId);
  assert.equal((await service.context()).notSentSubmissionId, undefined);
  assert.equal((await service.send(recoveredReview.reviewId)).status, 'submitted');
  assert.equal(sends, 1, 'A known failure before dispatch must allow a fresh review and send.');
  await writeFile(join(dataRoot, 'startup-feedback.json'), '{"submissionId":"bad"}');
  const corrupt = createStartupFeedback(options);
  assert.equal((await corrupt.context()).recovery?.canPreserve, true);
  await assert.rejects(
    corrupt.review({ feedback: 'Synthetic blocked report.', includeReport: false }),
    /saved report status/,
  );
  assert.equal(sends, 1);
});

test('the startup feedback factory ignores unrelated engine configuration and dotenv keys', async (t) => {
  const { writeFile } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const root = await mkdtemp(join(tmpdir(), 'nod-startup-factory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, '.env'),
    'PORT=invalid-synthetic-port\nOPENAI_API_KEY=synthetic-model-key-canary\nDATABASE_POOL_MAX=invalid-synthetic-pool\n',
  );
  const source = new URL('../src/server/feedback-delivery.ts', import.meta.url).href;
  const script = join(root, 'check.mjs');
  await writeFile(
    script,
    `const { createFeedbackDelivery } = await import(${JSON.stringify(source)}); const delivery = createFeedbackDelivery({NOD_FEEDBACK_ENABLED:'false'}); process.stdout.write(JSON.stringify({modelKeyLoaded:Object.hasOwn(process.env,'OPENAI_API_KEY'),dotenvPortLoaded:Object.hasOwn(process.env,'PORT'),configured:delivery.configured}));`,
  );
  const result = await promisify(execFile)(process.execPath, [script], {
    cwd: root,
    env: Object.fromEntries(
      ['PATH', 'SystemRoot', 'SYSTEMROOT'].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]]] : [],
      ),
    ),
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    modelKeyLoaded: false,
    dotenvPortLoaded: false,
    configured: false,
  });
});

test(
  'startup report save failures restore disk state before a recovered restart',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { createStartupFeedback } = await import('../src/server/startup-feedback.ts');
    const { open } = await import('node:fs/promises');
    for (const previous of [false, true]) {
      await t.test(previous ? 'prior resolved receipt' : 'no previous report', async (t) => {
        const root = await mkdtemp(join(tmpdir(), 'nod-startup-save-restart-'));
        t.after(() => rm(root, { recursive: true, force: true }));
        let sends = 0;
        const options = {
          dataRoot: root,
          secrets: [],
          names: [],
          status: { phase: 'error' },
          context: {
            appVersion: '0.9.0',
            appRelease: 'a'.repeat(40),
            appModified: false,
            platform: 'darwin-arm64',
            development: false,
            source: 'desktop' as const,
          },
          delivery: {
            configured: true,
            recipient: 'n8n',
            async submit(envelope: import('../src/ports/feedback.ts').FeedbackEnvelope) {
              sends++;
              return { submissionId: envelope.submissionId, status: 'submitted' as const };
            },
            async status(id: string) {
              return { submissionId: id, status: 'submitted' as const };
            },
          },
        };
        const service = createStartupFeedback(options);
        let oldId: string | undefined;
        if (previous) {
          const old = await service.review({
            feedback: 'Synthetic earlier report.',
            includeReport: false,
          });
          oldId = old.reviewId;
          await service.send(oldId);
        }
        const candidate = await service.review({
          feedback: 'Synthetic new report.',
          includeReport: false,
        });
        const directory = await open(root, 'r');
        const prototype = Object.getPrototypeOf(directory);
        const sync = prototype.sync;
        await directory.close();
        try {
          prototype.sync = async function (this: Awaited<ReturnType<typeof open>>) {
            if ((await this.stat()).isDirectory())
              throw Object.assign(new Error('Synthetic directory sync failure.'), { code: 'EIO' });
            return sync.call(this);
          };
          await assert.rejects(service.send(candidate.reviewId));
        } finally {
          prototype.sync = sync;
        }
        assert.equal(sends, previous ? 1 : 0);
        const disk = await readFile(join(root, 'startup-feedback.json'), 'utf8').catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        assert.equal(disk ? JSON.parse(disk).submissionId : undefined, oldId);
        const restarted = createStartupFeedback(options);
        assert.equal((await restarted.context()).pending?.submissionId, oldId);
        const recovered = await restarted.review({
          feedback: 'Synthetic report after disk recovery.',
          includeReport: false,
        });
        assert.equal((await restarted.send(recovered.reviewId)).status, 'submitted');
        assert.equal(sends, previous ? 2 : 1);
      });
    }
  },
);

test('startup reports never open log paths and use only current desktop events', async (t) => {
  const { createStartupFeedback } = await import('../src/server/startup-feedback.ts');
  const filesystem = (await import('node:fs/promises')).default;
  const directFilesystem = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { mkdir, writeFile } = filesystem;
  const root = await mkdtemp(join(tmpdir(), 'nod-startup-no-log-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, 'profile');
  const outside = join(root, 'outside');
  await mkdir(dataRoot);
  await mkdir(outside);
  await writeFile(join(outside, 'startup.log'), 'Synthetic unrelated private file\n');
  if (process.platform === 'win32') {
    await mkdir(join(dataRoot, 'logs'));
    await writeFile(join(dataRoot, 'logs', 'startup.log'), 'Synthetic unrelated private file\n');
  } else await symlink(outside, join(dataRoot, 'logs'));
  const accessed: string[] = [];
  const restorations: Array<() => void> = [];
  function trackReads(surface: object, names: string[]) {
    for (const name of names) {
      const original = Reflect.get(surface, name);
      Reflect.set(surface, name, (...args: unknown[]) => {
        accessed.push(String(args[0]));
        return Reflect.apply(original, surface, args);
      });
      restorations.push(() => {
        Reflect.set(surface, name, original);
      });
    }
  }
  const options = {
    dataRoot,
    secrets: [],
    names: [],
    status: { phase: 'error' },
    context: {
      appVersion: '0.9.0',
      appRelease: 'a'.repeat(40),
      appModified: false,
      platform: 'darwin-arm64',
      development: false,
      source: 'desktop' as const,
    },
    startupLog: {
      entries: [{ ageMs: 5, line: 'Synthetic event from this desktop process' }],
      truncated: true,
    },
    delivery: {
      configured: true,
      recipient: 'n8n',
      async submit(envelope: import('../src/ports/feedback.ts').FeedbackEnvelope) {
        return { submissionId: envelope.submissionId, status: 'submitted' as const };
      },
      async status(id: string) {
        return { submissionId: id, status: 'unknown' as const };
      },
    },
  };
  try {
    const methods = [
      'open',
      'readFile',
      'readdir',
      'opendir',
      'readlink',
      'realpath',
      'stat',
      'lstat',
      'access',
    ];
    trackReads(filesystem, methods);
    trackReads(directFilesystem, [
      ...methods,
      ...methods.map((name) => `${name}Sync`),
      'createReadStream',
    ]);
    syncBuiltinESMExports();
    const service = createStartupFeedback(options);
    const snapshot = await service.review({ feedback: 'Synthetic failure.', includeReport: true });
    const report = JSON.parse(snapshot.content!);
    assert.equal(report.startupLog.status, 'collected');
    assert.equal(report.startupLog.scope, 'current-desktop-process');
    assert.equal(report.startupLog.truncated, true);
    assert.deepEqual(report.startupLog.entries, [
      { ageMs: 5, event: 'diagnostic_text_omitted', textOmitted: true },
    ]);
    assert.ok(!snapshot.content!.includes('Synthetic unrelated private file'));
    const malformed = createStartupFeedback({
      ...options,
      startupLog: { entries: [{ ageMs: -1, line: 'Synthetic invalid event' }], truncated: false },
    });
    const empty = JSON.parse(
      (await malformed.review({ feedback: 'Synthetic failure.', includeReport: true })).content!,
    );
    assert.equal(empty.startupLog.status, 'unavailable');
    assert.deepEqual(empty.startupLog.entries, []);
    assert.ok(
      !accessed.some((path) =>
        [join(dataRoot, 'logs'), outside].some(
          (root) => path === root || path.startsWith(root + '/') || path.startsWith(root + '\\'),
        ),
      ),
      'Preparing a startup report must not access a log path or its outside target.',
    );
  } finally {
    for (const restore of restorations.reverse()) restore();
    syncBuiltinESMExports();
  }
});

test('environment secret collection covers every model key and token segment before redaction', async () => {
  const { modelProviderInfo } = await import('../src/shared/models.ts');
  const modelEnvironment = Object.fromEntries(
    Object.values(modelProviderInfo).map(({ env }, index) => [env, `synthetic-model-key-${index}`]),
  );
  const legacyEnvironment = Object.fromEntries(
    [
      'API_KEY',
      'SECRET',
      'PASSWORD',
      'VAULT_KEY',
      'BOT_TOKEN',
      'ACCESS_TOKEN',
      'AUTH_TOKEN',
      'FEEDBACK_TOKEN',
      'TRACES_TOKEN',
      'UPDATES_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'PRIVATE_KEY',
      'ENCRYPTION_KEY',
      'PASSPHRASE',
      'ACCESS_KEY_ID',
    ].map((key, index) => [`SYNTHETIC_${key}`, `synthetic-legacy-key-${index}`]),
  );
  const environment = {
    ...modelEnvironment,
    ...legacyEnvironment,
    NOD_FEEDBACK_TOKEN: 'synthetic-feedback-key',
    NOD_TRACES_TOKEN: 'synthetic-traces-key',
    SYNTHETIC_TOKEN_SUFFIX: 'synthetic-token-with-suffix',
    SYNTHETIC_SECRET: 'synthetic-secret-value',
    SYNTHETIC_PASSWORD: 'synthetic-password-value',
    NOD_VAULT_KEY: 'synthetic-vault-key',
    DATABASE_URL: 'postgresql://synthetic:synthetic%2Bdatabase%2Fpassword@127.0.0.1/nod_synthetic',
    PORT: '1234',
  };
  const secrets = environmentSecrets(environment);
  for (const [key, value] of Object.entries(environment))
    assert.equal(secrets.includes(value), key !== 'PORT', key);
  assert.ok(secrets.includes('synthetic+database/password'));
  const malformed = 'synthetic%2Gprivate-password';
  assert.ok(
    environmentSecrets({
      DATABASE_URL: `postgresql://synthetic:${malformed}@127.0.0.1/nod_synthetic`,
    }).includes(malformed),
  );
  assert.deepEqual(
    environmentSecrets({
      EMPTY_TOKEN: '',
      MISSING_TOKEN: undefined,
      DATABASE_URL: 'synthetic-invalid-url',
    }),
    ['synthetic-invalid-url'],
  );
});

test('startup status recovery preserves corrupt bytes before a fresh reviewed submission', async (t) => {
  const { createStartupFeedback } = await import('../src/server/startup-feedback.ts');
  const { writeFile, readFile, readdir, stat } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  const root = await mkdtemp(join(tmpdir(), 'nod-status-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'startup-feedback.json');
  const untrustedId = randomUUID();
  const bytes = Buffer.from(
    `{"submissionId":"${untrustedId}","private":"synthetic-private-state"\n`,
  );
  await writeFile(path, bytes);
  const sent: import('../src/ports/feedback.ts').FeedbackEnvelope[] = [];
  let lookups = 0;
  const options = {
    dataRoot: root,
    secrets: [],
    names: [],
    status: { phase: 'error' },
    context: {
      appVersion: '0.9.0',
      appRelease: 'a'.repeat(40),
      appModified: false,
      development: false,
      source: 'desktop' as const,
      platform: 'darwin-arm64',
    },
    delivery: {
      configured: true,
      recipient: 'n8n',
      async submit(value: import('../src/ports/feedback.ts').FeedbackEnvelope) {
        sent.push(value);
        return { submissionId: value.submissionId, status: 'submitted' as const };
      },
      async status(id: string) {
        lookups++;
        return { submissionId: id, status: 'unknown' as const };
      },
    },
  };
  const service = createStartupFeedback(options);
  const blocked = await service.context();
  assert.equal(blocked.recovery?.canPreserve, true);
  assert.match(blocked.recovery!.message, /invalid JSON/);
  assert.ok(!JSON.stringify(blocked).includes('synthetic-private-state'));
  await assert.rejects(
    service.review({ feedback: 'Synthetic failure.', includeReport: true }),
    /invalid JSON/,
  );
  await assert.rejects(service.send(untrustedId), /invalid JSON/);
  assert.equal(lookups, 0);
  assert.throws(() => service.recover({ confirm: false }));
  assert.deepEqual(await readFile(path), bytes);
  await service.recover({ confirm: true });
  const names = await readdir(root);
  const backups = names.filter((name) => /^startup-feedback-recovered-.*\.bin$/.test(name));
  assert.equal(backups.length, 1);
  assert.deepEqual(await readFile(join(root, backups[0])), bytes);
  if (process.platform !== 'win32')
    assert.equal((await stat(join(root, backups[0]))).mode & 0o777, 0o600);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  assert.equal((await service.context()).pending, null);
  assert.equal(sent.length, 0);
  const fresh = await service.review({ feedback: 'Synthetic fresh report.', includeReport: true });
  assert.notEqual(fresh.reviewId, untrustedId);
  assert.ok(!fresh.content!.includes('synthetic-private-state'));
  assert.equal(sent.length, 0);
  await service.send(fresh.reviewId);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].submissionId, fresh.reviewId);
  await assert.rejects(service.recover({ confirm: true }), /Check the saved report status/);
  const restored = createStartupFeedback(options);
  assert.equal((await restored.context()).pending?.submissionId, fresh.reviewId);
  assert.equal(sent.length, 1);
});

test('startup recovery refuses a failed durable backup and retries a recovered status read', async (t) => {
  const { createStartupFeedback } = await import('../src/server/startup-feedback.ts');
  const filesystem = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { randomUUID } = await import('node:crypto');
  const root = await mkdtemp(join(tmpdir(), 'nod-status-preserve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'startup-feedback.json');
  const bytes = Buffer.from('Synthetic corrupt state\u0000private');
  await filesystem.writeFile(path, bytes);
  let submits = 0;
  let lookups = 0;
  const options = {
    dataRoot: root,
    secrets: [],
    names: [],
    status: { phase: 'error' },
    context: {
      appVersion: '0.9.0',
      appRelease: 'a'.repeat(40),
      appModified: false,
      development: false,
      source: 'desktop' as const,
      platform: 'darwin-arm64',
    },
    delivery: {
      configured: true,
      recipient: 'n8n',
      async submit(value: import('../src/ports/feedback.ts').FeedbackEnvelope) {
        submits++;
        return { submissionId: value.submissionId, status: 'submitted' as const };
      },
      async status(id: string) {
        lookups++;
        return { submissionId: id, status: 'unknown' as const };
      },
    },
  };
  const service = createStartupFeedback(options);
  assert.equal((await service.context()).recovery?.canPreserve, true);
  const probe = await filesystem.open(path, 'r');
  const prototype = Object.getPrototypeOf(probe);
  const originalSync = prototype.sync;
  await probe.close();
  try {
    prototype.sync = async function (this: import('node:fs/promises').FileHandle) {
      const info = await this.stat();
      if (info.isFile())
        throw Object.assign(new Error('EIO: Synthetic backup sync failure.'), { code: 'EIO' });
      return originalSync.call(this);
    };
    await assert.rejects(service.recover({ confirm: true }), /EIO/);
    assert.deepEqual(await filesystem.readFile(path), bytes);
    assert.equal((await service.context()).recovery?.canPreserve, true);
    await assert.rejects(
      service.review({ feedback: 'Synthetic blocked report.', includeReport: false }),
    );
    assert.equal(submits, 0);
  } finally {
    prototype.sync = originalSync;
  }
  if (process.platform !== 'win32') {
    try {
      prototype.sync = async function (this: import('node:fs/promises').FileHandle) {
        if ((await this.stat()).isDirectory())
          throw Object.assign(new Error('EIO: Synthetic backup directory sync failure.'), {
            code: 'EIO',
          });
        return originalSync.call(this);
      };
      await assert.rejects(service.recover({ confirm: true }), /EIO/);
      assert.deepEqual(await filesystem.readFile(path), bytes);
      assert.equal((await service.context()).recovery?.canPreserve, true);
    } finally {
      prototype.sync = originalSync;
    }
  }
  await service.recover({ confirm: true });
  assert.equal((await service.context()).pending, null);
  const id = randomUUID();
  await filesystem.writeFile(
    path,
    JSON.stringify({ submissionId: id, payloadHash: 'b'.repeat(64) }),
  );
  const originalOpen = filesystem.open;
  let fail = true;
  const retrying = createStartupFeedback(options);
  try {
    filesystem.open = (async (...args: Parameters<typeof originalOpen>) => {
      if (fail && String(args[0]) === path)
        throw Object.assign(new Error('EACCES: Synthetic transient read failure.'), {
          code: 'EACCES',
        });
      return originalOpen(...args);
    }) as typeof originalOpen;
    syncBuiltinESMExports();
    const unavailable = await retrying.context();
    assert.equal(unavailable.recovery?.canPreserve, false);
    assert.match(unavailable.recovery!.message, /EACCES/);
    fail = false;
    assert.equal((await retrying.context()).pending?.submissionId, id);
    await assert.rejects(retrying.recover({ confirm: true }), /Check the saved report status/);
    await assert.rejects(
      retrying.review({ feedback: 'Synthetic duplicate refusal.', includeReport: false }),
      /previous report status/,
    );
    assert.equal(lookups, 1);
    assert.equal(submits, 0);
  } finally {
    filesystem.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test(
  'startup keeps the saved submission fence when durable save and rollback both fail',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { createStartupFeedback } = await import('../src/server/startup-feedback.ts');
    const filesystem = (await import('node:fs/promises')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const root = await mkdtemp(join(tmpdir(), 'nod-report-rollback-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'startup-feedback.json');
    let submits = 0;
    const options = {
      dataRoot: root,
      secrets: [],
      names: [],
      status: { phase: 'error' },
      context: {
        appVersion: '0.9.0',
        appRelease: 'a'.repeat(40),
        appModified: false,
        development: false,
        source: 'desktop' as const,
        platform: 'darwin-arm64',
      },
      delivery: {
        configured: true,
        recipient: 'n8n',
        async submit(value: import('../src/ports/feedback.ts').FeedbackEnvelope) {
          submits++;
          return { submissionId: value.submissionId, status: 'submitted' as const };
        },
        async status(id: string) {
          return { submissionId: id, status: 'unknown' as const };
        },
      },
    };
    const service = createStartupFeedback(options);
    const review = await service.review({
      feedback: 'Synthetic durable report.',
      includeReport: false,
    });
    const directory = await filesystem.open(root, 'r');
    const prototype = Object.getPrototypeOf(directory);
    const originalSync = prototype.sync;
    const originalRm = filesystem.rm;
    await directory.close();
    try {
      prototype.sync = async function (this: import('node:fs/promises').FileHandle) {
        if ((await this.stat()).isDirectory())
          throw Object.assign(new Error('EIO: Synthetic directory save failure.'), { code: 'EIO' });
        return originalSync.call(this);
      };
      filesystem.rm = (async (...args: Parameters<typeof originalRm>) => {
        if (String(args[0]) === path)
          throw Object.assign(new Error('EPERM: Synthetic rollback refusal.'), { code: 'EPERM' });
        return originalRm(...args);
      }) as typeof originalRm;
      syncBuiltinESMExports();
      await assert.rejects(
        service.send(review.reviewId),
        /previous saved report status could not be restored/,
      );
      assert.equal(
        JSON.parse(await filesystem.readFile(path, 'utf8')).submissionId,
        review.reviewId,
      );
      assert.equal((await service.context()).pending?.submissionId, review.reviewId);
      assert.equal((await service.send(review.reviewId)).status, 'unknown');
      await assert.rejects(
        service.review({ feedback: 'Synthetic replacement.', includeReport: false }),
        /previous report status/,
      );
      assert.equal(submits, 0);
      assert.equal(
        (await createStartupFeedback(options).context()).pending?.submissionId,
        review.reviewId,
      );
    } finally {
      prototype.sync = originalSync;
      filesystem.rm = originalRm;
      syncBuiltinESMExports();
    }
  },
);

test('startup exports and receipts hide original overlapping private spans before text changes', async (t) => {
  const { createStartupFeedback } = await import('../src/server/startup-feedback.ts');
  const root = await mkdtemp(join(tmpdir(), 'nod-report-overlap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    {
      name: 'contained',
      secrets: ['k7X', 'k7Xsynthetic-private-contained'],
      input: 'k7Xsynthetic-private-contained',
    },
    {
      name: 'crossing',
      secrets: ['prefixABC', 'ABCsynthetic-private-cross-tail'],
      input: 'prefixABCsynthetic-private-cross-tail',
    },
    {
      name: 'chain',
      secrets: ['prefixABC', 'ABCsynthetic-private-middle', 'middleXYZtail'],
      input: 'prefixABCsynthetic-private-middleXYZtail',
    },
    {
      name: 'adjacent',
      secrets: ['synthetic-private-first', 'synthetic-private-second'],
      input: 'synthetic-private-firstsynthetic-private-second',
    },
    {
      name: 'literal',
      secrets: [String.raw`synthetic+(private)[value]\key`],
      input: String.raw`synthetic+(private)[value]\key`,
    },
    {
      name: 'repeated masks',
      secrets: ['red', 'synthetic-private-repeat'],
      input: '[redacted] synthetic-private-repeat [redacted]',
    },
    {
      name: 'POSIX root',
      secrets: ['/Applications/Synthetic Owner/engine', 'engine/synthetic-private-path-tail'],
      input: '/Applications/Synthetic Owner/engine/synthetic-private-path-tail',
    },
    {
      name: 'Windows root',
      secrets: [
        String.raw`C:\Synthetic Owner\engine`,
        String.raw`engine\synthetic-private-path-tail`,
      ],
      input: String.raw`C:\Synthetic Owner\engine\synthetic-private-path-tail`,
    },
    {
      name: 'short credential in root',
      secrets: ['/', '/Applications/Synthetic Owner/engine'],
      input: '/Applications/Synthetic Owner/engine/startup',
    },
  ];
  for (const [index, item] of cases.entries())
    await t.test(item.name, async () => {
      let exported = '';
      const service = createStartupFeedback({
        dataRoot: join(root, String(index)),
        status: {
          phase: 'error',
          error: `Synthetic failure EIO ${item.input}`,
          failure: Object.assign(new Error(item.input), { code: 'EIO' }),
        },
        context: {
          appVersion: '0.9.0',
          appRelease: 'a'.repeat(40),
          appModified: false,
          development: false,
          source: 'desktop',
          platform: 'darwin-arm64',
        },
        delivery: {
          configured: true,
          recipient: 'n8n',
          async submit(envelope) {
            exported = Buffer.from(envelope.report!.data, 'base64').toString('utf8');
            return {
              submissionId: envelope.submissionId,
              status: 'submitted',
              message: `Synthetic collector reason EIO ${item.input}`,
            };
          },
          status: () => assert.fail('No status request is needed.'),
        },
      });
      const review = await service.review({
        feedback: 'Synthetic overlap report.',
        includeReport: true,
      });
      const result = await service.send(review.reviewId);
      assert.equal(exported, review.content);
      assert.equal(result.message, undefined);
      assert.equal(result.messageOmitted, true);
      for (const value of [exported, JSON.stringify(result)]) {
        assert.ok(!value.includes('synthetic-private'));
        assert.ok(!value.includes('Synthetic Owner'));
        assert.ok(!value.includes(String.raw`synthetic+(private)[value]\key`));
        assert.ok(!value.includes('[['));
      }
    });
});

test('startup attachment repair keeps the original ID and bytes and never repeats the description', async (t) => {
  const { createStartupFeedback } = await import('../src/server/startup-feedback.ts');
  const root = await mkdtemp(join(tmpdir(), 'nod-report-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: import('../src/ports/feedback.ts').FeedbackEnvelope[] = [];
  let release!: (value: import('../src/shared/feedback.ts').FeedbackReceipt) => void;
  let dispatch!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    dispatch = resolve;
  });
  let hold = true;
  let remote: 'partial' | 'submitted' = 'partial';
  const options = {
    dataRoot: root,
    secrets: ['synthetic-private-key'],
    names: [],
    status: { phase: 'error', error: 'Synthetic failure synthetic-private-key' },
    context: {
      appVersion: '0.9.0',
      appRelease: 'a'.repeat(40),
      appModified: false,
      development: false,
      source: 'desktop' as const,
      platform: 'darwin-arm64',
    },
    delivery: {
      configured: true,
      recipient: 'n8n',
      async submit(
        value: import('../src/ports/feedback.ts').FeedbackEnvelope,
      ): Promise<import('../src/shared/feedback.ts').FeedbackReceipt> {
        calls.push(value);
        if (value.action === 'repair' && hold) {
          dispatch();
          return new Promise((resolve) => {
            release = resolve;
          });
        }
        return {
          submissionId: value.submissionId,
          status: value.action === 'repair' ? 'submitted' : 'partial',
          message: 'Synthetic delivery detail synthetic-private-key',
        };
      },
      async status(id: string) {
        return { submissionId: id, status: remote };
      },
    },
  };
  const service = createStartupFeedback(options);
  const review = await service.review({
    feedback: 'Synthetic original description.',
    includeReport: true,
  });
  const partialReceipt = await service.send(review.reviewId);
  assert.equal(partialReceipt.canRetryAttachments, true);
  assert.equal(partialReceipt.message, undefined);
  assert.equal(partialReceipt.messageOmitted, true);
  const repairing = service.repair(review.reviewId);
  await dispatched;
  const duplicate = service.repair(review.reviewId);
  assert.equal(calls.length, 2);
  const { action, ...same } = calls[1];
  assert.equal(action, 'repair');
  assert.deepEqual(same, calls[0]);
  release({ submissionId: review.reviewId, status: 'unknown' });
  assert.equal((await repairing).status, 'unknown');
  assert.equal((await duplicate).status, 'unknown');
  await assert.rejects(service.repair(review.reviewId), /Check the report status/);
  await assert.rejects(
    service.review({ feedback: 'Synthetic new description.', includeReport: true }),
    /previous report status/,
  );
  assert.equal((await service.status())?.status, 'partial');
  hold = false;
  assert.equal((await service.repair(review.reviewId)).status, 'submitted');
  assert.equal(calls.filter((value) => !value.action).length, 1);
  const second = await service.review({
    feedback: 'Synthetic second report.',
    includeReport: true,
  });
  await service.send(second.reviewId);
  const restarted = createStartupFeedback(options);
  assert.equal((await restarted.context()).pending?.canRetryAttachments, false);
  await assert.rejects(restarted.repair(second.reviewId), /original report bytes/);
  assert.equal(calls.filter((value) => !value.action).length, 2);
  const fresh = await restarted.review({ feedback: 'Synthetic fresh bytes.', includeReport: true });
  assert.notEqual(fresh.reviewId, second.reviewId);
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 3_600_001;
    assert.equal((await service.status())?.canRetryAttachments, false);
    await assert.rejects(service.repair(second.reviewId), /original report bytes/);
  } finally {
    Date.now = originalNow;
  }
  assert.equal(calls.filter((value) => !value.action).length, 2);
});

test('startup not-sent evidence binds an expired review and survives a clock change', async (t) => {
  const { createStartupFeedback } = await import('../src/server/startup-feedback.ts');
  const { writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'nod-report-expiry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const olderId = randomUUID();
  await writeFile(
    join(root, 'startup-feedback.json'),
    JSON.stringify({ submissionId: olderId, payloadHash: 'a'.repeat(64) }),
  );
  let now = Date.now();
  const originalNow = now;
  t.mock.method(Date, 'now', () => now);
  let submits = 0;
  const service = createStartupFeedback({
    dataRoot: root,
    status: { phase: 'error' },
    context: {
      appVersion: '0.9.0',
      appRelease: 'a'.repeat(40),
      appModified: false,
      development: false,
      source: 'desktop',
      platform: 'darwin-arm64',
    },
    delivery: {
      configured: true,
      recipient: 'n8n',
      submit: async (value) => {
        submits++;
        return { submissionId: value.submissionId, status: 'submitted' };
      },
      status: async (id) => ({ submissionId: id, status: 'submitted' }),
    },
  });
  assert.equal((await service.context()).pending?.submissionId, olderId);
  const expired = await service.review({
    feedback: 'Synthetic expired review.',
    includeReport: false,
  });
  now += 3600001;
  await assert.rejects(service.send(expired.reviewId), /Review the report again/);
  const evidence = await service.context();
  assert.equal(evidence.notSentSubmissionId, expired.reviewId);
  assert.equal(evidence.pending?.submissionId, olderId);
  now = originalNow;
  await assert.rejects(service.send(expired.reviewId), /Review the report again/);
  assert.equal(submits, 0);
  const fresh = await service.review({ feedback: 'Synthetic fresh review.', includeReport: false });
  assert.notEqual(fresh.reviewId, expired.reviewId);
  assert.equal((await service.context()).notSentSubmissionId, undefined);
  await service.send(fresh.reviewId);
  assert.equal(submits, 1);
  assert.equal((await service.context()).notSentSubmissionId, undefined);
});

test('startup facts omit every prose shape without pattern matching or code inference', () => {
  const values = [
    '/Applications/Synthetic Owner/profile/workspaces/synthetic-private-contract.docx',
    String.raw`C:\Synthetic Owner\profile\synthetic-private-contract.docx`,
    '<profile>[redacted]workspaces[redacted]synthetic-private-contract.docx',
    'https:[redacted][redacted]private.example.test[redacted]synthetic-private-url',
    'synthetic-private-local[redacted]example.test',
    'synthetic-private-local@example.test',
    '@synthetic-private-handle',
    '+34 600 123 456',
    '%2FUsers%2Fsynthetic-private-owner%2Fcontract',
    '{"name":"synthetic-private-owner","message":"HTTP 503 EIO"}',
    'prefixABCsynthetic-private-cross-tail',
    'prefixABCsynthetic-private-middleXYZtail',
  ];
  for (const value of values) {
    const status = startupStatusFacts({
      phase: 'error',
      stage: value,
      error: value,
      details: value,
      failure: { name: value, code: value, syscall: value, status: '503' },
    });
    const event = startupEventFacts(value, {
      error: value,
      durationMs: value,
      path: value,
      line: value,
    });
    const log = startupLogFacts({
      entries: [{ ageMs: 5, line: value, event: value }],
      truncated: false,
    });
    const encoded = JSON.stringify({ status, event, log });
    assert.ok(!encoded.includes(value));
    assert.equal(status.stage, 'unknown');
    assert.equal(status.failure?.httpStatus, undefined);
    assert.equal(status.failure?.errno, undefined);
    assert.equal(event.event, 'diagnostic_text_omitted');
    assert.equal(log.entries[0].textOmitted, true);
  }
});

test('startup facts keep only structured bounded codes and do not call getters or serializers', () => {
  let calls = 0;
  const error = Object.assign(new TypeError('synthetic-private-error'), {
    code: 'EACCES',
    errno: -13,
    statusCode: 0,
    syscall: 'open',
    status: 503,
    signal: 'SIGTERM',
    exitCode: 4294967295,
    toJSON() {
      calls++;
      throw new Error('No serialization.');
    },
  });
  Object.defineProperty(error, 'stack', {
    get() {
      calls++;
      throw new Error('No stack read.');
    },
  });
  const facts = startupErrorFacts(error);
  assert.equal(
    startupStatusFacts({ phase: 'preparing', runtime: { phase: 'downloading' } }).runtimePhase,
    'downloading',
  );
  assert.deepEqual(facts, {
    detailsOmitted: true,
    class: 'TypeError',
    errno: 'EACCES',
    syscall: 'open',
    httpStatus: 503,
    exitCode: 4294967295,
    signal: 'SIGTERM',
  });
  const poisoned = Object.defineProperties(
    {},
    Object.fromEntries(
      [
        'name',
        'code',
        'syscall',
        'status',
        'phase',
        'stage',
        'runtime',
        'error',
        'failure',
        'message',
      ].map((key) => [
        key,
        {
          get() {
            calls++;
            throw new Error('No getter read.');
          },
        },
      ]),
    ),
  );
  JSON.stringify(startupStatusFacts(poisoned));
  JSON.stringify(startupErrorFacts(poisoned));
  JSON.stringify(startupEventFacts('runtime_failed', poisoned));
  assert.deepEqual(startupReceiptFacts(poisoned, 'synthetic-owned-id'), {
    submissionId: 'synthetic-owned-id',
    status: 'unknown',
  });
  const receipt = startupReceiptFacts(
    { status: 'rejected', message: 'synthetic-private-receipt', httpStatus: 400 },
    'synthetic-owned-id',
  );
  assert.deepEqual(receipt, {
    submissionId: 'synthetic-owned-id',
    status: 'rejected',
    httpStatus: 400,
    messageOmitted: true,
  });
  assert.ok(!startupFailureMessage(error).includes('synthetic-private'));
  assert.match(startupFailureMessage(error), /EACCES.*open.*HTTP 503/);
  assert.match(
    startupFailureMessage(new StartupFeedbackError('review_required')),
    /Review the report again/,
  );
  assert.equal(
    startupReceiptFacts(
      { ...receipt, issueUrl: 'https://private.example.test/synthetic-private' },
      'synthetic-owned-id',
    ).issueUrl,
    undefined,
  );
  assert.equal(calls, 0);
  for (const value of [-1, 1.5, Infinity, NaN, 86400001])
    assert.equal(startupEventFacts('update', { durationMs: value }).durationMs, undefined);
  assert.equal(
    startupErrorFacts({ code: 'synthetic-private-code', status: 600 }).httpStatus,
    undefined,
  );
});
