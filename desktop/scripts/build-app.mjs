import { constants } from 'node:fs';
import {
  access,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { copyBundleSource as copy, copyEngineDependencies } from './engine-dependencies.mjs';
import { assetHash, runtimeRelease as readRuntimeRelease } from '../runtime/assets.mjs';
import { runtimeInputs } from './runtime-inputs.mjs';
import { buildDesktopUI } from './build-ui.mjs';
import { checkRelease } from '../../.github/scripts/prepare-desktop-release.mjs';
import {
  assess,
  exportCertificate,
  minimumSystemVersion as supportedMinimumSystemVersion,
  notarize,
  run,
  signApplication,
  signingArguments,
  signingConfiguration,
  signingMetadata,
  sourceRevision,
  staple,
  verifyApplicationRuntime,
  verifyIdentity,
  verifyRuntimeRelease,
  verifySignature,
} from './release-tools.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const desktop = join(root, 'desktop');
const output = resolve(process.env.NOD_DESKTOP_OUTPUT || join(root, 'dist', 'desktop'));
const stage = resolve(process.env.NOD_DESKTOP_STAGE || join(root, 'dist', 'desktop-staging'));
const engine = join(stage, 'engine');
const appSource = join(stage, 'app');
const runtimeAssets = resolve(
  process.env.NOD_RUNTIME_ASSETS || join(root, '.local', 'desktop-runtime-assets'),
);
const descriptorOption = process.argv.indexOf('--runtime-descriptor');
if (
  descriptorOption >= 0 &&
  (!process.argv[descriptorOption + 1] || process.argv[descriptorOption + 1].startsWith('--'))
)
  throw new Error('Pass the path to runtime-release.json after --runtime-descriptor.');
const runtimeRelease = resolve(
  root,
  descriptorOption < 0
    ? join(root, '.local', 'desktop-runtime-release', 'runtime-release.json')
    : process.argv[descriptorOption + 1],
);
const full = process.argv.includes('--full');
const signed = process.argv.includes('--release');
const skipArchive = process.argv.includes('--no-runtime-archive');
const stageOnly = process.argv.includes('--stage-only');
if (signed && (full || stageOnly))
  throw new Error('Signed releases require the lean complete application build.');
if (full && skipArchive) throw new Error('Full builds cannot omit their runtime assets.');
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch))
  throw new Error('This desktop build requires an Intel or Apple Silicon Mac.');
if (basename(runtimeRelease) !== 'runtime-release.json')
  throw new Error('The runtime descriptor must be named runtime-release.json.');

const signing = signed ? signingConfiguration() : undefined;
const configuration = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'));
const version = process.env.NOD_DESKTOP_VERSION || configuration.version;
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))
  throw new Error('The desktop version is invalid.');
if (signed && process.env.NOD_RELEASE_PLAN) await checkRelease(root, version);
else if (signed && version !== configuration.version)
  throw new Error('Prepare the desktop package version before its signed release.');
configuration.version = version;
const repository = process.env.GITHUB_REPOSITORY || 'n8n-io/nod';
if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository))
  throw new Error('The desktop release repository is invalid.');
const tracesToken = process.env.NOD_TRACES_TOKEN;
if (tracesToken && !/^[A-Za-z0-9_-]{32,128}$/.test(tracesToken))
  throw new Error('NOD_TRACES_TOKEN must be 32 to 128 URL-safe characters.');
const updateSourceUrl = process.env.NOD_DESKTOP_UPDATE_SOURCE_URL;
if (updateSourceUrl) {
  if (!URL.canParse(updateSourceUrl))
    throw new Error('The desktop update source must be a credential-free HTTPS URL.');
  const url = new URL(updateSourceUrl);
  if (url.protocol !== 'https:' || url.username || url.password || /[?#]/.test(updateSourceUrl))
    throw new Error('The desktop update source must be a credential-free HTTPS URL.');
}
const electronVersion = configuration.devDependencies.electron;
let release;
let minimumSystemVersion;
if (full) {
  const manifest = JSON.parse(await readFile(join(runtimeAssets, 'manifest.json'), 'utf8'));
  minimumSystemVersion = manifest.minimumSystemVersion || supportedMinimumSystemVersion;
} else {
  release = await readRuntimeRelease(dirname(runtimeRelease));
  if (!release) throw new Error('The runtime release descriptor is missing.');
  minimumSystemVersion = release.minimumSystemVersion || supportedMinimumSystemVersion;
  if (signing) {
    await verifyIdentity(signing);
    const inputs = await runtimeInputs();
    if (
      process.env.NOD_EXPECTED_RUNTIME_FINGERPRINT &&
      process.env.NOD_EXPECTED_RUNTIME_FINGERPRINT !== inputs.fingerprint
    )
      throw new Error('The requested runtime fingerprint does not match these inputs.');
    await verifyRuntimeRelease(release, inputs.fingerprint, signing, {
      descriptorPath: runtimeRelease,
    });
  }
  if (!skipArchive) {
    const archive = join(dirname(runtimeRelease), release.archive.file);
    if (
      (await stat(archive)).size !== release.archive.bytes ||
      (await assetHash(archive)) !== release.archive.sha256
    )
      throw new Error('The companion runtime archive failed its integrity check.');
  }
}
for (const path of [
  'node_modules/tsx/dist/esm/api/index.mjs',
  'dist/web/index.html',
  'desktop/ui/index.html',
])
  await access(join(root, path));

await rm(stage, { recursive: true, force: true });
await mkdir(engine, { recursive: true });
await mkdir(appSource, { recursive: true });
await mkdir(output, { recursive: true });
for (const path of [
  'src',
  'public',
  'dist/web',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'LICENSE',
  'NOTICE',
  'desktop/runtime',
  'desktop/main/engine.mjs',
  'desktop/main/onepassword.mjs',
]) {
  await mkdir(dirname(join(engine, path)), { recursive: true });
  await copy(join(root, path), join(engine, path));
}
await copyEngineDependencies({ root, target: engine, arch: process.arch });
for (const path of ['main', 'preload']) await copy(join(desktop, path), join(appSource, path));
await buildDesktopUI(join(appSource, 'ui'));
if (full)
  await cp(runtimeAssets, join(engine, 'runtime-assets'), {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    verbatimSymlinks: true,
  });
else {
  const target = join(engine, 'runtime-release.json');
  await copy(runtimeRelease, target);
  if ((await assetHash(target)) !== (await assetHash(runtimeRelease)))
    throw new Error('The packaged runtime release does not match its source.');
  if (!(await readRuntimeRelease(engine)))
    throw new Error('The packaged runtime release is missing.');
}
configuration.nodBuild = {
  source: await sourceRevision(),
  builtAt: new Date().toISOString(),
  modified: Boolean(await run('/usr/bin/git', ['-C', root, 'status', '--porcelain'])),
  ...(release ? { runtime: release.id } : {}),
  ...(updateSourceUrl ? { updateSourceUrl } : {}),
  ...(tracesToken ? { tracesToken } : {}),
  ...(process.env.NOD_RELEASE_BUILD === 'true' ? { release: true } : {}),
};
delete configuration.devDependencies;
delete configuration.scripts;
await writeFile(join(appSource, 'package.json'), JSON.stringify(configuration, null, 2));
if (stageOnly) {
  console.log(`Desktop engine staged: ${engine}`);
  process.exit(0);
}

const iconset = join(stage, 'nod.iconset');
await mkdir(iconset, { recursive: true });
for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
  const filename = size === 1024 ? 'icon_512x512@2x.png' : `icon_${size}x${size}.png`;
  await run('/usr/bin/sips', [
    '-z',
    String(size),
    String(size),
    join(desktop, 'assets', 'nod-macos.png'),
    '--out',
    join(iconset, filename),
  ]);
}
const icon = join(stage, 'nod.icns');
await run('/usr/bin/iconutil', ['--convert', 'icns', '--output', icon, iconset]);
const paths = await packager({
  dir: appSource,
  out: output,
  name: configuration.productName,
  executableName: configuration.productName,
  appBundleId: 'dev.nod.desktop',
  appVersion: version,
  appCopyright: 'Copyright © 2026 n8n GmbH',
  electronVersion,
  platform: 'darwin',
  arch: process.arch,
  asar: false,
  prune: false,
  overwrite: true,
  icon,
  extendInfo: {
    LSMinimumSystemVersion: minimumSystemVersion,
    ElectronSquirrelPreventDowngrades: true,
    NSMicrophoneUsageDescription: 'nod uses your microphone when you record a voice message.',
  },
});
const application = join(paths[0], `${configuration.productName}.app`);
await rename(engine, join(application, 'Contents', 'Resources', 'engine'));
const licenses = join(application, 'Contents', 'Resources', 'licenses');
await mkdir(licenses, { recursive: true });
for (const name of ['LICENSE', 'LICENSES.chromium.html'])
  await copy(join(paths[0], name), join(licenses, name));
let nativeBinaries;
let applicationNotarization;
if (signing) {
  console.log(`Signing the application (${signing.mode}).`);
  nativeBinaries = await signApplication(application, electronVersion, signing);
  await exportCertificate(signing, join(output, 'signing.cer'));
  if (signing.mode === 'developer-id') {
    const archive = join(stage, 'application-notarization.zip');
    try {
      await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', application, archive], {
        timeout: 10 * 60_000,
      });
      applicationNotarization = await notarize(
        archive,
        signing,
        join(output, 'application-notarization.json'),
      );
      await staple(application);
      await verifySignature(application, signing, { executable: true });
      await assess(application, 'execute');
    } finally {
      await rm(archive, { force: true });
    }
  }
} else {
  await run(
    '/usr/bin/codesign',
    ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', application],
    { timeout: 10 * 60_000 },
  );
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
}
await verifyApplicationRuntime(application, electronVersion);
console.log(`Application ready: ${application}`);
for (const entry of await readdir(output, { withFileTypes: true }))
  if (entry.isFile() && /\.(?:dmg|zip)(?:\.sha256)?$/.test(entry.name))
    await rm(join(output, entry.name));
const updateArchive = join(
  output,
  full ? `nod-full-${process.arch}.zip` : `nod-${process.arch}.zip`,
);
await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', application, updateArchive], {
  timeout: 10 * 60_000,
});
await run('/usr/bin/unzip', ['-tq', updateArchive], { timeout: 10 * 60_000 });
if ((await stat(updateArchive)).size >= 2 * 1024 ** 3)
  throw new Error('The application ZIP exceeds GitHub’s per-asset release limit.');
const update = {
  file: basename(updateArchive),
  bytes: (await stat(updateArchive)).size,
  sha256: await assetHash(updateArchive),
};
const diskStage = join(stage, 'disk');
await mkdir(diskStage, { recursive: true });
await run('/bin/cp', ['-cR', application, join(diskStage, `${configuration.productName}.app`)]);
await run('/bin/ln', ['-s', '/Applications', join(diskStage, 'Applications')]);
const diskImage = join(output, full ? `nod-full-${process.arch}.dmg` : `nod-${process.arch}.dmg`);
const writableImage = join(stage, 'disk.dmg');
await run(
  '/usr/bin/hdiutil',
  [
    'create',
    '-volname',
    configuration.productName,
    '-srcfolder',
    diskStage,
    '-ov',
    '-format',
    'UDRW',
    writableImage,
  ],
  { timeout: 15 * 60_000 },
);
await run(
  '/usr/bin/hdiutil',
  ['convert', writableImage, '-format', 'ULFO', '-ov', '-o', diskImage],
  {
    timeout: 15 * 60_000,
  },
);
await rm(writableImage, { force: true });
let diskNotarization;
if (signing) {
  await run('/usr/bin/codesign', [...signingArguments(signing), diskImage]);
  await verifySignature(diskImage, signing);
  if (signing.mode === 'developer-id') {
    diskNotarization = await notarize(diskImage, signing, join(output, 'disk-notarization.json'));
    await staple(diskImage);
    await verifySignature(diskImage, signing);
    await assess(diskImage, 'open');
  }
}
await run('/usr/bin/hdiutil', ['verify', diskImage], { timeout: 10 * 60_000 });
if ((await stat(diskImage)).size >= 2 * 1024 ** 3)
  throw new Error('The disk image exceeds GitHub’s per-asset release limit.');
const disk = {
  file: basename(diskImage),
  bytes: (await stat(diskImage)).size,
  sha256: await assetHash(diskImage),
};
await writeFile(`${diskImage}.sha256`, `${disk.sha256}  ${disk.file}\n`);
await writeFile(
  join(output, 'SHA256SUMS'),
  `${disk.sha256}  ${disk.file}\n${update.sha256}  ${update.file}\n`,
);
await writeFile(
  join(output, 'update.json'),
  JSON.stringify(
    {
      url: `https://github.com/${repository}/releases/download/nod-v${version}/${update.file}`,
      name: `nod ${version}`,
      pub_date: configuration.nodBuild.builtAt.replace(/\.\d{3}Z$/, 'Z'),
    },
    null,
    2,
  ) + '\n',
);
if (release) {
  await copy(runtimeRelease, join(output, 'runtime-release.json'));
  if ((await assetHash(join(output, 'runtime-release.json'))) !== (await assetHash(runtimeRelease)))
    throw new Error('The release descriptor copy failed verification.');
}
const detail = await run('/usr/bin/codesign', ['-d', '--verbose=4', application]);
await writeFile(
  join(output, 'release.json'),
  JSON.stringify(
    {
      version,
      platform: `darwin-${process.arch}`,
      minimumSystemVersion,
      source: await sourceRevision(),
      ...(updateSourceUrl ? { updateSourceUrl } : {}),
      signing: signing ? signingMetadata(signing) : { mode: 'ad-hoc' },
      notarized: signing?.mode === 'developer-id',
      ...(applicationNotarization
        ? { notarization: { application: applicationNotarization, disk: diskNotarization } }
        : {}),
      nativeBinaries,
      cdHash: detail.match(/^CDHash=(\w+)/m)?.[1],
      disk,
      update,
      runtime: release
        ? {
            fingerprint: release.fingerprint,
            id: release.id,
            archive: release.archive,
            ...(release.url ? { url: release.url } : {}),
          }
        : { included: true },
    },
    null,
    2,
  ) + '\n',
);
if (!full && !skipArchive) {
  const target = join(output, release.archive.file);
  await copy(join(dirname(runtimeRelease), release.archive.file), target);
  if ((await assetHash(target)) !== release.archive.sha256)
    throw new Error('The copied runtime archive failed its integrity check.');
  console.log(`Runtime pack: ${target}`);
}
console.log(`Disk image: ${diskImage}`);
console.log(
  signing?.mode === 'developer-id'
    ? 'Developer ID signed, notarized, stapled, and verified.'
    : signing
      ? 'Signed with the internal certificate. Not notarized; macOS may require a manual security approval.'
      : 'This local preview is ad-hoc signed and is not notarized for public distribution.',
);
