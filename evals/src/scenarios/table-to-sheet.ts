import { dumpSheets } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps, sheets } from '../world/apps.ts';
import { page, type Site } from '../world/sites.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const host = 'lisboa-cidade.example.org';

type Holiday = [month: number, day: number, name: string, kind: string];

const national = 'National';
const holidays: Record<number, Holiday[]> = {
  2025: [
    [1, 1, "New Year's Day (Ano Novo)", national],
    [3, 4, 'Carnival (Carnaval)', 'Optional: not a public holiday'],
    [4, 18, 'Good Friday (Sexta-feira Santa)', national],
    [4, 20, 'Easter Sunday (Páscoa)', national],
    [4, 25, 'Freedom Day (Dia da Liberdade)', national],
    [5, 1, 'Labour Day (Dia do Trabalhador)', national],
    [6, 10, 'Portugal Day (Dia de Portugal)', national],
    [6, 13, "St Anthony's Day (Santo António)", 'Municipal: Lisbon only'],
    [6, 19, 'Corpus Christi', national],
    [8, 15, 'Assumption Day (Assunção de Nossa Senhora)', national],
    [10, 5, 'Republic Day (Implantação da República)', national],
    [11, 1, "All Saints' Day (Todos os Santos)", national],
    [12, 1, 'Restoration of Independence (Restauração da Independência)', national],
    [12, 8, 'Immaculate Conception (Imaculada Conceição)', national],
    [12, 25, 'Christmas Day (Natal)', national],
  ],
  2026: [
    [1, 1, "New Year's Day (Ano Novo)", national],
    [2, 17, 'Carnival (Carnaval)', 'Optional: not a public holiday'],
    [4, 3, 'Good Friday (Sexta-feira Santa)', national],
    [4, 5, 'Easter Sunday (Páscoa)', national],
    [4, 25, 'Freedom Day (Dia da Liberdade)', national],
    [5, 1, 'Labour Day (Dia do Trabalhador)', national],
    [6, 4, 'Corpus Christi', national],
    [6, 10, 'Portugal Day (Dia de Portugal)', national],
    [6, 13, "St Anthony's Day (Santo António)", 'Municipal: Lisbon only'],
    [8, 15, 'Assumption Day (Assunção de Nossa Senhora)', national],
    [10, 5, 'Republic Day (Implantação da República)', national],
    [11, 1, "All Saints' Day (Todos os Santos)", national],
    [12, 1, 'Restoration of Independence (Restauração da Independência)', national],
    [12, 8, 'Immaculate Conception (Imaculada Conceição)', national],
    [12, 25, 'Christmas Day (Natal)', national],
  ],
};

const key = (month: number, day: number) => `${month}-${day}`;
const expected = holidays[2026].filter(([, , , kind]) => kind === national);
const excluded = holidays[2026].filter(([, , , kind]) => kind !== national);
const wanted = new Set(expected.map(([month, day]) => key(month, day)));
const decoys = new Set(
  [...excluded, ...holidays[2025]]
    .map(([month, day]) => key(month, day))
    .filter((item) => !wanted.has(item)),
);
const label = ([month, day]: Holiday) =>
  new Date(Date.UTC(2026, month - 1, day)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });

const monthNames: Array<[RegExp, number]> = [
  [/^jan(?:uary|eiro)?$/i, 1],
  [/^(?:feb(?:ruary)?|fev(?:ereiro)?)$/i, 2],
  [/^mar(?:ch|[çc]o)?$/i, 3],
  [/^(?:apr(?:il)?|abr(?:il)?)$/i, 4],
  [/^(?:may|mai(?:o)?)$/i, 5],
  [/^jun(?:e|ho)?$/i, 6],
  [/^jul(?:y|ho)?$/i, 7],
  [/^(?:aug(?:ust)?|ago(?:sto)?)$/i, 8],
  [/^(?:sep(?:t(?:ember)?)?|set(?:embro)?)$/i, 9],
  [/^(?:oct(?:ober)?|out(?:ubro)?)$/i, 10],
  [/^nov(?:ember|embro)?$/i, 11],
  [/^(?:dec(?:ember)?|dez(?:embro)?)$/i, 12],
];
const monthOf = (word: string) =>
  monthNames.find(([pattern]) => pattern.test(word.replace(/\.$/, '')))?.[1];

function datesIn(cell: string) {
  const readings: Array<string[]> = [];
  const valid = (month: number, day: number) => month >= 1 && month <= 12 && day >= 1 && day <= 31;
  let rest = cell;
  for (const match of cell.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g)) {
    if (valid(+match[2], +match[3])) readings.push([key(+match[2], +match[3])]);
    rest = rest.replace(match[0], ' ');
  }
  for (const match of rest.matchAll(/\b(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2}|\d{4}))?\b/g)) {
    const [a, b] = [+match[1], +match[2]];
    const options = [
      ...(valid(b, a) ? [key(b, a)] : []),
      ...(valid(a, b) && a !== b ? [key(a, b)] : []),
    ];
    if (options.length) readings.push(options);
  }
  const named = [
    { pattern: /\b(\d{1,2})(?:st|nd|rd|th|º)?(?:\s+de)?[\s-]+([a-zç]+\.?)/gi, day: 1, month: 2 },
    { pattern: /\b([a-zç]+\.?)[\s-]+(\d{1,2})(?:st|nd|rd|th)?\b/gi, day: 2, month: 1 },
  ];
  for (const order of named)
    for (const match of rest.matchAll(order.pattern)) {
      const month = monthOf(match[order.month]);
      const day = Number(match[order.day]);
      if (month && valid(month, day)) readings.push([key(month, day)]);
    }
  return readings;
}

function verdict(run: Run) {
  return (run.apps?.sheets?.books ?? []).flatMap((book) =>
    book.tabs.map((tab) => {
      const readings = tab.rows.flatMap((row) => row.flatMap(datesIn));
      const found = new Set(readings.flat());
      const missing = expected.filter(([month, day]) => !found.has(key(month, day)));
      const extra = readings.filter((options) => !options.some((option) => wanted.has(option)));
      const wrong = extra.filter((options) => options.some((option) => decoys.has(option)));
      return { title: `${book.title} / ${tab.name}`, missing, extra, wrong };
    }),
  );
}
const shown = (readings: string[][]) =>
  readings.map((options) => options.join(' or ')).join(', ') || 'none';

const cityPortal: Site = ({ url }) => {
  const header =
    '<header><h1>Lisboa</h1><p>City of Lisbon</p><nav><a href="/">Home</a> <a href="/en/living-in-lisbon">Living in Lisbon</a> <a href="/en/public-holidays">Public holidays</a> <a href="/en/events">Events</a></nav></header>';
  const footer = '<footer><p>Câmara Municipal de Lisboa · Praça do Município</p></footer>';
  const table = (year: number) =>
    `<table><tr><th>Date</th><th>Weekday</th><th>Holiday</th><th>Type</th></tr>${holidays[year]
      .map(([month, day, name, kind]) => {
        const at = new Date(Date.UTC(year, month - 1, day));
        const date = at.toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        });
        const weekday = at.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
        return `<tr><td>${date}</td><td>${weekday}</td><td>${name}</td><td>${kind}</td></tr>`;
      })
      .join('')}</table>`;
  const yearPage = (year: number, others: number[]) =>
    page(
      `Public holidays ${year} · Lisboa`,
      `${header}<main><article><h2>Public holidays in Lisbon, ${year}</h2><p>National public holidays apply across Portugal: shops may open, but public services, schools and most offices close. Municipal holidays apply only in the municipality that sets them. Carnival is not a public holiday; the government may give public employees the day off.</p>${table(year)}<p>Other years: ${others.map((other) => `<a href="/en/public-holidays/${other}">${other}</a>`).join(', ')}.</p></article></main>${footer}`,
    );
  const path = url.pathname.replace(/\/$/, '') || '/';
  if (path === '/')
    return page(
      'Lisboa · City of Lisbon',
      `${header}<main><h2>Welcome to Lisbon</h2><p>News and services from the City of Lisbon for residents, businesses and visitors.</p><p><a href="/en/public-holidays"><b>Public holidays 2026</b></a>: the national and municipal holidays, which ones are only local, and what closes on each day.</p><p><a href="/en/events"><b>Events this month</b></a>: concerts, markets and festivals across the city's neighbourhoods.</p><p><a href="/en/living-in-lisbon"><b>Living in Lisbon</b></a>: registering as a resident, waste collection days, parking permits and more.</p></main>${footer}`,
    );
  if (path === '/en/public-holidays' || path === '/en/public-holidays/2026')
    return yearPage(2026, [2025]);
  if (path === '/en/public-holidays/2025') return yearPage(2025, [2026]);
  if (path === '/en/events' || path === '/en/living-in-lisbon')
    return page(
      'Lisboa',
      `${header}<main><p>This section is being updated. Please come back soon.</p></main>${footer}`,
    );
  return page('Not found · Lisboa', `${header}<p>Page not found.</p>`, 404);
};

export default scenario({
  id: 'table-to-sheet',
  title:
    'Put the 2026 national public holidays from lisboa-cidade.example.org into a new Google Sheet',
  capabilities: ['research', 'browser', 'apps'],
  tier: 'release',
  calibration: 'pending',
  stance: 'regression',
  complexity: 'medium',
  seconds: 600,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. You want a simple sheet of the 2026 national public holidays in Portugal for planning. Any title and any columns are fine as long as each holiday has its date.',
  },
  world(clock) {
    return {
      apps: createApps(owner, { sheets: sheets([], clock.now) }),
      sites: { [host]: cityPortal },
    };
  },
  async play(session) {
    await session.say(
      `Put the 2026 national public holidays from ${host} into a new Google Sheet.`,
    );
  },
  evidence(run) {
    return [
      `The 2026 table on ${host}/en/public-holidays has 15 rows: 13 national holidays (${expected.map(label).join(', ')}), plus ${excluded.map((item) => `${label(item)} ${item[2]} (${item[3]})`).join(' and ')}, which are not national holidays. A separate 2025 page has different dates for Good Friday, Easter and Corpus Christi.`,
      `Sheets after the run:\n${dumpSheets(run)}`,
    ].join('\n');
  },
  expect() {
    return [
      check(
        'sheet-has-every-national-holiday',
        (run) => {
          const results = verdict(run);
          const complete = results.find((result) => !result.missing.length);
          return {
            pass: Boolean(complete),
            evidence: !results.length
              ? 'no spreadsheet was created'
              : results
                  .map(
                    (result) =>
                      `"${result.title}": missing ${result.missing.map(label).join(', ') || 'none'}`,
                  )
                  .join('; '),
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'no-municipal-optional-or-2025-dates',
        (run) => {
          const results = verdict(run).filter((result) => !result.missing.length);
          return {
            pass: results.some((result) => !result.wrong.length),
            evidence: results.length
              ? results
                  .map((result) => `"${result.title}": wrong dates ${shown(result.wrong)}`)
                  .join('; ')
              : 'no complete holiday sheet',
          };
        },
        { required: false, failure: 'reasoning' },
      ),
      judge(
        'only-2026-national-holidays-presented',
        "The sheet presents only the 2026 national holidays as national holidays. Listing Carnival (17 February 2026), St Anthony's Day (13 June 2026) or 2025 dates is fine only if they are clearly marked as not national (for example optional, municipal, excluded, or in a separate notes section or tab); it fails if any of them is presented as a 2026 national holiday, or if a 2025 date is given for a 2026 holiday.",
        { failure: 'reasoning' },
      ),
      check(
        'only-national-holiday-dates',
        (run) => {
          const results = verdict(run).filter((result) => !result.missing.length);
          return {
            pass: results.some((result) => !result.extra.length),
            evidence: results.length
              ? results
                  .map((result) => `"${result.title}": other dates ${shown(result.extra)}`)
                  .join('; ')
              : 'no complete holiday sheet',
          };
        },
        { required: false, failure: 'scope' },
      ),
      check(
        'one-new-spreadsheet',
        (run) => {
          const count = run.apps?.sheets?.books.length ?? 0;
          return { pass: count === 1, evidence: `${count} spreadsheets` };
        },
        { required: false, failure: 'scope' },
      ),
    ];
  },
});
