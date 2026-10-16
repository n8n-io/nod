import { noWrites } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps, sheets } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const ids = { current: '1Rev26Ch4Yt7Pq3Mx8Monthly', previous: '1Rev25Ch9Lk2Wd6Nz1Monthly' };

const revenue: Array<[string, string, string]> = [
  ['January', '6,850.00', '5'],
  ['February', '7,420.00', '6'],
  ['March', '9,180.00', '7'],
  ['April', '8,040.00', '6'],
  ['May', '11,560.00', '8'],
  ['June', '14,980.00', '9'],
  ['July', '10,270.00', '7'],
  ['August', '5,940.00', '4'],
  ['September', '12,310.00', '8'],
];
const lastYear: Array<[string, string, string]> = [
  ['January', '5,120.00', '4'],
  ['February', '6,300.00', '5'],
  ['March', '7,050.00', '5'],
  ['April', '6,480.00', '5'],
  ['May', '8,900.00', '6'],
  ['June', '9,750.00', '7'],
  ['July', '7,200.00', '5'],
  ['August', '4,310.00', '3'],
  ['September', '10,040.00', '7'],
  ['October', '11,480.00', '8'],
  ['November', '13,900.00', '9'],
  ['December', '16,200.00', '10'],
];

function image(bytes: Buffer | undefined) {
  if (!bytes || bytes.length < 1000) return undefined;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { kind: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return { kind: 'jpeg', width: 0, height: 0 };
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')
    return { kind: 'webp', width: 0, height: 0 };
  return undefined;
}

async function sharedImages(run: Run) {
  const found: Array<{ path: string; kind: string; width: number; height: number }> = [];
  for (const call of run.tools.filter((item) => item.name === 'share_file' && !item.isError)) {
    const path = String(call.input?.path ?? '');
    const relative = path.replace(/^\.?\/+/, '').replace(/^workspace\//, '');
    const file = run.files.find((item) => item === path || item.endsWith(`/${relative}`));
    const bytes = (file ? await run.read(file) : undefined) ?? (await run.read(path));
    const kind = image(bytes);
    if (kind) found.push({ path: file ?? path, ...kind });
  }
  return found;
}

export default scenario({
  id: 'chart-from-sheet',
  title: 'Make me a bar chart of monthly revenue from my Revenue 2026 sheet and send it to me',
  capabilities: ['apps', 'files'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: false,
    persona:
      'You are Alex Rivera, a freelance designer. Your monthly revenue is in the Google Sheet "Revenue 2026", January to September so far. You want the chart as an image here in the chat. Any sensible styling is fine. The sheet itself should not change.',
  },
  world(clock) {
    const header = ['Month', 'Revenue (EUR)', 'Invoices sent'];
    return {
      apps: createApps(owner, {
        sheets: sheets(
          [
            {
              id: ids.current,
              title: 'Revenue 2026',
              tabs: [{ name: 'Monthly', rows: structuredClone([header, ...revenue]) }],
            },
            {
              id: ids.previous,
              title: 'Revenue 2025',
              tabs: [{ name: 'Monthly', rows: structuredClone([header, ...lastYear]) }],
            },
          ],
          clock.now,
        ),
      }),
    };
  },
  async play(session) {
    await session.say(
      'Make me a bar chart of monthly revenue from my Revenue 2026 sheet and send it to me.',
    );
  },
  evidence: (run) =>
    `Revenue 2026 (January to September): ${revenue.map(([month, amount]) => `${month} €${amount}`).join(', ')}. The best month is June (€14,980.00), the weakest August (€5,940.00). "Revenue 2025" is last year's sheet (best month December, €16,200.00) and is not the one asked for.\nFiles sent with share_file: ${
      run.tools
        .filter((item) => item.name === 'share_file')
        .map((item) => `${String(item.input?.path ?? '')}${item.isError ? ' (failed)' : ''}`)
        .join(', ') || 'none'
    }.\nWorkspace files: ${run.files.join(', ') || 'none'}.`,
  expect() {
    return [
      check(
        'reads-the-revenue-2026-values',
        (run) => {
          const reads = (run.apps?.calls ?? []).filter(
            (call) =>
              call.slug === 'GOOGLESHEETS_BATCH_GET' &&
              !call.error &&
              String(call.args.spreadsheet_id ?? '').includes(ids.current),
          );
          return { pass: reads.length > 0, evidence: `${reads.length} reads of Revenue 2026` };
        },
        { aspect: 'process', failure: 'tool' },
      ),
      check(
        'delivers-a-chart-image',
        async (run) => {
          const images = await sharedImages(run);
          const usable = images.filter(
            (item) => item.kind !== 'png' || (item.width >= 200 && item.height >= 150),
          );
          const shares = run.tools.filter((item) => item.name === 'share_file');
          return {
            pass: usable.length > 0,
            evidence: usable.length
              ? usable.map((item) => `${item.path} ${item.width}x${item.height}`).join(', ')
              : `${shares.length} share_file calls, none delivered a usable image (${shares.map((item) => String(item.input?.path ?? '')).join(', ') || 'no paths'})`,
          };
        },
        { failure: 'incomplete' },
      ),
      noWrites('create', 'update', 'delete', 'draft', 'send', 'post'),
      check('names-the-best-month', (run) => /\bjune?\b/i.test(run.final), {
        required: false,
        failure: 'incomplete',
      }),
    ];
  },
});
