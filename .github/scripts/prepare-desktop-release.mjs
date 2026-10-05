import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const releaseFiles = [
  'desktop/package.json',
  'desktop/package-lock.json',
  'desktop/release.json',
  'desktop/CHANGELOG.md',
];
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const maximumNotesBytes = 64 * 1024;
const productPaths = [
  'src',
  'desktop',
  'public',
  'index.html',
  'vite.config.ts',
  'tsconfig.json',
  'package.json',
  'package-lock.json',
  'Dockerfile.workspace',
  'Dockerfile.browser',
  '.dockerignore',
  '.github/scripts/with-apple-signing.mjs',
  ':(exclude)desktop/test',
  ':(exclude)desktop/*.md',
  ':(exclude)desktop/release.json',
];

export function releaseVersion(value) {
  if (typeof value !== 'string' || value.length > 64 || !versionPattern.test(value))
    throw new Error('OTTO_RELEASE_VERSION must be a stable semantic version, such as 0.1.0.');
  return value;
}

function compareVersions(left, right) {
  const a = releaseVersion(left).split('.').map(BigInt);
  const b = releaseVersion(right).split('.').map(BigInt);
  for (let index = 0; index < a.length; index++)
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

function git(root, args, allowMissing = false) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (allowMissing && error.status === 1) return null;
    throw new Error(`Unable to inspect Git history (${args[0]}).`);
  }
}

function repository(root) {
  if (resolve(git(root, ['rev-parse', '--show-toplevel']).trim()) !== resolve(root))
    throw new Error('Run the release script from the repository root.');
  if (git(root, ['rev-parse', '--is-shallow-repository']).trim() !== 'false')
    throw new Error('Desktop releases require the full Git history and tags.');
  return git(root, ['rev-parse', 'HEAD']).trim();
}

function tagExists(root, tag) {
  return git(root, ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], true) !== null;
}

function latestTag(root, source) {
  const tags = git(root, ['tag', '--merged', source, '--list', 'desktop-v*'])
    .trim()
    .split('\n')
    .filter((tag) => versionPattern.test(tag.slice('desktop-v'.length)));
  return tags.sort((a, b) => compareVersions(b.slice(9), a.slice(9)))[0] ?? null;
}

async function readJson(root, file) {
  try {
    return JSON.parse(await readFile(resolve(root, file), 'utf8'));
  } catch {
    throw new Error(`Could not read ${file}.`);
  }
}

function packageVersions(pkg, lock) {
  const current = releaseVersion(pkg.version);
  if (lock.version !== current || lock.packages?.['']?.version !== current)
    throw new Error('Desktop package and lockfile versions do not match.');
  if (pkg.name !== lock.name || pkg.name !== lock.packages[''].name)
    throw new Error('Desktop package and lockfile names do not match.');
  return current;
}

function releaseCommits(root, previousTag, source) {
  const exclusions = [':(exclude)desktop/release.json', ':(exclude)desktop/CHANGELOG.md'];
  const scope = previousTag ? ['.', ...exclusions] : ['desktop', ...exclusions];
  if (
    previousTag &&
    !git(root, ['diff', '--name-only', previousTag, source, '--', ...scope]).trim()
  )
    throw new Error('There are no changes to release since the previous desktop tag.');
  const entries = git(root, [
    'log',
    '--no-merges',
    '--max-count=101',
    '--format=%H%x00%s%x00',
    previousTag ? `${previousTag}..${source}` : source,
    '--',
    ...scope,
  ]).split('\0');
  const commits = [];
  for (let index = 0; index + 1 < entries.length; index += 2) {
    const sha = entries[index].trim();
    const subject = entries[index + 1];
    if (!/^[a-f0-9]{40}$/.test(sha) || subject.length > 2000 || /[\r\n\0]/.test(subject))
      throw new Error('Commit history cannot be represented as bounded release notes.');
    commits.push({ sha, subject });
  }
  if (!commits.length) throw new Error('There are no desktop changes to release.');
  return commits;
}

export function currentNotes(changelog, version) {
  releaseVersion(version);
  const sections = [...changelog.matchAll(/^## (\d+\.\d+\.\d+) - (\d{4}-\d{2}-\d{2})$/gm)];
  if (sections[0]?.[1] !== version || sections.filter((entry) => entry[1] === version).length !== 1)
    throw new Error('The current desktop version must have one leading changelog section.');
  const notes = changelog.slice(sections[0].index, sections[1]?.index).trim() + '\n';
  if (Buffer.byteLength(notes) > maximumNotesBytes)
    throw new Error('The desktop release notes exceed 64 KiB.');
  return notes;
}

function productChanged(root, previousTag, source) {
  const changed = git(root, [
    'diff',
    '--name-only',
    '-z',
    previousTag,
    source,
    '--',
    ...productPaths,
  ])
    .split('\0')
    .filter(Boolean);
  return changed.some((file) => {
    if (
      ![
        'package.json',
        'package-lock.json',
        'desktop/package.json',
        'desktop/package-lock.json',
      ].includes(file)
    )
      return true;
    const withoutVersion = (ref) => {
      const value = JSON.parse(git(root, ['show', `${ref}:${file}`]));
      delete value.version;
      if (value.packages?.['']) delete value.packages[''].version;
      return value;
    };
    return !isDeepStrictEqual(withoutVersion(previousTag), withoutVersion(source));
  });
}

function automaticNotes(root, version, previousTag, source) {
  const date = new Date(git(root, ['show', '-s', '--format=%cI', source]).trim())
    .toISOString()
    .slice(0, 10);
  const commits = releaseCommits(root, previousTag, source);
  const notes = [
    `## ${version} - ${date}`,
    '',
    `Source: \`${source}\``,
    `Previous release: \`${previousTag}\``,
    '',
    ...commits.slice(0, 100).map(({ sha, subject }) => `- ${subject} (${sha.slice(0, 7)})`),
    ...(commits.length > 100
      ? ['', 'More commits are included; review the full Git history.']
      : []),
    '',
  ].join('\n');
  if (Buffer.byteLength(notes) > maximumNotesBytes)
    throw new Error('The desktop release notes exceed 64 KiB.');
  return notes;
}

export function automaticRelease(root, releases, sourceRepository) {
  const source = repository(root);
  if (git(root, ['status', '--porcelain', '--untracked-files=no']).trim())
    throw new Error('Automatic releases require clean tested source.');
  if (!Array.isArray(releases)) throw new Error('Desktop release history is unavailable.');
  const desktop = releases
    .filter((release) =>
      /^desktop-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(release.tag_name),
    )
    .sort((a, b) => compareVersions(b.tag_name.slice(9), a.tag_name.slice(9)));
  const previous = desktop.find((release) => release.draft === false);
  if (!previous) throw new Error('Automatic releases require a published desktop baseline.');
  const previousTag = previous.tag_name;
  if (
    !tagExists(root, previousTag) ||
    git(root, ['merge-base', '--is-ancestor', previousTag, source], true) === null
  )
    throw new Error('The latest published desktop tag must belong to this source history.');
  if (!productChanged(root, previousTag, source)) return;
  const marker = `Source: https://github.com/${sourceRepository}/commit/${source}`;
  const pending = desktop.find(
    (release) => release.draft === true && release.target_commitish === source,
  );
  let version;
  if (pending) {
    if (
      !pending.body?.includes(marker) ||
      compareVersions(pending.tag_name.slice(9), previousTag.slice(9)) <= 0
    )
      throw new Error('The pending desktop release does not match this source and version.');
    version = pending.tag_name.slice(9);
  } else {
    const [major, minor, patch] = previousTag.slice(9).split('.');
    const reserved = new Set([
      ...desktop.map((release) => release.tag_name),
      ...git(root, ['tag', '--list', 'desktop-v*']).trim().split('\n'),
    ]);
    let next = BigInt(patch) + 1n;
    while (reserved.has(`desktop-v${major}.${minor}.${next}`)) next++;
    version = releaseVersion(`${major}.${minor}.${next}`);
  }
  return {
    version,
    previousTag,
    source,
    notes: automaticNotes(root, version, previousTag, source),
  };
}

export async function checkReleasePlan(root, input, path, digest) {
  const bytes = await readFile(resolve(root, path));
  if (
    !/^[a-f0-9]{64}$/.test(digest ?? '') ||
    createHash('sha256').update(bytes).digest('hex') !== digest
  )
    throw new Error('The release plan failed its checksum.');
  if (bytes.length > maximumNotesBytes + 1024)
    throw new Error('The desktop release plan is too large.');
  const plan = JSON.parse(bytes.toString('utf8'));
  const source = repository(root);
  if (
    Object.keys(plan).sort().join(',') !== 'notes,previousTag,source,version' ||
    plan.version !== releaseVersion(input) ||
    plan.source !== source ||
    !/^desktop-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(plan.previousTag) ||
    compareVersions(plan.version, plan.previousTag.slice(9)) <= 0 ||
    !tagExists(root, plan.previousTag) ||
    git(root, ['merge-base', '--is-ancestor', plan.previousTag, source], true) === null ||
    git(root, ['status', '--porcelain', '--untracked-files=no']).trim()
  )
    throw new Error('The release plan does not match the clean tested source.');
  if (
    !productChanged(root, plan.previousTag, source) ||
    plan.notes !== automaticNotes(root, plan.version, plan.previousTag, source)
  )
    throw new Error('The release plan notes do not match the source changes.');
  if (
    tagExists(root, `desktop-v${plan.version}`) &&
    git(root, ['rev-parse', `refs/tags/desktop-v${plan.version}^{commit}`]).trim() !== source
  )
    throw new Error('The desktop release tag already points to another commit.');
  return plan;
}

export async function configuredRelease(root) {
  const path = process.env.OTTO_RELEASE_PLAN || releaseFiles[2];
  const manifest = await readJson(root, path);
  return checkRelease(root, process.env.OTTO_RELEASE_VERSION || manifest.version);
}

export async function prepareRelease(root, input) {
  const version = releaseVersion(input);
  const source = repository(root);
  if (
    git(root, ['status', '--porcelain', '--untracked-files=normal', '--', ...releaseFiles]).trim()
  )
    throw new Error(
      'Commit or restore changes to the desktop release files before preparing a release.',
    );
  if (tagExists(root, `desktop-v${version}`))
    throw new Error(`Tag desktop-v${version} already exists.`);
  const [pkg, lock, changelog] = await Promise.all([
    readJson(root, releaseFiles[0]),
    readJson(root, releaseFiles[1]),
    readFile(resolve(root, releaseFiles[3]), 'utf8'),
  ]);
  const current = packageVersions(pkg, lock);
  const previousTag = latestTag(root, source);
  if (
    compareVersions(version, current) < 0 ||
    (previousTag &&
      (compareVersions(version, current) === 0 ||
        compareVersions(version, previousTag.slice(9)) <= 0))
  )
    throw new Error(
      'The release version must increase beyond the current package and previous desktop release.',
    );
  if (new RegExp(`^## ${version.replaceAll('.', '\\.')} - `, 'm').test(changelog))
    throw new Error(`The changelog already contains desktop version ${version}.`);
  const commits = releaseCommits(root, previousTag, source);
  const manifest = { version, previousTag, source };
  const notes = [
    `## ${version} - ${new Date().toISOString().slice(0, 10)}`,
    '',
    `Source: \`${source}\``,
    `Previous release: ${previousTag ? `\`${previousTag}\`` : 'none'}`,
    '',
    ...commits.slice(0, 100).map(({ sha, subject }) => `- ${subject} (${sha.slice(0, 7)})`),
    ...(commits.length > 100
      ? ['', 'More commits are included; review the full Git history.']
      : []),
    '',
  ].join('\n');
  if (Buffer.byteLength(notes) > maximumNotesBytes)
    throw new Error('The desktop release notes exceed 64 KiB.');
  const firstSection = changelog.search(/^## /m);
  const prefix = (firstSection < 0 ? changelog : changelog.slice(0, firstSection)).trimEnd();
  const history = firstSection < 0 ? '' : changelog.slice(firstSection).trim();
  pkg.version = version;
  lock.version = version;
  lock.packages[''].version = version;
  const output = [
    JSON.stringify(pkg, null, 2) + '\n',
    JSON.stringify(lock, null, 2) + '\n',
    JSON.stringify(manifest, null, 2) + '\n',
    `${prefix}\n\n${notes}${history ? `\n${history}\n` : ''}`,
  ];
  for (let index = 0; index < releaseFiles.length; index++)
    await writeFile(resolve(root, releaseFiles[index]), output[index]);
  return manifest;
}

export async function checkRelease(root, input) {
  const version = releaseVersion(input);
  if (process.env.OTTO_RELEASE_PLAN) {
    if (process.env.GITHUB_ACTIONS !== 'true')
      throw new Error('Generated release plans are only accepted in GitHub Actions.');
    return checkReleasePlan(
      root,
      version,
      process.env.OTTO_RELEASE_PLAN,
      process.env.OTTO_RELEASE_PLAN_SHA256,
    );
  }
  const head = repository(root);
  for (const file of releaseFiles) {
    const committed = git(root, ['show', `HEAD:${file}`]);
    if (committed !== (await readFile(resolve(root, file), 'utf8')))
      throw new Error(`Commit ${file} before validating the release.`);
  }
  const [pkg, lock, manifest, changelog] = await Promise.all([
    readJson(root, releaseFiles[0]),
    readJson(root, releaseFiles[1]),
    readJson(root, releaseFiles[2]),
    readFile(resolve(root, releaseFiles[3]), 'utf8'),
  ]);
  if (
    packageVersions(pkg, lock) !== version ||
    manifest.version !== version ||
    Object.keys(manifest).sort().join(',') !== 'previousTag,source,version' ||
    !/^[a-f0-9]{40}$/.test(manifest.source ?? '')
  )
    throw new Error('Desktop release manifest and package versions are inconsistent.');
  if (git(root, ['merge-base', '--is-ancestor', manifest.source, head], true) === null)
    throw new Error('The release source must be an ancestor of the current commit.');
  if (
    git(root, ['diff', '--name-only', '-z', manifest.source, head])
      .split('\0')
      .some((file) => file && !releaseFiles.includes(file))
  )
    throw new Error('Source changes landed after release preparation; regenerate the release PR.');
  if (manifest.previousTag !== latestTag(root, manifest.source))
    throw new Error('The manifest previous tag does not match the release source history.');
  if (manifest.previousTag && compareVersions(version, manifest.previousTag.slice(9)) <= 0)
    throw new Error('The release version must exceed the previous desktop tag.');
  if (
    tagExists(root, `desktop-v${version}`) &&
    git(root, ['rev-parse', `refs/tags/desktop-v${version}^{commit}`]).trim() !== head
  )
    throw new Error('The desktop release tag already points to another commit.');
  const notes = currentNotes(changelog, version);
  if (
    !notes.includes(`\nSource: \`${manifest.source}\`\n`) ||
    !notes.includes(
      `\nPrevious release: ${manifest.previousTag ? `\`${manifest.previousTag}\`` : 'none'}\n`,
    ) ||
    !/^\- .+ \([a-f0-9]{7}\)$/m.test(notes)
  )
    throw new Error('The current changelog section does not match the release manifest.');
  return { ...manifest, notes };
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length > (args[0] === '--notes' ? 2 : 1) ||
    (args.length && !['--check', '--notes'].includes(args[0]))
  )
    throw new Error('Usage: prepare-desktop-release.mjs [--check | --notes [output-file]]');
  const root = process.cwd();
  const version = releaseVersion(
    process.env.OTTO_RELEASE_VERSION ??
      (args.length ? (await configuredRelease(root)).version : undefined),
  );
  if (!args.length) {
    const manifest = await prepareRelease(root, version);
    process.stdout.write(`Prepared desktop-v${version} from ${manifest.source}.\n`);
  } else {
    const release = await checkRelease(root, version);
    if (args[0] === '--notes') {
      if (args[1]) await writeFile(resolve(root, args[1]), release.notes);
      else process.stdout.write(release.notes);
    } else process.stdout.write(`Validated desktop-v${version}.\n`);
  }
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
