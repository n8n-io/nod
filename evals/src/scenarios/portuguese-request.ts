import { check, judge, scenario } from '../scenario.ts';
import { calendar, createApps } from '../world/apps.ts';
import { dayLabel, localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const tomorrow = [
  {
    summary: 'Revisão do logótipo com a Meridian',
    key: /meridian/i,
    hour: 9,
    minute: 30,
    length: 60,
  },
  {
    summary: 'Reunião de orçamento com a Inês Carvalho',
    key: /carvalho|\bin[eê]s\b/i,
    hour: 12,
    minute: 0,
    length: 45,
  },
  { summary: 'Chamada com a Kestrel Bikes', key: /kestrel/i, hour: 16, minute: 0, length: 30 },
];
const otherDays = [
  { summary: 'Sessão de fotos no estúdio', key: /sess[aã]o de fotos/i, back: 0, hour: 11 },
  { summary: 'Dentista', key: /dentista/i, back: -2, hour: 10 },
];

export default scenario({
  id: 'portuguese-request',
  title: 'Que reuniões tenho amanhã?',
  capabilities: ['progress', 'apps'],
  tier: 'release',
  complexity: 'simple',
  stance: 'regression',
  seconds: 300,
  calibration: 'pending',
  user: {
    approve: true,
    persona:
      'És o Alex Rivera, designer de marcas freelancer em Lisboa. Escreves sempre em português. Só queres saber que reuniões tens amanhã.',
  },
  world(clock) {
    const now = clock.now();
    const at = (back: number, hour: number, minute = 0) =>
      localTime(now, back, hour, 'Europe/Madrid', minute);
    return {
      apps: createApps(owner, {
        calendar: calendar(
          owner,
          [
            ...tomorrow.map((event) => ({
              summary: event.summary,
              start: at(-1, event.hour, event.minute),
              end: at(-1, event.hour, event.minute) + event.length * 60_000,
            })),
            ...otherDays.map((event) => ({
              summary: event.summary,
              start: at(event.back, event.hour),
              end: at(event.back, event.hour) + 3_600_000,
            })),
          ],
          'Europe/Madrid',
        ),
      }),
      tomorrow: dayLabel(at(-1, 12)),
    };
  },
  async play(session) {
    await session.say('Que reuniões tenho amanhã?');
  },
  evidence(_run, world) {
    return `Tomorrow is ${world.tomorrow}. Tomorrow's calendar has exactly three events: "Revisão do logótipo com a Meridian" 09:30-10:30, "Reunião de orçamento com a Inês Carvalho" 12:00-12:45 and "Chamada com a Kestrel Bikes" 16:00-16:30. "Sessão de fotos no estúdio" is today and "Dentista" is the day after tomorrow, so neither is tomorrow. The user wrote in Portuguese.`;
  },
  expect() {
    return [
      check(
        'names-all-three-meetings',
        (run) => {
          const missing = tomorrow.filter((event) => !event.key.test(run.said));
          return {
            pass: !missing.length,
            evidence: missing.length
              ? `missing ${missing.map((event) => event.summary).join(', ')}`
              : undefined,
          };
        },
        {
          failure: 'incomplete',
          otherwise:
            "The answer refers to each of tomorrow's three meetings (the Meridian logo review, the budget meeting with Inês Carvalho and the call with Kestrel Bikes) in any wording or language: its title, a paraphrase, a participant or its time.",
        },
      ),
      check(
        'does-not-add-other-days',
        (run) => {
          const found = otherDays.filter((event) => event.key.test(run.final));
          return {
            pass: !found.length,
            evidence: found.length
              ? `mentions ${found.map((event) => event.summary).join(', ')}`
              : undefined,
          };
        },
        { required: false, failure: 'reasoning' },
      ),
      judge(
        'replies-in-portuguese',
        'The assistant\'s answer to "Que reuniões tenho amanhã?" is written in Portuguese (European or Brazilian), not English or Spanish. Event titles copied from the calendar do not count either way; judge the surrounding sentences.',
        { failure: 'format' },
      ),
    ];
  },
});
