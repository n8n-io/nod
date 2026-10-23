import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { automaticRelease, configuredRelease, isReleaseMerge } from './prepare-desktop-release.mjs';

const root = process.cwd();
const runtimeDirectory = join(root, '.local/desktop-runtime-release');
const output = process.env.NOD_DESKTOP_OUTPUT || join(root, 'dist/desktop');
const platform = process.env.NOD_DESKTOP_TARGET || 'darwin-arm64';
if (!['darwin-arm64', 'darwin-x64'].includes(platform))
  throw new Error('Unsupported Mac release target.');
const arch = platform.slice(7);
const sourceRepository = process.env.GITHUB_REPOSITORY;
const sourceRevision = process.env.NOD_RELEASE_SOURCE || process.env.GITHUB_SHA;
const releaseRepository = sourceRepository;
const runtimeRepository = releaseRepository;
const signingMode = process.env.NOD_SIGNING_MODE || 'self-signed';
const shaPattern = /^[a-f0-9]{40}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const maximumAssetBytes = 2 * 1024 ** 3;
const windowsRuntimeArchive = 'nod-Runtime-win32-x64.tar.gz';

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 ** 2,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function gh(args, repository = sourceRepository) {
  const token = repository === sourceRepository ? process.env.GH_TOKEN : process.env.RELEASE_TOKEN;
  if (!token) throw new Error('Configure RELEASE_TOKEN for the distribution repositories.');
  try {
    return run('gh', args, { env: { ...process.env, GH_TOKEN: token } });
  } catch (error) {
    if (args[0] === 'api' && String(error.stderr).includes('(HTTP 404)')) return undefined;
    throw new Error(
      'GitHub release access failed. Check token permissions and repository settings.',
    );
  }
}

function api(route, repository = sourceRepository) {
  const result = gh(['api', route], repository);
  return result === undefined ? undefined : JSON.parse(result);
}

function releaseByTag(repository, tag) {
  const published = api(`repos/${repository}/releases/tags/${tag}`, repository);
  if (published) return published;
  const [owner, name] = repository.split('/');
  const result = JSON.parse(
    gh(
      [
        'api',
        'graphql',
        '-f',
        'query=query($owner: String!, $name: String!, $tag: String!) { repository(owner: $owner, name: $name) { release(tagName: $tag) { databaseId } } }',
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-f',
        `tag=${tag}`,
      ],
      repository,
    ),
  );
  const id = result.data?.repository?.release?.databaseId;
  if (id === undefined || id === null) return;
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid GitHub release identifier.');
  return api(`repos/${repository}/releases/${id}`, repository);
}

async function hash(path) {
  const value = createHash('sha256');
  for await (const bytes of createReadStream(path)) value.update(bytes);
  return value.digest('hex');
}

async function outputValues(values) {
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  console.log(JSON.stringify(values));
}

async function jsonDownload(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('The runtime descriptor must be publicly downloadable.');
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 2 * 1024 ** 2) throw new Error('The runtime descriptor is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function repositoryName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))
    throw new Error('Configure an explicit source repository and NOD_RUNTIME_REPO destination.');
  return value;
}

function descriptor(value, fingerprint, baseUrl, isPublic) {
  if (
    value.version !== 1 ||
    value.platform !== platform ||
    value.fingerprint !== fingerprint ||
    !hashPattern.test(value.id) ||
    !hashPattern.test(value.archive?.sha256) ||
    !new RegExp(`^nod-Runtime-${platform}-[a-f0-9]{12}\\.tar\\.gz$`).test(value.archive?.file) ||
    !Number.isSafeInteger(value.archive.bytes) ||
    value.archive.bytes <= 0 ||
    value.archive.bytes >= maximumAssetBytes ||
    value.signing?.mode !== signingMode ||
    value.signing?.certificateSha256 !== process.env.NOD_SIGNING_CERTIFICATE_SHA256 ||
    (signingMode === 'developer-id' && value.notarization?.status !== 'Accepted') ||
    (value.url !== undefined && (!isPublic || value.url !== `${baseUrl}/${value.archive.file}`))
  )
    throw new Error('The published runtime descriptor does not match these release inputs.');
  return value;
}

async function downloadDescriptor(
  repository,
  tag,
  baseUrl,
  isPublic,
  name = 'runtime-release.json',
) {
  if (isPublic) return jsonDownload(`${baseUrl}/${name}`);
  await mkdir(runtimeDirectory, { recursive: true });
  gh(
    [
      'release',
      'download',
      tag,
      '--repo',
      repository,
      '--pattern',
      name,
      '--dir',
      runtimeDirectory,
      '--clobber',
    ],
    repository,
  );
  const path = join(runtimeDirectory, name);
  if ((await stat(path)).size > 2 * 1024 ** 2)
    throw new Error('The runtime descriptor is too large.');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function plan() {
  if (process.env.GITHUB_REF !== 'refs/heads/main')
    throw new Error('Desktop releases must start from main.');
  repositoryName(sourceRepository);
  repositoryName(releaseRepository);
  repositoryName(runtimeRepository);
  if (!['self-signed', 'developer-id'].includes(signingMode))
    throw new Error('Invalid signing mode.');
  const source = run('git', ['rev-parse', 'HEAD']);
  if (!shaPattern.test(source) || source !== sourceRevision)
    throw new Error('Release checkout does not match the workflow revision.');
  if (process.env.GITHUB_EVENT_NAME === 'push') {
    const pulls = api(`repos/${sourceRepository}/commits/${source}/pulls`);
    if (
      !Array.isArray(pulls) ||
      !pulls.some((pull) => isReleaseMerge(pull, source, sourceRepository))
    ) {
      await outputValues({ release_needed: 'false' });
      return;
    }
  }
  if (process.env.NOD_RELEASE_TARGETS === 'all') {
    const targets = [];
    let first;
    for (const target of ['arm64', 'x64']) {
      const environment = {
        ...process.env,
        NOD_RELEASE_TARGETS: '',
        NOD_DESKTOP_TARGET: `darwin-${target}`,
        GITHUB_OUTPUT: '',
      };
      if (first?.metadata_sha256)
        Object.assign(environment, {
          NOD_AUTOMATIC_RELEASE: 'false',
          NOD_RELEASE_PLAN: '.local/desktop-release-plan.json',
          NOD_RELEASE_PLAN_SHA256: first.metadata_sha256,
        });
      const result = JSON.parse(
        run(process.execPath, [fileURLToPath(import.meta.url), 'plan'], { env: environment }),
      );
      if (result.release_needed === 'false') {
        await outputValues({ release_needed: 'false' });
        return;
      }
      first ||= result;
      if (
        result.release_needed !== 'true' ||
        result.source !== first.source ||
        result.version !== first.version
      )
        throw new Error('The Mac release plans do not match.');
      if (result.runtime_reused === 'true') {
        await mkdir(join(runtimeDirectory, target), { recursive: true });
        await copyFile(
          join(runtimeDirectory, 'runtime-release.json'),
          join(runtimeDirectory, target, 'runtime-release.json'),
        );
      }
      targets.push({
        ...result,
        arch: target,
        platform: `darwin-${target}`,
        linux_runner:
          target === 'arm64'
            ? 'blacksmith-16vcpu-ubuntu-2404-arm'
            : 'blacksmith-16vcpu-ubuntu-2404',
        mac_runner: 'blacksmith-12vcpu-macos-15',
        node_arch: target,
        docker_arch: target === 'arm64' ? 'arm64' : 'amd64',
      });
    }
    const windows = JSON.parse(
      run(process.execPath, ['desktop/scripts/runtime-inputs.mjs'], {
        env: { ...process.env, NOD_DESKTOP_TARGET: 'win32-x64' },
      }),
    ).fingerprint;
    if (!hashPattern.test(windows)) throw new Error('Invalid runtime fingerprint.');
    const windowsRuntime = gh([
      'api',
      `repos/${releaseRepository}/releases?per_page=100`,
      '--paginate',
      '--jq',
      '.[] | {tag_name, draft, assets: [.assets[] | {name}]}',
    ])
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find(
        (release) =>
          !release.draft &&
          /^nod-v/.test(release.tag_name) &&
          [`runtime-win32-x64-${windows}.json`, windowsRuntimeArchive].every((name) =>
            release.assets?.some((asset) => asset.name === name),
          ),
      );
    await outputValues({
      ...first,
      windows_runtime_fingerprint: windows,
      windows_runtime_tag: windowsRuntime?.tag_name || '',
      runtime_refresh: process.env.NOD_RUNTIME_REFRESH || 'local',
      mac_matrix: JSON.stringify({ include: targets }),
      runtime_matrix: JSON.stringify({
        include: targets.filter((target) => target.runtime_reused !== 'true'),
      }),
      runtime_needed: String(targets.some((target) => target.runtime_reused !== 'true')),
    });
    return;
  }
  const automatic = process.env.NOD_AUTOMATIC_RELEASE === 'true';
  const release = automatic
    ? automaticRelease(
        root,
        gh([
          'api',
          `repos/${releaseRepository}/releases?per_page=100`,
          '--paginate',
          '--jq',
          '.[] | {id, tag_name, target_commitish, draft, body: (if .draft then .body else null end)}',
        ])
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
        sourceRepository,
      )
    : await configuredRelease(root);
  if (process.env.APPLE_CONFIGURED !== 'true')
    throw new Error('Configure signing credentials and public certificate metadata in release.');
  const runs = api(
    `repos/${sourceRepository}/actions/workflows/ci.yml/runs?head_sha=${source}&per_page=20`,
  );
  if (
    runs?.workflow_runs.find(
      (entry) =>
        entry.head_sha === source &&
        entry.head_branch === 'main' &&
        entry.head_repository?.full_name === sourceRepository &&
        ['push', 'workflow_dispatch'].includes(entry.event),
    )?.conclusion !== 'success'
  )
    throw new Error('The exact main revision must pass CI before packaging a release.');
  const appRepo = api(`repos/${releaseRepository}`, releaseRepository);
  const runtimeRepo = api(`repos/${runtimeRepository}`, runtimeRepository);
  if (!appRepo || !runtimeRepo)
    throw new Error('The configured distribution repositories are unavailable.');
  if (signingMode === 'self-signed' && (!appRepo.private || !runtimeRepo.private))
    throw new Error('Self-signed builds are restricted to private distribution repositories.');
  const tag = `nod-v${release.version}`;
  const existing = releaseByTag(releaseRepository, tag);
  if (existing && !existing.draft) {
    if (process.env.GITHUB_EVENT_NAME === 'push') {
      await outputValues({ release_needed: 'false' });
      return;
    }
    throw new Error('This desktop version is already published.');
  }
  let metadataSha256 = '';
  if (automatic) {
    const path = join(root, '.local/desktop-release-plan.json');
    await mkdir(join(root, '.local'), { recursive: true });
    await writeFile(path, JSON.stringify(release, null, 2) + '\n');
    metadataSha256 = await hash(path);
  }
  const inputs = JSON.parse(run(process.execPath, ['desktop/scripts/runtime-inputs.mjs']));
  if (!hashPattern.test(inputs.fingerprint)) throw new Error('Invalid runtime fingerprint.');
  const alias = `runtime-${platform}-${inputs.fingerprint}.json`;
  const releases = gh([
    'api',
    `repos/${runtimeRepository}/releases?per_page=100`,
    '--paginate',
    '--jq',
    '.[]',
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const runtime = releases.find(
    (release) =>
      !release.draft &&
      /^nod-v/.test(release.tag_name) &&
      release.assets?.some((asset) => asset.name === alias) &&
      release.assets?.some((asset) =>
        new RegExp(`^nod-Runtime-${platform}-[a-f0-9]{12}\\.tar\\.gz$`).test(asset.name),
      ),
  );
  const runtimeTag = runtime?.tag_name || tag;
  const baseUrl = `https://github.com/${runtimeRepository}/releases/download/${runtimeTag}`;
  const reused = Boolean(runtime && !runtime.draft);
  if (reused) {
    const saved = descriptor(
      await downloadDescriptor(runtimeRepository, runtimeTag, baseUrl, !runtimeRepo.private, alias),
      inputs.fingerprint,
      baseUrl,
      !runtimeRepo.private,
    );
    const asset = runtime.assets.find((entry) => entry.name === saved.archive.file);
    if (asset?.digest !== `sha256:${saved.archive.sha256}` || asset.size !== saved.archive.bytes)
      throw new Error('Published runtime archive metadata failed verification.');
    if (!runtimeRepo.private) saved.url = `${baseUrl}/${saved.archive.file}`;
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(
      join(runtimeDirectory, 'runtime-release.json'),
      JSON.stringify(saved, null, 2) + '\n',
    );
  }
  await outputValues({
    source,
    release_needed: 'true',
    metadata_sha256: metadataSha256,
    version: release.version,
    previous_tag: release.previousTag || '',
    tag,
    runtime_tag: runtimeTag,
    runtime_fingerprint: inputs.fingerprint,
    runtime_base_url: baseUrl,
    runtime_reused: String(reused),
    runtime_public: String(!runtimeRepo.private),
  });
}

function releaseTarget(repository, release) {
  const target = repository === sourceRepository ? sourceRevision : release?.target_commitish;
  const source = shaPattern.test(target)
    ? target
    : typeof target === 'string' && target
      ? api(`repos/${repository}/commits/${encodeURIComponent(target)}`, repository)?.sha
      : undefined;
  if (!shaPattern.test(source)) throw new Error('The release target could not be resolved.');
  return source;
}

async function uploadDraft({ repository, tag, title, notes, marker, files }) {
  let release = releaseByTag(repository, tag);
  if (release && (!release.draft || !release.body?.includes(marker)))
    throw new Error('Refusing to replace a published or unrelated release.');
  const id = release?.id;
  const target =
    release || repository === sourceRepository ? releaseTarget(repository, release) : undefined;
  const notesPath = join(process.env.RUNNER_TEMP || root, `nod-${tag}-notes.md`);
  await writeFile(notesPath, notes);
  if (!release)
    gh(
      [
        'release',
        'create',
        tag,
        '--repo',
        repository,
        '--draft',
        '--prerelease=false',
        '--latest=false',
        ...(repository === sourceRepository ? ['--target', sourceRevision] : []),
        '--title',
        title,
        '--notes-file',
        notesPath,
      ],
      repository,
    );
  else
    gh(
      [
        'release',
        'edit',
        tag,
        '--repo',
        repository,
        '--tag',
        tag,
        '--target',
        target,
        '--prerelease=false',
        '--latest=false',
        '--title',
        title,
        '--notes-file',
        notesPath,
      ],
      repository,
    );
  for (const file of files)
    if ((await stat(file)).size >= maximumAssetBytes)
      throw new Error('GitHub release assets must be smaller than 2 GiB.');
  if (files.length)
    gh(['release', 'upload', tag, ...files, '--repo', repository, '--clobber'], repository);
  release = releaseByTag(repository, tag);
  if (
    !release?.draft ||
    release.tag_name !== tag ||
    (id !== undefined && release.id !== id) ||
    (target !== undefined && release.target_commitish !== target)
  )
    throw new Error('Release draft identity does not match its tag and source.');
  for (const file of files) {
    const asset = release.assets.find((entry) => entry.name === basename(file));
    if (asset?.digest !== `sha256:${await hash(file)}` || asset.size !== (await stat(file)).size)
      throw new Error(`Uploaded asset integrity check failed: ${basename(file)}`);
  }
  return release;
}

function publishRelease(repository, tag) {
  const release = releaseByTag(repository, tag);
  if (!release?.draft || release.tag_name !== tag)
    throw new Error('The release draft is unavailable.');
  const target = releaseTarget(repository, release);
  gh(
    [
      'release',
      'edit',
      tag,
      '--repo',
      repository,
      '--tag',
      tag,
      '--target',
      target,
      '--draft=false',
      '--prerelease=false',
      '--latest=true',
    ],
    repository,
  );
  const published = releaseByTag(repository, tag);
  if (
    !published ||
    published.draft ||
    published.prerelease !== false ||
    published.id !== release.id ||
    published.tag_name !== tag ||
    published.target_commitish !== target
  )
    throw new Error('Published release identity does not match its tag and source.');
}

async function verifyDelivery(tag, version) {
  const sourceUrl = process.env.NOD_DESKTOP_UPDATE_SOURCE_URL;
  if (!sourceUrl) return;
  const { createUpdateSource } = await import('../../desktop/main/updates.mjs');
  const get = (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
  let target;
  try {
    for (target of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
      const [os, arch] = target.split('-');
      let update;
      for (let attempt = 0; update?.version !== version; attempt++) {
        if (attempt === 6) throw new Error(`it does not list nod ${version}`);
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 10_000));
        update = await createUpdateSource({ sourceUrl, os, arch }).latest('0.0.0');
      }
      const response = await get(`${sourceUrl}/releases?installer=true&platform=${target}`);
      const installer = response.ok ? await response.json() : {};
      const downloads =
        os === 'win32'
          ? [installer.installer?.url, installer.runtime?.url]
          : [installer.disk?.url, update.downloadUrl];
      const statuses = [];
      for (const url of downloads) {
        const download = await get(url, { redirect: 'manual' });
        await download.body?.cancel();
        statuses.push(download.status);
      }
      const feed = update.feedUrl && (await get(update.feedUrl));
      if (
        installer.version !== version ||
        statuses.some((status) => status !== 302) ||
        (feed && (!feed.ok || (await feed.json()).name !== `nod ${version}`))
      )
        throw new Error('its installer, runtime or update is unavailable');
    }
  } catch (error) {
    gh(
      ['release', 'edit', tag, '--repo', releaseRepository, '--tag', tag, '--draft=true'],
      releaseRepository,
    );
    throw new Error(
      `nod ${version} is a draft again because ${sourceUrl} cannot deliver ${target}: ${error.message}`,
    );
  }
}

async function draftApp({ stageOnly = false } = {}) {
  repositoryName(sourceRepository);
  repositoryName(releaseRepository);
  repositoryName(runtimeRepository);
  const publish = process.env.NOD_PUBLISH_RELEASE === 'true';
  const prepared = await configuredRelease(root);
  const version = prepared.version;
  const tag = `nod-v${version}`;
  const source = sourceRevision;
  if (!shaPattern.test(source) || run('git', ['rev-parse', 'HEAD']) !== source)
    throw new Error('Invalid source revision.');
  const appRepo = api(`repos/${releaseRepository}`, releaseRepository);
  const runtimeRepo = api(`repos/${runtimeRepository}`, runtimeRepository);
  if (
    !appRepo ||
    !runtimeRepo ||
    (signingMode === 'self-signed' && (!appRepo.private || !runtimeRepo.private))
  )
    throw new Error('Self-signed builds require accessible private distribution repositories.');
  const metadata = JSON.parse(await readFile(join(output, 'release.json'), 'utf8'));
  if (
    metadata.platform !== platform ||
    metadata.version !== version ||
    metadata.source !== source ||
    metadata.signing?.mode !== signingMode ||
    metadata.signing?.certificateSha256 !== process.env.NOD_SIGNING_CERTIFICATE_SHA256 ||
    (await hash(join(output, 'signing.cer'))) !== metadata.signing.certificateSha256 ||
    (signingMode === 'developer-id' && metadata.notarized !== true)
  )
    throw new Error('Packaged release metadata does not match the approved source.');
  if (metadata.updateSourceUrl !== (process.env.NOD_DESKTOP_UPDATE_SOURCE_URL || undefined))
    throw new Error('The packaged update source does not match the release configuration.');
  if (metadata.updateSourceUrl !== undefined) {
    if (typeof metadata.updateSourceUrl !== 'string' || !URL.canParse(metadata.updateSourceUrl))
      throw new Error('The packaged update source must be a credential-free HTTPS URL.');
    const url = new URL(metadata.updateSourceUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      /[?#]/.test(metadata.updateSourceUrl)
    )
      throw new Error('The packaged update source must be a credential-free HTTPS URL.');
  }
  const changes = prepared.notes.trimEnd();
  await writeFile(join(output, 'CHANGELOG.md'), changes + '\n');
  const names = (await readdir(output)).filter(
    (name) =>
      /\.(?:dmg|zip)$/.test(name) ||
      [
        'SHA256SUMS',
        'release.json',
        'runtime-release.json',
        'update.json',
        'CHANGELOG.md',
        'signing.cer',
      ].includes(name),
  );
  if (
    names.filter((name) => name.endsWith('.dmg')).length !== 1 ||
    names.filter((name) => name.endsWith('.zip')).length !== 1 ||
    !names.includes('SHA256SUMS') ||
    !names.includes('update.json')
  )
    throw new Error('Expected one signed DMG, application ZIP, update feed and checksums.');
  const marker = `Source: https://github.com/${sourceRepository}/commit/${source}`;
  const runtime = JSON.parse(await readFile(join(output, 'runtime-release.json'), 'utf8'));
  const runtimeTag = runtime.releaseTag || tag;
  if (!/^nod-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(runtimeTag))
    throw new Error('The runtime must belong to a nod version release.');
  const baseUrl = `https://github.com/${runtimeRepository}/releases/download/${runtimeTag}`;
  descriptor(runtime, process.env.NOD_EXPECTED_RUNTIME_FINGERPRINT, baseUrl, !runtimeRepo.private);
  const runtimeFiles = [];
  if (runtimeTag === tag) {
    const archive = join(runtimeDirectory, arch, runtime.archive.file);
    if (
      (await hash(archive)) !== runtime.archive.sha256 ||
      (await stat(archive)).size !== runtime.archive.bytes
    )
      throw new Error('The local runtime archive does not match the packaged app.');
    runtimeFiles.push(archive);
  } else {
    const runtimeRelease = releaseByTag(runtimeRepository, runtimeTag);
    const saved = await downloadDescriptor(
      runtimeRepository,
      runtimeTag,
      baseUrl,
      !runtimeRepo.private,
      `runtime-${platform}-${runtime.fingerprint}.json`,
    );
    const asset = runtimeRelease?.assets.find((entry) => entry.name === runtime.archive.file);
    if (
      !runtimeRelease ||
      runtimeRelease.draft ||
      !isDeepStrictEqual({ ...saved, url: undefined }, { ...runtime, url: undefined }) ||
      asset?.digest !== `sha256:${runtime.archive.sha256}` ||
      asset.size !== runtime.archive.bytes
    )
      throw new Error('The published runtime does not match the packaged app.');
  }
  const alias = join(
    root,
    '.local/desktop-runtime-aliases',
    `runtime-${platform}-${runtime.fingerprint}.json`,
  );
  await mkdir(join(root, '.local/desktop-runtime-aliases'), { recursive: true });
  await copyFile(join(output, 'runtime-release.json'), alias);
  runtimeFiles.push(alias);
  if (
    metadata.runtime?.fingerprint !== runtime.fingerprint ||
    metadata.runtime?.id !== runtime.id ||
    !isDeepStrictEqual(metadata.runtime?.archive, runtime.archive)
  )
    throw new Error('Packaged app and runtime descriptor do not match.');
  const disk = names.find((name) => name.endsWith('.dmg'));
  const zip = names.find((name) => name.endsWith('.zip'));
  for (const [file, entry] of [
    [disk, metadata.disk],
    [zip, metadata.update],
  ]) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:dmg|zip)$/.test(file) ||
      entry?.file !== file ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes <= 0 ||
      entry.bytes >= maximumAssetBytes ||
      !hashPattern.test(entry.sha256) ||
      entry.sha256 !== (await hash(join(output, file))) ||
      entry.bytes !== (await stat(join(output, file))).size
    )
      throw new Error('Packaged application assets do not match the release metadata.');
  }
  if (
    disk !== `nod-${arch}.dmg` ||
    zip !== disk.replace(/\.dmg$/, '.zip') ||
    (await readFile(join(output, 'SHA256SUMS'), 'utf8')).trim() !==
      `${metadata.disk.sha256}  ${disk}\n${metadata.update.sha256}  ${zip}`
  )
    throw new Error('Packaged DMG, application ZIP and checksums do not match.');
  const feed = JSON.parse(await readFile(join(output, 'update.json'), 'utf8'));
  if (
    feed.url !== `https://github.com/${releaseRepository}/releases/download/${tag}/${zip}` ||
    feed.name !== `nod ${version}` ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(feed.pub_date) ||
    !Number.isFinite(Date.parse(feed.pub_date)) ||
    new Date(feed.pub_date).toISOString().replace(/\.\d{3}Z$/, 'Z') !== feed.pub_date ||
    Object.keys(feed).sort().join(',') !== 'name,pub_date,url'
  )
    throw new Error('The native update feed does not match the packaged release.');
  const releaseNotes = () =>
    `[${arch === 'arm64' ? 'Mac ARM' : 'Mac Intel'}](https://github.com/${releaseRepository}/releases/download/${tag}/${disk})\n\n${changes}\n\n${marker}\n`;
  const files = [...runtimeFiles];
  for (const name of names) {
    if (
      arch === 'x64' &&
      ['release.json', 'runtime-release.json', 'update.json', 'SHA256SUMS'].includes(name)
    ) {
      const destination = join(
        root,
        '.local/desktop-intel-assets',
        name.replace(/(\.json)?$/, (extension) => `-darwin-x64${extension}`),
      );
      await mkdir(join(root, '.local/desktop-intel-assets'), { recursive: true });
      await copyFile(join(output, name), destination);
      files.push(destination);
    } else files.push(join(output, name));
  }
  let release = await uploadDraft({
    repository: releaseRepository,
    tag,
    title: `nod v${version}`,
    marker,
    notes: releaseNotes(),
    files,
  });
  const downloadDirectory = join(process.env.RUNNER_TEMP || root, `nod-download-check-${version}`);
  await mkdir(downloadDirectory, { recursive: true });
  for (const file of [disk, zip]) {
    gh(
      [
        'release',
        'download',
        tag,
        '--repo',
        releaseRepository,
        '--pattern',
        file,
        '--dir',
        downloadDirectory,
        '--clobber',
      ],
      releaseRepository,
    );
    if (
      (await hash(join(downloadDirectory, file))) !== (await hash(join(output, file))) ||
      (await stat(join(downloadDirectory, file))).size !== (await stat(join(output, file))).size
    )
      throw new Error(`Downloaded release ${file === disk ? 'DMG' : 'ZIP'} failed its checksum.`);
    await rm(join(downloadDirectory, file));
  }
  if (publish && !stageOnly) {
    await uploadDraft({
      repository: releaseRepository,
      tag,
      title: `nod v${version}`,
      marker,
      notes: releaseNotes(),
      files: [],
    });
    publishRelease(releaseRepository, tag);
    release = releaseByTag(releaseRepository, tag);
    if (!release || release.draft) throw new Error('The app release was not published.');
  }
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `[Open desktop release](${release.html_url})\n`,
    );
  await outputValues({
    release_url: release.html_url,
    published: publish,
  });
}

async function windowsRuntime(fingerprint, manifest, archive, asset) {
  const bytes = (await stat(archive)).size;
  const sha256 = await hash(archive);
  if (
    !hashPattern.test(fingerprint) ||
    manifest.version !== 1 ||
    manifest.platform !== 'win32-x64' ||
    manifest.fingerprint !== fingerprint ||
    manifest.guest?.file !== 'guest.tar.gz' ||
    manifest.guest.sha256 !== sha256 ||
    manifest.guest.bytes !== bytes ||
    (asset && (asset.digest !== `sha256:${sha256}` || asset.size !== bytes))
  )
    throw new Error('The Windows runtime does not match its manifest.');
}

async function reuseWindowsRuntime() {
  const tag = process.env.NOD_WINDOWS_RUNTIME_TAG;
  const fingerprint = process.env.NOD_WINDOWS_RUNTIME_FINGERPRINT;
  const assets = join(root, '.local/windows-runtime-assets');
  const name = `runtime-win32-x64-${fingerprint}.json`;
  const release = /^nod-v/.test(tag || '') && releaseByTag(releaseRepository, tag);
  if (!release || release.draft) throw new Error('The reused Windows runtime is unavailable.');
  await mkdir(assets, { recursive: true });
  gh(
    [
      'release',
      'download',
      tag,
      '--repo',
      releaseRepository,
      '--pattern',
      name,
      '--pattern',
      windowsRuntimeArchive,
      '--dir',
      assets,
      '--clobber',
    ],
    releaseRepository,
  );
  const manifest = JSON.parse(await readFile(join(assets, name), 'utf8'));
  await windowsRuntime(
    fingerprint,
    manifest,
    join(assets, windowsRuntimeArchive),
    release.assets.find((entry) => entry.name === windowsRuntimeArchive),
  );
  await rename(join(assets, windowsRuntimeArchive), join(assets, 'guest.tar.gz'));
  delete manifest.fingerprint;
  await writeFile(join(assets, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

async function draftAll() {
  const prepared = await configuredRelease(root);
  const version = prepared.version;
  const source = sourceRevision;
  if (!shaPattern.test(source) || run('git', ['rev-parse', 'HEAD']) !== source)
    throw new Error('Invalid source revision.');
  const windows = join(root, 'dist/desktop/win32-x64');
  const metadata = JSON.parse(await readFile(join(windows, 'release-win32-x64.json'), 'utf8'));
  const receipt = JSON.parse(await readFile(join(windows, 'windows-check.json'), 'utf8'));
  if (
    metadata.version !== version ||
    metadata.source !== source ||
    metadata.platform !== 'win32-x64' ||
    metadata.updateSourceUrl !== (process.env.NOD_DESKTOP_UPDATE_SOURCE_URL || undefined) ||
    metadata.signing?.mode !== 'unsigned' ||
    ['installed', 'engine', 'wsl', 'application', 'browser', 'workspaceFiles', 'reopened'].some(
      (key) => receipt[key] !== true,
    )
  )
    throw new Error('The Windows release does not match its source or native checks.');
  for (const [entry, name] of [
    [metadata.installer, 'nod-Setup-x64.exe'],
    [metadata.runtime, 'nod-Runtime-win32-x64.tar.gz'],
  ]) {
    if (
      entry?.file !== name ||
      !hashPattern.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes <= 0 ||
      entry.bytes >= maximumAssetBytes ||
      (await hash(join(windows, name))) !== entry.sha256 ||
      (await stat(join(windows, name))).size !== entry.bytes
    )
      throw new Error('The Windows release asset failed verification.');
  }
  if (
    (await readFile(join(windows, 'SHA256SUMS'), 'utf8')).trim() !==
    `${metadata.installer.sha256}  ${metadata.installer.file}\n${metadata.runtime.sha256}  ${metadata.runtime.file}`
  )
    throw new Error('The Windows checksums do not match.');
  const windowsFingerprint = JSON.parse(
    run(process.execPath, ['desktop/scripts/runtime-inputs.mjs'], {
      env: { ...process.env, NOD_DESKTOP_TARGET: 'win32-x64' },
    }),
  ).fingerprint;
  const windowsManifest = join(windows, `runtime-win32-x64-${windowsFingerprint}.json`);
  await windowsRuntime(
    windowsFingerprint,
    JSON.parse(await readFile(windowsManifest, 'utf8')),
    join(windows, windowsRuntimeArchive),
  );
  for (const target of ['arm64', 'x64']) {
    const environment = {
      ...process.env,
      NOD_DESKTOP_TARGET: `darwin-${target}`,
      NOD_DESKTOP_OUTPUT: join(root, `dist/desktop/${target}`),
      GITHUB_OUTPUT: '',
    };
    const inputs = JSON.parse(
      run(process.execPath, ['desktop/scripts/runtime-inputs.mjs'], { env: environment }),
    );
    environment.NOD_EXPECTED_RUNTIME_FINGERPRINT = inputs.fingerprint;
    run(process.execPath, [fileURLToPath(import.meta.url), 'stage'], { env: environment });
  }
  const tag = `nod-v${version}`;
  const marker = `Source: https://github.com/${sourceRepository}/commit/${source}`;
  const sum = join(windows, 'SHA256SUMS-win32-x64');
  await copyFile(join(windows, 'SHA256SUMS'), sum);
  const download = (file) =>
    `https://github.com/${releaseRepository}/releases/download/${tag}/${file}`;
  const notes = `### Downloads\n\n- [Mac Intel](${download('nod-x64.dmg')})\n- [Mac ARM](${download('nod-arm64.dmg')})\n- [Windows](${download('nod-Setup-x64.exe')})\n\nMac requires macOS 14 or later. Windows requires Windows 11 with WSL 2. To install with one Terminal or PowerShell command, follow the [install guide](https://nod-docs.pages.dev/get-started/install-desktop/). Installed apps update themselves. The first launch downloads the runtime.\n\nMac builds use ${signingMode === 'self-signed' ? 'the internal signing certificate' : 'Developer ID signing and Apple notarization'}. Windows builds are unsigned.\n\n${prepared.notes.trimEnd()}\n\n${marker}\n`;
  let release = await uploadDraft({
    repository: releaseRepository,
    tag,
    title: `nod v${version}`,
    notes,
    marker,
    files: ['nod-Setup-x64.exe', 'nod-Runtime-win32-x64.tar.gz', 'release-win32-x64.json']
      .map((name) => join(windows, name))
      .concat(sum, windowsManifest),
  });
  const expected = [
    'nod-arm64.dmg',
    'nod-x64.dmg',
    'nod-Setup-x64.exe',
    'nod-arm64.zip',
    'nod-x64.zip',
    'release.json',
    'release-darwin-x64.json',
    'runtime-release.json',
    'runtime-release-darwin-x64.json',
    'update.json',
    'update-darwin-x64.json',
    'release-win32-x64.json',
    'nod-Runtime-win32-x64.tar.gz',
    basename(windowsManifest),
  ];
  if (expected.some((name) => release.assets.filter((asset) => asset.name === name).length !== 1))
    throw new Error('All three platform bundles are required before publication.');
  const directory = join(process.env.RUNNER_TEMP || root, `nod-windows-download-check-${version}`);
  await mkdir(directory, { recursive: true });
  for (const entry of [metadata.installer, metadata.runtime]) {
    gh([
      'release',
      'download',
      tag,
      '--repo',
      releaseRepository,
      '--pattern',
      entry.file,
      '--dir',
      directory,
      '--clobber',
    ]);
    if (
      (await stat(join(directory, entry.file))).size !== entry.bytes ||
      (await hash(join(directory, entry.file))) !== entry.sha256
    )
      throw new Error('The downloaded Windows release failed verification.');
    await rm(join(directory, entry.file));
  }
  if (process.env.NOD_PUBLISH_RELEASE === 'true') {
    publishRelease(releaseRepository, tag);
    await verifyDelivery(tag, version);
    release = releaseByTag(releaseRepository, tag);
  }
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `[Open desktop release](${release.html_url})\n`,
    );
  await outputValues({ release_url: release.html_url, published: !release.draft });
}

const command = process.argv[2];
if (command === 'plan') await plan();
else if (command === 'draft') await draftApp();
else if (command === 'stage') await draftApp({ stageOnly: true });
else if (command === 'draft-all') await draftAll();
else if (command === 'reuse-windows-runtime') await reuseWindowsRuntime();
else throw new Error('Expected plan, draft, stage, draft-all or reuse-windows-runtime.');
