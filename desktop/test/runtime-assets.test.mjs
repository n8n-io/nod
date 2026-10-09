import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { create } from 'tar';
import { copyBundleSource, copyEngineDependencies } from '../scripts/engine-dependencies.mjs';
import {
  assetHash,
  ensureRuntimeAssets,
  findRuntimeAssets,
  installRuntimeArchive,
} from '../runtime/assets.mjs';
import {
  automaticRelease,
  checkRelease,
  checkReleasePlan,
  prepareRelease,
} from '../../.github/scripts/prepare-desktop-release.mjs';
import { cleanupAppleSigning } from '../../.github/scripts/with-apple-signing.mjs';
import { verifyRuntimeDownload, verifyRuntimeRelease } from '../scripts/release-tools.mjs';

async function releaseRepository(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'otto-release-history-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Synthetic Release Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Synthetic Release Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const commit = () => {
    git('add', '.');
    git('commit', '-m', 'Synthetic release change');
    return git('rev-parse', 'HEAD');
  };
  await mkdir(join(root, 'desktop'));
  const pkg = { name: 'synthetic-desktop', version: '0.1.0' };
  await Promise.all([
    writeFile(join(root, 'desktop/package.json'), JSON.stringify(pkg)),
    writeFile(join(root, 'desktop/pnpm-lock.yaml'), 'lockfileVersion: 9.0\n'),
    writeFile(join(root, 'desktop/CHANGELOG.md'), '# Desktop changes\n'),
    writeFile(join(root, 'desktop/main.mjs'), 'export const initial = true;\n'),
  ]);
  git('init', '--initial-branch=main');
  commit();
  return { root, git, commit };
}

test('release preparation records initial and subsequent source histories and rejects reused versions', async (t) => {
  const f = await releaseRepository(t);
  const initial = await prepareRelease(f.root, '0.1.0');
  assert.equal(initial.previousTag, null);
  f.commit();
  assert.equal((await checkRelease(f.root, '0.1.0')).source, initial.source);
  f.git('tag', 'desktop-v0.1.0', initial.source);
  await assert.rejects(checkRelease(f.root, '0.1.0'), /previous tag does not match/);
  f.git('tag', '--force', 'desktop-v0.1.0');
  await writeFile(join(f.root, 'desktop/main.mjs'), 'export const updated = true;\n');
  f.commit();
  await assert.rejects(prepareRelease(f.root, '0.1.0'), /already exists/);
  const next = await prepareRelease(f.root, '0.2.0');
  assert.equal(next.previousTag, 'desktop-v0.1.0');
  f.commit();
  const checked = await checkRelease(f.root, '0.2.0');
  assert.equal(checked.source, next.source);
  assert.match(checked.notes, /Previous release: `desktop-v0.1.0`/);
});

test('release gate rejects malformed metadata, uncommitted notes and source drift', async (t) => {
  const f = await releaseRepository(t);
  await assert.rejects(prepareRelease(f.root, '0.1.0-alpha'), /stable semantic version/);
  await prepareRelease(f.root, '0.1.0');
  const prepared = f.commit();
  const notes = join(f.root, 'desktop/CHANGELOG.md');
  await writeFile(notes, '# Replaced notes\n');
  await assert.rejects(checkRelease(f.root, '0.1.0'), /Commit desktop\/CHANGELOG.md/);
  f.commit();
  await assert.rejects(checkRelease(f.root, '0.1.0'), /leading changelog section/);
  f.git('reset', '--hard', prepared);
  const manifestPath = join(f.root, 'desktop/release.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: '9.9.9' }));
  f.commit();
  await assert.rejects(checkRelease(f.root, '0.1.0'), /inconsistent/);
  f.git('reset', '--hard', prepared);
  await writeFile(join(f.root, 'desktop/main.mjs'), 'export const late = true;\n');
  f.commit();
  await assert.rejects(
    checkRelease(f.root, '0.1.0'),
    /Source changes landed after release preparation/,
  );
});

test('automatic patches release unchanged source and bind generated notes across midnight', async (t) => {
  const f = await releaseRepository(t);
  await prepareRelease(f.root, '0.1.0');
  const source = f.commit();
  f.git('tag', 'desktop-v0.1.0');
  const releases = [{ tag_name: 'desktop-v0.1.0', draft: false }];
  const plan = automaticRelease(f.root, releases, 'synthetic/otto');
  assert.equal(plan.version, '0.1.1');
  assert.equal(plan.source, source);
  assert.equal(plan.previousTag, 'desktop-v0.1.0');
  assert.equal(f.git('status', '--porcelain'), '');
  const path = join(f.root, 'release-plan.json');
  const bytes = JSON.stringify(plan);
  const digest = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path, bytes);
  assert.deepEqual(await checkReleasePlan(f.root, plan.version, path, digest), plan);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 24 * 60 * 60 * 1000 });
  assert.deepEqual(await checkReleasePlan(f.root, plan.version, path, digest), plan);
  const nextDay = automaticRelease(f.root, releases, 'synthetic/otto');
  assert.notEqual(nextDay.date, plan.date);
  t.mock.timers.reset();
  const tampered = JSON.stringify({ ...plan, notes: plan.notes + '\nAltered release.\n' });
  await writeFile(path, tampered);
  await assert.rejects(checkReleasePlan(f.root, plan.version, path, digest), /checksum/);
  await assert.rejects(
    checkReleasePlan(
      f.root,
      plan.version,
      path,
      createHash('sha256').update(tampered).digest('hex'),
    ),
    /notes do not match/,
  );
  await writeFile(path, bytes);
  await writeFile(join(f.root, 'desktop/main.mjs'), 'export const dirty = true;\n');
  await assert.rejects(checkReleasePlan(f.root, plan.version, path, digest), /clean tested source/);
  f.git('add', 'desktop/main.mjs');
  f.git('commit', '-m', 'Synthetic late change');
  await assert.rejects(checkReleasePlan(f.root, plan.version, path, digest), /clean tested source/);
});

test('automatic patches resume the matching draft and never reuse an occupied or published version', async (t) => {
  const f = await releaseRepository(t);
  await prepareRelease(f.root, '0.1.0');
  f.commit();
  f.git('tag', 'desktop-v0.1.0');
  await writeFile(join(f.root, 'desktop/main.mjs'), 'export const updated = true;\n');
  const source = f.commit();
  const published = { tag_name: 'desktop-v0.1.0', draft: false };
  const pending = {
    tag_name: 'desktop-v0.1.1',
    draft: true,
    target_commitish: source,
    body: `Source: https://github.com/synthetic/otto/commit/${source}`,
  };
  assert.equal(automaticRelease(f.root, [published, pending], 'synthetic/otto').version, '0.1.1');
  assert.throws(
    () =>
      automaticRelease(
        f.root,
        [published, { ...pending, body: 'Unrelated draft' }],
        'synthetic/otto',
      ),
    /pending desktop release/,
  );
  const stale = { ...pending, target_commitish: '0'.repeat(40) };
  assert.equal(automaticRelease(f.root, [published, stale], 'synthetic/otto').version, '0.1.2');
  f.git('tag', 'desktop-v0.1.2');
  assert.equal(automaticRelease(f.root, [published, stale], 'synthetic/otto').version, '0.1.3');
  f.git('tag', 'desktop-v0.1.1');
  assert.equal(
    automaticRelease(f.root, [published, { ...pending, draft: false }], 'synthetic/otto').version,
    '0.1.3',
  );
  assert.throws(
    () =>
      automaticRelease(f.root, [{ tag_name: 'desktop-v9.0.0', draft: false }], 'synthetic/otto'),
    /latest published desktop tag/,
  );
});

test('signing cleanup fences process identity and stops an orphaned group before deleting its keychain', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'otto-signing-cleanup-')));
  const directory = await mkdtemp(join(root, 'otto-apple-signing-'));
  const worker = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  t.after(async () => {
    try {
      process.kill(-worker.pid, 'SIGKILL');
    } catch {}
    await rm(root, { recursive: true, force: true });
  });
  await once(worker.stdout, 'data');
  const exited = once(worker, 'exit');
  const started = execFileSync('/bin/ps', ['-p', String(worker.pid), '-o', 'lstart='], {
    encoding: 'utf8',
  }).trim();
  const keychain = join(directory, 'signing.keychain-db');
  const marker = join(root, 'otto-apple-signing-state.json');
  const state = {
    version: 2,
    pid: 2147483647,
    directory,
    keychain,
    searchList: [],
    groups: [{ pid: worker.pid, started: 'Wrong process start time' }],
  };
  await writeFile(keychain, 'Synthetic keychain', { mode: 0o600 });
  await writeFile(marker, JSON.stringify(state), { mode: 0o600 });
  const calls = [];
  const run = async (command, args) => {
    assert.equal(command, '/usr/bin/security');
    assert.equal(worker.signalCode, 'SIGKILL');
    calls.push(args[0]);
    if (args[0] === 'delete-keychain') await rm(keychain);
  };
  await assert.rejects(
    cleanupAppleSigning({ env: { RUNNER_TEMP: root }, run }),
    /recorded identity/,
  );
  assert.deepEqual(calls, []);
  assert.equal(await readFile(keychain, 'utf8'), 'Synthetic keychain');
  state.groups[0].started = started;
  await writeFile(marker, JSON.stringify(state), { mode: 0o600 });
  await cleanupAppleSigning({ env: { RUNNER_TEMP: root }, run });
  await exited;
  assert.deepEqual(calls, ['delete-keychain', 'list-keychains']);
  assert.deepEqual(await readdir(root), []);
});

test('signing discovery preserves native bundles and skips symlinks under a low file limit', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'otto-signing-discovery-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const application = join(root, 'Synthetic.app');
  const framework = join(application, 'Contents/Frameworks/Synthetic.framework');
  const helper = join(application, 'Contents/Helpers/Synthetic Helper.app');
  const native = [join(framework, 'Versions/A/Synthetic'), join(helper, 'Contents/MacOS/helper')];
  for (const file of native) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
  }
  for (let directory = 0; directory < 8; directory++) {
    const path = join(application, 'Contents/Resources/dependencies', String(directory));
    await mkdir(path, { recursive: true });
    for (let file = 0; file < 256; file++)
      await writeFile(join(path, `${file}.js`), 'export const synthetic = true;\n');
  }
  const outside = join(root, 'outside');
  await mkdir(outside);
  const sentinel = join(outside, 'untouched.cstemp');
  await writeFile(sentinel, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0]));
  await symlink(outside, join(application, 'outside'));
  await symlink(application, join(application, 'cycle'));
  await symlink(native[0], join(framework, 'Synthetic'));
  const stale = join(application, 'stale.cstemp');
  await writeFile(stale, 'Synthetic stale signing file');
  const utility = pathToFileURL(
    join(dirname(fileURLToPath(import.meta.resolve('@electron/osx-sign'))), 'util.js'),
  ).href;
  const script = `import { walk } from ${JSON.stringify(utility)};
process.stdout.write(JSON.stringify(await walk(process.argv[1])));`;
  const { stdout } = await promisify(execFile)(
    '/bin/sh',
    [
      '-c',
      'ulimit -n 256\nexec "$@"',
      'otto-signing-discovery',
      process.execPath,
      '--input-type=module',
      '-e',
      script,
      application,
    ],
    { env: { PATH: process.env.PATH }, timeout: 30_000 },
  );
  const paths = JSON.parse(stdout);
  assert.deepEqual([...paths].sort(), [...native, framework, helper].sort());
  assert(paths.indexOf(native[0]) < paths.indexOf(framework));
  assert(paths.indexOf(native[1]) < paths.indexOf(helper));
  assert.equal((await readFile(sentinel)).length, 5);
  await assert.rejects(stat(stale), { code: 'ENOENT' });
});

test('runtime public verification uses a bounded GET when HEAD is unsupported or lacks length', async (t) => {
  for (const head of [new Response(null, { status: 405 }), new Response(null, { status: 200 })]) {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls.push(options);
      return options.method === 'HEAD'
        ? head
        : new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/123' } });
    });
    await verifyRuntimeDownload('https://runtime.example.invalid/runtime.tar.gz', {
      file: 'runtime.tar.gz',
      bytes: 123,
    });
    assert.deepEqual(
      calls.map((call) => call.method),
      ['HEAD', 'GET'],
    );
    assert.equal(calls[1].headers.range, 'bytes=0-0');
    await assert.rejects(
      verifyRuntimeDownload('https://runtime.example.invalid/runtime.tar.gz', {
        file: 'runtime.tar.gz',
        bytes: 124,
      }),
      /expected size/,
    );
    t.mock.restoreAll();
  }
});

async function releaseFixture(
  t,
  {
    isPublic = false,
    publish = false,
    plan = false,
    runtimeRepository = 'synthetic/otto',
    diskName = 'Otto-arm64.dmg',
    updateSourceUrl,
    automatic = false,
  } = {},
) {
  const f = await releaseRepository(t);
  const root = f.root;
  const scripts = join(root, '.github/scripts');
  await mkdir(scripts, { recursive: true });
  await copyFile(
    fileURLToPath(new URL('../../.github/scripts/prepare-desktop-release.mjs', import.meta.url)),
    join(scripts, 'prepare-desktop-release.mjs'),
  );
  if (plan) {
    const { runtimeInputs } = await import('../scripts/runtime-inputs.mjs');
    const input = await runtimeInputs();
    const repository = fileURLToPath(new URL('../../', import.meta.url));
    for (const path of new Set([
      ...input.inputs.filter(
        (path) => !path.includes(':') && !path.startsWith('@') && !path.startsWith('signing.'),
      ),
      'pnpm-lock.yaml',
      'desktop/package.json',
      'desktop/pnpm-lock.yaml',
    ])) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await copyFile(join(repository, path), join(root, path));
    }
    for (const path of ['desktop/package.json']) {
      const file = join(root, path);
      const value = JSON.parse(await readFile(file, 'utf8'));
      value.version = '0.1.0';
      if (value.packages) value.packages[''].version = '0.1.0';
      await writeFile(file, JSON.stringify(value));
    }
  }
  f.commit();
  await prepareRelease(root, '0.1.0');
  let source = f.commit();
  const baseline = source;
  if (automatic) {
    f.git('tag', 'desktop-v0.1.0');
    await writeFile(join(root, 'desktop/main.mjs'), 'export const next = true;\n');
    source = f.commit();
  }
  const assets = join(root, '.local/desktop-runtime-release');
  const output = join(root, 'dist/desktop');
  const bin = join(root, 'bin');
  await Promise.all([
    mkdir(assets, { recursive: true }),
    mkdir(output, { recursive: true }),
    mkdir(bin),
  ]);
  await writeFile(join(bin, 'package.json'), '{"type":"commonjs"}');
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const archive = Buffer.from('Synthetic runtime archive');
  const certificate = Buffer.from('Synthetic public certificate');
  const signingEnv = {
    OTTO_SIGNING_MODE: isPublic ? 'developer-id' : 'self-signed',
    OTTO_SIGNING_IDENTITY: 'Synthetic Otto Signing',
    OTTO_SIGNING_CERTIFICATE_SHA256: digest(certificate),
  };
  const fingerprint = plan
    ? JSON.parse(
        (
          await promisify(execFile)(
            process.execPath,
            [join(root, 'desktop/scripts/runtime-inputs.mjs')],
            { env: signingEnv },
          )
        ).stdout,
      ).fingerprint
    : digest('Synthetic runtime inputs');
  const runtimeTag = `runtime-darwin-arm64-${fingerprint}`;
  const version = automatic ? '0.1.1' : '0.1.0';
  const appTag = `desktop-v${version}`;
  const name = `Otto-Runtime-darwin-arm64-${digest(archive).slice(0, 12)}.tar.gz`;
  const release = {
    version: 1,
    platform: 'darwin-arm64',
    fingerprint,
    id: digest('Synthetic runtime files'),
    source,
    minimumSystemVersion: '14.0',
    archive: { file: name, bytes: archive.length, sha256: digest(archive) },
    signing: {
      mode: isPublic ? 'developer-id' : 'self-signed',
      certificateSha256: digest(certificate),
      ...(isPublic ? { teamId: 'SYNTHETIC1' } : {}),
    },
    ...(isPublic
      ? { notarization: { status: 'Accepted', id: '12345678-1234-1234-1234-123456789abc' } }
      : {}),
    ...(isPublic && publish
      ? { url: `https://github.com/synthetic/otto/releases/download/${runtimeTag}/${name}` }
      : {}),
  };
  const disk = Buffer.from('Synthetic signed disk image');
  const update = Buffer.from('Synthetic signed application ZIP');
  const updateName = 'Otto-arm64.zip';
  const feed = {
    url: `https://github.com/synthetic/otto/releases/download/${appTag}/${updateName}`,
    name: `Otto ${version}`,
    pub_date: '2026-10-04T12:00:00Z',
  };
  const metadata = {
    version,
    source,
    ...(updateSourceUrl ? { updateSourceUrl } : {}),
    signing: release.signing,
    notarized: isPublic,
    runtime: { fingerprint, id: release.id, archive: release.archive },
    disk: { file: diskName, bytes: disk.length, sha256: digest(disk) },
    update: { file: updateName, bytes: update.length, sha256: digest(update) },
  };
  await Promise.all([
    writeFile(join(assets, name), archive),
    writeFile(join(assets, 'runtime-release.json'), JSON.stringify(release)),
    writeFile(join(assets, 'SHA256SUMS'), `${digest(archive)}  ${name}\n`),
    writeFile(join(assets, 'signing.cer'), certificate),
    writeFile(join(output, diskName), disk),
    writeFile(join(output, updateName), update),
    writeFile(join(output, 'update.json'), JSON.stringify(feed)),
    writeFile(join(output, 'release.json'), JSON.stringify(metadata)),
    writeFile(join(output, 'runtime-release.json'), JSON.stringify(release)),
    writeFile(
      join(output, 'SHA256SUMS'),
      `${digest(disk)}  ${diskName}\n${digest(update)}  ${updateName}\n`,
    ),
    writeFile(join(output, 'signing.cer'), certificate),
  ]);
  const statePath = join(root, 'github.json');
  const readState = async () => JSON.parse(await readFile(statePath, 'utf8'));
  const writeState = (state) => writeFile(statePath, JSON.stringify(state));
  await writeState({
    private: !isPublic,
    runtimeRepository,
    releases: automatic
      ? {
          'desktop-v0.1.0': {
            id: 100,
            tag_name: 'desktop-v0.1.0',
            target_commitish: baseline,
            draft: false,
            assets: [],
          },
        }
      : {},
    created: 0,
    calls: [],
    contents: {},
    runs: [
      {
        head_sha: source,
        head_branch: 'main',
        head_repository: { full_name: 'synthetic/otto' },
        event: 'push',
        conclusion: 'success',
      },
    ],
  });
  await writeFile(
    join(bin, 'gh'),
    `#!${process.execPath}\n` +
      String.raw`const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { basename, join } = require('node:path');
const { createHash } = require('node:crypto');
const file = process.env.FIXTURE_STATE;
const state = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args);
const save = () => writeFileSync(file, JSON.stringify(state));
const missing = () => { save(); process.stderr.write('Not Found (HTTP 404)'); process.exit(1); };
const output = (value) => { save(); process.stdout.write(JSON.stringify(value)); process.exit(0); };
const flag = (name) => args[args.indexOf(name) + 1];
if (args[0] === 'api') {
  if (args[1] === 'repos/synthetic/otto' || args[1] === 'repos/' + state.runtimeRepository) output({ private: state.private });
  if (args[1] === 'repos/' + state.runtimeRepository + '/commits/main') output({ sha: 'f'.repeat(40) });
  if (args[1].includes('/actions/workflows/')) output({ workflow_runs: state.runs });
  if (args[1] === 'repos/synthetic/otto/releases?per_page=100') {
    save();
    process.stdout.write(Object.values(state.releases).map(release => JSON.stringify(release)).join('\n'));
    process.exit(0);
  }
  if (args[1] === 'graphql') {
    const tag = args.find(value => value.startsWith('tag=')).slice(4);
    const release = state.releases[tag];
    output({ data: { repository: { release: release ? { databaseId: release.id } : null } } });
  }
  if (args[1].includes('/releases/tags/')) {
    const release = state.releases[args[1].split('/').at(-1)];
    if (release && !release.draft) output(release);
  }
  const release = Object.values(state.releases).find(value => args[1] === 'repos/synthetic/otto/releases/' + value.id || args[1] === 'repos/' + state.runtimeRepository + '/releases/' + value.id);
  if (release) output(release);
  missing();
}
if (args[0] !== 'release') throw new Error('Unexpected command');
const tag = args[2];
if (args[1] === 'create') {
  if (state.releases[tag]) throw new Error('Duplicate release');
  const id = ++state.created;
  state.releases[tag] = { id, tag_name: tag, target_commitish: args.includes('--target') ? flag('--target') : 'main', draft: args.includes('--draft'), prerelease: args.includes('--prerelease'), body: readFileSync(flag('--notes-file'), 'utf8'), html_url: 'https://github.com/synthetic/otto/releases/tag/untagged-' + id, assets: [] };
} else {
  const release = state.releases[tag];
  if (!release) missing();
  if (args[1] === 'edit') {
    const nextTag = args.includes('--tag') ? flag('--tag') : 'untagged-' + release.id;
    if (nextTag !== tag) {
      delete state.releases[tag];
      state.releases[nextTag] = release;
    }
    release.tag_name = nextTag;
    if (args.includes('--target')) release.target_commitish = flag('--target');
    if (args.includes('--draft=false')) {
      release.draft = false;
      release.html_url = 'https://github.com/synthetic/otto/releases/tag/' + tag;
    }
    if (args.includes('--notes-file')) release.body = readFileSync(flag('--notes-file'), 'utf8');
  } else if (args[1] === 'upload') {
    const bytes = readFileSync(args[3]);
    const name = basename(args[3]);
    release.assets = release.assets.filter(asset => asset.name !== name);
    release.assets.push({ name, size: bytes.length, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') });
    state.contents[tag + '/' + name] = bytes.toString('base64');
  } else if (args[1] === 'download') {
    const name = flag('--pattern');
    if (!state.contents[tag + '/' + name]) missing();
    mkdirSync(flag('--dir'), { recursive: true });
    writeFileSync(join(flag('--dir'), name), (state.corruptDmg && name.endsWith('.dmg')) || (state.corruptZip && name.endsWith('.zip')) ? 'Corrupted application' : Buffer.from(state.contents[tag + '/' + name], 'base64'));
  } else throw new Error('Unexpected release operation');
}
save();
`,
    { mode: 0o700 },
  );
  const network = join(root, 'network.mjs');
  await writeFile(
    network,
    String.raw`import { readFileSync, writeFileSync } from 'node:fs';
globalThis.fetch = async (url, options = {}) => {
  const file = process.env.FIXTURE_STATE;
  const state = JSON.parse(readFileSync(file, 'utf8'));
  state.calls.push(['fetch', options.method || 'GET', String(url)]);
  writeFileSync(file, JSON.stringify(state));
  const match = String(url).match(/^https:\/\/github\.com\/synthetic\/otto\/releases\/download\/([^/]+)\/([^/]+)$/);
  if (!match) throw new Error('Unexpected network access');
  const [, tag, name] = match;
  const bytes = state.contents[tag + '/' + name];
  if (state.releases[tag]?.draft || !bytes || state.failPublicDownload) return new Response(null, { status: 404 });
  const body = Buffer.from(bytes, 'base64');
  return new Response(options.method === 'HEAD' ? null : body, { headers: { 'content-length': String(body.length) } });
};
`,
  );
  const script = fileURLToPath(
    new URL('../../.github/scripts/desktop-release.mjs', import.meta.url),
  );
  const invoke = (command, requestPublish = publish, environment = {}) =>
    promisify(execFile)(process.execPath, [script, command], {
      cwd: root,
      env: {
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        FIXTURE_STATE: statePath,
        NODE_OPTIONS: `--import=${network}`,
        GH_TOKEN: 'synthetic-fixture-token',
        RELEASE_TOKEN: 'synthetic-fixture-token',
        OTTO_RUNTIME_REPO: runtimeRepository,
        GITHUB_REPOSITORY: 'synthetic/otto',
        GITHUB_SHA: source,
        GITHUB_REF: 'refs/heads/main',
        GITHUB_ACTIONS: 'true',
        APPLE_CONFIGURED: 'true',
        ...signingEnv,
        OTTO_RUNTIME_FINGERPRINT: fingerprint,
        OTTO_EXPECTED_RUNTIME_FINGERPRINT: fingerprint,
        OTTO_PUBLISH_RELEASE: String(requestPublish),
        OTTO_AUTOMATIC_RELEASE: String(automatic),
        ...(updateSourceUrl ? { OTTO_DESKTOP_UPDATE_SOURCE_URL: updateSourceUrl } : {}),
        ...environment,
      },
      timeout: 30_000,
    });
  return {
    root,
    source,
    git: f.git,
    invoke,
    readState,
    writeState,
    release,
    assets,
    output,
    runtimeTag,
    appTag,
    digest,
    metadata,
    feed,
  };
}

test('automatic delivery requires current exact-main CI and publishes only its checked metadata', async (t) => {
  const f = await releaseFixture(t, { automatic: true, plan: true, publish: true });
  const initial = await f.readState();
  const successful = initial.runs[0];
  for (const runs of [
    [],
    [{ ...successful, head_sha: '0'.repeat(40) }],
    [{ ...successful, head_branch: 'feature' }],
    [{ ...successful, head_repository: { full_name: 'synthetic/fork' } }],
    [{ ...successful, event: 'pull_request' }],
    [{ ...successful, conclusion: 'failure' }, successful],
    [{ ...successful, conclusion: null }, successful],
  ]) {
    await f.writeState({ ...initial, runs });
    await assert.rejects(f.invoke('plan'), /exact main revision must pass CI/);
    assert.equal((await f.readState()).created, 0);
  }
  await f.writeState(initial);
  const plan = JSON.parse((await f.invoke('plan')).stdout);
  assert.equal(plan.release_needed, 'true');
  assert.equal(plan.version, '0.1.1');
  assert.equal(plan.source, f.source);
  assert.equal(JSON.parse(await readFile(join(f.root, 'desktop/package.json'))).version, '0.1.0');
  assert.equal(f.git('status', '--porcelain', '--untracked-files=no'), '');
  const environment = {
    OTTO_RELEASE_PLAN: join(f.root, '.local/desktop-release-plan.json'),
    OTTO_RELEASE_PLAN_SHA256: plan.metadata_sha256,
  };
  await f.invoke('draft-runtime');
  await assert.rejects(
    f.invoke('draft', true, { ...environment, OTTO_RELEASE_PLAN_SHA256: '0'.repeat(64) }),
    /checksum/,
  );
  await assert.rejects(
    f.invoke('draft', true, { ...environment, GITHUB_ACTIONS: 'false' }),
    /only accepted in GitHub Actions/,
  );
  assert.equal((await f.readState()).releases[f.appTag], undefined);
  await f.invoke('draft', true, environment);
  const published = await f.readState();
  assert.equal(published.releases[f.appTag].draft, false);
  assert.equal(published.releases[f.appTag].target_commitish, f.source);
  assert.equal(published.releases[f.runtimeTag].draft, false);
  assert.equal(published.created, 2);
  assert.deepEqual(published.releases['desktop-v0.1.0'], initial.releases['desktop-v0.1.0']);
  f.git('tag', f.appTag);
  await assert.rejects(
    f.invoke('plan', true, { APPLE_CONFIGURED: 'false' }),
    /Configure signing credentials/,
  );
  const repeated = JSON.parse((await f.invoke('plan')).stdout);
  assert.equal(repeated.release_needed, 'true');
  assert.equal(repeated.version, '0.1.2');
  assert.equal(repeated.runtime_reused, 'true');
  assert.deepEqual((await f.readState()).releases, published.releases);
  assert.equal((await f.readState()).created, 2);
});

test('runtime and app drafts handle pending tags and retries without publishing either release', async (t) => {
  const f = await releaseFixture(t);
  const initial = JSON.parse((await f.invoke('draft-runtime')).stdout);
  assert.equal(
    initial.runtime_descriptor_sha256,
    await assetHash(join(f.assets, 'runtime-release.json')),
  );
  await f.invoke('draft-runtime');
  await f.invoke('draft');
  await f.invoke('draft');
  const state = await f.readState();
  assert.equal(state.created, 2);
  for (const [tag, release] of Object.entries(state.releases)) {
    assert.equal(release.tag_name, tag);
    assert.equal(release.target_commitish, f.metadata.source);
    assert.equal(release.draft, true);
    assert.equal(release.prerelease, true);
  }
  assert(state.releases[f.appTag].body.includes(state.releases[f.runtimeTag].html_url));
  for (const name of [f.metadata.update.file, 'update.json', 'SHA256SUMS']) {
    const bytes = await readFile(join(f.output, name));
    assert.equal(state.contents[f.appTag + '/' + name], bytes.toString('base64'));
  }
  assert(!state.calls.some((call) => call.includes('--draft=false')));
});

test('foreign runtime draft edits retain their resolved repository target', async (t) => {
  const f = await releaseFixture(t, { runtimeRepository: 'synthetic/runtime', publish: true });
  await f.invoke('draft-runtime');
  await f.invoke('draft-runtime');
  await f.invoke('draft');
  const state = await f.readState();
  assert.equal(state.releases[f.runtimeTag].target_commitish, 'f'.repeat(40));
  assert.equal(state.releases[f.appTag].target_commitish, f.metadata.source);
  assert.equal(state.releases[f.runtimeTag].tag_name, f.runtimeTag);
  assert.equal(state.releases[f.appTag].tag_name, f.appTag);
  assert(Object.values(state.releases).every((release) => !release.draft));
});

test('app upload rejects mismatched update artifacts, feed and provenance', async (t) => {
  const f = await releaseFixture(t);
  await f.invoke('draft-runtime');
  const metadataPath = join(f.output, 'release.json');
  const feedPath = join(f.output, 'update.json');
  const checksumsPath = join(f.output, 'SHA256SUMS');
  const updatePath = join(f.output, f.metadata.update.file);
  const original = new Map(
    await Promise.all(
      [metadataPath, feedPath, checksumsPath, updatePath].map(async (path) => [
        path,
        await readFile(path),
      ]),
    ),
  );
  const cases = [
    ['ZIP contents', () => writeFile(updatePath, 'Different application')],
    ['ZIP size', (metadata) => (metadata.update.bytes += 1)],
    ['ZIP filename', (metadata) => (metadata.update.file = '../outside.zip')],
    ['ZIP limit', (metadata) => (metadata.update.bytes = 2 * 1024 ** 3)],
    ['source', (metadata) => (metadata.source = '0'.repeat(40))],
    ['update source', (metadata) => (metadata.updateSourceUrl = 'https://unapproved.invalid')],
    ['certificate', (metadata) => (metadata.signing.certificateSha256 = '0'.repeat(64))],
    ['runtime', (metadata) => (metadata.runtime.archive.bytes += 1)],
    ['feed release', (_metadata, feed) => (feed.url = feed.url.replace('v0.1.0', 'v0.2.0'))],
    ['feed date', (_metadata, feed) => (feed.pub_date = '2026-99-99T12:00:00Z')],
    [
      'missing ZIP checksum',
      () => writeFile(checksumsPath, `${f.metadata.disk.sha256}  ${f.metadata.disk.file}\n`),
    ],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      for (const [path, bytes] of original) await writeFile(path, bytes);
      const metadata = structuredClone(f.metadata);
      const feed = structuredClone(f.feed);
      await mutate(metadata, feed);
      await writeFile(metadataPath, JSON.stringify(metadata));
      await writeFile(feedPath, JSON.stringify(feed));
      await assert.rejects(f.invoke('draft'));
      const state = await f.readState();
      assert.equal(state.releases[f.appTag], undefined);
      assert(!state.calls.some((call) => call.includes('--draft=false')));
    });
  }
});

test('app publication binds its delivery source and renamed installer to verified release assets', async (t) => {
  const f = await releaseFixture(t, {
    publish: true,
    updateSourceUrl: 'https://releases.example.invalid/otto',
  });
  await f.invoke('draft-runtime');
  await writeFile(
    join(f.output, 'release.json'),
    JSON.stringify({ ...f.metadata, updateSourceUrl: undefined }),
  );
  await assert.rejects(f.invoke('draft'), /update source does not match/);
  assert.equal((await f.readState()).releases[f.appTag], undefined);
  await writeFile(join(f.output, 'release.json'), JSON.stringify(f.metadata));
  await f.invoke('draft');
  const state = await f.readState();
  const assets = state.releases[f.appTag].assets;
  for (const entry of [f.metadata.disk, f.metadata.update])
    assert.deepEqual(
      assets.find((asset) => asset.name === entry.file),
      {
        name: entry.file,
        size: entry.bytes,
        digest: `sha256:${entry.sha256}`,
      },
    );
  assert.equal(
    JSON.parse(Buffer.from(state.contents[f.appTag + '/release.json'], 'base64')).updateSourceUrl,
    f.metadata.updateSourceUrl,
  );
  assert(Object.values(state.releases).every((release) => !release.draft));
  for (const source of [
    'http://releases.example.invalid/otto',
    'https://user:password@releases.example.invalid/otto',
    'https://releases.example.invalid/otto?token=synthetic',
    'https://releases.example.invalid/otto#fragment',
    'https://releases.example.invalid/otto?',
    'https://releases.example.invalid/otto#',
  ]) {
    const invalid = await releaseFixture(t, { updateSourceUrl: source });
    await assert.rejects(invalid.invoke('draft'), /credential-free HTTPS/);
    assert.equal((await invalid.readState()).created, 0);
  }
  const unrelated = await releaseFixture(t, { diskName: 'Other-arm64.dmg' });
  await unrelated.invoke('draft-runtime');
  await assert.rejects(unrelated.invoke('draft'), /DMG, application ZIP and checksums/);
  assert.equal((await unrelated.readState()).releases[unrelated.appTag], undefined);
});

test('new public runtime drafts omit anonymous download URLs and support signed manual import', async (t) => {
  const f = await releaseFixture(t, { isPublic: true });
  const request = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected anonymous download');
  });
  await verifyRuntimeRelease(f.release, f.release.fingerprint, {
    ...f.release.signing,
    team: f.release.signing.teamId,
  });
  await f.invoke('draft-runtime');
  await f.invoke('draft');
  const state = await f.readState();
  const uploaded = JSON.parse(
    Buffer.from(state.contents[f.runtimeTag + '/runtime-release.json'], 'base64'),
  );
  assert.equal(uploaded.url, undefined);
  assert.equal(request.mock.callCount(), 0);
  assert(!state.calls.some((call) => call[0] === 'fetch' || call.includes('--draft=false')));
});

test('published public runtime reuse adds its working download URL without republishing it', async (t) => {
  const f = await releaseFixture(t, { isPublic: true, plan: true });
  await f.invoke('draft-runtime');
  const state = await f.readState();
  state.releases[f.runtimeTag].draft = false;
  await f.writeState(state);
  const plan = JSON.parse((await f.invoke('plan')).stdout);
  assert.equal(plan.runtime_reused, 'true');
  const descriptorPath = join(f.assets, 'runtime-release.json');
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
  assert.equal(
    descriptor.url,
    `https://github.com/synthetic/otto/releases/download/${f.runtimeTag}/${f.release.archive.file}`,
  );
  await copyFile(descriptorPath, join(f.output, 'runtime-release.json'));
  await f.invoke('draft');
  const saved = await f.readState();
  assert.equal(saved.releases[f.appTag].draft, true);
  assert.equal(saved.releases[f.runtimeTag].draft, false);
  assert(!saved.calls.some((call) => call.includes('--draft=false')));
});

test('pending public runtime packaging defers only reachability for the checked CI descriptor', async (t) => {
  const f = await releaseFixture(t, { isPublic: true, publish: true });
  const configuration = { ...f.release.signing, team: f.release.signing.teamId };
  const descriptorPath = join(f.assets, 'runtime-release.json');
  const env = {
    GITHUB_ACTIONS: 'true',
    OTTO_PENDING_RUNTIME_DESCRIPTOR_SHA256: await assetHash(descriptorPath),
  };
  const request = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(null, { status: 404 }),
  );
  await verifyRuntimeRelease(f.release, f.release.fingerprint, configuration, {
    descriptorPath,
    env,
  });
  assert.equal(request.mock.callCount(), 0);
  await assert.rejects(
    verifyRuntimeRelease(f.release, '0'.repeat(64), configuration, { descriptorPath, env }),
    /provenance/,
  );
  await assert.rejects(
    verifyRuntimeRelease(f.release, f.release.fingerprint, configuration, {
      descriptorPath,
      env: { ...env, GITHUB_ACTIONS: 'false' },
    }),
    /checked CI artifact/,
  );
  await writeFile(descriptorPath, JSON.stringify({ ...f.release, source: '0'.repeat(40) }));
  await assert.rejects(
    verifyRuntimeRelease(f.release, f.release.fingerprint, configuration, { descriptorPath, env }),
    /checked CI artifact/,
  );
  await assert.rejects(
    verifyRuntimeRelease(f.release, f.release.fingerprint, configuration, { env: {} }),
    /not anonymously reachable/,
  );
});

test('runtime publication waits for checked app bytes and retries reuse an already published runtime', async (t) => {
  const f = await releaseFixture(t, { isPublic: true, publish: true });
  await f.invoke('draft-runtime');
  let state = await f.readState();
  assert.equal(state.releases[f.runtimeTag].draft, true);
  assert(!state.calls.some((call) => call[0] === 'fetch' || call.includes('--draft=false')));
  const archive = state.releases[f.runtimeTag].assets.find(
    (asset) => asset.name === f.release.archive.file,
  );
  archive.digest = `sha256:${'0'.repeat(64)}`;
  await f.writeState(state);
  await assert.rejects(f.invoke('draft'), /uploaded runtime does not match/);
  state = await f.readState();
  assert.equal(state.releases[f.appTag], undefined);
  state.releases[f.runtimeTag].assets.find(
    (asset) => asset.name === f.release.archive.file,
  ).digest = `sha256:${f.release.archive.sha256}`;
  state.corruptDmg = true;
  await f.writeState(state);
  await assert.rejects(f.invoke('draft'), /Downloaded release DMG failed/);
  state = await f.readState();
  assert(Object.values(state.releases).every((release) => release.draft));
  assert(!state.calls.some((call) => call.includes('--draft=false')));
  state.corruptDmg = false;
  state.corruptZip = true;
  await f.writeState(state);
  await assert.rejects(f.invoke('draft'), /Downloaded release ZIP failed/);
  state = await f.readState();
  assert(Object.values(state.releases).every((release) => release.draft));
  assert(!state.calls.some((call) => call.includes('--draft=false')));
  state.corruptZip = false;
  state.failPublicDownload = true;
  await f.writeState(state);
  await assert.rejects(f.invoke('draft'), /publicly downloadable/);
  state = await f.readState();
  assert.equal(state.releases[f.runtimeTag].draft, false);
  assert.equal(state.releases[f.appTag].draft, true);
  state.failPublicDownload = false;
  await f.writeState(state);
  await f.invoke('draft');
  state = await f.readState();
  assert(Object.values(state.releases).every((release) => !release.draft));
  const publications = state.calls.filter((call) => call.includes('--draft=false'));
  assert.deepEqual(
    publications.map((call) => call[2]),
    [f.runtimeTag, f.appTag],
  );
  const downloadedApp = state.calls.findIndex(
    (call) => call[1] === 'download' && call.includes(f.metadata.disk.file),
  );
  const downloadedUpdate = state.calls.findIndex(
    (call) => call[1] === 'download' && call.includes(f.metadata.update.file),
  );
  const publishedRuntime = state.calls.findIndex((call) => call.includes('--draft=false'));
  const checkedPublicRuntime = state.calls.findIndex(
    (call) => call[0] === 'fetch' && call[1] === 'HEAD',
  );
  const publishedApp = state.calls.findLastIndex((call) => call.includes('--draft=false'));
  assert(
    downloadedApp >= 0 &&
      downloadedUpdate >= 0 &&
      downloadedApp < publishedRuntime &&
      downloadedUpdate < publishedRuntime &&
      publishedRuntime < checkedPublicRuntime &&
      checkedPublicRuntime < publishedApp,
  );
  assert(!state.releases[f.appTag].body.includes('/untagged-'));
  for (const [tag, release] of Object.entries(state.releases)) {
    assert.equal(release.tag_name, tag);
    assert.equal(release.target_commitish, f.metadata.source);
  }
  await assert.rejects(
    f.invoke('draft-runtime'),
    /Refusing to replace a published or unrelated release/,
  );
});

test('bundle copy includes explicit release assets under .local while excluding private descendants', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'otto-bundle-copy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, '.local', 'release');
  const target = join(root, 'bundle');
  await mkdir(join(source, '.local'), { recursive: true });
  await mkdir(target);
  await writeFile(join(source, 'runtime-release.json'), '{"synthetic":true}');
  await writeFile(join(source, 'runtime.tar.gz'), 'synthetic archive');
  await writeFile(join(source, '.env'), 'SYNTHETIC_PRIVATE=value');
  await writeFile(join(source, '.local', 'state.json'), '{"syntheticPrivate":true}');
  for (const file of ['runtime-release.json', 'runtime.tar.gz']) {
    await copyBundleSource(join(source, file), join(target, file));
    assert.equal(await assetHash(join(target, file)), await assetHash(join(source, file)));
  }
  await copyBundleSource(source, join(target, 'tree'));
  assert.deepEqual((await readdir(join(target, 'tree'))).sort(), [
    'runtime-release.json',
    'runtime.tar.gz',
  ]);
});

test('packaged engine loads dynamic dependencies and binary links outside the checkout and excludes other platforms', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'otto-packaged-dependencies-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'checkout');
  const target = join(root, 'application');
  const dependency = join(source, 'node_modules', 'synthetic-extension');
  await mkdir(join(dependency, 'assets'), { recursive: true });
  await mkdir(join(source, 'node_modules', '.bin'));
  await writeFile(
    join(dependency, 'package.json'),
    JSON.stringify({ name: 'synthetic-extension', type: 'module', exports: './index.mjs' }),
  );
  await writeFile(join(dependency, 'assets', 'value.json'), '{"value":42}');
  await writeFile(
    join(dependency, 'index.mjs'),
    'import { readFileSync } from "node:fs"; export default JSON.parse(readFileSync(new URL("./assets/value.json", import.meta.url))).value;',
  );
  await writeFile(
    join(dependency, 'cli.mjs'),
    'import value from "./index.mjs"; console.log(value);',
  );
  await symlink('../synthetic-extension/cli.mjs', join(source, 'node_modules', '.bin', 'probe'));
  for (const name of ['synthetic-linux', '@synthetic/intel']) {
    const directory = join(source, 'node_modules', name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name, os: name.includes('linux') ? ['linux'] : ['darwin'], cpu: ['x64'] }),
    );
  }
  await copyEngineDependencies({ root: source, target });
  for (const name of ['synthetic-linux', '@synthetic/intel'])
    await assert.rejects(stat(join(target, 'node_modules', name)), { code: 'ENOENT' });
  await rm(source, { recursive: true });
  await writeFile(
    join(target, 'probe.mjs'),
    'const name = process.argv[2]; console.log((await import(name)).default);',
  );
  for (const args of [['probe.mjs', 'synthetic-extension'], ['node_modules/.bin/probe']]) {
    const result = await promisify(execFile)(process.execPath, args, {
      cwd: target,
      env: { PATH: process.env.PATH },
    });
    assert.equal(result.stdout.trim(), '42');
  }
});

async function fixture(t, extra) {
  const root = await mkdtemp(join(tmpdir(), 'otto-runtime-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const resourcesPath = join(root, 'resources');
  const cacheRoot = join(root, 'cache');
  await mkdir(source);
  await mkdir(resourcesPath);
  const files = [];
  for (const path of [
    'manifest.json',
    'lima/bin/limactl',
    'docker-host/docker/docker',
    'docker-guest.tar.gz',
    'lima/share/lima/lima-guestagent.Linux-aarch64.gz',
  ]) {
    const target = join(source, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `Synthetic fixture ${path}`);
    files.push({
      path,
      bytes: (await stat(target)).size,
      mode: 0o644,
      sha256: await assetHash(target),
    });
  }
  const entries = files.map((file) => file.path);
  if (extra) entries.push(...(await extra({ root, source })));
  const archivePath = join(root, 'runtime.tar.gz');
  await create(
    {
      cwd: source,
      file: archivePath,
      portable: true,
      noMtime: true,
      gzip: true,
      preservePaths: true,
    },
    entries,
  );
  const release = {
    version: 1,
    platform: 'darwin-arm64',
    id: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    archive: { bytes: (await stat(archivePath)).size, sha256: await assetHash(archivePath) },
    files,
  };
  await writeFile(join(resourcesPath, 'runtime-release.json'), JSON.stringify(release));
  return { root, source, archivePath, resourcesPath, cacheRoot, release };
}

test('runtime archive installs atomically and detects a modified executable before reuse', async (t) => {
  const options = await fixture(t);
  const installed = await installRuntimeArchive(options);
  assert.equal(await findRuntimeAssets(options), installed);
  assert.equal(
    await readFile(join(installed, 'lima/bin/limactl'), 'utf8'),
    'Synthetic fixture lima/bin/limactl',
  );
  assert.deepEqual(await readdir(options.cacheRoot), [options.release.id]);
  await writeFile(join(installed, 'lima/bin/limactl'), 'changed');
  assert.equal(await findRuntimeAssets(options), undefined);
  assert.equal(await installRuntimeArchive(options), installed);
  assert.equal(await findRuntimeAssets(options), installed);
});

test('runtime archive hash mismatch never installs files', async (t) => {
  const options = await fixture(t);
  const bytes = await readFile(options.archivePath);
  bytes[30] ^= 1;
  await writeFile(options.archivePath, bytes);
  await assert.rejects(installRuntimeArchive(options), /does not match/);
  assert.equal(await findRuntimeAssets(options), undefined);
});

test('runtime extraction rejects traversal without changing files outside its staging directory', async (t) => {
  const options = await fixture(t, async ({ root }) => {
    await writeFile(join(root, 'outside.txt'), 'unchanged');
    return ['../outside.txt'];
  });
  await assert.rejects(installRuntimeArchive(options));
  assert.equal(await readFile(join(options.root, 'outside.txt'), 'utf8'), 'unchanged');
  assert.deepEqual(await readdir(options.cacheRoot), []);
});

test('runtime extraction rejects symlinks and unexpected files', async (t) => {
  const options = await fixture(t, async ({ source }) => {
    await symlink('/tmp/otto-outside-fixture', join(source, 'unexpected'));
    return ['unexpected'];
  });
  await assert.rejects(installRuntimeArchive(options), /unexpected files/);
  assert.deepEqual(await readdir(options.cacheRoot), []);
});

test('runtime extraction bounds decompressed content before unexpected data can fill storage', async (t) => {
  const options = await fixture(t, async ({ source }) => {
    await writeFile(join(source, 'oversized'), Buffer.alloc(2 * 1024 * 1024));
    return ['oversized'];
  });
  await assert.rejects(installRuntimeArchive(options), /expected expanded size/);
  assert.deepEqual(await readdir(options.cacheRoot), []);
});

test('missing runtime release requests the companion pack without inventing a download endpoint', async (t) => {
  const options = await fixture(t);
  await assert.rejects(ensureRuntimeAssets(options), { code: 'RUNTIME_ARCHIVE_REQUIRED' });
  await assert.rejects(installRuntimeArchive({ ...options, signal: AbortSignal.abort() }));
  assert.equal(await findRuntimeAssets(options), undefined);
});

test('first-run runtime resolves its exact download after a cache miss and restarts offline', async (t) => {
  const options = await fixture(t);
  const signal = new AbortController().signal;
  const requests = [];
  const bytes = await readFile(options.archivePath);
  let resolutions = 0;
  const installed = await ensureRuntimeAssets({
    ...options,
    signal,
    resolveDownloadUrl: async (release, receivedSignal) => {
      assert.deepEqual(release, options.release);
      assert.equal(receivedSignal, signal);
      resolutions++;
      return 'https://releases.example.invalid/exact-runtime';
    },
    fetch: async (url) => {
      requests.push(url);
      return requests.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://assets.example.invalid/exact-runtime' },
          })
        : new Response(bytes);
    },
  });
  assert.equal(resolutions, 1);
  assert.deepEqual(requests, [
    'https://releases.example.invalid/exact-runtime',
    'https://assets.example.invalid/exact-runtime',
  ]);
  assert.equal(await findRuntimeAssets(options), installed);
  const offline = async () => {
    throw new Error('A verified cache must not access the network.');
  };
  assert.equal(
    await ensureRuntimeAssets({ ...options, resolveDownloadUrl: offline, fetch: offline }),
    installed,
  );
});

test('failed or cancelled runtime resolution never fetches an archive and allows an explicit retry', async (t) => {
  const options = await fixture(t);
  const controller = new AbortController();
  const fetch = async () => {
    throw new Error('Archive download must not start.');
  };
  await assert.rejects(
    ensureRuntimeAssets({
      ...options,
      fetch,
      resolveDownloadUrl: async () => {
        throw new Error('Release service unavailable');
      },
    }),
    /Release service unavailable/,
  );
  await assert.rejects(
    ensureRuntimeAssets({
      ...options,
      fetch,
      signal: controller.signal,
      resolveDownloadUrl: async () => {
        controller.abort();
        return 'https://releases.example.invalid/exact-runtime';
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(await findRuntimeAssets(options), undefined);
  const bytes = await readFile(options.archivePath);
  const installed = await ensureRuntimeAssets({
    ...options,
    resolveDownloadUrl: async () => 'https://releases.example.invalid/exact-runtime',
    fetch: async () => new Response(bytes),
  });
  assert.equal(await findRuntimeAssets(options), installed);
});

test('runtime installation refuses insufficient storage without removing saved caches and can retry', async (t) => {
  const options = await fixture(t);
  const saved = join(options.cacheRoot, 'previous-runtime');
  await mkdir(saved, { recursive: true });
  await writeFile(join(saved, 'saved'), 'preserved');
  const archiveHash = await assetHash(options.archivePath);
  await assert.rejects(
    installRuntimeArchive({
      ...options,
      inspectDisk: async () => ({ bavail: 0n, bsize: 4096n }),
    }),
    { code: 'RUNTIME_DISK_SPACE' },
  );
  assert.deepEqual(await readdir(options.cacheRoot), ['previous-runtime']);
  assert.equal(await readFile(join(saved, 'saved'), 'utf8'), 'preserved');
  assert.equal(await assetHash(options.archivePath), archiveHash);
  const installed = await installRuntimeArchive({
    ...options,
    inspectDisk: async () => ({ bavail: 1024n ** 3n, bsize: 4096n }),
  });
  assert.equal(await findRuntimeAssets(options), installed);
  assert.equal(await readFile(join(saved, 'saved'), 'utf8'), 'preserved');
});

test('verified runtime reuse requires no additional free storage', async (t) => {
  const options = await fixture(t);
  const installed = await installRuntimeArchive(options);
  assert.equal(
    await ensureRuntimeAssets({
      ...options,
      inspectDisk: async () => {
        throw new Error('Storage inspection must not run for a verified cache.');
      },
    }),
    installed,
  );
});

test('runtime download reserves both its archive and extracted files before requesting bytes', async (t) => {
  const options = await fixture(t);
  options.release.url = 'https://runtime.example.invalid/fixture.tar.gz';
  await writeFile(
    join(options.resourcesPath, 'runtime-release.json'),
    JSON.stringify(options.release),
  );
  const expanded = options.release.files.reduce((total, file) => total + file.bytes, 0);
  const available = expanded + 512 * 1024 ** 2 + options.release.archive.bytes - 1;
  const request = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('The runtime must not download without sufficient storage.');
  });
  await assert.rejects(
    ensureRuntimeAssets({
      ...options,
      inspectDisk: async () => ({ bavail: BigInt(available), bsize: 1n }),
    }),
    { code: 'RUNTIME_DISK_SPACE' },
  );
  assert.equal(request.mock.callCount(), 0);
  assert.deepEqual(await readdir(options.cacheRoot), []);
});

test('runtime rechecks storage after downloading and removes only its incomplete installation', async (t) => {
  const options = await fixture(t);
  options.release.url = 'https://runtime.example.invalid/fixture.tar.gz';
  await writeFile(
    join(options.resourcesPath, 'runtime-release.json'),
    JSON.stringify(options.release),
  );
  const saved = join(options.cacheRoot, 'previous-runtime');
  await mkdir(saved, { recursive: true });
  await writeFile(join(saved, 'saved'), 'preserved');
  const bytes = await readFile(options.archivePath);
  const request = t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  let inspections = 0;
  await assert.rejects(
    ensureRuntimeAssets({
      ...options,
      inspectDisk: async () => ({
        bavail: inspections++ === 0 ? 1024n ** 3n : 0n,
        bsize: 4096n,
      }),
    }),
    { code: 'RUNTIME_DISK_SPACE' },
  );
  assert.equal(inspections, 2);
  assert.equal(request.mock.callCount(), 1);
  assert.deepEqual(await readdir(options.cacheRoot), ['previous-runtime']);
  assert.equal(await readFile(join(saved, 'saved'), 'utf8'), 'preserved');
  assert.equal(await findRuntimeAssets(options), undefined);
});

test('runtime download rejects an insecure redirect without fetching it or leaving partial bytes', async (t) => {
  const options = await fixture(t);
  options.release.url = 'https://runtime.example.invalid/fixture.tar.gz';
  await writeFile(
    join(options.resourcesPath, 'runtime-release.json'),
    JSON.stringify(options.release),
  );
  const request = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(null, { status: 302, headers: { location: 'http://unsafe.invalid' } }),
  );
  await assert.rejects(ensureRuntimeAssets(options), /unsafe runtime download address/);
  assert.equal(request.mock.callCount(), 1);
  assert.deepEqual(await readdir(options.cacheRoot), []);
});

test('runtime download rejects corrupt bytes, cleans its download and allows a verified retry', async (t) => {
  const options = await fixture(t);
  options.release.url = 'https://runtime.example.invalid/fixture.tar.gz';
  await writeFile(
    join(options.resourcesPath, 'runtime-release.json'),
    JSON.stringify(options.release),
  );
  const bytes = await readFile(options.archivePath);
  const corrupt = Buffer.from(bytes);
  corrupt[30] ^= 1;
  const request = t.mock.method(globalThis, 'fetch', async () => new Response(corrupt));
  await assert.rejects(ensureRuntimeAssets(options), /does not match/);
  assert.deepEqual(await readdir(options.cacheRoot), []);
  request.mock.mockImplementation(async () => new Response(bytes));
  const installed = await ensureRuntimeAssets(options);
  assert.equal(await findRuntimeAssets(options), installed);
  assert.deepEqual(await readdir(options.cacheRoot), [options.release.id]);
});

test(
  'workload firewall refresh blocks private TCP traffic without interrupting public connections',
  {
    skip:
      process.env.OTTO_TEST_RUNTIME_NETWORK !== '1' ||
      process.platform !== 'linux' ||
      process.getuid?.() !== 0,
  },
  async (t) => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { protectNetworks } = await import('../runtime/guest-config.mjs');
    const root = await mkdtemp(join(tmpdir(), 'otto-firewall-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'firewall'), protectNetworks);
    await writeFile(
      join(root, 'probe.py'),
      String.raw`import json, os, select, socket, subprocess, sys, time
from pathlib import Path
root = Path(sys.argv[1])
def run(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True)
for name, interface, network in [('workload', 'otto-workspace', '172.31.81'), ('target', 'otto-fixture', '10.70.0')]:
    run('ip', 'netns', 'add', name)
    run('ip', '-n', name, 'link', 'set', 'lo', 'up')
    run('ip', 'link', 'add', interface, 'type', 'veth', 'peer', 'name', name)
    run('ip', 'link', 'set', name, 'netns', name)
    run('ip', 'addr', 'add', network+'.1/24', 'dev', interface)
    run('ip', 'link', 'set', interface, 'up')
    run('ip', '-n', name, 'addr', 'add', network+'.2/24', 'dev', name)
    run('ip', '-n', name, 'link', 'set', name, 'up')
    run('ip', '-n', name, 'route', 'add', 'default', 'via', network+'.1')
run('ip', '-n', 'target', 'addr', 'add', '93.184.216.34/32', 'dev', 'target')
run('ip', 'route', 'add', '93.184.216.34/32', 'via', '10.70.0.2')
run('sysctl', '-w', 'net.ipv4.ip_forward=1')
run('iptables', '-N', 'DOCKER-USER')
run('iptables', '-A', 'FORWARD', '-j', 'DOCKER-USER')
server = subprocess.Popen(['ip', 'netns', 'exec', 'target', 'python3', '-u', '-c', '''
import socketserver
class Echo(socketserver.StreamRequestHandler):
    def handle(self):
        while line := self.rfile.readline():
            self.wfile.write(line)
            self.wfile.flush()
server = socketserver.ThreadingTCPServer(('0.0.0.0',19090), Echo)
print('ready', flush=True)
server.serve_forever()
'''], stdout=subprocess.PIPE, text=True)
assert server.stdout.readline().strip() == 'ready'
clients = []
def connect(address):
    process = subprocess.Popen(['ip', 'netns', 'exec', 'workload', 'python3', '-u', '-c', '''
import json, socket, sys
try:
    connection = socket.create_connection((sys.argv[1],19090), timeout=0.5)
except OSError:
    print('false', flush=True)
    sys.exit()
print('true', flush=True)
for line in sys.stdin:
    try:
        connection.sendall(line.encode())
        print(json.dumps(connection.recv(4096) == line.encode()), flush=True)
    except OSError:
        print('false', flush=True)
''', address], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    clients.append(process)
    assert select.select([process.stdout], [], [], 3)[0]
    return process, json.loads(process.stdout.readline())
def echo(process):
    process.stdin.write('synthetic-probe\n')
    process.stdin.flush()
    assert select.select([process.stdout], [], [], 3)[0]
    return json.loads(process.stdout.readline())
try:
    prior_private, connected = connect('10.70.0.2')
    assert connected and echo(prior_private)
    run('bash', str(root/'firewall'))
    assert not echo(prior_private), 'Existing forbidden private connection survived protection'
    assert not connect('10.70.0.2')[1]
    public, connected = connect('93.184.216.34')
    assert connected and echo(public)
    wrapper = root/'bin'
    wrapper.mkdir()
    for name in ['iptables', 'iptables-restore']:
        executable = run('which', name).stdout.strip()
        (wrapper/name).write_text('#!/bin/bash\n'+(
            'cat > "$OTTO_PROBE/transaction"\ntouch "$OTTO_PROBE/paused"\nwhile [ ! -f "$OTTO_PROBE/released" ]; do sleep 0.01; done\nexec '+executable+' "$@" < "$OTTO_PROBE/transaction"\n'
            if name == 'iptables-restore' else
            executable+' "$@"\nresult=$?\nif [ "$1" = -F ] && [ "$2" = OTTO-WORKLOADS ]; then\ntouch "$OTTO_PROBE/paused"\nwhile [ ! -f "$OTTO_PROBE/released" ]; do sleep 0.01; done\nfi\nexit "$result"\n'))
        (wrapper/name).chmod(0o755)
    refresh = subprocess.Popen(['bash', str(root/'firewall')], env={**os.environ, 'PATH':str(wrapper)+':'+os.environ['PATH'], 'OTTO_PROBE':str(root)})
    deadline = time.monotonic()+5
    while not (root/'paused').exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert (root/'paused').exists()
    try:
        assert not connect('10.70.0.2')[1], 'Private TCP connection opened during refresh'
        assert echo(public), 'Public response traffic stopped during refresh'
    finally:
        (root/'released').touch()
        assert refresh.wait(timeout=5) == 0
    assert not connect('10.70.0.2')[1]
    assert echo(public)
    print(json.dumps({'privateBlocked':True, 'publicPreserved':True, 'oldPrivateRevoked':True}))
finally:
    for process in clients+[server]:
        process.terminate()
        process.wait(timeout=3)
`,
    );
    const { stdout } = await promisify(execFile)(
      'unshare',
      [
        '--fork',
        '--kill-child=KILL',
        '--pid',
        '--mount-proc',
        '--net',
        '--mount',
        'bash',
        '-euc',
        'mount --make-rprivate /; mkdir -p /run/netns; mount -t tmpfs tmpfs /run/netns; exec python3 "$1/probe.py" "$1"',
        'otto-firewall-fixture',
        root,
      ],
      {
        timeout: 30_000,
        env: { PATH: process.env.PATH, LANG: 'C' },
      },
    );
    assert.deepEqual(JSON.parse(stdout), {
      privateBlocked: true,
      publicPreserved: true,
      oldPrivateRevoked: true,
    });
  },
);

test('runtime cache reuse rejects same-size noncritical changes and executable-mode drift', async (t) => {
  const { chmod } = await import('node:fs/promises');
  const options = await fixture(t);
  const path = 'lima/bin/lima';
  const original = Buffer.from('Synthetic additional executable');
  await writeFile(join(options.source, path), original);
  options.release.files.push({
    path,
    bytes: original.length,
    mode: 0o755,
    sha256: createHash('sha256').update(original).digest('hex'),
  });
  options.release.id = createHash('sha256')
    .update(JSON.stringify(options.release.files))
    .digest('hex');
  await create(
    { cwd: options.source, file: options.archivePath, portable: true, noMtime: true, gzip: true },
    options.release.files.map((file) => file.path),
  );
  options.release.archive = {
    bytes: (await stat(options.archivePath)).size,
    sha256: await assetHash(options.archivePath),
  };
  await writeFile(
    join(options.resourcesPath, 'runtime-release.json'),
    JSON.stringify(options.release),
  );
  const installed = await installRuntimeArchive(options);
  const target = join(installed, path);
  const changed = Buffer.from(original);
  changed[0] ^= 1;
  await writeFile(target, changed);
  assert.equal(await findRuntimeAssets(options), undefined);
  await installRuntimeArchive(options);
  assert.deepEqual(await readFile(target), original);
  await chmod(target, 0o644);
  assert.equal(await findRuntimeAssets(options), undefined);
  await installRuntimeArchive(options);
  assert.equal((await stat(target)).mode & 0o7777, 0o755);
  assert.equal(await findRuntimeAssets(options), installed);
});

test('runtime networks reject isolation drift before any workload can start', async () => {
  const { ensureNetwork } = await import('../runtime/index.mjs');
  const expected = {
    name: 'otto-workspace-synthetic',
    subnet: '172.31.81.0/24',
    bridge: 'otto-workspace',
  };
  const network = {
    Driver: 'bridge',
    Scope: 'local',
    EnableIPv6: false,
    Internal: false,
    IPAM: { Config: [{ Subnet: expected.subnet }] },
    Options: {
      'com.docker.network.bridge.name': expected.bridge,
      'com.docker.network.bridge.enable_icc': 'false',
    },
  };
  for (const change of [
    (value) => (value.Driver = 'host'),
    (value) => (value.EnableIPv6 = true),
    (value) => (value.IPAM.Config[0].Subnet = '172.31.82.0/24'),
    (value) => (value.Options['com.docker.network.bridge.name'] = 'unprotected-bridge'),
    (value) => (value.Options['com.docker.network.bridge.enable_icc'] = 'true'),
  ]) {
    const drifted = structuredClone(network);
    change(drifted);
    const calls = [];
    await assert.rejects(
      ensureNetwork(async (args) => {
        calls.push(args);
        return JSON.stringify([drifted]);
      }, expected),
      /isolation settings/,
    );
    assert.deepEqual(calls, [['network', 'inspect', expected.name]]);
  }
  const calls = [];
  await ensureNetwork(async (args) => {
    calls.push(args);
    return JSON.stringify([network]);
  }, expected);
  assert.deepEqual(calls, [['network', 'inspect', expected.name]]);
});

test('runtime replaces owned containers even with unchanged images and retains their data volumes', async () => {
  const { replaceContainer } = await import('../runtime/index.mjs');
  const name = 'otto-workspace-synthetic';
  const image = `sha256:${'a'.repeat(64)}`;
  const args = [
    '--network',
    'otto-workspace-synthetic',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--volume',
    'otto-workspace-synthetic:/workspace',
  ];
  const current = {
    Image: image,
    Config: { Labels: { 'dev.otto.desktop.experiment': 'true' } },
    Mounts: [{ Type: 'volume', Name: 'otto-workspace-synthetic', Destination: '/workspace' }],
    HostConfig: { Privileged: true, NetworkMode: 'host' },
    State: { Running: true },
  };
  const calls = [];
  await replaceContainer(
    async (command) => {
      calls.push(command);
      return command[1] === 'inspect' ? JSON.stringify([current]) : '';
    },
    name,
    image,
    args,
  );
  assert.deepEqual(calls, [
    ['container', 'inspect', name],
    ['stop', '--time', '20', name],
    ['rm', name],
    ['run', '-d', '--name', name, '--label', 'dev.otto.desktop.experiment=true', ...args, image],
  ]);
  for (const changed of [
    { ...current, Config: { Labels: {} } },
    { ...current, Mounts: [{ Type: 'volume', Name: 'other-data', Destination: '/workspace' }] },
  ]) {
    const commands = [];
    await assert.rejects(
      replaceContainer(
        async (command) => {
          commands.push(command);
          return JSON.stringify([changed]);
        },
        name,
        image,
        args,
      ),
      /identity changed|storage needs recovery/,
    );
    assert.deepEqual(commands, [['container', 'inspect', name]]);
  }
});

test('runtime fingerprints include root dependencies and complete source and reject symlinked input roots', async (t) => {
  const { cp, realpath } = await import('node:fs/promises');
  const { runtimeInputs } = await import('../scripts/runtime-inputs.mjs');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'otto-runtime-inputs-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const input = await runtimeInputs();
  const sourcePaths = input.inputs.filter(
    (path) => !path.includes(':') && !path.startsWith('@') && !path.startsWith('signing.'),
  );
  for (const path of new Set([
    ...sourcePaths,
    'pnpm-lock.yaml',
    'desktop/package.json',
    'desktop/pnpm-lock.yaml',
  ])) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(join(repository, path), join(root, path));
  }
  const run = () =>
    promisify(execFile)(process.execPath, [join(root, 'desktop/scripts/runtime-inputs.mjs')], {
      env: { PATH: process.env.PATH },
    });
  const before = JSON.parse((await run()).stdout).fingerprint;
  const manifestPath = join(root, 'package.json');
  const manifestSource = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestSource);
  manifest.dependencies['agent-browser'] = '0.0.0-synthetic';
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.notEqual(JSON.parse((await run()).stdout).fingerprint, before);
  await writeFile(manifestPath, manifestSource);
  const lockPath = join(root, 'pnpm-lock.yaml');
  const lockSource = await readFile(lockPath, 'utf8');
  await writeFile(lockPath, `${lockSource}\nsyntheticDependencyChange: true\n`);
  assert.notEqual(JSON.parse((await run()).stdout).fingerprint, before);
  await writeFile(lockPath, lockSource);
  for (const path of ['src/server/index.ts', 'src/web/pages/chat.tsx']) {
    const file = join(root, path);
    const source = await readFile(file, 'utf8');
    await writeFile(file, `${source}\nexport const syntheticRuntimeChange = true;\n`);
    assert.notEqual(JSON.parse((await run()).stdout).fingerprint, before);
    await writeFile(file, source);
  }
  assert.equal(JSON.parse((await run()).stdout).fingerprint, before);
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'must-not-be-hashed'), 'Synthetic outside-checkout content');
  await rm(join(root, 'src/ports'), { recursive: true });
  await symlink(outside, join(root, 'src/ports'));
  await assert.rejects(run(), /cannot contain symbolic links/);
  await rm(join(root, 'src/ports'));
  await mkdir(join(root, 'src/ports'));
  await rm(join(root, 'Dockerfile.workspace'));
  await symlink(join(outside, 'must-not-be-hashed'), join(root, 'Dockerfile.workspace'));
  await assert.rejects(run(), /cannot contain symbolic links/);
});

test('image preparation replaces a cached PostgreSQL image from the wrong architecture', async (t) => {
  const { cp, realpath } = await import('node:fs/promises');
  const { runtimeInputs } = await import('../scripts/runtime-inputs.mjs');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'otto-image-architecture-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const input = await runtimeInputs();
  for (const path of new Set([
    ...input.inputs.filter(
      (path) => !path.includes(':') && !path.startsWith('@') && !path.startsWith('signing.'),
    ),
    'pnpm-lock.yaml',
    'desktop/package.json',
    'desktop/pnpm-lock.yaml',
  ])) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(join(repository, path), join(root, path));
  }
  await symlink(join(repository, 'node_modules'), join(root, 'node_modules'));
  await writeFile(join(root, 'desktop/scripts/check-browser-image.mjs'), '');
  const bin = join(root, 'bin');
  const archiveRoot = join(root, 'image');
  await mkdir(bin);
  await writeFile(join(bin, 'package.json'), '{"type":"commonjs"}');
  await mkdir(archiveRoot);
  const imageId = 'a'.repeat(64);
  await writeFile(join(archiveRoot, `${imageId}.json`), '{}');
  await writeFile(
    join(archiveRoot, 'manifest.json'),
    JSON.stringify([
      {
        Config: `${imageId}.json`,
        RepoTags: [
          'otto-desktop-workspace:experiment',
          'otto-desktop-browser:experiment',
          'postgres:17-alpine',
        ],
        Layers: [],
      },
    ]),
  );
  const archive = join(root, 'image.tar');
  await create({ cwd: archiveRoot, file: archive, portable: true }, [
    'manifest.json',
    `${imageId}.json`,
  ]);
  const statePath = join(root, 'docker.json');
  await writeFile(statePath, JSON.stringify({ architecture: 'amd64', calls: [] }));
  await writeFile(
    join(bin, 'docker'),
    `#!${process.execPath}\n` +
      String.raw`
const { readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.FIXTURE_STATE, 'utf8'));
state.calls.push(args);
if (args[0] === 'pull') state.architecture = 'arm64';
writeFileSync(process.env.FIXTURE_STATE, JSON.stringify(state));
if (args[0] === 'image' && args[1] === 'inspect') process.stdout.write(JSON.stringify([{ Id: 'sha256:' + 'a'.repeat(64), Architecture: args[2] === 'postgres:17-alpine' ? state.architecture : 'arm64', Os: 'linux' }]));
else if (args[0] === 'save') process.stdout.write(readFileSync(process.env.FIXTURE_ARCHIVE));
else if (args[0] !== 'pull') throw new Error('Unexpected Docker command');
`,
    { mode: 0o700 },
  );
  const args = [
    join(root, 'desktop/scripts/prepare-runtime.mjs'),
    '--images-only',
    '--prebuilt-images',
  ];
  const environment = {
    PATH: `${bin}:/usr/bin:/bin`,
    FIXTURE_STATE: statePath,
    FIXTURE_ARCHIVE: archive,
    OTTO_RUNTIME_ASSETS: join(root, 'assets'),
    OTTO_RUNTIME_DOWNLOADS: join(root, 'downloads'),
  };
  await promisify(execFile)(process.execPath, args, { env: environment, timeout: 20_000 });
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.deepEqual(
    saved.calls.filter((call) => call[0] === 'pull'),
    [['pull', '--platform', 'linux/arm64', 'postgres:17-alpine']],
  );
  const manifest = JSON.parse(await readFile(join(root, 'assets/images-manifest.json'), 'utf8'));
  assert.equal(manifest.images.find((image) => image.name === 'postgres').id, `sha256:${imageId}`);
  saved.calls = [];
  await writeFile(statePath, JSON.stringify(saved));
  await promisify(execFile)(process.execPath, args, { env: environment, timeout: 20_000 });
  assert.equal(
    JSON.parse(await readFile(statePath, 'utf8')).calls.some((call) =>
      ['pull', 'save'].includes(call[0]),
    ),
    false,
  );
  await writeFile(join(root, 'assets/images/workspace.tar.gz.id'), `sha256:${imageId}`);
  await writeFile(statePath, JSON.stringify({ ...saved, calls: [] }));
  await promisify(execFile)(process.execPath, args, { env: environment, timeout: 20_000 });
  assert.deepEqual(
    JSON.parse(await readFile(statePath, 'utf8')).calls.filter((call) => call[0] === 'save'),
    [['save', 'otto-desktop-workspace:experiment']],
  );
});

test('remote runtime preparation rejects forged content IDs and changed installed descriptors without touching the current cache', async (t) => {
  const { prepareRuntimeUpdate } = await import('../runtime/assets.mjs');
  const f = await fixture(t);
  const installed = await installRuntimeArchive(f);
  const before = await readFile(join(installed, 'lima/bin/limactl'));
  const marker = await readFile(join(installed, '.ready.json'));
  const options = {
    ...f,
    downloadUrl: 'https://updates.example.invalid/runtime',
    fetch: () => assert.fail('A rejected descriptor must not download'),
  };
  await assert.rejects(
    prepareRuntimeUpdate({ ...f.release, id: '0'.repeat(64) }, options),
    /identifier does not match/,
  );
  await assert.rejects(
    prepareRuntimeUpdate(
      { ...f.release, archive: { ...f.release.archive, sha256: 'a'.repeat(64) } },
      options,
    ),
    /without changing its ID/,
  );
  assert.equal(
    await prepareRuntimeUpdate(
      { ...f.release, url: 'https://updates.example.invalid/replaced' },
      options,
    ),
    installed,
  );
  await writeFile(
    join(f.resourcesPath, 'runtime-release.json'),
    JSON.stringify({ ...f.release, url: 'https://updates.example.invalid/original' }),
  );
  assert.equal(
    await prepareRuntimeUpdate(
      { ...f.release, url: 'https://updates.example.invalid/replaced' },
      options,
    ),
    installed,
  );
  assert.equal(await prepareRuntimeUpdate(f.release, options), installed);
  assert.equal(await prepareRuntimeUpdate(f.release, options), installed);
  assert.deepEqual(await readFile(join(installed, 'lima/bin/limactl')), before);
  assert.deepEqual(await readFile(join(installed, '.ready.json')), marker);
  assert.deepEqual(await readdir(f.cacheRoot), [f.release.id]);
  await writeFile(join(installed, 'lima/bin/limactl'), 'Changed synthetic executable');
  await assert.rejects(
    prepareRuntimeUpdate(
      { ...f.release, url: 'https://updates.example.invalid/replaced' },
      options,
    ),
    /installed runtime could not be verified/,
  );
});

test('a different verified runtime downloads into its own cache, survives corrupt downloads, and is reused without starting a VM', async (t) => {
  const { prepareRuntimeUpdate } = await import('../runtime/assets.mjs');
  const current = await fixture(t);
  const installed = await installRuntimeArchive(current);
  const next = await fixture(t);
  const executable = join(next.source, 'lima/bin/limactl');
  await writeFile(executable, 'Synthetic second runtime');
  const file = next.release.files.find((entry) => entry.path === 'lima/bin/limactl');
  file.bytes = (await stat(executable)).size;
  file.sha256 = await assetHash(executable);
  next.release.id = createHash('sha256').update(JSON.stringify(next.release.files)).digest('hex');
  await create(
    { cwd: next.source, file: next.archivePath, portable: true, noMtime: true, gzip: true },
    next.release.files.map((entry) => entry.path),
  );
  next.release.archive = {
    bytes: (await stat(next.archivePath)).size,
    sha256: await assetHash(next.archivePath),
  };
  const bytes = await readFile(next.archivePath);
  let downloads = 0;
  let corrupt = true;
  const options = {
    ...current,
    downloadUrl: 'https://updates.example.invalid/runtime',
    fetch: async (url, options) => {
      assert.equal(url, 'https://updates.example.invalid/runtime');
      assert.equal(options.headers.accept, 'application/octet-stream');
      downloads++;
      const content = Buffer.from(bytes);
      if (corrupt) content[30] ^= 1;
      return new Response(content);
    },
  };
  await assert.rejects(prepareRuntimeUpdate(next.release, options), /does not match/);
  assert.equal(await findRuntimeAssets(current), installed);
  assert.deepEqual(await readdir(current.cacheRoot), [current.release.id]);
  corrupt = false;
  const prepared = await prepareRuntimeUpdate(next.release, options);
  assert.notEqual(prepared, installed);
  assert.equal(
    await readFile(join(prepared, 'lima/bin/limactl'), 'utf8'),
    'Synthetic second runtime',
  );
  assert.equal(await prepareRuntimeUpdate(next.release, options), prepared);
  assert.equal(downloads, 2);
  assert.equal(await findRuntimeAssets(current), installed);
  assert.deepEqual(
    (await readdir(current.cacheRoot)).sort(),
    [current.release.id, next.release.id].sort(),
  );
});
