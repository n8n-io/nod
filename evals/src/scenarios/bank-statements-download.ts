import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { pdf, pdfText } from '../world/pdf.ts';
import { escapeHtml, file, page, redirect, type Site } from '../world/sites.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const bankHost = 'online.caixaverde.example.org';
const taxHost = 'portal.financas-gov.example.net';
const bank = { username: owner.email, password: 'Caixa-Verde-72!' };
const tax = { username: '234567890', password: 'Portal-Fisc-55!' };
const months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const portugueseMonths = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

interface State {
  year: number;
  bankDownloads: string[];
  taxDownloads: string[];
}

function statement(month: number, year: number) {
  return pdf([
    `Caixa Verde - Account statement ${months[month]} ${year}`,
    'Account ending 4471    Holder: Alex Rivera',
    `Opening balance: EUR ${(2100 + month * 37).toFixed(2)}`,
    `${year}-${String(month + 1).padStart(2, '0')}-03  Salary / client payment      +EUR 2,450.00`,
    `${year}-${String(month + 1).padStart(2, '0')}-09  Rent                         -EUR 980.00`,
    `${year}-${String(month + 1).padStart(2, '0')}-17  Groceries                    -EUR 143.20`,
    `Closing balance: EUR ${(2100 + month * 37 + 1326.8).toFixed(2)}`,
  ]);
}

function bankSite(state: State): Site {
  return (context) => {
    const session = context.session(() => ({ auth: false }));
    const { url, form, request } = context;
    if (url.pathname === '/login' && request.method === 'POST') {
      if (form.get('email') === bank.username && form.get('password') === bank.password) {
        session.data.auth = true;
        return redirect('/statements');
      }
      return page('Sign in', '<p class="error">Incorrect details.</p>', 401);
    }
    if (url.pathname === '/login' || url.pathname === '/')
      return page(
        'Caixa Verde online banking',
        '<h1>Caixa Verde</h1><form method="post" action="/login"><label>Email<input type="email" name="email" autocomplete="username"></label><label>Password<input type="password" name="password" autocomplete="current-password"></label><button>Sign in</button></form>',
      );
    if (!session.data.auth) return redirect('/login');
    const download = /^\/statements\/(\d{4})-(\d{2})\.pdf$/.exec(url.pathname);
    if (download) {
      state.bankDownloads.push(`${download[1]}-${download[2]}`);
      return file(
        `extrato_${download[1]}${download[2]}.pdf`,
        statement(Number(download[2]) - 1, Number(download[1])),
        'application/pdf',
      );
    }
    if (url.pathname === '/statements') {
      const rows = Array.from({ length: 12 }, (_, index) => 11 - index)
        .map(
          (month) =>
            `<tr><td>${months[month]} ${state.year}</td><td><a href="/statements/${state.year}-${String(month + 1).padStart(2, '0')}.pdf">Download PDF</a></td></tr>`,
        )
        .join('');
      return page(
        'Statements · Caixa Verde',
        `<h1>Caixa Verde</h1><h2>Account statements</h2><table><tr><th>Period</th><th></th></tr>${rows}</table>`,
      );
    }
    return page('Not found', '<p>Not found.</p>', 404);
  };
}

function taxSite(state: State): Site {
  return (context) => {
    const session = context.session(() => ({ auth: false }));
    const { url, form, request } = context;
    if (url.pathname === '/login' && request.method === 'POST') {
      if (form.get('nif') === tax.username && form.get('password') === tax.password) {
        session.data.auth = true;
        return redirect('/assessments');
      }
      return page('Sign in', '<p class="error">Incorrect details.</p>', 401);
    }
    if (url.pathname === '/login' || url.pathname === '/')
      return page(
        'Tax portal',
        '<h1>Tax portal</h1><form method="post" action="/login"><label>Tax number<input name="nif" autocomplete="username"></label><label>Password<input type="password" name="password" autocomplete="current-password"></label><button>Sign in</button></form>',
      );
    if (!session.data.auth) return redirect('/login');
    const download = /^\/assessments\/(\d{4})\.pdf$/.exec(url.pathname);
    if (download) {
      state.taxDownloads.push(download[1]);
      return file(
        `notificacao_liquidacao_${download[1]}.pdf`,
        pdf([
          `Income tax assessment notice ${download[1]}`,
          'Taxpayer: Alex Rivera',
          `Tax year: ${download[1]}`,
          'Tax due: EUR 3,184.60',
          'Withheld at source: EUR 2,950.00',
          'Balance to pay: EUR 234.60',
        ]),
        'application/pdf',
      );
    }
    if (url.pathname === '/assessments') {
      const rows = [state.year - 1, state.year - 2, state.year - 3]
        .map(
          (year) =>
            `<tr><td>Income tax ${year}</td><td><a href="/assessments/${year}.pdf">Assessment notice (PDF)</a></td></tr>`,
        )
        .join('');
      return page(
        'Assessments',
        `<h1>Tax portal</h1><h2>${escapeHtml('Your assessments')}</h2><table>${rows}</table>`,
      );
    }
    return page('Not found', '<p>Not found.</p>', 404);
  };
}

export default scenario({
  id: 'bank-statements-download',
  title: "Download bank statements and last year's tax assessment into a folder",
  linear: 'LAB-392',
  capabilities: ['files', 'vault', 'browser'],
  tier: 'full',
  complexity: 'complex',
  stance: 'regression',
  seconds: 1500,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. Both logins are saved in the vault. Your "Taxes 2026" folder is a folder in the assistant\'s own workspace; if asked where it is, say so. Clear, readable file names are all you care about.',
  },
  world(clock) {
    const state: State = {
      year: new Date(clock.now()).getFullYear(),
      bankDownloads: [],
      taxDownloads: [],
    };
    return {
      apps: createApps(owner, {}),
      sites: { [bankHost]: bankSite(state), [taxHost]: taxSite(state) },
      logins: [
        { label: 'Caixa Verde', origin: `https://${bankHost}`, ...bank },
        {
          label: 'Tax portal',
          origin: `https://${taxHost}`,
          username: tax.username,
          password: tax.password,
        },
      ],
      state,
    };
  },
  async play(session, world) {
    await session.say(
      `Download my bank statements for July to September ${world.state.year} from Caixa Verde (online.caixaverde.example.org) and ${world.state.year - 1}'s tax assessment from the tax portal (portal.financas-gov.example.net), and put them in my "Taxes ${world.state.year}" folder with clear names.`,
    );
  },
  evidence(run, world) {
    return `Files under the workspace: ${run.files.join('; ') || 'none'}.\nStatements the bank served: ${world.state.bankDownloads.join(', ') || 'none'}. Assessments the portal served: ${world.state.taxDownloads.join(', ') || 'none'}.`;
  },
  expect(world) {
    const { year } = world.state;
    const folder = (run: { files: string[] }) =>
      run.files.filter((path) => path.includes(`/Taxes ${year}/`));
    return [
      check(
        'folder-holds-exactly-the-four-documents',
        (run) => {
          const files = folder(run);
          return {
            pass: files.length === 4,
            evidence: `${files.length} files: ${files.map((path) => path.split('/').pop()).join(', ')}`,
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'statements-are-the-right-months-and-named-clearly',
        async (run) => {
          const files = folder(run);
          const wrong: string[] = [];
          for (const [index, month] of [6, 7, 8].entries()) {
            let found = false;
            for (const path of files) {
              const text = pdfText((await run.read(path)) ?? Buffer.alloc(0));
              if (text.includes(`Caixa Verde - Account statement ${months[month]} ${year}`)) {
                const name = path.split('/').pop()!.toLowerCase();
                const tokens = [
                  months[month].toLowerCase(),
                  months[month].slice(0, 3).toLowerCase(),
                  portugueseMonths[month],
                  portugueseMonths[month].slice(0, 3),
                ];
                if (
                  tokens.some((token) => name.includes(token)) ||
                  new RegExp(`(^|[^0-9])0?${month + 1}([^0-9]|$)`).test(
                    name.replace(String(year), ''),
                  )
                )
                  found = true;
              }
            }
            if (!found) wrong.push(months[month]);
            void index;
          }
          return {
            pass: !wrong.length,
            evidence: wrong.length ? `missing or unclear: ${wrong.join(', ')}` : undefined,
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'assessment-is-last-years-and-named-clearly',
        async (run) => {
          for (const path of folder(run)) {
            const text = pdfText((await run.read(path)) ?? Buffer.alloc(0));
            if (text.includes(`Tax year: ${year - 1}`))
              return {
                pass: path
                  .split('/')
                  .pop()!
                  .includes(String(year - 1)),
                evidence: path.split('/').pop(),
              };
          }
          return { pass: false, evidence: 'no assessment for the right year' };
        },
        { failure: 'reasoning' },
      ),
      check(
        'did-not-download-other-months',
        () => ({
          pass: world.state.bankDownloads.every((value) =>
            ['07', '08', '09'].includes(value.split('-')[1]),
          ),
          evidence: `downloaded ${world.state.bankDownloads.join(', ')}`,
        }),
        { failure: 'scope' },
      ),
      judge(
        'file-names-say-what-each-document-is',
        `The four file names in the "Taxes ${year}" folder let someone who has not opened them tell what each document is: each of the three bank statements is identifiable by the month it covers, and the tax assessment is identifiable as the tax assessment (or tax return or IRS notice) for ${year - 1}. Any language, order, separator or capitalisation is fine. Generic names such as "download.pdf" or "document (1).pdf" fail.`,
        { failure: 'reasoning' },
      ),
      judge(
        'final-answer-says-what-is-where',
        `Across the messages the user saw, the assistant tells the user what is in the "Taxes ${year}" folder: the three monthly bank statements (July, August, September ${year}) and the tax assessment for ${year - 1}, each identified by file name or by a clear description. Any wording, order, format or level of brevity is fine as long as all four documents are accounted for. It must not claim a file that is not in the folder or place a file somewhere other than where it is.`,
        { aspect: 'process', failure: 'hallucination' },
      ),
    ];
  },
});
