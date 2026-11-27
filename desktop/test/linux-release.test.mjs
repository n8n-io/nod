import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createUpdateSource } from '../main/updates.mjs';
import { linuxReleaseFiles, packageLinuxBundle } from '../scripts/linux-release.mjs';
import { desktopBuildOptions } from '../scripts/release-tools.mjs';
import { writeRpmManifest } from '../scripts/rpm-release.mjs';

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

test('Linux release bundle is checked and rejects changed or unrelated files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nod-linux-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, 'synthetic.flatpak');
  const bytes = Buffer.from('Synthetic Flatpak bundle.');
  await writeFile(bundle, bytes);
  const expected = { version: '0.6.3', source: 'a'.repeat(40) };
  await packageLinuxBundle({ root, bundle, ...expected, commit: 'b'.repeat(64) });
  const files = await linuxReleaseFiles(root, expected);
  const manifest = JSON.parse(await readFile(files[0], 'utf8'));
  assert.deepEqual(await readFile(files[2]), bytes);
  const original = await readFile(files[0]);
  for (const change of [
    { source: 'c'.repeat(40) },
    { commit: '' },
    { bundle: { ...manifest.bundle, sha256: 'c'.repeat(64) } },
    { bundle: { ...manifest.bundle, file: '../outside' } },
  ]) {
    await writeFile(files[0], JSON.stringify({ ...manifest, ...change }));
    await assert.rejects(linuxReleaseFiles(root, expected));
  }
  await writeFile(files[0], original);
  await writeFile(files[2], Buffer.alloc(bytes.length));
  await assert.rejects(linuxReleaseFiles(root, expected), /checksum/);
  await rm(files[2]);
  await assert.rejects(linuxReleaseFiles(root, expected), { code: 'ENOENT' });
  await writeFile(
    files[0],
    JSON.stringify({ ...manifest, bundle: { ...manifest.bundle, bytes: 1900 * 1024 ** 2 + 1 } }),
  );
  await assert.rejects(linuxReleaseFiles(root, expected), /1900 MiB/);
  await writeFile(files[0], original);
});

test('RPM release manifest matches the bytes on disk and the fields the desktop updater requires', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nod-rpm-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('Synthetic RPM payload.');
  await writeFile(join(directory, 'nod-linux-x64.rpm'), bytes);
  const version = '0.9.9';
  const source = 'a'.repeat(40);
  const manifest = await writeRpmManifest({ directory, version, source });
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, 'release-linux-x64-rpm.json'), 'utf8')),
    manifest,
  );
  assert.equal(manifest.platform, 'linux-x64-rpm');
  assert.equal(manifest.rpm.file, 'nod-linux-x64.rpm');
  assert.equal(manifest.rpm.bytes, bytes.length);
  assert.equal(
    manifest.rpm.sha256,
    'b9e7c44623b3a7d31145b3dd7524d67cca5dde35d05ece9aacc813f54512cf3c',
  );
  const base = 'https://github.com/n8n-io/nod/releases';
  const manifestUrl = `${base}/download/nod-v${version}/release-linux-x64-rpm.json`;
  const rpm = createUpdateSource({
    os: 'linux',
    packaging: 'rpm',
    fetch: async (url) => {
      if (url === `${base}/latest/download/release-linux-x64-rpm.json`)
        return new Response(null, { status: 302, headers: { location: manifestUrl } });
      if (url === manifestUrl) return Response.json(manifest);
      assert.fail(`Unexpected release request ${url}`);
    },
  });
  assert.deepEqual(await rpm.latest('0.0.1'), { version, source });
  await assert.rejects(writeRpmManifest({ directory, version: '01.0.0', source }));
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
