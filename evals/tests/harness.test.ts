import assert from 'node:assert/strict';
import test from 'node:test';
import { band, passAtK, passPowK, summarize, wilson } from '../src/aggregate.ts';
import { amounts, mentions, urlsGrounded } from '../src/checks.ts';
import { insights } from '../src/insights.ts';
import type { AttemptResult, RunManifest } from '../src/results.ts';
import { tripwire } from '../src/product.ts';
import { agreement, kappa } from '../src/review.ts';
import { choice, number, parseArgs, text, whole } from '../src/options.ts';
import { changes, trustLabels } from '../src/report.ts';
import { select } from '../src/run.ts';
import { createApps, gmail, sheets, slack } from '../src/world/apps.ts';
import { daysAgo, inDays, localTime } from '../src/world/time.ts';

const manifest: RunManifest = {
  label: 't',
  startedAt: '',
  commit: '',
  dirty: false,
  model: 'm',
  judge: 'j',
  repeat: 3,
  k: 3,
  provenance: {},
};

function attempt(
  scenario: string,
  status: AttemptResult['status'],
  extra: Partial<AttemptResult> = {},
): AttemptResult {
  return {
    scenario,
    title: scenario,
    capabilities: ['apps'],
    tier: 'full',
    complexity: 'simple',
    stance: 'regression',
    fingerprint: 'x',
    attempt: 1,
    task: '',
    status,
    checks: [],
    seconds: 10,
    toolCalls: 4,
    modelCalls: 2,
    tokens: 1000,
    costUsd: 0.1,
    toolErrors: 0,
    firstReplySeconds: 2,
    judgeCostUsd: 0.01,
    final: '',
    transcript: '',
    groundTruth: '',
    ...extra,
  };
}

test('pass@k and pass^k follow the unbiased estimators', () => {
  assert.equal(passAtK(3, 2, 3), 1);
  assert.equal(passPowK(3, 2, 3), 0);
  assert.equal(passPowK(3, 3, 3), 1);
  assert.ok(Math.abs(passAtK(5, 2, 2)! - 0.7) < 1e-9);
  assert.ok(Math.abs(passPowK(5, 2, 2)! - 0.1) < 1e-9);
  assert.equal(passAtK(2, 2, 3), null);
});

test('the headline excludes incomplete attempts and known gaps, and flags contaminated runs', () => {
  const summary = summarize(manifest, [
    attempt('a', 'pass'),
    attempt('a', 'fail'),
    attempt('a', 'incomplete', { blame: 'infra' }),
    attempt('b', 'pass', { stance: 'gap' }),
  ]);
  assert.equal(summary.regression.total, 2);
  assert.equal(summary.regression.passed, 1);
  assert.equal(summary.regression.incomplete, 1);
  assert.equal(summary.gap.passed, 1);
  assert.equal(summary.contaminated, false);
  const bad = summarize(manifest, [
    attempt('a', 'incomplete', { blame: 'infra' }),
    attempt('a', 'incomplete', { blame: 'infra' }),
    attempt('a', 'pass'),
  ]);
  assert.equal(bad.contaminated, true);
});

test('intervals and difficulty bands behave at the edges', () => {
  assert.equal(wilson(0, 0), null);
  assert.equal(wilson(3, 3)!.high, 1);
  const half = wilson(5, 10)!;
  assert.ok(half.low > 0.2 && half.low < 0.26 && half.high > 0.74 && half.high < 0.8);
  assert.equal(band(1, 3), 'anchor');
  assert.equal(band(0, 3), 'frontier');
  assert.equal(band(0.5, 3), 'discriminator');
  assert.equal(band(1, 2), null);
});

test('amounts are read in the formats assistants actually write', () => {
  assert.ok(mentions('Total €1,850.00 overdue', 1850));
  assert.ok(mentions('Total 1.850,00 EUR', 1850));
  assert.ok(mentions('bill of 86,40', 86.4));
  assert.ok(mentions('12,408 weekly users', 12408));
  assert.ok(mentions('€3 200', 3200));
  assert.ok(!mentions('€3,200', 320));
  assert.deepEqual(amounts('Pay 86.40 by 14 Oct').slice(0, 1), [86.4]);
});

test('the fake Gmail understands the queries agents write', async () => {
  const now = Date.UTC(2026, 9, 2, 12);
  const owner = { name: 'Alex', email: 'alex@x.test' };
  const box = gmail(
    owner,
    [
      {
        id: 'a',
        from: 'Billing <billing@acme.test>',
        subject: 'Invoice 7',
        body: 'Please pay',
        at: now - 2 * 86_400_000,
      },
      {
        id: 'b',
        from: 'News <news@x.test>',
        subject: 'Weekly digest',
        body: 'Invoice tips',
        at: now - 40 * 86_400_000,
      },
      {
        id: 'c',
        from: 'Sam <sam@y.test>',
        subject: 'Lunch?',
        body: 'Are you free',
        at: now - 3_600_000,
        labels: ['INBOX', 'UNREAD'],
      },
    ],
    () => now,
  );
  const fetch = (query: string) =>
    (box.tools[0].run({ query }) as { messages: Array<{ messageId: string }> }).messages.map(
      (m) => m.messageId,
    );
  assert.deepEqual(fetch('from:billing'), ['a']);
  assert.deepEqual(fetch('invoice newer_than:30d'), ['a']);
  assert.deepEqual(fetch('invoice -from:news'), ['a']);
  assert.deepEqual(fetch('from:sam OR from:billing').sort(), ['a', 'c']);
  assert.deepEqual(fetch('is:unread'), ['c']);
  assert.deepEqual(fetch('"are you free"'), ['c']);
});

test('draft and send are separate effects in the fake mailbox', () => {
  const owner = { name: 'Alex', email: 'alex@x.test' };
  const box = gmail(owner, [], Date.now);
  const draft = box.tools.find((tool) => tool.slug === 'GMAIL_CREATE_EMAIL_DRAFT')!;
  const created = draft.run({ recipient_email: 'a@b.test', subject: 's', body: 'b' }) as {
    id: string;
  };
  assert.equal(box.drafts().length, 1);
  assert.equal(box.sent().length, 0);
  const read = box.tools
    .find((tool) => tool.slug === 'GMAIL_GET_DRAFT')!
    .run({ draft_id: created.id }) as { message: { to: string } };
  assert.equal(read.message.to, 'a@b.test');
  box.tools
    .find((tool) => tool.slug === 'GMAIL_SEND_EMAIL')!
    .run({ recipient_email: 'a@b.test', subject: 's', body: 'b' });
  assert.equal(box.sent().length, 1);
  const world = createApps(owner, { gmail: box });
  assert.deepEqual(world.services, ['gmail']);
});

test('sheet ranges and appends behave like Google Sheets', () => {
  const book = sheets(
    [
      {
        title: 'T',
        tabs: [
          {
            name: 'Data',
            rows: [
              ['a', 'b'],
              ['1', '2'],
            ],
          },
        ],
      },
    ],
    Date.now,
  );
  const run = (slug: string, args: Record<string, unknown>) =>
    book.tools.find((tool) => tool.slug === slug)!.run(args) as any;
  const id = book.books[0].id;
  assert.deepEqual(
    run('GOOGLESHEETS_BATCH_GET', { spreadsheet_id: id, ranges: ['Data!A2:B2'] }).valueRanges[0]
      .values,
    [['1', '2']],
  );
  run('GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND', {
    spreadsheetId: id,
    range: 'Data!A1',
    values: [['3', '4']],
  });
  assert.deepEqual(book.books[0].tabs[0].rows[2], ['3', '4']);
});

test('local times are anchored in the user time zone across a daylight saving change', () => {
  const clock = (value: number) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Madrid',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(value);
  assert.equal(clock(localTime(Date.UTC(2026, 9, 2, 12), 1, 18)), '01/10/2026, 18:00');
  assert.equal(clock(localTime(Date.UTC(2026, 9, 26, 12), 1, 18)), '25/10/2026, 18:00');
  assert.equal(clock(localTime(Date.UTC(2026, 9, 25, 12), 1, 18)), '24/10/2026, 18:00');
  const evening = Date.UTC(2026, 9, 24, 18, 30);
  assert.equal(clock(inDays(evening, 2)), '26/10/2026, 20:30');
  assert.equal(clock(daysAgo(inDays(evening, 2), 2)), '24/10/2026, 20:30');
  assert.equal(evening - daysAgo(evening, 0.5), 43_200_000);
  assert.equal(inDays(evening, 1.5) - evening, 133_200_000);
});

test('a Slack thread reply lands in the thread, not the channel', () => {
  const owner = { id: 'U1', name: 'Alex', email: 'alex@x.test' };
  const chat = slack(
    owner,
    [],
    [
      {
        name: 'ops',
        kind: 'channel',
        messages: [{ user: 'U2', text: 'Who owns the invoice?', at: Date.UTC(2026, 9, 2, 9) }],
      },
    ],
    Date.now,
  );
  const send = chat.tools.find((tool) => tool.slug === 'SLACK_SEND_MESSAGE')!;
  const parent = chat.conversations[0].messages[0];
  send.run({ channel: 'ops', text: 'Mine', thread_ts: parent.ts });
  assert.equal(chat.conversations[0].messages.length, 1);
  assert.equal(parent.replies?.[0].text, 'Mine');
  assert.throws(
    () => send.run({ channel: 'ops', text: 'x', thread_ts: '1.1' }),
    /thread_not_found/,
  );
  const found = chat.tools
    .find((tool) => tool.slug === 'SLACK_SEARCH_MESSAGES')!
    .run({ query: 'mine' }) as { messages: { matches: unknown[] } };
  assert.equal(found.messages.matches.length, 1);
  send.run({ channel: 'ops', text: 'Top level' });
  assert.equal(chat.conversations[0].messages.length, 2);
});

test('a link only counts as grounded when a page or tool returned it', () => {
  const run = (output: string) =>
    ({
      task: 'Look at https://given.example/a',
      final: 'See https://given.example/a, https://found.example/b and https://made.example/c.',
      tools: [{ name: 'browser', input: { url: 'https://made.example/c' }, output }],
    }) as never;
  assert.deepEqual(urlsGrounded(run('Result: https://found.example/b')).invented, [
    'https://made.example/c',
  ]);
});

test('model rankings ignore runs that are contaminated or only partly run', () => {
  const run = (percent: number, extra: Record<string, unknown> = {}, incomplete = 0) =>
    ({
      attempts: [],
      summary: {
        manifest: { model: 'openai/m', label: 'l' },
        regression: { percent, total: 30, incomplete, passPowK: percent },
        efficiency: { costPerPass: 0.1, seconds: { p50: 60 } },
        trust: { safetyIncidents: 0 },
        contaminated: false,
        ...extra,
      },
    }) as never;
  const good = run(0.6);
  const flaky = run(0.9, {}, 20);
  const partial = run(0.95, {
    regression: { percent: 0.95, total: 10, incomplete: 0, passPowK: 0.95 },
  });
  const ranked = insights([good, run(0.9, { contaminated: true }), flaky, partial]);
  assert.equal(ranked.best?.run, good);
  assert.equal(insights([run(0.9, { contaminated: true })]).best, undefined);
});

test('calibrating scenarios run only on request or by name', () => {
  const plain = { tier: 'full', ignoreWindow: true };
  const standard = select(plain).map((item) => item.id);
  const everything = select({ ...plain, includePending: true }).map((item) => item.id);
  assert.ok(everything.length > standard.length);
  const pending = everything.find((id) => !standard.includes(id))!;
  assert.deepEqual(
    select({ ...plain, scenarioIds: [pending] }).map((item) => item.id),
    [pending],
  );
});

test('the style tripwires catch what the personality forbids and let normal replies through', () => {
  const run = (texts: string[], user = 'hi') =>
    ({
      messages: [
        { role: 'user', text: user, at: 0, turnId: null },
        ...texts.map((text) => ({ role: 'assistant' as const, text, at: 1, turnId: null })),
      ],
    }) as never;
  assert.equal(tripwire(run(['Your total is €412 and the renewal is on 12 Oct.'])), undefined);
  assert.match(tripwire(run(['Certainly! Here is the answer.']))!, /certainly/);
  assert.match(tripwire(run(['Done — sent it.']))!, /em dash/);
  assert.match(
    tripwire(run(['All set. Let me know if you need anything else.']))!,
    /let me know if/,
  );
  assert.match(tripwire(run(['## Summary\nAll good']))!, /heading/);
  assert.match(tripwire(run(['Request failed with HTTP 503']))!, /raw error/);
  assert.equal(tripwire(run(['Nice 🎉'], 'party 🎉')), undefined);
  assert.match(tripwire(run(['Nice 🎉']))!, /emoji/);
});

test('human agreement is measured with chance-corrected kappa', () => {
  assert.equal(kappa(5, 0, 0, 5), 1);
  assert.equal(kappa(0, 5, 5, 0), -1);
  assert.ok(Math.abs(kappa(4, 1, 1, 4)! - 0.6) < 1e-9);
  const attempts = [
    { scenario: 'a', attempt: 1, status: 'pass' },
    { scenario: 'a', attempt: 2, status: 'fail' },
    { scenario: 'b', attempt: 1, status: 'pass' },
  ] as never;
  const result = agreement(attempts, {
    'a.1': { verdict: 'trust', wrongChecks: [], note: '', reviewer: 'x', at: '' },
    'a.2': { verdict: 'trust', wrongChecks: [], note: 'it was fine', reviewer: 'x', at: '' },
  });
  assert.equal(result.reviewed, 2);
  assert.equal(result.agree, 1);
  assert.match(result.disagreements[0], /a\.2/);
});

test('trust lines count only applicable product judgements and safety incidents', () => {
  const product = (
    id: string,
    pass: boolean,
    extra: Partial<AttemptResult['checks'][number]> = {},
  ) => ({
    id,
    kind: 'judge' as const,
    group: 'product' as const,
    aspect: 'process' as const,
    failure: 'hallucination' as const,
    required: false,
    pass,
    ...extra,
  });
  const summary = summarize(manifest, [
    attempt('a', 'pass', {
      checks: [
        product('honest-completion-claims', true),
        product('keeps-going-when-blocked', true, { na: true }),
      ],
    }),
    attempt('a', 'fail', {
      checks: [
        product('honest-completion-claims', false, { required: true }),
        {
          ...product('no-payment', false, { required: true, failure: 'unsafe' }),
          group: 'task' as const,
        },
      ],
    }),
  ]);
  assert.equal(
    summary.trust.lines.find((line) => line.id === 'honest-completion-claims')!.rate,
    0.5,
  );
  assert.equal(
    summary.trust.lines.find((line) => line.id === 'keeps-going-when-blocked')!.applicable,
    0,
  );
  assert.equal(summary.trust.safetyIncidents, 1);
});

test('the command line understands commands, positionals, flags and booleans', () => {
  const args = parseArgs([
    'models',
    'a/x',
    'b/y',
    '--tier',
    'pr',
    '--repeat=2',
    '--resume',
    '--budget',
    '5',
  ]);
  assert.equal(args.command, 'models');
  assert.deepEqual(args.positional, ['a/x', 'b/y']);
  assert.equal(text(args, 'tier'), 'pr');
  assert.equal(whole(args, 'repeat', 3), 2);
  assert.equal(args.flags.get('resume'), true);
  assert.equal(whole(args, 'concurrency', 4), 4);
  assert.equal(parseArgs([]).command, 'help');
  assert.equal(parseArgs(['run', '--help']).command, 'help');
  assert.throws(
    () => whole(parseArgs(['run', '--repeat', '0']), 'repeat', 3),
    /positive whole number/,
  );
  assert.throws(() => parseArgs(['run', '--repeat']), /needs a value/);
  assert.throws(() => parseArgs(['run', '--budget', '--resume']), /needs a value/);
  assert.throws(() => number(parseArgs(['run', '--budget', 'nope']), 'budget', 0), /number from 0/);
  assert.throws(() => number(parseArgs(['run', '--min-pass', '2']), 'min-pass', 0, 1), /0 to 1/);
  assert.equal(number(parseArgs(['run', '--min-pass', '0.8']), 'min-pass', 0, 1), 0.8);
  assert.throws(
    () => choice(parseArgs(['run', '--tier', 'ful']), 'tier', ['pr', 'full', 'live'], 'full'),
    /one of: pr, full, live/,
  );
});

test('failures are grouped by scenario, category and blame, and eval faults are surfaced', () => {
  const diagnosis = (blame: 'agent' | 'scenario', category: 'reasoning' | 'scope') => ({
    rootCause: 'because',
    category,
    blame,
    turningPoint: '',
    fix: 'fix it',
    confidence: 0.8,
  });
  const summary = summarize(manifest, [
    attempt('a', 'fail', { diagnosis: diagnosis('agent', 'reasoning') }),
    attempt('a', 'fail', { diagnosis: diagnosis('agent', 'reasoning') }),
    attempt('b', 'fail', { diagnosis: diagnosis('scenario', 'scope') }),
    attempt('c', 'fail'),
    attempt('d', 'pass'),
  ]);
  assert.equal(summary.wentWrong.groups[0].count, 2);
  assert.equal(summary.wentWrong.suspectEval.length, 1);
  assert.equal(summary.wentWrong.suspectEval[0].scenario, 'b');
  assert.equal(summary.wentWrong.undiagnosed, 1);
});

test('run comparison reports what got worse and better, but only for unchanged scenarios', () => {
  const check = (id: string, pass: boolean) => ({
    id,
    kind: 'check' as const,
    group: 'task' as const,
    aspect: 'outcome' as const,
    failure: 'reasoning' as const,
    required: true,
    pass,
  });
  const runs = (passes: boolean[], fingerprint = 'x') => {
    const attempts = passes.map((pass, index) =>
      attempt('s', pass ? 'pass' : 'fail', {
        attempt: index + 1,
        fingerprint,
        checks: [check('names-the-sheet', pass)],
      }),
    );
    return { summary: summarize(manifest, attempts), attempts };
  };
  const out = changes(runs([true, true, true]), runs([false, false, true])).join('\n');
  assert.match(out, /Got worse/);
  assert.match(out, /s \/ names-the-sheet: 3\/3 → 1\/3/);
  assert.doesNotMatch(
    changes(runs([true, true, true]), runs([false, false, true], 'changed')).join('\n'),
    /Got worse/,
  );
  assert.equal(typeof trustLabels['honest-completion-claims'], 'string');
});
