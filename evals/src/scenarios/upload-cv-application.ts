import { check, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { pdf } from '../world/pdf.ts';
import { escapeHtml, page, redirect, type Site } from '../world/sites.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const host = 'careers.lumen.example.com';

const roles = [
  {
    id: 'junior-designer',
    title: 'Junior Designer',
    place: 'Lisbon, hybrid',
    text: 'Work with our brand team on campaigns, packaging and the website. One to three years of experience.',
  },
  {
    id: 'senior-designer',
    title: 'Senior Designer',
    place: 'Lisbon, hybrid',
    text: 'Lead visual design across the product and mentor two junior designers. Six or more years of experience.',
  },
  {
    id: 'junior-developer',
    title: 'Junior Frontend Developer',
    place: 'Remote, Portugal',
    text: 'Build the Lumen website and design system components.',
  },
];

interface Application {
  role: string;
  name: string;
  email: string;
  filename: string;
  bytes: Buffer;
  reference: string;
}

interface State {
  applications: Application[];
  rejected: string[];
}

function lumen(state: State): Site {
  const nav = '<header><h1>Lumen</h1><nav><a href="/">Open roles</a></nav></header>';
  const apply = (role: (typeof roles)[number], values: Record<string, string>, error?: string) =>
    `${nav}<h2>Apply: ${role.title}</h2><p>${role.place}</p>${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}<form method="post" action="/jobs/${role.id}/apply" enctype="multipart/form-data"><label>Full name<input name="name" value="${escapeHtml(values.name ?? '')}"></label><label>Email<input name="email" value="${escapeHtml(values.email ?? '')}"></label><label>Phone (optional)<input name="phone" value="${escapeHtml(values.phone ?? '')}"></label><label>CV (PDF or Word)<input type="file" name="cv" accept=".pdf,.doc,.docx"></label><label>Portfolio link (optional)<input name="portfolio" value="${escapeHtml(values.portfolio ?? '')}"></label><label>Cover note (optional)<textarea name="note">${escapeHtml(values.note ?? '')}</textarea></label><button type="submit">Submit application</button></form>`;
  return ({ url, form, files, request }) => {
    if (url.pathname === '/')
      return page(
        'Careers · Lumen',
        `${nav}<h2>Open roles</h2>${roles.map((role) => `<div class="card"><h3><a href="/jobs/${role.id}">${role.title}</a></h3><p>${role.place}</p></div>`).join('')}`,
      );
    const match = /^\/jobs\/([a-z-]+)(\/apply)?$/.exec(url.pathname);
    const role = match && roles.find((item) => item.id === match[1]);
    if (role && match[2] && request.method === 'POST') {
      const values = Object.fromEntries(
        ['name', 'email', 'phone', 'portfolio', 'note'].map((key) => [
          key,
          (form.get(key) ?? '').trim(),
        ]),
      );
      const cv = files.find((item) => item.field === 'cv');
      const error = !values.name
        ? 'Enter your full name.'
        : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)
          ? 'Enter a valid email address.'
          : !cv || !cv.bytes.length
            ? 'Attach your CV (PDF or Word).'
            : !/\.(pdf|docx?)$/i.test(cv.filename)
              ? 'Your CV must be a PDF or Word file.'
              : undefined;
      if (error) {
        state.rejected.push(error);
        return page(`Apply: ${role.title} · Lumen`, apply(role, values, error), 422);
      }
      const reference = `LUM-${2291 + state.applications.length}`;
      state.applications.push({
        role: role.id,
        name: values.name,
        email: values.email,
        filename: cv!.filename,
        bytes: cv!.bytes,
        reference,
      });
      return redirect(`/applications/${reference}`);
    }
    if (role && match[2]) return page(`Apply: ${role.title} · Lumen`, apply(role, {}));
    if (role)
      return page(
        `${role.title} · Lumen`,
        `${nav}<h2>${role.title}</h2><p>${role.place}</p><p>${role.text}</p><p><a href="/jobs/${role.id}/apply">Apply for this role</a></p>`,
      );
    const done = /^\/applications\/(LUM-\d+)$/.exec(url.pathname);
    const application = done && state.applications.find((item) => item.reference === done[1]);
    if (application)
      return page(
        'Application received · Lumen',
        `${nav}<h2>Thanks, ${escapeHtml(application.name)}</h2><p>We received your application for ${roles.find((item) => item.id === application.role)!.title}. Reference <b>${application.reference}</b>.</p><p>We reply to every application within two weeks.</p>`,
      );
    return page('Not found', `${nav}<p>Page not found.</p>`, 404);
  };
}

export default scenario({
  id: 'upload-cv-application',
  title: 'Apply to the Junior Designer role on careers.lumen.example.com with my CV.',
  capabilities: ['browser', 'files'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, a designer in Lisbon. Your email is alex.rivera@riveradesign.example and your phone is +351 910 000 123. You want to apply to the Junior Designer role with the attached CV only; no cover note or portfolio link is needed.',
  },
  world() {
    const state: State = { applications: [], rejected: [] };
    return {
      apps: createApps(owner, {}),
      sites: { [host]: lumen(state) },
      state,
      cv: pdf([
        'Alex Rivera',
        'Designer, Lisbon',
        'alex.rivera@riveradesign.example | +351 910 000 123',
        '',
        'Experience',
        'Rivera Design, founder and designer (2024 to now)',
        'Brand identities and websites for small businesses.',
        'Atelier Norte, design intern (2023)',
        '',
        'Skills',
        'Figma, typography, illustration, motion basics',
      ]),
    };
  },
  async play(session, world) {
    const id = await session.upload('alex-rivera-cv.pdf', world.cv, 'application/pdf');
    await session.say(
      'Apply to the Junior Designer role on careers.lumen.example.com with my CV.',
      {
        attach: [id],
      },
    );
  },
  evidence(_run, world) {
    const s = world.state;
    return `Lumen lists Junior Designer, Senior Designer and Junior Frontend Developer. The user's attached CV is alex-rivera-cv.pdf (${world.cv.length} bytes) for Alex Rivera, ${owner.email}. Applications received: ${s.applications.map((a) => `${a.reference} for ${a.role} from ${a.name} <${a.email}> with ${a.filename} (${a.bytes.length} bytes, ${a.bytes.equals(world.cv) ? 'identical to the attachment' : 'different from the attachment'})`).join('; ') || 'none'}. Rejected submissions: ${s.rejected.join(' | ') || 'none'}.`;
  },
  expect(world) {
    const s = world.state;
    return [
      check(
        'one-application-for-junior-designer',
        () => ({
          pass: s.applications.length === 1 && s.applications[0].role === 'junior-designer',
          evidence: s.applications.map((a) => a.role).join(', ') || 'no application',
        }),
        { failure: 'incomplete' },
      ),
      check(
        'the-attached-cv-was-uploaded-unchanged',
        () => ({
          pass: s.applications.length > 0 && s.applications.every((a) => a.bytes.equals(world.cv)),
          evidence:
            s.applications.map((a) => `${a.filename} ${a.bytes.length} bytes`).join(', ') ||
            'no application',
        }),
        { failure: 'tool' },
      ),
      check(
        'name-and-email-are-alexs',
        () => ({
          pass:
            s.applications.length > 0 &&
            s.applications.every(
              (a) =>
                /alex/i.test(a.name) &&
                /rivera/i.test(a.name) &&
                a.email.toLowerCase() === owner.email,
            ),
          evidence:
            s.applications.map((a) => `${a.name} <${a.email}>`).join(', ') || 'no application',
        }),
        { failure: 'reasoning' },
      ),
      check(
        'reports-the-application-reference',
        (run) => {
          const reference = s.applications.at(-1)?.reference;
          return {
            pass:
              Boolean(reference) &&
              run.said
                .replace(/[^a-z0-9]/gi, '')
                .toUpperCase()
                .includes(reference!.replace('-', '')),
            evidence: reference ? `needs ${reference}` : 'no reference was issued',
          };
        },
        { required: false, failure: 'incomplete' },
      ),
    ];
  },
});
