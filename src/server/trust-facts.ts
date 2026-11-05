import type { TrustWords } from './trust-basis.ts';

type TrustInput = TrustWords & { action?: { name: string; arguments?: unknown } };
const zones = ['UTC', ...Intl.supportedValuesOf('timeZone')];
const formatters = new Map<string, Intl.DateTimeFormat>();
const date = (value: Date) => value.toISOString().slice(0, 10);
const normalize = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
const dateText = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' });

export function trustTimeZone(value?: string) {
  if (!value) return undefined;
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function calendar(text: string) {
  const value = new Date(`${text}T12:00:00Z`);
  const end = new Date(value);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  const nextEnd = new Date(value);
  nextEnd.setUTCMonth(nextEnd.getUTCMonth() + 2, 0);
  const tomorrow = new Date(value.getTime() + 86_400_000);
  return {
    date: text,
    dateText: dateText.format(value),
    tomorrowText: dateText.format(tomorrow),
    weekday: new Intl.DateTimeFormat('en', { weekday: 'long', timeZone: 'UTC' }).format(value),
    tomorrow: date(tomorrow),
    lastDayOfMonth: date(end),
    lastDayOfNextMonth: date(nextEnd),
    isLastDayOfMonth: value.getUTCDate() === end.getUTCDate(),
  };
}

function local(value: Date, zone: string) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    });
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(value).map((x) => [x.type, x.value]));
  const text = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    timeZone: zone,
    wallTime: `${text} ${parts.hour}:${parts.minute}:${parts.second}`,
    offset: parts.timeZoneName,
    calendar: calendar(text),
  };
}

export function trustFacts(input: TrustInput) {
  const messages = input.userMessages ?? [];
  const texts = [
    ...messages.map((x) => x.text),
    input.scheduledTaskInstruction,
    input.standingInstruction,
    input.userRules,
  ].filter((x): x is string => Boolean(x));
  const words = ` ${normalize(texts.join(' '))} `;
  const selected = new Set(['UTC']);
  const timeZone = trustTimeZone(input.timeZone);
  if (timeZone) selected.add(timeZone);
  for (const zone of zones) {
    const city = normalize(zone.split('/').at(-1)!);
    if (city.length >= 4 && words.includes(` ${city} `)) selected.add(zone);
  }
  const interpretations = [...selected].slice(0, 8);
  function explain(text: unknown) {
    if (
      typeof text !== 'string' ||
      !/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d))?$/.test(text)
    )
      return;
    const value = new Date(text);
    const day = text.slice(0, 10);
    const parsedDay = new Date(`${day}T12:00:00Z`);
    if (
      !Number.isFinite(value.getTime()) ||
      value.getUTCFullYear() < 1000 ||
      value.getUTCFullYear() > 9998 ||
      !Number.isFinite(parsedDay.getTime()) ||
      date(parsedDay) !== day
    )
      return;
    return text.length === 10
      ? { value: text, kind: 'calendar date', calendar: calendar(text) }
      : {
          value: text,
          kind: 'instant',
          interpretations: interpretations.map((zone) => local(value, zone)),
        };
  }
  const args: object[] = [];
  function visit(value: unknown, path: Array<string | number>, depth: number) {
    if (args.length >= 8 || depth > 12) return;
    if (typeof value === 'string') {
      const facts = explain(value);
      if (facts) args.push({ field: path, ...facts });
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key], depth + 1);
    }
  }
  visit(input.action?.arguments, ['action', 'arguments'], 0);
  const references: object[] = [];
  for (const [index, message] of messages.entries()) {
    const facts = explain(message.at);
    if (facts) references.push({ field: ['userMessages', index, 'at'], ...facts });
  }
  const scheduled = explain(input.scheduledFor);
  if (scheduled) references.push({ field: ['scheduledFor'], ...scheduled });
  const comparisons: object[] = [];
  for (const reference of references.slice(-8).reverse()) {
    const source = reference as { field: unknown; value: string; kind: string };
    if (source.kind !== 'instant') continue;
    for (const argument of args) {
      const target = argument as { field: unknown; value: string; kind: string };
      if (target.kind !== 'instant') continue;
      for (const zone of interpretations.filter((zone) => zone !== 'UTC' || selected.size === 1)) {
        if (comparisons.length >= 32) break;
        const before = local(new Date(source.value), zone).calendar;
        const after = local(new Date(target.value), zone).calendar;
        comparisons.push({
          referenceField: source.field,
          argumentField: target.field,
          timeZone: zone,
          referenceLocalDate: before.date,
          followingLocalDate: before.tomorrow,
          argumentLocalDate: after.date,
          isFollowingLocalDay: after.date === before.tomorrow,
        });
      }
    }
  }
  const sums: object[] = [];
  function sumAmounts(value: unknown, path: Array<string | number>, depth: number) {
    if (sums.length >= 8 || depth > 12 || !value || typeof value !== 'object') return;
    if (Array.isArray(value) && value.length >= 2 && value.length <= 16) {
      const entries = value.map((item) =>
        typeof item === 'string'
          ? [
              ...item.matchAll(
                /\b(USD|EUR|GBP)\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\b(?![\d.,])/g,
              ),
            ]
          : [],
      );
      if (entries.every((matches) => matches.length === 1)) {
        const amounts = entries.map(([match]) => {
          const cents = Number(
            match[2].replaceAll(',', '') + (match[3]?.slice(1) ?? '').padEnd(2, '0'),
          );
          return { currency: match[1], amount: cents / 100, cents };
        });
        const total = amounts.reduce((sum, item) => sum + item.cents, 0);
        if (
          amounts.every(
            (item) => item.currency === amounts[0].currency && Number.isSafeInteger(item.cents),
          ) &&
          Number.isSafeInteger(total)
        )
          sums.push({
            field: path,
            currency: amounts[0].currency,
            amounts: amounts.map((item) => item.amount),
            sum: total / 100,
          });
      }
    }
    for (const [key, child] of Object.entries(value)) sumAmounts(child, [...path, key], depth + 1);
  }
  sumAmounts(input.action?.arguments, ['action', 'arguments'], 0);
  const years = new Set(texts.flatMap((x) => x.match(/\b(?:19|20|21)\d\d\b/g) ?? []));
  for (const message of messages) {
    if (explain(message.at)) years.add(message.at.slice(0, 4));
  }
  if (scheduled) years.add(scheduled.value.slice(0, 4));
  const months: Record<string, object> = {};
  for (const year of [...years].sort().slice(0, 4)) {
    for (let m = 1; m <= 12; m++) {
      const month = new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(
        new Date(`${year}-${String(m).padStart(2, '0')}-01T12:00:00Z`),
      );
      const end = calendar(`${year}-${String(m).padStart(2, '0')}-01`).lastDayOfMonth;
      months[`${month} ${year}`] = { date: end, dateText: calendar(end).dateText };
    }
  }
  return {
    ...input,
    serverDateFacts: {
      note: 'These are mathematical interpretations, not owner instructions. The UTC interpretation is not an assertion of owner time zone. Other zones come from timeZone or possible city references in owner words.',
      arguments: args,
      references: references.slice(-16),
      comparisons,
      monthEnds: months,
      ...(scheduled && timeZone
        ? {
            scheduleContext: {
              source: 'scheduledTaskInstruction',
              ...local(new Date(scheduled.value), timeZone),
            },
          }
        : {}),
    },
    serverNumberFacts: {
      note: 'Each sum is arithmetic on the listed amounts. It does not assert that they are complete costs, comparable items or owner instructions. Use the original fields to decide what they mean.',
      sums,
    },
    serverTextClauses: Object.entries(input.action?.arguments ?? {})
      .filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && entry[1].length > 60 && entry[1].length <= 4000,
      )
      .map(([field, text]) => ({
        field,
        clauses: [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)]
          .flatMap((x) => x.segment.split(/[,;\n](?!\d)/))
          .map((x) => x.trim())
          .filter(Boolean),
      })),
  };
}
