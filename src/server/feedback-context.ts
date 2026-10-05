import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FeedbackContext } from '../shared/feedback.ts';

const execute = promisify(execFile);

export async function feedbackContext(options: {
  runtimeMode: 'local' | 'gateway' | 'tenant';
  environment: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<Omit<FeedbackContext, 'enabled'>> {
  const { runtimeMode, environment } = options;
  const development = runtimeMode === 'local' && environment.NODE_ENV !== 'production';
  let appRelease = environment.OTTO_IMAGE_RELEASE || environment.OTTO_RELEASE || null;
  let appModified: boolean | null = null;
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
    appVersion: environment.OTTO_APP_VERSION?.trim() || null,
    appRelease,
    development,
    source: runtimeMode === 'local' ? 'local-web' : 'hosted-web',
    appModified,
    computerName: null,
    platform: null,
  };
}
