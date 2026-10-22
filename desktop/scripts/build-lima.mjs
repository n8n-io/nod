import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, verifyCompatibility } from './release-tools.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await readFile(join(directory, 'runtime-build-lock.json'), 'utf8'));

export async function buildLima(sourceArchive, goArchive, cache, output) {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch))
    throw new Error('Lima host builds require an Intel or Apple Silicon Mac.');
  const source = join(cache, `lima-source-${lock.limaVersion}-${process.arch}`);
  const compiler = join(cache, basename(goArchive, '.tar.gz'));
  const stamp = join(source, '.nod-build.json');
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(lock))
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest('hex');
  const binary = join(source, '_output/bin/limactl');
  let cached;
  try {
    cached = JSON.parse(await readFile(stamp, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (
    cached?.fingerprint !== fingerprint ||
    !(await stat(binary).catch(() => undefined)) ||
    createHash('sha256')
      .update(await readFile(binary))
      .digest('hex') !== cached.sha256
  ) {
    await rm(source, { recursive: true, force: true });
    await mkdir(source, { recursive: true });
    await rm(compiler, { recursive: true, force: true });
    await mkdir(compiler, { recursive: true });
    const go = join(compiler, 'go/bin/go');
    await run('/usr/bin/tar', ['-xzf', goArchive, '-C', compiler]);
    await run('/usr/bin/tar', ['-xzf', sourceArchive, '--strip-components=1', '-C', source]);
    const environment = {
      ...process.env,
      GOTOOLCHAIN: 'local',
      GOWORK: 'off',
      GOFLAGS: '-mod=readonly',
      GOCACHE: join(cache, 'go-build'),
      GOMODCACHE: join(cache, 'go-modules'),
      GOOS: 'darwin',
      GOARCH: process.arch === 'x64' ? 'amd64' : 'arm64',
      CGO_ENABLED: '1',
      MACOSX_DEPLOYMENT_TARGET: lock.minimumSystemVersion,
      CGO_CFLAGS: `-arch ${process.arch === 'x64' ? 'x86_64' : 'arm64'} -mmacosx-version-min=${lock.minimumSystemVersion}`,
      CGO_LDFLAGS: `-arch ${process.arch === 'x64' ? 'x86_64' : 'arm64'} -mmacosx-version-min=${lock.minimumSystemVersion}`,
    };
    await run(
      '/usr/bin/make',
      [
        '-C',
        source,
        `GO='${go.replaceAll("'", "'\\''")}'`,
        `VERSION=v${lock.limaVersion}`,
        'ADDITIONAL_DRIVERS=',
        'limactl',
      ],
      { env: environment, timeout: 20 * 60_000, stdio: 'inherit' },
    );
    await verifyCompatibility([binary]);
    await writeFile(
      stamp,
      JSON.stringify({
        fingerprint,
        sha256: createHash('sha256')
          .update(await readFile(binary))
          .digest('hex'),
      }) + '\n',
    );
  }
  await verifyCompatibility([binary]);
  await mkdir(join(output, 'bin'), { recursive: true });
  await cp(binary, join(output, 'bin/limactl'));
  await run('/usr/bin/codesign', [
    '--force',
    '--sign',
    '-',
    '--entitlements',
    join(directory, 'lima-entitlements.plist'),
    join(output, 'bin/limactl'),
  ]);
}
