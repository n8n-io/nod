import { Buffer } from 'node:buffer';
import {
  boundedBody,
  failure,
  generation,
  ownerIdentity,
  RuntimeControlError,
} from './protocol.ts';
import { browserRequestBytes } from '../../../src/ports/computer.ts';
import { threadIdentity } from '../../../src/ports/thread-identity.ts';
import type { ComputerCommand } from './computer-lifecycle.ts';

type Command = {
  id: string;
  generation: string;
  process?: ExecProcess;
  input?: WritableStreamDefaultWriter;
  inputBytes: number;
  outputBytes: number;
  output: ReadableStream<Uint8Array>;
  outputReader: ReadableStreamDefaultReader<Uint8Array>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  attached: boolean;
  ended: boolean;
  completing: boolean;
  terminal: boolean;
  failed: boolean;
  signalled: boolean;
  control: Promise<unknown>;
  signals: Promise<unknown>;
  readers: Set<ReadableStreamDefaultReader>;
  timer: ReturnType<typeof setTimeout>;
  authorizationTimer?: ReturnType<typeof setTimeout>;
};

const outputLimit = 32 * 1024 * 1024;
const receiptLimit = 32;

export function createComputerCommands(options: {
  role: 'browser' | 'workspace';
  authorize(generation: string): Promise<void>;
  launch(input: ComputerCommand): Promise<ExecProcess>;
  completed(input: { id: string; generation: string; code: number }): Promise<void>;
  uncertain(input: { id: string; generation: string }): Promise<void>;
  live(): boolean;
  timeoutMs?: number;
  authorizationIntervalMs?: number;
  receiptTimeoutMs?: number;
}) {
  const inputLimit = (options.role === 'browser' ? browserRequestBytes : 1024 * 1024) + 1024;
  const commands = new Map<string, Command>();
  const receipts = new Map<string, number>();
  const encoder = new TextEncoder();
  const timeout = options.timeoutMs ?? 3_720_000;
  const authorizationInterval = Math.min(options.authorizationIntervalMs ?? 1000, 1000);
  const receiptTimeout = Math.min(options.receiptTimeoutMs ?? 30_000, 30_000);
  if (
    !Number.isFinite(timeout) ||
    timeout <= 0 ||
    !Number.isFinite(authorizationInterval) ||
    authorizationInterval <= 0 ||
    !Number.isFinite(receiptTimeout) ||
    receiptTimeout <= 0
  )
    throw new RuntimeControlError(503);
  const concurrency = options.role === 'browser' ? 32 : 1;
  let fenced = false;
  let fencing: Promise<void> | undefined;

  function key(version: string, id: string) {
    return `${version}:${id}`;
  }

  function expireReceipts() {
    const now = Date.now();
    for (const [id, expires] of receipts) {
      if (expires > now) break;
      receipts.delete(id);
    }
  }

  function remember(command: Command) {
    const id = key(command.generation, command.id);
    commands.delete(id);
    expireReceipts();
    receipts.set(id, Date.now() + receiptTimeout);
    while (receipts.size > receiptLimit) receipts.delete(receipts.keys().next().value!);
  }

  function finish(command: Command) {
    if (command.failed) throw new RuntimeControlError(503);
    command.terminal = true;
    clearTimeout(command.timer);
    clearTimeout(command.authorizationTimer);
    const input = command.input;
    void input
      ?.close()
      .catch(() => {})
      .finally(() => {
        try {
          input.releaseLock();
        } catch {}
        if (command.input === input) command.input = undefined;
      });
    command.process = undefined;
    remember(command);
  }

  function stopProcess(command: Command) {
    void command.outputReader
      .cancel()
      .catch(() => {})
      .finally(() => command.outputReader.releaseLock());
    try {
      if (command.process && !command.signalled) {
        command.signalled = true;
        command.process.kill(9);
      }
    } catch {}
    const input = command.input;
    void input
      ?.abort()
      .catch(() => {})
      .finally(() => {
        try {
          input.releaseLock();
        } catch {}
        if (command.input === input) command.input = undefined;
      });
    for (const reader of command.readers) void reader.cancel().catch(() => {});
    for (const stream of [command.process?.stdout, command.process?.stderr]) {
      try {
        if (stream && !stream.locked) void stream.cancel().catch(() => {});
      } catch {}
    }
  }

  function fail(command: Command): Promise<void> {
    if (command.terminal) return fencing ?? Promise.resolve();
    if (command.failed) return fencing ?? Promise.resolve();
    fenced = true;
    const affected = [...commands.values()].filter((entry) => !entry.terminal && !entry.failed);
    for (const entry of affected) {
      entry.failed = true;
      clearTimeout(entry.timer);
      clearTimeout(entry.authorizationTimer);
      void entry.writer
        .abort(new Error('The computer command did not finish safely.'))
        .catch(() => {});
      stopProcess(entry);
    }
    fencing = Promise.all(
      affected.map((entry) =>
        Promise.resolve()
          .then(() => options.uncertain({ id: entry.id, generation: entry.generation }))
          .catch(() => {}),
      ),
    ).then(() => {});
    return fencing;
  }

  function watchAuthorization(command: Command) {
    command.authorizationTimer = setTimeout(() => {
      if (command.failed || command.terminal) return;
      void Promise.resolve()
        .then(() => options.authorize(command.generation))
        .then(
          () => {
            if (!command.failed && !command.terminal) watchAuthorization(command);
          },
          () => fail(command),
        );
    }, authorizationInterval);
  }

  async function frame(command: Command, value: unknown) {
    if (command.failed || command.terminal) throw new RuntimeControlError(503);
    await command.writer.write(encoder.encode(JSON.stringify(value) + '\n'));
  }

  async function drain(command: Command, stream: ReadableStream | null, type: 'stdout' | 'stderr') {
    if (!stream) throw new RuntimeControlError(503);
    const reader = stream.getReader();
    command.readers.add(reader);
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) throw new RuntimeControlError(503);
        command.outputBytes += next.value.byteLength;
        if (command.outputBytes > outputLimit) throw new RuntimeControlError(413);
        for (let offset = 0; offset < next.value.byteLength; offset += 16 * 1024)
          await frame(command, {
            type,
            data: Buffer.from(next.value.subarray(offset, offset + 16 * 1024)).toString('base64'),
          });
      }
    } catch {
      await fail(command);
      throw new RuntimeControlError(503);
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
      command.readers.delete(reader);
    }
  }

  async function collect(command: Command) {
    try {
      const process = command.process!;
      const [code] = await Promise.all([
        process.exitCode,
        drain(command, process.stdout, 'stdout'),
        drain(command, process.stderr, 'stderr'),
      ]);
      if (command.failed || !Number.isSafeInteger(code)) throw new RuntimeControlError(503);
      command.completing = true;
      await Promise.all([command.control, command.signals]);
      if (command.failed) throw new RuntimeControlError(503);
      await options.authorize(command.generation);
      await options.completed({ id: command.id, generation: command.generation, code });
      await options.authorize(command.generation);
      await frame(command, { type: 'exit', code });
      await command.writer.close();
      command.writer.releaseLock();
    } catch {
      await fail(command);
    }
  }

  async function create(request: Request, version: string) {
    let input: {
      id: string;
      role: string;
      threadId?: string;
      connected?: number;
      session?: boolean;
    };
    try {
      input = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
          await boundedBody(request, 512),
        ),
      );
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (key) => !['id', 'role', 'threadId', 'connected', 'session'].includes(key),
        ) ||
        input.role !== options.role ||
        (input.threadId !== undefined && typeof input.threadId !== 'string') ||
        (input.session !== undefined && (input.session !== true || options.role !== 'workspace')) ||
        (input.connected !== undefined &&
          (!Number.isInteger(input.connected) ||
            input.connected < 20_000 ||
            input.connected >= 60_000 ||
            options.role !== 'workspace')) ||
        (input.connected && input.session) ||
        (options.role === 'workspace' && !input.threadId) ||
        (options.role === 'browser' && input.threadId !== undefined)
      )
        throw new Error();
      ownerIdentity(input.id);
      if (input.threadId !== undefined) threadIdentity(input.threadId);
    } catch (error) {
      if (error instanceof RuntimeControlError) throw error;
      throw new RuntimeControlError(400);
    }
    if (
      fenced ||
      commands.has(key(version, input.id)) ||
      receipts.has(key(version, input.id)) ||
      [...commands.values()].filter((entry) => !entry.terminal && !entry.failed).length >=
        concurrency
    )
      throw new RuntimeControlError(409);
    const output = new TransformStream<Uint8Array, Uint8Array>();
    const writer = output.writable.getWriter();
    const reader = output.readable.getReader();
    const command: Command = {
      id: input.id,
      generation: version,
      inputBytes: 0,
      outputBytes: 0,
      output: new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const next = await reader.read();
              if (command.failed) throw new RuntimeControlError(503);
              if (next.done) {
                finish(command);
                reader.releaseLock();
                controller.close();
              } else controller.enqueue(next.value);
            } catch {
              controller.error(new Error('The computer command did not finish safely.'));
              reader.releaseLock();
              await fail(command);
            }
          },
          async cancel() {
            void reader
              .cancel()
              .catch(() => {})
              .finally(() => reader.releaseLock());
            await fail(command);
          },
        },
        { highWaterMark: 0 },
      ),
      outputReader: reader,
      writer,
      attached: false,
      ended: false,
      completing: false,
      terminal: false,
      failed: false,
      signalled: false,
      control: Promise.resolve(),
      signals: Promise.resolve(),
      readers: new Set(),
      timer: setTimeout(() => void fail(command), timeout),
    };
    commands.set(key(version, input.id), command);
    void writer.closed.catch(() => fail(command));
    let rejected = false;
    try {
      await options.authorize(version);
      watchAuthorization(command);
      try {
        command.process = await options.launch({
          id: input.id,
          generation: version,
          threadId: input.threadId,
          ...(input.connected && { connected: input.connected }),
          ...(input.session && { session: true }),
        });
      } catch (error) {
        rejected = !command.failed && error instanceof RuntimeControlError && error.status === 409;
        throw error;
      }
      void command.process.exitCode.catch(() => {});
      if (command.process.stdin) command.input = command.process.stdin.getWriter();
      if (command.failed || !command.process.stdin) throw new RuntimeControlError(503);
      await options.authorize(version);
      if (command.failed) throw new RuntimeControlError(503);
      void collect(command);
      return Response.json(
        { id: input.id },
        { status: 201, headers: { 'cache-control': 'no-store' } },
      );
    } catch {
      if (rejected) {
        command.terminal = true;
        clearTimeout(command.timer);
        clearTimeout(command.authorizationTimer);
        commands.delete(key(version, input.id));
        await writer.abort().catch(() => {});
        reader.releaseLock();
        writer.releaseLock();
        throw new RuntimeControlError(409);
      }
      stopProcess(command);
      await fail(command);
      throw new RuntimeControlError(503);
    }
  }

  function controlSignal(action: string, body: Uint8Array) {
    let signal: unknown;
    if (action === 'end' && body.byteLength) throw new RuntimeControlError(400);
    if (action === 'kill') {
      try {
        const input = JSON.parse(
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body),
        );
        if (!input || Object.keys(input).length !== 1) throw new Error();
        signal = input.signal;
      } catch {
        throw new RuntimeControlError(400);
      }
      if (signal !== 'SIGTERM' && signal !== 'SIGKILL') throw new RuntimeControlError(400);
    }
    return signal;
  }

  async function control(command: Command, action: string, body: Uint8Array) {
    if (action === 'input' && (command.completing || command.terminal || command.ended))
      throw new RuntimeControlError(409);
    if (action === 'input') {
      command.inputBytes += body.byteLength;
      if (command.inputBytes > inputLimit) throw new RuntimeControlError(413);
    }
    const signal = controlSignal(action, body);
    if (command.completing || command.terminal)
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    const operation = (action === 'kill' ? command.signals : command.control).then(async () => {
      await options.authorize(command.generation);
      if (command.failed) throw new RuntimeControlError(503);
      if (action === 'input') {
        if (command.terminal || command.ended) throw new RuntimeControlError(409);
        await command.input!.write(body);
      } else if (action === 'end') {
        if (command.terminal || command.ended) return;
        command.ended = true;
        await command.input!.close();
      } else {
        if (!command.terminal) command.process!.kill(signal === 'SIGTERM' ? 15 : 9);
      }
      await options.authorize(command.generation);
      if (command.failed) throw new RuntimeControlError(503);
    });
    if (action === 'kill') command.signals = operation;
    else command.control = operation;
    try {
      await operation;
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      await fail(command);
      throw error;
    }
  }

  return {
    get active() {
      return [...commands.values()].filter((entry) => !entry.terminal && !entry.failed).length;
    },
    get uncertain() {
      return fenced;
    },
    async stop() {
      fenced = true;
      await Promise.all([...commands.values()].map(fail));
      await fencing;
    },
    async fetch(request: Request) {
      expireReceipts();
      let selected: Command | undefined;
      let fenceOnError = false;
      try {
        const url = new URL(request.url);
        const version = generation(request.headers.get('x-otto-generation'));
        if (url.search || url.hash) throw new RuntimeControlError(404);
        if (url.pathname === '/v1/commands' && request.method === 'POST') {
          await options.authorize(version);
          return await create(request, version);
        }
        if (url.pathname === '/v1/status' && request.method === 'GET') {
          await options.authorize(version);
          return Response.json(
            { live: !fenced && options.live() },
            { headers: { 'cache-control': 'no-store' } },
          );
        }
        const match = /^\/v1\/commands\/([0-9a-f-]{36})\/(input|end|kill|output)$/.exec(
          url.pathname,
        );
        if (!match) throw new RuntimeControlError(404);
        const id = key(version, ownerIdentity(match[1]));
        const command = commands.get(id);
        if (!command) {
          if (!receipts.has(id)) throw new RuntimeControlError(404);
          await options.authorize(version);
          if (match[2] === 'output')
            throw new RuntimeControlError(request.method === 'GET' ? 409 : 405);
          if (request.method !== 'POST') throw new RuntimeControlError(405);
          const body = await boundedBody(request, match[2] === 'input' ? inputLimit : 128);
          if (match[2] === 'input') throw new RuntimeControlError(409);
          controlSignal(match[2], body);
          return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
        }
        selected = command;
        fenceOnError = true;
        await options.authorize(version);
        fenceOnError = false;
        if (command.failed) throw new RuntimeControlError(503);
        if (match[2] === 'output') {
          if (request.method !== 'GET') throw new RuntimeControlError(405);
          if (command.attached) throw new RuntimeControlError(409);
          command.attached = true;
          return new Response(command.output, {
            headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' },
          });
        }
        if (request.method !== 'POST') throw new RuntimeControlError(405);
        fenceOnError = true;
        const body = await boundedBody(request, match[2] === 'input' ? inputLimit : 128);
        return await control(command, match[2], body);
      } catch (error) {
        if (
          selected &&
          !selected.terminal &&
          fenceOnError &&
          !(error instanceof RuntimeControlError && error.status === 409)
        )
          await fail(selected);
        return failure(error);
      }
    },
  };
}
