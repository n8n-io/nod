import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function sourceAnalyticsVersion(
  root: string,
  production: boolean,
  processVersion?: string,
  savedVersion?: string,
) {
  if (processVersion?.trim()) return processVersion;
  if (savedVersion?.trim()) return savedVersion;
  if (!production) return undefined;
  try {
    const { stdout: topLevel } = await run('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      timeout: 3000,
    });
    if ((await realpath(topLevel.trim())) !== (await realpath(root))) return undefined;
    const { stdout } = await run(
      'git',
      ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
      {
        cwd: root,
        timeout: 3000,
        maxBuffer: 512 * 1024,
      },
    );
    const lines = stdout.trim().split(/\r?\n/);
    const revision = lines.find((line) => line.startsWith('# branch.oid '))?.slice(13);
    return revision &&
      /^[a-f0-9]{40,64}$/.test(revision) &&
      lines.every((line) => line.startsWith('#'))
      ? revision
      : undefined;
  } catch {
    return undefined;
  }
}
