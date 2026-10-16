import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { page, type Site } from '../world/sites.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const museum = 'museuribeira.example.org';
const blog = 'lisbon-wanderer.example.net';
const guide = '/2024/05/lisbon-museums-guide';

const official: Site = ({ url }) => {
  const header =
    '<header><h1>Museu da Ribeira</h1><nav><a href="/">Home</a> <a href="/visit">Plan your visit</a> <a href="/exhibitions">Exhibitions</a> <a href="/news">News</a></nav></header>';
  const footer =
    '<footer><p>Museu da Ribeira · Cais da Ribeira 12, 1100-001 Lisboa · Official website</p></footer>';
  if (url.pathname === '/')
    return page(
      'Museu da Ribeira · Official website',
      `${header}<main><h2>Lisbon's river museum</h2><p>Five centuries of life on the Tagus: boats, trade, fishing and the people of the riverside, in a restored 19th-century warehouse on the Ribeira quay.</p><p><b>New opening days:</b> since 2 March 2026 the museum is open on Mondays and closed on Tuesdays. See <a href="/visit">Plan your visit</a> for opening hours and tickets.</p><p>Now showing: <a href="/exhibitions">Salt and Sail</a>, until 10 January 2027.</p></main>${footer}`,
    );
  if (url.pathname === '/visit')
    return page(
      'Plan your visit · Museu da Ribeira',
      `${header}<main><article><h2>Plan your visit</h2><h3>Opening hours</h3><table><tr><th>Day</th><th>Museum and exhibitions</th></tr><tr><td>Monday</td><td>10:00-18:00</td></tr><tr><td>Tuesday</td><td>Closed</td></tr><tr><td>Wednesday</td><td>10:00-18:00</td></tr><tr><td>Thursday</td><td>10:00-18:00</td></tr><tr><td>Friday</td><td>10:00-20:00</td></tr><tr><td>Saturday</td><td>10:00-18:00</td></tr><tr><td>Sunday</td><td>10:00-18:00</td></tr></table><p>Last entry 30 minutes before closing. The museum is closed on 1 January, Easter Sunday, 1 May and 25 December.</p><p>The library and reading room are open Wednesday to Friday, 14:00-18:00, by appointment.</p><h3>Tickets</h3><p>Adults €8, students and over-65s €5, children under 12 free. Free admission on the first Sunday of every month.</p><p>Opening days changed on 2 March 2026: the museum now opens on Mondays and closes on Tuesdays. Guides published before that date may show the old days.</p></article></main>${footer}`,
    );
  if (url.pathname === '/news')
    return page(
      'News · Museu da Ribeira',
      `${header}<main><article><h2>News</h2><h3>New opening days from 2 March 2026</h3><p>Published 9 February 2026. From Monday 2 March 2026 the Museu da Ribeira will open on Mondays, 10:00-18:00, and close on Tuesdays instead. Many Lisbon museums close on Mondays, so we are opening on the day visitors most often find doors shut.</p><h3>Salt and Sail opens</h3><p>Published 14 September 2026. Our new temporary exhibition on the salt trade of the Tagus estuary runs until 10 January 2027.</p></article></main>${footer}`,
    );
  if (url.pathname === '/exhibitions')
    return page(
      'Exhibitions · Museu da Ribeira',
      `${header}<main><article><h2>Exhibitions</h2><p><b>Salt and Sail</b>, until 10 January 2027: the salt pans and cargo boats of the Tagus estuary.</p><p><b>The Ribeira quay</b>, permanent: from the 16th-century fish market to the container port.</p></article></main>${footer}`,
    );
  return page('Not found · Museu da Ribeira', `${header}<p>Page not found.</p>`, 404);
};

const wanderer: Site = ({ url }) => {
  const header =
    '<header><h1>Lisbon Wanderer</h1><p>Slow travel tips from a Lisbon local</p><nav><a href="/">Home</a> <a href="/about">About</a></nav></header>';
  if (url.pathname === '/')
    return page(
      'Lisbon Wanderer · Travel blog',
      `${header}<main><h2>Latest posts</h2><p><a href="${guide}"><b>The ultimate guide to Lisbon's museums</b></a> (14 May 2024). My pick of the city's museums, from tiles to trams to the river, with opening days, ticket prices and the best time to go to each one.</p><p><a href="/2024/03/best-pasteis-de-nata"><b>Where to eat the best pastéis de nata</b></a> (2 March 2024). Eleven bakeries, one afternoon, and a very honest ranking of the custard tarts that are worth the queue.</p><p><a href="/2023/11/tram-28-tips"><b>Tram 28 without the queues</b></a> (20 November 2023). Where to board, when to go and which stops are worth getting off at on Lisbon's most famous tram line.</p></main>`,
    );
  if (url.pathname === guide)
    return page(
      "The ultimate guide to Lisbon's museums · Lisbon Wanderer",
      `${header}<main><article><h2>The ultimate guide to Lisbon's museums</h2><p><i>Published 14 May 2024 by Inês, Lisbon Wanderer</i></p><p>Lisbon is packed with museums, and most of them share one rule you should plan around: they close on Mondays. Here is my pick of the ones worth your time, with the practical details I wish someone had told me.</p><h3>Museu da Ribeira</h3><p>My favourite rainy-day museum: boats, maps and the story of the riverside, in an old warehouse on the quay. <b>Closed on Mondays</b>, like most museums in the city. Open Tuesday to Sunday, 10:00-18:00. Tickets €7. Go early on a Tuesday to have the boat hall to yourself.</p><h3>Casa dos Azulejos Antigos</h3><p>Five floors of tiles from the 15th century to today. Closed Mondays. Open Tuesday to Sunday, 10:00-17:30.</p><h3>Museu do Bonde</h3><p>Old trams you can climb into. Open daily, 10:00-17:00, including Mondays.</p><p>Opening times change, so treat this as a starting point.</p></article></main>`,
    );
  if (url.pathname === '/about')
    return page(
      'About · Lisbon Wanderer',
      `${header}<main><p>I'm Inês, born and raised in Lisbon. I write about the city at my own pace.</p></main>`,
    );
  return page('Not found · Lisbon Wanderer', `${header}<p>Page not found.</p>`, 404);
};

export default scenario({
  id: 'conflicting-sources',
  title: 'Is the Museu da Ribeira open on Mondays?',
  capabilities: ['research', 'browser'],
  tier: 'release',
  calibration: 'pending',
  stance: 'regression',
  complexity: 'simple',
  seconds: 420,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. You want to visit the Museu da Ribeira in Lisbon on a Monday and just want to know whether it is open. A short answer is enough.',
  },
  world() {
    return { apps: createApps(owner, {}), sites: { [museum]: official, [blog]: wanderer } };
  },
  async play(session) {
    await session.say(
      `Is the Museu da Ribeira open on Mondays? Check ${museum} and the guide at ${blog}.`,
    );
  },
  evidence(run) {
    const opened = (host: string) =>
      [
        ...new Set(run.visits.filter((visit) => visit.host === host).map((visit) => visit.path)),
      ].join(', ') || 'none';
    return [
      `Ground truth: the official museum website (${museum}) says the museum has been open on Mondays (10:00-18:00) and closed on Tuesdays since 2 March 2026; its home page, its "Plan your visit" page and a news post dated 9 February 2026 all say so, and the visit page warns that older guides may show the old days. Only the library and reading room are closed on Mondays (open Wednesday to Friday).`,
      `The travel blog (${blog}), in a guide published 14 May 2024, says the museum is closed on Mondays and open Tuesday to Sunday. That was the old schedule; the blog is out of date.`,
      `Pages opened on the official site: ${opened(museum)}. Pages opened on the blog: ${opened(blog)}.`,
    ].join('\n');
  },
  expect() {
    return [
      check(
        'checked-both-sources',
        (run) => {
          const hosts = new Set(run.visits.map((visit) => visit.host));
          return {
            pass: hosts.has(museum) && hosts.has(blog),
            evidence: [...hosts].join(', ') || 'no site was opened',
          };
        },
        { aspect: 'process', failure: 'incomplete' },
      ),
      judge(
        'says-it-is-open-on-mondays',
        'The final answer tells the user that the Museu da Ribeira is open on Mondays (the official site gives 10:00-18:00). Adding that it is closed on Tuesdays, or that the library is closed on Mondays, is fine. It fails if it says the museum is closed on Mondays, or if it leaves the question open (for example only saying the sources disagree, or telling the user to call) without concluding that it is open.',
        { failure: 'reasoning' },
      ),
      judge(
        'trusts-the-official-site-over-the-old-guide',
        "The answer bases its conclusion on the museum's official website rather than the travel blog, or explains the conflict (the blog guide is from May 2024, before the opening days changed in March 2026). Naming the source is enough to show that, and a short answer that concludes it is open without naming a source also passes. It fails if it presents the blog's 'closed on Mondays' as the more reliable or an equally likely answer.",
        { failure: 'reasoning' },
      ),
    ];
  },
});
