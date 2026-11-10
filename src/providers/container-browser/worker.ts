import { chmod, lstat, mkdir, rm, unlink } from 'node:fs/promises';
import { createServer, connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserDownload, Computer } from '../../ports/computer.ts';
import { BrowserActionError } from '../../ports/computer.ts';
import { createAgentBrowserComputer } from '../agent-browser/index.ts';
import { containerBrowserOptions } from './config.ts';
import {
  browserFrame,
  browserInputResult,
  browserMetadata,
  browserResponse,
  browserSocketPath,
  imageBytes,
  responseBytes,
  transferBytes,
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
      : request.method === 'injectCredentials' || request.method === 'fillCard'
        ? request.input.threadId
        : undefined);
  try {
    const screen = threadId ? computer?.screenStatus(threadId) : undefined;
    return browserMetadata.parse({
      status: 'Workspace browser is ready.',
      ...(screen && { screen: { threadId, ...screen } }),
    });
  } catch {
    return { status: 'Workspace browser is unavailable.' };
  }
}

async function dispatch(
  computer: Computer,
  request: BrowserRequest,
  signal: AbortSignal,
  upload: Promise<Buffer>,
) {
  signal.throwIfAborted();
  switch (request.method) {
    case 'bindProfile':
      return computer.bindProfile(request.threadId, request.profileId);
    case 'deleteProfile':
      return computer.deleteProfile(request.profileId);
    case 'act':
      return computer.act(request.threadId, request.input, signal);
    case 'download': {
      const file = await computer.download(request.threadId, request.input, signal);
      signal.throwIfAborted();
      if (!Buffer.isBuffer(file.bytes) || !file.bytes.length) throw new Error();
      return file;
    }
    case 'upload': {
      const { size: _size, ...input } = request.input;
      return computer.upload(request.threadId, { ...input, bytes: await upload }, signal);
    }
    case 'screenshot': {
      const image = await computer.screenshot(request.threadId, signal);
      if (image && image.length > imageBytes) throw new Error();
      return image?.toString('base64') ?? null;
    }
    case 'currentPage':
      return computer.currentPage(request.threadId, request.input);
    case 'signInMethods':
      if (!computer.signInMethods) throw new Error('Sign-in choices are not available.');
      return computer.signInMethods(request.threadId, request.origin, request.methods, signal);
    case 'selectSignInMethod':
      if (!computer.selectSignInMethod) throw new Error('Sign-in choices are not available.');
      await computer.selectSignInMethod(request.threadId, request.input, signal);
      return null;
    case 'injectCredentials':
      return computer.injectCredentials(request.input);
    case 'fillCard':
      await computer.fillCard(request.input);
      return null;
    case 'cardDestinations':
      return computer.cardDestinations(request.threadId, request.fields);
    case 'checkoutImage': {
      const image = await computer.checkoutImage(request.threadId);
      if (!image.length || image.length > imageBytes) throw new Error();
      return Buffer.from(image).toString('base64');
    }
    case 'hold':
      return computer.hold(request.threadId, request.held);
    case 'close':
      return computer.close(request.threadId);
    case 'clear':
      return computer.clear(request.threadId);
    case 'discard':
      return computer.discard(request.threadId);
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
    let request: BrowserRequest | undefined;
    let uploaded: Buffer[] = [];
    let uploadedBytes = 0;
    const controller = new AbortController();
    let finishUpload = (_bytes: Buffer) => {};
    const upload = new Promise<Buffer>((resolve, reject) => {
      finishUpload = resolve;
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      });
    });
    upload.catch(() => {});
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
    const send = async (line: string) => {
      if (!socket.write(line))
        await new Promise((resolve) => {
          socket.once('drain', resolve);
          socket.once('close', resolve);
        });
    };
    const view = async (computer: Computer, threadId: string, id: string) => {
      for await (const image of computer.view(threadId, controller.signal)) {
        await send(JSON.stringify(viewFrame.parse({ id, frame: image.toString('base64') })) + '\n');
        if (socket.destroyed) break;
      }
      return null;
    };
    const download = async (file: BrowserDownload, id: string) => {
      for (let offset = 0; offset < file.bytes.length; offset += transferBytes) {
        controller.signal.throwIfAborted();
        await send(
          JSON.stringify({
            id,
            chunk: file.bytes.subarray(offset, offset + transferBytes).toString('base64'),
          }) + '\n',
        );
      }
      return { name: file.name, mimeType: file.mimeType, size: file.bytes.length };
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
          if (input.method === 'view') viewing = entry.computer;
          const done = entry.computer.then(async (computer) => {
            if (input.method === 'view') return view(computer, input.threadId, input.id);
            const result = await dispatch(computer, input, controller.signal, upload);
            return input.method === 'download'
              ? download(result as BrowserDownload, input.id)
              : result;
          });
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
        if (input.method === 'upload') await upload.catch(() => {});
        response = {
          id: input.id,
          ok: false,
          error: controller.signal.aborted
            ? 'cancelled'
            : error instanceof BrowserActionError
              ? error.code
              : error instanceof Error && 'statusCode' in error && error.statusCode === 423
                ? 'locked'
                : 'unavailable',
          ...(error instanceof BrowserActionError && error.detail ? { detail: error.detail } : {}),
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
      if (terminal) return stop();
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
          } else if (frame.type === 'data') {
            if (request?.method !== 'upload' || frame.id !== request.id) return stop();
            const bytes = Buffer.from(frame.data, 'base64');
            uploadedBytes += bytes.length;
            if (uploadedBytes > request.input.size) return stop();
            uploaded.push(bytes);
            if (uploadedBytes === request.input.size) {
              finishUpload(Buffer.concat(uploaded));
              uploaded = [];
            }
          } else if (frame.type === 'input') {
            if (request?.method !== 'view' || frame.id !== request.id || !viewing) return stop();
            const { threadId } = request;
            const computer = viewing;
            inputs = inputs
              .then(async () => {
                let result;
                try {
                  controller.signal.throwIfAborted();
                  const text = await (
                    await computer
                  ).control(threadId, frame.input, controller.signal);
                  controller.signal.throwIfAborted();
                  result = {
                    id: frame.id,
                    inputId: frame.inputId,
                    ok: true,
                    ...(frame.input.type === 'copy' && typeof text === 'string' ? { text } : {}),
                  };
                } catch (error) {
                  result = {
                    id: frame.id,
                    inputId: frame.inputId,
                    ok: false,
                    ...(error instanceof BrowserActionError ? { error: error.code } : {}),
                  };
                }
                if (!socket.destroyed)
                  await send(JSON.stringify(browserInputResult.parse(result)) + '\n');
              })
              .catch(stop);
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
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  try {
    await rm('/tmp/nod-browser-uploads', { recursive: true, force: true });
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
