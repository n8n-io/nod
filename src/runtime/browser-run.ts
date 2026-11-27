import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import {
  BrowserActionError,
  type BrowserAction,
  type BrowserObservation,
} from '../ports/computer.ts';

const maxSteps = 20;
const scriptTimeoutMs = 30_000;
const maxOutputChars = 40_000;
const maxConsoleLogs = 100;

export interface BrowserRunActResult {
  page: BrowserObservation;
  choice?: string;
}

export interface BrowserRunHandlers {
  signal: AbortSignal;
  act(
    step: BrowserAction,
    started?: () => void,
    options?: { observe?: boolean; signal?: AbortSignal },
  ): Promise<BrowserRunActResult | { output: unknown }>;
  record(
    step: { action: string; text?: string; key?: string },
    page: BrowserObservation,
    choice?: string,
  ): void;
  format(page: BrowserObservation, full?: boolean): string;
  screenshot(signal?: AbortSignal): Promise<Buffer | undefined>;
}

interface ApprovalPause {
  stepIndex: number;
  action: string;
  output: unknown;
}

interface WorkerRequest {
  type: 'call';
  id: number;
  method: string;
  args: unknown[];
}

interface WorkerDone {
  type: 'done';
  result: string;
  hasResult: boolean;
  logs: string[];
}

interface WorkerError {
  type: 'error';
  message: string;
  logs: string[];
}

type WorkerMessage = WorkerRequest | WorkerDone | WorkerError;

const sandboxSource = `'use strict';
const { createContext, Script } = require('node:vm');
const readline = require('node:readline');
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const dgram = require('node:dgram');
const dns = require('node:dns');

const networkBlocked = () => {
  throw new Error('Network access is disabled inside browser_run.');
};
net.Socket.prototype.connect = networkBlocked;
net.connect = networkBlocked;
net.createConnection = networkBlocked;
tls.connect = networkBlocked;
http.request = networkBlocked;
http.get = networkBlocked;
https.request = networkBlocked;
https.get = networkBlocked;
dgram.createSocket = networkBlocked;
dns.lookup = networkBlocked;
dns.resolve = networkBlocked;
if (dns.promises) {
  dns.promises.lookup = networkBlocked;
  dns.promises.resolve = networkBlocked;
}
Object.defineProperty(globalThis, 'fetch', { value: undefined, writable: false, configurable: false });
Object.defineProperty(globalThis, 'WebSocket', { value: undefined, writable: false, configurable: false });

const send = (msg, done) => {
  process.stdout.write(JSON.stringify(msg) + '\\n', done);
};

let nextId = 1;
const pending = new Map();
const logs = [];
const maxLogs = ${maxConsoleLogs};

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === 'start') {
    void runScript(String(msg.code || ''));
    return;
  }
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  if (msg.ok) entry.resolve(msg.value);
  else entry.reject(new Error(msg.error));
});

function invoke(method, args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ type: 'call', id, method, args });
  });
}

function safeSerialize(value) {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value, null, 2);
    if (typeof json === 'string') return json;
  } catch {}
  try {
    return String(value);
  } catch {
    return '[unserializable]';
  }
}

const context = createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false },
});

const bridge = new Script(\`
(function(invokeJson, logJson) {
  function safeString(value) {
    if (value === undefined) return '';
    if (typeof value === 'string') return value;
    try {
      const json = JSON.stringify(value, null, 2);
      if (typeof json === 'string') return json;
    } catch {}
    try {
      return String(value);
    } catch {
      return '[unserializable]';
    }
  }
  function call(method, args) {
    return new Promise(function(resolve, reject) {
      let serializedArgs;
      try {
        serializedArgs = JSON.stringify(args);
      } catch (err) {
        reject(new Error(safeString(err && err.message ? err.message : err)));
        return;
      }
      invokeJson(String(method), serializedArgs, function(err, raw) {
        if (err) {
          reject(new Error(String(err)));
          return;
        }
        try {
          resolve(raw === undefined ? undefined : JSON.parse(String(raw)));
        } catch (parseErr) {
          reject(new Error(safeString(parseErr && parseErr.message ? parseErr.message : parseErr)));
        }
      });
    });
  }
  function makeArgs() {
    var out = [];
    for (var i = 0; i < arguments.length; i++) out.push(arguments[i]);
    return out;
  }
  function formatLog() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(safeString(arguments[i]));
    return parts.join(' ').slice(0, 4000);
  }
  const methods = [
    'open', 'snapshot', 'click', 'fill', 'type', 'press', 'select',
    'check', 'uncheck', 'hover', 'drag', 'scroll', 'back', 'forward',
    'reload', 'wait', 'evaluate', 'tabList', 'tabSwitch',
    'acceptDialog', 'dismissDialog', 'screenshot'
  ];
  const page = Object.create(null);
  for (let i = 0; i < methods.length; i++) {
    const name = methods[i];
    page[name] = function() {
      return call(name, makeArgs.apply(null, arguments));
    };
  }
  Object.freeze(page);
  const consoleObj = Object.freeze({
    log: function() { logJson(formatLog.apply(null, arguments)); },
    warn: function() { logJson(formatLog.apply(null, arguments)); },
    error: function() { logJson(formatLog.apply(null, arguments)); },
  });
  Object.defineProperty(globalThis, 'page', {
    value: page,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  Object.defineProperty(globalThis, 'console', {
    value: consoleObj,
    writable: false,
    configurable: false,
    enumerable: true,
  });
})
\`).runInContext(context);

bridge(
  (method, rawArgs, done) => {
    try {
      let args = [];
      try {
        args = JSON.parse(typeof rawArgs === 'string' ? rawArgs : '[]');
        if (!Array.isArray(args)) args = [];
      } catch {
        args = [];
      }
      invoke(typeof method === 'string' ? method : '', args).then(
        (val) => {
          try {
            done(null, val === undefined ? undefined : JSON.stringify(val));
          } catch {}
        },
        (err) => {
          try {
            done(err && typeof err.message === 'string' ? err.message : 'Browser action failed.');
          } catch {}
        },
      );
    } catch {
      try {
        done('Browser action failed.');
      } catch {}
    }
  },
  (line) => {
    try {
      if (logs.length >= maxLogs) return;
      if (typeof line === 'string') logs.push(line.slice(0, 4000));
    } catch {}
  },
);

async function runScript(code) {
  let payload;
  try {
    const script = new Script('(async () => {\\n' + code + '\\n})()', {
      filename: 'browser_run.js',
    });
    const value = await script.runInContext(context);
    const hasResult = value !== undefined;
    const result = hasResult ? safeSerialize(value) : '';
    payload = { type: 'done', result, hasResult, logs };
  } catch (error) {
    const message = error && typeof error.message === 'string' ? error.message : safeSerialize(error);
    payload = { type: 'error', message, logs };
  }
  rl.close();
  send(payload, () => {
    process.exit(0);
  });
}
`;

function optObj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Expected string for ${field}.`);
  return value;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function buildAction(
  method: string,
  args: unknown[],
): { step: BrowserAction; observe: boolean } | 'screenshot' {
  if (method === 'screenshot') return 'screenshot';
  switch (method) {
    case 'open': {
      const url = asString(args[0], 'url');
      const opts = optObj(args[1]);
      const waitMs = asOptionalNumber(opts.waitMs);
      return {
        step: { action: 'open', url, ...(waitMs !== undefined ? { waitMs } : {}) },
        observe: false,
      };
    }
    case 'snapshot': {
      const opts = optObj(args[0]);
      const selector = asOptionalString(opts.selector);
      const offset = asOptionalNumber(opts.offset);
      return {
        step: {
          action: 'snapshot',
          ...(selector ? { selector } : {}),
          ...(offset !== undefined ? { offset } : {}),
        },
        observe: true,
      };
    }
    case 'click': {
      const selector = asString(args[0], 'selector');
      const opts = optObj(args[1]);
      const waitMs = asOptionalNumber(opts.waitMs);
      return {
        step: { action: 'click', selector, ...(waitMs !== undefined ? { waitMs } : {}) },
        observe: false,
      };
    }
    case 'fill': {
      const selector = asString(args[0], 'selector');
      const text = asString(args[1], 'text');
      const opts = optObj(args[2]);
      const waitMs = asOptionalNumber(opts.waitMs);
      return {
        step: { action: 'fill', selector, text, ...(waitMs !== undefined ? { waitMs } : {}) },
        observe: false,
      };
    }
    case 'type': {
      const selector = asString(args[0], 'selector');
      const text = asString(args[1], 'text');
      const opts = optObj(args[2]);
      const waitMs = asOptionalNumber(opts.waitMs);
      return {
        step: { action: 'type', selector, text, ...(waitMs !== undefined ? { waitMs } : {}) },
        observe: false,
      };
    }
    case 'press': {
      const key = asString(args[0], 'key');
      const opts = optObj(args[1]);
      const waitMs = asOptionalNumber(opts.waitMs);
      return {
        step: { action: 'press', key, ...(waitMs !== undefined ? { waitMs } : {}) },
        observe: false,
      };
    }
    case 'select': {
      const selector = asString(args[0], 'selector');
      const text = asString(args[1], 'text');
      const opts = optObj(args[2]);
      const waitMs = asOptionalNumber(opts.waitMs);
      return {
        step: { action: 'select', selector, text, ...(waitMs !== undefined ? { waitMs } : {}) },
        observe: false,
      };
    }
    case 'check':
      return { step: { action: 'check', selector: asString(args[0], 'selector') }, observe: false };
    case 'uncheck':
      return {
        step: { action: 'uncheck', selector: asString(args[0], 'selector') },
        observe: false,
      };
    case 'hover':
      return { step: { action: 'hover', selector: asString(args[0], 'selector') }, observe: false };
    case 'drag':
      return {
        step: {
          action: 'drag',
          selector: asString(args[0], 'selector'),
          targetSelector: asString(args[1], 'targetSelector'),
        },
        observe: false,
      };
    case 'scroll': {
      const direction = args[0] === 'up' ? 'up' : 'down';
      const opts = optObj(args[1]);
      const amount = asOptionalNumber(opts.amount);
      const selector = asOptionalString(opts.selector);
      return {
        step: {
          action: 'scroll',
          direction,
          ...(amount !== undefined ? { amount } : {}),
          ...(selector ? { selector } : {}),
        },
        observe: false,
      };
    }
    case 'back':
      return { step: { action: 'back' }, observe: false };
    case 'forward':
      return { step: { action: 'forward' }, observe: false };
    case 'reload':
      return { step: { action: 'reload' }, observe: false };
    case 'wait': {
      const opts = optObj(args[0]);
      const text = asOptionalString(opts.text);
      const url = asOptionalString(opts.url);
      const load =
        opts.load === 'load' || opts.load === 'domcontentloaded' || opts.load === 'networkidle'
          ? opts.load
          : undefined;
      const waitMs = asOptionalNumber(opts.waitMs);
      return {
        step: {
          action: 'wait',
          ...(text ? { text } : {}),
          ...(url ? { url } : {}),
          ...(load ? { load } : {}),
          ...(waitMs !== undefined ? { waitMs } : {}),
        },
        observe: false,
      };
    }
    case 'evaluate':
      return { step: { action: 'evaluate', script: asString(args[0], 'script') }, observe: true };
    case 'tabList':
      return { step: { action: 'tab_list' }, observe: true };
    case 'tabSwitch':
      return {
        step: { action: 'tab_switch', tabId: asString(args[0], 'tabId') },
        observe: false,
      };
    case 'acceptDialog': {
      const text = asOptionalString(args[0]);
      return {
        step: { action: 'accept_dialog', ...(text !== undefined ? { text } : {}) },
        observe: false,
      };
    }
    case 'dismissDialog':
      return { step: { action: 'dismiss_dialog' }, observe: false };
    default:
      throw new Error(`Unknown page method: ${method}`);
  }
}

function formatActionCount(count: number): string {
  return `${count} ${count === 1 ? 'action' : 'actions'}`;
}

export async function runBrowserScript(
  code: string,
  handlers: BrowserRunHandlers,
): Promise<unknown> {
  if (!code.trim()) throw new Error('Provide JavaScript code to run.');
  handlers.signal.throwIfAborted();

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(handlers.signal.reason);
  handlers.signal.addEventListener('abort', onOuterAbort, { once: true });

  const actions: string[] = [];
  const env: NodeJS.ProcessEnv = {
    ELECTRON_RUN_AS_NODE: '1',
    ...(process.platform === 'win32' ? { SystemRoot: 'C:\\Windows' } : {}),
  };
  let reserved = 0;
  let lastPage: BrowserObservation | undefined;
  let lastObservedText = '';
  let lastWasSnapshot = false;
  let capturedImage: Buffer | undefined;
  let paused: ApprovalPause | undefined;
  let timedOut = false;
  let actionQueue = Promise.resolve();
  let inFlight: { index: number; action: string; started: boolean } | undefined;
  let interrupted: { index: number; action: string; started: boolean } | undefined;

  const withActionSummary = (message: string) => {
    const prefix: string[] = [];
    if (actions.length) {
      prefix.push(`Ran ${formatActionCount(actions.length)}: ${actions.join(', ')}.`);
    }
    const active = interrupted ?? inFlight;
    if (active) {
      const status = active.started ? 'was still running and may have taken effect' : 'did not run';
      prefix.push(`Action ${active.index + 1} (${active.action}) ${status}.`);
    }
    return prefix.length ? `${prefix.join(' ')} ${message}` : message;
  };

  const stopError = () => {
    if (paused) return new Error('Browser run paused for approval.');
    if (timedOut) return new Error(`browser_run timed out after ${scriptTimeoutMs / 1000}s.`);
    if (controller.signal.aborted) {
      return controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error('Browser run aborted.');
    }
    return undefined;
  };

  const reserveSlot = () => {
    const err = stopError();
    if (err) throw err;
    if (reserved >= maxSteps) throw new Error(`browser_run reached the ${maxSteps}-action limit.`);
    return reserved++;
  };

  const executeMethod = async (method: string, args: unknown[]): Promise<unknown> => {
    const built = buildAction(method, args);
    const index = reserveSlot();
    let result: unknown;
    let failure: unknown;
    const run = async () => {
      const err = stopError();
      if (err) throw err;
      if (built === 'screenshot') {
        const image = await handlers.screenshot(controller.signal);
        actions.push('screenshot');
        capturedImage = image;
        return Boolean(image);
      }
      const { step, observe } = built;
      const current = { index, action: step.action, started: false };
      inFlight = current;
      let done: BrowserRunActResult | { output: unknown };
      try {
        done = await handlers.act(
          step,
          () => {
            current.started = true;
          },
          { observe, signal: controller.signal },
        );
      } catch (error) {
        inFlight = undefined;
        if (controller.signal.aborted) {
          interrupted ??= {
            index: current.index,
            action: current.action,
            started: current.started,
          };
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        const ran = actions.length
          ? `Ran ${formatActionCount(actions.length)}: ${actions.join(', ')}. `
          : '';
        const status = current.started ? 'failed and may have taken effect' : 'did not run';
        const staleRefHint =
          error instanceof BrowserActionError &&
          error.code === 'browser_target_changed' &&
          actions.some((a) =>
            ['open', 'back', 'forward', 'reload', 'click', 'tab_switch'].includes(a),
          )
            ? ' Refs from before navigation or page change are stale; call await page.snapshot() after open/back/click before using @eN refs.'
            : '';
        const detail = `${ran}Action ${index + 1} (${step.action}) ${status}. ${message}${staleRefHint}`;
        if (error instanceof BrowserActionError) {
          throw new Error(detail, { cause: error });
        }
        throw new Error(detail, { cause: error });
      }
      inFlight = undefined;
      if ('output' in done) {
        paused = { stepIndex: index, action: step.action, output: done.output };
        controller.abort(new Error('Browser run paused for approval.'));
        throw new Error('Browser run paused for approval.');
      }
      actions.push(step.action);
      handlers.record(step, done.page, done.choice);
      lastPage = done.page;
      lastWasSnapshot = step.action === 'snapshot';
      if (done.page.text) lastObservedText = done.page.text;

      if (step.action === 'evaluate') {
        const prefix = 'Script result (JSON):\n';
        if (done.page.text.startsWith(prefix)) {
          try {
            return JSON.parse(done.page.text.slice(prefix.length));
          } catch {
            return done.page.text.slice(prefix.length);
          }
        }
        return done.page.text;
      }
      if (step.action === 'tab_list') return done.page.text;
      if (step.action === 'wait') {
        return { url: done.page.url, text: done.page.text, unmet: done.page.unmet ?? false };
      }
      return { url: done.page.url, text: done.page.text };
    };

    const queued = actionQueue.then(
      () => run(),
      () => run(),
    );
    actionQueue = queued.then(
      (value) => {
        result = value;
      },
      (error) => {
        failure = error;
      },
    );
    await actionQueue;
    if (failure !== undefined) throw failure;
    return result;
  };

  let logs: string[] = [];
  let serialized = '';
  let hasResult = false;
  let child: ChildProcessByStdio<Writable, Readable, null> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let runFailure:
    | { kind: 'timeout' }
    | { kind: 'abort'; reason: unknown }
    | { kind: 'script'; message: string }
    | { kind: 'worker'; error: unknown }
    | { kind: 'exit'; exitCode: number | null; signal: NodeJS.Signals | null }
    | undefined;

  const terminateChild = () => {
    const current = child;
    child = undefined;
    if (!current) return;
    try {
      current.stdin.destroy();
      current.kill('SIGKILL');
    } catch {}
  };

  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
        resolve();
      };

      const onAbort = () => {
        terminateChild();
        if (!paused) {
          if (timedOut) runFailure ??= { kind: 'timeout' };
          else runFailure ??= { kind: 'abort', reason: controller.signal.reason };
        }
        finish();
      };

      controller.signal.addEventListener('abort', onAbort, { once: true });

      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error(`browser_run timed out after ${scriptTimeoutMs / 1000}s.`));
      }, scriptTimeoutMs);

      child = spawn(
        process.execPath,
        [
          '--permission',
          '--disallow-code-generation-from-strings',
          '--max-old-space-size=64',
          '-e',
          sandboxSource,
        ],
        { env, stdio: ['pipe', 'pipe', 'ignore'] },
      );

      const sendToChild = (msg: Record<string, unknown>) => {
        if (settled || !child || child.stdin.destroyed) return;
        try {
          child.stdin.write(JSON.stringify(msg) + '\n');
        } catch {}
      };

      const stdoutLines: string[] = [];
      let stdoutBuffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        for (let end = stdoutBuffer.indexOf('\n'); end >= 0; end = stdoutBuffer.indexOf('\n')) {
          const line = stdoutBuffer.slice(0, end);
          stdoutBuffer = stdoutBuffer.slice(end + 1);
          if (line) stdoutLines.push(line);
        }
        const pendingCalls: WorkerRequest[] = [];
        let terminal: WorkerDone | WorkerError | undefined;
        for (const line of stdoutLines.splice(0)) {
          let msg: WorkerMessage;
          try {
            msg = JSON.parse(line) as WorkerMessage;
          } catch {
            continue;
          }
          if (msg.type === 'done' || msg.type === 'error') {
            terminal = msg;
            break;
          }
          if (msg.type === 'call') pendingCalls.push(msg);
        }
        if (terminal) {
          if (terminal.type === 'done') {
            logs = terminal.logs;
            serialized = terminal.result;
            hasResult = terminal.hasResult;
            finish();
            return;
          }
          logs = terminal.logs;
          runFailure ??= { kind: 'script', message: terminal.message };
          if (!controller.signal.aborted) controller.abort(new Error(terminal.message));
          finish();
          return;
        }
        for (const msg of pendingCalls) {
          void executeMethod(msg.method, msg.args).then(
            (value) => {
              sendToChild({ id: msg.id, ok: true, value });
            },
            (error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              sendToChild({ id: msg.id, ok: false, error: message });
            },
          );
        }
      });

      child.stdin.on('error', () => {});

      child.on('error', (error) => {
        runFailure ??= { kind: 'worker', error };
        if (!controller.signal.aborted) controller.abort(error);
        finish();
      });

      child.on('close', (exitCode, exitSignal) => {
        if (settled) return;
        if (!paused) {
          if (timedOut) runFailure ??= { kind: 'timeout' };
          else runFailure ??= { kind: 'exit', exitCode, signal: exitSignal };
          const detail = exitSignal ? `signal ${exitSignal}` : `exit code ${exitCode ?? 'unknown'}`;
          if (!controller.signal.aborted)
            controller.abort(new Error(`browser_run exited unexpectedly (${detail}).`));
        }
        finish();
      });

      sendToChild({ type: 'start', code });
    });
  } finally {
    if (timer) clearTimeout(timer);
    handlers.signal.removeEventListener('abort', onOuterAbort);
    terminateChild();
    await actionQueue.catch(() => {});
  }

  if (paused) {
    const pause: ApprovalPause = paused;
    return {
      steps: actions.length
        ? `Ran ${formatActionCount(actions.length)}: ${actions.join(', ')}.`
        : 'Ran 0 actions.',
      stopped: `Action ${pause.stepIndex + 1} (${pause.action}) and the code after it did not run.`,
      result: pause.output,
    };
  }

  if (runFailure) {
    if (runFailure.kind === 'timeout') {
      throw new Error(withActionSummary(`browser_run timed out after ${scriptTimeoutMs / 1000}s.`));
    }
    if (runFailure.kind === 'abort') {
      if (runFailure.reason instanceof Error) throw runFailure.reason;
      throw new Error(withActionSummary('Browser run aborted.'));
    }
    if (runFailure.kind === 'script') {
      const message =
        runFailure.message.startsWith('Ran ') || runFailure.message.startsWith('Action ')
          ? runFailure.message
          : withActionSummary(runFailure.message);
      throw new Error(message);
    }
    if (runFailure.kind === 'worker') {
      throw runFailure.error instanceof Error
        ? runFailure.error
        : new Error(withActionSummary(String(runFailure.error)));
    }
    const detail = runFailure.signal
      ? `signal ${runFailure.signal}`
      : `exit code ${runFailure.exitCode ?? 'unknown'}`;
    throw new Error(withActionSummary(`browser_run exited unexpectedly (${detail}).`));
  }

  handlers.signal.throwIfAborted();

  let finalPageText = '';
  if (actions.length > 0 && !capturedImage) {
    if (lastPage && lastObservedText && lastWasSnapshot) {
      finalPageText = handlers.format(lastPage, true);
    } else if (
      lastPage &&
      lastPage.text.startsWith('A ') &&
      lastPage.text.includes('dialog blocks the page')
    ) {
      finalPageText = `URL: ${lastPage.url}\n${lastPage.text}`;
    } else if (!hasResult) {
      const done = await handlers.act({ action: 'snapshot' }, undefined, {
        observe: true,
        signal: handlers.signal,
      });
      if (!('output' in done)) {
        handlers.record({ action: 'snapshot' }, done.page);
        finalPageText = handlers.format(done.page, false);
      }
    }
  }

  const parts: string[] = [];
  if (actions.length)
    parts.push(`Ran ${formatActionCount(actions.length)}: ${actions.join(', ')}.`);
  if (logs.length) parts.push(`Console:\n${logs.join('\n')}`);
  if (serialized) parts.push(`Result:\n${serialized}`);
  if (finalPageText) parts.push(finalPageText);

  let text = parts.join('\n\n') || 'Done.';
  if (text.length > maxOutputChars) {
    text = `${text.slice(0, maxOutputChars)}\n… (truncated)`;
  }

  if (capturedImage) {
    return {
      content: [
        { type: 'text', text },
        { type: 'image', data: capturedImage.toString('base64'), mimeType: 'image/png' },
      ],
      details: {},
    };
  }

  return text;
}
