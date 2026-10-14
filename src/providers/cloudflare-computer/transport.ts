import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { browserRequestBytes } from '../../ports/computer.ts';
import { threadIdentity } from '../../ports/thread-identity.ts';
import type { CommandProcess } from '../command-process.ts';
import { loopbackHost } from '../../shared/loopback.ts';

const outputLimit = 32 * 1024 * 1024;
const frameLimit = 22_000;

export function launchCloudflareCommand(options: {
  role: 'browser' | 'workspace';
  generation: string;
  threadId?: string;
  connected?: boolean;
  session?: boolean;
  fetch?: typeof fetch;
  origin?: string;
  onUncertain(): void;
}): CommandProcess {
  const { role, generation, threadId: selectedThreadId, connected, session, onUncertain } = options;
  let origin: string;
  try {
    const url = new URL(options.origin ?? 'http://otto.computer');
    if (
      url.protocol !== 'http:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      (url.origin !== 'http://otto.computer' && !loopbackHost(url.hostname)) ||
      !['browser', 'workspace'].includes(role) ||
      !/^[1-9]\d{0,18}$/.test(generation) ||
      (role === 'workspace' && !selectedThreadId) ||
      ((connected || session) && role !== 'workspace') ||
      (connected && session)
    )
      throw new Error();
    if (selectedThreadId !== undefined) threadIdentity(selectedThreadId);
    origin = url.origin;
  } catch {
    throw new Error('The remote computer configuration is invalid.');
  }
  const inputLimit = (role === 'browser' ? browserRequestBytes : 1024 * 1024) + 1024;
  const id = randomUUID();
  const requestFetch = options.fetch ?? fetch;
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const lifetime = new AbortController();
  const error = () => new Error('The remote computer connection did not finish safely.');
  let closed = false;
  let terminal: number | undefined;
  let outputEnded = false;
  let outputBytes = 0;
  let pendingInput = 0;
  let signalRequests = Promise.resolve();

  function fail() {
    if (closed) return;
    closed = true;
    lifetime.abort();
    stdin.destroy(error());
    stdout.end();
    stderr.end();
    try {
      onUncertain();
    } catch {}
    events.emit('error', error());
  }

  function finish() {
    if (closed || !outputEnded || terminal === undefined || pendingInput || stdin.writableLength)
      return;
    closed = true;
    lifetime.abort();
    stdin.destroy();
    stdout.end();
    stderr.end();
    events.emit('close', terminal);
  }

  async function request<T>(
    path: string,
    init: RequestInit,
    read: (response: Response) => Promise<T>,
    timeout = 30_000,
  ): Promise<T> {
    if (closed) throw error();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    timer.unref();
    try {
      const response = await requestFetch(origin + path, {
        ...init,
        headers: {
          ...init.headers,
          'x-otto-generation': generation,
          'x-otto-computer-role': role,
        },
        redirect: 'error',
        signal: AbortSignal.any([lifetime.signal, controller.signal]),
      });
      try {
        return await read(response);
      } finally {
        await response.body?.cancel().catch(() => {});
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function control(path: string, body?: Uint8Array | string) {
    await request(
      `/v1/commands/${id}/${path}`,
      {
        method: 'POST',
        headers: {
          'content-type':
            typeof body === 'string' ? 'application/json' : 'application/octet-stream',
        },
        body: body === undefined || typeof body === 'string' ? body : new Uint8Array(body),
      },
      async (response) => {
        if (response.status !== 204) throw error();
      },
    );
  }

  const stdin = new Writable({
    autoDestroy: false,
    write(chunk: Buffer, _encoding, callback) {
      pendingInput++;
      void ready
        .then(() => control('input', chunk))
        .then(
          () => {
            pendingInput--;
            callback();
            finish();
          },
          () => {
            pendingInput--;
            fail();
            callback(error());
          },
        );
    },
    final(callback) {
      void ready
        .then(() => (closed || terminal !== undefined ? undefined : control('end')))
        .then(
          () => callback(),
          () => {
            if (closed || terminal !== undefined) return callback();
            fail();
            callback(error());
          },
        );
    },
    destroy(_cause, callback) {
      if (!closed) fail();
      callback();
    },
  });
  stdin.on('error', fail);
  const write = stdin.write.bind(stdin);
  const end = stdin.end.bind(stdin);
  function accepted(chunk: unknown, encoding?: unknown) {
    try {
      const size =
        typeof chunk === 'string'
          ? Buffer.byteLength(
              chunk,
              typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8',
            )
          : chunk instanceof Uint8Array
            ? chunk.byteLength
            : -1;
      return size >= 0 && size + stdin.writableLength <= inputLimit;
    } catch {
      return false;
    }
  }
  stdin.write = function (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) {
    if (closed || !accepted(chunk, encodingOrCallback)) {
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      queueMicrotask(() => {
        fail();
        done?.(error());
      });
      return false;
    }
    return typeof encodingOrCallback === 'string'
      ? write(chunk, encodingOrCallback, callback)
      : write(chunk, encodingOrCallback ?? callback);
  } as Writable['write'];
  stdin.end = function (
    chunk?: string | Uint8Array | (() => void),
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) {
    if (closed) {
      const done =
        typeof chunk === 'function'
          ? chunk
          : typeof encodingOrCallback === 'function'
            ? encodingOrCallback
            : callback;
      queueMicrotask(() => done?.());
      return stdin;
    }
    if (
      chunk !== undefined &&
      typeof chunk !== 'function' &&
      !accepted(chunk, encodingOrCallback)
    ) {
      queueMicrotask(fail);
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      queueMicrotask(() => done?.(error()));
      return stdin;
    }
    return typeof chunk === 'function'
      ? end(chunk)
      : typeof encodingOrCallback === 'string'
        ? end(chunk, encodingOrCallback, callback)
        : end(chunk, encodingOrCallback ?? callback);
  } as Writable['end'];

  async function readOutput(response: Response) {
    if (response.status !== 200 || !response.body) throw error();
    const reader = response.body.getReader();
    let pending = Buffer.alloc(0);
    let wireBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        wireBytes += value.byteLength;
        if (wireBytes > outputLimit * 2) throw error();
        pending = Buffer.concat([pending, value]);
        for (let newline = pending.indexOf(10); newline >= 0; newline = pending.indexOf(10)) {
          if (newline > frameLimit || terminal !== undefined) throw error();
          const line = pending.subarray(0, newline);
          pending = pending.subarray(newline + 1);
          const frame = JSON.parse(
            new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(line),
          );
          if (!frame || typeof frame !== 'object' || Object.keys(frame).length !== 2) throw error();
          if (frame.type === 'exit' && Number.isSafeInteger(frame.code)) {
            terminal = frame.code;
          } else if (
            ['stdout', 'stderr'].includes(frame.type) &&
            typeof frame.data === 'string' &&
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)
          ) {
            const bytes = Buffer.from(frame.data, 'base64');
            outputBytes += bytes.length;
            if (
              bytes.length > 16 * 1024 ||
              outputBytes > outputLimit ||
              bytes.toString('base64') !== frame.data
            )
              throw error();
            (frame.type === 'stdout' ? stdout : stderr).write(bytes);
          } else throw error();
        }
        if (pending.length > frameLimit) throw error();
      }
      if (pending.length || terminal === undefined) throw error();
      outputEnded = true;
      finish();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  const ready = Promise.resolve().then(async () => {
    await request(
      '/v1/commands',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id,
          role,
          ...(selectedThreadId && { threadId: selectedThreadId }),
          ...(connected && { connected: true }),
          ...(session && { session: true }),
        }),
      },
      async (response) => {
        if (response.status !== 201 || !response.body) throw error();
        const reader = response.body.getReader();
        let bytes = Buffer.alloc(0);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (bytes.length + value.byteLength > 1024) throw error();
            bytes = Buffer.concat([bytes, value]);
          }
          const value = JSON.parse(
            new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
          );
          if (!value || Object.keys(value).length !== 1 || value.id !== id) throw error();
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      },
      180_000,
    );
  });
  void ready
    .then(() => request(`/v1/commands/${id}/output`, { method: 'GET' }, readOutput, 3_720_000))
    .catch(fail);
  return Object.assign(events, {
    stdin,
    stdout,
    stderr,
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      if (closed || terminal !== undefined || !['SIGTERM', 'SIGKILL'].includes(signal))
        return false;
      signalRequests = signalRequests
        .then(() => ready)
        .then(() =>
          closed || terminal !== undefined
            ? undefined
            : control('kill', JSON.stringify({ signal })),
        )
        .catch(() => {
          if (!closed && terminal === undefined) fail();
        });
      return true;
    },
  });
}

export async function cloudflareBrowserLive(options: { generation: string; fetch?: typeof fetch }) {
  if (!/^[1-9]\d{0,18}$/.test(options.generation))
    throw new Error('The remote computer configuration is invalid.');
  try {
    const response = await (options.fetch ?? fetch)('http://otto.computer/v1/status', {
      headers: { 'x-otto-generation': options.generation, 'x-otto-computer-role': 'browser' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    const value: { live?: unknown } | undefined =
      response.status === 200 ? await response.json() : undefined;
    await response.body?.cancel().catch(() => {});
    return value?.live === true;
  } catch {
    return false;
  }
}
