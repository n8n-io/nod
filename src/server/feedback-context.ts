import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import type { FeedbackContext } from '../shared/feedback.ts';

export function feedbackTechnicalContext(context: Omit<FeedbackContext, 'enabled' | 'recipient'>) {
  const version = (value: string | null) =>
    value &&
    /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-(?:alpha|beta|rc|canary|dev)(?:[.-]\d{1,6})?)?$/.test(value)
      ? value
      : null;
  return {
    appVersion: version(context.appVersion),
    appRelease:
      context.appRelease && /^[a-f0-9]{7,64}$/.test(context.appRelease)
        ? context.appRelease
        : version(context.appRelease),
    platform:
      context.platform &&
      /^(?:darwin|linux|win32)(?:-(?:arm64|x64|ia32|arm))?$/.test(context.platform)
        ? context.platform
        : null,
    development: context.development === true,
    source: context.source === 'desktop' ? ('desktop' as const) : ('local-web' as const),
    appModified: typeof context.appModified === 'boolean' ? context.appModified : null,
  };
}

export async function feedbackContext(options: {
  environment: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<Omit<FeedbackContext, 'enabled' | 'recipient'>> {
  const execute = promisify(childProcess.execFile);
  const { environment } = options;
  const development = environment.NODE_ENV !== 'production';
  let appRelease: string | null = null;
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
  return feedbackTechnicalContext({
    appVersion: environment.NOD_APP_VERSION?.trim() || null,
    appRelease,
    development,
    source: environment.NOD_DESKTOP === 'true' ? 'desktop' : 'local-web',
    appModified,
    platform: `${process.platform}-${process.arch}`,
  });
}
