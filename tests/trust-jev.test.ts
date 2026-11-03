import assert from 'node:assert/strict';
import test from 'node:test';
import { createDecisionModel } from '../src/providers/decisions.ts';
import { createTrustReview } from '../src/server/trust-review.ts';
import { trustBasis } from '../src/server/trust-basis.ts';

test('Jev keeps action data out of the owner proof and blocks failures without an LLM', async (t) => {
  for (const provider of ['openrouter', 'typesafe'] as const)
    await t.test(provider, async () => {
      const requested = provider === 'openrouter' ? 'typesafe/jev-1.14' : 'jev-1.14.0';
      const served = provider === 'openrouter' ? 'typesafe/jev-1.14-20261014' : requested;
      const words = {
        userMessages: [
          { at: '2026-11-03T09:00:00Z', text: 'Send the test report to qa@example.test.' },
        ],
      };
      const body = 'Synthetic test report. '.repeat(4000) + 'Final test condition.';
      const input = {
        ...words,
        action: { name: 'send_email', arguments: { to: 'qa@example.test', body } },
      };
      let requests = 0;
      let llmCalls = 0;
      let recipientConflict = false;
      let wrongMethod = 0;
      let failure:
        'http' | 'version' | 'probability' | 'refusal' | 'connection' | 'stop' | undefined;
      let controller = new AbortController();
      const decisions = createDecisionModel({
        resolve: async () => ({
          provider,
          key: 'synthetic-jev-key',
          model: failure === 'connection' && requests === 1 ? 'jev-unknown' : requested,
        }),
        fetch: async (_url, init) => {
          requests++;
          const request = JSON.parse(String(init?.body));
          const primary = 'trust' in request.questions;
          if (failure === 'http') return new Response('', { status: 503 });
          if (primary) {
            assert.deepEqual(request.state.action, input.action);
            assert.deepEqual(request.state.userMessages, words.userMessages);
          } else {
            assert.equal('action' in request.state, false);
            assert.equal('userMessages' in request.state, false);
            assert.deepEqual(request.state.ownerSourceForThisCheck, {
              kind: 'message:0',
              text: words.userMessages[0].text,
            });
            assert.equal(JSON.stringify(request.state).includes(body), false);
          }
          const answers = Object.fromEntries(
            Object.entries(request.questions).map(([name, question]) => {
              const item = question as { type: string; criteria?: Record<string, string> };
              if (item.type === 'noul') {
                const positive = ['direct_request', 'needed_step', 'permission'].includes(name);
                const noul =
                  name === 'recipient_conflict' && recipientConflict
                    ? 0.99
                    : positive
                      ? 0.99
                      : 0.01;
                return [name, { type: 'noul', noul: failure === 'probability' ? 1.1 : noul }];
              }
              const choice =
                name === 'trust'
                  ? 'message:0'
                  : name === 'owner_method'
                    ? wrongMethod > 0.5
                      ? 'browser'
                      : 'any'
                    : 'send';
              return [
                name,
                failure === 'refusal'
                  ? { type: 'refusal' }
                  : {
                      type: 'choice',
                      choice,
                      probabilities:
                        name === 'owner_method'
                          ? { any: 1 - wrongMethod, app: 0, browser: wrongMethod, unclear: 0 }
                          : Object.fromEntries(
                              Object.keys(item.criteria!).map((value) => [
                                value,
                                Number(value === choice),
                              ]),
                            ),
                    },
              ];
            }),
          );
          if (failure === 'stop' && primary) controller.abort();
          return Response.json({
            model: failure === 'version' ? 'jev-unknown' : served,
            answers,
            usage: { input_tokens: 100, cost: 0.0000042 },
          });
        },
      });
      const review = createTrustReview({
        decisions,
        escalate: true,
        review: async () => {
          llmCalls++;
          assert.fail('A failure must not start the LLM stage.');
        },
      });
      const check = () => review('Apply the owner policy.', input, controller.signal);
      assert.equal(trustBasis(await check(), words, ['owner-message'])?.kind, 'message');
      assert.equal(requests, 2);
      recipientConflict = true;
      requests = 0;
      assert.equal(trustBasis(await check(), words, ['owner-message']), undefined);
      recipientConflict = false;
      wrongMethod = 1;
      assert.equal(trustBasis(await check(), words, ['owner-message']), undefined);
      wrongMethod = 0.4;
      const pure = createTrustReview({
        decisions,
        review: async () => assert.fail('Pure mode must not use an LLM.'),
      });
      assert.equal(
        trustBasis(await pure('Apply the owner policy.', input), words, ['owner-message']),
        undefined,
      );
      let smallCalls = 0;
      const hybrid = createTrustReview({
        decisions,
        escalate: true,
        review: async () => {
          smallCalls++;
          return { run: true, because: words.userMessages[0].text };
        },
      });
      assert.equal(
        trustBasis(await hybrid('Apply the owner policy.', input), words, ['owner-message'])?.kind,
        'message',
      );
      assert.equal(smallCalls, 1);
      wrongMethod = 0;
      for (failure of ['http', 'version', 'probability', 'connection', 'stop'] as const) {
        requests = 0;
        controller = new AbortController();
        await assert.rejects(check());
        assert.equal(requests, 1);
      }
      failure = 'refusal';
      requests = 0;
      controller = new AbortController();
      assert.equal(await check(), undefined);
      assert.equal(requests, 1);
      assert.equal(llmCalls, 0);
    });
});

test('Jev checks elapsed time, local clocks and weekdays before it permits an action', async () => {
  const { checkJevTimes, selectedJevDate } = await import('../src/server/trust-jev-time.ts');
  const { trustFacts } = await import('../src/server/trust-facts.ts');
  const facts = trustFacts({
    userMessages: [{ at: '2031-09-08T12:00:00Z', text: 'Use London time.' }],
    action: {
      name: 'GOOGLECALENDAR_CREATE_EVENT',
      arguments: { start: '2031-09-09T09:30:00Z', end: '2031-09-09T11:00:00Z' },
    },
  });
  const dates = facts.serverDateFacts
    .arguments as import('../src/server/trust-jev-time.ts').JevDate[];
  const answer = (choice: string, probability = 1) => ({ choice, probability });
  const first = { date_field: answer('date:0'), end_field: answer('date:1') };
  const owner = {
    owner_duration: answer('90'),
    owner_zone: answer('Europe/London'),
    owner_clock: answer('10:30'),
    owner_weekday: answer('Tuesday'),
  };
  assert.deepEqual(checkJevTimes(first, owner, dates), {
    mismatch: false,
    uncertain: false,
    clockVerified: true,
    durationVerified: true,
    dateVerified: false,
  });
  const exactDate = {
    ...owner,
    owner_year: answer('2031'),
    owner_month: answer('9'),
    owner_day: answer('9'),
  };
  assert.equal(checkJevTimes(first, exactDate, dates).dateVerified, true);
  assert.equal(
    checkJevTimes(first, { ...exactDate, owner_day: answer('10') }, dates).mismatch,
    true,
  );
  for (const [name, value] of [
    ['owner_duration', '60'],
    ['owner_clock', '11:30'],
    ['owner_weekday', 'Wednesday'],
  ])
    assert.equal(checkJevTimes(first, { ...owner, [name]: answer(value) }, dates).mismatch, true);
  const uncertain = checkJevTimes({ ...first, end_field: answer('none') }, owner, dates);
  assert.equal(uncertain.uncertain, true);
  assert.equal(uncertain.clockVerified, false);
  assert.equal(uncertain.durationVerified, false);
  assert.equal(selectedJevDate(answer('none'), dates), undefined);
  assert.equal(selectedJevDate(answer('date:-1'), dates), undefined);
  assert.equal(selectedJevDate(answer('date:999'), dates), undefined);
  assert.equal(
    checkJevTimes(first, { ...owner, owner_duration: answer('90', 0.6) }, dates).uncertain,
    true,
  );
});

test('a nested effect can refuse the private-read path even when the first Jev check calls it a read', async () => {
  const input = {
    userMessages: [{ at: '2032-02-17T17:20:00Z', text: 'Read the synthetic batch status.' }],
    action: {
      name: 'SAMPLES_STATUS',
      arguments: {
        id: 'synthetic-batch',
        options: { after: [{ tool: 'SAMPLES_RELEASE', args: { id: 'synthetic-batch' } }] },
      },
    },
  };
  let failure: 'http' | 'refusal' | undefined;
  let privateChecks = 0;
  const decisions = createDecisionModel({
    resolve: async () => ({
      provider: 'openrouter',
      key: 'synthetic-jev-key',
      model: 'typesafe/jev-1.14',
    }),
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.questions.private) {
        privateChecks++;
        assert.deepEqual(request.state.action, input.action);
        assert.equal(request.state.nestedOperations[0].value.tool, 'SAMPLES_RELEASE');
        assert.ok(request.questions.private_0);
        assert.equal('userMessages' in request.state, false);
        if (failure === 'http') return new Response('', { status: 503 });
      }
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([name, value]) => {
          const question = value as { type: string; criteria: Record<string, string> };
          if (name === 'private_0' && failure === 'refusal') return [name, { type: 'refusal' }];
          if (question.type === 'noul')
            return [
              name,
              {
                type: 'noul',
                noul: ['read_effect', 'private_preparation', 'private'].includes(name)
                  ? 0.99
                  : 0.01,
              },
            ];
          const choice = name === 'owner_method' ? 'any' : 'read';
          return [
            name,
            {
              type: 'choice',
              choice,
              probabilities: Object.fromEntries(
                Object.keys(question.criteria).map((key) => [key, Number(key === choice)]),
              ),
            },
          ];
        }),
      );
      return Response.json({
        model: 'typesafe/jev-1.14-20261014',
        answers,
        usage: { input_tokens: 100, cost: 0.0000042 },
      });
    },
  });
  const review = createTrustReview({
    decisions,
    escalate: true,
    review: async () => assert.fail('An effect denial or failure must not start an LLM.'),
  });
  assert.equal(
    trustBasis(await review('Apply the owner policy.', input), input, ['owner-message']),
    undefined,
  );
  assert.equal(privateChecks, 1);
  failure = 'refusal';
  assert.equal(await review('Apply the owner policy.', input), undefined);
  failure = 'http';
  await assert.rejects(review('Apply the owner policy.', input));
});

test('scheduled message dates preserve the owner local day without parsing page text', async () => {
  const { jevMessageDate } = await import('../src/server/trust-jev-time.ts');
  const answer = (choice: string, probability = 1) => ({ choice, probability });
  const parts = { text_year: answer('2032'), text_month: answer('2'), text_day: answer('19') };
  assert.deepEqual(jevMessageDate(parts, '2032-02-19'), {
    mismatch: false,
    uncertain: false,
    verified: true,
  });
  assert.equal(jevMessageDate({ ...parts, text_day: answer('18') }, '2032-02-19').mismatch, true);
  assert.equal(
    jevMessageDate({ ...parts, text_month: answer('2', 0.6) }, '2032-02-19').uncertain,
    true,
  );
  assert.throws(() => jevMessageDate({}, '2032-02-19'));
});

test('strict Jev reads need a separate effect check and never treat a private draft as a read', async () => {
  let calls = 0;
  let failure: 'http' | 'refusal' | undefined;
  const decisions = createDecisionModel({
    resolve: async () => ({
      provider: 'openrouter',
      key: 'synthetic-jev-key',
      model: 'typesafe/jev-1.14',
    }),
    fetch: async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init?.body));
      const primary = 'readOnly' in request.questions;
      if (!primary) {
        assert.match(request.questions.private.instructions, /including a private draft/);
        if (failure === 'http') return new Response('', { status: 503 });
      }
      return Response.json({
        model: 'typesafe/jev-1.14-20261014',
        usage: { input_tokens: 100, cost: 0.0000042 },
        answers: primary
          ? {
              readOnly: {
                type: 'choice',
                choice: 'true',
                probabilities: { true: 0.9, false: 0.1 },
              },
            }
          : { private: failure === 'refusal' ? { type: 'refusal' } : { type: 'noul', noul: 0.01 } },
      });
    },
  });
  const review = createTrustReview({
    decisions,
    escalate: true,
    review: async () => assert.fail('A refusal or failure must not start an LLM.'),
  });
  const question = {
    name: 'readOnly',
    minProbability: 0.99,
    uncertainValue: false,
    choices: [
      { value: false, description: 'Write or unknown.' },
      { value: true, description: 'Read only.' },
    ],
  };
  const input = {
    action: {
      name: 'GMAIL_CREATE_EMAIL_DRAFT',
      arguments: { to: 'synthetic@example.test', body: 'Synthetic draft.' },
    },
  };
  assert.deepEqual(await review('Only existing reads can pass.', input, undefined, question), {
    readOnly: false,
  });
  assert.equal(calls, 2);
  failure = 'refusal';
  assert.equal(
    await review('Only existing reads can pass.', input, undefined, question),
    undefined,
  );
  failure = 'http';
  await assert.rejects(review('Only existing reads can pass.', input, undefined, question));
});

test('a browser uncertainty score cannot change the permission question for Nod settings', async () => {
  const { checkJevTrust } = await import('../src/server/trust-jev.ts');
  const { jevPolicy } = await import('../src/server/trust-jev-policy.ts');
  const model = {
    provider: 'openrouter',
    requested: 'typesafe/jev-1.14',
    served: 'typesafe/jev-1.14-20261014',
  };
  const raw = {
    choice: 'message:0',
    probability: 1,
    model,
    additional: {
      ...Object.fromEntries(
        Object.keys(jevPolicy.features).map((name) => [
          name,
          { choice: name === 'unclear_read_step', probability: 0.99 },
        ]),
      ),
      effect: { choice: 'read', probability: 1 },
    },
  };
  let checks = 0;
  await checkJevTrust(
    {
      check: async (request) => {
        checks++;
        assert.equal(request.question.name, 'permission');
        assert.ok(request.question.instructions?.endsWith(jevPolicy.ownerQuestions.owner_settings));
        return {
          choice: true,
          probability: 0.99,
          model,
          additional: {
            owner_method: {
              choice: 'any',
              probability: 1,
              probabilities: { any: 1, app: 0, browser: 0, unclear: 0 },
            },
          },
        };
      },
    },
    {
      userMessages: [{ at: '2033-06-20T18:30:00Z', text: 'Set my Nod task check-in to USD 7.' }],
      action: { name: 'NOD_limits_update', arguments: {} },
    },
    raw,
    { provider: model.provider, model: model.requested },
  );
  assert.equal(checks, 1);
});

test('every checker must quote owner words for Nod settings, sign-in and uploads', () => {
  const words = {
    userMessages: [{ at: '2033-06-20T18:30:00Z', text: 'Perform the synthetic action now.' }],
  };
  for (const name of [
    'NOD_limits_update',
    'NOD_schedule_create',
    'NOD_notification_preferences_update',
    'NOD_memory_control',
    'NOD_sign_in',
    'NOD_browser_session',
    'NOD_vault_allow',
    'NOD_browser',
  ]) {
    const input = {
      ...words,
      action: { name, arguments: name === 'NOD_browser' ? { step: 'upload' } : {} },
    };
    assert.equal(trustBasis({ run: true, because: 'read' }, input, ['owner-message']), undefined);
    assert.equal(
      trustBasis({ run: true, because: words.userMessages[0].text }, input, ['owner-message'])
        ?.kind,
      'message',
    );
  }
  for (const source of ['standingInstruction', 'userRules']) {
    const input = {
      action: { name: 'NOD_limits_update' },
      [source]: 'Set the task check-in to USD 7.',
    };
    assert.equal(trustBasis({ run: true, because: input[source] }, input, []), undefined);
  }
});
