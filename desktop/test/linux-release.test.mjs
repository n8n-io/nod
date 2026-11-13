import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { linuxReleaseFiles, packageLinuxBundle } from '../scripts/linux-release.mjs';
import { desktopBuildOptions } from '../scripts/release-tools.mjs';

test('desktop release metadata keeps the trace token and release flag together', () => {
  const tracesToken = 'a'.repeat(64);
  assert.deepEqual(desktopBuildOptions({}), {});
  assert.deepEqual(desktopBuildOptions({ NOD_TRACES_TOKEN: tracesToken }), { tracesToken });
  assert.deepEqual(
    desktopBuildOptions({ NOD_TRACES_TOKEN: tracesToken, NOD_RELEASE_BUILD: 'true' }),
    { tracesToken, release: true },
  );
  assert.throws(() => desktopBuildOptions({ NOD_TRACES_TOKEN: 'invalid token' }), /URL-safe/);
});

test('Linux release parts preserve the bundle and reject missing, changed or unrelated files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nod-linux-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, 'synthetic.flatpak');
  const bytes = Buffer.from('Synthetic Flatpak bundle with several parts.');
  await writeFile(bundle, bytes);
  const expected = { version: '0.6.3', source: 'a'.repeat(40) };
  await packageLinuxBundle({ root, bundle, ...expected, commit: 'b'.repeat(64), partBytes: 24 });
  const files = await linuxReleaseFiles(root, expected);
  const manifest = JSON.parse(await readFile(files[0], 'utf8'));
  assert.equal(manifest.parts.length, 2);
  assert.deepEqual(
    Buffer.concat(await Promise.all(files.slice(2).map((file) => readFile(file)))),
    bytes,
  );
  const original = await readFile(files[0]);
  for (const change of [
    { source: 'c'.repeat(40) },
    { commit: '' },
    { bundle: { ...manifest.bundle, sha256: 'c'.repeat(64) } },
    { parts: [{ ...manifest.parts[0], file: '../outside' }, ...manifest.parts.slice(1)] },
    { parts: [...manifest.parts].reverse() },
  ]) {
    await writeFile(files[0], JSON.stringify({ ...manifest, ...change }));
    await assert.rejects(linuxReleaseFiles(root, expected));
  }
  await writeFile(files[0], original);
  await writeFile(files[2], Buffer.alloc(24));
  await assert.rejects(linuxReleaseFiles(root, expected), /checksum/);
  await rm(files[2]);
  await assert.rejects(linuxReleaseFiles(root, expected), { code: 'ENOENT' });
  await assert.rejects(
    packageLinuxBundle({ root, bundle, ...expected, commit: 'b'.repeat(64), partBytes: 10 }),
    /two release parts/,
  );
});

test('Linux download links lead supported desktops to installation instructions', async () => {
  const source = (
    await readFile(new URL('../../docs/src/scripts/download.js', import.meta.url), 'utf8')
  ).replace('export function', 'function');
  for (const [navigator, expected] of [
    [{ platform: 'Linux x86_64' }, true],
    [
      {
        userAgentData: {
          platform: 'Linux',
          getHighEntropyValues: async () => ({ architecture: 'x86', bitness: '64' }),
        },
      },
      true,
    ],
    [{ platform: 'Linux aarch64' }, false],
    [{ platform: 'Linux x86_64', userAgent: 'Android' }, false],
  ]) {
    const label = { textContent: 'Choose installer' };
    const link = {
      href: 'https://nod.n8n.io/docs/get-started/install-desktop/',
      dataset: { download: 'label' },
      querySelector: (selector) => (selector === '[data-download-label]' ? label : null),
    };
    runInNewContext(`${source}\nstartDownload();`, {
      navigator,
      document: { querySelectorAll: () => [link] },
      URL,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(link.href.endsWith('#linux'), expected);
    if (expected) assert.equal(label.textContent, 'Install for Linux');
  }
});
