import { browserErrorMessage, type BrowserErrorCode } from '../../shared/browser-errors.ts';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { z } from 'zod';
import { BrowserActionError, type Computer } from '../../ports/computer.ts';
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
const observationSchema = z.object({ text: z.string(), url: z.string() }).strict();
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
  available?(input: BrowserCall): boolean;
  timeoutMs?: number;
  drainTimeoutMs?: number;
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
    'Explicitly reopen the website or saved browser session to start a new page. The previous action may have completed; do not repeat it.';

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
      })().finally(() => recovering.delete(key));
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
        (input.method === 'bindProfile' ||
          (input.method === 'act' && input.input.action === 'open'))
      ) {
        if (input.method === 'act') browserUrl(input.input.url ?? '');
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
    const result = new Promise<unknown>((resolve, reject) => {
      let child: CommandProcess;
      try {
        child = options.launch(input);
      } catch {
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
      const unavailable = () => {
        if (settled) return;
        settled = true;
        uncertain = true;
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
        drainTimer = setTimeout(unavailable, options.drainTimeoutMs ?? 15_000);
      }
      signal?.addEventListener('abort', cancel, { once: true });
      cancellations.set(cancel, browserId);
      child.stdin.on('error', unavailable);
      child.on('error', unavailable);
      child.stderr.resume();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        for (let end = output.indexOf('\n'); end >= 0; end = output.indexOf('\n')) {
          const line = output.slice(0, end);
          output = output.slice(end + 1);
          if (Buffer.byteLength(line) > responseBytes) return unavailable();
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
            return unavailable();
          }
        }
        if (Buffer.byteLength(output) > responseBytes) unavailable();
      });
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0 || !response || output) return unavailable();
        settled = true;
        cleanup();
        updateMetadata(response.metadata, order);
        if (cancelling || (!response.ok && response.error === 'cancelled'))
          return reject(new Error('Browser operation cancelled.'));
        if (response.ok) return resolve(response.result);
        if (browserErrorMessage(response.error))
          return reject(
            new BrowserActionError(response.error as BrowserErrorCode, response.detail),
          );
        if (response.error === 'locked') {
          const error = new Error('Browser observations are paused during credential entry.');
          return reject(Object.assign(error, { statusCode: 423 }));
        }
        reject(new Error('The workspace browser could not complete this action. Try again.'));
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
      })().catch(unavailable);
      if (signal?.aborted) cancel();
    });
    pending.set(result, browserId);
    void result.finally(() => pending.delete(result)).catch(() => {});
    return result;
  }

  async function* view(id: string, signal: AbortSignal): AsyncGenerator<Buffer> {
    const threadId = threadIdentity(id);
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
    bindProfile: async (id, profileId) => {
      await call({ method: 'bindProfile', threadId: threadIdentity(id), profileId });
      screens.delete(threadIdentity(id));
    },
    deleteProfile: async (profileId) => {
      await call({ method: 'deleteProfile', profileId });
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
    fillCard: async (input) => {
      await call({
        method: 'fillCard',
        input: browserCardInput.parse({ ...input, threadId: threadIdentity(input.threadId) }),
      });
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
    injectCredentials: async (input) => {
      return (
        z
          .object({ status: z.literal('submitted') })
          .strict()
          .nullable()
          .parse(
            await call({
              method: 'injectCredentials',
              input: browserCredentialInput.parse({
                ...input,
                threadId: threadIdentity(input.threadId),
              }),
            }),
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
