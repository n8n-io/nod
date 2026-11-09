import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import {
  copyFile,
  access,
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, posix, relative, resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createDesktopLifecycle } from '../main/lifecycle.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { create } from 'tar';
import { copyBundleSource, copyEngineDependencies } from '../scripts/engine-dependencies.mjs';
import { copySpeechSources } from '../scripts/speech-sources.mjs';
import {
  assetHash,
  ensureRuntimeAssets,
  findRuntimeAssets,
  installRuntimeArchive,
  openRuntimeAssets,
  seedRuntimeCache,
} from '../runtime/assets.mjs';
import {
  automaticRelease,
  checkRelease,
  checkReleasePlan,
  isReleaseMerge,
  prepareRelease,
} from '../../.github/scripts/prepare-desktop-release.mjs';
import { bindRecovery, recoveryContext } from '../../.github/scripts/desktop-release-recovery.mjs';
import { run, verifyDiskImage, verifyRuntimeRelease } from '../scripts/release-tools.mjs';
import { draftServerRelease } from '../../.github/scripts/server-release.mjs';
import { imageIdentities } from '../../deployment/self-host/image-identities.mjs';

test('server release helpers load without desktop build dependencies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nod-server-release-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = join(root, 'desktop', 'scripts');
  await mkdir(scripts, { recursive: true });
  for (const name of ['release-tools.mjs', 'runtime-inputs.mjs', 'runtime-build-lock.json'])
    await copyFile(new URL(`../scripts/${name}`, import.meta.url), join(scripts, name));
  await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(pathToFileURL(join(scripts, 'release-tools.mjs')).href)})`,
    ],
    { cwd: root, env: { PATH: process.env.PATH } },
  );
});

test('speech distribution includes matching source and license and rejects changed archives', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nod-speech-sources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dependency = join(root, 'node_modules', '@spelling-creator', 'spellophone');
  await mkdir(dependency, { recursive: true });
  await mkdir(join(root, 'desktop', 'licenses'), { recursive: true });
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ version: '0.2.1' }));
  await writeFile(join(dependency, 'LICENSE'), 'Synthetic license fixture');
  await writeFile(join(root, 'desktop', 'licenses', 'speech.md'), 'Synthetic source notice');
  const bytes = Buffer.from('Synthetic corresponding source archive');
  const archives = [
    {
      file: 'source.tar.gz',
      url: 'https://source.example.invalid/pinned-source',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  ];
  const target = join(root, 'engine');
  const cacheDir = join(root, 'cache');
  let calls = 0;
  const download = async (url, options) => {
    calls++;
    assert.equal(url, archives[0].url);
    assert.equal(options.redirect, 'error');
    return new Response(bytes);
  };
  await copySpeechSources({ root, target, cacheDir, archives, fetch: download });
  const sources = join(target, 'licenses', 'speech');
  assert.deepEqual(await readFile(join(sources, 'source.tar.gz')), bytes);
  assert.equal(await readFile(join(sources, 'GPL-3.0.txt'), 'utf8'), 'Synthetic license fixture');
  assert.equal(await readFile(join(sources, 'NOTICE.md'), 'utf8'), 'Synthetic source notice');
  await copySpeechSources({ root, target, cacheDir, archives, fetch: download });
  assert.equal(calls, 1);
  await writeFile(join(cacheDir, 'source.tar.gz'), 'corrupt');
  await assert.rejects(
    copySpeechSources({
      root,
      target,
      cacheDir,
      archives,
      fetch: async () => new Response('corrupt'),
    }),
    /checksum mismatch/,
  );
  await assert.rejects(
    copySpeechSources({
      root,
      target,
      cacheDir,
      archives,
      fetch: async () => new Response(Buffer.alloc(200)),
    }),
    /too large/,
  );
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ version: '9.0.0' }));
  await assert.rejects(
    copySpeechSources({ root, target, cacheDir, archives, fetch: download }),
    /do not match/,
  );
});

async function releaseRepository(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nod-release-history-')));
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

async function serverReleaseFixture(t) {
  const f = await releaseRepository(t);
  const source = f.git('rev-parse', 'HEAD');
  const directory = join(f.root, 'bundles');
  await mkdir(directory);
  const pack = async (architecture, revision = source, contentsArchitecture = architecture) => {
    const name = `nod-server-linux-${architecture}`;
    await mkdir(join(f.root, name), { recursive: true });
    await writeFile(join(f.root, name, 'source-revision'), `${revision}\n`);
    await writeFile(join(f.root, name, 'architecture'), `${contentsArchitecture}\n`);
    const archive = `${name}-${source}.tar.gz`;
    await create({ cwd: f.root, file: join(directory, archive), gzip: true }, [name]);
    const checksum = createHash('sha256')
      .update(await readFile(join(directory, archive)))
      .digest('hex');
    await writeFile(join(directory, `${archive}.sha256`), `${checksum}  ${archive}\n`);
    return join(directory, archive);
  };
  await pack('amd64');
  await pack('arm64');
  const state = {
    private: true,
    refs: [],
    releases: [],
    writes: [],
    corruptUpload: false,
    occupiedDraft: false,
  };
  const prefix = 'repos/synthetic/nod';
  const request = (route, options = {}) => {
    if (options.method === 'POST') {
      state.writes.push({ route, ...options });
      if (route === `${prefix}/git/refs`) {
        const ref = { ref: options.body.ref, object: { type: 'commit', sha: options.body.sha } };
        if (state.refs.some((entry) => entry.ref === ref.ref)) throw new Error('Duplicate ref');
        state.refs.push(ref);
        return ref;
      }
      if (route === `${prefix}/releases`) {
        const release = {
          id: 1,
          ...options.body,
          assets: state.occupiedDraft ? [{ name: 'unexpected' }] : [],
        };
        state.releases.push(release);
        return release;
      }
      const target = new URL(route);
      assert.equal(target.origin, 'https://uploads.github.com');
      assert.equal(target.pathname, `/${prefix}/releases/1/assets`);
      const bytes = readFileSync(options.file);
      const asset = {
        name: target.searchParams.get('name'),
        size: bytes.length,
        digest: `sha256:${createHash('sha256')
          .update(state.corruptUpload ? Buffer.from('corrupt') : bytes)
          .digest('hex')}`,
        state: 'uploaded',
      };
      assert.equal(
        state.releases[0].assets.some((entry) => entry.name === asset.name),
        false,
      );
      state.releases[0].assets.push(asset);
      return asset;
    }
    if (route === prefix) return { private: state.private };
    if (route.startsWith(`${prefix}/git/matching-refs/`)) return state.refs;
    if (route === `${prefix}/releases?per_page=100`) return state.releases;
    if (route === `${prefix}/releases/1`) return state.releases[0];
    if (route.startsWith(`${prefix}/git/ref/`)) return state.refs[0];
    throw new Error(`Unexpected synthetic GitHub request: ${route}`);
  };
  const environment = {
    GITHUB_SHA: source,
    GITHUB_REPOSITORY: 'synthetic/nod',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    NOD_DRAFT_RELEASE: 'true',
  };
  return {
    ...f,
    source,
    directory,
    state,
    pack,
    environment,
    draft: () => draftServerRelease({ root: f.root, directory, environment, request }),
  };
}

async function imageArchive(t, change = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'nod-image-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contents = join(root, 'contents');
  await mkdir(join(contents, 'blobs', 'sha256'), { recursive: true });
  const blobs = new Map();
  const add = (value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    blobs.set(digest, bytes);
    return { digest, size: bytes.length };
  };
  const revision = 'a'.repeat(40);
  const architecture = 'arm64';
  const manifest = [];
  const index = { schemaVersion: 2, manifests: [] };
  const expected = [];
  for (const service of ['server', 'browser']) {
    const reference = `nod-${service}:bundle-synthetic`;
    const config = add({
      architecture,
      os: 'linux',
      config: {
        Env: [`SERVICE=${service}`],
        Labels: { 'org.opencontainers.image.revision': revision },
      },
      rootfs: { type: 'layers', diff_ids: [] },
    });
    const image = add({ schemaVersion: 2, config, layers: [] });
    const target = service === 'server' ? add({ schemaVersion: 2, manifests: [image] }) : image;
    manifest.push({
      Config: `blobs/sha256/${config.digest.slice(7)}`,
      RepoTags: [reference],
      Layers: [],
    });
    index.manifests.push({
      ...target,
      annotations: { 'io.containerd.image.name': `docker.io/library/${reference}` },
    });
    expected.push({ reference, config: config.digest, target: target.digest });
  }
  change({ blobs, manifest, index });
  for (const [digest, bytes] of blobs)
    await writeFile(join(contents, 'blobs', 'sha256', digest.slice(7)), bytes);
  await writeFile(join(contents, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(contents, 'index.json'), JSON.stringify(index));
  const archive = join(root, 'images.tar.gz');
  await create({ cwd: contents, file: archive, gzip: true }, [
    'blobs',
    'index.json',
    'manifest.json',
  ]);
  return {
    expected,
    read: (options = {}) =>
      imageIdentities(
        archive,
        expected.map(({ reference }) => reference),
        {
          architecture,
          revision,
          ...options,
        },
      ),
  };
}

test('server bundle binds classic and containerd identities to the same archived image', async (t) => {
  const archive = await imageArchive(t);
  assert.deepEqual(await archive.read(), archive.expected);
  await assert.rejects(archive.read({ architecture: 'amd64' }), /platform, source or reference/);
  await assert.rejects(archive.read({ revision: 'b'.repeat(40) }), /platform, source or reference/);
});

test('server bundle rejects image substitution and corrupt archive identity metadata', async (t) => {
  const substitution = await imageArchive(t, ({ index }) => {
    index.manifests[0].digest = index.manifests[1].digest;
  });
  await assert.rejects(substitution.read(), /platform, source or reference/);
  const corrupt = await imageArchive(t, ({ blobs, index }) => {
    blobs.set(index.manifests[0].digest, Buffer.from('{}'));
  });
  await assert.rejects(corrupt.read(), /content digest/);
  const duplicate = await imageArchive(t, ({ manifest }) => {
    manifest.push(manifest[0]);
  });
  await assert.rejects(duplicate.read(), /exactly once/);
});

test('server release refuses unapproved, public, branch and source-mismatched uploads', async (t) => {
  const f = await serverReleaseFixture(t);
  for (const [key, value] of [
    ['NOD_DRAFT_RELEASE', 'false'],
    ['GITHUB_EVENT_NAME', 'pull_request'],
    ['GITHUB_REF', 'refs/heads/feature'],
    ['GITHUB_SHA', 'a'.repeat(40)],
  ]) {
    const saved = f.environment[key];
    f.environment[key] = value;
    await assert.rejects(f.draft());
    f.environment[key] = saved;
  }
  f.state.private = false;
  await assert.rejects(f.draft(), /private source repository/);
  assert.deepEqual(f.state.writes, []);
});

test('server release refuses corrupt, relabelled and incomplete native bundles before writing', async (t) => {
  const f = await serverReleaseFixture(t);
  const archive = await f.pack('arm64');
  await writeFile(archive, 'corrupted archive');
  await assert.rejects(f.draft(), /checksum/);
  await f.pack('arm64', 'a'.repeat(40));
  await assert.rejects(f.draft(), /tested source and architecture/);
  await f.pack('arm64', f.source, 'amd64');
  await assert.rejects(f.draft(), /tested source and architecture/);
  await rm(archive);
  await assert.rejects(f.draft(), { code: 'ENOENT' });
  assert.deepEqual(f.state.writes, []);
});

test('server release preserves existing tags, published releases and unfinished drafts', async (t) => {
  const f = await serverReleaseFixture(t);
  const tag = `server-${f.source}`;
  for (const source of [f.source, 'a'.repeat(40)]) {
    f.state.refs = [{ ref: `refs/tags/${tag}`, object: { type: 'commit', sha: source } }];
    await assert.rejects(f.draft(), /already exists/);
  }
  f.state.refs = [];
  for (const draft of [true, false]) {
    f.state.releases = [
      { id: 1, tag_name: tag, target_commitish: f.source, draft, assets: [{ name: 'existing' }] },
    ];
    await assert.rejects(f.draft(), /already exists/);
  }
  assert.deepEqual(f.state.writes, []);
});

test('server release rejects conflicting or corrupt uploaded assets and never publishes', async (t) => {
  const occupied = await serverReleaseFixture(t);
  occupied.state.occupiedDraft = true;
  await assert.rejects(occupied.draft(), /already contains assets/);
  assert.equal(occupied.state.writes.length, 2);
  const corrupt = await serverReleaseFixture(t);
  corrupt.state.corruptUpload = true;
  await assert.rejects(corrupt.draft(), /uploaded release asset/);
  assert.equal(corrupt.state.releases[0].draft, true);
  assert.equal(corrupt.state.releases[0].assets.length, 1);
  const valid = await serverReleaseFixture(t);
  await valid.draft();
  assert.equal(valid.state.releases[0].draft, true);
  assert.equal(valid.state.releases[0].target_commitish, valid.source);
  assert.equal(valid.state.refs[0].object.sha, valid.source);
  assert.equal(valid.state.releases[0].assets.length, 4);
  const writes = valid.state.writes.length;
  await assert.rejects(valid.draft(), /already exists/);
  assert.equal(valid.state.writes.length, writes);
});

test('release gate rejects malformed metadata, uncommitted notes and source drift', async (t) => {
  const f = await releaseRepository(t);
  await assert.rejects(prepareRelease(f.root, '0.1.0-alpha'));
  await prepareRelease(f.root, '0.1.0');
  const prepared = f.commit();
  const notes = join(f.root, 'desktop/CHANGELOG.md');
  await writeFile(notes, '# Replaced notes\n');
  await assert.rejects(checkRelease(f.root, '0.1.0'));
  f.commit();
  await assert.rejects(checkRelease(f.root, '0.1.0'));
  f.git('reset', '--hard', prepared);
  const manifestPath = join(f.root, 'desktop/release.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: '9.9.9' }));
  f.commit();
  await assert.rejects(checkRelease(f.root, '0.1.0'));
  f.git('reset', '--hard', prepared);
  await writeFile(join(f.root, 'desktop/main.mjs'), 'export const late = true;\n');
  f.commit();
  await assert.rejects(checkRelease(f.root, '0.1.0'));
});

test('release publication requires the exact merge of an owned release PR', () => {
  const source = 'a'.repeat(40);
  const repository = 'synthetic/nod';
  const pull = {
    merged_at: '2026-10-09T10:00:00Z',
    merge_commit_sha: source,
    base: { ref: 'main', repo: { full_name: repository } },
    head: { ref: 'release/desktop', repo: { full_name: repository } },
  };
  assert.equal(isReleaseMerge(pull, source, repository), true);
  for (const candidate of [
    { ...pull, merged_at: null },
    { ...pull, merge_commit_sha: 'b'.repeat(40) },
    { ...pull, head: { ...pull.head, ref: 'feature' } },
    { ...pull, head: { ...pull.head, repo: { full_name: 'foreign/nod' } } },
    { ...pull, base: { ...pull.base, ref: 'feature' } },
    { ...pull, base: { ...pull.base, repo: { full_name: 'foreign/nod' } } },
  ])
    assert.equal(isReleaseMerge(candidate, source, repository), false);
});

test('automatic patches release unchanged source and bind generated notes across midnight', async (t) => {
  const f = await releaseRepository(t);
  await prepareRelease(f.root, '0.1.0');
  const source = f.commit();
  f.git('tag', 'nod-v0.1.0');
  const releases = [{ tag_name: 'nod-v0.1.0', draft: false }];
  const plan = automaticRelease(f.root, releases, 'synthetic/nod');
  assert.equal(plan.version, '0.1.1');
  assert.equal(plan.source, source);
  assert.equal(plan.previousTag, 'nod-v0.1.0');
  assert.equal(f.git('status', '--porcelain'), '');
  const path = join(f.root, 'release-plan.json');
  const bytes = JSON.stringify(plan);
  const digest = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path, bytes);
  assert.deepEqual(await checkReleasePlan(f.root, plan.version, path, digest), plan);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 24 * 60 * 60 * 1000 });
  assert.deepEqual(await checkReleasePlan(f.root, plan.version, path, digest), plan);
  const nextDay = automaticRelease(f.root, releases, 'synthetic/nod');
  assert.notEqual(nextDay.date, plan.date);
  t.mock.timers.reset();
  const tampered = JSON.stringify({ ...plan, notes: plan.notes + '\nAltered release.\n' });
  await writeFile(path, tampered);
  await assert.rejects(checkReleasePlan(f.root, plan.version, path, digest));
  await assert.rejects(
    checkReleasePlan(
      f.root,
      plan.version,
      path,
      createHash('sha256').update(tampered).digest('hex'),
    ),
  );
  await writeFile(path, bytes);
  await writeFile(join(f.root, 'desktop/main.mjs'), 'export const dirty = true;\n');
  await assert.rejects(checkReleasePlan(f.root, plan.version, path, digest));
  f.git('add', 'desktop/main.mjs');
  f.git('commit', '-m', 'Synthetic late change');
  await assert.rejects(checkReleasePlan(f.root, plan.version, path, digest));
});

test('automatic patches resume the matching draft and never reuse an occupied or published version', async (t) => {
  const f = await releaseRepository(t);
  await prepareRelease(f.root, '0.1.0');
  f.commit();
  f.git('tag', 'nod-v0.1.0');
  await writeFile(join(f.root, 'desktop/main.mjs'), 'export const updated = true;\n');
  const source = f.commit();
  const published = { tag_name: 'nod-v0.1.0', draft: false };
  const pending = {
    tag_name: 'nod-v0.1.1',
    draft: true,
    target_commitish: source,
    body: `Source: https://github.com/synthetic/nod/commit/${source}`,
  };
  assert.equal(automaticRelease(f.root, [published, pending], 'synthetic/nod').version, '0.1.1');
  assert.throws(() =>
    automaticRelease(f.root, [published, { ...pending, body: 'Unrelated draft' }], 'synthetic/nod'),
  );
  const stale = { ...pending, target_commitish: '0'.repeat(40) };
  assert.equal(automaticRelease(f.root, [published, stale], 'synthetic/nod').version, '0.1.2');
  f.git('tag', 'nod-v0.1.2');
  assert.equal(automaticRelease(f.root, [published, stale], 'synthetic/nod').version, '0.1.3');
  f.git('tag', 'nod-v0.1.1');
  assert.equal(
    automaticRelease(f.root, [published, { ...pending, draft: false }], 'synthetic/nod').version,
    '0.1.3',
  );
  assert.throws(() =>
    automaticRelease(f.root, [{ tag_name: 'nod-v9.0.0', draft: false }], 'synthetic/nod'),
  );
});

test('release recovery binds normal and automatic builds to their original run and refresh', async (t) => {
  for (const automatic of [false, true])
    await t.test(
      automatic ? 'automatic private release' : 'normal public release',
      async (scope) => {
        const f = await releaseRepository(scope);
        await prepareRelease(f.root, '0.1.0');
        let source = f.commit();
        let version = '0.1.0';
        let planBytes;
        if (automatic) {
          f.git('tag', 'nod-v0.1.0');
          await writeFile(join(f.root, 'desktop/main.mjs'), 'export const next = true;\n');
          source = f.commit();
          version = '0.1.1';
          planBytes = Buffer.from(
            JSON.stringify(
              automaticRelease(f.root, [{ tag_name: 'nod-v0.1.0', draft: false }], 'synthetic/nod'),
            ) + '\n',
          );
        }
        const artifacts = join(f.root, '.local/desktop-release-artifacts');
        const updateSourceUrl = automatic
          ? 'https://internal.example.invalid/webhook/nod/desktop'
          : '';
        const runtimeReused = { arm64: automatic, x64: automatic };
        const contextSource = join(f.root, '.local/desktop-release-context.json');
        await promisify(execFile)(
          process.execPath,
          [
            fileURLToPath(
              new URL('../../.github/scripts/desktop-release-recovery.mjs', import.meta.url),
            ),
            'create',
          ],
          {
            cwd: f.root,
            env: {
              PATH: process.env.PATH,
              GITHUB_REPOSITORY: 'synthetic/nod',
              GITHUB_RUN_ID: '456',
              GITHUB_RUN_ATTEMPT: '2',
              NOD_CONTEXT_SOURCE: source,
              NOD_CONTEXT_VERSION: version,
              NOD_CONTEXT_RUNTIME_REFRESH: '2026-11-02',
              NOD_CONTEXT_MAC_MATRIX: JSON.stringify({
                include: ['arm64', 'x64'].map((arch) => ({
                  arch,
                  runtime_reused: String(runtimeReused[arch]),
                })),
              }),
              NOD_CONTEXT_PLAN_SHA256: planBytes
                ? createHash('sha256').update(planBytes).digest('hex')
                : '',
              NOD_CONTEXT_UPDATE_SOURCE_URL: updateSourceUrl,
              NOD_CONTEXT_PRIVATE: String(automatic),
            },
          },
        );
        const context = recoveryContext(JSON.parse(await readFile(contextSource, 'utf8')));
        const contextPath = join(artifacts, 'desktop-release-context/desktop-release-context.json');
        await mkdir(dirname(contextPath), { recursive: true });
        await copyFile(contextSource, contextPath);
        if (planBytes) {
          const planPath = join(artifacts, 'desktop-release-plan/desktop-release-plan.json');
          await mkdir(dirname(planPath), { recursive: true });
          await writeFile(planPath, planBytes);
        }
        const manifests = [
          ['arm64/release.json', 'darwin-arm64'],
          ['x64/release.json', 'darwin-x64'],
          ['win32-x64/release-win32-x64.json', 'win32-x64'],
        ];
        for (const [file, platform] of manifests) {
          const path = join(f.root, 'dist/desktop', file);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(
            path,
            JSON.stringify({
              platform,
              version,
              source,
              ...(updateSourceUrl ? { updateSourceUrl } : {}),
            }),
          );
          if (platform !== 'win32-x64')
            await writeFile(
              join(dirname(path), 'runtime-release.json'),
              JSON.stringify({ releaseTag: automatic ? 'nod-v0.1.0' : `nod-v${version}` }),
            );
        }
        const expected = {
          repository: 'synthetic/nod',
          runId: '456',
          runAttempt: '2',
          source,
          privateRepository: automatic,
        };
        const publisher = {
          name: 'Verify uploaded assets and prepare the release',
          conclusion: 'failure',
        };
        const jobs = [
          'Check release prerequisites',
          'Check arm64 Mac updates',
          'Check x64 Mac updates',
          'Package the arm64 Mac app',
          'Package the x64 Mac app',
          'Build the Windows runtime',
          'Check Windows updates',
          'Package and check the Windows installer',
        ].map((name) => ({ name, conclusion: 'success' }));
        if (!automatic)
          for (const arch of ['arm64', 'x64'])
            jobs.push({ name: `Build ${arch} Mac runtime images`, conclusion: 'success' });
        jobs.push(publisher);
        const getAttemptJobs = async (attempt) => {
          if (attempt === '2') return jobs;
          if (attempt === '3') return [publisher];
          throw new Error('Unexpected run attempt.');
        };
        const recover = (selected = expected, getJobs = getAttemptJobs) =>
          bindRecovery({ root: f.root, artifacts, expected: selected, getAttemptJobs: getJobs });
        scope.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
        const environment = await recover();
        assert.equal(environment.NOD_RELEASE_SOURCE, source);
        assert.equal(environment.NOD_RELEASE_VERSION, version);
        assert.equal(environment.NOD_DESKTOP_UPDATE_SOURCE_URL, updateSourceUrl);
        assert.equal(environment.NOD_RUNTIME_REFRESH, '2026-11-02');
        assert.equal(environment.NOD_RELEASE_PLAN_SHA256, context.metadataSha256 || undefined);
        assert.equal(
          environment.NOD_RELEASE_PLAN,
          automatic ? '.local/desktop-release-plan.json' : undefined,
        );
        if (automatic)
          assert.deepEqual(await readFile(join(f.root, environment.NOD_RELEASE_PLAN)), planBytes);
        const rerun = await recover({ ...expected, runAttempt: '3' });
        assert.equal(rerun.NOD_RUNTIME_REFRESH, '2026-11-02');
        await assert.rejects(recover({ ...expected, runAttempt: '1' }), /selected build run/);
        await assert.rejects(recover({ ...expected, runId: '457' }), /selected build run/);
        if (!automatic)
          await assert.rejects(
            recover({ ...expected, runAttempt: '3' }, async (attempt) =>
              attempt === '3'
                ? [publisher, { name: 'Build arm64 Mac runtime images', conclusion: 'skipped' }]
                : jobs,
            ),
            /arm64 runtime image/,
          );
        await assert.rejects(
          recover({ ...expected, runAttempt: '3' }, async (attempt) =>
            attempt === '3'
              ? [publisher, { name: 'Future verification', conclusion: 'failure' }]
              : jobs,
          ),
          /unexpected unsuccessful job/,
        );
        if (automatic) {
          await recover({ ...expected, runAttempt: '3' }, async (attempt) =>
            attempt === '3'
              ? [
                  publisher,
                  {
                    name: 'Build ${{ matrix.arch }} Mac runtime images',
                    conclusion: 'skipped',
                  },
                ]
              : jobs,
          );
          await assert.rejects(
            recover({ ...expected, privateRepository: false }),
            /visibility changed/,
          );
          await writeFile(
            join(artifacts, 'desktop-release-plan/desktop-release-plan.json'),
            Buffer.from('Changed release plan'),
          );
          await assert.rejects(recover(), /checksum/);
        } else {
          const path = join(f.root, 'dist/desktop/x64/release.json');
          await writeFile(
            path,
            JSON.stringify({
              platform: 'darwin-x64',
              version,
              source,
              updateSourceUrl: 'https://other.example.invalid',
            }),
          );
          await assert.rejects(recover(), /darwin-x64 release/);
        }
        scope.mock.timers.reset();
      },
    );
});

test('signing discovery preserves native bundles and skips symlinks under a low file limit', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nod-signing-discovery-')));
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
      'nod-signing-discovery',
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

test(
  'disk image checks reject a valid signed app without an attached Apple ticket',
  {
    skip: process.platform !== 'darwin',
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nod-disk-fixture-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const contents = join(root, 'source', 'Synthetic.app', 'Contents');
    await mkdir(join(contents, 'MacOS'), { recursive: true });
    await copyFile('/usr/bin/true', join(contents, 'MacOS', 'synthetic'));
    await writeFile(
      join(contents, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>invalid.example.nod-disk-fixture</string>
<key>CFBundleExecutable</key><string>synthetic</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`,
    );
    await run('/usr/bin/codesign', ['--force', '--sign', '-', dirname(contents)]);
    const image = join(root, 'synthetic.dmg');
    await run('/usr/bin/hdiutil', [
      'create',
      '-srcfolder',
      join(root, 'source'),
      '-format',
      'UDZO',
      image,
    ]);
    await assert.rejects(verifyDiskImage(image, 'Synthetic'), (error) => {
      assert.match(error.diagnostic, /does not have a ticket stapled/);
      return true;
    });
  },
);

async function releaseFixture(
  t,
  {
    isPublic = false,
    developerId = isPublic,
    publish = false,
    plan = false,
    runtimeRepository = 'synthetic/nod',
    diskName = 'nod-arm64.dmg',
    updateSourceUrl,
    automatic = false,
  } = {},
) {
  const f = await releaseRepository(t);
  const root = f.root;
  const scripts = join(root, '.github/scripts');
  const provenance = join(root, '.local/fixture.sigstore.json');
  await mkdir(dirname(provenance), { recursive: true });
  await writeFile(provenance, 'Synthetic signature bundle');
  await mkdir(scripts, { recursive: true });
  await copyFile(
    fileURLToPath(new URL('../../.github/scripts/prepare-desktop-release.mjs', import.meta.url)),
    join(scripts, 'prepare-desktop-release.mjs'),
  );
  await mkdir(join(root, 'deployment/n8n'), { recursive: true });
  await writeFile(join(root, 'deployment/n8n/install.sh'), 'exit 0\n');
  await writeFile(join(root, 'deployment/n8n/install.ps1'), 'Write-Output "Synthetic"\n');
  if (plan) {
    const { runtimeInputs } = await import('../scripts/runtime-inputs.mjs');
    const input = await runtimeInputs();
    const windows = await runtimeInputs('win32-x64');
    const repository = fileURLToPath(new URL('../../', import.meta.url));
    for (const path of new Set([
      ...[...input.inputs, ...windows.inputs].filter(
        (path) => !path.includes(':') && !path.startsWith('@') && !path.startsWith('signing.'),
      ),
      'package.json',
      'pnpm-lock.yaml',
      'desktop/package.json',
      'desktop/pnpm-lock.yaml',
      'desktop/scripts/runtime-inputs.mjs',
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
    f.git('tag', 'nod-v0.1.0');
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
    NOD_DESKTOP_TARGET: 'darwin-arm64',
    NOD_SIGNING_MODE: developerId ? 'developer-id' : 'self-signed',
    NOD_SIGNING_IDENTITY: 'Synthetic Nod Signing',
    NOD_SIGNING_CERTIFICATE_SHA256: digest(certificate),
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
  const appTag = `nod-v${version}`;
  const name = `nod-Runtime-darwin-arm64-${digest('Synthetic runtime files').slice(0, 12)}.tar.gz`;
  const release = {
    version: 1,
    platform: 'darwin-arm64',
    releaseTag: appTag,
    fingerprint,
    id: digest('Synthetic runtime files'),
    source,
    minimumSystemVersion: '14.0',
    archive: { file: name, bytes: archive.length, sha256: digest(archive) },
    signing: {
      mode: developerId ? 'developer-id' : 'self-signed',
      certificateSha256: digest(certificate),
      ...(developerId ? { teamId: 'SYNTHETIC1' } : {}),
    },
    ...(developerId
      ? { notarization: { status: 'Accepted', id: '12345678-1234-1234-1234-123456789abc' } }
      : {}),
    ...(isPublic && publish
      ? { url: `https://github.com/synthetic/nod/releases/download/${appTag}/${name}` }
      : {}),
  };
  const disk = Buffer.from('Synthetic signed disk image');
  const update = Buffer.from('Synthetic signed application ZIP');
  const updateName = 'nod-arm64.zip';
  const feed = {
    url: `https://github.com/synthetic/nod/releases/download/${appTag}/${updateName}`,
    name: `Nod ${version}`,
    pub_date: '2026-10-04T12:00:00Z',
  };
  const metadata = {
    platform: 'darwin-arm64',
    version,
    source,
    ...(updateSourceUrl ? { updateSourceUrl } : {}),
    signing: release.signing,
    notarized: developerId,
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
  await mkdir(join(assets, 'arm64'), { recursive: true });
  await copyFile(join(assets, name), join(assets, 'arm64', name));
  const statePath = join(root, 'github.json');
  const readState = async () => JSON.parse(await readFile(statePath, 'utf8'));
  const writeState = (state) => writeFile(statePath, JSON.stringify(state));
  await writeState({
    private: !isPublic,
    runtimeRepository,
    releases: automatic
      ? {
          'nod-v0.1.0': {
            id: 100,
            tag_name: 'nod-v0.1.0',
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
        head_repository: { full_name: 'synthetic/nod' },
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
  if (args[1] === 'repos/synthetic/nod' || args[1] === 'repos/' + state.runtimeRepository) output({ private: state.private });
  if (args[1] === 'repos/' + state.runtimeRepository + '/commits/main') output({ sha: 'f'.repeat(40) });
  if (args[1].includes('/actions/workflows/')) output({ workflow_runs: state.runs });
  if (args[1].endsWith('/pulls')) output(state.pulls || []);
  if (args[1] === 'repos/synthetic/nod/releases?per_page=100') {
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
  const release = Object.values(state.releases).find(value => args[1] === 'repos/synthetic/nod/releases/' + value.id || args[1] === 'repos/' + state.runtimeRepository + '/releases/' + value.id);
  if (release) output(release);
  missing();
}
if (args[0] === 'attestation') {
  if (state.rejectAttestation) process.exit(1);
  output([]);
}
if (args[0] !== 'release') throw new Error('Unexpected command');
const tag = args[2];
if (args[1] === 'create') {
  if (state.releases[tag]) throw new Error('Duplicate release');
  const id = ++state.created;
  state.releases[tag] = { id, tag_name: tag, target_commitish: args.includes('--target') ? flag('--target') : 'main', draft: args.includes('--draft'), prerelease: args.includes('--prerelease'), body: readFileSync(flag('--notes-file'), 'utf8'), html_url: 'https://github.com/synthetic/nod/releases/tag/untagged-' + id, assets: [] };
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
      release.published_at = '2026-10-04T12:00:00Z';
      release.html_url = 'https://github.com/synthetic/nod/releases/tag/' + tag;
      if (state.publicOnPublish) state.private = false;
    }
    if (args.includes('--draft=true')) release.draft = true;
    if (args.includes('--prerelease=false')) release.prerelease = false;
    if (args.includes('--notes-file')) release.body = readFileSync(flag('--notes-file'), 'utf8');
  } else if (args[1] === 'upload') {
    for (const file of args.slice(3, args.indexOf('--repo'))) {
      const bytes = readFileSync(file);
      const name = basename(file);
      release.assets = release.assets.filter(asset => asset.name !== name);
      state.assetIds = (state.assetIds || 0) + 1;
      release.assets.push({ id: state.assetIds, name, size: bytes.length, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), state: 'uploaded' });
      state.contents[tag + '/' + name] = bytes.toString('base64');
    }
    if (state.publicOnUpload) state.private = false;
  } else if (args[1] === 'download') {
    mkdirSync(flag('--dir'), { recursive: true });
    for (const name of args.filter((value, index) => args[index - 1] === '--pattern')) {
      if (!state.contents[tag + '/' + name]) missing();
      writeFileSync(join(flag('--dir'), name), state.corruptDownload === name || (state.corruptDmg && name.endsWith('.dmg')) || (state.corruptZip && name.endsWith('.zip')) ? 'Corrupted application' : Buffer.from(state.contents[tag + '/' + name], 'base64'));
    }
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
import { checkRedirect, checkRequest, releaseResponse } from ${JSON.stringify(new URL('../../deployment/n8n/desktop-releases.mjs', import.meta.url).href)};
const broker = (state, url, source) => {
  const path = url.pathname.slice(new URL(source).pathname.length + 1).split('/');
  const params = path[0] === 'tags' ? { tag: path[1] } : Object.fromEntries([['releaseId', path[1]], ['assetId', path[3]], ['filename', path[4]]].filter(([, value]) => value !== undefined));
  const checked = checkRequest({ params, query: Object.fromEntries(url.searchParams) });
  if (checked.status) return Response.json(checked.body, { status: checked.status });
  const releases = Object.values(state.releases).map(release => ({ ...release, assets: release.assets.filter(asset => !state.brokerHides?.includes(asset.name)) }));
  const found = releases.find(release => checked.tag ? release.tag_name === checked.tag : release.id === checked.releaseId);
  const pages = checked.tag || checked.releaseId ? [found ? { statusCode: 200, body: found } : { statusCode: 404, body: {} }] : [{ statusCode: 200, body: releases }];
  const result = releaseResponse(pages, checked, source);
  if (result.assetUrl) {
    const name = found.assets.find(asset => asset.id === checked.assetId).name;
    const redirect = result.metadata
      ? checkRedirect({ statusCode: 200, body: Buffer.from(state.contents[found.tag_name + '/' + name], 'base64').toString('utf8') }, result.metadata)
      : checkRedirect({ statusCode: 302, headers: { location: 'https://release-assets.githubusercontent.com/synthetic' } });
    return redirect.status === 302 ? new Response(null, { status: 302, headers: { location: redirect.location } }) : Response.json(redirect.body, { status: redirect.status });
  }
  return result.status === 204 ? new Response(null, { status: 204 }) : Response.json(result.body, { status: result.status });
};
globalThis.fetch = async (url, options = {}) => {
  const file = process.env.FIXTURE_STATE;
  const state = JSON.parse(readFileSync(file, 'utf8'));
  state.calls.push(['fetch', options.method || 'GET', String(url), new Headers(options.headers).has('authorization')]);
  writeFileSync(file, JSON.stringify(state));
  const source = process.env.NOD_DESKTOP_UPDATE_SOURCE_URL;
  if (source && String(url).startsWith(source + '/')) return broker(state, new URL(url), source);
  const address = new URL(url);
  if (address.origin === 'https://github.com' && address.pathname.startsWith('/synthetic/nod/releases/latest/download/')) {
    const release = Object.values(state.releases).filter(entry => !entry.draft).sort((a, b) => b.tag_name.localeCompare(a.tag_name, undefined, { numeric: true }))[0];
    const name = address.pathname.slice('/synthetic/nod/releases/latest/download/'.length);
    if (!release || !state.contents[release.tag_name + '/' + name]) return new Response(null, { status: 404 });
    return new Response(null, { status: 302, headers: { location: 'https://github.com/synthetic/nod/releases/download/' + release.tag_name + '/' + name } });
  }
  const match = String(url).match(/^https:\/\/github\.com\/synthetic\/nod\/releases\/download\/([^/]+)\/([^/]+)$/);
  if (!match) throw new Error('Unexpected network access');
  const [, tag, name] = match;
  const bytes = state.contents[tag + '/' + name];
  if (state.releases[tag]?.draft || !bytes || state.failPublicDownload || (options.method === 'HEAD' && state.missingHead === String(url))) return new Response(null, { status: 404 });
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
        NOD_RUNTIME_REPO: runtimeRepository,
        GITHUB_REPOSITORY: 'synthetic/nod',
        GITHUB_SHA: source,
        GITHUB_REF: 'refs/heads/main',
        GITHUB_ACTIONS: 'true',
        GITHUB_WORKFLOW_REF: 'synthetic/nod/.github/workflows/desktop-release.yml@refs/heads/main',
        ...(isPublic ? { NOD_RELEASE_ATTESTATION: provenance } : {}),
        APPLE_CONFIGURED: 'true',
        ...signingEnv,
        NOD_RUNTIME_FINGERPRINT: fingerprint,
        NOD_EXPECTED_RUNTIME_FINGERPRINT: fingerprint,
        NOD_PUBLISH_RELEASE: String(requestPublish),
        NOD_AUTOMATIC_RELEASE: String(automatic),
        ...(updateSourceUrl ? { NOD_DESKTOP_UPDATE_SOURCE_URL: updateSourceUrl } : {}),
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

test('public releases refuse missing or rejected provenance before uploading assets', async (t) => {
  const f = await releaseFixture(t, { isPublic: true });
  await assert.rejects(
    f.invoke('draft', false, { NOD_RELEASE_ATTESTATION: '' }),
    /require build provenance/,
  );
  await assert.rejects(
    f.invoke('draft', false, {
      GITHUB_WORKFLOW_REF: 'synthetic/fork/.github/workflows/desktop-release.yml@refs/heads/main',
    }),
    /trusted main workflow/,
  );
  await f.writeState({ ...(await f.readState()), rejectAttestation: true });
  await assert.rejects(f.invoke('draft'), /GitHub release access failed/);
  assert.equal((await f.readState()).created, 0);
  await f.writeState({ ...(await f.readState()), rejectAttestation: false });
  await f.invoke('draft', false, {
    NOD_RELEASE_SOURCE: f.source,
    GITHUB_SHA: 'b'.repeat(40),
    GITHUB_WORKFLOW_REF:
      'synthetic/nod/.github/workflows/recover-desktop-release.yml@refs/heads/main',
  });
  const state = await f.readState();
  assert(
    state.releases[f.appTag].assets.some((asset) => asset.name === 'nod-release.sigstore.json'),
  );
  const checks = state.calls.filter((call) => call[0] === 'attestation');
  assert(checks.length > 1);
  for (const call of checks) {
    assert.equal(call[call.indexOf('--source-digest') + 1], f.source);
    assert.equal(
      call[call.indexOf('--signer-workflow') + 1],
      'synthetic/nod/.github/workflows/desktop-release.yml',
    );
  }
});

test('public desktop releases refuse broker-backed bundles before upload', async (t) => {
  const f = await releaseFixture(t, {
    isPublic: true,
    updateSourceUrl: 'https://internal.example.invalid/webhook/nod/desktop',
  });
  await assert.rejects(f.invoke('draft', false), /private update service/);
  assert.equal((await f.readState()).created, 0);
});

test('private releases require provenance when attestations are enabled', async (t) => {
  const f = await releaseFixture(t);
  for (const workflow of ['desktop-release', 'recover-desktop-release']) {
    await assert.rejects(
      f.invoke('draft', false, {
        NOD_PRIVATE_ATTESTATIONS: 'true',
        NOD_RELEASE_ATTESTATION: '',
        NOD_RELEASE_SOURCE: f.source,
        GITHUB_SHA: 'b'.repeat(40),
        GITHUB_WORKFLOW_REF: `synthetic/nod/.github/workflows/${workflow}.yml@refs/heads/main`,
      }),
      /require build provenance/,
    );
    assert.equal((await f.readState()).created, 0);
  }
  await f.invoke('draft', false, { NOD_PRIVATE_ATTESTATIONS: 'false' });
  assert.equal((await f.readState()).created, 1);
});

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
    await assert.rejects(f.invoke('plan'));
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
    NOD_RELEASE_PLAN: join(f.root, '.local/desktop-release-plan.json'),
    NOD_RELEASE_PLAN_SHA256: plan.metadata_sha256,
  };
  await assert.rejects(
    f.invoke('draft', true, { ...environment, NOD_RELEASE_PLAN_SHA256: '0'.repeat(64) }),
  );
  await assert.rejects(f.invoke('draft', true, { ...environment, GITHUB_ACTIONS: 'false' }));
  assert.equal((await f.readState()).releases[f.appTag], undefined);
  await f.invoke('draft', true, environment);
  const published = await f.readState();
  assert.equal(published.releases[f.appTag].draft, false);
  assert.equal(published.releases[f.appTag].target_commitish, f.source);
  assert.equal(published.releases[f.appTag].prerelease, false);
  assert.equal(published.releases[f.runtimeTag], undefined);
  assert.equal(published.created, 1);
  assert.deepEqual(published.releases['nod-v0.1.0'], initial.releases['nod-v0.1.0']);
  f.git('tag', f.appTag);
  await assert.rejects(f.invoke('plan', true, { APPLE_CONFIGURED: 'false' }));
  const repeated = JSON.parse((await f.invoke('plan')).stdout);
  assert.equal(repeated.release_needed, 'true');
  assert.equal(repeated.version, '0.1.2');
  assert.equal(repeated.runtime_reused, 'true');
  assert.deepEqual((await f.readState()).releases, published.releases);
  assert.equal((await f.readState()).created, 1);
});

test('a release manifest push publishes only a merged release PR and keeps the tested source when main moves', async (t) => {
  const f = await releaseFixture(t, { plan: true, publish: true });
  const environment = {
    GITHUB_EVENT_NAME: 'push',
    GITHUB_SHA: 'b'.repeat(40),
    NOD_RELEASE_SOURCE: f.source,
  };
  assert.equal(
    JSON.parse((await f.invoke('plan', true, environment)).stdout).release_needed,
    'false',
  );
  assert.equal((await f.readState()).created, 0);
  await f.writeState({
    ...(await f.readState()),
    pulls: [
      {
        merged_at: '2026-10-09T10:00:00Z',
        merge_commit_sha: f.source,
        base: { ref: 'main', repo: { full_name: 'synthetic/nod' } },
        head: { ref: 'release/desktop', repo: { full_name: 'synthetic/nod' } },
      },
    ],
  });
  const plan = JSON.parse((await f.invoke('plan', true, environment)).stdout);
  assert.equal(plan.release_needed, 'true');
  assert.equal(plan.source, f.source);
  await f.invoke('draft', true, environment);
  const state = await f.readState();
  assert.equal(state.releases[f.appTag].draft, false);
  assert.equal(state.releases[f.appTag].target_commitish, f.source);
  assert.equal(
    JSON.parse((await f.invoke('plan', true, environment)).stdout).release_needed,
    'false',
  );
  assert.equal((await f.readState()).created, state.created);
  assert.equal(
    JSON.parse(
      (await f.invoke('plan', true, { ...environment, NOD_RELEASE_TARGETS: 'all' })).stdout,
    ).release_needed,
    'false',
  );
});

test('a private repository plans and drafts a notarized Developer ID release', async (t) => {
  const f = await releaseFixture(t, { developerId: true, plan: true });
  assert.equal(JSON.parse((await f.invoke('plan')).stdout).runtime_public, 'false');
  await f.invoke('draft');
  assert.equal((await f.readState()).releases[f.appTag].draft, true);
});

test('app upload rejects mismatched update artifacts, feed and provenance', async (t) => {
  const f = await releaseFixture(t);
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
    updateSourceUrl: 'https://releases.example.invalid/nod',
  });
  await writeFile(
    join(f.output, 'release.json'),
    JSON.stringify({ ...f.metadata, updateSourceUrl: undefined }),
  );
  await assert.rejects(f.invoke('draft'));
  assert.equal((await f.readState()).releases[f.appTag], undefined);
  await writeFile(join(f.output, 'release.json'), JSON.stringify(f.metadata));
  await f.invoke('draft');
  const state = await f.readState();
  const assets = state.releases[f.appTag].assets;
  for (const entry of [f.metadata.disk, f.metadata.update]) {
    const { name, size, digest } = assets.find((asset) => asset.name === entry.file);
    assert.deepEqual(
      { name, size, digest },
      {
        name: entry.file,
        size: entry.bytes,
        digest: `sha256:${entry.sha256}`,
      },
    );
  }
  assert.equal(
    JSON.parse(Buffer.from(state.contents[f.appTag + '/release.json'], 'base64')).updateSourceUrl,
    f.metadata.updateSourceUrl,
  );
  assert(Object.values(state.releases).every((release) => !release.draft));
  for (const source of [
    'http://releases.example.invalid/nod',
    'https://user:password@releases.example.invalid/nod',
    'https://releases.example.invalid/nod?token=synthetic',
    'https://releases.example.invalid/nod#fragment',
    'https://releases.example.invalid/nod?',
    'https://releases.example.invalid/nod#',
  ]) {
    const invalid = await releaseFixture(t, { updateSourceUrl: source });
    await assert.rejects(invalid.invoke('draft'));
    assert.equal((await invalid.readState()).created, 0);
  }
  const unrelated = await releaseFixture(t, { diskName: 'Other-arm64.dmg' });
  await assert.rejects(unrelated.invoke('draft'), /DMG, application ZIP and checksums/);
  assert.equal((await unrelated.readState()).releases[unrelated.appTag], undefined);
});

test('pending public runtime packaging defers only reachability for the checked CI descriptor', async (t) => {
  const f = await releaseFixture(t, { isPublic: true, publish: true });
  const configuration = { ...f.release.signing, team: f.release.signing.teamId };
  const descriptorPath = join(f.assets, 'runtime-release.json');
  const env = {
    GITHUB_ACTIONS: 'true',
    NOD_DESKTOP_TARGET: 'darwin-arm64',
    NOD_PENDING_RUNTIME_DESCRIPTOR_SHA256: await assetHash(descriptorPath),
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
  );
  await assert.rejects(
    verifyRuntimeRelease(f.release, f.release.fingerprint, configuration, {
      descriptorPath,
      env: { ...env, GITHUB_ACTIONS: 'false' },
    }),
  );
  await writeFile(descriptorPath, JSON.stringify({ ...f.release, source: '0'.repeat(40) }));
  await assert.rejects(
    verifyRuntimeRelease(f.release, f.release.fingerprint, configuration, { descriptorPath, env }),
  );
  await assert.rejects(
    verifyRuntimeRelease(f.release, f.release.fingerprint, configuration, {
      env: { NOD_DESKTOP_TARGET: 'darwin-arm64' },
    }),
  );
});

test('one official release waits for verified runtime and downloaded app bytes', async (t) => {
  const f = await releaseFixture(t, { publish: true });
  const archive = join(f.assets, 'arm64', f.release.archive.file);
  const bytes = await readFile(archive);
  await writeFile(archive, 'Corrupt runtime');
  await assert.rejects(f.invoke('draft'));
  assert.equal((await f.readState()).created, 0);
  await writeFile(archive, bytes);
  for (const key of ['corruptDmg', 'corruptZip']) {
    await f.writeState({ ...(await f.readState()), [key]: true });
    await assert.rejects(f.invoke('draft'));
    const failed = await f.readState();
    assert(Object.values(failed.releases).every((release) => release.draft));
    assert(!failed.calls.some((call) => call.includes('--draft=false')));
    await f.writeState({ ...failed, [key]: false });
  }
  await f.invoke('draft');
  const state = await f.readState();
  assert.equal(state.created, 1);
  assert.equal(state.releases[f.appTag].draft, false);
  assert.equal(state.releases[f.appTag].prerelease, false);
  assert.deepEqual(
    state.calls.filter((call) => call.includes('--draft=false')).map((call) => call[2]),
    [f.appTag],
  );
  await assert.rejects(f.invoke('draft'));
});

test('all three checked bundles publish together as one regular Nod release', async (t) => {
  for (const { isPublic, updateSourceUrl, rejectBroker = false, reusedRuntime = false } of [
    { isPublic: false, updateSourceUrl: 'https://releases.example.invalid/nod' },
    { isPublic: true },
    { isPublic: true, updateSourceUrl: 'https://releases.example.invalid/nod', rejectBroker: true },
    { isPublic: true, reusedRuntime: true },
  ]) {
    const f = await releaseFixture(t, {
      isPublic,
      plan: true,
      publish: true,
      updateSourceUrl,
    });
    const target = join(f.root, 'dist/desktop');
    const arm = join(target, 'arm64');
    const intel = join(target, 'x64');
    const windows = join(target, 'win32-x64');
    const names = [
      'release.json',
      'runtime-release.json',
      'update.json',
      'SHA256SUMS',
      'signing.cer',
      'nod-arm64.dmg',
      'nod-arm64.zip',
    ];
    for (const directory of [arm, intel, windows]) await mkdir(directory, { recursive: true });
    const reusedTag = 'nod-v0.0.9';
    const armRuntime = reusedRuntime
      ? {
          ...f.release,
          releaseTag: reusedTag,
          url: `https://github.com/synthetic/nod/releases/download/${reusedTag}/${f.release.archive.file}`,
        }
      : f.release;
    if (reusedRuntime)
      await writeFile(join(f.output, 'runtime-release.json'), JSON.stringify(armRuntime));
    for (const name of names) await copyFile(join(f.output, name), join(arm, name));
    const fingerprint = JSON.parse(
      (
        await promisify(execFile)(process.execPath, ['desktop/scripts/runtime-inputs.mjs'], {
          cwd: f.root,
          env: {
            NOD_DESKTOP_TARGET: 'darwin-x64',
            NOD_SIGNING_MODE: f.release.signing.mode,
            NOD_SIGNING_IDENTITY: 'Synthetic Nod Signing',
            NOD_SIGNING_CERTIFICATE_SHA256: f.metadata.signing.certificateSha256,
          },
        })
      ).stdout,
    ).fingerprint;
    const runtime = {
      ...armRuntime,
      platform: 'darwin-x64',
      fingerprint,
      archive: { ...armRuntime.archive, file: armRuntime.archive.file.replace('arm64', 'x64') },
      ...(isPublic ? { url: armRuntime.url.replace('arm64', 'x64') } : {}),
    };
    const metadata = {
      ...f.metadata,
      platform: 'darwin-x64',
      runtime: { fingerprint, id: runtime.id, archive: runtime.archive },
      disk: { ...f.metadata.disk, file: 'nod-x64.dmg' },
      update: { ...f.metadata.update, file: 'nod-x64.zip' },
    };
    await writeFile(join(intel, 'release.json'), JSON.stringify(metadata));
    await writeFile(join(intel, 'runtime-release.json'), JSON.stringify(runtime));
    await writeFile(
      join(intel, 'update.json'),
      JSON.stringify({ ...f.feed, url: f.feed.url.replace('arm64', 'x64') }),
    );
    await writeFile(
      join(intel, 'SHA256SUMS'),
      `${metadata.disk.sha256}  nod-x64.dmg\n${metadata.update.sha256}  nod-x64.zip\n`,
    );
    for (const [old, next] of [
      ['signing.cer', 'signing.cer'],
      ['nod-arm64.dmg', 'nod-x64.dmg'],
      ['nod-arm64.zip', 'nod-x64.zip'],
    ])
      await copyFile(join(arm, old), join(intel, next));
    await mkdir(join(f.assets, 'x64'), { recursive: true });
    await copyFile(
      join(f.assets, f.release.archive.file),
      join(f.assets, 'x64', runtime.archive.file),
    );
    if (reusedRuntime) {
      const oldAssets = [
        [armRuntime.archive.file, await readFile(join(f.assets, armRuntime.archive.file))],
        [runtime.archive.file, await readFile(join(f.assets, 'x64', runtime.archive.file))],
        [
          `runtime-darwin-arm64-${armRuntime.fingerprint}.json`,
          Buffer.from(JSON.stringify(armRuntime)),
        ],
        [`runtime-darwin-x64-${runtime.fingerprint}.json`, Buffer.from(JSON.stringify(runtime))],
      ];
      const state = await f.readState();
      state.releases[reusedTag] = {
        id: 90,
        tag_name: reusedTag,
        target_commitish: f.source,
        draft: false,
        prerelease: false,
        assets: oldAssets.map(([name, bytes], index) => ({
          id: index + 1,
          name,
          size: bytes.length,
          digest: `sha256:${f.digest(bytes)}`,
          state: 'uploaded',
        })),
      };
      for (const [name, bytes] of oldAssets)
        state.contents[`${reusedTag}/${name}`] = bytes.toString('base64');
      await f.writeState(state);
    }
    const installer = Buffer.from('Synthetic Windows installer');
    const pack = Buffer.from('Synthetic Windows runtime');
    const win = {
      platform: 'win32-x64',
      version: f.metadata.version,
      source: f.source,
      updateSourceUrl: f.metadata.updateSourceUrl,
      signing: { mode: 'artifact-signing' },
      installer: {
        file: 'nod-Setup-x64.exe',
        bytes: installer.length,
        sha256: f.digest(installer),
      },
      runtime: { file: 'nod-Runtime-win32-x64.tar.gz', bytes: pack.length, sha256: f.digest(pack) },
    };
    await writeFile(join(windows, win.installer.file), installer);
    await writeFile(join(windows, win.runtime.file), pack);
    await writeFile(join(windows, 'release-win32-x64.json'), JSON.stringify(win));
    const windowsFingerprint = JSON.parse(
      (
        await promisify(execFile)(process.execPath, ['desktop/scripts/runtime-inputs.mjs'], {
          cwd: f.root,
          env: { NOD_DESKTOP_TARGET: 'win32-x64' },
        })
      ).stdout,
    ).fingerprint;
    const windowsManifest = `runtime-win32-x64-${windowsFingerprint}.json`;
    const windowsRuntime = {
      version: 1,
      platform: 'win32-x64',
      images: [],
      guest: { file: 'guest.tar.gz', bytes: pack.length, sha256: win.runtime.sha256 },
      fingerprint: windowsFingerprint,
    };
    await writeFile(join(windows, windowsManifest), JSON.stringify(windowsRuntime));
    const receipt = Object.fromEntries(
      [
        'installed',
        'signatures',
        'engine',
        'wsl',
        'application',
        'browser',
        'workspaceFiles',
        'reopened',
      ].map((key) => [key, true]),
    );
    await writeFile(
      join(windows, 'SHA256SUMS'),
      `${win.installer.sha256}  ${win.installer.file}\n${win.runtime.sha256}  ${win.runtime.file}\n`,
    );
    await writeFile(join(windows, 'windows-check.json'), JSON.stringify(receipt));
    if (rejectBroker) {
      await assert.rejects(f.invoke('draft-all'), /private update service/);
      assert.equal((await f.readState()).created, 0);
      continue;
    }
    {
      for (const missing of ['reopened', 'signatures']) {
        await writeFile(
          join(windows, 'windows-check.json'),
          JSON.stringify({ ...receipt, [missing]: false }),
        );
        await assert.rejects(f.invoke('draft-all'));
        assert.equal((await f.readState()).created, 0);
      }
      await writeFile(join(windows, 'windows-check.json'), JSON.stringify(receipt));
      await f.invoke('stage-all');
      assert.equal((await f.readState()).created, 0);
      const subjects = await readFile(join(f.root, '.local/release-SHA256SUMS'), 'utf8');
      assert(subjects.includes(`${win.installer.sha256}  ${win.installer.file}\n`));
      assert(subjects.includes(`${win.runtime.sha256}  ${win.runtime.file}\n`));
      assert(subjects.includes('nod-install.sh'));
      assert(subjects.includes('nod-install.ps1'));
      await writeFile(join(intel, 'nod-x64.zip'), 'Corrupt Intel ZIP');
      await assert.rejects(f.invoke('draft-all'));
      assert.equal((await f.readState()).created, 0);
      assert.equal((await f.readState()).releases[f.appTag], undefined);
      await copyFile(join(arm, 'nod-arm64.zip'), join(intel, 'nod-x64.zip'));
      await writeFile(
        join(windows, windowsManifest),
        JSON.stringify({
          ...windowsRuntime,
          guest: { ...windowsRuntime.guest, sha256: win.installer.sha256 },
        }),
      );
      await assert.rejects(f.invoke('draft-all'), /Windows runtime does not match/);
      await writeFile(join(windows, windowsManifest), JSON.stringify(windowsRuntime));
      for (const name of [
        'nod-arm64.dmg',
        'nod-arm64.zip',
        'nod-x64.dmg',
        'nod-x64.zip',
        win.installer.file,
        win.runtime.file,
      ]) {
        await f.writeState({ ...(await f.readState()), corruptDownload: name });
        await assert.rejects(f.invoke('draft-all'), /failed its checksum/);
        assert.equal((await f.readState()).releases[f.appTag].draft, true);
      }
      await f.writeState({ ...(await f.readState()), corruptDownload: undefined });
      if (isPublic) {
        await f.writeState({ ...(await f.readState()), failPublicDownload: true });
        await assert.rejects(f.invoke('draft-all'));
        assert.equal((await f.readState()).releases[f.appTag].draft, true);
        await f.writeState({ ...(await f.readState()), failPublicDownload: false });
      } else {
        for (const hidden of [runtime.archive.file, win.runtime.file]) {
          await f.writeState({ ...(await f.readState()), brokerHides: [hidden] });
          await assert.rejects(f.invoke('draft-all'));
          assert.equal((await f.readState()).releases[f.appTag].draft, true);
        }
        await f.writeState({ ...(await f.readState()), brokerHides: [] });
      }
    }
    if (reusedRuntime) {
      const missingHead = armRuntime.url;
      await f.writeState({ ...(await f.readState()), missingHead });
      await assert.rejects(f.invoke('draft-all'), /runtime archive is unavailable/);
      assert.equal((await f.readState()).releases[f.appTag].draft, true);
      await f.writeState({ ...(await f.readState()), missingHead: undefined });
    }
    if (isPublic && !reusedRuntime) {
      const staleName = 'stale-unverified-runtime.tar.gz';
      const staleBytes = Buffer.from('Old draft asset');
      const state = await f.readState();
      const publishCount = state.calls.filter((call) => call.includes('--draft=false')).length;
      state.assetIds = (state.assetIds || 0) + 1;
      state.releases[f.appTag].assets.push({
        id: state.assetIds,
        name: staleName,
        size: staleBytes.length,
        digest: `sha256:${f.digest(staleBytes)}`,
        state: 'uploaded',
      });
      state.contents[`${f.appTag}/${staleName}`] = staleBytes.toString('base64');
      await f.writeState(state);
      await assert.rejects(f.invoke('draft-all'), /outside the checked build/);
      const rejected = await f.readState();
      assert.equal(rejected.releases[f.appTag].draft, true);
      assert.equal(
        rejected.calls.filter((call) => call.includes('--draft=false')).length,
        publishCount,
      );
      rejected.releases[f.appTag].assets = rejected.releases[f.appTag].assets.filter(
        (asset) => asset.name !== staleName,
      );
      delete rejected.contents[`${f.appTag}/${staleName}`];
      await f.writeState(rejected);
    }
    if (!isPublic) {
      for (const [transition, published] of [
        ['publicOnUpload', 0],
        ['publicOnPublish', 1],
      ]) {
        const state = await f.readState();
        const publishCount = state.calls.filter((call) => call.includes('--draft=false')).length;
        await f.writeState({ ...state, [transition]: true });
        await assert.rejects(f.invoke('draft-all'), /does not match repository visibility/);
        const rejected = await f.readState();
        assert.equal(rejected.releases[f.appTag].draft, true);
        assert.equal(rejected.private, false);
        assert.equal(
          rejected.calls.filter((call) => call.includes('--draft=false')).length,
          publishCount + published,
        );
        await f.writeState({ ...rejected, private: true, [transition]: false });
      }
    }
    await f.invoke('draft-all');
    const completed = await f.readState();
    assert.equal(completed.created, 1);
    assert.equal(completed.releases[f.appTag].draft, false);
    assert.equal(completed.releases[f.appTag].prerelease, false);
    assert.deepEqual(
      completed.calls.filter((call) => call.includes('--draft=false')).map((call) => call[2]),
      Array(isPublic ? 2 : 4).fill(f.appTag),
    );
    for (const name of [
      'nod-arm64.dmg',
      'nod-x64.dmg',
      'nod-Setup-x64.exe',
      ...(!reusedRuntime ? [runtime.archive.file, f.release.archive.file] : []),
      win.runtime.file,
      windowsManifest,
      'nod-install.sh',
      'nod-install.ps1',
    ])
      assert(completed.releases[f.appTag].assets.some((asset) => asset.name === name));
    if (isPublic && !updateSourceUrl) {
      assert(
        completed.calls.some(
          (call) =>
            call[0] === 'fetch' &&
            call[1] === 'GET' &&
            call[2].includes('/releases/latest/download/release.json'),
        ),
      );
      assert(
        !completed.calls.some(
          (call) => call[0] === 'fetch' && call[2].startsWith('https://api.github.com/'),
        ),
      );
      assert(
        completed.calls.every(
          (call) =>
            call[0] !== 'fetch' ||
            !call[2].startsWith('https://github.com/synthetic/nod/') ||
            call[3] === false,
        ),
      );
      const checkedAssets = completed.calls
        .filter((call) => call[0] === 'fetch' && call[1] === 'HEAD' && call[3] === false)
        .map((call) => call[2].split('/').at(-1));
      const expectedChecked = new Set(
        completed.releases[f.appTag].assets.map((asset) => asset.name),
      );
      if (reusedRuntime) {
        expectedChecked.add(armRuntime.archive.file);
        expectedChecked.add(runtime.archive.file);
      }
      assert.deepEqual(new Set(checkedAssets), expectedChecked);
    }
  }
});

test('a reused Windows runtime must match its published manifest and asset digest', async (t) => {
  const f = await releaseFixture(t);
  const fingerprint = f.digest('Synthetic Windows runtime inputs');
  const name = `runtime-win32-x64-${fingerprint}.json`;
  const pack = Buffer.from('Synthetic Windows runtime');
  const manifest = {
    version: 1,
    platform: 'win32-x64',
    images: [{ name: 'browser', id: `sha256:${f.digest('browser')}` }],
    guest: { file: 'guest.tar.gz', bytes: pack.length, expandedBytes: 99, sha256: f.digest(pack) },
    fingerprint,
  };
  const publish = async (
    bytes,
    draft = false,
    asset = { digest: f.digest(pack), size: pack.length },
  ) => {
    const state = await f.readState();
    state.releases['nod-v0.0.9'] = {
      id: 90,
      tag_name: 'nod-v0.0.9',
      draft,
      assets: [
        { name, size: 1, digest: `sha256:${f.digest(JSON.stringify(manifest))}` },
        {
          name: 'nod-Runtime-win32-x64.tar.gz',
          size: asset.size,
          digest: `sha256:${asset.digest}`,
        },
      ],
    };
    state.contents[`nod-v0.0.9/${name}`] = Buffer.from(JSON.stringify(manifest)).toString('base64');
    state.contents['nod-v0.0.9/nod-Runtime-win32-x64.tar.gz'] = bytes.toString('base64');
    await f.writeState(state);
  };
  const reuse = () =>
    f.invoke('reuse-windows-runtime', false, {
      NOD_WINDOWS_RUNTIME_TAG: 'nod-v0.0.9',
      NOD_WINDOWS_RUNTIME_FINGERPRINT: fingerprint,
    });
  const assets = join(f.root, '.local/windows-runtime-assets');
  await publish(Buffer.from('Tampered Windows runtime!'));
  await assert.rejects(reuse(), /Windows runtime does not match/);
  await assert.rejects(stat(join(assets, 'guest.tar.gz')));
  for (const asset of [
    { digest: f.digest('Another Windows runtime'), size: pack.length },
    { digest: f.digest(pack), size: pack.length + 1 },
  ]) {
    await publish(pack, false, asset);
    await assert.rejects(reuse(), /Windows runtime does not match/);
    await assert.rejects(stat(join(assets, 'guest.tar.gz')));
  }
  await publish(pack, true);
  await assert.rejects(reuse(), /reused Windows runtime is unavailable/);
  await publish(pack);
  await reuse();
  assert.deepEqual(await readFile(join(assets, 'guest.tar.gz')), pack);
  const saved = { ...manifest };
  delete saved.fingerprint;
  assert.deepEqual(JSON.parse(await readFile(join(assets, 'manifest.json'), 'utf8')), saved);
});

test('bundle copy includes explicit release assets under .local while excluding private descendants', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nod-bundle-copy-'));
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

test('engine source imports only production dependencies outside the development server', async () => {
  const { builtinModules } = await import('node:module');
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const manifest = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
  const allowed = new Set([...Object.keys(manifest.dependencies), ...builtinModules]);
  const files = [
    join(repository, 'desktop/main/engine.mjs'),
    join(repository, 'desktop/main/onepassword.mjs'),
  ];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (path !== join(repository, 'src/web')) await walk(path);
      } else if (/\.(?:ts|tsx|mjs)$/.test(entry.name)) files.push(path);
    }
  };
  await walk(join(repository, 'src'));
  await walk(join(repository, 'desktop/runtime'));
  const imported = new Set();
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const [, specifier] of source.matchAll(
      /(?:^|\n)\s*(?:import(?!\s+type\b)[^'"]*?from\s*|export[^'"]*?from\s*|import\s*\(\s*|import\s+)['"]([^'"./][^'"]*)['"]/g,
    ))
      if (!specifier.startsWith('node:')) imported.add(specifier.match(/^(?:@[^/]+\/)?[^/]+/)[0]);
  }
  imported.delete('vite');
  assert.deepEqual([...imported].filter((name) => !allowed.has(name)).sort(), []);
});

test('packaged engine loads dynamic dependencies and binary links outside the checkout and excludes other platforms', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nod-packaged-dependencies-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'checkout');
  const target = join(root, 'application');
  const dependency = join(source, 'node_modules', 'synthetic-extension');
  await mkdir(join(dependency, 'assets'), { recursive: true });
  await mkdir(join(source, 'node_modules', '.bin'));
  await mkdir(join(source, 'node_modules', '.vite'));
  await writeFile(join(source, 'node_modules', '.vite', 'build.mjs'), 'Synthetic build cache');
  await writeFile(join(source, 'node_modules', '.modules.yaml'), 'Synthetic package metadata');
  await writeFile(
    join(dependency, 'package.json'),
    JSON.stringify({ name: 'synthetic-extension', type: 'module', exports: './index.mjs' }),
  );
  await writeFile(join(dependency, 'assets', 'value.json'), '{"value":42}');
  await mkdir(join(dependency, 'dist', 'doc'), { recursive: true });
  await writeFile(
    join(dependency, 'dist', 'doc', 'runtime.mjs'),
    'import { readFileSync } from "node:fs"; export default JSON.parse(readFileSync(new URL("../../assets/value.json", import.meta.url))).value;',
  );
  await writeFile(
    join(dependency, 'index.mjs'),
    'export { default } from "./dist/doc/runtime.mjs";',
  );
  await writeFile(
    join(dependency, 'cli.mjs'),
    'import value from "./index.mjs"; console.log(value);',
  );
  for (const file of [
    'index.d.ts',
    'index.d.mts',
    'index.d.cts',
    'index.js.map',
    'src/index.ts',
    'test/index.test.mjs',
    'docs/index.md',
    'examples/demo.mjs',
    'scripts/build.mjs',
    'tsconfig.json',
  ]) {
    await mkdir(dirname(join(dependency, file)), { recursive: true });
    await writeFile(join(dependency, file), 'Synthetic build file');
  }
  await writeFile(join(dependency, 'LICENSE'), 'Synthetic license');
  await symlink('../synthetic-extension/cli.mjs', join(source, 'node_modules', '.bin', 'probe'));
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({
      dependencies: {
        'synthetic-extension': '1.0.0',
        'synthetic-linux': '1.0.0',
        '@synthetic/intel': '1.0.0',
        'onnxruntime-node': '1.0.0',
      },
      devDependencies: { 'synthetic-tool': '1.0.0' },
    }),
  );
  await writeFile(
    join(dependency, 'package.json'),
    JSON.stringify({
      name: 'synthetic-extension',
      type: 'module',
      exports: './index.mjs',
      dependencies: { 'synthetic-helper': '2.0.0' },
    }),
  );
  for (const [directory, version] of [
    [join(source, 'node_modules', 'synthetic-helper'), '1.0.0'],
    [join(dependency, 'node_modules', 'synthetic-helper'), '2.0.0'],
    [join(source, 'node_modules', 'synthetic-tool'), '1.0.0'],
  ]) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ version }));
  }
  await symlink('../synthetic-tool/package.json', join(source, 'node_modules', '.bin', 'tool'));
  for (const name of ['synthetic-linux', '@synthetic/intel']) {
    const directory = join(source, 'node_modules', name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name, os: name.includes('linux') ? ['linux'] : ['darwin'], cpu: ['x64'] }),
    );
  }
  const inference = join(source, 'node_modules', 'onnxruntime-node');
  await mkdir(inference, { recursive: true });
  await writeFile(join(inference, 'package.json'), JSON.stringify({ name: 'onnxruntime-node' }));
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const arch of ['arm64', 'x64']) {
      const directory = join(inference, 'bin', 'napi-v3', platform, arch);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'onnxruntime_binding.node'), 'synthetic native binary');
    }
  }
  await copyEngineDependencies({ root: source, target });
  for (const path of [
    'synthetic-linux',
    '@synthetic/intel',
    'synthetic-tool',
    'synthetic-helper',
    '.bin/tool',
    '.vite',
    '.modules.yaml',
    'onnxruntime-node/bin/napi-v3/linux',
    'onnxruntime-node/bin/napi-v3/win32',
    'onnxruntime-node/bin/napi-v3/darwin/x64',
    ...[
      'index.d.ts',
      'index.d.mts',
      'index.d.cts',
      'index.js.map',
      'src/index.ts',
      'test',
      'docs',
      'examples',
      'scripts',
      'tsconfig.json',
    ].map((file) => `synthetic-extension/${file}`),
  ])
    await assert.rejects(stat(join(target, 'node_modules', path)), { code: 'ENOENT' });
  assert.equal(
    await readFile(join(target, 'node_modules/synthetic-extension/LICENSE'), 'utf8'),
    'Synthetic license',
  );
  assert.equal(
    await readFile(
      join(
        target,
        'node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64/onnxruntime_binding.node',
      ),
      'utf8',
    ),
    'synthetic native binary',
  );
  const windowsTarget = join(root, 'windows-application');
  await copyEngineDependencies({
    root: source,
    target: windowsTarget,
    platform: 'win32',
    arch: 'x64',
  });
  assert.ok(
    (
      await stat(
        join(
          windowsTarget,
          'node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node',
        ),
      )
    ).isFile(),
  );
  await assert.rejects(
    stat(join(windowsTarget, 'node_modules/onnxruntime-node/bin/napi-v3/darwin')),
    { code: 'ENOENT' },
  );
  assert.equal(
    JSON.parse(
      await readFile(
        join(target, 'node_modules/synthetic-extension/node_modules/synthetic-helper/package.json'),
        'utf8',
      ),
    ).version,
    '2.0.0',
  );
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
  const root = await mkdtemp(join(tmpdir(), 'nod-runtime-assets-'));
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

test('runtime extraction rejects traversal, symlinks and oversized content without changing files outside its staging directory', async (t) => {
  const options = await fixture(t, async ({ root }) => {
    await writeFile(join(root, 'outside.txt'), 'unchanged');
    return ['../outside.txt'];
  });
  await assert.rejects(installRuntimeArchive(options));
  assert.equal(await readFile(join(options.root, 'outside.txt'), 'utf8'), 'unchanged');
  assert.equal(await findRuntimeAssets(options), undefined);
  await assert.rejects(stat(join(options.cacheRoot, options.release.id, '.ready.json')), {
    code: 'ENOENT',
  });
  await assert.rejects(stat(join(options.cacheRoot, options.release.id, 'outside.txt')), {
    code: 'ENOENT',
  });
  for (const extra of [
    async ({ source }) => {
      await symlink('/tmp/nod-outside-fixture', join(source, 'unexpected'));
      return ['unexpected'];
    },
    async ({ source }) => {
      await writeFile(join(source, 'oversized'), Buffer.alloc(2 * 1024 * 1024));
      return ['oversized'];
    },
  ]) {
    const rejected = await fixture(t, extra);
    await assert.rejects(installRuntimeArchive(rejected));
    assert.equal(await findRuntimeAssets(rejected), undefined);
    await assert.rejects(stat(join(rejected.cacheRoot, rejected.release.id, '.ready.json')), {
      code: 'ENOENT',
    });
    for (const name of ['unexpected', 'oversized'])
      await assert.rejects(stat(join(rejected.cacheRoot, rejected.release.id, name)), {
        code: 'ENOENT',
      });
  }
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
  assert.equal(await findRuntimeAssets(options), installed);
  const offline = async () => {
    throw new Error('A verified cache must not access the network.');
  };
  assert.equal(
    await ensureRuntimeAssets({ ...options, resolveDownloadUrl: offline, fetch: offline }),
    installed,
  );
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
  assert.deepEqual(
    (await readdir(options.cacheRoot)).sort(),
    [options.release.id, 'previous-runtime'].sort(),
  );
  assert.equal(await findRuntimeAssets(options), undefined);
  assert.equal(await readFile(join(saved, 'saved'), 'utf8'), 'preserved');
  assert.equal(await assetHash(options.archivePath), archiveHash);
  const installed = await installRuntimeArchive({
    ...options,
    inspectDisk: async () => ({ bavail: 1024n ** 3n, bsize: 4096n }),
  });
  assert.equal(await findRuntimeAssets(options), installed);
  assert.equal(await readFile(join(saved, 'saved'), 'utf8'), 'preserved');
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
  await assert.rejects(ensureRuntimeAssets(options));
  assert.equal(request.mock.callCount(), 1);
  assert.deepEqual(await readdir(options.cacheRoot), [options.release.id]);
  for (const file of options.release.files)
    await assert.rejects(stat(join(options.cacheRoot, options.release.id, file.path)), {
      code: 'ENOENT',
    });
});

test('runtime files become ready only after their own bytes verify, and a mismatched file never does', async (t) => {
  const options = await fixture(t);
  const bytes = await readFile(options.archivePath);
  const assets = await openRuntimeAssets({
    ...options,
    downloadUrl: 'https://runtime.example.invalid/fixture.tar.gz',
    fetch: async () => new Response(bytes),
  });
  for (const file of options.release.files) {
    await assets.ready(file.path);
    assert.equal(await assetHash(join(assets.root, file.path)), file.sha256);
  }
  assert.equal(await assets.done, assets.root);
  const tampered = await fixture(t);
  tampered.release.files[1].sha256 = 'f'.repeat(64);
  tampered.release.id = createHash('sha256')
    .update(JSON.stringify(tampered.release.files))
    .digest('hex');
  const rejected = await openRuntimeAssets({
    ...tampered,
    downloadUrl: 'https://runtime.example.invalid/fixture.tar.gz',
    fetch: async () => new Response(await readFile(tampered.archivePath)),
  });
  await assert.rejects(rejected.ready(tampered.release.files[1].path), (error) => {
    assert.match(error.cause.message, /SHA-256/);
    assert.ok(error.cause.message.includes(tampered.release.files[1].path));
    return true;
  });
  await assert.rejects(rejected.done);
  assert.equal(await findRuntimeAssets(tampered), undefined);
  await assert.rejects(stat(join(rejected.root, tampered.release.files[1].path)), {
    code: 'ENOENT',
  });
  await assert.rejects(stat(join(rejected.root, '.ready.json')), { code: 'ENOENT' });
});

test('runtime download keeps a slow connection going and resumes its saved bytes after data stops arriving', async (t) => {
  const slowly = (bytes, init) => {
    const size = Math.ceil(bytes.length / 10);
    let sent = 0;
    return new Response(
      new ReadableStream({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 120));
          if (sent >= bytes.length) return controller.close();
          controller.enqueue(bytes.subarray(sent, sent + size));
          sent += size;
        },
      }),
      init,
    );
  };
  const options = await fixture(t);
  const bytes = await readFile(options.archivePath);
  const slow = await openRuntimeAssets({
    ...options,
    stallTimeout: 300,
    downloadUrl: 'https://runtime.example.invalid/fixture.tar.gz',
    fetch: async () => slowly(bytes),
  });
  assert.equal(await slow.done, slow.root);
  for (const server of ['resumes', 'ignores', 'refuses']) {
    const stalled = await fixture(t);
    const archive = await readFile(stalled.archivePath);
    const half = Math.floor(archive.length / 2);
    const downloadUrl = 'https://runtime.example.invalid/fixture.tar.gz';
    const stuck = await openRuntimeAssets({
      ...stalled,
      stallTimeout: 300,
      downloadUrl,
      fetch: async (url, { signal }) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(archive.subarray(0, half));
              signal.addEventListener('abort', () => controller.error(signal.reason));
            },
          }),
        ),
    });
    await assert.rejects(stuck.done, /stopped receiving data/);
    const partial = `${stalled.release.id}.${stalled.release.archive.sha256.slice(0, 12)}.download`;
    const saved = await readdir(stalled.cacheRoot);
    assert.ok(saved.includes(partial));
    assert.ok(saved.every((name) => [partial, stalled.release.id].includes(name)));
    assert.equal(await findRuntimeAssets(stalled), undefined);
    const ranges = [];
    const resumed = await openRuntimeAssets({
      ...stalled,
      stallTimeout: 300,
      downloadUrl,
      fetch: async (url, { headers }) => {
        ranges.push(headers.range);
        if (server === 'resumes')
          return slowly(archive.subarray(half), {
            status: 206,
            headers: { 'content-range': `bytes ${half}-${archive.length - 1}/${archive.length}` },
          });
        if (server === 'refuses' && headers.range) return new Response(null, { status: 416 });
        return slowly(archive);
      },
    });
    assert.equal(await resumed.done, resumed.root);
    assert.deepEqual(
      ranges,
      server === 'refuses' ? [`bytes=${half}-`, undefined] : [`bytes=${half}-`],
    );
    assert.deepEqual(await readdir(stalled.cacheRoot), [stalled.release.id]);
  }
});

test('a complete saved runtime installs offline after a late connection failure or cancellation', async (t) => {
  for (const interruption of ['connection', 'cancelled']) {
    for (const retry of ['known-url', 'resolver']) {
      await t.test(`${interruption}: ${retry}`, async (t) => {
        const options = await fixture(t);
        const bytes = await readFile(options.archivePath);
        const controller = new AbortController();
        let connection;
        let requests = 0;
        const download = await openRuntimeAssets({
          ...options,
          signal: controller.signal,
          downloadUrl: 'https://runtime.example.invalid/fixture.tar.gz',
          fetch: async (url, { signal }) => {
            requests++;
            return new Response(
              new ReadableStream({
                start(stream) {
                  connection = stream;
                  stream.enqueue(bytes);
                  signal.addEventListener('abort', () => stream.error(signal.reason), {
                    once: true,
                  });
                },
              }),
            );
          },
        });
        await Promise.all(options.release.files.map((file) => download.ready(file.path)));
        const failure = new Error('Synthetic late connection failure');
        if (interruption === 'connection') connection.error(failure);
        else controller.abort(failure);
        await assert.rejects(download.done);
        const partial = join(
          options.cacheRoot,
          `${options.release.id}.${options.release.archive.sha256.slice(0, 12)}.download`,
        );
        assert.equal((await stat(partial)).size, options.release.archive.bytes);
        assert.equal(await assetHash(partial), options.release.archive.sha256);
        assert.equal(requests, 1);
        let resolutions = 0;
        const installed = await ensureRuntimeAssets({
          ...options,
          ...(retry === 'known-url'
            ? { downloadUrl: 'https://runtime.example.invalid/fixture.tar.gz' }
            : {}),
          resolveDownloadUrl: async () => {
            resolutions++;
            throw new Error('Synthetic offline release lookup');
          },
          fetch: async () => {
            requests++;
            throw new Error('Synthetic offline download');
          },
        });
        assert.equal(requests, 1);
        assert.equal(resolutions, 0);
        assert.equal(await findRuntimeAssets(options), installed);
        for (const file of options.release.files)
          assert.equal(await assetHash(join(installed, file.path)), file.sha256);
        await assert.rejects(stat(partial), { code: 'ENOENT' });
      });
    }
  }
});

test('a corrupt complete saved runtime is refused before network work and keeps other caches', async (t) => {
  for (const corruption of ['hash', 'size']) {
    const options = await fixture(t);
    const bytes = await readFile(options.archivePath);
    const bad =
      corruption === 'size' ? Buffer.concat([bytes, Buffer.from('extra')]) : Buffer.from(bytes);
    if (corruption === 'hash') bad[30] ^= 1;
    const partial = join(
      options.cacheRoot,
      `${options.release.id}.${options.release.archive.sha256.slice(0, 12)}.download`,
    );
    const kept = join(options.cacheRoot, 'previous-runtime');
    await mkdir(kept, { recursive: true });
    await writeFile(join(kept, 'saved'), 'Synthetic previous runtime');
    await writeFile(partial, bad);
    let requests = 0;
    await assert.rejects(
      ensureRuntimeAssets({
        ...options,
        resolveDownloadUrl: async () => {
          requests++;
          throw new Error('The saved bytes must be checked before a lookup.');
        },
        fetch: async () => {
          requests++;
          throw new Error('The saved bytes must be checked before a download.');
        },
      }),
      /integrity check/,
    );
    assert.equal(requests, 0);
    await assert.rejects(stat(partial), { code: 'ENOENT' });
    assert.equal(await findRuntimeAssets(options), undefined);
    assert.equal(await readFile(join(kept, 'saved'), 'utf8'), 'Synthetic previous runtime');
  }
});

test('a verified saved archive survives a storage error or cancellation until an explicit retry', async (t) => {
  for (const interruption of ['storage', 'cancelled']) {
    const options = await fixture(t);
    const partial = join(
      options.cacheRoot,
      `${options.release.id}.${options.release.archive.sha256.slice(0, 12)}.download`,
    );
    await mkdir(options.cacheRoot);
    await copyFile(options.archivePath, partial);
    const controller = new AbortController();
    const failure = new Error('Synthetic saved archive cancellation');
    const offline = async () => assert.fail('A complete saved archive must not use the network.');
    await assert.rejects(
      ensureRuntimeAssets({
        ...options,
        signal: controller.signal,
        resolveDownloadUrl: offline,
        fetch: offline,
        ...(interruption === 'storage'
          ? { inspectDisk: async () => ({ bavail: 0n, bsize: 4096n }) }
          : { onStatus: (value) => value.phase === 'installing' && controller.abort(failure) }),
      }),
      interruption === 'storage' ? { code: 'RUNTIME_DISK_SPACE' } : (error) => error === failure,
    );
    assert.equal(await assetHash(partial), options.release.archive.sha256);
    assert.equal(await findRuntimeAssets(options), undefined);
    const installed = await ensureRuntimeAssets({
      ...options,
      resolveDownloadUrl: offline,
      fetch: offline,
    });
    assert.equal(await findRuntimeAssets(options), installed);
    await assert.rejects(stat(partial), { code: 'ENOENT' });
  }
});

test('a saved archive still needs every file hash to pass before the runtime is ready', async (t) => {
  const options = await fixture(t);
  options.release.files[1].sha256 = 'f'.repeat(64);
  options.release.id = createHash('sha256')
    .update(JSON.stringify(options.release.files))
    .digest('hex');
  const partial = join(
    options.cacheRoot,
    `${options.release.id}.${options.release.archive.sha256.slice(0, 12)}.download`,
  );
  await mkdir(options.cacheRoot);
  await copyFile(options.archivePath, partial);
  const offline = () => assert.fail('File verification must use the saved archive.');
  const assets = await openRuntimeAssets({
    ...options,
    resolveDownloadUrl: offline,
    fetch: offline,
  });
  await assert.rejects(assets.ready(options.release.files[1].path));
  await assert.rejects(assets.done);
  assert.equal(await findRuntimeAssets(options), undefined);
  await assert.rejects(stat(join(assets.root, '.ready.json')), { code: 'ENOENT' });
  await assert.rejects(stat(join(assets.root, options.release.files[1].path)), { code: 'ENOENT' });
});

test('a short saved download survives an offline lookup and resumes only on an explicit retry', async (t) => {
  const options = await fixture(t);
  const bytes = await readFile(options.archivePath);
  const half = Math.floor(bytes.length / 2);
  const partial = join(
    options.cacheRoot,
    `${options.release.id}.${options.release.archive.sha256.slice(0, 12)}.download`,
  );
  await mkdir(options.cacheRoot);
  await writeFile(partial, bytes.subarray(0, half));
  let resolutions = 0;
  let requests = 0;
  await assert.rejects(
    ensureRuntimeAssets({
      ...options,
      resolveDownloadUrl: async () => {
        resolutions++;
        throw new Error('Synthetic offline lookup');
      },
      fetch: async () => {
        requests++;
        assert.fail('A failed lookup must not start a download.');
      },
    }),
    /Synthetic offline lookup/,
  );
  assert.deepEqual(await readFile(partial), bytes.subarray(0, half));
  assert.equal(resolutions, 1);
  assert.equal(requests, 0);
  const installed = await ensureRuntimeAssets({
    ...options,
    resolveDownloadUrl: async () => {
      resolutions++;
      return 'https://runtime.example.invalid/fixture.tar.gz';
    },
    fetch: async (url, { headers }) => {
      requests++;
      assert.equal(headers.range, `bytes=${half}-`);
      return new Response(bytes.subarray(half), {
        status: 206,
        headers: { 'content-range': `bytes ${half}-${bytes.length - 1}/${bytes.length}` },
      });
    },
  });
  assert.equal(resolutions, 2);
  assert.equal(requests, 1);
  assert.equal(await findRuntimeAssets(options), installed);
});

test('a complete saved archive must be a regular file before offline recovery can use it', async (t) => {
  for (const kind of ['link', 'directory']) {
    const options = await fixture(t);
    const partial = join(
      options.cacheRoot,
      `${options.release.id}.${options.release.archive.sha256.slice(0, 12)}.download`,
    );
    await mkdir(options.cacheRoot);
    if (kind === 'link') await symlink(options.archivePath, partial, 'file');
    else await mkdir(partial);
    const inode = (await stat(options.archivePath)).ino;
    let lookups = 0;
    await assert.rejects(
      ensureRuntimeAssets({
        ...options,
        resolveDownloadUrl: async () => {
          lookups++;
          throw new Error('Synthetic offline lookup');
        },
        fetch: () => assert.fail('An unavailable lookup must not start a request.'),
      }),
      /Synthetic offline lookup/,
    );
    assert.equal(lookups, 1);
    const metadata = await lstat(partial);
    assert.equal(kind === 'link' ? metadata.isSymbolicLink() : metadata.isDirectory(), true);
    assert.equal((await stat(options.archivePath)).ino, inode);
    assert.equal(await assetHash(options.archivePath), options.release.archive.sha256);
    assert.equal(await findRuntimeAssets(options), undefined);
  }
});

test('concurrent offline retries do not open a saved archive after another caller consumes it', async (t) => {
  const options = await fixture(t);
  const partial = join(
    options.cacheRoot,
    `${options.release.id}.${options.release.archive.sha256.slice(0, 12)}.download`,
  );
  await mkdir(options.cacheRoot);
  await copyFile(options.archivePath, partial);
  const offline = () => assert.fail('A complete saved archive must not use the network.');
  const filesystem = createRequire(import.meta.url)('node:fs');
  const original = filesystem.createReadStream;
  const gate = Promise.withResolvers();
  const caller = new AsyncLocalStorage();
  const readers = new Set();
  let held = false;
  const read = t.mock.method(filesystem, 'createReadStream', (path, settings) => {
    if (path === partial && !readers.has(caller.getStore())) {
      readers.add(caller.getStore());
      if (readers.size === 2) {
        held = true;
        return Readable.from(
          (async function* () {
            await gate.promise;
            yield* original(path, settings);
          })(),
          { objectMode: false },
        );
      }
    }
    return original(path, settings);
  });
  syncBuiltinESMExports();
  try {
    const install = (id) =>
      caller
        .run(id, () =>
          ensureRuntimeAssets({ ...options, resolveDownloadUrl: offline, fetch: offline }),
        )
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
    const first = install('first');
    const second = install('second');
    await Promise.race([first, second]);
    gate.resolve();
    const results = await Promise.all([first, second]);
    for (const result of results) assert.ifError(result.error);
    const installed = results[0].value;
    assert.equal(results[1].value, installed);
    assert.equal(readers.size, 1);
    assert.equal(held, false);
    assert.equal(await findRuntimeAssets(options), installed);
    assert.deepEqual(await readdir(options.cacheRoot), [options.release.id]);
    for (const file of options.release.files)
      assert.equal(await assetHash(join(installed, file.path)), file.sha256);
  } finally {
    gate.resolve();
    read.mock.restore();
    syncBuiltinESMExports();
  }
});

test('an offline retry uses the installed cache if another caller already consumed the saved archive', async (t) => {
  const options = await fixture(t);
  const partial = join(
    options.cacheRoot,
    `${options.release.id}.${options.release.archive.sha256.slice(0, 12)}.download`,
  );
  await mkdir(options.cacheRoot);
  await copyFile(options.archivePath, partial);
  const filesystem = createRequire(import.meta.url)('node:fs/promises');
  const original = filesystem.lstat;
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const caller = new AsyncLocalStorage();
  const inspect = t.mock.method(filesystem, 'lstat', async (path, settings) => {
    if (path === partial && caller.getStore() === 'waiting') {
      entered.resolve();
      await gate.promise;
    }
    return original(path, settings);
  });
  syncBuiltinESMExports();
  try {
    const offline = () => assert.fail('A completed concurrent install must not use the network.');
    const install = () =>
      ensureRuntimeAssets({ ...options, resolveDownloadUrl: offline, fetch: offline });
    const waiting = caller.run('waiting', install).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await entered.promise;
    const installed = await caller.run('winner', install);
    gate.resolve();
    const result = await waiting;
    assert.ifError(result.error);
    assert.equal(result.value, installed);
    assert.equal(await findRuntimeAssets(options), installed);
    assert.deepEqual(await readdir(options.cacheRoot), [options.release.id]);
  } finally {
    gate.resolve();
    inspect.mock.restore();
    syncBuiltinESMExports();
  }
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
  await assert.rejects(ensureRuntimeAssets(options));
  assert.deepEqual(await readdir(options.cacheRoot), [options.release.id]);
  assert.equal(await findRuntimeAssets(options), undefined);
  request.mock.mockImplementation(async () => new Response(bytes));
  const installed = await ensureRuntimeAssets(options);
  assert.equal(await findRuntimeAssets(options), installed);
  assert.deepEqual(await readdir(options.cacheRoot), [options.release.id]);
  for (const mismatch of ['bytes', 'sha256']) {
    const damaged = await fixture(t);
    if (mismatch === 'bytes') damaged.release.archive.bytes++;
    else damaged.release.archive.sha256 = 'f'.repeat(64);
    await assert.rejects(
      ensureRuntimeAssets({
        ...damaged,
        downloadUrl: 'https://runtime.example.invalid/fixture.tar.gz',
        fetch: async () => new Response(await readFile(damaged.archivePath)),
      }),
      (error) => {
        assert.match(error.cause.message, mismatch === 'bytes' ? /size/ : /SHA-256/);
        return true;
      },
    );
    assert.equal(await findRuntimeAssets(damaged), undefined);
    await assert.rejects(stat(join(damaged.cacheRoot, damaged.release.id, '.ready.json')), {
      code: 'ENOENT',
    });
    assert.ok((await readdir(damaged.cacheRoot)).every((name) => name === damaged.release.id));
  }
});

test(
  'workload firewall refresh blocks private TCP traffic without interrupting public connections',
  {
    skip:
      process.env.NOD_TEST_RUNTIME_NETWORK !== '1' ||
      process.platform !== 'linux' ||
      process.getuid?.() !== 0,
  },
  async (t) => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { protectNetworks } = await import('../runtime/guest-config.mjs');
    const root = await mkdtemp(join(tmpdir(), 'nod-firewall-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'firewall'), protectNetworks);
    await writeFile(
      join(root, 'probe.py'),
      String.raw`import json, os, select, socket, subprocess, sys, time
from pathlib import Path
root = Path(sys.argv[1])
def run(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True)
for name, interface, network in [('workload', 'nod-workspace', '172.31.81'), ('target', 'nod-fixture', '10.70.0')]:
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
            'cat > "$NOD_PROBE/transaction"\ntouch "$NOD_PROBE/paused"\nwhile [ ! -f "$NOD_PROBE/released" ]; do sleep 0.01; done\nexec '+executable+' "$@" < "$NOD_PROBE/transaction"\n'
            if name == 'iptables-restore' else
            executable+' "$@"\nresult=$?\nif [ "$1" = -F ] && [ "$2" = NOD-WORKLOADS ]; then\ntouch "$NOD_PROBE/paused"\nwhile [ ! -f "$NOD_PROBE/released" ]; do sleep 0.01; done\nfi\nexit "$result"\n'))
        (wrapper/name).chmod(0o755)
    refresh = subprocess.Popen(['bash', str(root/'firewall')], env={**os.environ, 'PATH':str(wrapper)+':'+os.environ['PATH'], 'NOD_PROBE':str(root)})
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
        'nod-firewall-fixture',
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

async function macRuntimePrepare(home, assets, overrides = {}) {
  const { availablePort, execute, retainStopExecutable, waitFor } =
    await import('../runtime/index.mjs');
  const { guestConfiguration, protectGuest } = await import('../runtime/guest-config.mjs');
  const source = await readFile(new URL('../runtime/index.mjs', import.meta.url), 'utf8');
  return runInNewContext(
    `${source.slice(source.indexOf('async function prepare('), source.indexOf('export async function preloadRuntimeImages('))}; prepare`,
    {
      process: { platform: 'darwin', arch: process.arch },
      resolve,
      join,
      delimiter,
      createHash,
      randomBytes,
      mkdir,
      chmod,
      readFile,
      access,
      writeFile,
      rename,
      homedir: () => home,
      totalmem: () => 6 * 1024 ** 3,
      hostCpus: () => [{}, {}],
      guestConfiguration,
      protectGuest,
      availablePort,
      retainStopExecutable,
      fileHash: assetHash,
      execute,
      waitFor,
      openRuntimeAssets: async () => ({
        root: assets,
        paths: [],
        ready: async () => {},
        done: Promise.resolve(assets),
      }),
      ...overrides,
    },
  );
}

test('Mac startup repairs existing guests before Docker and refuses failed or stopped protection', async (t) => {
  const { protectGuest } = await import('../runtime/guest-config.mjs');
  for (const outcome of ['ready', 'failed', 'aborted']) {
    await t.test(outcome, async () => {
      const root = await mkdtemp(join(tmpdir(), 'nod-guest-start-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const assets = join(root, 'assets');
      const dataRoot = join(root, 'profile');
      const identity = createHash('sha256').update(dataRoot).digest('hex').slice(0, 12);
      const limaHome = join(root, '.nod-desktop', identity);
      await mkdir(join(limaHome, 'nod'), { recursive: true });
      await mkdir(join(assets, 'lima/bin'), { recursive: true });
      await mkdir(join(dataRoot, 'desktop-runtime'), { recursive: true });
      await writeFile(join(assets, 'lima/bin/limactl'), 'Synthetic Lima executable');
      await writeFile(
        join(assets, 'manifest.json'),
        JSON.stringify({
          version: 1,
          platform: `darwin-${process.arch}`,
          guest: { file: 'guest.img', sha256: '1'.repeat(64) },
          dockerGuest: { file: 'docker-guest.tar.gz', sha256: '2'.repeat(64) },
          images: [],
        }),
      );
      await writeFile(
        join(dataRoot, 'desktop-runtime/state.json'),
        JSON.stringify({ version: 1, limaHome, port: 54329, password: '3'.repeat(64) }),
      );
      await writeFile(
        join(limaHome, 'nod/lima.yaml'),
        JSON.stringify({
          mounts: [{ location: assets, mountPoint: '/opt/nod-assets', writable: false }],
        }),
      );
      const signal = new AbortController();
      const calls = [];
      const prepare = await macRuntimePrepare(root, assets, {
        execute: async (command, args, options) => {
          calls.push(args[0]);
          if (args[0] === 'shell') {
            assert.equal(calls.at(-2), 'start');
            assert.deepEqual(Array.from(args), ['shell', 'nod', 'sudo', 'bash', '-s']);
            assert.equal(options.input, protectGuest);
            if (outcome === 'aborted') signal.abort(new Error('Synthetic stop'));
            if (outcome !== 'ready')
              throw Object.assign(new Error('Synthetic protection failure'), {
                details: 'Synthetic parser error',
              });
          }
          return '';
        },
        finishRuntime: async () => calls.push('database'),
      });
      const options = {
        dataRoot,
        resourcesPath: root,
        preserveRuntimeCache: true,
        signal: signal.signal,
      };
      if (outcome === 'ready') {
        await prepare(options, () => calls.push('starting'));
        assert.deepEqual(calls, ['starting', 'start', 'shell', 'info', 'database']);
      } else {
        await assert.rejects(
          prepare(options, () => calls.push('starting')),
          outcome === 'aborted'
            ? /Synthetic stop/
            : { code: 'NOD_COMPUTER_PROTECTION_FAILED', details: 'Synthetic parser error' },
        );
        assert.deepEqual(calls, ['starting', 'start', 'shell']);
      }
    });
  }
});

test('Mac runtime updates stop the old guest before changing its assets mount', async (t) => {
  for (const initial of ['Running', 'Broken', 'Stopped', 'refused', 'stop-error', 'aborted']) {
    await t.test(initial, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'nod-guest-update-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const assets = join(root, 'assets');
      const dataRoot = join(root, 'profile');
      const identity = createHash('sha256').update(dataRoot).digest('hex').slice(0, 12);
      const limaHome = join(root, '.nod-desktop', identity);
      const configuration = join(limaHome, 'nod/lima.yaml');
      const old = {
        mounts: [{ location: join(root, 'old'), mountPoint: '/opt/nod-assets', writable: false }],
      };
      await mkdir(join(limaHome, 'nod'), { recursive: true });
      await mkdir(join(assets, 'lima/bin'), { recursive: true });
      await mkdir(join(dataRoot, 'desktop-runtime'), { recursive: true });
      await writeFile(join(assets, 'lima/bin/limactl'), 'Synthetic Lima executable');
      await writeFile(
        join(assets, 'manifest.json'),
        JSON.stringify({
          version: 1,
          platform: `darwin-${process.arch}`,
          guest: { file: 'guest.img', sha256: '1'.repeat(64) },
          dockerGuest: { file: 'docker-guest.tar.gz', sha256: '2'.repeat(64) },
          images: [],
        }),
      );
      await writeFile(
        join(dataRoot, 'desktop-runtime/state.json'),
        JSON.stringify({
          version: 1,
          limaHome,
          port: 54329,
          password: '3'.repeat(64),
        }),
      );
      await writeFile(configuration, JSON.stringify(old));
      const controller = new AbortController();
      let state = initial;
      const commands = [];
      const prepare = await macRuntimePrepare(root, assets, {
        waitFor: async (operation) => operation(),
        execute: async (_command, args) => {
          commands.push(args[0]);
          if (args[0] === 'list') return state;
          if (args[0] === 'stop') {
            assert.deepEqual(JSON.parse(await readFile(configuration, 'utf8')), old);
            if (initial === 'aborted') controller.abort(new Error('Synthetic update stop'));
            if (initial !== 'refused') state = 'Stopped';
            if (initial === 'stop-error') throw new Error('Synthetic stop failure');
          }
          if (args[0] === 'start') {
            assert.equal(state, 'Stopped');
            assert.equal(
              JSON.parse(await readFile(configuration, 'utf8')).mounts[0].location,
              assets,
            );
          }
          return '';
        },
        finishRuntime: async () => {},
      });
      const options = {
        dataRoot,
        resourcesPath: root,
        preserveRuntimeCache: true,
        signal: controller.signal,
      };
      if (['refused', 'stop-error', 'aborted'].includes(initial)) {
        await assert.rejects(
          prepare(options, () => {}),
          initial === 'aborted' ? /Synthetic update stop/ : /stop/i,
        );
        assert.deepEqual(JSON.parse(await readFile(configuration, 'utf8')), old);
        assert.ok(!commands.includes('start'));
      } else {
        await prepare(options, () => {});
        assert.equal(
          commands.filter((command) => command === 'stop').length,
          initial === 'Stopped' ? 0 : 1,
        );
        assert.ok(commands.includes('start'));
      }
      assert.ok(!commands.includes('delete'));
    });
  }
});

test('Mac image loading keeps verified files through late pack failure and explicit retry', async (t) => {
  for (const outcome of ['connection', 'cancelled', 'checksum']) {
    for (const retry of ['download', 'archive', 'directory']) {
      await t.test(`${outcome}: ${retry}`, async (t) => {
        const options = await fixture(t);
        const file = 'images/workspace.tar.zst';
        const image = {
          name: 'workspace',
          file,
          reference: 'nod-workspace:fixture',
          id: `sha256:${'4'.repeat(64)}`,
          sha256: createHash('sha256').update('Synthetic image').digest('hex'),
        };
        await mkdir(join(options.source, 'images'));
        await writeFile(join(options.source, file), 'Synthetic image');
        await writeFile(
          join(options.source, 'manifest.json'),
          JSON.stringify({
            version: 1,
            platform: `darwin-${process.arch}`,
            guest: { file: 'guest.img', sha256: '1'.repeat(64) },
            dockerGuest: { file: 'docker-guest.tar.gz', sha256: '2'.repeat(64) },
            images: [image],
          }),
        );
        options.release.files.push({ path: file, mode: 0o644 });
        for (const item of options.release.files) {
          item.bytes = (await stat(join(options.source, item.path))).size;
          item.sha256 = await assetHash(join(options.source, item.path));
        }
        options.release.id = createHash('sha256')
          .update(JSON.stringify(options.release.files))
          .digest('hex');
        await create(
          {
            cwd: options.source,
            file: options.archivePath,
            portable: true,
            noMtime: true,
            gzip: true,
          },
          options.release.files.map((item) => item.path),
        );
        options.release.archive = {
          bytes: (await stat(options.archivePath)).size,
          sha256: await assetHash(options.archivePath),
        };
        await writeFile(
          join(options.resourcesPath, 'runtime-release.json'),
          JSON.stringify(options.release),
        );
        let connection;
        const stream = new ReadableStream({ start: (controller) => (connection = controller) });
        const controller = new AbortController();
        let requests = 0;
        const assets = await openRuntimeAssets({
          ...options,
          release:
            outcome === 'checksum'
              ? {
                  ...options.release,
                  archive: { ...options.release.archive, sha256: 'f'.repeat(64) },
                }
              : options.release,
          signal: controller.signal,
          downloadUrl: 'https://runtime.example.invalid/fixture.tar.gz',
          fetch: async (url, { signal }) => {
            requests++;
            signal.addEventListener('abort', () => connection.error(signal.reason), { once: true });
            return new Response(stream);
          },
        });
        connection.enqueue(await readFile(options.archivePath));
        const interruption = new Error('Synthetic connection reset');
        let downloadError;
        let inode;
        let loaded = false;
        const prepare = await macRuntimePrepare(options.root, assets.root, {
          openRuntimeAssets: async () => assets,
          execute: async (command, args) => {
            if (args[0] === 'image') {
              if (loaded) return image.id;
              throw new Error('Synthetic image is not installed.');
            }
            if (args.includes('load')) {
              inode = (await stat(join(assets.root, file))).ino;
              if (outcome === 'connection') connection.error(interruption);
              else if (outcome === 'cancelled') controller.abort(interruption);
              else connection.close();
              await assets.done.catch((error) => (downloadError = error));
              assert.equal(await assetHash(join(assets.root, file)), image.sha256);
              loaded = true;
            }
            return '';
          },
          finishRuntime: async ({ prepareImage, runtimeReady }) => {
            await prepareImage('workspace');
            await runtimeReady;
          },
        });
        await assert.rejects(
          prepare(
            {
              dataRoot: join(options.root, 'profile'),
              resourcesPath: options.root,
              preserveRuntimeCache: true,
            },
            () => {},
          ),
          (error) => {
            assert.equal(error, downloadError);
            return true;
          },
        );
        assert.equal(loaded, true);
        assert.equal(requests, 1);
        assert.equal(await findRuntimeAssets(options), undefined);
        await assert.rejects(stat(join(assets.root, '.ready.json')), { code: 'ENOENT' });
        options.inspectDisk = async () => ({ bavail: 512n * 1024n ** 2n, bsize: 1n });
        if (retry === 'archive') await installRuntimeArchive(options);
        else if (retry === 'directory') await seedRuntimeCache(options);
        else
          await ensureRuntimeAssets({
            ...options,
            downloadUrl: 'https://runtime.example.invalid/fixture.tar.gz',
            fetch: async () => {
              requests++;
              return new Response(await readFile(options.archivePath));
            },
          });
        assert.equal((await stat(join(assets.root, file))).ino, inode);
        assert.equal(await assetHash(join(assets.root, file)), image.sha256);
        assert.equal(await findRuntimeAssets(options), assets.root);
        assert.equal(requests, retry === 'download' && outcome === 'checksum' ? 2 : 1);
      });
    }
  }
});

test(
  'guest repair restores stacked process signals, keeps confinement and preserves PostgreSQL across a restart',
  { skip: process.platform !== 'darwin' || !process.env.NOD_TEST_GUEST_ASSETS },
  async (t) => {
    const { execute } = await import('../runtime/index.mjs');
    const { protectGuest } = await import('../runtime/guest-config.mjs');
    const assets = resolve(process.env.NOD_TEST_GUEST_ASSETS);
    const manifest = JSON.parse(await readFile(join(assets, 'manifest.json'), 'utf8'));
    const root = await realpath(await mkdtemp('/tmp/nod-guest-'));
    const dataRoot = join(root, 'profile');
    const identity = createHash('sha256').update(dataRoot).digest('hex').slice(0, 12);
    const lima = join(assets, 'lima/bin/limactl');
    const env = {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: root,
      LIMA_HOME: join(root, '.nod-desktop', identity),
      LANG: 'en_US.UTF-8',
    };
    const run = (args, extra = {}) => execute(lima, args, { env, ...extra });
    const shell = (input) => run(['shell', 'nod', 'sudo', 'bash', '-s'], { input });
    t.after(async () => {
      await run(['stop', '--force', 'nod']);
      await run(['delete', '--force', 'nod']).finally(() =>
        rm(root, { recursive: true, force: true }),
      );
    });
    const prepare = await macRuntimePrepare(root, assets, {
      finishRuntime: async ({ prepareImage }) => prepareImage('postgres'),
    });
    const options = { dataRoot, resourcesPath: root, preserveRuntimeCache: true };
    await prepare(options, () => {});
    const image = manifest.images.find((image) => image.name === 'postgres');
    assert.match(image.id, /^sha256:[a-f0-9]{64}$/);
    const stack = `aa-exec -p 'docker-default//&unconfined' -- sh -c 'sleep 3 & child=$!; kill -TERM "$child" || exit 1; wait "$child"; test "$?" = 143'`;
    const oldProtection = protectGuest
      .replace('  signal (send,receive) peer="docker-default//&unconfined",\n', '')
      .replace('  ptrace (trace,read,tracedby,readby) peer="docker-default//&unconfined",\n', '');
    await shell(oldProtection);
    await assert.rejects(shell(stack), (error) => /Permission denied/.test(error.details));
    await shell(protectGuest);
    await shell(protectGuest);
    await shell(`set -eu
${stack}
test "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_unconfined)" = 1
test "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = 1
mkdir -p /tmp/nod-mount
mount -t tmpfs tmpfs /tmp/nod-mount
umount /tmp/nod-mount
if aa-exec -p 'docker-default//&unconfined' -- mount -t tmpfs tmpfs /tmp/nod-mount; then
  umount /tmp/nod-mount
  exit 1
fi
`);
    const start = `set -eu
docker=/usr/local/bin/docker
$docker run -d --name nod-database-fixture --network none --env POSTGRES_USER=fixture --env POSTGRES_DB=fixture --env POSTGRES_PASSWORD=synthetic-fixture --volume nod-database-fixture:/var/lib/postgresql/data ${image.id} >/dev/null
for attempt in $(seq 1 100); do
  if $docker exec nod-database-fixture pg_isready -h 127.0.0.1 -U fixture -d fixture >/dev/null; then break; fi
  sleep 0.2
done
$docker exec nod-database-fixture pg_isready -h 127.0.0.1 -U fixture -d fixture
test "$($docker inspect --format '{{.AppArmorProfile}}' nod-database-fixture)" = docker-default
`;
    await shell(`${start}
$docker exec nod-database-fixture psql -U fixture -d fixture -v ON_ERROR_STOP=1 -c "CREATE TABLE kernel_fixture (value text PRIMARY KEY); INSERT INTO kernel_fixture VALUES ('synthetic-kernel-check');"
$docker stop --time 20 nod-database-fixture
$docker rm nod-database-fixture
`);
    await shell(oldProtection);
    const vmConfigPath = join(env.LIMA_HOME, 'nod/lima.yaml');
    const config = JSON.parse(await readFile(vmConfigPath, 'utf8'));
    config.provision[0].script = config.provision[0].script.replace(protectGuest, oldProtection);
    await writeFile(vmConfigPath, JSON.stringify(config));
    await run(['stop', '--tty=false', 'nod'], { timeout: 120_000 });
    await prepare(options, () => {});
    await shell(stack);
    assert.match(
      await shell(`${start}
$docker exec nod-database-fixture psql -U fixture -d fixture -At -v ON_ERROR_STOP=1 -c 'SELECT value FROM kernel_fixture'
$docker stop --time 20 nod-database-fixture
`),
      /synthetic-kernel-check/,
    );
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

test('runtime cache repair refuses symlinks, directories and changed bytes without changing an outside target', async (t) => {
  for (const changed of ['root', 'parent', 'file', 'directory', 'bytes']) {
    await t.test(changed, async (t) => {
      const options = await fixture(t);
      const root = await installRuntimeArchive(options);
      const file = join(root, 'lima/bin/limactl');
      const outside = join(options.root, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'keep'), 'Synthetic outside file');
      const target = join(outside, 'target');
      if (changed === 'root' || changed === 'parent') {
        const path = changed === 'root' ? root : join(root, 'lima');
        await rename(path, target);
        await symlink(target, path, 'dir');
      } else if (changed === 'file') {
        await copyFile(file, target);
        await rm(file);
        await symlink(target, file);
      } else if (changed === 'directory') {
        await rm(file);
        await mkdir(file);
      } else {
        const bytes = await readFile(file);
        bytes[0] ^= 1;
        await writeFile(file, bytes);
      }
      const outsideInode = (await stat(target).catch(() => undefined))?.ino;
      assert.equal(await findRuntimeAssets(options), undefined);
      await installRuntimeArchive(options);
      assert.equal(await findRuntimeAssets(options), root);
      assert.equal(await assetHash(file), options.release.files[1].sha256);
      assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'Synthetic outside file');
      if (outsideInode !== undefined) assert.equal((await stat(target)).ino, outsideInode);
    });
  }
});

test('cancelling cache revalidation keeps files published by an earlier attempt', async (t) => {
  for (const retry of [installRuntimeArchive, seedRuntimeCache]) {
    const options = await fixture(t);
    const root = await installRuntimeArchive(options);
    const file = join(root, 'manifest.json');
    const inode = (await stat(file)).ino;
    await rm(join(root, '.ready.json'));
    const controller = new AbortController();
    const check = controller.signal.throwIfAborted.bind(controller.signal);
    const interruption = new Error('Synthetic cancelled revalidation');
    let checks = 0;
    t.mock.method(controller.signal, 'throwIfAborted', () => {
      if (++checks === 3) controller.abort(interruption);
      check();
    });
    await assert.rejects(
      retry({ ...options, signal: controller.signal }),
      (error) => error === interruption,
    );
    assert.equal((await stat(file)).ino, inode);
    assert.equal(await assetHash(file), options.release.files[0].sha256);
    assert.equal(await findRuntimeAssets(options), undefined);
    await retry(options);
    assert.equal((await stat(file)).ino, inode);
    assert.equal(await findRuntimeAssets(options), root);
  }
});

test('directory installation shares its pending runtime with a concurrent download request', async (t) => {
  const options = await fixture(t);
  let downloading;
  const root = await seedRuntimeCache({
    ...options,
    onStatus: () => {
      downloading = openRuntimeAssets({
        ...options,
        downloadUrl: 'https://runtime.example.invalid/fixture.tar.gz',
        fetch: () => assert.fail('A pending directory install must not start a download.'),
      });
    },
  });
  const assets = await downloading;
  assert.equal(await assets.done, root);
  assert.equal(await findRuntimeAssets(options), root);
});

test('a failed runtime command names its cause from the end of its output, including WSL errors', async () => {
  const { execute } = await import('../runtime/index.mjs');
  await assert.rejects(
    execute(process.execPath, [
      '-e',
      'console.error("started\\n" + "x".repeat(400) + "\\nError response from daemon: Pool overlaps"); process.exit(3)',
    ]),
    (error) => {
      assert.match(
        error.message,
        /^Nod runtime command failed \(3\): …x+ Error response from daemon: Pool overlaps$/,
      );
      assert.equal(
        error.details,
        `started\n${'x'.repeat(400)}\nError response from daemon: Pool overlaps`,
      );
      return true;
    },
  );
  await assert.rejects(
    execute(process.execPath, [
      '-e',
      'process.stdout.write(Buffer.from("Error code: Wsl/Service/CreateInstance/CreateVm/HCS_E_HYPERV_NOT_INSTALLED\\r\\n", "utf16le")); process.exit(1)',
    ]),
    {
      message:
        'Nod runtime command failed (1): Error code: Wsl/Service/CreateInstance/CreateVm/HCS_E_HYPERV_NOT_INSTALLED',
    },
  );
});

test('runtime networks reject isolation drift before any workload can start', async () => {
  const { ensureNetwork } = await import('../runtime/index.mjs');
  const expected = {
    name: 'nod-workspace-synthetic',
    subnet: '172.31.81.0/24',
    bridge: 'nod-workspace',
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
    await assert.rejects(ensureNetwork(async () => JSON.stringify([drifted]), expected));
  }
  await ensureNetwork(async () => JSON.stringify([network]), expected);
});

test('runtime replaces owned containers even with unchanged images and retains their data volumes', async () => {
  const { replaceContainer } = await import('../runtime/index.mjs');
  const name = 'nod-workspace-synthetic';
  const image = `sha256:${'a'.repeat(64)}`;
  const args = [
    '--network',
    'nod-workspace-synthetic',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--volume',
    'nod-workspace-synthetic:/workspace',
  ];
  const current = {
    Image: image,
    Config: { Labels: { 'dev.nod.desktop.experiment': 'true' } },
    Mounts: [{ Type: 'volume', Name: 'nod-workspace-synthetic', Destination: '/workspace' }],
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
  assert.equal(calls.at(-1)[0], 'run');
  assert.ok(calls.at(-1).includes('nod-workspace-synthetic:/workspace'));
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
    );
    assert.ok(!commands.some(([command]) => command === 'stop' || command === 'rm'));
  }
});

test('runtime retries reuse only the same owned PostgreSQL container with unchanged storage, port and security', async () => {
  const { replaceContainer } = await import('../runtime/index.mjs');
  const name = 'nod-postgres-fixture';
  const image = `sha256:${'a'.repeat(64)}`;
  const args = [
    '--network',
    'nod-control-fixture',
    '--publish',
    '127.0.0.1:54329:5432',
    '--volume',
    `${name}:/var/lib/postgresql/data`,
  ];
  const original = {
    Id: 'synthetic-postgres-container',
    Image: image,
    Config: { Labels: { 'dev.nod.desktop.experiment': 'true' }, Env: ['POSTGRES_DB=nod'] },
    Mounts: [{ Type: 'volume', Name: name, Destination: '/var/lib/postgresql/data', RW: true }],
    HostConfig: {
      Privileged: false,
      NetworkMode: 'nod-control-fixture',
      PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '54329' }] },
    },
    NetworkSettings: { Networks: { 'nod-control-fixture': { NetworkID: 'owned-control' } } },
    State: { Running: true },
  };
  const reuse = await replaceContainer(
    async (args) => (args[1] === 'inspect' ? JSON.stringify([original]) : ''),
    name,
    image,
    args,
    { remember: true },
  );
  for (const change of [
    undefined,
    (value) => {
      value.Id = 'replacement';
    },
    (value) => {
      value.Image = `sha256:${'b'.repeat(64)}`;
    },
    (value) => {
      value.State.Running = false;
    },
    (value) => {
      value.HostConfig.Privileged = true;
    },
    (value) => {
      value.HostConfig.PortBindings['5432/tcp'][0].HostIp = '0.0.0.0';
    },
    (value) => {
      value.HostConfig.PortBindings['5432/tcp'][0].HostPort = '54330';
    },
    (value) => {
      value.HostConfig.NetworkMode = 'host';
    },
    (value) => {
      value.Config.Env = ['POSTGRES_DB=foreign'];
    },
    (value) => {
      value.NetworkSettings.Networks['nod-control-fixture'].NetworkID = 'foreign';
    },
  ]) {
    const current = structuredClone(original);
    change?.(current);
    const commands = [];
    await replaceContainer(
      async (args) => {
        commands.push(args);
        return args[1] === 'inspect' ? JSON.stringify([current]) : '';
      },
      name,
      image,
      args,
      { reuse },
    );
    if (!change) assert.deepEqual(commands, [['container', 'inspect', name]]);
    else
      assert.deepEqual(
        commands.filter((args) => ['stop', 'rm', 'run'].includes(args[0])).map((args) => args[0]),
        ['stop', 'rm', 'run'],
      );
  }
  for (const change of [
    (value) => {
      value.Config.Labels = {};
    },
    (value) => {
      value.Mounts[0].Name = 'foreign-data';
    },
  ]) {
    const current = structuredClone(original);
    change(current);
    const commands = [];
    await assert.rejects(
      replaceContainer(
        async (args) => {
          commands.push(args);
          return JSON.stringify([current]);
        },
        name,
        image,
        args,
        { reuse },
      ),
    );
    assert.equal(commands.length, 1);
  }
});

test('native runtime can stop after the streaming runtime pack is removed', async (t) => {
  if (process.platform === 'win32') return t.skip('This fixture uses a Mac shell program.');
  const root = await mkdtemp(join(tmpdir(), 'nod-stop-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, 'profile');
  const controlRoot = join(dataRoot, 'desktop-runtime');
  const assets = join(root, 'partial-runtime');
  const identity = createHash('sha256').update(dataRoot).digest('hex').slice(0, 12);
  const expected = join(root, '.nod-desktop', identity);
  await mkdir(join(expected, 'nod'), { recursive: true });
  await mkdir(controlRoot, { recursive: true });
  await mkdir(assets);
  await writeFile(join(expected, 'nod/lima.yaml'), '{}');
  await writeFile(join(expected, 'status'), 'Running');
  const lima = join(assets, 'limactl');
  await writeFile(
    lima,
    '#!/bin/sh\ncase "$1" in\nstop) printf Stopped > "$LIMA_HOME/status";;\nlist) cat "$LIMA_HOME/status";;\nesac\n',
  );
  const { retainStopExecutable, execute, waitFor } = await import('../runtime/index.mjs');
  const hash = await retainStopExecutable(lima, controlRoot);
  await writeFile(
    join(controlRoot, 'state.json'),
    JSON.stringify({ version: 1, limaHome: expected, stopExecutableSha256: hash }),
  );
  await rm(assets, { recursive: true });
  let lookups = 0;
  const source = await readFile(new URL('../runtime/index.mjs', import.meta.url), 'utf8');
  const stop = runInNewContext(
    `${source.slice(source.indexOf('async function stopComputer('))}; stopComputer`,
    {
      process: { platform: 'darwin' },
      resolve,
      join,
      delimiter,
      homedir: () => root,
      createHash,
      access,
      readFile,
      fileHash: async (path) =>
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      findRuntimeAssets: () => {
        lookups++;
        return undefined;
      },
      execute,
      waitFor,
    },
  );
  await stop({ dataRoot, resourcesPath: root });
  assert.equal(await readFile(join(expected, 'status'), 'utf8'), 'Stopped');
  assert.equal(lookups, 0);
  await writeFile(join(controlRoot, 'limactl-stop'), 'changed binary');
  await assert.rejects(stop({ dataRoot, resourcesPath: root }), (error) => {
    assert.equal(error.code, 'NOD_RUNTIME_STOP_FAILED');
    assert.match(error.cause.message, /could not find/);
    return true;
  });
  assert.equal(lookups, 1);
  await writeFile(
    join(controlRoot, 'state.json'),
    JSON.stringify({ version: 1, limaHome: root, stopExecutableSha256: hash }),
  );
  await assert.rejects(stop({ dataRoot, resourcesPath: root }), (error) => {
    assert.equal(error.code, 'NOD_RUNTIME_STOP_FAILED');
    assert.match(error.cause.message, /identity changed/);
    return true;
  });
});

test('native runtime wrapper preserves handed-off storage through failed preparation and explicit retry until quit', async () => {
  const source = await readFile(new URL('../runtime/index.mjs', import.meta.url), 'utf8');
  const wrapper = source
    .slice(
      source.indexOf('export function prepareRuntime('),
      source.indexOf('async function stopComputer('),
    )
    .replaceAll('export ', '');
  for (const terminal of ['retry', 'quit', 'abort', 'cleanup-failed']) {
    let attempts = 0;
    let stops = 0;
    let engineStops = 0;
    let retired = false;
    const startupError = Object.assign(new Error('Synthetic startup failure'), {
      details: 'Synthetic startup command details',
    });
    const stopError = new Error('Synthetic stop command failure');
    const cleanupError = Object.assign(new Error('Synthetic stop failure', { cause: stopError }), {
      code: 'NOD_RUNTIME_STOP_FAILED',
      details: 'Synthetic stop command details',
    });
    const pending = [];
    let handed;
    const storageHanded = new Promise((accept) => {
      handed = accept;
    });
    const storage = {
      env: {},
      close: () => runtime.stopRuntime({ dataRoot: resolve('synthetic-profile') }),
    };
    const runtime = runInNewContext(`${wrapper}; ({ prepareRuntime, stopRuntime })`, {
      resolve,
      preparing: new Map(),
      storageReady: new Map(),
      prepare: async (options, started) => {
        started();
        attempts++;
        if (terminal === 'cleanup-failed') throw startupError;
        if (retired) throw new Error('Synthetic new attempt before storage');
        if (attempts === 2) throw new Error('Synthetic retry before storage handshake');
        await options.onStorageReady(storage);
        handed();
        if (terminal === 'abort')
          await new Promise((_, reject) =>
            options.signal.addEventListener('abort', () => reject(new Error('Synthetic abort')), {
              once: true,
            }),
          );
        if (attempts === 1) throw new Error('Synthetic workspace startup failure');
        return storage;
      },
      stopComputer: async () => {
        stops++;
        if (terminal === 'cleanup-failed' && stops === 1) throw cleanupError;
      },
    });
    const lifecycle = createDesktopLifecycle({
      prepareRuntime: (options) =>
        runtime.prepareRuntime({ ...options, dataRoot: resolve('synthetic-profile') }),
      validateStart: async () => {},
      startEngine: async ({ pending: waiting }) => pending.push(waiting === true),
      stopEngine: async () => {
        engineStops++;
      },
      stopRuntime: () => runtime.stopRuntime({ dataRoot: resolve('synthetic-profile') }),
      onRuntimeStatus() {},
    });
    if (terminal === 'cleanup-failed') {
      await assert.rejects(lifecycle.start(), (error) => {
        assert.equal(error.code, cleanupError.code);
        assert.equal(error.errors[0], startupError);
        assert.equal(error.errors[1], cleanupError);
        assert.equal(error.cause, cleanupError);
        assert.equal(error.cause.cause, stopError);
        assert.ok(error.details.includes(startupError.details));
        assert.ok(error.details.includes('Synthetic stop command details'));
        return true;
      });
      assert.equal(stops, 1);
      assert.deepEqual(pending, []);
      await lifecycle.close();
      assert.equal(stops, 2);
      assert.equal(engineStops, 1);
      continue;
    }
    if (terminal === 'abort') {
      const starting = assert.rejects(lifecycle.start(), /Synthetic abort/);
      await storageHanded;
      await lifecycle.close();
      await starting;
      assert.equal(engineStops, 1);
      assert.equal(stops, 1);
      continue;
    }
    await assert.rejects(lifecycle.start(), /Synthetic workspace startup failure/);
    assert.equal(stops, 0, `${terminal}: storage must remain usable after workspace failure`);
    assert.deepEqual(pending, [true]);
    if (terminal === 'retry') {
      await assert.rejects(lifecycle.start());
      assert.equal(attempts, 1);
      await assert.rejects(
        lifecycle.start({ retry: true }),
        /Synthetic retry before storage handshake/,
      );
      assert.equal(stops, 0);
      await lifecycle.start({ retry: true });
      assert.equal(attempts, 3);
      assert.deepEqual(pending, [true, true, false]);
    }
    await lifecycle.close();
    assert.equal(engineStops, 1);
    assert.equal(stops, 1, `${terminal}: quit must close retained storage exactly once`);
    retired = true;
    await assert.rejects(
      runtime.prepareRuntime({
        dataRoot: resolve('synthetic-profile'),
        onStorageReady: async () => {},
      }),
      /Synthetic new attempt/,
    );
    assert.equal(stops, 2);
  }
});

test('Windows storage starts on a free port, and a readiness failure names its cause and replaces retained PostgreSQL on that port only on the next explicit retry', async (t) => {
  const source = await readFile(new URL('../runtime/index.mjs', import.meta.url), 'utf8');
  const functions = source
    .slice(
      source.indexOf('export async function finishRuntime('),
      source.indexOf('async function stopComputer('),
    )
    .replaceAll('export ', '')
    .replace("const { default: pg } = await import('pg');", '');
  const { availablePort, replaceContainer } = await import('../runtime/index.mjs');
  const taken = createServer();
  await new Promise((listening) => taken.listen(0, '127.0.0.1', listening));
  t.after(() => taken.close());
  for (const [failure, expectedCode] of [
    ['pg_isready', 'NOD_DATABASE_NOT_READY'],
    ['connect', 'NOD_DATABASE_CONNECTION_FAILED'],
    ['query', 'NOD_DATABASE_CONNECTION_FAILED'],
    ['stopped', 'NOD_DATABASE_STOPPED'],
    ['memory', 'NOD_DATABASE_OUT_OF_MEMORY'],
    ['wsl', 'NOD_DATABASE_NOT_READY'],
  ]) {
    const containers = new Map();
    const commands = [];
    const connections = [];
    let fault = 'workspace';
    let created = 0;
    let stopped = 0;
    const runtime = runInNewContext(
      `${functions}; ({ finishRuntime, prepareRuntime, stopRuntime })`,
      {
        resolve,
        join,
        process: { platform: 'win32' },
        preparing: new Map(),
        storageReady: new Map(),
        replaceContainer,
        availablePort,
        ensureNetwork: async () => {},
        protectNetworks: '',
        waitFor: async (operation) => operation(),
        removeStaleImages: async () => {},
        pg: {
          Client: class {
            constructor({ connectionString }) {
              connections.push(new URL(connectionString).port);
            }
            async connect() {
              if (['connect', 'stopped', 'memory', 'wsl'].includes(fault))
                throw Object.assign(
                  new Error(`Synthetic ${fault} failure: synthetic-fixture-password`),
                  { code: 'ECONNRESET' },
                );
            }
            async query() {
              if (fault === 'query') throw new Error('Synthetic query failure');
            }
            async end() {}
          },
        },
        prepare: async (options, started) => {
          started();
          return runtime.finishRuntime({
            ...options,
            resourcesPath: 'synthetic-resources',
            assets: 'synthetic-assets',
            identity: 'fixture',
            manifest: {
              images: ['postgres', 'workspace', 'browser'].map((name) => ({
                name,
                id: `sha256:${name}`,
              })),
            },
            saved: { port: taken.address().port, password: 'synthetic-fixture-password' },
            controlRoot: 'synthetic-control',
            path: 'synthetic-path',
            dockerEnvironment: {},
            runGuest: async () => {},
            status: options.onStatus,
            prepareImage: async (name) => {
              if (name === fault) throw new Error(`Synthetic ${name} startup failure`);
            },
            runDocker: async (args, options) => {
              commands.push(args);
              if (options?.timeout === 10_000) {
                assert.ok(['inspect', 'exec'].includes(args[0]));
                if (fault === 'wsl')
                  throw new Error('Synthetic WSL check failure: synthetic-fixture-password');
              }
              if (args[0] === 'container' && args[1] === 'inspect') {
                if (!containers.has(args[2])) throw new Error('Absent synthetic container');
                return JSON.stringify([containers.get(args[2])]);
              }
              if (args[0] === 'run') {
                const name = args[args.indexOf('--name') + 1];
                containers.set(name, {
                  Id: `synthetic-container-${++created}`,
                  Image: args.find((value) => value.startsWith('sha256:')),
                  State: { Running: true },
                  Config: { Labels: { 'dev.nod.desktop.experiment': 'true' } },
                  Mounts: args.flatMap((value, index) => {
                    if (value !== '--volume') return [];
                    const [Name, Destination] = args[index + 1].split(':');
                    return [{ Type: 'volume', Name, Destination }];
                  }),
                });
              }
              if (args[0] === 'exec' && args[2] === 'pg_isready' && fault === 'pg_isready')
                throw new Error('Synthetic pg_isready failure');
              if (
                args[0] === 'inspect' &&
                args.includes('{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}')
              )
                return fault === 'memory'
                  ? 'exited 137 true'
                  : fault === 'stopped'
                    ? 'exited 1 false'
                    : 'running 0 false';
              if (args[0] === 'inspect') return 'true';
              return '';
            },
          });
        },
        stopComputer: async () => {
          stopped++;
        },
      },
    );
    const lifecycle = createDesktopLifecycle({
      prepareRuntime: (options) =>
        runtime.prepareRuntime({ ...options, dataRoot: resolve('synthetic-profile') }),
      validateStart: async () => {},
      startEngine: async () => {},
      stopEngine: async () => {},
      onRuntimeStatus() {},
    });
    const postgres = () => containers.get('nod-postgres-fixture').Id;
    try {
      await assert.rejects(lifecycle.start(), /Synthetic workspace startup failure/);
      const original = postgres();
      fault = 'browser';
      await assert.rejects(lifecycle.start({ retry: true }), /Synthetic browser startup failure/);
      assert.equal(postgres(), original);
      fault = failure;
      await assert.rejects(lifecycle.start({ retry: true }), (error) => {
        assert.equal(error.code, expectedCode);
        assert.match(error.details, new RegExp(`Synthetic ${failure} failure`));
        assert.ok(!JSON.stringify(error).includes('synthetic-fixture-password'));
        return true;
      });
      assert.equal(postgres(), original);
      assert.equal(stopped, 0);
      const attempted = commands.length;
      fault = undefined;
      await assert.rejects(lifecycle.start());
      assert.equal(commands.length, attempted);
      await lifecycle.start({ retry: true });
      assert.notEqual(
        postgres(),
        original,
        `${failure}: explicit retry must replace failed PostgreSQL`,
      );
      const launches = commands.filter(
        (args) => args[0] === 'run' && args.includes('nod-postgres-fixture'),
      );
      assert.equal(launches.length, 2);
      assert.deepEqual(launches[1], launches[0]);
      const published = launches[0][launches[0].indexOf('--publish') + 1];
      assert.notEqual(published, `127.0.0.1:${taken.address().port}:5432`);
      assert.deepEqual(new Set(connections), new Set([published.split(':')[1]]));
      assert.equal(stopped, 0);
    } finally {
      await lifecycle.close();
    }
    assert.equal(stopped, 1);
  }
});

async function windowsImageFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nod-windows-image-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'images'));
  const images = await Promise.all(
    ['postgres', 'workspace', 'browser'].map(async (name) => {
      const bytes = Buffer.from(`synthetic-${name}-image`);
      const digest = createHash('sha256').update(bytes).digest('hex');
      await writeFile(join(root, 'images', `${name}.tar.zst`), bytes);
      return {
        name,
        id: `sha256:${digest}`,
        sha256: digest,
        reference: `synthetic:${name}`,
        file: `images/${name}.tar.zst`,
      };
    }),
  );
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ images }));
  await writeFile(join(root, 'state.json'), JSON.stringify({ images: {}, commands: [] }));
  const runner = join(root, 'run.py');
  await writeFile(
    runner,
    `import builtins, json, os, subprocess, sys
source, root, command = sys.argv[1:]
original_open = builtins.open
original_exists = os.path.exists
source_code = original_open(source).read()
state_path = os.path.join(root, 'state.json')
state = json.load(original_open(state_path))
manifest = json.load(original_open(os.path.join(root, 'manifest.json')))
def mapped(path):
    path = os.fspath(path)
    for prefix in ['/opt/nod-assets/', '/var/lib/nod/']:
        if path.startswith(prefix): return os.path.join(root, path[len(prefix):])
    if path == '/var/lib/nod': return root
    raise RuntimeError('Unexpected fixture path')
def run(args, **kwargs):
    state['commands'].append(args[1:])
    if args[1:] == ['info']: return subprocess.CompletedProcess(args, 0)
    if args[1:3] == ['image', 'inspect']:
        value = state['images'].get(args[-1])
        result = subprocess.CompletedProcess(args, 0 if value else 1, stdout=value or '')
    elif args[1:3] == ['load', '--input']:
        image = next(image for image in manifest['images'] if args[-1].endswith('/' + image['file']))
        state['images'][image['reference']] = 'sha256:' + '0' * 64 if state.get('wrong') == image['name'] else image['id']
        result = subprocess.CompletedProcess(args, 0)
    else: raise RuntimeError('Unexpected Docker command')
    if kwargs.get('check') and result.returncode: raise subprocess.CalledProcessError(result.returncode, args)
    return result
builtins.open = lambda path, *args, **kwargs: original_open(mapped(path), *args, **kwargs)
os.path.exists = lambda path: original_exists(mapped(path))
def makedirs(path, **kwargs):
    assert mapped(path) == root
os.makedirs = makedirs
subprocess.run = run
sys.argv = [source, command]
try:
    exec(compile(source_code, source, 'exec'), {'__name__': '__main__'})
finally:
    with original_open(state_path, 'w') as target: json.dump(state, target)
`,
  );
  return {
    root,
    async read() {
      return JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
    },
    async wrong(name) {
      const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
      await writeFile(join(root, 'state.json'), JSON.stringify({ ...state, wrong: name }));
    },
    run(command, name) {
      return execFileSync(
        process.platform === 'win32' ? 'python' : 'python3',
        [
          runner,
          fileURLToPath(new URL('../runtime/windows-guest.py', import.meta.url)),
          root,
          command,
        ],
        {
          input: JSON.stringify({ identity: '123456abcdef', name }),
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    },
  };
}

test('runtime hands off verified storage before browser readiness and fences failed or aborted handoffs', async (t) => {
  const { finishRuntime } = await import('../runtime/index.mjs');
  const { default: pg } = await import('pg');
  for (const outcome of [
    'ready',
    'callback-failed',
    'aborted-handoff',
    'aborted',
    'windows-ready',
    'windows-failed',
    'windows-damaged',
  ]) {
    await t.test(outcome, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'nod-storage-ready-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const signal = new AbortController();
      const windows = outcome.startsWith('windows-') ? await windowsImageFixture(t) : undefined;
      if (windows) {
        windows.run('start');
        assert.deepEqual((await windows.read()).images, {});
        if (outcome === 'windows-failed') await windows.wrong('browser');
        if (outcome === 'windows-damaged')
          await writeFile(
            join(windows.root, 'images/browser.tar.zst'),
            'corrupt synthetic archive',
          );
      }
      const calls = [];
      let storage;
      let callbacks = 0;
      let verified = false;
      let release;
      let blocked;
      let continueSetup;
      let handedOff;
      const handoff = new Promise((resolve) => {
        continueSetup = resolve;
      });
      const handed = new Promise((resolve) => {
        handedOff = resolve;
      });
      const browser = new Promise((resolve) => {
        release = resolve;
      });
      const waiting = new Promise((resolve) => {
        blocked = resolve;
      });
      t.mock.method(pg.Client.prototype, 'connect', async () => {
        calls.push('database-connect');
      });
      t.mock.method(pg.Client.prototype, 'query', async (query) => {
        assert.equal(query, 'SELECT 1');
        verified = true;
      });
      t.mock.method(pg.Client.prototype, 'end', async () => {
        calls.push('database-end');
      });
      const created = new Set();
      const runDocker = async (args) => {
        signal.signal.throwIfAborted();
        calls.push(args);
        if (args[0] === 'network' && args[1] === 'inspect') {
          const role = args[2].split('-')[1];
          const index = ['control', 'workspace', 'browser'].indexOf(role);
          return JSON.stringify([
            {
              Driver: 'bridge',
              Scope: 'local',
              EnableIPv6: false,
              Internal: false,
              IPAM: { Config: [{ Subnet: `172.31.${80 + index}.0/24` }] },
              Options: {
                'com.docker.network.bridge.name': `nod-${role}`,
                'com.docker.network.bridge.enable_icc': 'false',
              },
            },
          ]);
        }
        if (args[0] === 'run') created.add(args[args.indexOf('--name') + 1]);
        if (args[0] === 'container' && args[1] === 'inspect') {
          if (!created.has(args[2])) throw new Error('Absent fixture container');
          return JSON.stringify([
            {
              Id: args[2],
              Image: 'sha256:postgres',
              State: { Running: true },
              Config: { Labels: { 'dev.nod.desktop.experiment': 'true' } },
              Mounts: [
                {
                  Type: 'volume',
                  Name: 'nod-postgres-fixture',
                  Destination: '/var/lib/postgresql/data',
                },
              ],
            },
          ]);
        }
        if (args[0] === 'inspect') return 'true';
        if (args[0] === 'exec' && args[1] === 'nod-browser-fixture') {
          blocked();
          if (outcome === 'callback-failed') release();
          await Promise.race([
            browser,
            new Promise((_, reject) =>
              signal.signal.addEventListener('abort', () => reject(signal.signal.reason), {
                once: true,
              }),
            ),
          ]);
        }
        return '';
      };
      let settled = false;
      const operation = finishRuntime({
        dataRoot: root,
        resourcesPath: root,
        assets: root,
        identity: 'fixture',
        manifest: {
          images: ['postgres', 'workspace', 'browser'].map((name) => ({
            name,
            id: `sha256:${name}`,
          })),
        },
        saved: { port: 54329, password: 'synthetic-fixture-password' },
        controlRoot: root,
        docker: join(root, 'docker-fixture'),
        path: process.env.PATH,
        dockerEnvironment: {
          DOCKER_HOST: 'unix://synthetic-docker',
          DOCKER_CONFIG: join(root, 'docker-config'),
        },
        runDocker,
        runGuest: async () => {},
        signal: signal.signal,
        status() {},
        prepareImage: async (name) => {
          calls.push(['prepare-image', name]);
          if (name !== 'postgres') await handed;
          windows?.run('image', name);
        },
        async onStorageReady(runtime) {
          callbacks++;
          if (windows)
            assert.deepEqual(Object.keys((await windows.read()).images), ['synthetic:postgres']);
          assert.equal(verified, true);
          assert.ok(calls.includes('database-end'));
          assert.equal(
            calls.some(
              (command) =>
                Array.isArray(command) &&
                command[0] === 'run' &&
                command.includes('nod-workspace-fixture'),
            ),
            false,
          );
          assert.equal(runtime.env, runtime.environment);
          assert.equal(new URL(runtime.env.DATABASE_URL).port, '54329');
          assert.equal(runtime.env.WORKSPACE_CONTAINER, 'nod-workspace-fixture');
          if (process.platform !== 'win32')
            assert.ok((await stat(join(root, 'bin/docker'))).isFile());
          storage = runtime;
          handedOff();
          if (outcome === 'callback-failed') throw new Error('Synthetic engine startup failed');
          await handoff;
        },
      }).then(
        (runtime) => {
          settled = true;
          return runtime;
        },
        (error) => {
          settled = true;
          throw error;
        },
      );
      const result = operation.then(
        (runtime) => ({ runtime }),
        (error) => ({ error }),
      );
      try {
        if (outcome === 'callback-failed') {
          const failed = await result;
          assert.match(failed.error?.message ?? '', /Synthetic engine startup failed/);
          assert.equal(
            calls.some(
              (command) =>
                Array.isArray(command) &&
                command[0] === 'run' &&
                command.includes('nod-browser-fixture'),
            ),
            false,
          );
        } else {
          await Promise.race([
            handed,
            waiting.then(() => {
              throw new Error('Browser started before storage handoff');
            }),
            result.then((value) => {
              throw value.error ?? new Error('Runtime completed before storage handoff');
            }),
          ]);
          assert.deepEqual(
            calls.filter((command) => Array.isArray(command) && command[0] === 'prepare-image'),
            [
              ['prepare-image', 'postgres'],
              ['prepare-image', 'workspace'],
              ['prepare-image', 'browser'],
            ],
          );
          if (outcome === 'aborted-handoff') {
            signal.abort(new Error('Synthetic setup cancelled during handoff'));
            continueSetup();
            assert.equal((await result).error, signal.signal.reason);
            assert.equal(
              calls.some(
                (command) =>
                  Array.isArray(command) &&
                  command[0] === 'run' &&
                  command.includes('nod-workspace-fixture'),
              ),
              false,
            );
            return;
          }
          continueSetup();
          if (outcome === 'windows-failed' || outcome === 'windows-damaged') {
            assert.ok((await result).error);
            assert.ok(storage);
            assert.equal(callbacks, 1);
            if (outcome === 'windows-damaged')
              assert.equal(
                (await windows.read()).commands.some(
                  (command) => command[0] === 'load' && command.at(-1).endsWith('/browser.tar.zst'),
                ),
                false,
              );
            assert.equal(
              calls.some(
                (command) =>
                  Array.isArray(command) &&
                  command[0] === 'run' &&
                  command.includes('nod-browser-fixture'),
              ),
              false,
            );
            return;
          }
          await Promise.race([
            waiting,
            result.then((value) => {
              throw value.error ?? new Error('Runtime completed before browser gate');
            }),
          ]);
          assert.equal(callbacks, 1);
          assert.ok(storage);
          assert.equal(settled, false);
          if (outcome === 'aborted') signal.abort(new Error('Synthetic setup cancelled'));
          else release();
          const finished = await result;
          if (outcome === 'aborted') {
            assert.equal(finished.error?.name, 'AbortError');
            assert.equal(finished.error?.cause, signal.signal.reason);
          } else assert.equal(finished.runtime, storage);
        }
        assert.equal(callbacks, 1);
        assert.equal(
          calls.some(
            (command) =>
              Array.isArray(command) &&
              ['volume', 'network'].includes(command[0]) &&
              command[1] === 'rm',
          ),
          false,
        );
      } finally {
        continueSetup();
        release();
        await result;
      }
    });
  }
});

test('runtime fingerprints cover the locked packages and every source the images use, and reject symlinked input roots', async (t) => {
  const { cp, realpath } = await import('node:fs/promises');
  const { build } = await import('esbuild');
  const { browserEntries, browserInputs, browserTools, runtimeInputs } =
    await import('../scripts/runtime-inputs.mjs');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nod-runtime-inputs-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const bundle = await build({
    entryPoints: browserEntries,
    absWorkingDir: repository,
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    metafile: true,
    outdir: 'out',
    logLevel: 'silent',
  });
  const browser = await browserInputs();
  const input = await runtimeInputs();
  const windows = await runtimeInputs('win32-x64');
  const locked = (inputs, name) => inputs.some((path) => path.startsWith(`lock:${name}@`));
  const dependencyManifest = (path) =>
    /^(?:package\.json|pnpm-lock\.yaml|patches(?:\/|$))/.test(path);
  for (const path of Object.keys(bundle.metafile.inputs)) {
    if (!path.includes('node_modules/')) {
      assert.ok(browser.sources.includes(path), path);
      continue;
    }
    const name = path
      .split('node_modules/')
      .at(-1)
      .match(/^(?:@[^/]+\/)?[^/]+/)[0];
    assert.ok(locked(input.inputs, name) && locked(windows.inputs, name), path);
  }
  const browserDockerfile = await readFile(join(repository, 'Dockerfile.browser'), 'utf8');
  assert.ok(browserDockerfile.includes(`esbuild ${browserEntries.join(' ')} `));
  for (const [, name] of browserDockerfile.matchAll(
    /node_modules\/(?:\.bin\/)?((?:@[\w.-]+\/)?[\w.-]+)/g,
  )) {
    assert.ok(browserTools.includes(name), name);
    assert.ok(locked(input.inputs, name) && locked(windows.inputs, name), name);
  }
  const windowsCopies = [
    ...(
      await readFile(join(repository, 'desktop/scripts/prepare-windows-runtime.mjs'), 'utf8')
    ).matchAll(/copyFile\(join\(root, '([^']+)'\)/g),
  ].map(([, path]) => path);
  assert.ok(windowsCopies.length >= 2);
  for (const path of windowsCopies) assert.ok(windows.inputs.includes(path), path);
  const covered = (inputs, path) => {
    const full = join(repository, path);
    if (!existsSync(full) || !statSync(full).isDirectory()) return inputs.includes(path);
    return readdirSync(full, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .every((entry) =>
        inputs.includes(
          relative(repository, join(entry.parentPath, entry.name)).replaceAll('\\', '/'),
        ),
      );
  };
  for (const path of ['Dockerfile.workspace', 'Dockerfile.browser']) {
    const dockerfile = await readFile(join(repository, path), 'utf8');
    for (const [, sources] of dockerfile.matchAll(
      /^(?:COPY|ADD)(?! --from)(?:\s+--\S+)*\s+(.+)\s+\S+$/gm,
    ))
      for (const source of sources.split(/\s+/))
        if (source !== 'src' && !dependencyManifest(source))
          assert.ok(covered(input.inputs, source), `${path}: ${source}`);
    for (const [source] of dockerfile.matchAll(/\bsrc\/[\w./-]+/g))
      assert.ok(covered(input.inputs, source), `${path}: ${source}`);
  }
  for (const [inputs, roots] of [
    [input.inputs, ['desktop/scripts/prepare-runtime.mjs', 'desktop/scripts/runtime-pack.mjs']],
    [
      windows.inputs,
      ['desktop/scripts/prepare-runtime.mjs', 'desktop/scripts/prepare-windows-runtime.mjs'],
    ],
  ]) {
    const seen = new Set();
    const visit = async (path) => {
      if (
        seen.has(path) ||
        path === 'desktop/scripts/runtime-inputs.mjs' ||
        dependencyManifest(path)
      )
        return;
      seen.add(path);
      assert.ok(covered(inputs, path), path);
      if (!path.endsWith('.mjs')) return;
      const source = await readFile(join(repository, path), 'utf8');
      const targets = [
        ...[...source.matchAll(/(?:from\s*|import\(\s*)'(\.{1,2}\/[^']+\.mjs)'/g)].map(
          ([, target]) => posix.join(posix.dirname(path), target),
        ),
        ...[
          ...source.matchAll(
            /'((?:desktop|src|patches)\/[^'*]+|Dockerfile\.[\w.]+|\.dockerignore|package\.json|pnpm-[\w.-]+\.yaml)'/g,
          ),
        ].map(([, target]) => target),
      ];
      for (const target of targets)
        if (await stat(join(repository, target)).catch(() => undefined)) await visit(target);
    };
    for (const root of roots) await visit(root);
    assert.ok(seen.size > roots.length);
  }
  for (const path of [
    'Dockerfile.browser',
    'Dockerfile.workspace',
    'desktop/runtime/Dockerfile.windows',
  ])
    for (const stage of (await readFile(join(repository, path), 'utf8')).split(/^FROM /m))
      if (stage.includes('apt-get install'))
        assert.match(
          stage.slice(0, stage.indexOf('apt-get install')),
          /^ARG NOD_RUNTIME_REFRESH$/m,
          path,
        );
  const dockerfiles = `${browserDockerfile}\n${await readFile(join(repository, 'Dockerfile.workspace'), 'utf8')}`;
  for (const [, path] of dockerfiles.matchAll(/^COPY (?:--\S+ )*(src\/\S+)/gm))
    assert.ok(input.inputs.includes(path), path);
  const sourcePaths = [...input.inputs, ...windows.inputs].filter(
    (path) => !path.includes(':') && !path.startsWith('@') && !path.startsWith('signing.'),
  );
  for (const path of new Set([
    ...sourcePaths,
    'package.json',
    'pnpm-lock.yaml',
    'desktop/package.json',
    'desktop/pnpm-lock.yaml',
    'desktop/scripts/runtime-inputs.mjs',
  ])) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(join(repository, path), join(root, path));
  }
  const run = () =>
    promisify(execFile)(process.execPath, [join(root, 'desktop/scripts/runtime-inputs.mjs')], {
      env: { PATH: process.env.PATH },
    });
  const before = JSON.parse((await run()).stdout).fingerprint;
  const lockPath = join(root, 'pnpm-lock.yaml');
  const lockSource = await readFile(lockPath, 'utf8');
  for (const [name, image] of [
    ['zod', true],
    ['agent-browser', true],
    ['@esbuild/linux-arm64', true],
    ['posthog-node', false],
    ['react', false],
  ]) {
    const entry = new RegExp(
      `^( {2}'?${name.replaceAll('/', '\\/')}@[^:\\s]+'?:\\n {4}resolution: \\{integrity: )\\S+\\}`,
      'm',
    );
    assert.match(lockSource, entry, name);
    await writeFile(lockPath, lockSource.replace(entry, '$1sha512-synthetic}'));
    const fingerprint = JSON.parse((await run()).stdout).fingerprint;
    if (image) assert.notEqual(fingerprint, before, name);
    else assert.equal(fingerprint, before, name);
  }
  await writeFile(lockPath, `${lockSource}\nsyntheticDependencyChange: true\n`);
  assert.equal(JSON.parse((await run()).stdout).fingerprint, before);
  await writeFile(lockPath, lockSource);
  const manifestPath = join(root, 'package.json');
  const manifestSource = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestSource);
  await writeFile(
    manifestPath,
    JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, synthetic: '1.0.0' } }),
  );
  assert.equal(JSON.parse((await run()).stdout).fingerprint, before);
  await writeFile(manifestPath, JSON.stringify({ ...manifest, packageManager: 'pnpm@0.0.0' }));
  assert.notEqual(JSON.parse((await run()).stdout).fingerprint, before);
  await writeFile(manifestPath, manifestSource);
  for (const path of [
    'src/shared/public-address.ts',
    'src/providers/docker/save-video.py',
    'pnpm-workspace.yaml',
  ]) {
    const file = join(root, path);
    const source = await readFile(file, 'utf8');
    await writeFile(file, `${source}\n// synthetic runtime change\n`);
    assert.notEqual(JSON.parse((await run()).stdout).fingerprint, before);
    await writeFile(file, source);
  }
  for (const path of [
    'src/server/index.ts',
    'src/web/pages/chat.tsx',
    '.github/workflows/desktop-release.yml',
    'patches/libsignal@6.0.0.patch',
    'desktop/scripts/runtime-inputs.mjs',
  ]) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    const source = await readFile(file, 'utf8').catch(() => '');
    await writeFile(file, `${source}\nexport const syntheticAppChange = true;\n`);
  }
  assert.equal(JSON.parse((await run()).stdout).fingerprint, before);
  const windowsRun = (env = {}) =>
    promisify(execFile)(process.execPath, [join(root, 'desktop/scripts/runtime-inputs.mjs')], {
      env: { PATH: process.env.PATH, NOD_DESKTOP_TARGET: 'win32-x64', ...env },
    }).then(({ stdout }) => JSON.parse(stdout).fingerprint);
  const windowsBefore = await windowsRun();
  const refreshed = await promisify(execFile)(
    process.execPath,
    [join(root, 'desktop/scripts/runtime-inputs.mjs')],
    { env: { PATH: process.env.PATH, NOD_RUNTIME_REFRESH: '2026-10-19' } },
  );
  assert.notEqual(JSON.parse(refreshed.stdout).fingerprint, before);
  assert.notEqual(await windowsRun({ NOD_RUNTIME_REFRESH: '2026-10-19' }), windowsBefore);
  assert.equal(
    await windowsRun({
      NOD_SIGNING_MODE: 'self-signed',
      NOD_SIGNING_IDENTITY: 'Synthetic Nod Signing',
      NOD_SIGNING_CERTIFICATE_SHA256: 'a'.repeat(64),
    }),
    windowsBefore,
  );
  for (const path of [
    ...windowsCopies,
    'desktop/scripts/prepare-windows-runtime.mjs',
    'desktop/scripts/speech-sources.mjs',
    'desktop/licenses/speech.md',
  ]) {
    const file = join(root, path);
    const source = await readFile(file, 'utf8');
    await writeFile(file, `${source}\n# synthetic runtime change\n`);
    assert.notEqual(await windowsRun(), windowsBefore, path);
    assert.equal(JSON.parse((await run()).stdout).fingerprint, before, path);
    await writeFile(file, source);
  }
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'must-not-be-hashed'), 'Synthetic outside-checkout content');
  const ports = join(root, 'src/ports');
  await rm(ports, { recursive: true });
  await symlink(outside, ports);
  await assert.rejects(run());
  await rm(ports);
  await cp(join(repository, 'src/ports'), ports, { recursive: true });
  assert.equal(JSON.parse((await run()).stdout).fingerprint, before);
  await rm(join(root, 'Dockerfile.workspace'));
  await symlink(join(outside, 'must-not-be-hashed'), join(root, 'Dockerfile.workspace'));
  await assert.rejects(run());
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
  await assert.rejects(prepareRuntimeUpdate({ ...f.release, id: '0'.repeat(64) }, options));
  await assert.rejects(
    prepareRuntimeUpdate(
      { ...f.release, archive: { ...f.release.archive, sha256: 'a'.repeat(64) } },
      options,
    ),
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
    fetch: async () => {
      downloads++;
      const content = Buffer.from(bytes);
      if (corrupt) content[30] ^= 1;
      return new Response(content);
    },
  };
  await assert.rejects(prepareRuntimeUpdate(next.release, options));
  assert.equal(await findRuntimeAssets(current), installed);
  assert.deepEqual(
    (await readdir(current.cacheRoot)).sort(),
    [current.release.id, next.release.id].sort(),
  );
  assert.equal(await findRuntimeAssets({ ...options, release: next.release }), undefined);
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

test('runtime cleanup removes only old unmounted packs and leftovers inside the managed cache', async (t) => {
  const { removeUnusedRuntimes } = await import('../runtime/assets.mjs');
  const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), 'nod-runtime-cleanup-')));
  t.after(() => rm(cacheRoot, { recursive: true, force: true }));
  const id = (letter) => letter.repeat(64);
  const names = {
    current: id('a'),
    mounted: id('b'),
    old: id('c'),
    recent: id('d'),
    download: `${id('e')}.${'1'.repeat(12)}.download`,
    install: `${id('f')}.install-${'2'.repeat(12)}`,
    other: 'notes',
  };
  for (const name of Object.values(names)) await mkdir(join(cacheRoot, name));
  const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  for (const name of Object.values(names))
    if (name !== names.recent) await utimes(join(cacheRoot, name), past, past);
  const elsewhere = join(cacheRoot, 'outside', id('a'));
  assert.deepEqual(await removeUnusedRuntimes({ current: elsewhere, cacheRoot }), []);
  const removed = await removeUnusedRuntimes({
    current: join(cacheRoot, names.current),
    keep: [join(cacheRoot, names.mounted)],
    cacheRoot,
  });
  assert.deepEqual(removed.sort(), [names.old, names.download, names.install].sort());
  assert.deepEqual(
    (await readdir(cacheRoot)).sort(),
    [names.current, names.mounted, names.recent, names.other].sort(),
  );
});

test('runtime removes images outside its manifest without touching current images', async () => {
  const { removeStaleImages } = await import('../runtime/index.mjs');
  const current = `sha256:${'a'.repeat(64)}`;
  const stale = [`sha256:${'b'.repeat(64)}`, `sha256:${'c'.repeat(64)}`];
  const removed = [];
  const guest = [];
  const runDocker = async (args) => {
    if (args[1] === 'ls') return [current, ...stale, stale[0]].join('\n');
    removed.push(args[2]);
    if (args[2] === stale[1]) throw new Error('in use');
    return '';
  };
  const manifest = { images: [{ id: current }] };
  assert.deepEqual(
    await removeStaleImages(runDocker, async (input) => guest.push(input), manifest),
    stale,
  );
  assert.deepEqual(removed, stale);
  assert.equal(guest.length, 1);
  removed.length = 0;
  await removeStaleImages(
    async () => current,
    async (input) => guest.push(input),
    manifest,
  );
  assert.deepEqual(removed, []);
  assert.equal(guest.length, 1);
});

test(
  'removing all data restarts after deletion and preserves the app and other profiles',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { removeProfile } = await import('../runtime/index.mjs');
    const root = await realpath(await mkdtemp(join(tmpdir(), 'nod-remove-profile-')));
    const home = process.env.HOME;
    process.env.HOME = join(root, 'home');
    t.after(async () => {
      process.env.HOME = home;
      await rm(root, { recursive: true, force: true });
    });
    const homes = join(root, 'home', '.nod-desktop');
    const computer = (profile) =>
      join(homes, createHash('sha256').update(profile).digest('hex').slice(0, 12));
    const profiles = [join(root, 'nod/profiles/local'), join(root, 'Other/profiles/local')];
    const application = join(root, 'nod.app');
    await writeFile(application, 'synthetic app');
    for (const profile of profiles) {
      await mkdir(join(profile, 'desktop-runtime'), { recursive: true });
      await writeFile(join(profile, 'desktop-runtime/state.json'), '{}');
      await mkdir(join(computer(profile), 'nod'), { recursive: true });
      await writeFile(join(computer(profile), 'nod/lima.yaml'), '{}');
    }
    const source = await readFile(new URL('../main/main.mjs', import.meta.url), 'utf8');
    let response = 1;
    let storageCleared = false;
    let cacheCleared = false;
    let relaunched = false;
    let exited = false;
    const removeAllData = runInNewContext(
      `${source
        .slice(
          source.indexOf('async function removeAllData()'),
          source.indexOf('async function finishQuit('),
        )
        .replace(/await import\([\s\S]*?\);/, 'runtime;')}; removeAllData`,
      {
        quitting: false,
        remoteConnection: undefined,
        dialog: { showMessageBox: async () => ({ response }) },
        quit: async (complete) => complete(),
        runtime: { removeProfile },
        profileRoot: profiles[0],
        engineRoot: root,
        session: {
          fromPartition: () => ({
            clearStorageData: async () => {
              storageCleared = true;
            },
            clearCache: async () => {
              cacheCleared = true;
            },
          }),
        },
        app: {
          setLoginItemSettings() {},
          relaunch() {
            assert.equal(storageCleared && cacheCleared, true);
            assert.equal(existsSync(profiles[0]), false);
            assert.equal(existsSync(computer(profiles[0])), false);
            assert.equal(readFileSync(application, 'utf8'), 'synthetic app');
            relaunched = true;
          },
          exit() {
            assert.equal(relaunched, true);
            exited = true;
          },
        },
      },
    );
    await removeAllData();
    assert.equal(exited, false);
    assert.equal(existsSync(profiles[0]), true);
    assert.equal(await readFile(join(profiles[0], 'desktop-runtime/state.json'), 'utf8'), '{}');
    assert.equal(await readFile(join(computer(profiles[0]), 'nod/lima.yaml'), 'utf8'), '{}');
    assert.equal(storageCleared, false);
    assert.equal(cacheCleared, false);
    assert.equal(relaunched, false);
    response = 0;
    await removeAllData();
    assert.equal(exited, true);
    await assert.rejects(stat(profiles[0]), { code: 'ENOENT' });
    await assert.rejects(stat(computer(profiles[0])), { code: 'ENOENT' });
    assert.equal(await readFile(join(profiles[1], 'desktop-runtime/state.json'), 'utf8'), '{}');
    assert.equal(await readFile(join(computer(profiles[1]), 'nod/lima.yaml'), 'utf8'), '{}');
    await removeProfile({ dataRoot: profiles[1], resourcesPath: root });
    await assert.rejects(stat(homes), { code: 'ENOENT' });
    assert.deepEqual(await readdir(join(root, 'nod/profiles')), []);
  },
);

test('local test installs refuse normal apps and cannot reuse or follow foreign profiles', async (t) => {
  const { testProfile, validateTestApplication } = await import('../scripts/test-install.mjs');
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'nod-test-install-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const application = join(temporary, 'nod.app');
  const packagePath = join(application, 'Contents', 'Resources', 'app', 'package.json');
  await mkdir(dirname(packagePath), { recursive: true });
  await writeFile(packagePath, JSON.stringify({ name: 'nod-desktop', productName: 'nod' }));
  await assert.rejects(validateTestApplication(application), /not an isolated Nod test/);
  await writeFile(
    packagePath,
    JSON.stringify({
      name: 'nod-setup-test',
      productName: 'nod Setup Test',
      nodBuild: { testProfile: true },
    }),
  );
  await validateTestApplication(application);
  const linkedApp = join(temporary, 'linked.app');
  await symlink(application, linkedApp, 'dir');
  await assert.rejects(validateTestApplication(linkedApp), /real directory/);
  const profiles = join(temporary, 'profiles');
  const fresh = await testProfile(profiles, 'fresh', true);
  const saved = join(fresh, 'saved-data');
  await writeFile(saved, 'synthetic preserved account data');
  assert.equal(await testProfile(profiles, 'fresh'), fresh);
  await assert.rejects(testProfile(profiles, 'fresh', true), { code: 'EEXIST' });
  await assert.rejects(testProfile(profiles, '../normal', true), /profile name/);
  const foreign = join(temporary, 'normal');
  await mkdir(foreign);
  await writeFile(join(foreign, 'test-profile.json'), '{}');
  await symlink(foreign, join(profiles, 'foreign'), 'dir');
  await assert.rejects(testProfile(profiles, 'foreign'), /must not be a link/);
  await mkdir(join(profiles, 'unowned'));
  await writeFile(join(profiles, 'unowned', 'test-profile.json'), '{}');
  await assert.rejects(testProfile(profiles, 'unowned'), /not created by the test installer/);
  assert.equal(await readFile(saved, 'utf8'), 'synthetic preserved account data');
  assert.deepEqual(await readdir(foreign), ['test-profile.json']);
});
