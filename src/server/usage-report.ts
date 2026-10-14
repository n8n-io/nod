import { clockOptions } from '../shared/date-locale.ts';
import type { TrustEntry, TrustView } from '../shared/trust.ts';
import { pdfFile, textWidth, type PdfText } from './pdf.ts';

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

function summary(view: TrustView) {
  const { week } = view;
  const reached = week.reached
    ? ` ${week.reached === 1 ? '1 reached someone' : `${week.reached} reached people`}, all on your say-so.`
    : '';
  return `In the last 7 days, Otto did ${week.things} ${week.things === 1 ? 'thing' : 'things'}.${reached} It spent ${dollars(week.spentUsd)}.`;
}

function month({ view, timeZone, locale }: UsageReport) {
  const name = new Date(view.month.start).toLocaleDateString(locale, {
    month: 'long',
    year: 'numeric',
    timeZone,
  });
  const { limit } = view;
  const spent = `${name}: ${dollars(view.month.spentUsd)}${limit ? ` of a ${dollars(limit.monthlyUsd)} limit` : ''}.`;
  if (limit?.reached)
    return `${spent} The limit is reached, so new chat and background requests pause until next month. Raise or remove the limit in Settings › Trust to resume. Running turns can finish.`;
  const over = limit && view.month.forecastUsd > limit.monthlyUsd ? ', above your limit' : '';
  return `${spent} On track for ${dollars(view.month.forecastUsd)}${over}.`;
}

export function usageDigest(report: UsageReport, link: string | null) {
  return [
    summary(report.view),
    month(report),
    report.view.month.unpriced ? 'Some usage has no price, so it isn’t counted.' : '',
    `The PDF lists this month’s runs.${link ? ` Open Trust: ${link}` : ''}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function usageFileName(exported: Date) {
  return `otto-usage-${exported.toISOString().slice(0, 10)}.pdf`;
}

export function usagePdf(report: UsageReport, exported: Date) {
  const { view, entries, timeZone, locale } = report;
  const pages: PdfText[][] = [[]];
  let y = 790;
  const line = (text: string, size = 10, bold = false, gap = 16, cost?: string) => {
    if (y < 60) {
      pages.push([]);
      y = 790;
    }
    const page = pages.at(-1)!;
    page.push([
      56,
      y,
      size,
      bold ? 2 : 1,
      cost && text.length > 92 ? `${text.slice(0, 91)}…` : text,
    ]);
    if (cost) page.push([539 - textWidth(cost, size), y, size, 1, cost]);
    y -= gap;
  };
  line('Otto usage', 20, true, 30);
  line(
    `Exported ${exported.toLocaleString(locale, { day: 'numeric', month: 'long', year: 'numeric', ...clockOptions(locale, report.hourCycle), timeZone })}`,
    9,
    false,
    24,
  );
  for (const text of [summary(view), month(report)]) line(text, 10, false, 16);
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
    const did = [...new Set(entry.actions)].join(', ');
    line(
      `${time}  ${entry.title}${did ? ` (${did})` : ''}`,
      9,
      false,
      14,
      entry.costUsd === null ? '-' : dollars(entry.costUsd),
    );
  }
  if (!entries.length) line('Nothing yet this month.', 9);
  return pdfFile(pages);
}
