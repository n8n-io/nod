import type { Presentation } from '../../../src/shared/presentation.ts';
import { check } from '../scenario.ts';
import { inlineVisualScenario, presentations } from '../world/inline-visuals.ts';

const definition = inlineVisualScenario({
  id: 'inline-visual-flight-connections',
  title: 'Compare connecting flights without hiding transfer risks',
  type: 'flights',
  path: '/flights/lis-prg/connections',
  request: (date, source) =>
    `Compare the Lisbon to Prague options leaving on ${date} at ${source}. I need a cabin bag, want to arrive before noon the following day, and can spend €350 on flights. I prefer not to change airports or collect and recheck bags. Show the whole journey for each option here, including every flight and stop, and explain which you recommend and what is still uncertain. Don't book anything.`,
  body: (date) => {
    const tomorrow = new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    return `<p>Synthetic search results for one adult, one way. All times are local to the named airport. Every option includes one cabin bag; checked baggage is not included. Fares and equipment can change. There is no seat inventory or reservation. The source does not establish visa eligibility or minimum connection times.</p>
<h2>Option A: €260, three flights, separate tickets for the final flight</h2>
<table><tr><th>Flight</th><th>Departure</th><th>Arrival</th><th>Equipment and operation</th></tr>
<tr><td>Aerovia AV101</td><td>LIS Terminal 1, ${date}, 20:00, Europe/Lisbon</td><td>CDG Terminal 2B, ${date}, 23:30, Europe/Paris</td><td>Aerovia; A320; economy; duration 2h30; no technical stops</td></tr>
<tr><td>Aerovia AV501</td><td>CDG Terminal 2B, ${tomorrow}, 02:00, Europe/Paris</td><td>FRA Terminal 1, ${tomorrow}, 06:30, Europe/Berlin</td><td>Operated by Alpine Regional; A220; economy; duration 4h30 including a 45-minute technical stop at ZRH. Passengers remain on the same aircraft at ZRH; this is not a connection.</td></tr>
<tr><td>Citybridge CB210</td><td>HHN, ${tomorrow}, 10:30, Europe/Berlin</td><td>PRG Terminal 2, ${tomorrow}, 11:45, Europe/Prague</td><td>Citybridge; E190; economy; duration 1h15; no technical stops</td></tr></table>
<p>After AV101: 2h30 overnight connection at CDG, same airport and ticket; no self-transfer. After AV501: 4 hours between FRA arrival and HHN departure. The passenger must travel from FRA to HHN and handle check-in for a separate ticket. This is an airport change and self-transfer; any checked bag would need collection and recheck. Ground transport is not included in €260 and its price is unknown. The source does not say whether four hours is sufficient. Total scheduled journey: 14h45, two connections plus one technical stop.</p>
<h2>Option B: €340, two flights on one ticket</h2>
<table><tr><th>Flight</th><th>Departure</th><th>Arrival</th><th>Equipment and operation</th></tr>
<tr><td>Canal Air CA220</td><td>LIS Terminal 1, ${date}, 21:00, Europe/Lisbon</td><td>AMS, ${tomorrow}, 01:00, Europe/Amsterdam</td><td>Canal Air; A321; economy; duration 3h; no technical stops</td></tr>
<tr><td>Canal Air CA330</td><td>AMS, ${tomorrow}, 04:00, Europe/Amsterdam</td><td>PRG Terminal 2, ${tomorrow}, 05:30, Europe/Prague</td><td>Canal Air; E195; economy; duration 1h30; no technical stops</td></tr></table>
<p>Option B has a 3-hour overnight connection at AMS on one ticket, no airport change and no self-transfer. Total scheduled journey: 7h30. The source provides no minimum connection-time or immigration assessment. Search results are not guaranteed or booked.</p>`;
  },
  criterion:
    'Preserve both options in native flight presentations and in a useful text comparison. Option A costs €260 for flights, has AV101 LIS–CDG, AV501 CDG–FRA operated by Alpine Regional with a 45-minute ZRH technical stop on the same aircraft, then CB210 HHN–PRG. It has two connections, not three; the technical stop remains inside AV501. Preserve the overnight 2h30 CDG connection and the 4-hour FRA-to-HHN airport change/self-transfer with separate final ticket. Ground transfer cost and connection feasibility are unknown; do not claim the whole trip is within €350, protected, safe or booked. Option B is €340, CA220 LIS–AMS then CA330 AMS–PRG, 3-hour overnight same-airport connection, one ticket and no self-transfer; recommend it as matching the stated preferences, without inventing a minimum-connection-time or visa check. Both arrive before noon the next day and include a cabin bag but no checked bag. Preserve the source dates, local times, time zones, operating carrier and distinct equipment per segment. A single route summary, prose-only hidden connections, or one shared aircraft for all legs fails. Do not invent terminals, availability, guaranteed fares or reservations.',
});

export default {
  ...definition,
  expect(world) {
    return [
      ...definition.expect(world),
      check(
        'keeps-connections-and-technical-stops-in-their-segments',
        (run) => {
          const visuals = presentations(run).filter((value) => value.type === 'flights') as Array<
            Extract<Presentation, { type: 'flights' }>
          >;
          const journeys = visuals.flatMap((value) =>
            value.options.flatMap((option) => option.journeys ?? []),
          );
          const journey = journeys.find(
            (value) =>
              value.segments.length === 3 &&
              value.segments
                .map((segment) => segment.flightNumber?.replace(/\s+/g, '').toUpperCase())
                .join('|') === 'AV101|AV501|CB210',
          );
          const first = journey?.segments[0];
          const middle = journey?.segments[1];
          const last = journey?.segments[2];
          return {
            pass: Boolean(
              first?.connectionAfter?.airportChange === 'no' &&
              first.connectionAfter.selfTransfer === 'no' &&
              middle?.technicalStops?.some((stop) => /\bZRH\b/i.test(stop.airport)) &&
              middle.connectionAfter?.airportChange === 'yes' &&
              middle.connectionAfter.selfTransfer === 'yes' &&
              /\bFRA\b/i.test(middle.arrival.airport) &&
              last &&
              /\bHHN\b/i.test(last.departure.airport),
            ),
            evidence: JSON.stringify(journey ?? { journeys: journeys.length }),
          };
        },
        { failure: 'reasoning' },
      ),
    ];
  },
} satisfies typeof definition;
