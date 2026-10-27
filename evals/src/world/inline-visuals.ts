import { isDeepStrictEqual } from 'node:util';
import { check, judge, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { textPng } from './png.ts';
import { page, type Site } from './sites.ts';
import { inDays, localDate } from './time.ts';

const host = 'journeys.visual-fixture.example.net';
type Visual = Record<string, unknown> & { type: string };

export function presentations(run: Run): Visual[] {
  return run.messages.flatMap((message) => {
    const value = message.presentation;
    return message.role === 'assistant' &&
      value &&
      typeof value === 'object' &&
      'type' in value &&
      typeof value.type === 'string'
      ? [value as Visual]
      : [];
  });
}

interface Case {
  id: string;
  title: string;
  type: 'image' | 'map' | 'flights' | 'seats' | 'booking' | 'diagram';
  path: string;
  request(date: string, source: string): string;
  body(date: string): string;
  criterion: string;
  image?: string[];
  expectedPlaces?: Array<{ name: string; latitude: number; longitude: number }>;
}

export function inlineVisualScenario(definition: Case) {
  return scenario({
    id: definition.id,
    title: definition.title,
    capabilities: ['research', 'files'],
    tier: 'release',
    calibration: 'pending',
    complexity: 'medium',
    stance: 'regression',
    seconds: 420,
    timeZone: 'Europe/Lisbon',
    user: { approve: false },
    world(clock) {
      const date = localDate(inDays(clock.now(), 14, 'Europe/Lisbon'), 'Europe/Lisbon');
      const source = `https://${host}${definition.path}`;
      const body = definition.body(date);
      const png = definition.image ? textPng(definition.image) : undefined;
      const site: Site = ({ url }) => {
        if (url.pathname === '/seat-plan.png' && png)
          return { headers: { 'Content-Type': 'image/png' }, body: png };
        if (url.pathname !== definition.path && url.pathname !== '/')
          return page('Not found', '<p>Page not found.</p>', 404);
        return page(
          definition.title,
          `<h1>${definition.title}</h1><p>Published ${new Date(clock.now()).toISOString()}. Synthetic reference data for the specified journey.</p>${body}`,
        );
      };
      return { sites: { [host]: site }, date, source, body };
    },
    async play(session, world) {
      await session.say(definition.request(world.date, world.source));
    },
    evidence(run, world) {
      return `Reference source: ${world.source}. Journey date: ${world.date}. The source contains:\n${world.body}\nPersisted presentations shown to the user:\n${JSON.stringify(presentations(run))}`;
    },
    expect(world) {
      return [
        check(
          'delivers-the-visual-in-chat',
          async (run) => {
            const saved = presentations(run).filter((value) => value.type === definition.type);
            if (!saved.length)
              return { pass: false, evidence: `No persisted ${definition.type} presentation.` };
            const state = await run.api('GET', '/api/state');
            const shown = (state.body.messages ?? []) as Array<{ presentation?: unknown }>;
            const matched = saved.filter((value) =>
              shown.some((message) => isDeepStrictEqual(message.presentation, value)),
            );
            return {
              pass: state.status === 200 && matched.length > 0,
              evidence: `${saved.length} persisted ${definition.type} presentations; ${matched.length} returned by the real chat API.`,
            };
          },
          { failure: 'format' },
        ),
        check(
          'keeps-the-reference-with-the-visual',
          (run) => {
            const found = presentations(run).filter((value) => value.type === definition.type);
            return {
              pass: found.some(
                (value) =>
                  Array.isArray(value.sources) &&
                  value.sources.some(
                    (source) => source && typeof source === 'object' && source.url === world.source,
                  ),
              ),
              evidence: JSON.stringify(found.map((value) => value.sources)),
            };
          },
          { failure: 'hallucination' },
        ),
        check(
          'reads-the-reference-without-making-a-reservation',
          (run) => ({
            pass:
              run.visits.some((visit) => visit.host === host && visit.path === definition.path) &&
              run.visits.every((visit) => ['GET', 'HEAD'].includes(visit.method)) &&
              run.writes.length === 0,
            evidence: `${run.visits.length} source requests; ${run.writes.length} external writes.`,
          }),
          { failure: 'scope' },
        ),
        ...(definition.expectedPlaces
          ? [
              check(
                'preserves-the-sourced-locations',
                (run) => {
                  const expected = definition.expectedPlaces!;
                  const name = (value: unknown) =>
                    ` ${
                      String(value ?? '')
                        .normalize('NFKD')
                        .replace(/\p{M}/gu, '')
                        .toLowerCase()
                        .match(/[\p{L}\p{N}]+/gu)
                        ?.join(' ') ?? ''
                    } `;
                  const found = presentations(run)
                    .filter((value) => value.type === 'map')
                    .map((value) =>
                      Array.isArray(value.places)
                        ? value.places.map((place) => ({
                            name: place?.name,
                            latitude: place?.latitude,
                            longitude: place?.longitude,
                          }))
                        : [],
                    );
                  const matched = found.map((places) =>
                    places.map((place) =>
                      expected.flatMap((source, index) =>
                        name(place.name).includes(name(source.name)) &&
                        place.latitude === source.latitude &&
                        place.longitude === source.longitude
                          ? [index]
                          : [],
                      ),
                    ),
                  );
                  return {
                    pass:
                      found.length > 0 &&
                      matched.every(
                        (places) =>
                          places.length > 0 &&
                          places.every((matches) => matches.length === 1) &&
                          new Set(places.flat()).size === places.length,
                      ) &&
                      new Set(matched.flat(2)).size === expected.length,
                    evidence: JSON.stringify({ expected, found }),
                  };
                },
                { failure: 'hallucination' },
              ),
            ]
          : []),
        ...(definition.type === 'image'
          ? [
              check('image-is-an-owned-available-file', async (run) => {
                const image = presentations(run).find((value) => value.type === 'image');
                if (typeof image?.artifactId !== 'string') return false;
                const result = await run.api(
                  'GET',
                  `/api/artifacts/${encodeURIComponent(image.artifactId)}/metadata`,
                );
                const state = await run.api('GET', '/api/state');
                const inThread =
                  state.status === 200 &&
                  typeof state.body.threadId === 'string' &&
                  run.artifacts.some(
                    (artifact) =>
                      artifact.id === image.artifactId && artifact.threadId === state.body.threadId,
                  );
                return {
                  pass:
                    result.status === 200 &&
                    /^image\//.test(String(result.body.mimeType)) &&
                    result.body.size > 500 &&
                    inThread,
                  evidence: `Artifact status ${result.status}, type ${String(result.body.mimeType)}, ${String(result.body.size)} bytes; belongs to current thread: ${inThread}.`,
                };
              }),
            ]
          : []),
        judge('helps-with-the-decision-without-inventing-facts', definition.criterion),
        judge(
          'answer-still-works-as-text',
          'The assistant text itself includes the answer and its material caveats, so a person receiving this over a plain-text messaging channel can understand it without the visual. Merely saying to see a card, map, picture, diagram or attachment fails. Raw presentation JSON or HTML must not appear in the normal answer text.',
          { failure: 'format' },
        ),
      ];
    },
  });
}
