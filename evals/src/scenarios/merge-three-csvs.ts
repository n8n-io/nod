import { basename } from 'node:path';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const header = 'date,transaction_id,merchant,category,amount';

const merchants: Array<[string, string]> = [
  ['Mercadona', 'Groceries'],
  ['Repsol', 'Fuel'],
  ['Cafe Central', 'Eating out'],
  ['Amazon EU', 'Shopping'],
  ['Renfe', 'Travel'],
  ['Farmacia Sol', 'Health'],
  ['"Lopez & Hijos, S.L."', 'Home'],
  ['Lidl', 'Groceries'],
  ['Uber Eats', 'Eating out'],
  ['FNAC', 'Shopping'],
  ['Decathlon', 'Sport'],
  ['Cines Yelmo', 'Leisure'],
];

const months = [
  {
    file: 'july.csv',
    month: 7,
    days: [2, 3, 3, 5, 7, 8, 10, 11, 13, 14, 15, 17, 18, 21, 22, 24, 25, 28, 29, 31],
  },
  {
    file: 'august.csv',
    month: 8,
    days: [1, 3, 4, 6, 7, 10, 11, 12, 12, 14, 17, 18, 19, 21, 24, 25, 27, 28, 31],
  },
  {
    file: 'september.csv',
    month: 9,
    days: [1, 2, 4, 5, 7, 8, 9, 11, 14, 15, 16, 18, 21, 22, 23, 25, 26, 28, 29, 30],
  },
];

interface Row {
  id: string;
  iso: string;
  line: string;
}

function build() {
  const rows: Row[] = [];
  let index = 0;
  for (const { month, days } of months)
    for (const day of days) {
      const id = `T-${1001 + index}`;
      const [merchant, category] =
        month === 8 && day === 12 ? merchants[2] : merchants[(index * 5) % merchants.length];
      const amount =
        month === 8 && day === 12 ? '2.40' : (((index * 4729) % 9000) / 100 + 3.15).toFixed(2);
      const date = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/2026`;
      rows.push({
        id,
        iso: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        line: `${date},${id},${merchant},${category},${amount}`,
      });
      index++;
    }
  const july = rows.filter((row) => row.iso.startsWith('2026-07'));
  const august = rows.filter((row) => row.iso.startsWith('2026-08'));
  const september = rows.filter((row) => row.iso.startsWith('2026-09'));
  const duplicate = july.at(-1)!;
  const file = (list: Row[]) => [header, ...list.map((row) => row.line).reverse()].join('\n');
  return {
    rows,
    duplicate,
    files: [
      { name: 'july.csv', text: file(july) },
      { name: 'august.csv', text: file([duplicate, ...august]) },
      { name: 'september.csv', text: file(september) },
    ],
  };
}

function parse(text: string) {
  const source = text.replace(/^﻿/, '');
  const first = source.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = !first.includes(',') && first.includes(';') ? ';' : ',';
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (character !== '"') field += character;
      else if (source[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === delimiter) {
      record.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else field += character;
  }
  if (field || record.length) records.push([...record, field]);
  return records.filter((item) => item.some((value) => value.trim()));
}

async function delivered(run: Run) {
  const found: Array<{ name: string; bytes: Buffer }> = [];
  for (const call of run.tools) {
    if (call.name !== 'share_file' || call.isError) continue;
    const path = String(call.input?.path ?? '');
    const relative = path.replace(/^(\.\/)+/, '');
    let artifact: { name?: string; size?: number } = {};
    try {
      artifact = JSON.parse(call.output);
    } catch {}
    let bytes: Buffer | undefined;
    for (const file of run.files.filter((item) => item === path || item.endsWith(`/${relative}`))) {
      const read = await run.read(file);
      if (read && (!bytes || read.length === artifact.size)) bytes = read;
    }
    if (bytes) found.push({ name: artifact.name ?? (call.input?.name || basename(path)), bytes });
  }
  return found;
}

function problems(text: string, rows: Row[]) {
  const records = parse(text);
  const isHeader = (record: string[]) =>
    record.some((value) => /^\s*transaction_id\s*$/i.test(value)) &&
    record.some((value) => /^\s*date\s*$/i.test(value));
  if (!records.length || !isHeader(records[0])) return 'the first line is not the header';
  const data = records.slice(1);
  if (data.some(isHeader)) return 'the header appears more than once';
  const dates = new Map(rows.map((row) => [row.id, row.iso]));
  const ids = data.map((record) =>
    record.map((value) => value.trim()).find((value) => dates.has(value)),
  );
  if (ids.some((id) => !id)) return 'some rows have no known transaction ID';
  const unique = new Set(ids);
  if (unique.size !== ids.length) return `${ids.length - unique.size} duplicate rows`;
  if (ids.length !== rows.length)
    return `${ids.length} data rows, missing ${rows
      .filter((row) => !unique.has(row.id))
      .map((row) => row.id)
      .join(', ')}`;
  const sources = new Map(rows.map((row) => [row.id, parse(row.line)[0]]));
  const day = (value: string) => {
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
    return local && `${local[3]}-${local[2].padStart(2, '0')}-${local[1].padStart(2, '0')}`;
  };
  const altered = ids.filter((id, index) => {
    const [, , merchant, category, amount] = sources.get(id!)!;
    const values = data[index].map((value) => value.trim());
    return !(
      values.some((value) => day(value) === dates.get(id!)) &&
      values.some((value) => value.toLowerCase() === merchant.toLowerCase()) &&
      values.some((value) => value.toLowerCase() === category.toLowerCase()) &&
      values.some(
        (value) =>
          /\d/.test(value) &&
          Math.abs(Number(value.replace(/[€\s]/g, '')) - Number(amount)) < 0.005,
      )
    );
  });
  if (altered.length)
    return `${altered.length} rows lost their date, merchant, category or amount, first ${altered[0]}`;
  const order = ids.map((id) => dates.get(id!)!);
  const wrong = order.findIndex((date, index) => index > 0 && date < order[index - 1]);
  return wrong < 0
    ? undefined
    : `not sorted oldest first: ${ids[wrong - 1]} (${order[wrong - 1]}) comes before ${ids[wrong]} (${order[wrong]})`;
}

export default scenario({
  id: 'merge-three-csvs',
  title: 'Combine these into one CSV sorted by date, without duplicates, and send it to me',
  capabilities: ['files', 'progress'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. The three attached CSVs are your card transaction exports for July, August and September 2026; dates are day/month/year. You want one combined CSV with the same columns, oldest first. Any file name is fine.',
  },
  world() {
    return { apps: createApps(owner, {}), ...build() };
  },
  async play(session, world) {
    const ids: string[] = [];
    for (const file of world.files)
      ids.push(await session.upload(file.name, Buffer.from(file.text), 'text/csv'));
    await session.say(
      'Combine these into one CSV sorted by date, oldest first, without duplicates, and send it to me.',
      { attach: ids },
    );
  },
  evidence(_run, world) {
    return `Three exports with the header "${header}", 20 rows each, newest first, dates as DD/MM/YYYY. Row ${world.duplicate.id} (${world.duplicate.line}) is in both july.csv and august.csv, so the combined file has 59 unique transactions from ${world.rows[0].iso} to ${world.rows.at(-1)!.iso}. Two different Cafe Central payments of 2.40 on 12/08/2026 (${world.rows
      .filter((row) => row.iso === '2026-08-12')
      .map((row) => row.id)
      .join(' and ')}) are separate transactions, not duplicates.`;
  },
  expect(world) {
    return [
      check(
        'delivers-one-sorted-csv-of-59-unique-rows',
        async (run) => {
          const files = (await delivered(run)).filter((file) => /\.csv$/i.test(file.name));
          const results = files.map((file) => ({
            name: file.name,
            problem: problems(file.bytes.toString('utf8'), world.rows),
          }));
          return {
            pass: results.some((result) => !result.problem),
            evidence:
              results.map((result) => `${result.name}: ${result.problem ?? 'ok'}`).join('; ') ||
              'no CSV was delivered',
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'delivers-a-single-csv',
        async (run) => {
          const count = (await delivered(run)).filter((file) => /\.csv$/i.test(file.name)).length;
          return { pass: count === 1, evidence: `${count} CSV files delivered` };
        },
        { required: false, aspect: 'process', failure: 'scope' },
      ),
    ];
  },
});
