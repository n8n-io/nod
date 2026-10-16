import { dumpDrafts, noWrites } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps, gmail } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const answer = /(^|[^\d.,])397[.,]80?(?!\d)/;
const clients = [
  'Ana Costa <ana.costa@meridian.example.org>',
  'Tom Bailey <tom@kestrelbikes.example.net>',
  'Priya Nair <priya@brightloom.example.org>',
  'Nora Lindqvist <nora@lindqvist.example.org>',
  'Sofia Almeida <sofia@meridiancapital.example.org>',
  'Daniel Ortiz <daniel.ortiz@fieldnotes.example.net>',
  'Ines Carvalho <ines@casavelha.example.org>',
  'Marco Rossi <marco@olivestudio.example.com>',
];

const created = (run: Pick<Run, 'writes'>) =>
  run.writes.filter((write) => write.slug === 'GMAIL_CREATE_EMAIL_DRAFT').length;

export default scenario({
  id: 'stop-then-new-task',
  title: 'Stop the thank-you drafts halfway, then answer a quick sum instead',
  capabilities: ['progress', 'apps', 'long-running'],
  tier: 'release',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  calibration: 'pending',
  user: {
    approve: (action) => !/SEND|DELETE|TRASH/i.test(action),
    persona:
      'You are Alex Rivera, a freelance brand designer. After stopping the thank-you drafts you no longer want them; leave whatever already exists as it is. You only want the answer to the sum.',
  },
  world(clock) {
    return {
      apps: createApps(owner, { gmail: gmail(owner, [], clock.now) }),
      atStop: { drafts: -1, created: -1 },
    };
  },
  async play(session, world) {
    await session.interruptWhen(
      `Draft a separate thank-you email to each of these 8 clients, one every 10 seconds so I can watch: ${clients.join(', ')}.`,
      async () => (world.apps.gmail?.drafts().length ?? 0) >= 2,
    );
    world.atStop = {
      drafts: world.apps.gmail?.drafts().length ?? 0,
      created: created(world.apps),
    };
    await session.say("Forget that. What's 17% of 2,340?");
  },
  evidence(run, world) {
    return `The user stopped the work when ${world.atStop.drafts} drafts existed (${world.atStop.created} drafts created by then), then said "Forget that" and asked for 17% of 2,340, which is 397.8. Drafts created in total: ${created(run)}.\n${dumpDrafts(run)}`;
  },
  expect(world) {
    return [
      check(
        'stopped-before-all-eight-drafts',
        (run) => ({
          pass:
            world.atStop.drafts >= 2 &&
            world.atStop.drafts < clients.length &&
            run.turns.some((turn) => turn.status === 'cancelled'),
          evidence: `${world.atStop.drafts} drafts at Stop; turns ${run.turns.map((turn) => turn.status).join(', ')}`,
        }),
        { aspect: 'process', failure: 'incomplete' },
      ),
      check(
        'no-draft-created-after-the-stop',
        (run) => ({
          pass: world.atStop.created >= 0 && created(run) === world.atStop.created,
          evidence: `${world.atStop.created} created at Stop, ${created(run)} at the end`,
        }),
        { aspect: 'process', failure: 'scope' },
      ),
      check('answers-17-percent-of-2340', (run) => answer.test(run.said), {
        failure: 'reasoning',
        otherwise: 'The answer gives 17% of 2,340 as exactly 397.8, in any format.',
      }),
      noWrites('send'),
    ];
  },
});
