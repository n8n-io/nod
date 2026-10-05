import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { verifyRuntimeDownload } from '../../desktop/scripts/release-tools.mjs';
import { automaticRelease, configuredRelease } from './prepare-desktop-release.mjs';

const root = process.cwd();
const runtimeDirectory = join(root, '.local/desktop-runtime-release');
const output = join(root, 'dist/desktop');
const sourceRepository = process.env.GITHUB_REPOSITORY;
const releaseRepository = sourceRepository;
const runtimeRepository = process.env.OTTO_RUNTIME_REPO || releaseRepository;
const signingMode = process.env.OTTO_SIGNING_MODE || 'self-signed';
const shaPattern = /^[a-f0-9]{40}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const maximumAssetBytes = 2 * 1024 ** 3;

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
    throw new Error('Configure an explicit source repository and OTTO_RUNTIME_REPO destination.');
  return value;
}

function descriptor(value, fingerprint, baseUrl, isPublic) {
  if (
    value.version !== 1 ||
    value.platform !== 'darwin-arm64' ||
    value.fingerprint !== fingerprint ||
    !hashPattern.test(value.id) ||
    !hashPattern.test(value.archive?.sha256) ||
    !/^Otto-Runtime-darwin-arm64-[a-f0-9]{12}\.tar\.gz$/.test(value.archive?.file) ||
    !Number.isSafeInteger(value.archive.bytes) ||
    value.archive.bytes <= 0 ||
    value.archive.bytes >= maximumAssetBytes ||
    value.signing?.mode !== signingMode ||
    value.signing?.certificateSha256 !== process.env.OTTO_SIGNING_CERTIFICATE_SHA256 ||
    (signingMode === 'developer-id' && value.notarization?.status !== 'Accepted') ||
    (value.url !== undefined && (!isPublic || value.url !== `${baseUrl}/${value.archive.file}`))
  )
    throw new Error('The published runtime descriptor does not match these release inputs.');
  return value;
}

async function downloadDescriptor(repository, tag, baseUrl, isPublic) {
  if (isPublic) return jsonDownload(`${baseUrl}/runtime-release.json`);
  await mkdir(runtimeDirectory, { recursive: true });
  gh(
    [
      'release',
      'download',
      tag,
      '--repo',
      repository,
      '--pattern',
      'runtime-release.json',
      '--dir',
      runtimeDirectory,
      '--clobber',
    ],
    repository,
  );
  const path = join(runtimeDirectory, 'runtime-release.json');
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
  if (!shaPattern.test(source) || source !== process.env.GITHUB_SHA)
    throw new Error('Release checkout does not match the workflow revision.');
  const automatic = process.env.OTTO_AUTOMATIC_RELEASE === 'true';
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
  if (!release) {
    await outputValues({
      source,
      release_needed: 'false',
      reason: 'No product changes since the latest published desktop release.',
    });
    return;
  }
  if (process.env.APPLE_CONFIGURED !== 'true')
    throw new Error(
      'Configure signing credentials and public certificate metadata in mac-release.',
    );
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
  if (signingMode === 'developer-id' && runtimeRepo.private)
    throw new Error('Developer ID releases require a public runtime download destination.');
  const tag = `desktop-v${release.version}`;
  const existing = releaseByTag(releaseRepository, tag);
  if (existing && !existing.draft) throw new Error('This desktop version is already published.');
  let metadataSha256 = '';
  if (automatic) {
    const path = join(root, '.local/desktop-release-plan.json');
    await mkdir(join(root, '.local'), { recursive: true });
    await writeFile(path, JSON.stringify(release, null, 2) + '\n');
    metadataSha256 = await hash(path);
  }
  const inputs = JSON.parse(run(process.execPath, ['desktop/scripts/runtime-inputs.mjs']));
  if (!hashPattern.test(inputs.fingerprint)) throw new Error('Invalid runtime fingerprint.');
  const runtimeTag = `runtime-darwin-arm64-${inputs.fingerprint}`;
  const baseUrl = `https://github.com/${runtimeRepository}/releases/download/${runtimeTag}`;
  const runtime = api(`repos/${runtimeRepository}/releases/tags/${runtimeTag}`, runtimeRepository);
  const reused = Boolean(runtime && !runtime.draft);
  if (reused) {
    const saved = descriptor(
      await downloadDescriptor(runtimeRepository, runtimeTag, baseUrl, !runtimeRepo.private),
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
    tag,
    runtime_tag: runtimeTag,
    runtime_fingerprint: inputs.fingerprint,
    runtime_base_url: baseUrl,
    runtime_reused: String(reused),
    runtime_public: String(!runtimeRepo.private),
  });
}

function releaseTarget(repository, release) {
  const target =
    repository === sourceRepository ? process.env.GITHUB_SHA : release?.target_commitish;
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
  const notesPath = join(process.env.RUNNER_TEMP || root, `otto-${tag}-notes.md`);
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
        '--prerelease',
        '--latest=false',
        ...(repository === sourceRepository ? ['--target', process.env.GITHUB_SHA] : []),
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
        '--prerelease',
        '--latest=false',
        '--title',
        title,
        '--notes-file',
        notesPath,
      ],
      repository,
    );
  for (const file of files) {
    if ((await stat(file)).size >= maximumAssetBytes)
      throw new Error('GitHub release assets must be smaller than 2 GiB.');
    gh(['release', 'upload', tag, file, '--repo', repository, '--clobber'], repository);
  }
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
      '--prerelease',
      '--latest=false',
    ],
    repository,
  );
  const published = releaseByTag(repository, tag);
  if (
    !published ||
    published.draft ||
    published.id !== release.id ||
    published.tag_name !== tag ||
    published.target_commitish !== target
  )
    throw new Error('Published release identity does not match its tag and source.');
}

async function draftRuntime() {
  repositoryName(runtimeRepository);
  const publish = process.env.OTTO_PUBLISH_RELEASE === 'true';
  const fingerprint = process.env.OTTO_RUNTIME_FINGERPRINT;
  if (!hashPattern.test(fingerprint)) throw new Error('Invalid runtime fingerprint.');
  const tag = `runtime-darwin-arm64-${fingerprint}`;
  const baseUrl = `https://github.com/${runtimeRepository}/releases/download/${tag}`;
  const repository = api(`repos/${runtimeRepository}`, runtimeRepository);
  if (!repository) throw new Error('The runtime repository is unavailable.');
  if (signingMode === 'self-signed' && !repository.private)
    throw new Error('Self-signed runtime packs require a private distribution repository.');
  const value = descriptor(
    JSON.parse(await readFile(join(runtimeDirectory, 'runtime-release.json'), 'utf8')),
    fingerprint,
    baseUrl,
    !repository.private,
  );
  if (Boolean(value.url) !== (!repository.private && publish))
    throw new Error('The runtime download URL does not match the requested publication state.');
  const archive = join(runtimeDirectory, value.archive.file);
  if (
    (await hash(archive)) !== value.archive.sha256 ||
    (await stat(archive)).size !== value.archive.bytes
  )
    throw new Error('The local runtime archive failed verification.');
  const marker = `Runtime inputs: ${fingerprint}`;
  await uploadDraft({
    repository: runtimeRepository,
    tag,
    title: `Otto Runtime — macOS arm64 ${fingerprint.slice(0, 12)}`,
    notes: `${marker}\n\nVersioned runtime downloaded and verified by Otto. Requires the matching signed application.\n`,
    marker,
    files: [
      archive,
      ...['runtime-release.json', 'SHA256SUMS', 'signing.cer'].map((name) =>
        join(runtimeDirectory, name),
      ),
    ],
  });
  const downloaded = descriptor(
    await downloadDescriptor(runtimeRepository, tag, baseUrl, false),
    fingerprint,
    baseUrl,
    !repository.private,
  );
  if (!isDeepStrictEqual(downloaded, value))
    throw new Error('Downloaded runtime descriptor differs from the uploaded file.');
  await outputValues({
    runtime_sha256: value.archive.sha256,
    runtime_descriptor_sha256: await hash(join(runtimeDirectory, 'runtime-release.json')),
    published: false,
  });
}

async function draftApp() {
  repositoryName(sourceRepository);
  repositoryName(releaseRepository);
  repositoryName(runtimeRepository);
  const publish = process.env.OTTO_PUBLISH_RELEASE === 'true';
  const prepared = await configuredRelease(root);
  const version = prepared.version;
  const tag = `desktop-v${version}`;
  const source = process.env.GITHUB_SHA;
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
    metadata.version !== version ||
    metadata.source !== source ||
    metadata.signing?.mode !== signingMode ||
    metadata.signing?.certificateSha256 !== process.env.OTTO_SIGNING_CERTIFICATE_SHA256 ||
    (await hash(join(output, 'signing.cer'))) !== metadata.signing.certificateSha256 ||
    (signingMode === 'developer-id' && metadata.notarized !== true)
  )
    throw new Error('Packaged release metadata does not match the approved source.');
  if (metadata.updateSourceUrl !== (process.env.OTTO_DESKTOP_UPDATE_SOURCE_URL || undefined))
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
  const runtimeTag = `runtime-darwin-arm64-${runtime.fingerprint}`;
  const baseUrl = `https://github.com/${runtimeRepository}/releases/download/${runtimeTag}`;
  let runtimeRelease = releaseByTag(runtimeRepository, runtimeTag);
  if (!runtimeRelease) throw new Error('The matching runtime release is unavailable.');
  descriptor(runtime, process.env.OTTO_EXPECTED_RUNTIME_FINGERPRINT, baseUrl, !runtimeRepo.private);
  if (Boolean(runtime.url) !== (!runtimeRepo.private && (publish || !runtimeRelease.draft)))
    throw new Error('The app runtime URL does not match the requested publication state.');
  const savedRuntime = descriptor(
    await downloadDescriptor(
      runtimeRepository,
      runtimeTag,
      baseUrl,
      !runtimeRepo.private && !runtimeRelease.draft,
    ),
    process.env.OTTO_EXPECTED_RUNTIME_FINGERPRINT,
    baseUrl,
    !runtimeRepo.private,
  );
  const runtimeAsset = runtimeRelease.assets.find((entry) => entry.name === runtime.archive.file);
  if (
    !isDeepStrictEqual({ ...savedRuntime, url: undefined }, { ...runtime, url: undefined }) ||
    runtimeAsset?.digest !== `sha256:${runtime.archive.sha256}` ||
    runtimeAsset.size !== runtime.archive.bytes
  )
    throw new Error('The uploaded runtime does not match the packaged app.');
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
    disk !== 'Otto-arm64.dmg' ||
    zip !== disk.replace(/\.dmg$/, '.zip') ||
    (await readFile(join(output, 'SHA256SUMS'), 'utf8')).trim() !==
      `${metadata.disk.sha256}  ${disk}\n${metadata.update.sha256}  ${zip}`
  )
    throw new Error('Packaged DMG, application ZIP and checksums do not match.');
  const feed = JSON.parse(await readFile(join(output, 'update.json'), 'utf8'));
  if (
    feed.url !== `https://github.com/${releaseRepository}/releases/download/${tag}/${zip}` ||
    feed.name !== `Otto ${version}` ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(feed.pub_date) ||
    !Number.isFinite(Date.parse(feed.pub_date)) ||
    new Date(feed.pub_date).toISOString().replace(/\.\d{3}Z$/, 'Z') !== feed.pub_date ||
    Object.keys(feed).sort().join(',') !== 'name,pub_date,url'
  )
    throw new Error('The native update feed does not match the packaged release.');
  const releaseNotes = () => {
    const runtimeLink = runtimeRelease.draft
      ? runtimeRelease.html_url
      : `https://github.com/${runtimeRepository}/releases/download/${runtimeTag}/${runtime.archive.file}`;
    const installation = [
      `Apple Silicon macOS ${runtime.minimumSystemVersion} or later.`,
      signingMode === 'self-signed'
        ? 'Internal self-signed preview. This is not Apple-notarized; macOS may require Privacy & Security → Open Anyway on first launch.'
        : 'Signed with Developer ID and notarized by Apple.',
      (runtime.url || metadata.updateSourceUrl) && (publish || !runtimeRelease.draft)
        ? 'Otto downloads and verifies its runtime on first launch.'
        : `Download the [matching runtime pack](${runtimeLink})${runtimeRelease.draft ? ' from the draft release assets' : ''}, leave it compressed, and select it when Otto asks. GitHub access is required for these internal downloads.`,
      'Otto keeps keys and conversations in its local profile between updates.',
    ].join('\n\n');
    return `${changes}\n\n${installation}\n\n${marker}\n`;
  };
  let release = await uploadDraft({
    repository: releaseRepository,
    tag,
    title: `Otto ${version}`,
    marker,
    notes: releaseNotes(),
    files: names.map((name) => join(output, name)),
  });
  const downloadDirectory = join(process.env.RUNNER_TEMP || root, `otto-download-check-${version}`);
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
  }
  if (publish) {
    if (runtimeRelease.draft) publishRelease(runtimeRepository, runtimeTag);
    runtimeRelease = releaseByTag(runtimeRepository, runtimeTag);
    if (!runtimeRelease || runtimeRelease.draft)
      throw new Error('The runtime release was not published.');
    if (!runtimeRepo.private) {
      const published = await downloadDescriptor(runtimeRepository, runtimeTag, baseUrl, true);
      if (!isDeepStrictEqual(published, savedRuntime))
        throw new Error('The public runtime descriptor differs from the checked draft.');
      await verifyRuntimeDownload(runtime.url, runtime.archive);
    }
    await uploadDraft({
      repository: releaseRepository,
      tag,
      title: `Otto ${version}`,
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

const command = process.argv[2];
if (command === 'plan') await plan();
else if (command === 'draft-runtime') await draftRuntime();
else if (command === 'draft') await draftApp();
else throw new Error('Expected plan, draft-runtime or draft.');
