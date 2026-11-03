import type { DecisionQuestion } from '../ports/decisions.ts';

export interface JevChoice {
  choice: string | boolean;
  probability: number;
}

export interface JevDate {
  field: Array<string | number>;
  value: string;
  kind: string;
  calendar?: { date: string; tomorrow: string; weekday: string };
  interpretations?: Array<{
    timeZone: string;
    wallTime: string;
    calendar: { date: string; tomorrow: string; weekday: string };
  }>;
}

export const jevTimeBounds =
  'Do the owner words impose a time condition beyond an exact start day, clock, weekday and elapsed event length? Include windows, before or after bounds, deadlines, explicit end dates, relative moves and multiple starts. Tomorrow and an exact start clock alone are not extra conditions.';

export function selectedJevDate(answer: JevChoice | undefined, dates: JevDate[]) {
  const match = typeof answer?.choice === 'string' && /^date:(0|[1-9]\d*)$/.exec(answer.choice);
  return match ? dates[Number(match[1])] : undefined;
}

export function jevTimeQuestions(text: string, dates: JevDate[], kind: string): DecisionQuestion[] {
  if (!dates.length) return [];
  const clocks = [
    ...new Set(
      [
        ...text.matchAll(
          /(?<![\d:])([01]?\d|2[0-3])(?::([0-5]\d)(?::([0-5]\d))?)?\s*(a\.?m\.?|p\.?m\.?)?(?![\p{L}\d])/giu,
        ),
      ]
        .filter((match) => (match[2] || match[4]) && (!match[4] || Number(match[1]) <= 12))
        .map((match) => {
          const hour = match[4]
            ? (Number(match[1]) % 12) + (match[4].toLowerCase().startsWith('p') ? 12 : 0)
            : Number(match[1]);
          return `${String(hour).padStart(2, '0')}:${match[2] ?? '00'}${match[3] ? ':' + match[3] : ''}`;
        }),
    ),
  ];
  const questions: DecisionQuestion[] = [];
  if (clocks.length)
    questions.push(
      {
        name: 'owner_clock',
        minProbability: 0,
        instructions:
          'Select the exact local start clock time chosen by the owner. Use none for bounds, windows, relative moves or no exact start.',
        choices: [
          { value: 'none', description: 'No exact start clock time.' },
          ...clocks.map((value) => ({ value, description: value })),
        ],
      },
      {
        name: 'owner_time_bounds',
        format: 'predicate',
        minProbability: 0,
        instructions: jevTimeBounds,
        choices: [
          { value: true, description: 'There is another time condition.' },
          { value: false, description: 'There is no other time condition.' },
        ],
      },
    );
  if (dates.some((date) => date.kind === 'instant')) {
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
  {
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
      if (values.length)
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
      'Extract only a weekday name explicitly written by the owner for this operation. Do not calculate a weekday from a calendar date. A month and day do not name a weekday. Use none when no weekday name is written, and multiple for several allowed weekdays.',
    choices: [
      { value: 'none', description: 'The owner writes no weekday name.' },
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
  let uncertain = Object.entries(owner).some(
    ([name, value]) =>
      name.startsWith('owner_') &&
      ['none', 'unspecified'].includes(String(value.choice)) &&
      value.probability < 0.8,
  );
  let clockVerified = false;
  let durationVerified = false;
  let dateVerified = false;
  if (!dates.length) return { mismatch, uncertain, clockVerified, durationVerified, dateVerified };
  const field = selectedJevDate(first.date_field, dates);
  const end = selectedJevDate(first.end_field, dates);
  const duration = owner.owner_duration;
  durationVerified = duration?.choice === 'none' && duration.probability >= 0.8;
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
  const local =
    field?.kind === 'instant' && zone?.choice === 'unspecified'
      ? {
          wallTime: `${field.value.slice(0, 10)} ${field.value.slice(11, 16)}:${field.value[16] === ':' ? field.value.slice(17, 19) : '00'}`,
          calendar: {
            date: field.value.slice(0, 10),
            weekday: new Intl.DateTimeFormat('en', { weekday: 'long', timeZone: 'UTC' }).format(
              new Date(field.value.slice(0, 10) + 'T12:00:00Z'),
            ),
          },
        }
      : field?.interpretations?.find((value) => value.timeZone === zone?.choice);
  if (clock && clock.choice !== 'none') {
    const actual = local?.wallTime.slice(11, 11 + String(clock.choice).length);
    if (
      !actual ||
      clock.probability < 0.75 ||
      !zone ||
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
  if (parts.some((part) => part && part.choice !== 'none')) {
    const actual = field?.calendar?.date ?? local?.calendar.date;
    if (
      !actual ||
      !owner.owner_month ||
      !owner.owner_day ||
      parts.some((part) => part && part.probability < 0.8) ||
      (!field?.calendar && (!zone || zone.probability < 0.75)) ||
      (first.date_field?.probability ?? 0) < 0.8
    )
      uncertain = true;
    else {
      dateVerified = parts.every(
        (part, index) =>
          !part ||
          part.choice === 'none' ||
          String(part.choice).padStart(index ? 2 : 4, '0') === actual.split('-')[index],
      );
      mismatch ||= !dateVerified;
    }
  }
  const weekday = owner.owner_weekday;
  if (weekday && !['none', 'multiple'].includes(String(weekday.choice))) {
    const actual = field?.calendar?.weekday ?? local?.calendar.weekday;
    if (
      !actual ||
      weekday.probability < 0.8 ||
      (!field?.calendar && (!zone || zone.probability < 0.75)) ||
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
    return {
      mismatch: false,
      uncertain: [month, day, year].some((value) => value.probability < 0.8),
      verified: false,
    };
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
