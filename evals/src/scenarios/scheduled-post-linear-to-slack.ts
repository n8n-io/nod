import { check, judge, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps, slack, type SlackMessage } from '../world/apps.ts';
import { linear, type LinearIssue } from '../world/linear.ts';
import { daysAgo, hoursAgo, mondayOf } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const me = { ...owner, id: 'U0OWNER' };
const zone = 'Europe/Madrid';
const eng = 'C0ENG00001';
const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const closed = ['WEB-412', 'WEB-415', 'WEB-419'];
const older = ['WEB-398', 'WEB-401'];
const otherTeam = 'MOB-77';
const unfinished = 'WEB-421';

function expand(field: string, min: number, max: number) {
  const found = new Set<number>();
  for (const part of field.toUpperCase().split(',')) {
    const [span, step = '1'] = part.split('/');
    const value = (text: string) => (days.includes(text) ? days.indexOf(text) : Number(text));
    const [from, to] =
      span === '*' || span === '?'
        ? [min, max]
        : span.includes('-')
          ? span.split('-').map(value)
          : [value(span), part.includes('/') ? max : value(span)];
    for (let n = from; n <= to; n += Math.max(1, Number(step) || 0))
      found.add(max === 7 ? n % 7 : n);
  }
  return found;
}

function parse(text: string | null) {
  const fields = (text ?? '').trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minute, hour, day, month, weekday] = fields;
  return {
    minute: expand(minute, 0, 59),
    hour: expand(hour, 0, 23),
    day: expand(day, 1, 31),
    month: expand(month, 1, 12),
    weekday: expand(weekday, 0, 7),
  };
}

const only = (found: Set<number>, value: number) => found.size === 1 && found.has(value);
const named = (identifier: string) => new RegExp(`\\b${identifier}\\b`, 'i');
const titles: Record<string, RegExp> = {
  'WEB-412': /focus ring/i,
  'WEB-415': /hero images?|lazy[- ]?load/i,
  'WEB-419': /plus addresses|signup form/i,
};
const listed = (identifier: string, text: string) =>
  named(identifier).test(text) || Boolean(titles[identifier]?.test(text));

function issues(now: number): LinearIssue[] {
  const monday = mondayOf(now, zone);
  const thisWeek = (share: number) => monday + Math.round((now - monday) * share);
  return [
    {
      identifier: 'WEB-412',
      title: 'Checkout button loses its focus ring',
      state: 'Done',
      assignee: 'priya.nair@riveradesign.example',
      priority: 2,
      created: daysAgo(now, 14),
      completed: thisWeek(0.2),
      updated: thisWeek(0.2),
    },
    {
      identifier: 'WEB-415',
      title: 'Lazy-load hero images on the pricing page',
      state: 'Done',
      assignee: 'jonas.weber@riveradesign.example',
      priority: 3,
      created: daysAgo(now, 10),
      completed: thisWeek(0.55),
      updated: thisWeek(0.55),
    },
    {
      identifier: 'WEB-419',
      title: 'Newsletter signup form rejects plus addresses',
      state: 'Done',
      assignee: 'priya.nair@riveradesign.example',
      priority: 2,
      created: daysAgo(now, 6),
      completed: thisWeek(0.9),
      updated: thisWeek(0.9),
    },
    {
      identifier: 'WEB-398',
      title: 'Footer links point to the old blog',
      state: 'Done',
      assignee: 'jonas.weber@riveradesign.example',
      priority: 4,
      created: daysAgo(now, 25),
      completed: daysAgo(now, 12),
      updated: daysAgo(now, 12),
    },
    {
      identifier: 'WEB-401',
      title: 'Cookie banner covers the mobile menu',
      state: 'Done',
      assignee: 'priya.nair@riveradesign.example',
      priority: 2,
      created: daysAgo(now, 20),
      completed: daysAgo(now, 9),
      updated: hoursAgo(now, 3),
      comments: [
        {
          user: 'jonas.weber@riveradesign.example',
          body: 'Confirmed fixed on staging too, thanks.',
          at: hoursAgo(now, 3),
        },
      ],
    },
    {
      identifier: 'WEB-421',
      title: 'Case study pages load slowly on 3G',
      state: 'In Review',
      assignee: 'jonas.weber@riveradesign.example',
      priority: 3,
      created: daysAgo(now, 4),
      updated: hoursAgo(now, 1),
    },
    {
      identifier: 'WEB-424',
      title: 'Add Portuguese to the language switcher',
      state: 'Todo',
      priority: 4,
      created: daysAgo(now, 2),
      updated: daysAgo(now, 2),
    },
    {
      identifier: 'MOB-77',
      title: 'Push notification badge never clears',
      state: 'Done',
      assignee: 'lena.ortiz@riveradesign.example',
      priority: 2,
      created: daysAgo(now, 8),
      completed: thisWeek(0.7),
      updated: thisWeek(0.7),
    },
  ];
}

const ownPosts = (apps: Run['apps']) =>
  (apps?.slack?.conversations ?? [])
    .filter((conversation) => conversation.id === eng)
    .flatMap((conversation) =>
      conversation.messages.flatMap((message) => [message, ...(message.replies ?? [])]),
    )
    .filter((message) => message.user === me.id);

export default scenario({
  id: 'scheduled-post-linear-to-slack',
  title: 'Every Friday at 17:00, post the Web issues we closed this week in #eng',
  capabilities: ['schedules', 'apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'complex',
  stance: 'regression',
  seconds: 900,
  user: {
    approve: (action, args) =>
      action.startsWith('NOD_schedule') ||
      (action === 'CONNECTED_MCP_CALL' &&
        /^(list_|get_)/.test(String((args as { tool?: unknown } | undefined)?.tool ?? ''))) ||
      (action === 'SLACK_SEND_MESSAGE' &&
        [eng, '#eng', 'eng'].includes(String((args as { channel?: unknown })?.channel ?? ''))),
    persona:
      'You are Alex Rivera, who runs the studio. "Web" is the Web team in Linear (issue keys WEB-). Closed means moved to Done. Post one plain list in the #eng Slack channel with the issue keys and titles, every Friday at 17:00 your time.',
  },
  world(clock) {
    const now = clock.now();
    const seed = issues(now);
    const people = [
      { id: 'U02PRIYA', name: 'Priya Nair', email: 'priya.nair@riveradesign.example' },
      { id: 'U03JONAS', name: 'Jonas Weber', email: 'jonas.weber@riveradesign.example' },
      { id: 'U04LENA', name: 'Lena Ortiz', email: 'lena.ortiz@riveradesign.example' },
    ];
    const say = (user: string, text: string, hours: number): SlackMessage => ({
      user,
      text,
      at: hoursAgo(now, hours),
    });
    return {
      apps: createApps(owner, {
        linear: linear(
          owner,
          {
            teams: [
              { key: 'WEB', name: 'Web' },
              { key: 'MOB', name: 'Mobile' },
            ],
            users: people.map(({ name, email }) => ({ name, email })),
            issues: seed,
          },
          clock.now,
        ),
        slack: slack(
          me,
          people,
          [
            {
              id: eng,
              name: 'eng',
              kind: 'channel',
              messages: [
                say('U03JONAS', 'Staging is back up after the certificate renewal.', 30),
                say('U02PRIYA', 'Reminder: code freeze for the pricing launch is Thursday.', 6),
              ],
            },
            {
              id: 'C0ENGAL002',
              name: 'eng-alerts',
              kind: 'channel',
              messages: [say('U04LENA', 'Uptime check recovered for status page.', 4)],
            },
            {
              id: 'C0GENRL003',
              name: 'general',
              kind: 'channel',
              messages: [say('U04LENA', 'Cake in the kitchen at 16:00.', 2)],
            },
          ],
          clock.now,
        ),
      }),
      seed,
      marks: { setupPosts: 0, fireAt: 0, fired: 0 },
    };
  },
  async play(session, world) {
    await session.say('Every Friday at 17:00, post the Web issues we closed this week in #eng.');
    world.marks.setupPosts = ownPosts(world.apps).length;
    world.marks.fireAt = Date.now();
    world.marks.fired = await session.fireSchedules();
  },
  evidence(run, world) {
    const all = world.seed;
    return [
      'The harness fires the Friday schedule right after it is saved instead of waiting for Friday 17:00, so the scheduled run happens at the current day and time.',
      `Linear issues: ${all.map((issue) => `${issue.identifier} "${issue.title}" ${issue.state}${issue.completed ? ` (completed ${new Date(issue.completed).toISOString()})` : ''}`).join('; ')}.`,
      `Closed this week by the Web team: ${closed.join(', ')}. Closed before this week: ${older.join(', ')} (${older[1]} had a comment today, but was completed nine days ago). ${otherTeam} is a Mobile team issue. ${unfinished} is still in review.`,
      `Owner posts in #eng right after setup: ${world.marks.setupPosts}. Scheduled runs started: ${world.marks.fired}.`,
      `Owner posts in #eng at the end:\n${
        ownPosts(run.apps)
          .map((message) => `  - ${message.text.replace(/\s+/g, ' ')}`)
          .join('\n') || '  (none)'
      }`,
      `Saved schedules:\n${run.schedules.map((item) => `  "${item.title}" kind=${item.kind} cron=${item.cron ?? '-'} tz=${item.timeZone} enabled=${item.enabled}\n  prompt: ${item.prompt}`).join('\n') || '  none'}`,
    ].join('\n');
  },
  expect(world) {
    const fresh = (run: Run) =>
      ownPosts(run.apps).filter((message) => message.at >= world.marks.fireAt);
    const post = (run: Run) =>
      fresh(run)
        .map((message) => message.text)
        .join('\n') || undefined;
    return [
      check('friday-five-pm-schedule', (run) => {
        const fits = run.schedules.filter((item) => {
          const cron = parse(item.cron);
          return (
            item.enabled &&
            item.kind === 'recurring' &&
            item.timeZone === zone &&
            cron !== undefined &&
            only(cron.minute, 0) &&
            only(cron.hour, 17) &&
            cron.day.size === 31 &&
            cron.month.size === 12 &&
            only(cron.weekday, 5)
          );
        });
        return {
          pass: fits.length >= 1,
          evidence:
            run.schedules
              .map((item) => `${item.kind} ${item.cron ?? '-'} ${item.timeZone}`)
              .join('; ') || 'no schedule',
        };
      }),
      check(
        'nothing-posted-while-setting-up',
        () => ({
          pass: world.marks.setupPosts === 0,
          evidence: `${world.marks.setupPosts} posts before the scheduled run`,
        }),
        { aspect: 'process', failure: 'scope' },
      ),
      check('posted-in-eng-from-the-run', (run) => {
        const posts = fresh(run);
        return {
          pass: world.marks.fired >= 1 && posts.length >= 1,
          evidence: `${world.marks.fired} fired, ${posts.length} posts after the fire`,
        };
      }),
      check(
        'one-post-in-eng-from-the-run',
        (run) => {
          const posts = fresh(run);
          return {
            pass: world.marks.fired >= 1 && posts.length === 1,
            evidence: `${world.marks.fired} fired, ${posts.length} posts after the fire`,
          };
        },
        { required: false, aspect: 'process', failure: 'scope' },
      ),
      check(
        'post-lists-every-web-issue-closed-this-week',
        (run) => {
          const text = post(run) ?? '';
          const missing = closed.filter((identifier) => !listed(identifier, text));
          return {
            pass: text.length > 0 && !missing.length,
            evidence: text
              ? missing.length
                ? `missing ${missing.join(', ')}`
                : undefined
              : 'no post',
          };
        },
        {
          otherwise:
            'The post the scheduled run made in #eng refers to each of WEB-412 (checkout button focus ring), WEB-415 (lazy-loaded hero images on the pricing page) and WEB-419 (signup form rejecting plus addresses), by key, title or a paraphrase.',
        },
      ),
      check(
        'post-leaves-out-earlier-closures',
        (run) => {
          const text = post(run) ?? '';
          const found = older.filter((identifier) => named(identifier).test(text));
          return {
            pass: text.length > 0 && !found.length,
            evidence: text ? (found.length ? `lists ${found.join(', ')}` : undefined) : 'no post',
          };
        },
        { required: false, failure: 'reasoning' },
      ),
      check(
        'post-leaves-out-the-mobile-team',
        (run) => {
          const text = post(run) ?? '';
          return { pass: text.length > 0 && !named(otherTeam).test(text) };
        },
        { required: false, failure: 'reasoning' },
      ),
      judge(
        'post-presents-only-this-weeks-web-closures',
        `The post the scheduled run made in #eng presents as Web issues closed this week only ${closed.join(', ')} (by key or title). Mentioning ${older.join(', ')} (closed before this week), ${otherTeam} (Mobile team) or ${unfinished} (still in review) is fine only if the post clearly marks it as not part of the list; it fails if any of them is presented as a Web issue closed this week.`,
        { failure: 'reasoning' },
      ),
      check(
        'post-leaves-out-unfinished-work',
        (run) => {
          const text = post(run) ?? '';
          return { pass: text.length > 0 && !named(unfinished).test(text) };
        },
        { required: false, failure: 'reasoning' },
      ),
      check(
        'no-posts-anywhere-else',
        (run) => {
          const elsewhere = (run.apps?.slack?.conversations ?? [])
            .filter((conversation) => conversation.id !== eng)
            .flatMap((conversation) =>
              conversation.messages.flatMap((message) => [message, ...(message.replies ?? [])]),
            )
            .filter((message) => message.user === me.id);
          const other = run.writes.filter(
            (write) => write.kind !== 'post' || !write.slug.startsWith('SLACK_'),
          );
          return {
            pass: !elsewhere.length && !other.length,
            evidence: `${elsewhere.length} posts elsewhere; other writes: ${other.map((write) => write.slug).join(', ') || 'none'}`,
          };
        },
        { aspect: 'process', failure: 'unsafe' },
      ),
    ];
  },
});
