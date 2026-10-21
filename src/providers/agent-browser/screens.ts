import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { z } from 'zod';
import { threadIdentity } from '../../ports/thread-identity.ts';
import { BrowserActionError, browserRequestBytes } from '../../ports/computer.ts';

const storedScreen = z.object({
  version: z.literal(1),
  url: z.string(),
  sensitive: z.boolean(),
  active: z.boolean(),
  navigationFailed: z.boolean().optional(),
  restoreSession: z.boolean().optional(),
  scripted: z.boolean().optional(),
  profileId: z.uuid().optional(),
  resumeUrl: z.string().optional(),
  capturedAt: z.iso.datetime().optional(),
  timeZone: z.string().max(100).optional(),
  locale: z.string().max(35).optional(),
});
export type StoredScreen = z.infer<typeof storedScreen>;

export function createScreenStore(root: string) {
  const path = (id: string) => resolve(root, `screen-${threadIdentity(id)}.png`);
  const metadata = (id: string) => resolve(root, `screen-${threadIdentity(id)}.json`);
  return {
    path,
    async clearImage(id: string) {
      await rm(path(id), { force: true });
    },
    async profileScreens(profileId: string) {
      const files = await readdir(root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const ids = files
        .map((file) => /^screen-([A-Za-z0-9_-]{1,100})\.json$/.exec(file)?.[1])
        .filter((id): id is string => Boolean(id));
      const matches = await Promise.all(
        ids.map(async (id) => ((await this.load(id))?.profileId === profileId ? id : null)),
      );
      return matches.filter((id): id is string => Boolean(id));
    },
    async delete(id: string) {
      await Promise.all([rm(path(id), { force: true }), rm(metadata(id), { force: true })]);
    },
    async load(id: string): Promise<StoredScreen | null> {
      try {
        return storedScreen.parse(JSON.parse(await readFile(metadata(id), 'utf8')));
      } catch {
        return null;
      }
    },
    async save(id: string, value: StoredScreen) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const temporary = metadata(id) + '.' + randomUUID();
      await writeFile(temporary, JSON.stringify(storedScreen.parse(value)), { mode: 0o600 });
      await rename(temporary, metadata(id));
    },
    async read(id: string): Promise<Buffer | null> {
      try {
        const image = await readFile(path(id));
        return image.length ? image : null;
      } catch {
        return null;
      }
    },
    async accept(id: string, temporary: string): Promise<Buffer> {
      await chmod(temporary, 0o600);
      const buffer = await readFile(temporary);
      if (!buffer.length) throw new Error('The browser screenshot is empty.');
      await rename(temporary, path(id));
      return buffer;
    },
  };
}

export class DaemonCommandError extends Error {
  constructor(readonly detail?: string) {
    super('Browser action could not complete. Observe the page again before retrying.');
  }
}

export class DaemonTransportError extends Error {
  constructor(
    readonly kind:
      | 'timeout'
      | 'aborted'
      | 'socket_error'
      | 'socket_closed'
      | 'response_limit'
      | 'invalid_response',
  ) {
    super(
      kind === 'aborted'
        ? 'Browser observation cancelled.'
        : kind === 'response_limit'
          ? 'Browser observation exceeded its limit.'
          : 'The previous browser is unavailable.',
    );
  }
}

function interceptedClick(command: Record<string, unknown>, error: unknown): boolean {
  if (
    command.action !== 'click' ||
    typeof command.selector !== 'string' ||
    typeof error !== 'string'
  )
    return false;
  const prefix = `Element '${command.selector}' is covered by <`;
  const suffix =
    '> at its click point, so the input would land on that element instead. Dismiss or interact with the covering element first (it is often a dialog, banner, or sticky header).';
  if (!error.startsWith(prefix) || !error.endsWith(suffix)) return false;
  return /^[a-z][a-z0-9-]*(?:[#.][^<>\u0000-\u001f]{1,512}| inside [a-z][a-z0-9-]*#[^<>\u0000-\u001f]{1,512})?$/.test(
    error.slice(prefix.length, -suffix.length),
  );
}

export function daemonDeadline(command: Record<string, unknown>) {
  const operation = Number(command.timeout);
  return Math.max(60_000, (Number.isFinite(operation) ? operation : 0) + 30_000);
}

export function existingDaemonCommand(
  path: string,
  command: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs = daemonDeadline(command),
  maxBytes = browserRequestBytes,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.setEncoding('utf8');
    let received = '';
    let settled = false;
    const stop = (error?: Error, data?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(data ?? {});
    };
    const abort = () => stop(new DaemonTransportError('aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(() => stop(new DaemonTransportError('timeout')), timeoutMs);
    socket.once('error', (error: NodeJS.ErrnoException) =>
      command.action === 'close' && ['ENOENT', 'ECONNREFUSED'].includes(error.code ?? '')
        ? stop(undefined, {})
        : stop(new DaemonTransportError('socket_error')),
    );
    socket.once('end', () => stop(new DaemonTransportError('socket_closed')));
    socket.once('connect', () =>
      socket.write(JSON.stringify({ id: randomUUID(), ...command }) + '\n'),
    );
    socket.on('data', (chunk: string) => {
      received += chunk;
      if (Buffer.byteLength(received) > maxBytes)
        return stop(new DaemonTransportError('response_limit'));
      const end = received.indexOf('\n');
      if (end < 0) return;
      try {
        const response = JSON.parse(received.slice(0, end));
        if (response.success === false) {
          if (interceptedClick(command, response.error))
            return stop(new BrowserActionError('browser_click_intercepted'));
          if (
            command.action === 'navigate' &&
            typeof response.error === 'string' &&
            /^Navigation failed: net::ERR_[A-Z_]+/.test(response.error)
          )
            return stop(new BrowserActionError('browser_navigation_failed'));
          return stop(
            new DaemonCommandError(typeof response.error === 'string' ? response.error : undefined),
          );
        }
        if (response.success !== true) throw new Error();
        stop(undefined, response.data ?? {});
      } catch {
        stop(new DaemonTransportError('invalid_response'));
      }
    });
  });
}
