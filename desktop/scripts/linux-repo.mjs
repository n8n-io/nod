import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { linuxReleaseFiles } from './linux-release.mjs';

const defaultRun = promisify(execFile);
const ref = 'app/io.n8n.Nod/x86_64/stable';

export async function publishLinuxRepo({
  root,
  repo,
  key,
  gpgHome,
  version,
  source,
  run = defaultRun,
}) {
  if (!key)
    throw new Error('Set NOD_FLATPAK_REPO_KEY to the GPG key that signs the Linux repository.');
  const [manifestPath, , bundle] = await linuxReleaseFiles(root, { version, source });
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const signing = [`--gpg-sign=${key}`, ...(gpgHome ? [`--gpg-homedir=${gpgHome}`] : [])];
  await mkdir(repo, { recursive: true });
  if (
    !(await access(join(repo, 'config')).then(
      () => true,
      () => false,
    ))
  )
    await run('ostree', [`--repo=${repo}`, 'init', '--mode=archive-z2']);
  const staging = await mkdtemp(join(tmpdir(), 'nod-linux-repo-'));
  try {
    await run('ostree', [`--repo=${staging}`, 'init', '--mode=archive-z2']);
    await run('flatpak', ['build-import-bundle', staging, bundle]);
    const { stdout } = await run('ostree', [`--repo=${staging}`, 'rev-parse', ref]);
    if (stdout.trim() !== manifest.commit)
      throw new Error('The Linux repository does not hold the commit in the release manifest.');
    await run('ostree', [`--repo=${repo}`, 'pull-local', staging, ref]);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  await run('flatpak', ['build-sign', '--arch=x86_64', ...signing, repo, 'io.n8n.Nod', 'stable']);
  await run('flatpak', [
    'build-update-repo',
    ...signing,
    '--generate-static-deltas',
    '--prune',
    repo,
  ]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await publishLinuxRepo({
    root: process.cwd(),
    repo: resolve(process.argv[2] ?? '.local/flatpak-publish'),
    key: process.env.NOD_FLATPAK_REPO_KEY,
    gpgHome: process.env.NOD_FLATPAK_GPG_HOME,
    version: process.env.NOD_DESKTOP_VERSION,
    source: process.env.NOD_RELEASE_SOURCE,
  });
}
