import { chmod, lstat, mkdir, rm, unlink } from 'node:fs/promises';
import { createServer, connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Computer } from '../../ports/computer.ts';
import {
  BrowserActionError,
  browserDownloadBytes,
  browserRequestBytes,
  browserUploadBytes,
} from '../../ports/computer.ts';
import { createAgentBrowserComputer } from '../agent-browser/index.ts';
import { containerBrowserOptions } from './config.ts';
import {
  browserFrame,
  browserMetadata,
  browserResponse,
  browserSocketPath,
  imageBytes,
  responseBytes,
  viewBytes,
  viewFrame,
  type BrowserMetadata,
  type BrowserRequest,
  type BrowserResponse,
} from './protocol.ts';

type Namespace = {
  computer: Promise<Computer & { canCheckpoint?(): boolean }>;
  pending: Map<string, { controller: AbortController; done: Promise<unknown> }>;
  closing?: Promise<void>;
  closeFailed?: boolean;
  quiescing?: boolean;
};

function metadata(computer?: Computer, request?: BrowserRequest): BrowserMetadata {
  const threadId =
    request &&
    ('threadId' in request
      ? request.threadId
      : request.method === 'injectCredentials'
        ? request.input.threadId
        : undefined);
  try {
    const screen = threadId ? computer?.screenStatus?.(threadId) : undefined;
    return browserMetadata.parse({
      status: computer?.status() ?? 'Workspace browser is unavailable.',
      currentSession: computer?.currentSession?.() ?? null,
      ...(screen && { screen: { threadId, ...screen } }),
    });
  } catch {
    return { status: 'Workspace browser is unavailable.', currentSession: null };
  }
}

async function dispatch(computer: Computer, request: BrowserRequest, signal: AbortSignal) {
  signal.throwIfAborted();
  switch (request.method) {
    case 'bindProfile':
      if (!computer.bindProfile) throw new Error();
      return computer.bindProfile(request.threadId, request.profileId);
    case 'deleteProfile':
      if (!computer.deleteProfile) throw new Error();
      return computer.deleteProfile(request.profileId);
    case 'act':
      return computer.act(request.threadId, request.input, signal);
    case 'download': {
      if (!computer.download) throw new Error();
      const file = await computer.download(request.threadId, request.input, signal);
      signal.throwIfAborted();
      if (
        !Buffer.isBuffer(file.bytes) ||
        !file.bytes.length ||
        file.bytes.length > browserDownloadBytes
      )
        throw new Error();
      if (
        typeof file.name !== 'string' ||
        !file.name ||
        file.name.length > 200 ||
        /[/\\\u0000-\u001f\u007f]/.test(file.name)
      )
        throw new Error();
      if (
        typeof file.mimeType !== 'string' ||
        file.mimeType.length > 100 ||
        !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(file.mimeType)
      )
        throw new Error();
      return { data: file.bytes.toString('base64'), name: file.name, mimeType: file.mimeType };
    }
    case 'upload': {
      if (!computer.upload) throw new Error();
      const { data, ...input } = request.input;
      if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error();
      const bytes = Buffer.from(data, 'base64');
      if (!bytes.length || bytes.length > browserUploadBytes || bytes.toString('base64') !== data)
        throw new Error();
      return computer.upload(request.threadId, { ...input, bytes }, signal);
    }
    case 'screenshot': {
      const image = await computer.screenshot(request.threadId, signal);
      if (image && image.length > imageBytes) throw new Error();
      return image?.toString('base64') ?? null;
    }
    case 'currentPage':
      return computer.currentPage(request.threadId);
    case 'injectCredentials':
      return computer.injectCredentials(request.input);
    case 'hold':
      return computer.hold(request.threadId, request.until);
    case 'close':
      return computer.close(request.threadId);
    case 'discard':
      if (!computer.discard) throw new Error();
      return computer.discard(request.threadId);
    case 'status':
      return null;
    case 'view':
    case 'dispose':
    case 'quiesce':
      throw new Error();
  }
}

async function prepareSocket(path: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  try {
    if (!(await lstat(path)).isSocket()) throw new Error('Invalid browser socket.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const alive = await new Promise<boolean>((resolve) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
  if (alive) throw new Error('The workspace browser is already running.');
  await unlink(path);
}

export async function startContainerBrowserWorker(
  options: {
    socketPath?: string;
    dataRoot?: string;
    createComputer?: (
      dataRoot: string,
    ) =>
      | (Computer & { canCheckpoint?(): boolean })
      | Promise<Computer & { canCheckpoint?(): boolean }>;
    maxNamespaces?: number;
    maxPendingPerNamespace?: number;
  } = {},
) {
  const path = options.socketPath ?? browserSocketPath;
  const dataRoot = options.dataRoot ?? '/data';
  const createComputer =
    options.createComputer ?? ((root) => createAgentBrowserComputer(containerBrowserOptions(root)));
  const namespaces = new Map<string, Namespace>();
  const connections = new Set<Socket>();
  let closing = false;
  function namespace(name: string) {
    if (closing) throw new Error();
    let value = namespaces.get(name);
    if (!value) {
      if (namespaces.size >= (options.maxNamespaces ?? 16)) throw new Error();
      value = {
        computer: Promise.resolve().then(() => createComputer(join(dataRoot, name))),
        pending: new Map(),
      };
      namespaces.set(name, value);
    }
    if (value.closing || value.quiescing) throw new Error();
    return value;
  }
  async function dispose(name: string) {
    const entry = namespaces.get(name);
    if (!entry) return;
    if (!entry.closing || entry.closeFailed) {
      entry.closeFailed = false;
      entry.closing = (async () => {
        for (const pending of entry.pending.values()) pending.controller.abort();
        await Promise.allSettled([...entry.pending.values()].map((pending) => pending.done));
        await (await entry.computer).dispose();
        namespaces.delete(name);
      })().catch((error) => {
        entry.closeFailed = true;
        throw error;
      });
    }
    await entry.closing;
  }
  async function quiesce(name: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (closing) throw new Error();
    const entry = namespaces.get(name);
    if (!entry) return true;
    if (entry.closing || entry.quiescing || entry.pending.size) return false;
    entry.quiescing = true;
    const computer = await entry.computer;
    signal.throwIfAborted();
    if (entry.closing || entry.pending.size || computer.canCheckpoint?.() !== true) {
      entry.quiescing = false;
      return false;
    }
    await dispose(name);
    return true;
  }
  await prepareSocket(path);
  let ready = false;
  const server = createServer((socket) => {
    if (!ready) return socket.destroy();
    socket.setEncoding('utf8');
    connections.add(socket);
    let incoming = '';
    let received = 0;
    let request: BrowserRequest | undefined;
    const controller = new AbortController();
    let terminal = false;
    let viewing: Promise<Computer> | undefined;
    let inputs = Promise.resolve();
    const stop = () => {
      controller.abort();
      socket.destroy();
    };
    socket.on('error', stop);
    socket.on('close', () => {
      controller.abort();
      connections.delete(socket);
      if (!terminal && request && !['quiesce', 'view'].includes(request.method))
        void dispose(request.namespace).catch(() => {});
    });
    socket.setTimeout(90_000, stop);
    const view = async (computer: Computer, threadId: string, id: string) => {
      if (!computer.view || !computer.control) throw new Error();
      let sent = 0;
      for await (const image of computer.view(threadId, controller.signal)) {
        const line =
          JSON.stringify(viewFrame.parse({ id, frame: image.toString('base64') })) + '\n';
        sent += line.length;
        if (!socket.write(line))
          await new Promise((resolve) => {
            socket.once('drain', resolve);
            socket.once('close', resolve);
          });
        if (sent > viewBytes || socket.destroyed) break;
      }
      return null;
    };
    const execute = async (input: BrowserRequest) => {
      let entry: Namespace | undefined;
      let registered = false;
      let response: BrowserResponse;
      try {
        if (input.method === 'dispose') {
          await dispose(input.namespace);
          response = { id: input.id, ok: true, result: null, metadata: metadata() };
        } else if (input.method === 'quiesce') {
          response = {
            id: input.id,
            ok: true,
            result: await quiesce(input.namespace, controller.signal),
            metadata: metadata(),
          };
        } else {
          entry = namespace(input.namespace);
          if (entry.pending.has(input.id)) throw new Error();
          if (entry.pending.size >= (options.maxPendingPerNamespace ?? 32)) throw new Error();
          if (input.method === 'view') viewing = entry.computer;
          const done = entry.computer.then((computer) =>
            input.method === 'view'
              ? view(computer, input.threadId, input.id)
              : dispatch(computer, input, controller.signal),
          );
          entry.pending.set(input.id, { controller, done });
          registered = true;
          const result = await done;
          controller.signal.throwIfAborted();
          response = {
            id: input.id,
            ok: true,
            result: result ?? null,
            metadata: metadata(await entry.computer, input),
          };
        }
      } catch (error) {
        response = {
          id: input.id,
          ok: false,
          error: controller.signal.aborted
            ? 'cancelled'
            : error instanceof BrowserActionError && error.code === 'browser_click_intercepted'
              ? 'click_intercepted'
              : error instanceof BrowserActionError && error.code === 'browser_navigation_failed'
                ? 'navigation'
                : error instanceof BrowserActionError && error.code === 'browser_dialog_open'
                  ? 'dialog'
                  : error instanceof BrowserActionError && error.code === 'browser_action_failed'
                    ? 'action'
                    : error instanceof BrowserActionError &&
                        error.code === 'browser_observation_failed'
                      ? 'observation'
                      : error instanceof Error && 'statusCode' in error && error.statusCode === 423
                        ? 'locked'
                        : 'unavailable',
          metadata: metadata(await entry?.computer.catch(() => undefined), input),
        };
      } finally {
        if (registered) entry?.pending.delete(input.id);
      }
      terminal = true;
      if (socket.destroyed) return;
      try {
        const line = JSON.stringify(browserResponse.parse(response)) + '\n';
        if (Buffer.byteLength(line) > responseBytes) throw new Error();
        socket.end(line);
      } catch {
        socket.end(
          JSON.stringify({ id: input.id, ok: false, error: 'unavailable', metadata: metadata() }) +
            '\n',
        );
      }
    };
    socket.on('data', (chunk: string) => {
      received += Buffer.byteLength(chunk);
      if (terminal || received > browserRequestBytes + 1024) return stop();
      incoming += chunk;
      for (let line = incoming.indexOf('\n'); line >= 0; line = incoming.indexOf('\n')) {
        const raw = incoming.slice(0, line);
        incoming = incoming.slice(line + 1);
        try {
          const frame = browserFrame.parse(JSON.parse(raw));
          if (frame.type === 'request') {
            if (request) return stop();
            request = frame.request;
            void execute(request);
          } else if (frame.type === 'input') {
            if (request?.method !== 'view' || frame.id !== request.id || !viewing) return stop();
            const { threadId } = request;
            const computer = viewing;
            inputs = inputs
              .then(async () => (await computer).control!(threadId, frame.input, controller.signal))
              .catch(() => {});
          } else {
            if (!request || frame.id !== request.id) return stop();
            controller.abort();
          }
        } catch {
          return stop();
        }
      }
    });
  });
  server.maxConnections = 256;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  try {
    await rm('/tmp/otto-browser-uploads', { recursive: true, force: true });
    await chmod(path, 0o600);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(path).catch(() => {});
    throw error;
  }
  ready = true;
  return {
    async close() {
      if (closing) return;
      closing = true;
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of connections) socket.destroy();
      await Promise.allSettled([...namespaces.keys()].map(dispose));
      await stopped;
      await unlink(path).catch(() => {});
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const worker = await startContainerBrowserWorker();
  const stop = () => {
    void worker.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
