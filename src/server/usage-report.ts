import { clockOptions } from '../shared/date-locale.ts';
import type { TrustEntry, TrustView } from '../shared/trust.ts';

export interface UsageReport {
  view: TrustView;
  entries: TrustEntry[];
  timeZone: string;
  locale: string;
  hourCycle: 'auto' | 'h12' | 'h23';
}

const dollars = (value: number) =>
  value > 0 && value < 0.01
    ? '<$0.01'
    : `$${Number.isInteger(value) && value >= 1 ? value : value.toFixed(2)}`;

const plan = (planUsd: number) => (planUsd > 0 ? ' beyond your ChatGPT plan' : '');

function summary(view: TrustView) {
  const { week } = view;
  const actions = week.actions
    ? ` It used your apps ${week.actions === 1 ? 'once' : `${week.actions} times`}.`
    : '';
  return `In the last 7 days, Nod did ${week.things} ${week.things === 1 ? 'thing' : 'things'}.${actions} It spent ${week.spentUsd > 0 ? dollars(week.spentUsd) : 'nothing'}${plan(week.planUsd)}.`;
}

function month({ view, timeZone, locale }: UsageReport) {
  const name = new Date(view.month.start).toLocaleDateString(locale, {
    month: 'long',
    year: 'numeric',
    timeZone,
  });
  const { limit, month } = view;
  const amount =
    limit || month.spentUsd > 0
      ? `${dollars(month.spentUsd)}${limit ? ` of a ${dollars(limit.monthlyUsd)} limit` : ''}`
      : 'nothing';
  const notes = [
    month.planUsd > 0 &&
      ` Your ChatGPT plan covered about ${dollars(month.planUsd)}${month.spentUsd > 0 ? ' more' : ''} at API prices.`,
    month.unpriced && ' Some usage has no price in Nod, such as a local or free model.',
    month.backgroundUsd > 0 && ` Background work cost ${dollars(month.backgroundUsd)}.`,
  ]
    .filter(Boolean)
    .join('');
  const spent = `${name}: ${amount}${plan(month.planUsd)}.${notes}`;
  if (limit?.reached)
    return `${spent} The limit is reached, so new chat and background requests pause until next month. Raise or remove the limit in Usage to resume. Running turns can finish.`;
  if (!month.spentUsd) return spent;
  const over = limit && month.forecastUsd > limit.monthlyUsd ? ', above your limit' : '';
  return `${spent} On track for ${dollars(month.forecastUsd)}${over}.`;
}

export function usageFileName(exported: Date) {
  return `nod-usage-${exported.toISOString().slice(0, 10)}.pdf`;
}

const winAnsi = new Map(
  [...'€ ‚ƒ„…†‡ˆ‰Š‹Œ Ž  ‘’“”•–—˜™š›œ žŸ']
    .map((char, index) => [char, 0x80 + index] as const)
    .filter(([char]) => char !== ' '),
);

function pdfText(value: string) {
  const bytes = [
    ...value.replace(/ ?(?:(?![©®™])[\p{Extended_Pictographic}\u200d\ufe0f])+/gu, ''),
  ].map((char) => {
    const code = char.codePointAt(0)!;
    const mapped =
      winAnsi.get(char) ?? ((code >= 32 && code < 127) || (code >= 160 && code <= 255) ? code : 63);
    const byte = String.fromCharCode(mapped);
    return mapped === 40 || mapped === 41 || mapped === 92 ? `\\${byte}` : byte;
  });
  return `(${bytes.join('')})`;
}

const width = (text: string, size: number) =>
  ([...text].reduce((sum, char) => sum + ({ '.': 278, '<': 584, '-': 333 }[char] ?? 556), 0) *
    size) /
  1000;

function wrap(text: string, size: number, room: number) {
  const rows: string[] = [];
  let row = '';
  for (const word of text.split(' ')) {
    const next = row ? `${row} ${word}` : word;
    if (row && width(next, size) > room) {
      rows.push(row);
      row = word;
    } else row = next;
  }
  return [...rows, row];
}

function fit(text: string, size: number, room: number) {
  if (width(text, size) <= room) return text;
  let cut = text;
  while (cut && width(`${cut}…`, size) > room) cut = cut.slice(0, -1);
  return `${cut}…`;
}

export function usagePdf(report: UsageReport, exported: Date) {
  const { view, entries, timeZone, locale } = report;
  const lines: Array<[number, number, string, number, string?]> = [];
  const pages: (typeof lines)[] = [lines];
  let y = 790;
  const line = (text: string, size = 10, bold = false, gap = 16, cost?: string) => {
    if (y < 60) {
      pages.push([]);
      y = 790;
    }
    pages
      .at(-1)!
      .push([
        y,
        size,
        cost ? fit(text, size, 539 - width(cost, size) - 68) : text,
        bold ? 2 : 1,
        cost,
      ]);
    y -= gap;
  };
  line('Nod usage', 20, true, 30);
  line(
    `Exported ${exported.toLocaleString(locale, { day: 'numeric', month: 'long', year: 'numeric', ...clockOptions(locale, report.hourCycle), timeZone })}`,
    9,
    false,
    24,
  );
  for (const text of [summary(view), month(report)]) {
    const rows = wrap(text, 10, 483);
    rows.forEach((row, index) => line(row, 10, false, index === rows.length - 1 ? 16 : 13));
  }
  y -= 12;
  line('This month’s runs', 12, true, 22);
  let day = '';
  for (const entry of entries) {
    const at = new Date(entry.at);
    const label = at.toLocaleDateString(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone,
    });
    if (label !== day) {
      day = label;
      y -= 6;
      line(label, 9, true, 14);
    }
    const time = at.toLocaleTimeString(locale, {
      ...clockOptions(locale, report.hourCycle),
      timeZone,
    });
    const did = [...new Set(entry.actions.map((action) => action.label))].join(', ');
    line(
      `${time}  ${entry.title}${did ? ` (${did})` : ''}`,
      9,
      false,
      14,
      entry.costUsd !== null
        ? dollars(entry.costUsd)
        : entry.pricing === 'plan'
          ? 'ChatGPT plan'
          : entry.pricing === 'unpriced'
            ? 'No price'
            : '-',
    );
  }
  if (!entries.length) line('Nothing yet this month.', 9);
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  const fonts = ['Helvetica', 'Helvetica-Bold'].map(
    (name) => `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`,
  );
  objects.push(...fonts);
  const kids: number[] = [];
  for (const page of pages) {
    const stream = page
      .map(
        ([top, size, text, font, cost]) =>
          `BT /F${font} ${size} Tf 56 ${top} Td ${pdfText(text)} Tj ET` +
          (cost
            ? ` BT /F1 ${size} Tf ${539 - width(cost, size)} ${top} Td ${pdfText(cost)} Tj ET`
            : ''),
      )
      .join('\n');
    objects.push(
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    );
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${objects.length} 0 R >>`,
    );
    kids.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(body, 'latin1');
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
