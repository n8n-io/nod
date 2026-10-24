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
const airport = z.strictObject({ airport: text(80), time: text(80) });

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
    z.strictObject({
      ...common,
      type: z.literal('flights'),
      options: z
        .array(
          z.strictObject({
            id,
            airline: text(80),
            flightNumber: text(40).optional(),
            departure: airport,
            arrival: airport,
            duration: text(80),
            stops: text(120),
            price: text(80),
            baggage: text(200).optional(),
            url: url.optional(),
            recommended: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(8),
    }),
    z.strictObject({
      ...common,
      type: z.literal('seats'),
      aircraft: text(120).optional(),
      columns: z
        .array(
          z
            .string()
            .max(4)
            .regex(/^[A-Za-z0-9]*$/),
        )
        .min(1)
        .max(12),
      rows: z
        .array(
          z.strictObject({
            label: text(12),
            seats: z
              .array(
                z.strictObject({
                  column: text(4),
                  label: text(20),
                  status: z.enum(['available', 'unavailable', 'unknown']),
                  note: text(240).optional(),
                  price: text(80).optional(),
                }),
              )
              .min(1)
              .max(12),
          }),
        )
        .min(1)
        .max(60),
      recommended: text(20).optional(),
    }),
    z.strictObject({
      ...common,
      type: z.literal('booking'),
      name: text(160),
      status: z.enum(['option', 'pending', 'confirmed', 'cancelled']),
      facts: z
        .array(z.strictObject({ label: text(80), value: text(400) }))
        .min(1)
        .max(16),
      url: url.optional(),
    }),
    z.strictObject({
      ...common,
      type: z.literal('chart'),
      chart: z.enum(['bar', 'line']),
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
    if (value.type === 'map' && !unique(value.places.map((place) => place.id)))
      invalid('Place IDs must be unique.');
    if (value.type === 'flights' && !unique(value.options.map((option) => option.id)))
      invalid('Flight IDs must be unique.');
    if (value.type === 'seats') {
      const columns = value.columns.filter(Boolean);
      const seats = value.rows.flatMap((row) => row.seats);
      if (!columns.length || !unique(columns)) invalid('Seat columns must be named and unique.');
      if (!unique(value.rows.map((row) => row.label)) || !unique(seats.map((seat) => seat.label)))
        invalid('Seat and row labels must be unique.');
      if (
        value.rows.some((row) => !unique(row.seats.map((seat) => seat.column))) ||
        seats.some((seat) => !columns.includes(seat.column))
      )
        invalid('Each seat must use a different named column within its row.');
      if (value.recommended && !seats.some((seat) => seat.label === value.recommended))
        invalid('The recommended seat must exist.');
    }
    if (value.type === 'chart') {
      if (!unique(value.series.map((series) => series.id)))
        invalid('Chart series IDs must be unique.');
      if (value.series.some((series) => !unique(series.points.map((point) => point.label))))
        invalid('Chart point labels must be unique within each series.');
      if (value.chart === 'line') {
        const labels = JSON.stringify(value.series[0].points.map((point) => point.label));
        if (
          value.series.some(
            (series) => JSON.stringify(series.points.map((point) => point.label)) !== labels,
          )
        )
          invalid('Line series must use the same point labels in the same order.');
      }
    }
    if (value.type === 'diagram') {
      const nodes = value.nodes.map((node) => node.id);
      if (!unique(nodes)) invalid('Diagram node IDs must be unique.');
      if (value.edges.some((edge) => !nodes.includes(edge.from) || !nodes.includes(edge.to)))
        invalid('Diagram edges must reference existing nodes.');
    }
  });

export type Presentation = z.infer<typeof presentationSchema>;

export function presentationText(value: Presentation) {
  const lines = [value.title];
  if (value.caption) lines.push(value.caption);
  if (value.asOf) lines.push(value.asOf);
  if (value.type === 'image') lines.push(value.alt);
  if (value.type === 'map')
    for (const place of value.places)
      lines.push(
        [place.name, `${place.latitude}, ${place.longitude}`, place.description, place.url]
          .filter(Boolean)
          .join(' · '),
      );
  if (value.type === 'flights')
    for (const option of value.options)
      lines.push(
        [
          [option.airline, option.flightNumber].filter(Boolean).join(' '),
          `${option.departure.airport} ${option.departure.time} → ${option.arrival.airport} ${option.arrival.time}`,
          option.duration,
          option.stops,
          option.price,
          option.baggage,
          option.recommended ? 'Recommended' : undefined,
          option.url,
        ]
          .filter(Boolean)
          .join(' · '),
      );
  if (value.type === 'seats') {
    if (value.aircraft) lines.push(value.aircraft);
    lines.push(`Columns: ${value.columns.map((column) => column || 'aisle').join(' · ')}`);
    for (const row of value.rows)
      lines.push(
        `Row ${row.label}: ${row.seats
          .map((seat) =>
            [
              `${seat.column} (${seat.label})`,
              seat.status,
              seat.note,
              seat.price,
              seat.label === value.recommended ? 'Recommended' : undefined,
            ]
              .filter(Boolean)
              .join(' · '),
          )
          .join('; ')}`,
      );
  }
  if (value.type === 'booking') {
    lines.push(`${value.name} · ${value.status}`);
    for (const fact of value.facts) lines.push(`${fact.label}: ${fact.value}`);
    if (value.url) lines.push(value.url);
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
