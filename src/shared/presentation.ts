import { z } from 'zod';
import { previewableUrl } from './link-preview.ts';

const text = (length: number) =>
  z
    .string()
    .min(1)
    .max(length)
    .refine((value) => Boolean(value.trim()));
const id = text(40).regex(/^[A-Za-z0-9_-]+$/);
const url = text(2048)
  .refine((value) => Boolean(previewableUrl(value)?.startsWith('https://')), {
    message: 'Use a public HTTPS source without credentials or private links.',
  })
  .transform((value) => previewableUrl(value)!);
const common = {
  version: z.literal(1),
  title: text(120),
  caption: text(600).optional(),
  sources: z.array(z.strictObject({ label: text(100), url })).max(8),
  asOf: text(120).optional(),
};
const airport = z.strictObject({
  airport: text(80),
  date: text(40).optional(),
  time: text(80),
  timeZone: text(80).optional(),
  terminal: text(40).optional(),
});
const seat = z.strictObject({
  label: text(20),
  status: z.enum(['available', 'unavailable', 'unknown']),
  note: text(240).optional(),
  price: text(80).optional(),
});
const photo = z.strictObject({ artifactId: z.uuid(), alt: text(500) });
const booking = {
  name: text(160),
  status: z.enum(['option', 'pending', 'confirmed', 'cancelled']),
  facts: z
    .array(z.strictObject({ label: text(80), value: text(400) }))
    .min(1)
    .max(16),
  url: url.optional(),
  photos: z.array(photo).min(1).max(4).optional(),
  notes: z.array(text(300)).min(1).max(6).optional(),
  rating: z
    .strictObject({
      value: z.number().finite().min(0).max(100),
      scale: z.number().finite().positive().max(100),
      count: z.number().int().positive().max(1e9).optional(),
      sourceLabel: text(100),
      url,
      summary: text(600).optional(),
    })
    .optional(),
};

const flightsPresentation = z.strictObject({
  ...common,
  type: z.literal('flights'),
  options: z
    .array(
      z.strictObject({
        id,
        label: text(120).optional(),
        status: z
          .enum(['booked', 'option', 'unknown'])
          .describe(
            'booked for a confirmed purchased itinerary, option for a candidate, unknown when the booking state is not established.',
          )
          .optional(),
        bookingReference: text(80)
          .describe('A known booking reference, separate from the itinerary label.')
          .optional(),
        price: text(80)
          .describe('Include only when known and relevant; not required for booked itineraries.')
          .optional(),
        baggage: text(200).optional(),
        url: url.optional(),
        recommended: z.boolean().optional(),
        journeys: z
          .array(
            z.strictObject({
              id,
              label: text(80),
              duration: text(80).optional(),
              segments: z
                .array(
                  z.strictObject({
                    airline: text(80),
                    flightNumber: text(40).optional(),
                    operatedBy: text(80)
                      .describe(
                        'Operating carrier explicitly established by the source. Do not infer it from an unlabeled carrier name or the marketing airline; omit when unknown.',
                      )
                      .optional(),
                    aircraft: text(120).optional(),
                    cabin: text(80).optional(),
                    duration: text(80).optional(),
                    departure: airport,
                    arrival: airport,
                    technicalStops: z
                      .array(
                        z.strictObject({
                          airport: text(80),
                          duration: text(80).optional(),
                          details: text(300).optional(),
                        }),
                      )
                      .max(4)
                      .optional(),
                    connectionAfter: z
                      .strictObject({
                        duration: text(80).optional(),
                        airportChange: z.enum(['yes', 'no', 'unknown']),
                        selfTransfer: z.enum(['yes', 'no', 'unknown']),
                        details: text(400).optional(),
                      })
                      .optional(),
                  }),
                )
                .min(1)
                .max(8),
            }),
          )
          .min(1)
          .max(6),
      }),
    )
    .min(1)
    .max(8),
});

const bugReportPresentation = z.strictObject({
  ...common,
  type: z.literal('bug-report'),
  draftId: z.uuid(),
  summary: text(4000),
});

const instant = z.iso.datetime({ offset: true });
const scheduleRunPresentation = z.strictObject({
  ...common,
  type: z.literal('schedule-run'),
  scheduleId: z.uuid(),
  revision: z.number().int().nonnegative(),
  outcome: z.enum(['failed', 'ran']),
  dueAt: instant,
  startedAt: instant,
  skipped: z.array(z.strictObject({ at: instant, reason: z.enum(['stopped', 'paused']) })).max(100),
  reason: text(2400).optional(),
  code: text(40).optional(),
  link: z.enum(['server', 'models']).optional(),
  nextRunAt: instant.optional(),
  timeZone: text(80),
});
export type ScheduleRunPresentation = z.infer<typeof scheduleRunPresentation>;

const fact = z.strictObject({ label: text(80), value: text(400) });
const place = z.strictObject({
  place: text(80),
  time: text(40).optional(),
  note: text(80).optional(),
});
const status = z.strictObject({
  label: text(40),
  tone: z
    .enum(['new', 'waiting', 'done', 'failed'])
    .describe(
      'new for something needing the owner, waiting for an open request, done for settled, failed for blocked or refused.',
    ),
});
const pick = z
  .strictObject({ question: text(300), multiple: z.boolean().optional() })
  .describe(
    'Ask the owner to choose from this card. Each row (items) or column (compare) becomes an answer choice below it, and the turn waits for the answer.',
  );
const badge = text(24).describe(
  'A two or three word highlight such as Top pick, Cheapest or Closest. At most one or two per card.',
);
const journey = z.strictObject({
  label: text(80),
  summary: text(120).optional(),
  legs: z
    .array(
      z.strictObject({
        from: place,
        to: place,
        name: text(80).describe('The flight, train or service, e.g. BA 977.'),
        detail: text(160).optional(),
        after: text(160)
          .describe('The change or wait before the next leg, e.g. Change at LHR · 2 hr.')
          .optional(),
      }),
    )
    .min(1)
    .max(8),
});
const tags = z
  .array(text(24))
  .min(1)
  .max(3)
  .describe('Up to three short traits shown as chips, e.g. Terrace, Open late, €€.');
const itemsInput = z.strictObject({
  ...common,
  type: z.literal('items'),
  pick: pick.optional(),
  label: text(80).optional(),
  layout: z
    .enum(['list', 'tiles'])
    .describe('tiles shows two to six short options side by side as tiles; list is the default.')
    .optional(),
  ranked: z.boolean().describe('Number the rows as a ranking, best first.').optional(),
  items: z
    .array(
      z.strictObject({
        title: text(120).describe('Short scannable item name.'),
        sub: text(160)
          .describe('One concise subtitle line, e.g. neighbourhood · price tier.')
          .optional(),
        badge: badge.optional(),
        tags: tags.optional(),
        status: status.optional(),
        value: text(40)
          .describe('Short right-aligned figure or rating, e.g. €125 or 4.6 ★.')
          .optional(),
        valueSub: text(48)
          .describe('Brief context under value, e.g. OpenTable, 921 reviews.')
          .optional(),
        route: z
          .strictObject({
            from: place,
            to: place,
            middle: z
              .array(text(80))
              .min(1)
              .max(3)
              .describe('Places the trip passes through, in order.')
              .optional(),
            duration: text(40).optional(),
            stops: z
              .array(
                z.strictObject({ label: text(40), place: text(80), detail: text(160).optional() }),
              )
              .min(1)
              .max(4)
              .optional(),
          })
          .optional(),
        warning: text(200).optional(),
        location: z
          .strictObject({
            latitude: z.number().finite().min(-90).max(90),
            longitude: z.number().finite().min(-180).max(180),
          })
          .describe('Verified coordinates. When every item has one, the card shows them as pins.')
          .optional(),
        detail: text(360)
          .describe(
            'One or two short sentences when expanded; summarise ranges instead of listing raw slots.',
          )
          .optional(),
        facts: z.array(fact).min(1).max(12).optional(),
        journeys: z
          .array(journey)
          .min(1)
          .max(6)
          .describe('Legs of a trip with changes, shown as a timeline when expanded.')
          .optional(),
        url: url.optional(),
        image: z
          .union([photo, url])
          .describe(
            'For a product, stay, venue or place: its public page or image URL. Nod adds the picture.',
          )
          .optional(),
      }),
    )
    .min(1)
    .max(20),
  note: text(220)
    .describe('One short line of context not already in the title; omit if redundant.')
    .optional(),
});
const itemsPresentation = itemsInput.extend({
  map: z
    .strictObject({
      zoom: z.number().int().min(2).max(16),
      x: z.number().int(),
      y: z.number().int().min(0),
      columns: z.number().int().min(1).max(4),
      tiles: z
        .array(z.strictObject({ artifactId: z.uuid(), alt: text(500) }))
        .min(1)
        .max(8),
    })
    .optional(),
});

export const mapTileSize = 256;

const wrap = (value: number, size: number) => ((value % size) + size) % size;

export function mapPoint(
  location: { latitude: number; longitude: number },
  zoom: number,
  frameX?: number,
) {
  const size = mapTileSize * 2 ** zoom;
  const sin = Math.sin((Math.max(-85, Math.min(85, location.latitude)) * Math.PI) / 180);
  const x = ((location.longitude + 180) / 360) * size;
  return {
    x: frameX === undefined ? x : frameX * mapTileSize + wrap(x - frameX * mapTileSize, size),
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  };
}

export function mapFrame(
  locations: Array<{ latitude: number; longitude: number }>,
  columns = 4,
  rows = 2,
) {
  if (!locations.length) return null;
  const pad = 36;
  const longitudes = locations
    .map((location) => wrap(location.longitude, 360))
    .sort((a, b) => a - b);
  const gaps = longitudes.map(
    (value, index) => (longitudes[index + 1] ?? longitudes[0]! + 360) - value,
  );
  const west = longitudes[(gaps.indexOf(Math.max(...gaps)) + 1) % longitudes.length]!;
  const unwrapped = locations.map((location) => ({
    latitude: location.latitude,
    longitude: west + wrap(location.longitude - west, 360),
  }));
  for (let zoom = 16; zoom >= 2; zoom--) {
    const points = unwrapped.map((location) => mapPoint(location, zoom));
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const x = Math.round(centerX / mapTileSize - columns / 2);
    const y = Math.max(0, Math.min(2 ** zoom - rows, Math.round(centerY / mapTileSize - rows / 2)));
    const fits = points.every(
      (point) =>
        point.x >= x * mapTileSize + pad &&
        point.x <= (x + columns) * mapTileSize - pad &&
        point.y >= y * mapTileSize + pad &&
        point.y <= (y + rows) * mapTileSize - pad,
    );
    if (fits) return { zoom, x: wrap(x, 2 ** zoom), y, columns, rows };
  }
  return null;
}
const schedulePresentation = z.strictObject({
  ...common,
  type: z.literal('schedule'),
  items: z
    .array(
      z.strictObject({
        day: text(40)
          .describe('The day this item belongs to, e.g. Sat 28 Nov; items group under it.')
          .optional(),
        start: text(40),
        end: text(40).optional(),
        title: text(120),
        detail: text(180).optional(),
        quiet: z.boolean().describe('Free time, travel or a tentative block.').optional(),
        clash: z.boolean().describe('Overlaps another item.').optional(),
      }),
    )
    .min(1)
    .max(24),
  note: text(220)
    .describe('One short line of context not already in the title; omit if redundant.')
    .optional(),
});
const factsPresentation = z.strictObject({
  ...common,
  type: z.literal('facts'),
  status: status
    .describe('Only a state the evidence establishes, such as Confirmed or Pending.')
    .optional(),
  stats: z
    .array(
      z.strictObject({
        label: text(40),
        value: text(24).describe('A short figure, e.g. €1,240, 4.6 ★, 12 days.'),
        sub: text(60).optional(),
      }),
    )
    .min(1)
    .max(4)
    .describe('One to four headline figures shown large above the details.')
    .optional(),
  items: z
    .array(fact.extend({ strong: z.boolean().describe('A total or the key figure.').optional() }))
    .max(20)
    .optional(),
  note: text(220)
    .describe('One short line of context not already in the title; omit if redundant.')
    .optional(),
});
const comparePresentation = z.strictObject({
  ...common,
  type: z.literal('compare'),
  pick: pick.optional(),
  columns: z
    .array(
      z.union([
        text(60),
        z.strictObject({
          label: text(60),
          sub: text(60).describe('One short line under the name, e.g. the price.').optional(),
          image: z
            .union([photo, url])
            .describe('A direct https photo of it you saw. Nod adds the picture.')
            .optional(),
          url: url.describe('Its own public product or listing page.').optional(),
        }),
      ]),
    )
    .min(2)
    .max(4),
  winner: z
    .number()
    .int()
    .min(0)
    .max(3)
    .describe('Column index of the recommended option, shown as the pick.')
    .optional(),
  rows: z
    .array(
      z.strictObject({
        label: text(60),
        values: z.array(text(80)).min(2).max(4),
        best: z
          .number()
          .int()
          .min(0)
          .max(3)
          .describe('Column index of the better value.')
          .optional(),
        amounts: z
          .array(z.number().finite().min(0).max(1e12))
          .min(2)
          .max(4)
          .describe('The values as numbers, to draw bars; one per column.')
          .optional(),
      }),
    )
    .min(1)
    .max(12),
  verdict: text(240).describe('The one-line recommendation, shown first.').optional(),
  note: text(220)
    .describe('One short line of context not already in the title; omit if redundant.')
    .optional(),
});

const appLink = text(2048).refine(
  (value) => value.startsWith('https://') && Boolean(previewableUrl(value)),
  { message: 'Use an HTTPS link to the draft in its app.' },
);
const draftPresentation = z.strictObject({
  ...common,
  type: z.literal('draft'),
  status: z
    .enum(['draft', 'sent', 'scheduled'])
    .describe('draft until it has really been sent or scheduled.'),
  via: text(40).describe('Where it lives, e.g. Gmail, Outlook, Slack.').optional(),
  from: text(320).optional(),
  to: z.array(text(320)).min(1).max(20),
  cc: z.array(text(320)).min(1).max(20).optional(),
  subject: text(300).optional(),
  body: text(8000).describe('The message exactly as written, with line breaks.'),
  attachments: z.array(text(160)).min(1).max(10).optional(),
  when: text(80).describe('Sent or scheduled time.').optional(),
  open: appLink.describe('Link that opens the draft or message in its app.').optional(),
});

export const compareColumn = (
  column:
    | string
    | {
        label: string;
        sub?: string;
        url?: string;
        image?: string | { artifactId: string; alt: string };
      },
) => (typeof column === 'string' ? { label: column } : column);

type PictureSlot = { url: string; fallback: boolean } | null;

const mapPage = (url: string) =>
  /^https:\/\/([^/]+\.)?(google\.[a-z.]+\/maps|maps\.google\.|maps\.app\.goo\.gl|goo\.gl\/maps|maps\.apple\.com|(www\.)?openstreetmap\.org|(www\.)?bing\.com\/maps)/i.test(
    url,
  );

const searchPage = (url: string) =>
  /\/(search|suche|s)(\/|$|\?)|[?&](q|query|search|fs|k|keywords?)=/i.test(url);

const ownPage = (url: string) => !mapPage(url) && !searchPage(url);

export function pictureSlots(value: Presentation | undefined): PictureSlot[] {
  if (value?.type === 'items')
    return value.items.map((item, index) => {
      if (index >= 8) return null;
      if (typeof item.image === 'string') return { url: item.image, fallback: false };
      if (!item.image && item.url && !item.route && ownPage(item.url))
        return { url: item.url, fallback: true };
      return null;
    });
  if (value?.type === 'compare')
    return value.columns.map((column) => {
      if (typeof column !== 'object') return null;
      if (typeof column.image === 'string') return { url: column.image, fallback: false };
      if (!column.image && column.url && ownPage(column.url))
        return { url: column.url, fallback: true };
      return null;
    });
  return [];
}

export function withPictures(
  value: Presentation,
  pictures: Array<{ artifactId: string; alt: string } | null | undefined>,
): Presentation {
  const place = <T extends { image?: unknown }>(entry: T, index: number) => {
    const picture = pictures[index];
    if (picture) return { ...entry, image: picture };
    if (typeof entry.image !== 'string') return entry;
    const { image: _, ...rest } = entry;
    return rest;
  };
  if (value.type === 'items') return { ...value, items: value.items.map(place) };
  if (value.type === 'compare')
    return {
      ...value,
      columns: value.columns.map((column, index) =>
        typeof column === 'string' ? column : place(column, index),
      ),
    };
  return value;
}

export const pictureAlt = (value: Presentation, index: number) =>
  value.type === 'items'
    ? (value.items[index]?.title ?? 'Picture')
    : value.type === 'compare'
      ? compareColumn(value.columns[index] ?? 'Picture').label
      : 'Picture';

export const bugReportReplyHint =
  'Reply "send" to share this summary with the Nod team, or ignore it. To add a diagnostic report, send it from Nod on your computer.';

export const presentationSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      ...common,
      type: z.literal('image'),
      artifactId: z.uuid(),
      alt: text(500),
    }),
    z.strictObject({
      ...common,
      type: z.literal('map'),
      places: z
        .array(
          z.strictObject({
            id,
            name: text(120),
            latitude: z.number().finite().min(-90).max(90),
            longitude: z.number().finite().min(-180).max(180),
            description: text(400).optional(),
            url: url.optional(),
          }),
        )
        .min(1)
        .max(12),
    }),
    flightsPresentation,
    z.strictObject({
      ...common,
      type: z.literal('seats'),
      aircraft: text(120).optional(),
      flight: text(200).optional(),
      coverage: z
        .strictObject({
          scope: z.enum(['full-aircraft', 'cabin', 'selection']),
          description: text(240),
        })
        .optional(),
      sections: z
        .array(
          z.strictObject({
            id,
            name: text(80),
            deck: text(40).optional(),
            rows: z
              .array(
                z.strictObject({
                  label: text(12),
                  groups: z.array(z.array(seat.nullable()).min(1).max(12)).min(1).max(4),
                }),
              )
              .min(1)
              .max(60),
          }),
        )
        .min(1)
        .max(8),
      recommended: z.strictObject({ sectionId: id, seatLabel: text(20) }).optional(),
    }),
    z.strictObject({
      ...common,
      type: z.literal('booking'),
      ...booking,
      alternatives: z.array(z.strictObject(booking)).min(1).max(3).optional(),
    }),
    z.strictObject({
      ...common,
      type: z.literal('chart'),
      chart: z.enum(['bar', 'line', 'pie', 'donut']),
      xLabel: text(80).optional(),
      yLabel: text(80).optional(),
      unit: text(32).optional(),
      series: z
        .array(
          z.strictObject({
            id,
            label: text(120),
            points: z
              .array(
                z.strictObject({
                  label: text(80),
                  value: z.number().finite().min(-1e12).max(1e12),
                }),
              )
              .min(1)
              .max(24),
          }),
        )
        .min(1)
        .max(3),
    }),
    z.strictObject({
      ...common,
      type: z.literal('apps'),
      services: z
        .array(z.string().regex(/^[a-z][a-z0-9_]{0,79}$/))
        .min(1)
        .max(3),
    }),
    z.strictObject({
      ...common,
      type: z.literal('diagram'),
      nodes: z
        .array(z.strictObject({ id, label: text(120), detail: text(300).optional() }))
        .min(1)
        .max(20),
      edges: z.array(z.strictObject({ from: id, to: id, label: text(120).optional() })).max(32),
    }),
    itemsPresentation,
    schedulePresentation,
    factsPresentation,
    comparePresentation,
    draftPresentation,
    bugReportPresentation,
    scheduleRunPresentation,
  ])
  .superRefine((value, context) => {
    const invalid = (message: string) => context.addIssue({ code: 'custom', message });
    const unique = (values: string[]) => new Set(values).size === values.length;
    if (new TextEncoder().encode(JSON.stringify(value)).length > 24 * 1024)
      invalid('A presentation must fit within 24 KB.');
    if (value.type === 'apps' && !unique(value.services)) invalid('Apps must be unique.');
    if (value.type === 'map' && !unique(value.places.map((place) => place.id)))
      invalid('Place IDs must be unique.');
    if (value.type === 'flights') {
      if (!unique(value.options.map((option) => option.id))) invalid('Flight IDs must be unique.');
      for (const option of value.options) {
        if (!unique(option.journeys.map((journey) => journey.id)))
          invalid('Journey IDs must be unique within each option.');
        for (const journey of option.journeys) {
          for (const [index, segment] of journey.segments.entries()) {
            if (index < journey.segments.length - 1 && !segment.connectionAfter)
              invalid('Every connecting segment must describe the following connection.');
            if (index === journey.segments.length - 1 && segment.connectionAfter)
              invalid('The final segment cannot have a following connection.');
          }
        }
      }
    }
    if (value.type === 'seats') {
      if (!unique(value.sections.map((section) => section.id)))
        invalid('Seat section IDs must be unique.');
      if (value.sections.reduce((total, section) => total + section.rows.length, 0) > 60)
        invalid('A seat plan can contain at most 60 rows.');
      for (const section of value.sections) {
        const seats = section.rows
          .flatMap((row) => row.groups.flat())
          .filter((seat) => seat !== null);
        if (
          !unique(section.rows.map((row) => row.label)) ||
          !unique(seats.map((seat) => seat.label))
        )
          invalid('Seat and row labels must be unique within each section.');
        for (const row of section.rows) {
          if (!row.groups.some((group) => group.some((seat) => seat !== null)))
            invalid('Each row must contain a seat.');
          if (row.groups.reduce((total, group) => total + group.length, row.groups.length - 1) > 12)
            invalid('Each row can contain at most 12 positions including aisles.');
        }
      }
      if (value.recommended) {
        const recommended = value.recommended;
        const section = value.sections.find((section) => section.id === recommended.sectionId);
        if (
          !section?.rows.some((row) =>
            row.groups.some((group) => group.some((seat) => seat?.label === recommended.seatLabel)),
          )
        )
          invalid('The recommended seat must exist in its section.');
      }
    }
    if (value.type === 'booking')
      for (const venue of [value, ...(value.alternatives ?? [])])
        if (venue.rating && venue.rating.value > venue.rating.scale)
          invalid('A rating cannot exceed its source scale.');
    if (value.type === 'chart') {
      const first = value.series[0];
      if (!first) return;
      if (!unique(value.series.map((series) => series.id)))
        invalid('Chart series IDs must be unique.');
      if (value.series.some((series) => !unique(series.points.map((point) => point.label))))
        invalid('Chart point labels must be unique within each series.');
      if (value.chart === 'line') {
        const labels = JSON.stringify(first.points.map((point) => point.label));
        if (
          value.series.some(
            (series) => JSON.stringify(series.points.map((point) => point.label)) !== labels,
          )
        )
          invalid('Line series must use the same point labels in the same order.');
      }
      if (value.chart === 'pie' || value.chart === 'donut') {
        if (value.series.length !== 1)
          invalid('A pie or donut chart must contain exactly one series.');
        if (first.points.length > 12)
          invalid('A pie or donut chart can contain at most 12 slices.');
        if (value.series.some((series) => series.points.some((point) => point.value < 0)))
          invalid('Pie and donut values cannot be negative.');
        if (!first.points.some((point) => point.value > 0))
          invalid('A pie or donut chart must contain a positive value.');
      }
    }
    if (value.type === 'facts' && !value.items?.length && !value.stats?.length)
      invalid('A facts card needs items or stats.');
    if (
      value.type === 'compare' &&
      value.winner !== undefined &&
      value.winner >= value.columns.length
    )
      invalid('The winner must point to a column.');
    if (value.type === 'compare')
      for (const row of value.rows) {
        if (row.values.length !== value.columns.length)
          invalid('Each compare row needs one value per column.');
        if (row.amounts && row.amounts.length !== value.columns.length)
          invalid('Compare amounts need one number per column.');
        if (row.best !== undefined && row.best >= value.columns.length)
          invalid('The best value must point to a column.');
      }
    if (value.type === 'diagram') {
      const nodes = value.nodes.map((node) => node.id);
      if (!unique(nodes)) invalid('Diagram node IDs must be unique.');
      if (value.edges.some((edge) => !nodes.includes(edge.from) || !nodes.includes(edge.to)))
        invalid('Diagram edges must reference existing nodes.');
    }
  });

const notWrittenByPi = new Set([
  'flights',
  'map',
  'booking',
  'chart',
  'bug-report',
  'schedule-run',
]);

export const presentationInputSchema = z
  .discriminatedUnion('type', [
    itemsInput,
    ...presentationSchema.options.filter(
      (schema) => schema !== itemsPresentation && !notWrittenByPi.has(schema.shape.type.value),
    ),
  ])
  .pipe(presentationSchema)
  .refine((value) => !('pick' in value && value.pick) || pickLabels(value).length <= 6, {
    message: 'A card to pick from holds at most six rows. Show the best six.',
  });

function pickLabels(value: Presentation) {
  if (value.type === 'compare')
    return value.columns.map(compareColumn).map((column) => ({
      label: column.label,
      ...(column.sub ? { description: column.sub } : {}),
    }));
  if (value.type === 'items')
    return value.items.map((item) => {
      const times =
        item.route?.from.time && item.route.to.time
          ? `${item.route.from.time} → ${item.route.to.time}`
          : undefined;
      const description = [times, item.value, item.sub].filter(Boolean).join(' · ');
      return {
        label: clip(item.title, 120),
        ...(description ? { description: clip(description, 400) } : {}),
      };
    });
  return [];
}

export const draftSendLabel = 'Send it';

export function presentationChoices(value: Presentation) {
  if (value.type === 'compare') return pickLabels(value);
  if (value.type === 'draft' && value.status === 'draft') return [{ label: draftSendLabel }];
  if (value.type === 'items' && value.items.length >= 2 && value.items.length <= 6)
    return pickLabels(value);
  return [];
}

export function presentationPick(value: Presentation) {
  return (value.type === 'items' || value.type === 'compare') && value.pick
    ? { ...value.pick, choices: pickLabels(value) }
    : undefined;
}

export type Presentation = z.infer<typeof presentationSchema>;
type FlightsPresentation = z.infer<typeof flightsPresentation>;
type ItemsPresentation = z.infer<typeof itemsPresentation>;
type FlightSegment = FlightsPresentation['options'][number]['journeys'][number]['segments'][number];

const clip = (value: string, length: number) =>
  value.length > length ? `${value.slice(0, length - 1)}…` : value;
const changes = (count: number) => `${count} change${count === 1 ? '' : 's'}`;
const airportCode = (airport: string) => airport.match(/\(([A-Z]{3})\)\s*$/)?.[1] ?? airport;
const flightLeg = (segment: FlightSegment, airlines: number) => {
  const connection = segment.connectionAfter;
  const detail = [
    airlines > 1 && segment.flightNumber ? segment.airline : undefined,
    segment.duration,
    segment.operatedBy && `Operated by ${segment.operatedBy}`,
    ...(segment.technicalStops ?? []).map((stop) =>
      [`Technical stop ${airportCode(stop.airport)}`, stop.duration].filter(Boolean).join(' '),
    ),
  ]
    .filter(Boolean)
    .join(' · ');
  const after =
    connection &&
    [
      `Change at ${airportCode(segment.arrival.airport)}`,
      connection.duration ?? 'Duration not given',
      connection.airportChange === 'yes' && 'Airport change',
      connection.airportChange === 'unknown' && 'Airport change unknown',
      connection.selfTransfer === 'yes' && 'Self-transfer',
      connection.selfTransfer === 'unknown' && 'Self-transfer unknown',
    ]
      .filter(Boolean)
      .join(' · ');
  return {
    from: stop(segment.departure),
    to: stop(segment.arrival),
    name: clip(segment.flightNumber ?? segment.airline, 80),
    ...(detail ? { detail: clip(detail, 160) } : {}),
    ...(after ? { after: clip(after, 160) } : {}),
  };
};
const flightRisks = (segment: FlightSegment) => [
  ...(segment.connectionAfter?.airportChange === 'yes'
    ? [`Airport change at ${segment.arrival.airport}`]
    : []),
  ...(segment.connectionAfter?.selfTransfer === 'yes'
    ? [`Self-transfer at ${segment.arrival.airport}`]
    : []),
];
const stop = (place: FlightSegment['departure']) => ({
  place: clip(airportCode(place.airport), 80),
  time: clip(place.time, 40),
  ...(place.date ? { note: clip(place.date, 80) } : {}),
});

export function flightItems(value: FlightsPresentation): ItemsPresentation {
  return {
    version: 1,
    type: 'items',
    title: value.title,
    ...(value.caption ? { caption: value.caption } : {}),
    sources: value.sources,
    ...(value.asOf ? { asOf: value.asOf } : {}),
    items: value.options.map((option) => {
      const segments = option.journeys[0]!.segments;
      const first = segments[0]!;
      const last = segments.at(-1)!;
      const connections = segments.slice(0, -1);
      const risks = option.journeys.flatMap((journey) =>
        journey.segments
          .slice(0, -1)
          .flatMap(flightRisks)
          .map((risk) => (option.journeys.length > 1 ? `${journey.label}: ${risk}` : risk)),
      );
      const airlines = new Set(
        option.journeys.flatMap((journey) => journey.segments.map((s) => s.airline)),
      ).size;
      const journeys = option.journeys.map((journey) => {
        const summary = [
          journey.duration,
          journey.segments.length > 1
            ? changes(journey.segments.length - 1)
            : !journey.segments[0]!.technicalStops?.length && 'Nonstop',
        ]
          .filter(Boolean)
          .join(' · ');
        return {
          label: clip(journey.label, 80),
          ...(summary ? { summary: clip(summary, 120) } : {}),
          legs: journey.segments.map((segment) => flightLeg(segment, airlines)),
        };
      });
      const facts = [
        ...(option.bookingReference
          ? [{ label: 'Booking reference', value: option.bookingReference }]
          : []),
        ...(option.baggage ? [{ label: 'Baggage', value: option.baggage }] : []),
      ].map((fact) => ({ label: clip(fact.label, 80), value: clip(fact.value, 400) }));
      const sub = option.label;
      const duration =
        option.journeys[0]!.duration ?? (segments.length === 1 ? first.duration : undefined);
      return {
        title: clip(
          [
            ...new Set(
              option.journeys.flatMap((journey) => journey.segments.map((s) => s.airline)),
            ),
          ].join(' + '),
          120,
        ),
        ...(sub ? { sub: clip(sub, 160) } : {}),
        ...(option.recommended && option.status !== 'booked' && option.status !== 'unknown'
          ? { badge: 'Best' }
          : {}),
        ...(option.status === 'booked'
          ? { status: { label: 'Booked', tone: 'done' as const } }
          : {}),
        ...(option.price ? { value: clip(option.price, 40) } : {}),
        ...(connections.length
          ? {
              valueSub: clip(
                `${changes(connections.length)} · ${connections.map((segment) => airportCode(segment.arrival.airport)).join(', ')}`,
                48,
              ),
            }
          : !first.technicalStops?.length
            ? { valueSub: 'Nonstop' }
            : {}),
        route: {
          from: stop(first.departure),
          to: stop(last.arrival),
          ...(duration ? { duration: clip(duration, 40) } : {}),
          ...(connections.length
            ? {
                middle: connections
                  .slice(0, 3)
                  .map((segment) => clip(airportCode(segment.arrival.airport), 80)),
              }
            : {}),
        },
        ...(risks.length ? { warning: clip(risks.join('. '), 200) } : {}),
        journeys,
        ...(facts.length ? { facts } : {}),
        ...(option.url ? { url: option.url } : {}),
        ...(carrier(first.flightNumber)
          ? {
              image: `https://www.gstatic.com/flights/airline_logos/70px/${carrier(first.flightNumber)}.png`,
            }
          : {}),
      };
    }),
  };
}

const carrier = (flightNumber: string | undefined) =>
  flightNumber?.match(/^([A-Z0-9]{2})\s?\d/)?.[1];

export function presentationAttachments(
  value: Presentation,
): Array<{ artifactId: string; alt: string }> {
  if (value.type === 'image') return [value];
  if (value.type === 'booking')
    return [value, ...(value.alternatives ?? [])].flatMap((venue) => venue.photos ?? []);
  return [];
}

export function presentationImages(
  value: Presentation,
): Array<{ artifactId: string; alt: string }> {
  if (value.type === 'items')
    return [
      ...value.items.flatMap((item) =>
        item.image && typeof item.image === 'object' ? [item.image] : [],
      ),
      ...(value.map?.tiles ?? []),
    ];
  if (value.type === 'compare')
    return value.columns.flatMap((column) =>
      typeof column === 'object' && column.image && typeof column.image === 'object'
        ? [column.image]
        : [],
    );
  return presentationAttachments(value);
}

type FlightJourney = Extract<
  Presentation,
  { type: 'flights' }
>['options'][number]['journeys'][number];

export function flightJourneySummary(journey: FlightJourney) {
  const connections = journey.segments.length - 1;
  const technicalStops = journey.segments.reduce(
    (total, segment) => total + (segment.technicalStops?.length ?? 0),
    0,
  );
  const complete = journey.segments.every((segment) => segment.technicalStops !== undefined);
  if (!connections && !technicalStops && complete) return 'Nonstop';
  return [
    connections ? `${connections} connection${connections === 1 ? '' : 's'}` : 'No connections',
    technicalStops
      ? `${technicalStops} ${complete ? '' : 'reported '}technical stop${technicalStops === 1 ? '' : 's'}`
      : undefined,
    !complete ? 'Technical stop details not provided' : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function mapLocationUrl(place: { latitude: number; longitude: number }) {
  return `https://www.openstreetmap.org/?mlat=${place.latitude}&mlon=${place.longitude}#map=15/${place.latitude}/${place.longitude}`;
}

export function reviewCount(count: number) {
  return `${count.toLocaleString()} ${count === 1 ? 'review' : 'reviews'}`;
}

export function presentationText(value: Presentation) {
  if (value.type === 'schedule-run') return '';
  const lines = [value.title];
  if (value.caption) lines.push(value.caption);
  if (value.asOf) lines.push(value.asOf);
  if (value.type === 'image') lines.push(value.alt);
  if (value.type === 'apps') lines.push(`Connect in Apps: ${value.services.join(', ')}`);
  if (value.type === 'bug-report') lines.push(value.summary, '', bugReportReplyHint);
  if (value.type === 'map')
    for (const place of value.places)
      lines.push(
        [
          place.name,
          `${place.latitude}, ${place.longitude}`,
          place.description,
          mapLocationUrl(place),
          place.url,
        ]
          .filter(Boolean)
          .join(' · '),
      );
  if (value.type === 'flights') {
    for (const option of value.options) {
      lines.push(
        '',
        [
          option.label,
          option.status === 'booked'
            ? 'Booked'
            : option.status === 'unknown'
              ? 'Booking status unknown'
              : undefined,
          option.bookingReference ? `Booking reference: ${option.bookingReference}` : undefined,
          option.price,
          option.baggage,
          option.recommended && option.status !== 'booked' && option.status !== 'unknown'
            ? 'Recommended'
            : undefined,
          option.url,
        ]
          .filter(Boolean)
          .join(' · '),
      );
      for (const journey of option.journeys) {
        lines.push(
          [journey.label, journey.duration, flightJourneySummary(journey)]
            .filter(Boolean)
            .join(' · '),
        );
        for (const segment of journey.segments) {
          const endpoint = (point: typeof segment.departure) =>
            [
              point.airport,
              point.date || 'Date not provided',
              point.time,
              point.timeZone || 'Time zone not provided',
              point.terminal ? `Terminal ${point.terminal}` : undefined,
            ]
              .filter(Boolean)
              .join(' · ');
          lines.push(
            [
              [segment.airline, segment.flightNumber].filter(Boolean).join(' '),
              segment.operatedBy ? `Operated by ${segment.operatedBy}` : undefined,
              segment.aircraft,
              segment.cabin,
              segment.duration,
              `${endpoint(segment.departure)} → ${endpoint(segment.arrival)}`,
            ]
              .filter(Boolean)
              .join(' · '),
          );
          for (const stop of segment.technicalStops ?? [])
            lines.push(
              [`Technical stop: ${stop.airport}`, stop.duration, stop.details]
                .filter(Boolean)
                .join(' · '),
            );
          if (segment.connectionAfter) {
            const connection = segment.connectionAfter;
            lines.push(
              [
                'Connection',
                connection.duration,
                `Airport change: ${connection.airportChange}`,
                `Self-transfer: ${connection.selfTransfer}`,
                connection.details,
              ]
                .filter(Boolean)
                .join(' · '),
            );
          }
        }
      }
    }
  }
  if (value.type === 'seats') {
    if (value.aircraft) lines.push(value.aircraft);
    if (value.flight) lines.push(value.flight);
    if (value.coverage)
      lines.push(`Coverage: ${value.coverage.scope} · ${value.coverage.description}`);
    for (const section of value.sections) {
      lines.push([section.name, section.deck].filter(Boolean).join(' · '));
      for (const row of section.rows) {
        const groups = row.groups.map((group) =>
          group
            .map((seat) => {
              if (!seat) return 'Empty position';
              return [
                seat.label,
                seat.status,
                seat.note,
                seat.price,
                section.id === value.recommended?.sectionId &&
                seat.label === value.recommended.seatLabel
                  ? 'Recommended'
                  : undefined,
              ]
                .filter(Boolean)
                .join(' · ');
            })
            .join('; '),
        );
        lines.push(`Row ${row.label}: ${groups.join(' | aisle | ')}`);
      }
    }
  }
  if (value.type === 'booking') {
    for (const venue of [value, ...(value.alternatives ?? [])]) {
      lines.push(`${venue.name} · ${venue.status}`);
      for (const fact of venue.facts) lines.push(`${fact.label}: ${fact.value}`);
      for (const photo of venue.photos ?? []) lines.push(`Image: ${photo.alt}`);
      for (const note of venue.notes ?? []) lines.push(note);
      if (venue.rating) {
        const rating = venue.rating;
        lines.push(
          [
            `Rating: ${rating.value}/${rating.scale}`,
            rating.count === undefined ? undefined : reviewCount(rating.count),
            `${rating.sourceLabel}: ${rating.url}`,
            rating.summary,
          ]
            .filter(Boolean)
            .join(' · '),
        );
      }
      if (venue.url) lines.push(venue.url);
    }
  }
  if (value.type === 'draft') {
    lines.push(
      [
        value.status === 'draft'
          ? 'Draft, not sent'
          : value.status === 'sent'
            ? 'Sent'
            : 'Scheduled',
        value.via,
        value.when,
      ]
        .filter(Boolean)
        .join(' · '),
    );
    if (value.from) lines.push(`From: ${value.from}`);
    lines.push(`To: ${value.to.join(', ')}`);
    if (value.cc) lines.push(`Cc: ${value.cc.join(', ')}`);
    if (value.subject) lines.push(`Subject: ${value.subject}`);
    lines.push('', value.body, '');
    if (value.attachments) lines.push(`Attachments: ${value.attachments.join(', ')}`);
    if (value.open) lines.push(value.open);
  }
  if (value.type === 'chart') {
    for (const label of [value.xLabel, value.yLabel]) if (label) lines.push(label);
    for (const series of value.series)
      lines.push(
        `${series.label}: ${series.points.map((point) => `${point.label}: ${point.value}${value.unit ? ` ${value.unit}` : ''}`).join('; ')}`,
      );
  }
  if (value.type === 'items') {
    if (value.label) lines.push(value.label);
    for (const item of value.items) {
      lines.push(
        [
          item.title,
          item.badge,
          item.status?.label,
          item.sub,
          item.tags?.join(', '),
          [item.value, item.valueSub].filter(Boolean).join(' '),
          item.route &&
            [
              `${[item.route.from.time, item.route.from.place].filter(Boolean).join(' ')} → ${[item.route.to.time, item.route.to.place, item.route.to.note].filter(Boolean).join(' ')}`,
              item.route.middle && `via ${item.route.middle.join(', ')}`,
            ]
              .filter(Boolean)
              .join(' '),
          item.location && mapLocationUrl(item.location),
          item.url,
        ]
          .filter(Boolean)
          .join(' · '),
      );
      for (const stop of item.route?.stops ?? [])
        lines.push([stop.label, stop.place, stop.detail].filter(Boolean).join(' · '));
      if (item.warning) lines.push(item.warning);
      if (item.detail) lines.push(item.detail);
      for (const journey of item.journeys ?? []) {
        lines.push([journey.label, journey.summary].filter(Boolean).join(' · '));
        for (const leg of journey.legs) {
          lines.push(
            [
              leg.name,
              `${[leg.from.place, leg.from.time, leg.from.note].filter(Boolean).join(' ')} → ${[leg.to.place, leg.to.time, leg.to.note].filter(Boolean).join(' ')}`,
              leg.detail,
            ]
              .filter(Boolean)
              .join(' · '),
          );
          if (leg.after) lines.push(leg.after);
        }
      }
      for (const fact of item.facts ?? []) lines.push(`${fact.label}: ${fact.value}`);
    }
  }
  if (value.type === 'schedule') {
    for (const item of value.items)
      lines.push(
        [
          item.day,
          [item.start, item.end].filter(Boolean).join('–'),
          item.title,
          item.detail,
          item.clash ? 'Clash' : undefined,
        ]
          .filter(Boolean)
          .join(' · '),
      );
  }
  if (value.type === 'facts') {
    if (value.status) lines.push(value.status.label);
    for (const stat of value.stats ?? [])
      lines.push([`${stat.label}: ${stat.value}`, stat.sub].filter(Boolean).join(' · '));
    for (const item of value.items ?? []) lines.push(`${item.label}: ${item.value}`);
  }
  if (value.type === 'compare') {
    if (value.verdict) lines.push(value.verdict);
    lines.push(
      value.columns
        .map(compareColumn)
        .map((column, index) =>
          [column.label, column.sub, index === value.winner ? '(pick)' : undefined]
            .filter(Boolean)
            .join(' '),
        )
        .join(' | '),
    );
    for (const row of value.rows) lines.push(`${row.label}: ${row.values.join(' | ')}`);
    for (const column of value.columns.map(compareColumn))
      if (column.url) lines.push(`${column.label}: ${column.url}`);
  }
  if ('note' in value && value.note) lines.push(value.note);
  if (value.type === 'diagram') {
    let labels = new Map(
      value.nodes.map((node) => [
        node.id,
        value.nodes.some((other) => other.id !== node.id && other.label === node.label)
          ? `${node.label} (${node.id})`
          : node.label,
      ]),
    );
    if (new Set(labels.values()).size !== labels.size)
      labels = new Map(value.nodes.map((node) => [node.id, `[${node.id}] ${node.label}`]));
    for (const node of value.nodes)
      lines.push([labels.get(node.id), node.detail].filter(Boolean).join(': '));
    for (const edge of value.edges)
      lines.push(
        [`${labels.get(edge.from)} → ${labels.get(edge.to)}`, edge.label]
          .filter(Boolean)
          .join(': '),
      );
  }
  for (const source of value.sources) lines.push(`${source.label}: ${source.url}`);
  return lines.join('\n');
}
