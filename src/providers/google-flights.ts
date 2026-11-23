import type {
  FlightOption,
  FlightSearch,
  FlightSearchRequest,
  FlightSearchResult,
} from '../ports/flights.ts';

const site = 'https://www.google.com/travel/flights';
const headers = {
  cookie:
    'SOCS=CAISNQgQEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQwMzE3LjA5X3AwGgJlbiADGgYIgLC_rwY',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
};
const cabins = ['economy', 'premium_economy', 'business', 'first'] as const;
const shown = 12;
const expanded = 3;

interface Moment {
  date: number[];
  time: number[];
}

interface Leg {
  carrier: string;
  number: string;
  airline: string;
  aircraft?: string;
  cabin?: number;
  from: string;
  fromName?: string;
  to: string;
  toName?: string;
  departure: Moment;
  arrival: Moment;
  minutes?: number;
}

interface Journey {
  legs: Leg[];
  layovers: Array<number | undefined>;
  minutes?: number;
  selfTransfer: boolean;
  price?: number;
}

type Trip = { price?: number; journeys: Journey[]; separate?: boolean };
type Search = FlightSearchRequest['searches'][number];

function varint(value: bigint) {
  const bytes: number[] = [];
  do {
    const low = Number(value & 0x7fn);
    value >>= 7n;
    bytes.push(value ? low | 0x80 : low);
  } while (value);
  return bytes;
}

function field(number: number, value: number | string | number[]): number[] {
  if (typeof value === 'number') return [...varint(BigInt(number << 3)), ...varint(BigInt(value))];
  const bytes = typeof value === 'string' ? [...Buffer.from(value)] : value;
  return [...varint(BigInt((number << 3) | 2)), ...varint(BigInt(bytes.length)), ...bytes];
}

const two = (value: number | undefined) => String(value ?? 0).padStart(2, '0');
const isoDate = ([year, month, day]: number[]) => `${year}-${two(month)}-${two(day)}`;
const clock = ([hours, minutes]: number[]) => `${two(hours)}:${two(minutes)}`;
const span = (minutes: number) => `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
const instant = ({ date, time }: Moment) =>
  Date.UTC(date[0]!, date[1]! - 1, date[2], time[0] ?? 0, time[1] ?? 0);

function segment(
  search: { from: string[]; to: string[]; date: string },
  maxStops?: number,
  legs: Leg[] = [],
) {
  const place = (number: number, code: string) =>
    field(number, [...field(1, 1), ...field(2, code)]);
  return field(3, [
    ...field(2, search.date),
    ...(maxStops === undefined ? [] : field(5, maxStops)),
    ...legs.flatMap((leg) =>
      field(4, [
        ...field(1, leg.from),
        ...field(2, isoDate(leg.departure.date)),
        ...field(3, leg.to),
        ...field(5, leg.carrier),
        ...field(6, leg.number),
      ]),
    ),
    ...search.from.flatMap((code) => place(13, code)),
    ...search.to.flatMap((code) => place(14, code)),
  ]);
}

function searchUrl(request: FlightSearchRequest, segments: number[][]) {
  const tfs = Buffer.from([
    ...field(1, 28),
    ...field(2, 2),
    ...segments.flat(),
    ...[
      ...Array<number>(request.adults).fill(1),
      ...Array<number>(request.children).fill(2),
      ...Array<number>(request.infants).fill(3),
    ].flatMap((kind) => field(8, kind)),
    ...field(9, cabins.indexOf(request.cabin) + 1),
    ...field(14, 1),
    ...field(19, segments.length === 1 ? 2 : 1),
  ]).toString('base64url');
  return `${site}?${new URLSearchParams({ tfs, hl: request.language, curr: request.currency })}`;
}

const travellers = (request: FlightSearchRequest) =>
  (
    [
      [request.adults, 'adult', 'adults'],
      [request.children, 'child', 'children'],
      [request.infants, 'infant on a lap', 'infants on a lap'],
    ] as const
  ).flatMap(([value, one, many]) => (value ? [`${value} ${value === 1 ? one : many}`] : []));

function sourceUrl(request: FlightSearchRequest, search: Search) {
  const q = [
    `Flights from ${search.from[0]} to ${search.to[0]} on ${search.date}`,
    search.returnDate ? `returning ${search.returnDate}` : 'one way',
    `for ${travellers(request).join(' and ')}`,
    request.cabin === 'economy' ? '' : `in ${request.cabin.replace('_', ' ')} class`,
  ]
    .filter(Boolean)
    .join(' ');
  return `${site}?${new URLSearchParams({ q, hl: request.language, curr: request.currency })}`;
}

function leg(raw: unknown[]): Leg {
  const flight = raw[22] as string[];
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const leg: Leg = {
    carrier: flight[0]!,
    number: flight[1]!,
    airline: text(flight[3]) ?? flight[0]!,
    aircraft: text(raw[17]),
    cabin: typeof raw[16] === 'number' ? raw[16] : undefined,
    from: raw[3] as string,
    fromName: text(raw[4]),
    to: raw[6] as string,
    toName: text(raw[5]),
    departure: { date: raw[20] as number[], time: raw[8] as number[] },
    arrival: { date: raw[21] as number[], time: raw[10] as number[] },
    minutes: typeof raw[11] === 'number' ? raw[11] : undefined,
  };
  if (
    !leg.carrier ||
    !leg.number ||
    !leg.from ||
    !leg.to ||
    [leg.departure, leg.arrival].some((at) => at.date?.length !== 3 || !Array.isArray(at.time))
  )
    throw new Error('incomplete leg');
  return leg;
}

function journey(row: unknown[]): Journey {
  const detail = row[0] as unknown[];
  const price = (row[1] as unknown[] | undefined)?.[0];
  const amount = Array.isArray(price) ? price.at(-1) : undefined;
  const legs = (detail[2] as unknown[][]).map(leg);
  if (!legs.length) throw new Error('no legs');
  const stated = Array.isArray(detail[13]) ? (detail[13] as unknown[][]) : [];
  return {
    legs,
    layovers: legs.slice(1).map((_, index) => {
      const minutes = stated[index]?.[0];
      return typeof minutes === 'number' ? minutes : undefined;
    }),
    minutes: typeof detail[9] === 'number' ? detail[9] : undefined,
    selfTransfer: detail[12] === 1,
    price: typeof amount === 'number' && amount > 0 ? amount : undefined,
  };
}

async function page(url: string, signal: AbortSignal) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  const html = await response.text();
  if (!response.ok) throw new Error(`Google Flights answered HTTP ${response.status}.`);
  const data = [...html.matchAll(/AF_initDataCallback\((\{.*?\})\);/gs)]
    .map((match) => match[1]!)
    .find((block) => /key:\s*'ds:1'/.test(block))
    ?.match(/data:(.*?), sideChannel/s)?.[1];
  return { data, title: html.match(/<title>([^<]{1,120})<\/title>/)?.[1] };
}

async function results(url: string, signal: AbortSignal) {
  let { data, title } = await page(url, signal);
  if (!data) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    signal.throwIfAborted();
    ({ data, title } = await page(url, signal));
  }
  if (!data)
    throw new Error(
      `Google Flights returned a page without flight results${title ? ` (${title})` : ''}.`,
    );
  let payload: unknown[];
  try {
    payload = JSON.parse(data) as unknown[];
  } catch {
    throw new Error('Google Flights returned result data that could not be read.');
  }
  const rows = [2, 3].flatMap((index) => {
    const group = (payload[index] as unknown[][] | null)?.[0];
    return Array.isArray(group) ? (group as unknown[][]) : [];
  });
  const journeys = rows.flatMap((row) => {
    try {
      return [journey(row)];
    } catch {
      return [];
    }
  });
  if (rows.length && !journeys.length)
    throw new Error(`Google Flights changed its result format: none of ${rows.length} rows read.`);
  const priced = journeys.filter((item) => item.price !== undefined);
  return priced.length ? priced : journeys;
}

function summary(id: string, trip: Trip, price: (amount: number) => string, cabin: number) {
  const describe = (item: Journey) => {
    const first = item.legs[0]!;
    const last = item.legs.at(-1)!;
    const stops = item.legs.slice(1).map((next, index) => {
      const previous = item.legs[index]!;
      return [
        previous.to === next.from ? previous.to : `${previous.to}→${next.from} airport change`,
        ...(item.layovers[index] === undefined ? [] : [span(item.layovers[index])]),
        ...(isoDate(previous.arrival.date) === isoDate(next.departure.date) ? [] : ['overnight']),
      ].join(' ');
    });
    return [
      [...new Set(item.legs.map((current) => current.airline))].join(', '),
      `${isoDate(first.departure.date)} ${clock(first.departure.time)} ${first.from} → ${isoDate(last.arrival.date)} ${clock(last.arrival.time)} ${last.to}`,
      ...(item.minutes ? [span(item.minutes)] : []),
      stops.length
        ? `${stops.length} stop${stops.length > 1 ? 's' : ''} (${stops.join(', ')})`
        : 'nonstop',
      ...(item.selfTransfer ? ['self-transfer'] : []),
      ...(item.legs.some((current) => current.cabin !== undefined && current.cabin < cabin)
        ? ['mixed cabin']
        : []),
    ].join(' · ');
  };
  return [
    id,
    trip.price === undefined ? 'price not listed' : price(trip.price),
    trip.journeys.length > 1
      ? trip.journeys
          .map((item, index) => `${index ? 'back' : 'out'}: ${describe(item)}`)
          .join(' | ')
      : describe(trip.journeys[0]!),
    ...(trip.separate ? ['2 one-way tickets'] : []),
  ].join(' · ');
}

function card(
  id: string,
  trip: Trip,
  language: string,
  price: (amount: number) => string,
): FlightOption {
  const date = new Intl.DateTimeFormat(language, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  const time = new Intl.DateTimeFormat(language, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  const hours = new Intl.NumberFormat(language, {
    style: 'unit',
    unit: 'hour',
    unitDisplay: 'short',
  });
  const minutes = new Intl.NumberFormat(language, {
    style: 'unit',
    unit: 'minute',
    unitDisplay: 'short',
  });
  const length = (total: number) =>
    [
      ...(total >= 60 ? [hours.format(Math.floor(total / 60))] : []),
      ...(total % 60 || total < 60 ? [minutes.format(total % 60)] : []),
    ].join(' ');
  const point = (code: string, name: string | undefined, at: Moment) => ({
    airport: name && name.length + code.length < 77 ? `${name} (${code})` : code,
    date: date.format(instant({ date: at.date, time: [] })),
    time: time.format(instant({ date: [1970, 1, 1], time: at.time })),
  });
  return {
    id,
    status: 'option',
    ...(trip.price === undefined ? {} : { price: price(trip.price) }),
    journeys: trip.journeys.map((item, index) => ({
      id: `${id}-${index + 1}`,
      label: `${item.legs[0]!.from} → ${item.legs.at(-1)!.to}`,
      ...(item.minutes ? { duration: length(item.minutes) } : {}),
      segments: item.legs.map((current, position) => ({
        airline: current.airline,
        flightNumber: `${current.carrier} ${current.number}`,
        ...(current.aircraft ? { aircraft: current.aircraft } : {}),
        ...(current.minutes ? { duration: length(current.minutes) } : {}),
        departure: point(current.from, current.fromName, current.departure),
        arrival: point(current.to, current.toName, current.arrival),
        ...(position < item.legs.length - 1
          ? {
              connectionAfter: {
                ...(item.layovers[position] === undefined
                  ? {}
                  : { duration: length(item.layovers[position]) }),
                airportChange:
                  current.to === item.legs[position + 1]!.from ? ('no' as const) : ('yes' as const),
                selfTransfer: !item.selfTransfer
                  ? ('no' as const)
                  : item.legs.length === 2
                    ? ('yes' as const)
                    : ('unknown' as const),
              },
            }
          : {}),
      })),
    })),
  };
}

const oneWay = async (request: FlightSearchRequest, search: Search, signal: AbortSignal) =>
  results(searchUrl(request, [segment(search, request.maxStops)]), signal);

const leading = (journeys: Journey[]) => {
  const cheapest = journeys
    .filter((item) => item.price !== undefined)
    .sort((a, b) => a.price! - b.price!)[0];
  return [...new Set([...journeys.slice(0, expanded), ...(cheapest ? [cheapest] : [])])];
};

async function trips(
  request: FlightSearchRequest,
  search: Search,
  signal: AbortSignal,
): Promise<Trip[]> {
  if (!search.returnDate)
    return (await oneWay(request, search, signal))
      .slice(0, shown)
      .map((item) => ({ price: item.price, journeys: [item] }));
  const home = { from: search.to, to: search.from, date: search.returnDate };
  const back = segment(home, request.maxStops);
  const outbound = (legs?: Leg[]) => segment(search, request.maxStops, legs);
  const first = await results(searchUrl(request, [outbound(), back]), signal);
  const settled = await Promise.allSettled(
    leading(first).map(async (out) =>
      leading(await results(searchUrl(request, [outbound(out.legs), back]), signal)).map(
        (again) => ({ price: again.price, journeys: [out, again] }),
      ),
    ),
  );
  const found = settled.flatMap((item) => (item.status === 'fulfilled' ? item.value : []));
  if (found.length) return found;
  const [out, ret] = await Promise.all([
    oneWay(request, search, signal),
    oneWay(request, home, signal),
  ]);
  const separate = leading(out)
    .flatMap((there) =>
      leading(ret).map((again) => ({
        price:
          there.price === undefined || again.price === undefined
            ? undefined
            : there.price + again.price,
        journeys: [there, again],
        separate: true,
      })),
    )
    .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
    .slice(0, shown);
  const failed = settled.find((item) => item.status === 'rejected');
  if (!separate.length && failed) throw failed.reason;
  return separate;
}

const priced = (list: Trip[]) => list.some((trip) => trip.price !== undefined);
const letter = (index: number) => (index < 26 ? String.fromCharCode(65 + index) : `X${index}-`);

export function createGoogleFlights(): FlightSearch {
  return {
    async search(request, signal): Promise<FlightSearchResult> {
      if (request.adults + request.children + request.infants > 9)
        throw new Error('Google Flights searches at most nine travellers.');
      if (request.infants > request.adults) throw new Error('Each infant on a lap needs an adult.');
      const money = (language: string) =>
        new Intl.NumberFormat(language, {
          style: 'currency',
          currency: request.currency,
          maximumFractionDigits: 0,
        });
      const local = money(request.language);
      const english = money('en');
      const searches = await Promise.all(
        request.searches.map(async (search, index) => {
          const prefix = letter((request.first ?? 0) + index);
          const label = `${search.from.join('/')} → ${search.to.join('/')} ${search.date}${search.returnDate ? ` – ${search.returnDate}` : ''}`;
          const url = sourceUrl(request, search);
          try {
            let found = await trips(request, search, signal);
            let family = false;
            if (request.children + request.infants > 0 && !priced(found)) {
              const adults = await trips(
                {
                  ...request,
                  adults: request.adults + request.children + request.infants,
                  children: 0,
                  infants: 0,
                },
                search,
                signal,
              );
              if (priced(adults)) [found, family] = [adults, true];
            }
            const bound = (format: Intl.NumberFormat) => (amount: number) =>
              `${family ? '≤ ' : ''}${format.format(amount)}`;
            const cheapest = found.reduce<number | undefined>(
              (best, trip, position) =>
                trip.price !== undefined && (best === undefined || trip.price < found[best]!.price!)
                  ? position
                  : best,
              undefined,
            );
            return {
              label,
              url,
              ...(!found.length
                ? {
                    note: 'Google Flights listed no flights for this search. Relax the cabin or stop limit, or try nearby larger airports or other dates.',
                  }
                : family
                  ? {
                      note: 'Google Flights lists no family fares here, so children and infants are priced as adults. The family total is the same or lower.',
                      upperBound: true,
                    }
                  : {}),
              ...(cheapest === undefined ? {} : { cheapest: `${prefix}${cheapest + 1}` }),
              options: found.map((trip, position) => {
                const id = `${prefix}${position + 1}`;
                return {
                  summary: summary(id, trip, bound(english), cabins.indexOf(request.cabin) + 1),
                  option: card(id, trip, request.language, bound(local)),
                  ...(trip.price === undefined ? {} : { amount: trip.price }),
                };
              }),
            };
          } catch (error) {
            signal.throwIfAborted();
            return { label, url, error: error instanceof Error ? error.message : String(error) };
          }
        }),
      );
      return {
        searchedAt: new Date().toISOString(),
        travellers: travellers(request).join(', '),
        searches,
      };
    },
  };
}
