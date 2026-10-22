import childProcess from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type { FeedbackContext } from '../shared/feedback.ts';

export async function feedbackContext(options: {
  environment: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<Omit<FeedbackContext, 'enabled' | 'recipient'>> {
  const execute = promisify(childProcess.execFile);
  const { environment } = options;
  const development = environment.NODE_ENV !== 'production';
  let appRelease = environment.NOD_IMAGE_RELEASE || environment.NOD_RELEASE || null;
  let appModified: boolean | null = null;
  let computerName = '';
  try {
    if (os.platform() === 'darwin') {
      const { stdout } = await execute('/usr/sbin/scutil', ['--get', 'ComputerName'], {
        timeout: 2_000,
        maxBuffer: 8_192,
      }).catch(() => ({ stdout: '' }));
      computerName = stdout.trim();
    }
    computerName ||= os.hostname().trim();
  } catch {}
  if (development) {
    try {
      const { stdout } = await execute(
        'git',
        ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
        { cwd: options.cwd, timeout: 1000, maxBuffer: 512 * 1024 },
      );
      const lines = stdout.trim().split('\n');
      const head = lines.find((line) => line.startsWith('# branch.oid '))?.slice(13);
      if (head && /^[a-f0-9]{40,64}$/.test(head)) {
        appRelease = head;
        appModified = lines.some((line) => line && !line.startsWith('#'));
      }
    } catch {}
  }
  return {
    appVersion: environment.NOD_APP_VERSION?.trim() || null,
    appRelease,
    development,
    source: 'local-web',
    appModified,
    computerName: computerName.slice(0, 200) || null,
    platform: null,
  };
}
