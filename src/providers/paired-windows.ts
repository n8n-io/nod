import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, symlink, unlink, lstat, readlink } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { DesktopControl, DesktopRequest } from '../ports/desktop.ts';

export function pairedWindows(directory: string) {
  let peer: Socket | undefined;
  let generation: string | undefined;
  let socketPath = '';
  const link = join(directory, 'current');
  const changed = new Set<() => void>();
  const pending = new Map<
    string,
    {
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
    }
  >();
  const server = createServer((connection) => {
    if (peer) {
      connection.destroy();
      return;
    }
    peer = connection;
    generation = randomUUID();
    connection.write(JSON.stringify({ version: 1, ready: true }) + '\n');
    const reader = createInterface({ input: connection, crlfDelay: Infinity });
    connection.on('error', () => connection.destroy());
    reader.on('line', (line) => {
      try {
        if (line.length > 12_000_000) throw Error('Oversized reply');
        const result = JSON.parse(line);
        const item = pending.get(result.id);
        if (!item || peer !== connection) return;
        if (typeof result.error === 'string') item.reject(Error(result.error.slice(0, 400)));
        else if (
          result.result &&
          typeof result.result === 'object' &&
          !Array.isArray(result.result)
        )
          item.resolve(result.result);
        else throw Error('Invalid desktop result');
      } catch {
        connection.destroy();
      }
    });
    connection.once('close', () => {
      reader.close();
      if (peer !== connection) return;
      peer = undefined;
      generation = undefined;
      for (const job of [...pending.values()])
        job.reject(Error('Windows sharing ended. Check the current app before trying again.'));
      for (const cb of changed) cb();
    });
  });
  async function start() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.mode & 0o077 || stat.uid !== process.getuid?.())
      throw Error('Windows sharing needs a private socket directory owned by Nod.');
    const privateDir = await mkdtemp(join(directory, 'session-'));
    socketPath = join(privateDir, 'pc.sock');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await chmod(socketPath, 0o600);
    const previous = await lstat(link).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
    if (previous) {
      if (!previous.isSymbolicLink()) throw Error('Invalid Windows sharing socket link.');
      await unlink(link);
    }
    await symlink(socketPath, link);
  }
  function request(input: DesktopRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    const socket = peer;
    if (!socket || socket.destroyed)
      return Promise.reject(Error('Open Nod on the paired Windows PC and start sharing an app.'));
    if (pending.size >= 48) return Promise.reject(Error('The Windows PC is busy.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        if (!socket.destroyed) socket.write(JSON.stringify({ cancel: id }) + '\n');
        finish();
        reject(Error('The Windows step was stopped. Check the app before trying again.'));
      };
      const timer = setTimeout(cancel, 90_000);
      const finish = () => {
        clearTimeout(timer);
        pending.delete(id);
        signal?.removeEventListener('abort', cancel);
      };
      pending.set(id, {
        resolve(value) {
          finish();
          resolve(value);
        },
        reject(err) {
          finish();
          reject(err);
        },
      });
      signal?.addEventListener('abort', cancel, { once: true });
      socket.write(JSON.stringify({ id, request: input }) + '\n');
    });
  }
  const control: DesktopControl = {
    request,
    get session() {
      return generation;
    },
    paired: true,
    onDisconnect(cb) {
      changed.add(cb);
    },
    async close() {
      peer?.destroy();
      if ((await readlink(link).catch(() => '')) === socketPath) await unlink(link);
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return { start, control };
}
