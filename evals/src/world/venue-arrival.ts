import { check, judge, scenario } from '../scenario.ts';
import conflictingSources from '../scenarios/conflicting-sources.ts';

const museum = 'museuribeira.example.org';
const blog = 'lisbon-wanderer.example.net';
const guide = '/2024/05/lisbon-museums-guide';

export function venueArrivalScenario(variant: 'before' | 'after') {
  const arrival = variant === 'before' ? '18:15' : '18:45';
  const local = variant === 'before' ? '17:15' : '17:45';
  const conclusion =
    variant === 'before'
      ? 'The user can enter at the planned arrival under the published schedule, because 17:15 is before last entry at 17:30.'
      : 'The user cannot enter at the planned arrival, because 17:45 is after last entry at 17:30, even though the museum closes at 18:00.';

  return scenario({
    id: `conflicting-sources-arrival-${variant}`,
    title: 'Check museum admission at a planned Madrid-time arrival',
    capabilities: ['research', 'browser'],
    tier: 'release',
    calibration: 'pending',
    stance: 'regression',
    complexity: 'simple',
    seconds: 420,
    timeZone: 'Europe/Madrid',
    user: {
      approve: false,
      persona:
        'You are Alex Rivera. You want to know whether you can enter the museum at your planned arrival. A short answer is enough. You are not asking for a booking.',
    },
    world: conflictingSources.world,
    async play(session) {
      await session.say(
        `Can I still enter the Museu da Ribeira in Lisbon if I arrive on Monday, 2026-11-02 at ${arrival} Madrid time? Check ${museum} and the guide at ${blog}.`,
      );
    },
    evidence(run, world) {
      return [
        conflictingSources.evidence?.(run, world),
        `Judge-only answer key: evaluate the planned arrival on 2026-11-02, not the run's wall clock. That date is Monday. Madrid is UTC+1 and Lisbon is UTC+0, so ${arrival} Madrid time is ${local} Lisbon time. The official /visit page gives Monday hours 10:00-18:00 and last entry 30 minutes before closing, making last entry 17:30 Lisbon time. ${conclusion}`,
        'The fixture establishes published hours, not a booking, guaranteed capacity or an exception to last entry. Ground truth describes available source content; it does not prove the assistant read it. The transcript must show the relevant official visit content and the dated old guide, not only their home pages or an assistant-authored echo.',
      ]
        .filter(Boolean)
        .join('\n');
    },
    expect() {
      return [
        check(
          'opens-the-admission-page-and-dated-guide',
          (run) => ({
            pass: [
              [museum, '/visit'],
              [blog, guide],
            ].every(([host, path]) =>
              run.visits.some(
                (visit) => visit.host === host && visit.path === path && visit.method === 'GET',
              ),
            ),
            evidence: JSON.stringify(run.visits),
          }),
          { aspect: 'process', failure: 'incomplete' },
        ),
        judge(
          'reads-the-admission-rule-and-old-guide',
          "Before the final answer, actual tool observations show the official museum /visit content with its Monday 10:00-18:00 hours and last entry 30 minutes before closing, and the guide published 14 May 2024 saying the museum is closed on Mondays. Fetch results, browser content or consistent screenshots may establish these reads. Opening only the home pages, seeing titles or URLs, or repeating the assistant's own claims does not suffice. The current official schedule is authoritative over the outdated guide. Do not require a specific read tool, an extra confirmation, or a quotation in the final answer.",
          { aspect: 'process', failure: 'incomplete' },
        ),
        judge(
          'answers-admission-at-the-planned-arrival',
          `The final answer correctly relates ${arrival} Madrid time on Monday 2026-11-02 to the official last-entry boundary of 17:30 Lisbon time. It may explicitly give ${local} as the Lisbon-local arrival or make an equivalent unambiguous comparison, such as arriving 15 minutes before or after that cutoff as appropriate. It reaches this conclusion: ${conclusion} Judge admission at the specified arrival, not whether Monday is generally an opening day or whether the museum has already closed at the run's current time. Equivalent concise wording passes; the answer need not repeat the source-conflict history if it uses the current official schedule. Do not require a guaranteed ticket or capacity claim. It must not invent a booking, an exception to the cutoff, or an action already completed.`,
          { failure: 'reasoning' },
        ),
      ];
    },
  });
}
