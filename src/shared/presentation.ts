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
    if (value.type === 'diagram') {
      const nodes = value.nodes.map((node) => node.id);
      if (!unique(nodes)) invalid('Diagram node IDs must be unique.');
      if (value.edges.some((edge) => !nodes.includes(edge.from) || !nodes.includes(edge.to)))
        invalid('Diagram edges must reference existing nodes.');
    }
  });

export const presentationInputSchema = z
  .discriminatedUnion('type', [
    flightsPresentation.extend({
      options: z
        .array(
          flightsPresentation.shape.options.element.extend({
            status: flightsPresentation.shape.options.element.shape.status.unwrap(),
          }),
        )
        .min(1)
        .max(8),
    }),
    ...presentationSchema.options.filter((schema) => schema !== flightsPresentation),
  ])
  .pipe(presentationSchema);

export type Presentation = z.infer<typeof presentationSchema>;

export function presentationImages(
  value: Presentation,
): Array<{ artifactId: string; alt: string }> {
  if (value.type === 'image') return [value];
  if (value.type === 'booking')
    return [value, ...(value.alternatives ?? [])].flatMap((venue) => venue.photos ?? []);
  return [];
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

export function presentationText(value: Presentation) {
  const lines = [value.title];
  if (value.caption) lines.push(value.caption);
  if (value.asOf) lines.push(value.asOf);
  if (value.type === 'image') lines.push(value.alt);
  if (value.type === 'apps') lines.push(`Connect in Apps: ${value.services.join(', ')}`);
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
            rating.count === undefined ? undefined : `${rating.count} reviews`,
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
  if (value.type === 'chart') {
    for (const label of [value.xLabel, value.yLabel]) if (label) lines.push(label);
    for (const series of value.series)
      lines.push(
        `${series.label}: ${series.points.map((point) => `${point.label}: ${point.value}${value.unit ? ` ${value.unit}` : ''}`).join('; ')}`,
      );
  }
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
