import { browserErrorMessage, type BrowserErrorCode } from '../../shared/browser-errors.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  BrowserActionError,
  browserDownloadBytes,
  browserRequestBytes,
  browserUploadBytes,
  type Computer,
} from '../../ports/computer.ts';
import { threadIdentity } from '../../ports/thread-identity.ts';
import type { CommandProcess } from '../command-process.ts';
import { browserUrl } from '../agent-browser/network.ts';
import {
  browserFrame,
  browserCredentialInput,
  browserCardInput,
  browserRequest,
  browserResponse,
  imageBytes,
  responseBytes,
  viewFrame,
  type BrowserCall,
  type BrowserMetadata,
  type BrowserResponse,
} from './protocol.ts';

const viewFrameLine = 4 * 1024 * 1024 + 256;
const observationSchema = z.object({ text: z.string(), url: z.string() }).strict();

export function createBridgeComputer(options: {
  namespace: string;
  launch(input: BrowserCall): CommandProcess;
  available?(input: BrowserCall): boolean;
  timeoutMs?: number;
  openTimeoutMs?: number;
  drainTimeoutMs?: number;
}): Computer & { quiesce(): Promise<boolean> } {
  let disposed = false;
  let uncertain = false;
  let sequence = 0;
  let statusSequence = 0;
  let status = 'Workspace browser is ready.';
  const screens = new Map<
    string,
    { sequence: number; value: ReturnType<NonNullable<Computer['screenStatus']>> }
  >();
  const pending = new Set<Promise<unknown>>();
  const cancellations = new Set<() => void>();
  const views = new Map<string, Set<(input: unknown) => void>>();
  let disposing: Promise<void> | undefined;
  let recovering: Promise<void> | undefined;
  const reopenNotice =
    'Explicitly reopen the website or saved browser session to start a new page. The previous action may have completed; do not repeat it.';

  function recover() {
    recovering ??= (async () => {
      for (const cancel of cancellations) cancel();
      await Promise.allSettled([...pending]);
      await call({ method: 'dispose' });
      if (disposed) return;
      uncertain = false;
      screens.clear();
    })().finally(() => {
      recovering = undefined;
    });
    return recovering;
  }

  function updateMetadata(value: BrowserMetadata, order: number, input: BrowserCall) {
    if (order >= statusSequence) {
      statusSequence = order;
      status = value.status;
    }
    if (value.screen && order >= (screens.get(value.screen.threadId)?.sequence ?? 0)) {
      const { threadId: id, ...screen } = value.screen;
      screens.set(id, { sequence: order, value: screen });
      if (screens.size > 256) screens.delete(screens.keys().next().value!);
    }
  }

  function call(input: BrowserCall, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const request = browserRequest.parse({
      ...input,
      id: randomUUID(),
      namespace: options.namespace,
    });
    const encoded = JSON.stringify({ type: 'request', request }) + '\n';
    if (Buffer.byteLength(encoded) > browserRequestBytes)
      return Promise.reject(new Error('The browser request is too large.'));
    const available = options.available?.(input) !== false;
    if (input.method !== 'dispose' && (disposed || uncertain || !available)) {
      if (
        !disposed &&
        uncertain &&
        available &&
        (input.method === 'bindProfile' ||
          (input.method === 'act' && input.input.action === 'open'))
      ) {
        if (input.method === 'act') browserUrl(input.input.url ?? '');
        return recover().then(() => call(input, signal));
      }
      return Promise.reject(
        new Error(
          uncertain && !disposed && available
            ? `The workspace browser is unavailable. ${reopenNotice}`
            : 'The workspace browser is unavailable. Restart Otto before continuing.',
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
      let bytes = 0;
      let response: BrowserResponse | undefined;
      let settled = false;
      let cancelling = false;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const timeoutMs =
        input.method === 'act' && input.input.action === 'open'
          ? (options.openTimeoutMs ?? options.timeoutMs)
          : options.timeoutMs;
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => cancel(), timeoutMs);
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
        clearTimeout(timer);
        if (!response) child.stdin.write(JSON.stringify({ type: 'cancel', id: request.id }) + '\n');
        drainTimer = setTimeout(unavailable, options.drainTimeoutMs ?? 15_000);
      }
      signal?.addEventListener('abort', cancel, { once: true });
      cancellations.add(cancel);
      child.stdin.on('error', unavailable);
      child.on('error', unavailable);
      child.stderr.resume();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > responseBytes || response) return unavailable();
        output += chunk;
        const end = output.indexOf('\n');
        if (end < 0) return;
        try {
          if (output.slice(end + 1)) throw new Error();
          response = browserResponse.parse(JSON.parse(output.slice(0, end)));
          if (response.id !== request.id) throw new Error();
          output = '';
        } catch {
          unavailable();
        }
      });
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0 || !response) return unavailable();
        settled = true;
        cleanup();
        updateMetadata(response.metadata, order, input);
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
      child.stdin.write(encoded);
      if (signal?.aborted) cancel();
    });
    pending.add(result);
    void result.finally(() => pending.delete(result)).catch(() => {});
    return result;
  }

  async function* view(id: string, signal: AbortSignal): AsyncGenerator<Buffer> {
    const threadId = threadIdentity(id);
    signal.throwIfAborted();
    if (disposed || uncertain || options.available?.({ method: 'view', threadId }) === false)
      throw new Error('The workspace browser is unavailable.');
    const request = browserRequest.parse({
      method: 'view',
      threadId,
      id: randomUUID(),
      namespace: options.namespace,
    });
    const child = options.launch({ method: 'view', threadId });
    let closed = false;
    child.on('close', () => (closed = true));
    child.on('error', () => (closed = true));
    child.stdin.on('error', () => {});
    child.stderr.resume();
    let lines = '';
    const write = (frame: unknown) => {
      if (closed) return;
      if (!lines)
        setImmediate(() => {
          if (!closed) child.stdin.write(lines);
          lines = '';
        });
      lines += JSON.stringify(browserFrame.parse(frame)) + '\n';
    };
    const send = (input: unknown) => write({ type: 'input', id: request.id, input });
    const cancel = () => write({ type: 'cancel', id: request.id });
    const open = views.get(threadId) ?? new Set();
    views.set(threadId, open.add(send));
    signal.addEventListener('abort', cancel, { once: true });
    cancellations.add(cancel);
    write({ type: 'request', request });
    try {
      let buffered = '';
      child.stdout.setEncoding('utf8');
      for await (const chunk of child.stdout) {
        buffered += chunk;
        if (buffered.length > viewFrameLine) return;
        for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
          const frame = viewFrame.safeParse(JSON.parse(buffered.slice(0, end)));
          buffered = buffered.slice(end + 1);
          if (!frame.success || frame.data.id !== request.id) return;
          yield Buffer.from(frame.data.frame, 'base64');
        }
      }
    } finally {
      open.delete(send);
      if (!open.size && views.get(threadId) === open) views.delete(threadId);
      signal.removeEventListener('abort', cancel);
      cancellations.delete(cancel);
      cancel();
      if (!closed) setTimeout(() => closed || child.kill('SIGKILL'), 5_000).unref();
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
    status: () => (uncertain && !disposed ? reopenNotice : status),
    act: async (id, input, signal) =>
      observationSchema.parse(
        await call({ method: 'act', threadId: threadIdentity(id), input }, signal),
      ),
    screenshot: image,
    control: async (id, input) => {
      const send = [...(views.get(threadIdentity(id)) ?? [])].at(-1);
      if (!send) throw new Error('The browser view is not open.');
      send(input);
    },
    view,
    upload: async (id, input, signal) => {
      if (!input.bytes.length || input.bytes.length > browserUploadBytes)
        throw new Error('The browser file is too large.');
      return observationSchema.parse(
        await call(
          {
            method: 'upload',
            threadId: threadIdentity(id),
            input: {
              selector: input.selector,
              name: input.name,
              data: Buffer.from(input.bytes).toString('base64'),
            },
          },
          signal,
        ),
      );
    },
    async download(id, input, signal) {
      const result = z
        .object({
          data: z
            .string()
            .min(4)
            .max(Math.ceil(browserDownloadBytes / 3) * 4),
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
        .parse(await call({ method: 'download', threadId: threadIdentity(id), input }, signal));
      if (result.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.data))
        throw new Error('The browser file is unavailable.');
      const bytes = Buffer.from(result.data, 'base64');
      if (
        !bytes.length ||
        bytes.length > browserDownloadBytes ||
        bytes.toString('base64') !== result.data
      )
        throw new Error('The browser file is unavailable.');
      return { bytes, name: result.name, mimeType: result.mimeType };
    },
    currentPage: async (id) =>
      z
        .object({ origin: z.string().max(2048), url: z.string().max(8192) })
        .strict()
        .parse(await call({ method: 'currentPage', threadId: threadIdentity(id) })),
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
    hold: async (id, until) => {
      await call({ method: 'hold', threadId: threadIdentity(id), until });
    },
    close: async (id) => {
      await call({ method: 'close', threadId: threadIdentity(id) });
    },
    discard: async (id) => {
      await call({ method: 'discard', threadId: threadIdentity(id) });
      screens.delete(threadIdentity(id));
    },
    dispose: () => {
      disposing ??= (async () => {
        disposed = true;
        for (const cancel of cancellations) cancel();
        await Promise.allSettled([...pending]);
        await call({ method: 'dispose' });
        screens.clear();
        status = 'Workspace browser is stopped.';
      })().catch((error) => {
        disposing = undefined;
        throw error;
      });
      return disposing;
    },
  };
}
