import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const speechSourceArchives = [
  {
    file: 'spellophone-source.tar.gz',
    url: 'https://codeload.github.com/Spelling-Creator/spellophone/tar.gz/6d51a872d54a773e4969d7130fdaed665b2d6d18',
    size: 177581,
    sha256: '6702e673c93ea1d8d90300a162d64aaab9fdc23737068173ec54e0c0ca4c58c6',
  },
  {
    file: 'espeak-ng-source.tar.gz',
    url: 'https://codeload.github.com/espeak-ng/espeak-ng/tar.gz/4870adfa25b1a32b4361592f1be8a40337c58d6c',
    size: 17747711,
    sha256: 'cd83f84c4e495f281ac14e919aecf2834306ec1ea1b498de8ef6000f3a0f90de',
  },
];

export async function copySpeechSources({
  root,
  target,
  cacheDir = join(homedir(), '.cache', 'nod', 'speech-sources'),
  archives = speechSourceArchives,
  fetch: fetchImpl = globalThis.fetch,
}) {
  const dependency = join(root, 'node_modules', '@spelling-creator', 'spellophone');
  const manifest = JSON.parse(await readFile(join(dependency, 'package.json'), 'utf8'));
  if (manifest.version !== '0.2.1')
    throw new Error('Speech source records do not match the installed package.');
  const destination = join(target, 'licenses', 'speech');
  await mkdir(destination, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  const valid = (bytes, archive) =>
    bytes?.length === archive.size &&
    createHash('sha256').update(bytes).digest('hex') === archive.sha256;
  for (const archive of archives) {
    const cached = join(cacheDir, archive.file);
    let bytes = await readFile(cached).catch((error) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!valid(bytes, archive)) {
      const response = await fetchImpl(archive.url, {
        redirect: 'error',
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new Error('Speech source download failed.');
      }
      const chunks = [];
      let size = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > archive.size) throw new Error('Speech source archive is too large.');
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      bytes = Buffer.concat(chunks);
      if (!valid(bytes, archive)) throw new Error('Speech source archive checksum mismatch.');
      const temporary = `${cached}.${process.pid}.download`;
      try {
        await writeFile(temporary, bytes, { mode: 0o600 });
        await rename(temporary, cached);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    await cp(cached, join(destination, archive.file));
  }
  await cp(join(root, 'desktop', 'licenses', 'speech.md'), join(destination, 'NOTICE.md'));
  await cp(join(dependency, 'LICENSE'), join(destination, 'GPL-3.0.txt'));
  await writeFile(join(destination, 'sources.json'), `${JSON.stringify(archives, null, 2)}\n`);
}
