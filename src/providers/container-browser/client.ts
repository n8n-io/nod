import {
  browserErrorMessage,
  type BrowserErrorCode,
  type BrowserSignInGuard,
} from '../../shared/browser-errors.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { z } from 'zod';
import { BrowserActionError, type Computer } from '../../ports/computer.ts';
import { logFailure, logRepeatedFailure } from '../../ports/failure-log.ts';
import { fileBytes } from '../../shared/files.ts';
import { threadIdentity } from '../../ports/thread-identity.ts';
import type { CommandProcess } from '../command-process.ts';
import { browserUrl } from '../agent-browser/network.ts';
import {
  browserFrame,
  browserCredentialInput,
  browserCardInput,
  browserRequest,
  browserResponse,
  browserViewResult,
  chunkFrame,
  imageBytes,
  responseBytes,
  transferBytes,
  type BrowserCall,
  type BrowserMetadata,
  type BrowserResponse,
} from './protocol.ts';

const viewFrameLine = 4 * 1024 * 1024 + 256;
const observationSchema = z
  .object({ text: z.string(), url: z.string(), unmet: z.literal(true).optional() })
  .strict();
const controls = z
  .array(z.object({ role: z.string().max(100), name: z.string().max(300) }).strict())
  .max(3);

const pageSchema = z
  .object({
    origin: z.string().max(2048),
    url: z.string().max(8192),
    target: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    controls: controls.optional(),
    submits: z
      .union([z.object({ method: z.string(), to: z.string() }).strict(), z.literal('unknown')])
      .optional(),
    dropTarget: controls.optional(),
    dialog: z.string().max(8192).optional(),
  })
  .strict();

export function createBridgeComputer(options: {
  namespace: string;
  launch(input: BrowserCall): CommandProcess;
  launchPersistent?(): CommandProcess;
  available?(input: BrowserCall): boolean;
  ready?(signal?: AbortSignal): Promise<void>;
  timeoutMs?: number;
  drainTimeoutMs?: number;
  readyTimeoutMs?: number;
}): Computer & { quiesce(): Promise<boolean> } {
  let disposed = false;
  let uncertain = false;
  const uncertainBrowsers = new Set<string>();
  let sequence = 0;
  const screens = new Map<
    string,
    { sequence: number; value: ReturnType<NonNullable<Computer['screenStatus']>> }
  >();
  const pending = new Map<Promise<unknown>, string | undefined>();
  const cancellations = new Map<() => void, string | undefined>();
  const views = new Map<
    string,
    Set<(input: unknown, signal?: AbortSignal) => Promise<string | void>>
  >();
  let disposing: Promise<void> | undefined;
  const recovering = new Map<string, Promise<void>>();
  const reopenNotice =
    'Explicitly reopen the website to start a new page. The previous action may have completed; do not repeat it.';
  type MultiplexEntry = {
    order: number;
    chunks?: Buffer[];
    received: number;
    onResponse(response: BrowserResponse): void;
    onUnavailable(
      reason: string,
      error?: unknown,
      exit?: { exitCode: number | null; signal: string | null },
    ): void;
  };
  let persistentDisabled = false;
  let persistent:
    | {
        child: CommandProcess;
        entries: Map<string, MultiplexEntry>;
        stderr: string;
        output: string;
        closed: boolean;
        ready: Promise<void>;
        resolveReady: () => void;
        rejectReady: (error: Error) => void;
        isReady: boolean;
        readyTimer: ReturnType<typeof setTimeout>;
      }
    | undefined;

  function dropPersistent(
    reason?: string,
    error?: unknown,
    exit?: { exitCode: number | null; signal: string | null },
  ) {
    const channel = persistent;
    if (!channel || channel.closed) return;
    channel.closed = true;
    clearTimeout(channel.readyTimer);
    persistent = undefined;
    if (!channel.isReady) {
      channel.rejectReady(new Error(reason ?? 'exit'));
    }
    try {
      channel.child.stdin.destroy();
      channel.child.kill('SIGKILL');
    } catch {}
    if (reason) {
      for (const entry of channel.entries.values()) entry.onUnavailable(reason, error, exit);
    }
    channel.entries.clear();
  }

  function ensurePersistent() {
    if (persistentDisabled) return undefined;
    if (persistent && !persistent.closed) return persistent;
    if (!options.launchPersistent) return undefined;
    const child = options.launchPersistent();
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    ready.catch(() => {});
    const readyTimer = setTimeout(() => {
      if (persistent === channel && !channel.isReady) dropPersistent('ready_timeout');
    }, options.readyTimeoutMs ?? 5_000);
    const channel = {
      child,
      entries: new Map<string, MultiplexEntry>(),
      stderr: '',
      output: '',
      closed: false,
      ready,
      resolveReady,
      rejectReady,
      isReady: false,
      readyTimer,
    };
    persistent = channel;
    child.stdin.on('error', (error) => {
      if (persistent === channel) dropPersistent('stream_error', error);
    });
    child.on('error', (error) => {
      if (persistent === channel) dropPersistent('launch', error);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      channel.stderr = (channel.stderr + chunk).slice(-2000);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (channel.closed) return;
      channel.output += chunk;
      for (let end = channel.output.indexOf('\n'); end >= 0; end = channel.output.indexOf('\n')) {
        const line = channel.output.slice(0, end);
        channel.output = channel.output.slice(end + 1);
        if (Buffer.byteLength(line) > responseBytes) {
          dropPersistent('oversized_response');
          return;
        }
        try {
          const value = JSON.parse(line);
          if (value && typeof value === 'object' && value.type === 'ready') {
            if (!channel.isReady) {
              channel.isReady = true;
              clearTimeout(channel.readyTimer);
              channel.resolveReady();
            }
            continue;
          }
          const part = chunkFrame.safeParse(value);
          if (part.success) {
            const entry = channel.entries.get(part.data.id);
            if (!entry || !entry.chunks) throw new Error();
            const bytes = Buffer.from(part.data.chunk, 'base64');
            entry.received += bytes.length;
            if (entry.received > fileBytes) throw new Error();
            entry.chunks.push(bytes);
            continue;
          }
          const response = browserResponse.parse(value);
          const entry = channel.entries.get(response.id);
          if (!entry) continue;
          channel.entries.delete(response.id);
          entry.onResponse(response);
        } catch {
          dropPersistent('malformed_response');
          return;
        }
      }
      if (Buffer.byteLength(channel.output) > responseBytes) dropPersistent('oversized_response');
    });
    child.on('close', (code, signal) => {
      if (persistent === channel) {
        dropPersistent('exit', undefined, { exitCode: code, signal: signal ?? null });
      }
    });
    return channel;
  }

  function recover(browserId?: string) {
    const scope = uncertain ? undefined : browserId;
    const key = scope ?? '';
    let recovery = recovering.get(key);
    if (!recovery) {
      recovery = (async () => {
        for (const [cancel, id] of cancellations) if (!scope || id === scope) cancel();
        await Promise.allSettled(
          [...pending].flatMap(([promise, id]) => (!scope || id === scope ? [promise] : [])),
        );
        await call(
          scope ? { method: 'clear', threadId: scope } : { method: 'dispose' },
          undefined,
          {},
          true,
        );
        if (disposed) return;
        if (scope) {
          uncertainBrowsers.delete(scope);
          screens.delete(scope);
        } else {
          uncertain = false;
          uncertainBrowsers.clear();
          screens.clear();
        }
      })()
        .catch((error) => {
          logFailure('browser_recover_failed', error, { scope: scope ? 'browser' : 'all' });
          throw error;
        })
        .finally(() => recovering.delete(key));
      recovering.set(key, recovery);
    }
    return recovery;
  }

  function updateMetadata(value: BrowserMetadata, order: number) {
    if (value.screen && order >= (screens.get(value.screen.threadId)?.sequence ?? 0)) {
      const { threadId: id, ...screen } = value.screen;
      screens.set(id, { sequence: order, value: screen });
      if (screens.size > 256) screens.delete(screens.keys().next().value!);
    }
  }

  function call(
    input: BrowserCall,
    signal?: AbortSignal,
    transfer: { data?: Uint8Array; chunks?: Buffer[] } = {},
    recovery = false,
    forceOneShot = false,
  ): Promise<unknown> {
    if (!options.ready || input.method === 'dispose')
      return dispatch(input, signal, transfer, recovery, forceOneShot);
    return options
      .ready(signal)
      .then(() => dispatch(input, signal, transfer, recovery, forceOneShot));
  }

  function dispatch(
    input: BrowserCall,
    signal?: AbortSignal,
    transfer: { data?: Uint8Array; chunks?: Buffer[] } = {},
    recovery = false,
    forceOneShot = false,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const request = browserRequest.parse({
      ...input,
      id: randomUUID(),
      namespace: options.namespace,
    });
    const encoded = JSON.stringify({ type: 'request', request }) + '\n';
    const browserId =
      'threadId' in input
        ? input.threadId
        : input.method === 'injectCredentials' || input.method === 'fillCard'
          ? input.input.threadId
          : undefined;
    const fenced = uncertain || (browserId !== undefined && uncertainBrowsers.has(browserId));
    const available = options.available?.(input) !== false;
    if (input.method !== 'dispose' && (disposed || (!recovery && fenced) || !available)) {
      if (
        !disposed &&
        fenced &&
        available &&
        input.method === 'act' &&
        input.input.action === 'open'
      ) {
        browserUrl(input.input.url ?? '');
        return recover(browserId).then(() => call(input, signal, transfer));
      }
      return Promise.reject(
        new Error(
          fenced && !disposed && available
            ? `The workspace browser is unavailable. ${reopenNotice}`
            : 'The workspace browser is unavailable. Restart Nod before continuing.',
        ),
      );
    }
    const order = ++sequence;
    const started = Date.now();
    let stderr = '';
    const failed = (
      reason: string,
      error?: unknown,
      exit: {
        exitCode?: number | null;
        signal?: string | null;
        signInGuard?: BrowserSignInGuard;
      } = {},
    ) => {
      const message = error instanceof Error ? error.message : undefined;
      const context = {
        method: input.method,
        ...(input.method === 'act' ? { action: input.input.action } : {}),
        reason,
        ...exit,
        durationMs: Date.now() - started,
        fenced,
      };
      if (reason === 'error_response')
        logRepeatedFailure(
          'browser_bridge_failed',
          `${input.method}:${message}:${exit.signInGuard ?? ''}`,
          { code: message, stderr },
          context,
        );
      else logFailure('browser_bridge_failed', { message, stderr }, context);
    };
    const settleResponse = (
      response: BrowserResponse,
      cancelling: boolean,
      resolve: (value: unknown) => void,
      reject: (reason?: unknown) => void,
    ) => {
      updateMetadata(response.metadata, order);
      if (cancelling || (!response.ok && response.error === 'cancelled'))
        return reject(new Error('Browser operation cancelled.'));
      if (response.ok) return resolve(response.result);
      failed('error_response', new Error(response.error), {
        ...(response.signInGuard ? { signInGuard: response.signInGuard } : {}),
      });
      if (browserErrorMessage(response.error))
        return reject(
          new BrowserActionError(
            response.error as BrowserErrorCode,
            response.detail,
            response.signInGuard,
          ),
        );
      if (response.error === 'locked') {
        const error = new Error('Browser observations are paused during credential entry.');
        return reject(Object.assign(error, { statusCode: 423 }));
      }
      reject(
        Object.assign(
          new Error(
            response.detail
              ? `The workspace browser could not complete this action: ${response.detail}`
              : 'The workspace browser could not complete this action. Try again.',
          ),
          response.signInGuard ? { signInGuard: response.signInGuard } : {},
        ),
      );
    };
    const usePersistent =
      !forceOneShot &&
      Boolean(options.launchPersistent) &&
      !persistentDisabled &&
      input.method !== 'dispose';
    const result = new Promise<unknown>((resolve, reject) => {
      if (usePersistent) {
        let channel: NonNullable<typeof persistent>;
        try {
          channel = ensurePersistent()!;
        } catch (error) {
          failed('launch', error);
          uncertain = true;
          return reject(
            new Error(`The workspace browser is unavailable. Start its container. ${reopenNotice}`),
          );
        }
        let settled = false;
        let cancelling = false;
        let written = false;
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        const timer =
          options.timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                timedOut = true;
                cancel();
              }, options.timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          clearTimeout(drainTimer);
          signal?.removeEventListener('abort', cancel);
          cancellations.delete(cancel);
          channel.entries.delete(request.id);
        };
        const unavailable = (
          reason: string,
          error?: unknown,
          exit?: { exitCode: number | null; signal: string | null },
        ) => {
          if (settled) return;
          if (
            !written &&
            !channel.isReady &&
            !cancelling &&
            (reason === 'exit' || reason === 'ready_timeout')
          ) {
            settled = true;
            const proxyRefused = /403|forbidden|not allowed/i.test(channel.stderr);
            if (proxyRefused || reason === 'ready_timeout') {
              persistentDisabled = true;
              logFailure('browser_bridge_multiplex_fallback', new Error(channel.stderr || reason), {
                method: input.method,
              });
            }
            cleanup();
            void call(input, signal, transfer, recovery, true).then(resolve, reject);
            return;
          }
          settled = true;
          uncertain = true;
          stderr = channel.stderr;
          failed(reason, error, exit);
          cleanup();
          reject(new Error(`The workspace browser did not finish safely. ${reopenNotice}`));
        };
        function cancel() {
          if (settled || cancelling) return;
          cancelling = true;
          clearTimeout(timer);
          if (!written) {
            settled = true;
            cleanup();
            reject(
              signal?.aborted
                ? signal.reason instanceof Error
                  ? signal.reason
                  : new DOMException('Aborted', 'AbortError')
                : timedOut
                  ? new Error('The browser action timed out. Check the page before trying again.')
                  : new Error('The browser operation was cancelled before it was sent.'),
            );
            return;
          }
          if (!['currentPage', 'screenshot'].includes(input.method)) {
            if (browserId) uncertainBrowsers.add(browserId);
            else uncertain = true;
          }
          if (!channel.closed) {
            try {
              channel.child.stdin.write(JSON.stringify({ type: 'cancel', id: request.id }) + '\n');
            } catch {}
          }
          drainTimer = setTimeout(() => {
            if (persistent === channel) dropPersistent('timeout');
            else unavailable('timeout');
          }, options.drainTimeoutMs ?? 15_000);
        }
        signal?.addEventListener('abort', cancel, { once: true });
        cancellations.set(cancel, browserId);
        const runInContext = AsyncLocalStorage.snapshot();
        channel.entries.set(request.id, {
          order,
          chunks: transfer.chunks,
          received: 0,
          onResponse: (response) =>
            runInContext(() => {
              if (settled) return;
              settled = true;
              cleanup();
              settleResponse(response, cancelling, resolve, reject);
            }),
          onUnavailable: (reason, error, exit) =>
            runInContext(() => unavailable(reason, error, exit)),
        });
        void (async () => {
          try {
            await channel.ready;
          } catch {
            return;
          }
          if (settled || cancelling || channel.closed) return;
          written = true;
          if (!channel.child.stdin.write(encoded)) await once(channel.child.stdin, 'drain');
          const data = transfer.data ?? new Uint8Array();
          for (let offset = 0; offset < data.length; offset += transferBytes) {
            if (settled || cancelling || channel.closed) return;
            const line = {
              type: 'data',
              id: request.id,
              data: Buffer.from(data.subarray(offset, offset + transferBytes)).toString('base64'),
            };
            if (!channel.child.stdin.write(JSON.stringify(line) + '\n'))
              await once(channel.child.stdin, 'drain');
          }
        })().catch((error) => {
          if (persistent === channel) dropPersistent('stream_error', error);
          else unavailable('stream_error', error);
        });
        if (signal?.aborted) cancel();
        return;
      }
      let child: CommandProcess;
      try {
        child = options.launch(input);
      } catch (error) {
        failed('launch', error);
        uncertain = true;
        return reject(
          new Error(`The workspace browser is unavailable. Start its container. ${reopenNotice}`),
        );
      }
      let output = '';
      let received = 0;
      let response: BrowserResponse | undefined;
      let settled = false;
      let cancelling = false;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const timer =
        options.timeoutMs === undefined ? undefined : setTimeout(() => cancel(), options.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(drainTimer);
        signal?.removeEventListener('abort', cancel);
        cancellations.delete(cancel);
      };
      const unavailable = (
        reason: string,
        error?: unknown,
        exit?: { exitCode: number | null; signal: string | null },
      ) => {
        if (settled) return;
        settled = true;
        uncertain = true;
        failed(reason, error, exit);
        cleanup();
        child.stdin.destroy();
        child.kill('SIGKILL');
        reject(new Error(`The workspace browser did not finish safely. ${reopenNotice}`));
      };
      function cancel() {
        if (settled || cancelling) return;
        cancelling = true;
        if (!['currentPage', 'screenshot'].includes(input.method)) {
          if (browserId) uncertainBrowsers.add(browserId);
          else uncertain = true;
        }
        clearTimeout(timer);
        if (!response) child.stdin.write(JSON.stringify({ type: 'cancel', id: request.id }) + '\n');
        drainTimer = setTimeout(() => unavailable('timeout'), options.drainTimeoutMs ?? 15_000);
      }
      signal?.addEventListener('abort', cancel, { once: true });
      cancellations.set(cancel, browserId);
      child.stdin.on('error', (error) => unavailable('stream_error', error));
      child.on('error', (error) => unavailable('launch', error));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-2000);
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        for (let end = output.indexOf('\n'); end >= 0; end = output.indexOf('\n')) {
          const line = output.slice(0, end);
          output = output.slice(end + 1);
          if (Buffer.byteLength(line) > responseBytes) return unavailable('oversized_response');
          try {
            if (response) throw new Error();
            const value = JSON.parse(line);
            const part = chunkFrame.safeParse(value);
            if (part.success) {
              const bytes = Buffer.from(part.data.chunk, 'base64');
              received += bytes.length;
              if (!transfer.chunks || part.data.id !== request.id || received > fileBytes)
                throw new Error();
              transfer.chunks.push(bytes);
              continue;
            }
            response = browserResponse.parse(value);
            if (response.id !== request.id) throw new Error();
          } catch {
            return unavailable('malformed_response');
          }
        }
        if (Buffer.byteLength(output) > responseBytes) unavailable('oversized_response');
      });
      child.on('close', (code, signal) => {
        if (settled) return;
        if (code !== 0 || !response || output)
          return unavailable(code !== 0 ? 'exit' : 'malformed_response', undefined, {
            exitCode: code,
            signal: signal ?? null,
          });
        settled = true;
        cleanup();
        settleResponse(response, cancelling, resolve, reject);
      });
      void (async () => {
        child.stdin.write(encoded);
        const data = transfer.data ?? new Uint8Array();
        for (let offset = 0; offset < data.length; offset += transferBytes) {
          if (settled || cancelling) return;
          const line = {
            type: 'data',
            id: request.id,
            data: Buffer.from(data.subarray(offset, offset + transferBytes)).toString('base64'),
          };
          if (!child.stdin.write(JSON.stringify(line) + '\n')) await once(child.stdin, 'drain');
        }
      })().catch((error) => unavailable('stream_error', error));
      if (signal?.aborted) cancel();
    });
    pending.set(result, browserId);
    void result.finally(() => pending.delete(result)).catch(() => {});
    return result;
  }

  async function* view(id: string, signal: AbortSignal): AsyncGenerator<Buffer> {
    const threadId = threadIdentity(id);
    await options.ready?.(signal);
    signal.throwIfAborted();
    if (
      disposed ||
      uncertain ||
      uncertainBrowsers.has(threadId) ||
      options.available?.({ method: 'view', threadId }) === false
    )
      throw new Error('The workspace browser is unavailable.');
    const request = browserRequest.parse({
      method: 'view',
      threadId,
      id: randomUUID(),
      namespace: options.namespace,
    });
    const child = options.launch({ method: 'view', threadId });
    let closed = false;
    let exited = false;
    let latest: Buffer | undefined;
    let wake = () => {};
    const inputs = new Map<
      string,
      { resolve(value: string | void): void; reject(error: Error): void }
    >();
    const open = views.get(threadId) ?? new Set();
    const write = (frame: unknown) => {
      if (closed) return;
      child.stdin.write(JSON.stringify(browserFrame.parse(frame)) + '\n');
    };
    const stop = () => {
      closed = true;
      open.delete(send);
      if (!open.size && views.get(threadId) === open) views.delete(threadId);
      for (const input of inputs.values())
        input.reject(
          new Error('The browser input did not finish. Check the page before trying again.'),
        );
      inputs.clear();
      wake();
    };
    const cancel = () => {
      write({ type: 'cancel', id: request.id });
      stop();
    };
    const send = async (input: unknown, inputSignal?: AbortSignal) => {
      inputSignal?.throwIfAborted();
      if (closed) throw new Error('The browser view is not open.');
      if (uncertain || uncertainBrowsers.has(threadId))
        throw new Error(`The workspace browser is unavailable. ${reopenNotice}`);
      const inputId = randomUUID();
      const timer = setTimeout(cancel, options.timeoutMs ?? 30_000);
      inputSignal?.addEventListener('abort', cancel, { once: true });
      try {
        return await new Promise<string | void>((resolve, reject) => {
          inputs.set(inputId, { resolve, reject });
          write({ type: 'input', id: request.id, inputId, input });
        });
      } finally {
        inputs.delete(inputId);
        clearTimeout(timer);
        inputSignal?.removeEventListener('abort', cancel);
      }
    };
    child.on('close', () => {
      exited = true;
      stop();
    });
    child.on('error', stop);
    child.stdin.on('error', cancel);
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.stdout.on('error', cancel);
    child.stdout.on('end', stop);
    let buffered = '';
    child.stdout.on('data', (chunk: string) => {
      if (closed) return;
      buffered += chunk;
      try {
        for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
          if (end > viewFrameLine) return cancel();
          const result = browserViewResult.parse(JSON.parse(buffered.slice(0, end)));
          buffered = buffered.slice(end + 1);
          if (result.id !== request.id) return cancel();
          if ('frame' in result) {
            latest = Buffer.from(result.frame, 'base64');
            wake();
          } else {
            const input = inputs.get(result.inputId);
            inputs.delete(result.inputId);
            if (result.ok) input?.resolve(result.text);
            else
              input?.reject(
                result.error
                  ? new BrowserActionError(result.error)
                  : new Error('The browser did not take that input.'),
              );
          }
        }
        if (buffered.length > viewFrameLine) cancel();
      } catch {
        cancel();
      }
    });
    views.set(threadId, open.add(send));
    signal.addEventListener('abort', cancel, { once: true });
    cancellations.set(cancel, threadId);
    write({ type: 'request', request });
    if (signal.aborted) cancel();
    try {
      while (!closed || latest) {
        const frame = latest;
        latest = undefined;
        if (frame) yield frame;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      cancellations.delete(cancel);
      cancel();
      if (!exited) setTimeout(() => exited || child.kill('SIGKILL'), 5_000).unref();
    }
  }

  async function image(id: string, signal?: AbortSignal) {
    const value = await call({ method: 'screenshot', threadId: threadIdentity(id) }, signal);
    if (value === null) return null;
    if (
      typeof value !== 'string' ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
      value.length > Math.ceil(imageBytes / 3) * 4
    )
      throw new Error('The workspace browser image is unavailable.');
    return Buffer.from(value, 'base64');
  }

  return {
    async quiesce() {
      const result = await call({ method: 'quiesce' });
      if (typeof result !== 'boolean')
        throw new Error('The workspace browser could not pause safely.');
      if (result) screens.clear();
      return result;
    },
    screenStatus: (id) => screens.get(threadIdentity(id))?.value ?? { state: 'unavailable' },
    act: async (id, input, signal) =>
      observationSchema.parse(
        await call({ method: 'act', threadId: threadIdentity(id), input }, signal),
      ),
    screenshot: image,
    control: async (id, input, signal) => {
      const send = [...(views.get(threadIdentity(id)) ?? [])].at(-1);
      if (!send) throw new Error('The browser view is not open.');
      return await send(input, signal);
    },
    view,
    upload: async (id, input, signal) => {
      if (!input.bytes.length || input.bytes.length > fileBytes)
        throw new Error('The browser file is too large.');
      return observationSchema.parse(
        await call(
          {
            method: 'upload',
            threadId: threadIdentity(id),
            input: {
              selector: input.selector,
              name: input.name,
              size: input.bytes.length,
              ...(input.expectOrigin ? { expectOrigin: input.expectOrigin } : {}),
              ...(input.expectUrl ? { expectUrl: input.expectUrl } : {}),
              ...(input.expectTarget ? { expectTarget: input.expectTarget } : {}),
            },
          },
          signal,
          { data: input.bytes },
        ),
      );
    },
    async download(id, input, signal) {
      const chunks: Buffer[] = [];
      const result = z
        .object({
          size: z.number().int().min(1).max(fileBytes),
          name: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[^/\\\u0000-\u001f\u007f]+$/),
          mimeType: z
            .string()
            .max(100)
            .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
        })
        .strict()
        .parse(
          await call({ method: 'download', threadId: threadIdentity(id), input }, signal, {
            chunks,
          }),
        );
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== result.size) throw new Error('The browser file is unavailable.');
      return { bytes, name: result.name, mimeType: result.mimeType };
    },
    currentPage: async (id, step) =>
      pageSchema.parse(
        await call({
          method: 'currentPage',
          threadId: threadIdentity(id),
          ...(step ? { input: step } : {}),
        }),
      ),
    signInMethods: async (id, origin, methods, signal) =>
      z
        .object({
          document: z.string().min(1).max(200),
          methods: z
            .array(
              z
                .object({ id: z.uuid(), label: z.string().min(1).max(300), page: pageSchema })
                .strict(),
            )
            .min(1)
            .max(10),
        })
        .strict()
        .parse(
          await call(
            { method: 'signInMethods', threadId: threadIdentity(id), origin, methods },
            signal,
          ),
        ),
    selectSignInMethod: async (id, input, signal) => {
      await call({ method: 'selectSignInMethod', threadId: threadIdentity(id), input }, signal);
    },
    fillCard: async (input, signal) => {
      await call(
        {
          method: 'fillCard',
          input: browserCardInput.parse({ ...input, threadId: threadIdentity(input.threadId) }),
        },
        signal,
      );
    },
    cardDestinations: async (id, fields) =>
      z
        .object({
          document: z.string().min(1).max(200),
          destinations: z.partialRecord(
            z.enum(['number', 'expiry', 'expiryMonth', 'expiryYear', 'securityCode', 'name']),
            z.string().max(2048),
          ),
        })
        .strict()
        .parse(await call({ method: 'cardDestinations', threadId: threadIdentity(id), fields })),
    checkoutImage: async (id) => {
      const value = await call({ method: 'checkoutImage', threadId: threadIdentity(id) });
      if (
        typeof value !== 'string' ||
        !value ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
        value.length > Math.ceil(imageBytes / 3) * 4
      )
        throw new Error('The checkout page could not be captured.');
      return new Uint8Array(Buffer.from(value, 'base64'));
    },
    injectCredentials: async (input, signal) => {
      return (
        z
          .object({ status: z.literal('submitted') })
          .strict()
          .nullable()
          .parse(
            await call(
              {
                method: 'injectCredentials',
                input: browserCredentialInput.parse({
                  ...input,
                  threadId: threadIdentity(input.threadId),
                }),
              },
              signal,
            ),
          ) ?? undefined
      );
    },
    hold: async (id, held) => {
      await call({ method: 'hold', threadId: threadIdentity(id), held });
    },
    close: async (id) => {
      await call({ method: 'close', threadId: threadIdentity(id) });
    },
    clear: async (id) => {
      await call({ method: 'clear', threadId: threadIdentity(id) });
      screens.delete(threadIdentity(id));
    },
    discard: async (id) => {
      await call({ method: 'discard', threadId: threadIdentity(id) });
      screens.delete(threadIdentity(id));
    },
    dispose: () => {
      disposing ??= (async () => {
        disposed = true;
        for (const cancel of cancellations.keys()) cancel();
        await Promise.allSettled([...pending.keys()]);
        dropPersistent();
        await call({ method: 'dispose' });
        screens.clear();
      })().catch((error) => {
        disposing = undefined;
        throw error;
      });
      return disposing;
    },
  };
}
