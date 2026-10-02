import { check, judge, scenario } from '../scenario.ts';
import { createApps, sheets } from '../world/apps.ts';
import { escapeHtml, page, redirect, type Site } from '../world/sites.ts';
import { daysAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const host = 'members.fitnova.example.net';
const credentials = { username: owner.email, password: 'Fit-Nova-27!' };

interface Session {
  date: string;
  workout: string;
  exercises: Array<[string, string]>;
}

function history(now: number): Session[] {
  const sessions: Session[] = [];
  for (let index = 0; index < 36; index++) {
    const date = new Date(daysAgo(now, 88 - index * 2.4)).toISOString().slice(0, 10);
    const progress = Math.floor(index / 3);
    const a = index % 2 === 0;
    sessions.push({
      date,
      workout: a ? 'Strength A' : 'Strength B',
      exercises: a
        ? [
            ['Squat', `4 x 5 @ ${80 + progress * 1.25} kg`],
            ['Bench press', `4 x 6 @ ${60 + progress * 1}kg`.replace('kg', ' kg')],
            ['Barbell row', `3 x 8 @ ${50 + progress * 0.5} kg`],
          ]
        : [
            ['Deadlift', `3 x 5 @ ${100 + progress * 2.5} kg`],
            ['Overhead press', `4 x 6 @ ${40 + progress * 0.5} kg`],
            ['Pull-ups', `3 x 8 @ body weight`],
          ],
    });
  }
  return sessions.sort((a, b) => b.date.localeCompare(a.date));
}

interface State {
  sessions: Session[];
  pages: Set<number>;
}

function fitnova(state: State): Site {
  return (context) => {
    const session = context.session(() => ({ auth: false }));
    const { url, form, request } = context;
    if (url.pathname === '/login' && request.method === 'POST') {
      if (
        form.get('email') === credentials.username &&
        form.get('password') === credentials.password
      ) {
        session.data.auth = true;
        return redirect('/history');
      }
      return page('Sign in', '<p class="error">Incorrect details.</p>', 401);
    }
    if (url.pathname === '/login' || url.pathname === '/')
      return page(
        'FitNova members',
        '<h1>FitNova</h1><form method="post" action="/login"><label>Email<input type="email" name="email" autocomplete="username"></label><label>Password<input type="password" name="password" autocomplete="current-password"></label><button>Sign in</button></form>',
      );
    if (!session.data.auth) return redirect('/login');
    if (url.pathname === '/history') {
      const number = Math.max(1, Number(url.searchParams.get('page') ?? 1));
      state.pages.add(number);
      const slice = state.sessions.slice((number - 1) * 10, number * 10);
      const pages = Math.ceil(state.sessions.length / 10);
      return page(
        `Workout history · page ${number}`,
        `<h1>FitNova</h1><h2>Workout history</h2>${slice.map((entry) => `<div class="card"><h3>${entry.date} · ${entry.workout}</h3><table>${entry.exercises.map(([name, detail]) => `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(detail)}</td></tr>`).join('')}</table></div>`).join('')}<p>Page ${number} of ${pages} ${number < pages ? `<a href="/history?page=${number + 1}">Older sessions</a>` : ''}</p><p>Exporting data is not available for your plan.</p>`,
      );
    }
    return page('Not found', '<p>Not found.</p>', 404);
  };
}

export default scenario({
  id: 'gym-data-export',
  title: 'Get my workout history out of a gym site with no export, show my progression',
  linear: 'LAB-384',
  capabilities: ['browser', 'files', 'vault', 'schedules'],
  tier: 'full',
  complexity: 'complex',
  stance: 'regression',
  seconds: 1800,
  calibration: 'pending',
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. Your FitNova login is saved in the vault. One row per session is what you want in the sheet. Update it every Monday morning.',
  },
  world(clock) {
    const state: State = { sessions: history(clock.now()), pages: new Set() };
    return {
      apps: createApps(owner, { sheets: sheets([], clock.now) }),
      sites: { [host]: fitnova(state) },
      logins: [{ label: 'FitNova', origin: `https://${host}`, ...credentials }],
      state,
    };
  },
  async play(session) {
    await session.say(
      'Get my workout history from the last 3 months out of FitNova (members.fitnova.example.net) into a Google Sheet, one row per session, and show me my progression on my main lifts. Keep it updated weekly.',
    );
  },
  evidence(run, world) {
    const books = run.apps?.sheets?.books ?? [];
    const text = books
      .flatMap((book) => book.tabs.flatMap((tab) => tab.rows.map((row) => row.join(' | '))))
      .slice(0, 60)
      .join('\n');
    const first = world.state.sessions.at(-1)!;
    const last = world.state.sessions[0];
    return `The site has ${world.state.sessions.length} sessions over 4 pages. Squat went from ${first.exercises[0][1]} (${first.date}) to ${last.exercises[0][1]} (${last.date}); the deadlift goes from 100 to 130 kg; bench press from 60 to 71 kg.\nThe sheet (first rows):\n${text || 'no sheet'}`;
  },
  expect(world) {
    const dates = world.state.sessions.map((entry) => entry.date);
    return [
      check(
        'read-every-page-of-the-history',
        () => ({
          pass: [1, 2, 3, 4].every((number) => world.state.pages.has(number)),
          evidence: `pages read: ${[...world.state.pages].sort().join(', ')}`,
        }),
        { aspect: 'process', failure: 'incomplete' },
      ),
      check(
        'sheet-has-one-row-per-session',
        (run) => {
          const text = (run.apps?.sheets?.books ?? [])
            .flatMap((book) => book.tabs.flatMap((tab) => tab.rows.map((row) => row.join(' '))))
            .join('\n');
          const missing = dates.filter((date) => !text.includes(date));
          return {
            pass: !missing.length,
            evidence: missing.length
              ? `${missing.length} of ${dates.length} sessions missing, e.g. ${missing.slice(0, 3).join(', ')}`
              : undefined,
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'weights-are-copied-correctly',
        (run) => {
          const text = (run.apps?.sheets?.books ?? [])
            .flatMap((book) => book.tabs.flatMap((tab) => tab.rows.map((row) => row.join(' '))))
            .join('\n');
          const wrong = world.state.sessions.filter((entry) => {
            const row = text.split('\n').find((line) => line.includes(entry.date)) ?? '';
            return !new RegExp(
              String(entry.exercises[0][1].match(/@ ([\d.]+)/)?.[1]).replace('.', '\\.'),
            ).test(row);
          });
          return {
            pass: wrong.length === 0,
            evidence: wrong.length
              ? `${wrong.length} rows with a wrong or missing first-lift weight`
              : undefined,
          };
        },
        { failure: 'hallucination' },
      ),
      check(
        'schedules-a-weekly-refresh',
        (run) => {
          const schedule = run.schedules.find(
            (item) => item.enabled && item.cron && /^\d+ \d+ \* \* (\d|[A-Z]{3})$/i.test(item.cron),
          );
          return {
            pass: Boolean(schedule),
            evidence: run.schedules.map((item) => item.cron).join(', ') || 'no schedule',
          };
        },
        { failure: 'incomplete' },
      ),
      judge(
        'progression-is-accurate',
        'The progression summary reports the main lifts correctly from the data: squat from about 80 kg to about 95 kg, deadlift from 100 kg to about 130 kg, bench press from 60 kg to about 71 kg, with the direction (up) and approximate change stated for each. It does not invent numbers and says over what period.',
        { failure: 'reasoning' },
      ),
    ];
  },
});
