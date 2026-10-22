import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const releaseFiles = ['desktop/package.json', 'desktop/release.json', 'desktop/CHANGELOG.md'];
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const maximumNotesBytes = 64 * 1024;

export function releaseVersion(value) {
  if (typeof value !== 'string' || value.length > 64 || !versionPattern.test(value))
    throw new Error('NOD_RELEASE_VERSION must be a stable semantic version, such as 0.1.0.');
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
  const tags = git(root, ['tag', '--merged', source, '--list', 'nod-v*'])
    .trim()
    .split('\n')
    .filter((tag) => versionPattern.test(tag.slice('nod-v'.length)));
  return tags.sort((a, b) => compareVersions(b.slice(5), a.slice(5)))[0] ?? null;
}

export function isReleaseMerge(pull, source, sourceRepository) {
  return Boolean(
    pull.merged_at &&
    pull.merge_commit_sha === source &&
    pull.base?.ref === 'main' &&
    pull.base?.repo?.full_name === sourceRepository &&
    pull.head?.ref === 'release/desktop' &&
    pull.head?.repo?.full_name === sourceRepository,
  );
}

async function readJson(root, file) {
  try {
    return JSON.parse(await readFile(resolve(root, file), 'utf8'));
  } catch {
    throw new Error(`Could not read ${file}.`);
  }
}

function releaseCommits(root, previousTag, source, allowEmpty = false) {
  const exclusions = [':(exclude)desktop/release.json', ':(exclude)desktop/CHANGELOG.md'];
  const scope = previousTag ? ['.', ...exclusions] : ['desktop', ...exclusions];
  if (
    !allowEmpty &&
    previousTag &&
    !git(root, ['diff', '--name-only', previousTag, source, '--', ...scope]).trim()
  )
    throw new Error('There are no changes to release since the previous desktop tag.');
  const entries = git(root, [
    'log',
    '--no-merges',
    '--max-count=101',
    '--format=%H%x00%s%x00%b%x00',
    previousTag ? `${previousTag}..${source}` : source,
    '--',
    ...scope,
  ]).split('\0');
  const commits = [];
  for (let index = 0; index + 2 < entries.length; index += 3) {
    const sha = entries[index].trim();
    const subject = entries[index + 1];
    if (!/^[a-f0-9]{40}$/.test(sha) || subject.length > 2000 || /[\r\n\0]/.test(subject))
      throw new Error('Commit history cannot be represented as bounded release notes.');
    commits.push({ sha, subject, body: entries[index + 2] });
  }
  if (!commits.length && !allowEmpty) throw new Error('There are no desktop changes to release.');
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

export function releaseNotes(root, version, previousTag, source, date, allowEmpty = false) {
  const commits = releaseCommits(root, previousTag, source, allowEmpty);
  const repository = `https://github.com/${process.env.GITHUB_REPOSITORY || 'n8n-io/nod'}`;
  const groups = new Map(
    [
      'Breaking changes',
      'Features',
      'Fixes',
      'Performance',
      'Documentation',
      'Other changes',
      'Maintenance',
    ].map((name) => [name, []]),
  );
  const escape = (value) => value.replace(/[\\`*_~[\]<>]/g, '\\$&');
  for (const { sha, subject, body } of commits.slice(0, 100)) {
    const match = /^(\w+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/.exec(subject);
    if (match?.[1] === 'chore' && match[2] === 'release') continue;
    const breaking = /(?:^|\n)BREAKING[ -]CHANGE:\s*(.+)/.exec(body);
    const group =
      match?.[3] || breaking
        ? 'Breaking changes'
        : {
            feat: 'Features',
            fix: 'Fixes',
            perf: 'Performance',
            docs: 'Documentation',
            build: 'Maintenance',
            ci: 'Maintenance',
            chore: 'Maintenance',
            refactor: 'Maintenance',
            test: 'Maintenance',
            style: 'Maintenance',
          }[match?.[1]] || 'Other changes';
    const title = (match?.[4] || subject).replace(/\s*\(#\d+\)$/, '');
    const scope = match?.[2] ? `**${escape(match[2])}:** ` : '';
    const pull = /\(#(\d+)\)$/.exec(subject);
    const link = pull
      ? `[#${pull[1]}](${repository}/pull/${pull[1]})`
      : `[commit](${repository}/commit/${sha})`;
    groups
      .get(group)
      .push(
        `- ${scope}${escape(title.charAt(0).toUpperCase() + title.slice(1))}${breaking ? ` — ${escape(breaking[1])}` : ''}. ${link} (${sha.slice(0, 7)})`,
      );
  }
  const notes = [
    `## ${version} - ${date}`,
    '',
    ...[...groups].flatMap(([name, entries]) =>
      !entries.length
        ? []
        : name === 'Maintenance'
          ? [
              '<details>',
              `<summary>Maintenance (${entries.length} changes)</summary>`,
              '',
              ...entries,
              '',
              '</details>',
              '',
            ]
          : [`### ${name}`, '', ...entries, ''],
    ),
    ...(!commits.length ? ['- Build of the same tested source.', ''] : []),
    ...(commits.length > 100
      ? ['', 'More commits are included; review the full Git history.']
      : []),
    ...(previousTag
      ? [`[Full changelog](${repository}/compare/${previousTag}...${source})`, '']
      : []),
    '<details>',
    '<summary>Build details</summary>',
    '',
    `Source: \`${source}\``,
    `Previous release: ${previousTag ? `\`${previousTag}\`` : 'none'}`,
    '',
    '</details>',
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
      /^nod-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(release.tag_name),
    )
    .sort((a, b) => compareVersions(b.tag_name.slice(5), a.tag_name.slice(5)));
  const previous = desktop.find((release) => release.draft === false);
  if (!previous) throw new Error('Automatic releases require a published desktop baseline.');
  const previousTag = previous.tag_name;
  if (
    !tagExists(root, previousTag) ||
    git(root, ['merge-base', '--is-ancestor', previousTag, source], true) === null
  )
    throw new Error('The latest published desktop tag must belong to this source history.');
  const marker = `Source: https://github.com/${sourceRepository}/commit/${source}`;
  const pending = desktop.find(
    (release) => release.draft === true && release.target_commitish === source,
  );
  let version;
  if (pending) {
    if (
      !pending.body?.includes(marker) ||
      compareVersions(pending.tag_name.slice(5), previousTag.slice(5)) <= 0
    )
      throw new Error('The pending desktop release does not match this source and version.');
    version = pending.tag_name.slice(5);
  } else {
    const [major, minor, patch] = previousTag.slice(5).split('.');
    const reserved = new Set([
      ...desktop.map((release) => release.tag_name),
      ...git(root, ['tag', '--list', 'nod-v*']).trim().split('\n'),
    ]);
    let next = BigInt(patch) + 1n;
    while (reserved.has(`nod-v${major}.${minor}.${next}`)) next++;
    version = releaseVersion(`${major}.${minor}.${next}`);
  }
  const date = new Date().toISOString().slice(0, 10);
  return {
    version,
    previousTag,
    source,
    date,
    notes: releaseNotes(root, version, previousTag, source, date, true),
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
    Object.keys(plan).sort().join(',') !== 'date,notes,previousTag,source,version' ||
    plan.version !== releaseVersion(input) ||
    plan.source !== source ||
    typeof plan.date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(plan.date) ||
    !Number.isFinite(Date.parse(plan.date)) ||
    new Date(plan.date).toISOString().slice(0, 10) !== plan.date ||
    !/^nod-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(plan.previousTag) ||
    compareVersions(plan.version, plan.previousTag.slice(5)) <= 0 ||
    !tagExists(root, plan.previousTag) ||
    git(root, ['merge-base', '--is-ancestor', plan.previousTag, source], true) === null ||
    git(root, ['status', '--porcelain', '--untracked-files=no']).trim()
  )
    throw new Error('The release plan does not match the clean tested source.');
  if (plan.notes !== releaseNotes(root, plan.version, plan.previousTag, source, plan.date, true))
    throw new Error('The release plan notes do not match the source changes.');
  if (
    tagExists(root, `nod-v${plan.version}`) &&
    git(root, ['rev-parse', `refs/tags/nod-v${plan.version}^{commit}`]).trim() !== source
  )
    throw new Error('The desktop release tag already points to another commit.');
  return plan;
}

export async function configuredRelease(root) {
  const path = process.env.NOD_RELEASE_PLAN || releaseFiles[1];
  const manifest = await readJson(root, path);
  return checkRelease(root, process.env.NOD_RELEASE_VERSION || manifest.version);
}

export async function prepareRelease(root, input) {
  const source = repository(root);
  const previousTag = latestTag(root, source);
  const [major, minor, patch] = (
    previousTag?.slice(5) || (await readJson(root, releaseFiles[0])).version
  ).split('.');
  const version = releaseVersion(input || `${major}.${minor}.${BigInt(patch) + 1n}`);
  if (
    git(root, ['status', '--porcelain', '--untracked-files=normal', '--', ...releaseFiles]).trim()
  )
    throw new Error(
      'Commit or restore changes to the desktop release files before preparing a release.',
    );
  if (tagExists(root, `nod-v${version}`)) throw new Error(`Tag nod-v${version} already exists.`);
  const [pkg, changelog] = await Promise.all([
    readJson(root, releaseFiles[0]),
    readFile(resolve(root, releaseFiles[2]), 'utf8'),
  ]);
  const current = releaseVersion(pkg.version);
  if (
    compareVersions(version, current) < 0 ||
    (previousTag &&
      (compareVersions(version, current) === 0 ||
        compareVersions(version, previousTag.slice(5)) <= 0))
  )
    throw new Error(
      'The release version must increase beyond the current package and previous desktop release.',
    );
  if (new RegExp(`^## ${version.replaceAll('.', '\\.')} - `, 'm').test(changelog))
    throw new Error(`The changelog already contains desktop version ${version}.`);
  const manifest = { version, previousTag, source };
  const notes = releaseNotes(
    root,
    version,
    previousTag,
    source,
    new Date().toISOString().slice(0, 10),
  );
  const firstSection = changelog.search(/^## /m);
  const prefix = (firstSection < 0 ? changelog : changelog.slice(0, firstSection)).trimEnd();
  const history = firstSection < 0 ? '' : changelog.slice(firstSection).trim();
  pkg.version = version;
  const output = [
    JSON.stringify(pkg, null, 2) + '\n',
    JSON.stringify(manifest, null, 2) + '\n',
    `${prefix}\n\n${notes}${history ? `\n${history}\n` : ''}`,
  ];
  for (let index = 0; index < releaseFiles.length; index++)
    await writeFile(resolve(root, releaseFiles[index]), output[index]);
  return manifest;
}

export async function checkRelease(root, input) {
  const version = releaseVersion(input);
  if (process.env.NOD_RELEASE_PLAN) {
    if (process.env.GITHUB_ACTIONS !== 'true')
      throw new Error('Generated release plans are only accepted in GitHub Actions.');
    return checkReleasePlan(
      root,
      version,
      process.env.NOD_RELEASE_PLAN,
      process.env.NOD_RELEASE_PLAN_SHA256,
    );
  }
  const head = repository(root);
  for (const file of releaseFiles) {
    const committed = git(root, ['show', `HEAD:${file}`]);
    if (committed !== (await readFile(resolve(root, file), 'utf8')))
      throw new Error(`Commit ${file} before validating the release.`);
  }
  const [pkg, manifest, changelog] = await Promise.all([
    readJson(root, releaseFiles[0]),
    readJson(root, releaseFiles[1]),
    readFile(resolve(root, releaseFiles[2]), 'utf8'),
  ]);
  if (
    releaseVersion(pkg.version) !== version ||
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
  if (manifest.previousTag && compareVersions(version, manifest.previousTag.slice(5)) <= 0)
    throw new Error('The release version must exceed the previous desktop tag.');
  if (
    tagExists(root, `nod-v${version}`) &&
    git(root, ['rev-parse', `refs/tags/nod-v${version}^{commit}`]).trim() !== head
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
  let version;
  if (!args.length) {
    const manifest = await prepareRelease(root, process.env.NOD_RELEASE_VERSION);
    version = manifest.version;
    if (process.env.NOD_RELEASE_NOTES_FILE)
      await writeFile(
        process.env.NOD_RELEASE_NOTES_FILE,
        currentNotes(await readFile(resolve(root, releaseFiles[2]), 'utf8'), version),
      );
    process.stdout.write(`Prepared nod-v${version} from ${manifest.source}.\n`);
  } else {
    version = releaseVersion(
      process.env.NOD_RELEASE_VERSION || (await configuredRelease(root)).version,
    );
    const release = await checkRelease(root, version);
    if (args[0] === '--notes') {
      if (args[1]) await writeFile(resolve(root, args[1]), release.notes);
      else process.stdout.write(release.notes);
    } else process.stdout.write(`Validated nod-v${version}.\n`);
  }
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
