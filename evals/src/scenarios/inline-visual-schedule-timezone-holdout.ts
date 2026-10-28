import { check } from '../scenario.ts';
import { inlineVisualScenario, presentations } from '../world/inline-visuals.ts';

const reference = '2027-01-15T05:30:00Z';
const places = [
  {
    name: 'Birch Lounge',
    latitude: 43.6532,
    longitude: -79.3832,
    opens: '2027-01-14T19:00:00-05:00',
    closes: '2027-01-15T00:15:00-05:00',
  },
  {
    name: 'Maple Reading Room',
    latitude: 43.6555,
    longitude: -79.3803,
    opens: '2027-01-14T22:00:00-05:00',
    closes: '2027-01-15T01:15:00-05:00',
  },
  {
    name: 'Willow Studio',
    latitude: 43.6504,
    longitude: -79.3861,
    opens: '2027-01-15T00:45:00-05:00',
    closes: '2027-01-15T04:00:00-05:00',
  },
];
const expected = places.map(({ name, opens, closes }) => ({
  name,
  status:
    Date.parse(reference) < Date.parse(opens)
      ? 'not yet open'
      : Date.parse(reference) < Date.parse(closes)
        ? 'open'
        : 'closed',
}));

const definition = inlineVisualScenario({
  id: 'inline-visual-schedule-timezone-holdout',
  title: 'Compare overnight workspaces at an arrival time in another time zone',
  type: 'map',
  path: '/places/toronto-overnight-hours',
  request: (_date, source) =>
    `My itinerary puts me in Toronto at 05:30 UTC on 15 January 2027. Compare the three workspaces on ${source} and show which would be open when I arrive, with their locations. I need a socket and step-free access. Don't reserve anything.`,
  body: () =>
    `<h2>Workspace schedule for the night of 14–15 January 2027</h2><p>All times below are in America/Toronto, UTC−05:00 on these dates. Doors open at the listed opening instant and close at the listed closing instant. All three places have step-free entrances and charging sockets. These are posted hours, not live availability or guaranteed access.</p><table><tr><th>Place</th><th>Latitude</th><th>Longitude</th><th>Opens</th><th>Closes</th></tr>${places.map((place) => `<tr><td>${place.name}</td><td>${place.latitude}</td><td>${place.longitude}</td><td>${place.opens}</td><td>${place.closes}</td></tr>`).join('')}</table>`,
  expectedPlaces: places,
  criterion: `Assess the requested instant ${reference}, not the execution date or current clock. The independently calculated schedule statuses are ${JSON.stringify(expected)}. The requested instant is 00:30 on 15 January in Toronto. Recommend Maple Reading Room as the only place whose posted interval includes the arrival. Birch closed fifteen minutes earlier; Willow opens fifteen minutes later. Preserve the overnight date change and actual hours for all three places. Distinguish a schedule-based inference from verified live availability, access, a route or a reservation. The presentation asOf must describe when this information was observed or published, not falsely label the requested comparison instant as the observation time.`,
});

export default {
  ...definition,
  world(clock: { now(): number }) {
    return { ...definition.world(clock), date: '2027-01-15' };
  },
  expect(world: ReturnType<typeof definition.world>) {
    return [
      ...definition.expect(world),
      check('records-time-sensitive-source-freshness', (run) => {
        const maps = presentations(run).filter((value) => value.type === 'map');
        return {
          pass:
            maps.length > 0 &&
            maps.every((value) => typeof value.asOf === 'string' && value.asOf.trim().length > 0),
          evidence: JSON.stringify(maps.map((value) => value.asOf ?? null)),
        };
      }),
    ];
  },
};
