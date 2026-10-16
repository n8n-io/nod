import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { page, type Site } from '../world/sites.ts';
import { daysAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const host = 'acme-blog.example.com';

interface Post {
  slug: string;
  title: string;
  days: number;
  token: RegExp;
  pinned?: boolean;
  summary: string;
  body: string;
}

const posts: Post[] = [
  {
    slug: 'acme-partners-with-helios-freight',
    title: 'Acme partners with Helios Freight for same-day delivery in Iberia',
    days: 30,
    token: /\bhelios\b/i,
    pinned: true,
    summary:
      'Our biggest partnership yet brings same-day delivery to 14 cities in Spain and Portugal.',
    body: 'Acme and Helios Freight have signed a five-year partnership. From next spring, Acme customers in 14 cities across Spain and Portugal can offer same-day delivery at checkout, with Helios handling the last mile.',
  },
  {
    slug: 'introducing-orbit',
    title: 'Introducing Orbit, our self-serve analytics dashboard',
    days: 1,
    token: /\borbit\b/i,
    summary:
      'Orbit puts every order, return and delivery metric in one dashboard, available today.',
    body: 'Today we are launching Orbit, a self-serve analytics dashboard for every Acme customer on the Business plan. Orbit shows orders, returns and delivery times in one place, with daily email reports and CSV export. It is included in the Business plan at no extra cost and rolls out to all accounts this week.',
  },
  {
    slug: 'acme-opens-porto-office',
    title: 'Acme opens a new engineering office in Porto',
    days: 5,
    token: /\bporto\b/i,
    summary: 'Our second office in Portugal opens in January with 40 engineering roles.',
    body: 'Acme is opening a new engineering office in Porto, our second in Portugal after Lisbon. The office opens in January and we are hiring for 40 engineering roles across payments, logistics and data. Applications are open on our careers page.',
  },
  {
    slug: 'acme-acquires-kestrel-labs',
    title: 'Acme acquires Kestrel Labs',
    days: 9,
    token: /\bkestrel\b/i,
    summary: 'The route-optimisation start-up joins Acme to make deliveries faster and cheaper.',
    body: 'Acme has acquired Kestrel Labs, the route-optimisation start-up based in Valencia. The Kestrel team of 12 joins our logistics group, and its routing engine will power Acme deliveries from next year. Terms were not disclosed.',
  },
  {
    slug: 'two-factor-for-every-account',
    title: 'Two-factor sign-in now required for every account',
    days: 45,
    token: /\btwo-factor\b/i,
    summary: 'From today every Acme account must use two-factor sign-in.',
    body: 'To keep accounts safe, two-factor sign-in is now required for every Acme account. You can use an authenticator app or a security key.',
  },
];

const dated = (at: number) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Madrid',
  }).format(at);

function acmeBlog(entries: Array<Post & { date: string }>): Site {
  const ordered = [
    ...entries.filter((post) => post.pinned),
    ...entries.filter((post) => !post.pinned).sort((a, b) => a.days - b.days),
  ];
  return ({ url }) => {
    const header =
      '<header><h1>Acme Blog</h1><nav><a href="/">All posts</a> <a href="/about">About Acme</a></nav></header>';
    if (url.pathname === '/' || url.pathname === '/blog')
      return page(
        'Acme Blog · News and announcements',
        `${header}<main><h2>News and announcements</h2>${ordered
          .map(
            (post) =>
              `<p>${post.pinned ? '<b>Featured</b> · ' : ''}<time>${post.date}</time><br><a href="/posts/${post.slug}"><b>${post.title}</b></a><br>${post.summary}</p>`,
          )
          .join('')}</main>`,
      );
    const post = entries.find((item) => url.pathname === `/posts/${item.slug}`);
    if (post)
      return page(
        `${post.title} · Acme Blog`,
        `${header}<main><article><h2>${post.title}</h2><p><time>${post.date}</time> · Acme Newsroom</p><p>${post.body}</p><p>Questions? Write to press@acme.example.com.</p><p><a href="/">Back to all posts</a></p></article></main>`,
      );
    if (url.pathname === '/about')
      return page(
        'About Acme',
        `${header}<main><p>Acme builds checkout and delivery software for online shops in Europe.</p></main>`,
      );
    return page('Not found · Acme Blog', `${header}<p>Page not found.</p>`, 404);
  };
}

export default scenario({
  id: 'news-this-week-only',
  title: 'What has Acme announced in the last 7 days?',
  capabilities: ['research', 'browser'],
  tier: 'release',
  calibration: 'pending',
  stance: 'regression',
  complexity: 'simple',
  seconds: 420,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. Acme is a supplier of yours and you want a quick update on what they announced in the last 7 days. A short list is enough.',
  },
  world(clock) {
    const entries = posts.map((post) => ({
      ...post,
      date: dated(daysAgo(clock.now(), post.days)),
    }));
    return { apps: createApps(owner, {}), sites: { [host]: acmeBlog(entries) }, entries };
  },
  async play(session) {
    await session.say(`What has Acme announced in the last 7 days? Their blog is ${host}`);
  },
  evidence(_run, world) {
    return [
      'Posts on the Acme blog, with their dates:',
      ...world.entries.map(
        (post) =>
          `- ${post.date} (${post.days} day${post.days === 1 ? '' : 's'} ago)${post.pinned ? ', pinned as Featured at the top of the list' : ''}: ${post.title}`,
      ),
      'Only the Orbit launch and the Porto office were announced in the last 7 days. The Kestrel Labs acquisition (9 days ago), the Helios Freight partnership (30 days ago, pinned at the top) and the two-factor sign-in post (45 days ago) are older.',
    ].join('\n');
  },
  expect(world) {
    const recent = world.entries.filter((post) => post.days <= 7);
    const older = world.entries.filter((post) => post.days > 7);
    return [
      check(
        'names-both-recent-announcements',
        (run) => {
          const missing = recent.filter((post) => !post.token.test(run.said));
          return {
            pass: !missing.length,
            evidence: missing.length
              ? `missing: ${missing.map((post) => post.title).join('; ')}`
              : undefined,
          };
        },
        {
          failure: 'incomplete',
          otherwise:
            "The answer presents both of Acme's announcements from the last 7 days, the Orbit self-serve analytics dashboard launch and the new engineering office in Porto, in any wording.",
        },
      ),
      judge(
        'only-the-last-7-days',
        `The final answer presents only the Orbit launch (${recent[0].date}) and the new Porto office (${recent[1].date}) as Acme's announcements from the last 7 days. It fails if it presents the Kestrel Labs acquisition (${older.find((post) => post.slug.includes('kestrel'))!.date}), the Helios Freight partnership (${older.find((post) => post.slug.includes('helios'))!.date}, pinned at the top of the blog) or the two-factor sign-in post as announced in the last 7 days. Mentioning older posts explicitly as older or outside the window is fine.`,
        { failure: 'reasoning' },
      ),
      check(
        'older-posts-not-mentioned',
        (run) => {
          const found = older.filter((post) => post.token.test(run.final));
          return {
            pass: !found.length,
            evidence: found.length
              ? `mentions: ${found.map((post) => post.title).join('; ')}`
              : undefined,
          };
        },
        { required: false, failure: 'scope' },
      ),
    ];
  },
});
