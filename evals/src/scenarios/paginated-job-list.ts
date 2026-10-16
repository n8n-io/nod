import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { page, type Site } from '../world/sites.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const host = 'jobs.portal-emprego.example.org';

interface Job {
  slug: string;
  title: string;
  company: string;
  location: string;
  category: string;
  posted: number;
  closed?: boolean;
  key?: RegExp;
}

const jobs: Job[][] = [
  [
    {
      slug: 'product-designer-lumina',
      title: 'Product Designer',
      company: 'Lumina Apps',
      location: 'Lisbon',
      category: 'Design',
      posted: 2,
      key: /product designer/i,
    },
    {
      slug: 'backend-engineer-ondaweb',
      title: 'Backend Engineer',
      company: 'Ondaweb',
      location: 'Porto',
      category: 'Engineering',
      posted: 3,
    },
    {
      slug: 'ux-designer-seguros-tejo',
      title: 'Senior UX Designer',
      company: 'Seguros Tejo',
      location: 'Lisbon',
      category: 'Design',
      posted: 3,
      key: /ux designer/i,
    },
    {
      slug: 'support-specialist-ferrovia',
      title: 'Customer Support Specialist',
      company: 'Ferrovia',
      location: 'Lisbon',
      category: 'Customer service',
      posted: 4,
    },
    {
      slug: 'web-designer-nomada',
      title: 'Web Designer',
      company: 'Nómada Studio',
      location: 'Remote (Portugal)',
      category: 'Design',
      posted: 4,
    },
    {
      slug: 'frontend-engineer-lumina',
      title: 'Frontend Engineer',
      company: 'Lumina Apps',
      location: 'Lisbon',
      category: 'Engineering',
      posted: 5,
    },
    {
      slug: 'graphic-designer-doce-lar',
      title: 'Graphic Designer',
      company: 'Pastelaria Doce Lar',
      location: 'Lisbon',
      category: 'Design',
      posted: 5,
      key: /graphic designer/i,
    },
    {
      slug: 'packaging-designer-conservas',
      title: 'Packaging Designer',
      company: 'Conservas Atlântico',
      location: 'Porto',
      category: 'Design',
      posted: 6,
    },
    {
      slug: 'data-analyst-seguros-tejo',
      title: 'Data Analyst',
      company: 'Seguros Tejo',
      location: 'Lisbon',
      category: 'Data',
      posted: 6,
    },
    {
      slug: 'recruiter-talentopt',
      title: 'Recruiter',
      company: 'TalentoPT',
      location: 'Remote (Portugal)',
      category: 'People',
      posted: 7,
    },
  ],
  [
    {
      slug: 'ui-designer-ferrovia',
      title: 'UI Designer, Mobile',
      company: 'Ferrovia',
      location: 'Lisbon',
      category: 'Design',
      posted: 8,
      key: /ui designer/i,
    },
    {
      slug: 'devops-engineer-cloudnorte',
      title: 'DevOps Engineer',
      company: 'Cloudnorte',
      location: 'Porto',
      category: 'Engineering',
      posted: 8,
    },
    {
      slug: 'exhibition-designer-oriente',
      title: 'Exhibition Designer',
      company: 'Oriente Studio',
      location: 'Lisbon',
      category: 'Design',
      posted: 9,
      closed: true,
    },
    {
      slug: 'brand-designer-seguros-tejo',
      title: 'Brand Designer',
      company: 'Seguros Tejo',
      location: 'Lisbon (Parque das Nações)',
      category: 'Design',
      posted: 9,
      key: /brand designer/i,
    },
    {
      slug: 'ios-engineer-nomada',
      title: 'iOS Engineer',
      company: 'Nómada Studio',
      location: 'Remote (Portugal)',
      category: 'Engineering',
      posted: 10,
    },
    {
      slug: 'marketing-manager-doce-lar',
      title: 'Marketing Manager',
      company: 'Pastelaria Doce Lar',
      location: 'Lisbon',
      category: 'Marketing',
      posted: 10,
    },
    {
      slug: 'textile-designer-fios',
      title: 'Textile Designer',
      company: 'Fios do Norte',
      location: 'Porto',
      category: 'Design',
      posted: 11,
    },
    {
      slug: 'motion-designer-farol',
      title: 'Motion Designer',
      company: 'Estúdio Farol',
      location: 'Lisbon',
      category: 'Design',
      posted: 11,
      key: /motion designer/i,
    },
    {
      slug: 'qa-engineer-ondaweb',
      title: 'QA Engineer',
      company: 'Ondaweb',
      location: 'Lisbon',
      category: 'Engineering',
      posted: 12,
    },
    {
      slug: 'sales-rep-cloudnorte',
      title: 'Sales Representative',
      company: 'Cloudnorte',
      location: 'Porto',
      category: 'Sales',
      posted: 12,
    },
  ],
  [
    {
      slug: 'service-designer-camara',
      title: 'Service Designer',
      company: 'Câmara Digital',
      location: 'Lisbon',
      category: 'Design',
      posted: 13,
      key: /service designer/i,
    },
    {
      slug: 'technical-writer-docuverse',
      title: 'Technical Writer',
      company: 'Docuverse',
      location: 'Remote (Portugal)',
      category: 'Engineering',
      posted: 13,
    },
    {
      slug: 'interaction-designer-mobilidade',
      title: 'Interaction Designer',
      company: 'Mobilidade Lx',
      location: 'Lisbon',
      category: 'Design',
      posted: 14,
      key: /interaction designer/i,
    },
    {
      slug: 'account-executive-talentopt',
      title: 'Account Executive',
      company: 'TalentoPT',
      location: 'Lisbon',
      category: 'Sales',
      posted: 14,
    },
    {
      slug: 'illustrator-editora-sol',
      title: 'Illustrator',
      company: 'Editora Sol',
      location: 'Remote (Portugal)',
      category: 'Design',
      posted: 15,
    },
    {
      slug: 'visual-designer-farol',
      title: 'Junior Visual Designer',
      company: 'Estúdio Farol',
      location: 'Lisbon',
      category: 'Design',
      posted: 15,
      key: /visual designer/i,
    },
    {
      slug: 'ml-engineer-seguros-tejo',
      title: 'Machine Learning Engineer',
      company: 'Seguros Tejo',
      location: 'Lisbon',
      category: 'Engineering',
      posted: 16,
    },
    {
      slug: 'type-designer-fundicao',
      title: 'Type Designer',
      company: 'Fundição Tipográfica',
      location: 'Porto',
      category: 'Design',
      posted: 17,
    },
    {
      slug: 'office-manager-ferrovia',
      title: 'Office Manager',
      company: 'Ferrovia',
      location: 'Lisbon',
      category: 'Operations',
      posted: 17,
    },
    {
      slug: 'content-marketing-farol',
      title: 'Content Marketing Specialist',
      company: 'Estúdio Farol',
      location: 'Lisbon',
      category: 'Marketing',
      posted: 18,
    },
  ],
];

const all = jobs.flat();
const wanted = all.filter((job) => job.key);
const closed = all.find((job) => job.closed)!;
const otherDesign = all.filter(
  (job) => job.category === 'Design' && !job.location.startsWith('Lisbon'),
);

function portal(views: Set<number>): Site {
  const nav = '<header><h1>Portal Emprego</h1><nav><a href="/jobs">All jobs</a></nav></header>';
  return ({ url }) => {
    if (url.pathname === '/' || url.pathname === '/jobs') {
      const number = Number(url.searchParams.get('page') ?? '1');
      const list = jobs[number - 1];
      if (!Number.isInteger(number) || !list)
        return page('Not found', `${nav}<p>This page does not exist.</p>`, 404);
      views.add(number);
      const cards = list
        .map(
          (job) =>
            `<div class="card"><h3><a href="/jobs/${job.slug}">${job.title}</a></h3><p>${job.company} · ${job.location} · ${job.category}</p><p>${job.closed ? '<b>Closed</b> · No longer accepting applications' : `Posted ${job.posted} days ago`}</p></div>`,
        )
        .join('');
      const pager = `<nav aria-label="Pages"><p>Page ${number} of ${jobs.length}</p>${number > 1 ? `<a href="/jobs?page=${number - 1}">Previous page</a>` : ''}${number < jobs.length ? `<a href="/jobs?page=${number + 1}">Next page</a>` : ''}</nav>`;
      return page(
        `Jobs · page ${number} · Portal Emprego`,
        `${nav}<h2>Latest jobs in Portugal</h2><p>${all.length} jobs, newest first.</p>${cards}${pager}`,
      );
    }
    const match = /^\/jobs\/([a-z-]+)$/.exec(url.pathname);
    const job = match && all.find((item) => item.slug === match[1]);
    if (job)
      return page(
        `${job.title} · Portal Emprego`,
        `${nav}<h2>${job.title}</h2><p>${job.company} · ${job.location} · ${job.category}</p>${job.closed ? '<p><b>Closed.</b> This job is no longer accepting applications.</p>' : `<p>Posted ${job.posted} days ago. Full time.</p><p>Apply through the company careers page.</p>`}`,
      );
    return page('Not found', `${nav}<p>Page not found.</p>`, 404);
  };
}

const lines = (text: string) => text.split('\n');

export default scenario({
  id: 'paginated-job-list',
  title: 'List every open design job in Lisbon on jobs.portal-emprego.example.org.',
  capabilities: ['browser', 'research'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, a designer looking for work in Lisbon. You want every open design job in Lisbon on that board, any seniority, and you do not want to apply yet.',
  },
  world() {
    const views = new Set<number>();
    return { apps: createApps(owner, {}), sites: { [host]: portal(views) }, views };
  },
  async play(session) {
    await session.say('List every open design job in Lisbon on jobs.portal-emprego.example.org.');
  },
  evidence(_run, world) {
    return `The board has ${all.length} jobs over ${jobs.length} pages (10 per page, "Next page" links with ?page=2 and ?page=3). Open design jobs in Lisbon (9): ${wanted.map((job) => `${job.title} at ${job.company}, ${job.location}, page ${jobs.findIndex((list) => list.includes(job)) + 1}`).join('; ')}. Closed Lisbon design job (must not be listed as open): ${closed.title} at ${closed.company}, page 2. Design jobs outside Lisbon: ${otherDesign.map((job) => `${job.title} (${job.location})`).join(', ')}. Lisbon jobs in other categories: ${all
      .filter((job) => job.location.startsWith('Lisbon') && job.category !== 'Design')
      .map((job) => job.title)
      .join(
        ', ',
      )}. List pages the assistant opened: ${[...world.views].sort().join(', ') || 'none'}.`;
  },
  expect() {
    return [
      check(
        'lists-all-nine-open-lisbon-design-jobs',
        (run) => {
          const missing = wanted.filter((job) => !job.key!.test(run.said));
          return {
            pass: !missing.length,
            evidence: missing.length
              ? `missing ${missing.map((job) => job.title).join(', ')}`
              : undefined,
          };
        },
        {
          failure: 'incomplete',
          otherwise:
            'The answer lists all nine open design jobs in Lisbon from the ground truth (Product, UX, Graphic, UI, Brand, Motion, Service, Interaction and Visual Designer), each recognisable by its title or company, in any wording.',
        },
      ),
      check(
        'closed-posting-is-not-listed-as-open',
        (run) => {
          const named = lines(run.said).filter((line) => /exhibition designer/i.test(line));
          const unmarked = named.filter(
            (line) =>
              !/closed|no longer|not accepting|expired|filled|left out|excluded|skipped|omitted|not includ/i.test(
                line,
              ),
          );
          return {
            pass: !unmarked.length,
            evidence: unmarked.length ? unmarked[0].slice(0, 200) : undefined,
          };
        },
        { required: false, failure: 'reasoning' },
      ),
      judge(
        'closed-posting-not-presented-as-open',
        'The final answer does not present Exhibition Designer at Oriente Studio as an open job. Leaving it out, or mentioning it as closed, passes.',
        { failure: 'reasoning' },
      ),
      check(
        'design-jobs-outside-lisbon-are-not-listed-as-lisbon',
        (run) => {
          const wrong = lines(run.final).filter((line) =>
            otherDesign.some(
              (job) =>
                new RegExp(`\\b${job.title}\\b`, 'i').test(line) &&
                !/porto|remote|outside|not in lisbon/i.test(line),
            ),
          );
          return {
            pass: !wrong.length,
            evidence: wrong.length ? wrong[0].slice(0, 200) : undefined,
          };
        },
        { required: false, failure: 'scope' },
      ),
    ];
  },
});
