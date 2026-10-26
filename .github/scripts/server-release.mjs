import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function github(route, { method = 'GET', body, file, paginate = false } = {}) {
  const args = ['api', route, '--method', method];
  if (paginate) args.push('--paginate', '--slurp');
  if (body) args.push('--input', '-');
  if (file) args.push('--input', file, '--header', 'Content-Type: application/octet-stream');
  try {
    const value = JSON.parse(
      execFileSync('gh', args, {
        encoding: 'utf8',
        input: body && JSON.stringify(body),
        maxBuffer: 4 * 1024 ** 2,
        timeout: 15 * 60_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
    return paginate ? value.flat() : value;
  } catch {
    throw new Error(
      'GitHub release access failed. Check permissions and inspect the draft before retrying.',
    );
  }
}

async function hash(path) {
  const value = createHash('sha256');
  for await (const bytes of createReadStream(path)) value.update(bytes);
  return value.digest('hex');
}

export async function draftServerRelease({
  root = process.cwd(),
  directory,
  environment = process.env,
  request = github,
}) {
  const source = environment.GITHUB_SHA;
  const repository = environment.GITHUB_REPOSITORY;
  if (
    environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    environment.GITHUB_REF !== 'refs/heads/main' ||
    environment.NOD_DRAFT_RELEASE !== 'true' ||
    !/^[a-f0-9]{40}$/.test(source || '') ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') ||
    !/^[1-9][0-9]*$/.test(environment.GITHUB_RUN_ID || '') ||
    !/^[1-9][0-9]*$/.test(environment.GITHUB_RUN_ATTEMPT || '')
  )
    throw new Error('Server release drafts require an explicit manual run from main.');
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !== source)
    throw new Error('The checkout does not match the tested workflow source.');
  const prefix = `repos/${repository}`;
  if (request(prefix).private !== true)
    throw new Error('Server release drafts are restricted to the private source repository.');

  const assets = [];
  for (const architecture of ['amd64', 'arm64']) {
    const name = `nod-server-linux-${architecture}-${source}.tar.gz`;
    for (const filename of [name, `${name}.sha256`]) {
      const path = join(directory, filename);
      const info = await lstat(path);
      if (!info.isFile() || info.size <= 0 || info.size >= 2 * 1024 ** 3)
        throw new Error('Release assets must be regular files smaller than 2 GiB.');
      if (filename.endsWith('.sha256') && info.size > 256)
        throw new Error('Invalid bundle checksum file.');
      assets.push({ name: filename, path, size: info.size, digest: `sha256:${await hash(path)}` });
    }
    const archive = assets.at(-2);
    if (
      (await readFile(join(directory, `${name}.sha256`), 'utf8')) !==
      `${archive.digest.slice(7)}  ${name}\n`
    )
      throw new Error('The bundle checksum does not match its archive.');
    for (const [file, expected] of [
      ['source-revision', source],
      ['architecture', architecture],
    ]) {
      const value = execFileSync(
        'tar',
        ['-xOzf', archive.path, `nod-server-linux-${architecture}/${file}`],
        {
          encoding: 'utf8',
          maxBuffer: 1024,
          timeout: 5 * 60_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      if (value !== `${expected}\n`)
        throw new Error('The bundle contents do not match the tested source and architecture.');
    }
  }
  if (
    (await readdir(directory)).sort().join('\n') !==
    assets
      .map(({ name }) => name)
      .sort()
      .join('\n')
  )
    throw new Error('Unexpected files in the release artifacts.');

  const tag = `server-${source}`;
  const ref = `refs/tags/${tag}`;
  const refs = request(`${prefix}/git/matching-refs/tags/${tag}`);
  const releases = request(`${prefix}/releases?per_page=100`, { paginate: true });
  if (!Array.isArray(refs) || !Array.isArray(releases))
    throw new Error('Invalid GitHub release state.');
  if (refs.some((entry) => entry.ref === ref) || releases.some((entry) => entry.tag_name === tag))
    throw new Error(
      'A release or tag already exists for this source. Inspect it; nothing was replaced.',
    );

  const verifyRef = (entry) => {
    if (entry?.ref !== ref || entry.object?.type !== 'commit' || entry.object.sha !== source)
      throw new Error('The release tag does not identify the tested source.');
  };
  verifyRef(request(`${prefix}/git/refs`, { method: 'POST', body: { ref, sha: source } }));
  const run = `https://github.com/${repository}/actions/runs/${environment.GITHUB_RUN_ID}/attempts/${environment.GITHUB_RUN_ATTEMPT}`;
  const body = `Private Linux server bundles from ${source}.\n\nBoth native architectures passed the server and standalone installer checks in [this workflow run](${run}).\n\nReview the checks, deployment notes and checksums before publishing this draft within the private repository.\n`;
  const release = request(`${prefix}/releases`, {
    method: 'POST',
    body: {
      tag_name: tag,
      target_commitish: source,
      name: `Nod server ${source.slice(0, 12)}`,
      body,
      draft: true,
      prerelease: false,
      make_latest: 'false',
    },
  });
  const verifyRelease = (entry) => {
    if (
      !Number.isSafeInteger(entry?.id) ||
      entry.id <= 0 ||
      entry.id !== release.id ||
      entry.tag_name !== tag ||
      entry.target_commitish !== source ||
      entry.draft !== true ||
      entry.body !== body ||
      !Array.isArray(entry.assets)
    )
      throw new Error('The private draft release does not match the tested source.');
  };
  verifyRelease(release);
  if (release.assets.length) throw new Error('Refusing a draft that already contains assets.');
  for (const asset of assets) {
    const uploaded = request(
      `https://uploads.github.com/${prefix}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`,
      {
        method: 'POST',
        file: asset.path,
      },
    );
    if (
      uploaded?.name !== asset.name ||
      uploaded.digest !== asset.digest ||
      uploaded.size !== asset.size ||
      uploaded.state !== 'uploaded'
    )
      throw new Error('The uploaded release asset does not match the tested bundle.');
  }
  const saved = request(`${prefix}/releases/${release.id}`);
  verifyRelease(saved);
  if (
    saved.assets.length !== assets.length ||
    assets.some((asset) => {
      const matches = saved.assets.filter((entry) => entry.name === asset.name);
      return (
        matches.length !== 1 ||
        matches[0].digest !== asset.digest ||
        matches[0].size !== asset.size ||
        matches[0].state !== 'uploaded'
      );
    })
  )
    throw new Error('The saved draft assets do not match the tested bundles.');
  verifyRef(request(`${prefix}/git/ref/tags/${tag}`));
  return { tag, source, url: `https://github.com/${repository}/releases` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await draftServerRelease({
    directory: resolve(process.argv[2] || '.local/server-release'),
  });
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `Prepared private draft \`${result.tag}\` from \`${result.source}\`. Both architectures and all four uploaded asset digests passed. Review it in [Releases](${result.url}); this workflow does not publish it.\n`,
    );
  console.log(JSON.stringify(result));
}
