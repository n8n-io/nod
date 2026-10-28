import { check } from '../scenario.ts';
import { inlineVisualScenario, presentations } from '../world/inline-visuals.ts';

const reference = '2027-02-10T18:30:00Z';
const places = [
  {
    name: 'Cedro Workspace',
    latitude: 38.7223,
    longitude: -9.1393,
    opens: '2027-02-10T09:00:00Z',
    closes: '2027-02-10T18:30:00Z',
  },
  {
    name: 'Olive Studio',
    latitude: 38.7241,
    longitude: -9.1425,
    opens: '2027-02-10T16:00:00Z',
    closes: '2027-02-10T20:00:00Z',
  },
  {
    name: 'Praca Reading Room',
    latitude: 38.7198,
    longitude: -9.1366,
    opens: '2027-02-10T19:00:00Z',
    closes: '2027-02-10T22:00:00Z',
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
  id: 'inline-visual-schedule-boundaries',
  title: 'Compare workspaces at a requested closing-time boundary',
  type: 'map',
  path: '/places/lisbon-dated-hours',
  request: (_date, source) =>
    `I need a workspace at 18:30 Lisbon time on 10 February 2027. Compare the three places on ${source}, show their locations and tell me which would be open then. I need a socket and step-free access. Don't book anything.`,
  body: () =>
    `<h2>Workspace schedule for 10 February 2027</h2><p>All times below are in Europe/Lisbon, UTC+00:00 on this date. Doors open at the listed opening instant and close at the listed closing instant. All three places have step-free entrances and charging sockets. These are posted hours, not live availability or guaranteed access.</p><table><tr><th>Place</th><th>Latitude</th><th>Longitude</th><th>Opens</th><th>Closes</th></tr>${places.map((place) => `<tr><td>${place.name}</td><td>${place.latitude}</td><td>${place.longitude}</td><td>${place.opens}</td><td>${place.closes}</td></tr>`).join('')}</table>`,
  expectedPlaces: places,
  criterion: `Assess the requested instant ${reference}, not the execution date or current clock. The independently calculated schedule statuses are ${JSON.stringify(expected)}. Recommend Olive Studio as the only place whose posted interval includes that instant. Cedro is closed exactly at its closing time; Praca has not opened yet. Preserve all three places and their actual hours. Distinguish a schedule-based inference from verified live availability, access, a route or a reservation. The presentation asOf must describe when this information was observed or published, not falsely label the requested comparison instant as the observation time.`,
});

export default {
  ...definition,
  world(clock: { now(): number }) {
    return { ...definition.world(clock), date: '2027-02-10' };
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
