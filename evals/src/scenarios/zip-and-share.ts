import { basename } from 'node:path';
import { crc32 } from 'node:zlib';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';
import { pdf } from '../world/pdf.ts';
import { textPng } from '../world/png.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

function assets() {
  return [
    {
      name: 'brief.pdf',
      mime: 'application/pdf',
      bytes: pdf([
        'Rivera Design - Project brief',
        'Client: Northwind Bakery (northwind.example.com)',
        'Scope: new logo, packaging labels and a one-page website.',
        'Kickoff: Monday 2 November 2026. First concepts due Friday 13 November.',
      ]),
    },
    {
      name: 'budget.pdf',
      mime: 'application/pdf',
      bytes: pdf([
        'Rivera Design - Budget estimate',
        'Logo and identity: EUR 2,400.00',
        'Packaging labels (3 sizes): EUR 1,150.00',
        'One-page website: EUR 1,800.00',
        'Total before VAT: EUR 5,350.00',
      ]),
    },
    {
      name: 'moodboard.png',
      mime: 'image/png',
      bytes: textPng(['MOODBOARD', 'WARM TERRACOTTA', 'CREAM PAPER', 'HAND DRAWN WHEAT']),
    },
    {
      name: 'kickoff notes.txt',
      mime: 'text/plain',
      bytes: Buffer.from(
        'Kickoff notes - Northwind Bakery\n\n- Owner: Marta Ruiz, marta@northwind.example.com\n- They love the old hand-painted shop sign; keep that warmth.\n- Labels must fit 250 g, 500 g and 1 kg bags.\n- Website: opening hours, menu, map. No online shop yet.\n',
      ),
    },
  ];
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

function entries(bytes: Buffer) {
  try {
    if (bytes.readUInt32LE(0) !== 0x04034b50) return undefined;
    const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0) return undefined;
    const count = bytes.readUInt16LE(end + 10);
    let offset = bytes.readUInt32LE(end + 16);
    const list: Array<{ name: string; crc: number; size: number }> = [];
    for (let index = 0; index < count; index++) {
      if (bytes.readUInt32LE(offset) !== 0x02014b50) return undefined;
      const length = bytes.readUInt16LE(offset + 28);
      list.push({
        name: bytes.toString('utf8', offset + 46, offset + 46 + length),
        crc: bytes.readUInt32LE(offset + 16),
        size: bytes.readUInt32LE(offset + 24),
      });
      offset += 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    }
    return list;
  } catch {
    return undefined;
  }
}

const leaf = (name: string) => name.split('/').at(-1)!;

async function archive(run: Run) {
  const zip = (await delivered(run)).find(
    (file) => file.name.toLowerCase() === 'project-assets.zip',
  );
  return zip && { listed: entries(zip.bytes) };
}

export default scenario({
  id: 'zip-and-share',
  title: 'Zip these into project-assets.zip and send it back',
  capabilities: ['files'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. The four attached files are the assets for the Northwind Bakery project. You want them in one zip called project-assets.zip, with the files as they are.',
  },
  world() {
    return { apps: createApps(owner, {}), assets: assets() };
  },
  async play(session, world) {
    const ids: string[] = [];
    for (const file of world.assets)
      ids.push(await session.upload(file.name, file.bytes, file.mime));
    await session.say('Zip these into project-assets.zip and send it back.', { attach: ids });
  },
  evidence(_run, world) {
    return `The user attached four files: ${world.assets.map((file) => `${file.name} (${file.bytes.length} bytes)`).join(', ')}. Attachments are stored in the workspace with an ID prefix, such as <id>-brief.pdf.`;
  },
  expect(world) {
    const expected = world.assets.map((file) => ({
      name: file.name,
      crc: crc32(file.bytes),
      size: file.bytes.length,
    }));
    return [
      check(
        'delivers-project-assets-zip-with-the-four-files',
        async (run) => {
          const zip = await archive(run);
          if (!zip) return { pass: false, evidence: 'no project-assets.zip was delivered' };
          if (!zip.listed) return { pass: false, evidence: 'project-assets.zip is not a ZIP file' };
          const missing = expected.filter(
            (file) =>
              !zip.listed!.some(
                (entry) =>
                  (leaf(entry.name) === file.name || leaf(entry.name).endsWith(`-${file.name}`)) &&
                  entry.crc === file.crc &&
                  entry.size === file.size,
              ),
          );
          return {
            pass: !missing.length,
            evidence: `entries: ${zip.listed.map((entry) => entry.name).join(', ') || 'none'}${missing.length ? `; missing or changed: ${missing.map((file) => file.name).join(', ')}` : ''}`,
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'keeps-the-original-file-names',
        async (run) => {
          const names = ((await archive(run))?.listed ?? [])
            .filter((entry) => !entry.name.endsWith('/'))
            .map((entry) => leaf(entry.name));
          return {
            pass: expected.every((file) => names.includes(file.name)),
            evidence: names.join(', ') || 'no entries',
          };
        },
        { required: false, aspect: 'outcome', failure: 'format' },
      ),
      check(
        'zips-only-the-four-files',
        async (run) => {
          const files = ((await archive(run))?.listed ?? []).filter(
            (entry) => !entry.name.endsWith('/'),
          );
          return { pass: files.length === 4, evidence: `${files.length} file entries` };
        },
        { required: false, aspect: 'outcome', failure: 'scope' },
      ),
    ];
  },
});
