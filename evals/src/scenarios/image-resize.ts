import { basename } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const size = { width: 1600, height: 900 };
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function banner() {
  const { width, height } = size;
  const stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * stride + 1 + x * 3;
      const hill = 600 + Math.round(80 * Math.sin(x / 210) + 40 * Math.sin(x / 67));
      const sun = (x - 1180) ** 2 + (y - 260) ** 2 < 120 ** 2;
      const color =
        y > hill
          ? [40 + ((x + y) % 7), 140 - Math.round((y - 480) / 6), 70]
          : sun
            ? [255, 214, 90]
            : [250 - Math.round(y / 6), 150 + Math.round(y / 9), 90 + Math.round(y / 5)];
      pixels[at] = Math.max(0, Math.min(255, color[0]));
      pixels[at + 1] = Math.max(0, Math.min(255, color[1]));
      pixels[at + 2] = Math.max(0, Math.min(255, color[2]));
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
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

const dimensions = (bytes: Buffer) =>
  bytes.length > 24 &&
  bytes.subarray(0, 8).equals(signature) &&
  bytes.toString('ascii', 12, 16) === 'IHDR'
    ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    : undefined;

export default scenario({
  id: 'image-resize',
  title: 'Resize this to 800 pixels wide, keep the proportions, and send it back',
  capabilities: ['files'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 300,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. The attached PNG is the banner for your studio newsletter. You want the same picture back as a PNG, 800 pixels wide, not cropped or stretched. Any file name is fine.',
  },
  world() {
    return { apps: createApps(owner, {}), image: banner() };
  },
  async play(session, world) {
    const id = await session.upload('newsletter-banner.png', world.image, 'image/png');
    await session.say('Resize this to 800 pixels wide, keep the proportions, and send it back.', {
      attach: [id],
    });
  },
  evidence() {
    return `The attached newsletter-banner.png is ${size.width}×${size.height} pixels. Kept in proportion, 800 pixels wide means 800×450.`;
  },
  expect() {
    return [
      check(
        'delivers-an-800x450-png',
        async (run) => {
          const files = await delivered(run);
          const sizes = files.map((file) => ({ name: file.name, size: dimensions(file.bytes) }));
          return {
            pass: sizes.some(
              (file) => file.size?.width === 800 && Math.abs(file.size.height - 450) <= 1,
            ),
            evidence:
              sizes
                .map(
                  (file) =>
                    `${file.name}: ${file.size ? `${file.size.width}×${file.size.height} PNG` : 'not a PNG'}`,
                )
                .join(', ') || 'no file was delivered',
          };
        },
        { failure: 'incomplete' },
      ),
    ];
  },
});
