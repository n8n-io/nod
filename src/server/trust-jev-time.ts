import type { DecisionQuestion } from '../ports/decisions.ts';

export interface JevChoice {
  choice: string | boolean;
  probability: number;
}

export interface JevDate {
  field: Array<string | number>;
  value: string;
  kind: string;
  interpretations?: Array<{
    timeZone: string;
    wallTime: string;
    calendar: { date: string; tomorrow: string; weekday: string };
  }>;
}

export function selectedJevDate(answer: JevChoice | undefined, dates: JevDate[]) {
  const match = typeof answer?.choice === 'string' && /^date:(0|[1-9]\d*)$/.exec(answer.choice);
  return match ? dates[Number(match[1])] : undefined;
}

export function jevTimeQuestions(text: string, dates: JevDate[], kind: string): DecisionQuestion[] {
  if (!dates.some((date) => date.kind === 'instant')) return [];
  const clocks = [
    ...new Set(
      [...text.matchAll(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b/g)].map(
        (match) => `${match[1].padStart(2, '0')}:${match[2]}${match[3] ? ':' + match[3] : ''}`,
      ),
    ),
  ];
  const questions: DecisionQuestion[] = [];
  if (clocks.length)
    questions.push({
      name: 'owner_clock',
      minProbability: 0,
      instructions:
        'Select the exact local start clock time chosen by the owner. Use none for bounds, windows, relative moves or no exact start.',
      choices: [
        { value: 'none', description: 'No exact start clock time.' },
        ...clocks.map((value) => ({ value, description: value })),
      ],
    });
  if (dates.filter((date) => date.kind === 'instant').length > 1) {
    const values = new Set([5, 10, 15, 20, 30, 45, 60, 90, 120, 150, 180, 240]);
    for (const match of text.matchAll(/\d+(?:[.,]\d+)?/g)) {
      const number = Number(match[0].replace(',', '.'));
      if (number > 0 && number <= 10080) values.add(number);
      if (number * 60 > 0 && number * 60 <= 10080) values.add(number * 60);
    }
    questions.push({
      name: 'owner_duration',
      minProbability: 0,
      instructions:
        'Select an explicit elapsed event or appointment length. Use none for relative shifts, windows, calendar nights or days, or no stated length. Use unlisted for a length absent from these choices.',
      choices: [
        { value: 'none', description: 'No exact elapsed event length.' },
        { value: 'unlisted', description: 'An exact length not listed.' },
        ...[...values]
          .sort((a, b) => a - b)
          .slice(0, 24)
          .map((number) => ({
            value: String(number),
            description: `${number} minutes${number % 60 === 0 ? ' (' + number / 60 + ' hours)' : ''}`,
          })),
      ],
    });
  }
  const years = [...new Set(text.match(/\b[1-9]\d{3}\b/g) ?? [])];
  if (years.length) {
    for (const [name, label, values] of [
      ['owner_year', 'year', years.map((value) => [value, value])],
      [
        'owner_month',
        'month',
        Array.from({ length: 12 }, (_, index) => [
          String(index + 1),
          new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(
            new Date(Date.UTC(2000, index, 1)),
          ),
        ]),
      ],
      [
        'owner_day',
        'day of the month',
        Array.from({ length: 31 }, (_, index) => [String(index + 1), String(index + 1)]),
      ],
    ] as const)
      questions.push({
        name,
        minProbability: 0,
        instructions: `Select the ${label} of the explicit exact start date the owner chose. Use none for relative dates, windows, no exact date or no explicit ${label}. Ignore dates for other operations.`,
        choices: [
          { value: 'none', description: `No explicit ${label} for an exact start date.` },
          ...values.map(([value, description]) => ({ value, description })),
        ],
      });
  }
  questions.push({
    name: 'owner_weekday',
    minProbability: 0,
    instructions:
      'Select one explicit weekday required for this operation. Use none without an explicit weekday, and multiple for several allowed weekdays.',
    choices: [
      { value: 'none', description: 'No single weekday stated.' },
      { value: 'multiple', description: 'Several weekdays are allowed.' },
      ...['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(
        (value) => ({ value, description: value }),
      ),
    ],
  });
  return questions.map((question) => ({
    ...question,
    instructions: `For the ${kind} operation: ${question.instructions}`,
  }));
}

export function checkJevTimes(
  first: Record<string, JevChoice>,
  owner: Record<string, JevChoice>,
  dates: JevDate[],
) {
  let mismatch = false;
  let uncertain = false;
  let clockVerified = false;
  let durationVerified = false;
  let dateVerified = false;
  if (!dates.some((date) => date.kind === 'instant'))
    return { mismatch, uncertain, clockVerified, durationVerified, dateVerified };
  const field = selectedJevDate(first.date_field, dates);
  const end = selectedJevDate(first.end_field, dates);
  const duration = owner.owner_duration;
  if (duration && duration.choice !== 'none') {
    if (
      duration.choice === 'unlisted' ||
      duration.probability < 0.8 ||
      !field ||
      !end ||
      (first.date_field?.probability ?? 0) < 0.8 ||
      (first.end_field?.probability ?? 0) < 0.8
    )
      uncertain = true;
    else {
      const actual = (Date.parse(end.value) - Date.parse(field.value)) / 60000;
      const matches = Number.isFinite(actual) && Math.abs(actual - Number(duration.choice)) <= 1e-8;
      mismatch = !matches;
      durationVerified = matches;
    }
  }
  const zone = owner.owner_zone;
  const clock = owner.owner_clock;
  if (clock && clock.choice !== 'none' && zone && zone.choice !== 'unspecified') {
    const actual = field?.interpretations
      ?.find((value) => value.timeZone === zone.choice)
      ?.wallTime.slice(11, 11 + String(clock.choice).length);
    if (
      !actual ||
      clock.probability < 0.75 ||
      zone.probability < 0.75 ||
      (first.date_field?.probability ?? 0) < 0.8
    )
      uncertain = true;
    else {
      clockVerified = actual === clock.choice;
      mismatch ||= !clockVerified;
    }
  }
  const parts = [owner.owner_year, owner.owner_month, owner.owner_day];
  if (
    parts.every((part) => part && part.choice !== 'none') &&
    zone &&
    zone.choice !== 'unspecified'
  ) {
    const actual = field?.interpretations?.find((value) => value.timeZone === zone.choice)?.calendar
      .date;
    if (
      !actual ||
      parts.some((part) => part.probability < 0.8) ||
      zone.probability < 0.75 ||
      (first.date_field?.probability ?? 0) < 0.8
    )
      uncertain = true;
    else {
      const expected = parts
        .map((part, index) => String(part.choice).padStart(index ? 2 : 4, '0'))
        .join('-');
      dateVerified = expected === actual;
      mismatch ||= !dateVerified;
    }
  }
  const weekday = owner.owner_weekday;
  if (
    weekday &&
    !['none', 'multiple'].includes(String(weekday.choice)) &&
    zone &&
    zone.choice !== 'unspecified'
  ) {
    const actual = field?.interpretations?.find((value) => value.timeZone === zone.choice)?.calendar
      .weekday;
    if (
      !actual ||
      weekday.probability < 0.8 ||
      zone.probability < 0.75 ||
      (first.date_field?.probability ?? 0) < 0.8
    )
      uncertain = true;
    else mismatch ||= actual !== weekday.choice;
  }
  return {
    mismatch,
    uncertain,
    clockVerified: clockVerified && !uncertain,
    durationVerified: durationVerified && !uncertain,
    dateVerified: dateVerified && !uncertain,
  };
}

export function jevMessageDateQuestions(text: string, scheduledFor: string): DecisionQuestion[] {
  const years = [...new Set([scheduledFor.slice(0, 4), ...(text.match(/\b[1-9]\d{3}\b/g) ?? [])])];
  return [
    ['year', years.map((value) => [value, value])],
    [
      'month',
      Array.from({ length: 12 }, (_, index) => [
        String(index + 1),
        new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(
          new Date(Date.UTC(2000, index, 1)),
        ),
      ]),
    ],
    ['day', Array.from({ length: 31 }, (_, index) => [String(index + 1), String(index + 1)])],
  ].map(([part, values]) => ({
    name: `text_${part}`,
    minProbability: 0,
    instructions: `Read only action arguments and proposed message text. Select the ${part} of the primary explicit calendar date proposed there. Ignore owner words and server facts. Use none for relative dates, no explicit calendar date or no explicit ${part}. Numbers that are not dates do not select a date.`,
    choices: [
      { value: 'none', description: `No explicit ${part} of a proposed calendar date.` },
      ...(values as string[][]).map(([value, description]) => ({ value, description })),
    ],
  }));
}

export function jevMessageDate(answers: Record<string, JevChoice>, expected: string) {
  const month = answers.text_month;
  const day = answers.text_day;
  const year = answers.text_year;
  if (!month || !day || !year) throw new Error('The trust message date is incomplete.');
  if ([month, day, year].every((value) => value.choice === 'none'))
    return { mismatch: false, uncertain: false, verified: false };
  const uncertain =
    month.choice === 'none' ||
    day.choice === 'none' ||
    [month, day, year].some((value) => value.probability < 0.8);
  const actual = [
    year.choice === 'none' ? expected.slice(0, 4) : year.choice,
    String(month.choice).padStart(2, '0'),
    String(day.choice).padStart(2, '0'),
  ].join('-');
  return {
    mismatch: !uncertain && actual !== expected,
    uncertain,
    verified: !uncertain && actual === expected,
  };
}
