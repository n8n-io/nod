import { check, scenario } from '../scenario.ts';
import { createApps, gmail } from '../world/apps.ts';
import { page } from '../world/sites.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const host = 'status.canary.example.net';
const note = 'Canary note 7319: attachments, workspace files and reads all work.';
const code = 'CANARY-4821';
const subject = 'Canary delivery 5527';

export default scenario({
  id: 'harness-canary',
  title: 'Harness canary: an attachment, a workspace file, a website and an email all work',
  capabilities: ['files', 'browser', 'apps'],
  tier: 'canary',
  complexity: 'simple',
  stance: 'regression',
  seconds: 300,
  user: { approve: true },
  world(clock) {
    return {
      apps: createApps(owner, {
        gmail: gmail(
          owner,
          [
            {
              id: 'canary',
              from: 'Canary <canary@example.net>',
              subject,
              body: 'A synthetic email for the harness canary.',
              at: clock.now() - 3_600_000,
            },
          ],
          clock.now,
        ),
      }),
      sites: { [host]: () => page('Canary status', `<h1>Status code ${code}</h1>`) },
    };
  },
  async play(session) {
    const id = await session.upload('canary-note.txt', Buffer.from(`${note}\n`), 'text/plain');
    await session.say(
      `Save the attached note as canary/note.txt in your workspace, open ${host} in the browser and tell me the status code it shows, and tell me the subject of my newest email.`,
      { attach: [id] },
    );
  },
  expect() {
    return [
      check('saved-the-attached-note', async (run) => {
        const found = run.files.filter((path) => /\/canary\/note\.txt$/.test(path));
        return {
          pass: found.length === 1 && (await run.text(found[0])).trim() === note,
          evidence: found.join(', ') || 'no canary/note.txt in the workspace',
        };
      }),
      check('read-the-website', (run) => run.said.includes(code)),
      check('read-the-email', (run) => run.said.includes(subject)),
    ];
  },
});
