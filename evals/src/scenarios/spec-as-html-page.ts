import { check, judge, scenario } from '../scenario.ts';
import { pageText } from '../html.ts';
import type { Run } from '../trace.ts';

const notes = [
  'Feature: two-step sign-in for workspace admins. Owner: Dana Okafor. Status: in review.',
  'Why: 3 admin account takeovers last quarter, all from reused passwords. 412 admin accounts today.',
  'Goals: every admin sign-in needs a second step; recovery takes under 5 minutes.',
  'Not doing: second step for members, hardware keys.',
  'Measures: 95% of admins enrolled; 0 takeovers a quarter.',
  'Rollout: internal admins 1 March, opt-in customers 15 March, all admins 5 April.',
  'Still open: do service accounts count as admins?',
].join('\n');

async function pages(run: Run) {
  const found: Array<{ path: string; html: string }> = [];
  for (const call of run.tools) {
    if (call.name !== 'share_file' || call.isError) continue;
    const path = String(call.input?.path ?? '').replace(/^(\.\/)+/, '');
    if (!/\.html?$/i.test(path)) continue;
    const file = run.files.find((item) => item === path || item.endsWith(`/${path}`));
    const html = file ? await run.text(file) : '';
    if (html) found.push({ path, html });
  }
  return found;
}

const defects: Array<[string, RegExp]> = [
  ['loads a stylesheet or font', /<link\b|@import|url\(\s*["']?(?:https?:)?\/\//i],
  ['loads a script', /<script[^>]+\bsrc\s*=/i],
  [
    'loads media from the network',
    /<(?:img|video|audio|source|object|embed)[^>]+\b(?:src|data)\s*=\s*["']?(?:https?:)?\/\//i,
  ],
  ['embeds a frame', /<iframe\b/i],
  ['has a form', /<form\b/i],
  ['links within the page', /<a[^>]+\bhref\s*=\s*["']?#/i],
  ['links to a website', /<a[^>]+\bhref\s*=\s*["']?(?:https?:)?\/\//i],
  ['navigates', /\blocation\s*(?:=|\.\s*(?:href|assign|replace|reload)\b)|window\.open\s*\(/],
  ['uses browser storage', /localStorage|sessionStorage|document\.cookie/],
  ['calls the network', /\bfetch\s*\(|XMLHttpRequest|WebSocket/],
];

export default scenario({
  id: 'spec-as-html-page',
  title: 'Turn notes into a specification page that opens in the file preview',
  capabilities: ['files'],
  tier: 'full',
  complexity: 'simple',
  stance: 'regression',
  calibration: 'pending',
  seconds: 420,
  user: { approve: false },
  world() {
    return {};
  },
  async play(session) {
    await session.say(
      `Turn these notes into a spec page I can open here and walk the team through.\n\n${notes}`,
    );
  },
  expect() {
    return [
      check(
        'shares-one-html-page',
        async (run) => {
          const found = await pages(run);
          return {
            pass: found.length === 1,
            evidence: found.map((page) => page.path).join(', ') || 'no HTML file was shared',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'page-works-in-the-preview',
        async (run) => {
          const found = await pages(run);
          const hits = found.flatMap((page) =>
            defects.filter(([, pattern]) => pattern.test(page.html)).map(([name]) => name),
          );
          return {
            pass: found.length > 0 && !hits.length,
            evidence: hits.join(', ') || (found.length ? 'no defect found' : 'no HTML file'),
          };
        },
        { failure: 'format' },
      ),
      check(
        'page-has-dark-theme',
        async (run) => {
          const found = await pages(run);
          return {
            pass: found.some((page) => /prefers-color-scheme\s*:\s*dark/.test(page.html)),
            evidence: found.length ? 'checked for a dark theme rule' : 'no HTML file',
          };
        },
        { failure: 'format' },
      ),
      check(
        'page-keeps-the-facts',
        async (run) => {
          const text = (await pages(run)).map((page) => pageText(page.html)).join('\n');
          const wanted: Array<[string, RegExp]> = [
            ['Dana Okafor', /dana okafor/i],
            ['412', /\b412\b/],
            ['95%', /\b95\s?%/],
            ['1 March', /\b0?1(?:st)? mar|\bmar\w* 0?1\b/i],
            ['15 March', /\b15(?:th)? mar|\bmar\w* 15\b/i],
            ['5 April', /\b0?5(?:th)? apr|\bapr\w* 0?5\b/i],
            ['service accounts', /service accounts/i],
          ];
          const missing = wanted.filter(([, pattern]) => !pattern.test(text)).map(([fact]) => fact);
          return {
            pass: Boolean(text) && !missing.length,
            evidence: missing.length ? `Missing: ${missing.join(', ')}` : 'all facts present',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'rollout-dates-get-no-year',
        async (run) => {
          const years = (await pages(run)).flatMap(
            (page) =>
              pageText(page.html).match(
                /\b(?:mar|apr)[a-z]*\.?,?\s+20\d\d\b|\b20\d\d-0[34]-\d\d\b/gi,
              ) ?? [],
          );
          return { pass: !years.length, evidence: years.join(', ') || 'no year on a rollout date' };
        },
        { failure: 'hallucination' },
      ),
      check(
        'message-is-short',
        (run) => {
          const words = run.final.split(/\s+/).filter(Boolean).length;
          return { pass: words > 0 && words <= 120, evidence: `${words} words` };
        },
        { failure: 'format' },
      ),
      judge(
        'message-points-to-the-page',
        'The assistant message that delivers the file says in a sentence or two what the page is and does not repeat the specification in chat, announce future work or claim to have seen the rendered page.',
        { aspect: 'process', failure: 'format' },
      ),
    ];
  },
  evidence() {
    return `The owner supplied these notes and asked for a specification page to open in Nod and present to the team: ${notes} Nothing else is known. A number, date, name or quotation that is not in the notes is invented. Whether service accounts count as admins is an open question, not a decision. No account is connected.`;
  },
});
