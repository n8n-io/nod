import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type {
  BrowserAction,
  BrowserDownloadInput,
  BrowserUploadInput,
  BrowserObservation,
  Computer,
  CredentialInput,
  CredentialSubmission,
  BrowserPage,
} from '../../ports/computer.ts';
import { BrowserActionError, browserUploadBytes } from '../../ports/computer.ts';
import type { BrowserHandoffInput } from '../../shared/browser-handoff.ts';
import { threadIdentity } from '../../ports/thread-identity.ts';
import { runProcess, serviceEnvironment } from '../process.ts';
import { createBrowserProxy, browserUrl } from './network.ts';
import { credentialFields } from './credentials.ts';
import {
  createScreenStore,
  existingDaemonCommand,
  DaemonCommandError,
  DaemonTransportError,
  type StoredScreen,
} from './screens.ts';
import {
  createDownloadCapture,
  decodeDownload,
  downloadName,
  fetchDownloadScript,
  readDownload,
  waitForDownload,
} from './downloads.ts';

interface BrowserState {
  id: string;
  queue: Promise<unknown>;
  injecting: boolean;
  secrets: Set<string>;
  secretsByOrigin: Map<string, Set<string>>;
  typed?: { value: string; origin: string; field: number; fresh: boolean };
  protectedSelectors: Set<string>;
  uploads: Set<string>;
  started: boolean;
  lastUsed: number;
  busy: number;
  closed: boolean;
  closing: boolean;
  heldUntil: number;
  socket?: string;
  recovered?: boolean;
  saved: StoredScreen;
  browserExecutable?: string;
}
export interface BrowserDiagnostic {
  at: string;
  phase: 'url' | 'screenshot' | 'snapshot' | 'cleanup' | 'command';
  outcome:
    'completed' | 'daemon_rejected' | 'action_rejected' | 'failed' | DaemonTransportError['kind'];
  elapsedMs: number;
}

class BrowserLockedError extends Error {
  statusCode = 423;
  constructor() {
    super('Browser observations are paused during credential entry.');
  }
}
export function browserSessionId(id: string): string {
  return `sk-${createHash('sha256').update(threadIdentity(id)).digest('hex').slice(0, 24)}`;
}

export function redactBrowserText(text: string, secrets: Iterable<string>): string {
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    variants.add(secret);
    try {
      variants.add(encodeURIComponent(secret));
      variants.add(encodeURI(secret));
      variants.add(new URLSearchParams({ value: secret }).toString().slice(6));
    } catch {}
  }
  for (const value of variants)
    variants.add(value.replace(/%[0-9A-F]{2}/g, (code) => code.toLowerCase()));
  let parts: Array<string | null> = [text];
  for (const value of [...variants].sort((a, b) => b.length - a.length))
    parts = parts.flatMap((part) => {
      if (part === null) return [null];
      return part.split(value).flatMap((section, index) => (index ? [null, section] : [section]));
    });
  const result = parts.map((part) => part ?? '[redacted]').join('');
  return result.replace(/(password[^\n]*?)(?:value=|: )[^\n]*/gi, '$1 [redacted]');
}

const browserTabList = z
  .array(z.object({ tabId: z.string(), active: z.boolean(), url: z.string() }))
  .max(64);
const browserPoint = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
  .strict();

function browserTimeZone(value: string | undefined) {
  if (!value || !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(value)) return;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value;
  } catch {}
}

function browserLocale(value: string | undefined) {
  if (!value || !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,3}$/.test(value)) return;
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {}
}

function daemonRequest(args: string[], input?: string): Record<string, unknown> | null {
  switch (args[0]) {
    case 'open':
      return { action: 'navigate', url: args[1] };
    case 'eval':
      return { action: 'evaluate', script: input };
    case 'get':
      return args[1] === 'url'
        ? { action: 'url' }
        : args[1] === 'attr'
          ? { action: 'getattribute', selector: args[2], attribute: args[3] }
          : null;
    case 'click':
      return { action: 'click', selector: args[1] };
    case 'fill':
      return { action: 'fill', selector: args[1], value: args[2] };
    case 'focus':
      return { action: 'focus', selector: args[1] };
    case 'keyboard':
      return { action: 'keyboard', subaction: 'type', text: args[2] };
    case 'mouse':
      return args[1] === 'move'
        ? { action: 'mousemove', x: Number(args[2]), y: Number(args[3]) }
        : { action: `mouse${args[1]}`, button: 'left' };
    case 'press':
      return { action: 'press', key: args[1] };
    case 'scroll':
      return {
        action: 'scroll',
        direction: args[1],
        amount: Number(args[2]),
        ...(args[4] ? { selector: args[4] } : {}),
      };
    case 'screenshot':
      return { action: 'screenshot', path: args[1], fullPage: false, annotate: false };
    case 'download':
      return { action: 'download', selector: args[1], path: args[2] };
    case 'snapshot':
      return { action: 'snapshot', compact: true, ...(args[3] ? { selector: args[3] } : {}) };
    case 'close':
      return { action: 'close' };
    case 'tab':
      return args[1] === 'list'
        ? { action: 'tab_list' }
        : args[1] === 'switch'
          ? { action: 'tab_switch', tabId: args[2] }
          : null;
    case 'dialog':
      return { action: 'dialog', response: args[1], ...(args[2] && { promptText: args[2] }) };
    case 'wait':
      return args[1] === '--url'
        ? { action: 'waitforurl', url: args[2], timeout: Number(args[4]) }
        : args[1] === '--load'
          ? { action: 'waitforloadstate', state: args[2], timeout: Number(args[4]) }
          : { action: 'wait', text: args[2], timeout: Number(args[4]) };
    case 'set':
      return { action: 'viewport', width: Number(args[2]), height: Number(args[3]) };
  }
  return null;
}

function visualGesture(input: BrowserAction) {
  if (input.x === undefined && input.y === undefined && input.points === undefined) {
    if (input.durationMs !== undefined) throw new Error('A pointer duration needs coordinates.');
    return;
  }
  if (input.selector !== undefined || input.targetSelector !== undefined)
    throw new Error('Choose either a selector or screenshot coordinates.');
  const points =
    input.action === 'click' && input.points === undefined
      ? [browserPoint.parse({ x: input.x, y: input.y })]
      : input.action === 'drag' && input.x === undefined && input.y === undefined
        ? z.array(browserPoint).min(2).max(100).parse(input.points)
        : undefined;
  if (!points) throw new Error('Use screenshot coordinates with click or drag.');
  const durationMs = z
    .number()
    .int()
    .min(0)
    .max(15_000)
    .parse(input.durationMs ?? (input.action === 'click' ? 0 : 500));
  return { points, durationMs };
}

export function redactBrowserUrl(
  value: string,
  secrets: Iterable<string>,
  hideQuery = false,
): string {
  const url = new URL(value);
  const sensitive =
    /^(?:code|state|token|accesstoken|idtoken|refreshtoken|password|otp|session|sessionid|ticket|assertion|authorization|email|username|identifier|phone|apikey|xapikey|clientsecret|signature|sig|xamzsignature|xamzcredential|xgoogsignature|xgoogcredential)$/i;
  for (const name of url.searchParams.keys())
    if (hideQuery || sensitive.test(name.replace(/[-_]/g, '')))
      url.searchParams.set(name, '[redacted]');
  if (url.hash.includes('=')) url.hash = '[redacted]';
  return redactBrowserText(url.href, secrets);
}

export function createAgentBrowserComputer(options: {
  dataRoot: string;
  executable?: string;
  browserExecutable?: string;
  sandbox?: boolean;
  platform?: NodeJS.Platform;
  headless?: boolean;
  idleTimeoutMs?: number;
  maxLiveSessions?: number;
  viewport?: { width: number; height: number };
  run?: typeof runProcess;
  daemonCommand?: typeof existingDaemonCommand;
  onDiagnostic?(event: BrowserDiagnostic): void;
}): Computer & { canCheckpoint(): boolean } {
  const browsers = new Map<string, BrowserState>();
  const discarded = new Set<string>();
  let lastSession: { threadId: string; lastActivityAt: string } | undefined;
  const markActivity = (id: string) => {
    lastSession = { threadId: id, lastActivityAt: new Date().toISOString() };
  };
  const runtimeRoot = resolve(options.dataRoot, 'runtime');
  const profilePath = (state: BrowserState) =>
    resolve(runtimeRoot, 'profiles', state.saved.profileId ?? state.id);
  const screens = createScreenStore(runtimeRoot);
  const screenStatuses = new Map<string, ReturnType<NonNullable<Computer['screenStatus']>>>();
  const namespace = `sk-${createHash('sha256').update(runtimeRoot).digest('hex').slice(0, 12)}`;
  const uploadRoot = resolve('/tmp/otto-browser-uploads', namespace);
  const cachePath = (state: BrowserState) =>
    resolve('/tmp/otto-browser-cache', namespace, state.id);
  const executable =
    options.executable ?? resolve(process.cwd(), 'node_modules/.bin/agent-browser');
  const run = options.run ?? runProcess;
  const requestDaemon = (...args: Parameters<typeof existingDaemonCommand>) =>
    diagnose(
      args[1].action === 'url' || args[1].action === 'screenshot' || args[1].action === 'snapshot'
        ? args[1].action
        : args[1].action === 'close'
          ? 'cleanup'
          : 'command',
      () => (options.daemonCommand ?? existingDaemonCommand)(...args),
    );
  const sandbox = options.sandbox !== false;
  const viewport = options.viewport;
  const platform = options.platform ?? process.platform;
  const headed = options.headless === undefined ? platform === 'darwin' : !options.headless;
  const idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60_000;
  const maxLiveSessions = Math.max(1, Math.min(4, options.maxLiveSessions ?? 4));
  const proxy = createBrowserProxy();
  let disposed = false;
  let activeCalls = 0;
  let allocationQueue: Promise<void> = Promise.resolve();
  async function diagnose<T>(phase: BrowserDiagnostic['phase'], operation: () => Promise<T>) {
    const started = performance.now();
    const record = (outcome: BrowserDiagnostic['outcome']) => {
      const event: BrowserDiagnostic = {
        at: new Date().toISOString(),
        phase,
        outcome,
        elapsedMs: Math.round(performance.now() - started),
      };
      try {
        if (options.onDiagnostic) options.onDiagnostic(event);
        else console.warn(JSON.stringify({ event: 'browser_command', ...event }));
      } catch {}
    };
    try {
      const result = await operation();
      if (phase === 'cleanup') record('completed');
      return result;
    } catch (error) {
      record(
        error instanceof DaemonTransportError
          ? error.kind
          : error instanceof DaemonCommandError
            ? 'daemon_rejected'
            : error instanceof BrowserActionError
              ? 'action_rejected'
              : 'failed',
      );
      throw error;
    }
  }
  function allocate<T>(operation: () => Promise<T>): Promise<T> {
    const pending = allocationQueue.then(operation);
    allocationQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
  function tracked<Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>) {
    return async (...args: Args): Promise<Result> => {
      activeCalls += 1;
      try {
        return await operation(...args);
      } finally {
        activeCalls -= 1;
      }
    };
  }
  function assertNotDiscarded(id: string) {
    threadIdentity(id);
    if (discarded.has(id)) throw new Error('This conversation was reset. Its browser is gone.');
  }

  function stateFor(id: string): BrowserState {
    if (disposed) throw new Error('The browser service has stopped.');
    assertNotDiscarded(id);
    let state = browsers.get(id);
    if (!state) {
      state = {
        id,
        queue: Promise.resolve(),
        injecting: false,
        secrets: new Set(),
        secretsByOrigin: new Map(),
        protectedSelectors: new Set(),
        uploads: new Set(),
        started: false,
        lastUsed: Date.now(),
        busy: 0,
        closed: false,
        closing: false,
        heldUntil: 0,
        saved: { version: 1, url: '', sensitive: false, active: false },
        browserExecutable: options.browserExecutable,
      };
      browsers.set(id, state);
    }
    return state;
  }

  function serialize<T>(state: BrowserState, operation: () => Promise<T>): Promise<T> {
    state.busy += 1;
    const execute = async () => {
      if (state.closed || state.closing) {
        state.busy -= 1;
        throw new Error('The browser session has expired. Open the URL again.');
      }
      state.lastUsed = Date.now();
      try {
        return await operation();
      } finally {
        state.busy -= 1;
        state.lastUsed = Date.now();
      }
    };
    const pending = state.queue.then(execute, execute);
    state.queue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async function reserveBrowser(state: BrowserState): Promise<void> {
    const pending = allocate(async () => {
      if (state.started || state.saved.navigationFailed) return;
      const occupied = () =>
        [...browsers.values()].filter((entry) => entry.started || entry.saved.navigationFailed);
      const attempted = new Set<string>();
      while (occupied().length >= maxLiveSessions) {
        const candidate = occupied()
          .filter(
            (entry) =>
              entry !== state &&
              !attempted.has(entry.id) &&
              !entry.busy &&
              !entry.closed &&
              !entry.closing &&
              !entry.injecting &&
              entry.heldUntil <= Date.now(),
          )
          .sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (!candidate)
          throw new Error('The browser sessions are busy. Finish an open browser task and retry.');
        attempted.add(candidate.id);
        try {
          await closeBrowser(candidate.id, candidate.lastUsed);
        } catch {
          throw new Error('The browser sessions are busy. Finish an open browser task and retry.');
        }
      }
      if (disposed || state.closed || state.closing)
        throw new Error('The browser session has expired. Open the URL again.');
      state.started = true;
    });
    await pending;
  }

  function selector(value: string | undefined): string {
    if (!value || value.length > 500 || /^[\s-]/.test(value) || value.includes('\0'))
      throw new Error('A valid observed selector or element reference is required.');
    return value;
  }

  async function closeInterruptedBrowser(state: BrowserState) {
    state.closing = true;
    try {
      await command(state, ['close']);
      state.started = false;
      state.closed = true;
      await saveState(state);
    } catch {
      throw new Error('The browser could not stop safely. Open the URL again to retry.');
    }
  }

  async function drainInterruptedCommand<T>(
    state: BrowserState,
    action: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        action === 'close' ||
        error instanceof DaemonCommandError ||
        error instanceof BrowserActionError
      )
        throw error;
      await closeInterruptedBrowser(state);
      throw error;
    }
  }

  async function command(
    state: BrowserState,
    args: string[],
    options: { input?: string; signal?: AbortSignal; maxBytes?: number; timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    options.signal?.throwIfAborted();
    if (
      state.socket &&
      ![
        'select',
        'check',
        'uncheck',
        'hover',
        'drag',
        'upload',
        'back',
        'forward',
        'reload',
      ].includes(args[0])
    ) {
      const request = daemonRequest(args, options.input);
      if (!request) throw new Error('Reopen this page before continuing browser actions.');
      const result = await drainInterruptedCommand(state, args[0], () =>
        requestDaemon(
          state.socket!,
          request,
          options.signal,
          options.timeoutMs ?? 45_000,
          options.maxBytes,
        ),
      );
      return result;
    }
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const config = resolve(runtimeRoot, 'browser-config.json');
    await writeFile(config, '{}', { mode: 0o600 });
    const proxyUrl = await proxy.url();
    const profile = profilePath(state);
    const timeZone = browserTimeZone(state.saved.timeZone);
    const locale = browserLocale(state.saved.locale);
    const result = await drainInterruptedCommand(state, args[0], () =>
      run(
        executable,
        [
          '--config',
          config,
          '--namespace',
          namespace,
          '--session',
          browserSessionId(state.id),
          '--profile',
          profile,
          ...(state.browserExecutable ? ['--executable-path', state.browserExecutable] : []),
          ...(headed ? ['--headed'] : []),
          '--no-webmcp',
          '--json',
          '--proxy',
          proxyUrl,
          '--proxy-bypass',
          '<-loopback>',
          '--args',
          '--disable-quic,--force-webrtc-ip-handling-policy=disable_non_proxied_udp,--disable-background-networking,--disable-crash-reporter,--disable-breakpad,--disable-gpu-rasterization,--enable-unsafe-swiftshader,--disable-blink-features=AutomationControlled' +
            `,--disk-cache-dir=${cachePath(state)},--disk-cache-size=67108864` +
            (locale ? `,--accept-lang=${locale}` : '') +
            (sandbox ? '' : ',--no-sandbox') +
            (headed && platform === 'darwin' ? ',--start-minimized' : '') +
            (state.saved.restoreSession ? ',--restore-last-session' : ''),
          '--download-path',
          resolve(runtimeRoot, 'downloads', state.id),
          '--idle-timeout',
          `${Math.ceil((Math.max(idleTimeoutMs, 30 * 60_000) + 15 * 60_000) / 1000)}s`,
          ...args,
        ],
        {
          cwd: runtimeRoot,
          env: {
            ...serviceEnvironment(),
            ...(timeZone && { TZ: timeZone }),
            AGENT_BROWSER_DEFAULT_TIMEOUT: '25000',
          },
          input: options.input,
          signal: options.signal,
          timeoutMs: options.timeoutMs ?? 45_000,
          maxBytes: 256 * 1024,
        },
      ),
    );
    let response: { success?: boolean; data?: Record<string, unknown>; error?: unknown };
    try {
      response = JSON.parse(result.stdout.trim());
    } catch {
      throw new Error(
        'The workspace browser could not respond. Restart its container and try again.',
      );
    }
    if (args[0] === 'open') {
      await drainInterruptedCommand(state, 'connect', () => daemonSocket(state, options.signal));
      state.recovered = false;
      if (viewport)
        await command(state, ['set', 'viewport', String(viewport.width), String(viewport.height)], {
          signal: options.signal,
        });
    }
    if (
      args[0] === 'open' &&
      response.success === false &&
      typeof response.error === 'string' &&
      /^Navigation failed: net::ERR_[A-Z_]+/.test(response.error)
    )
      throw new BrowserActionError('browser_navigation_failed');
    if (
      args[0] === 'open' &&
      response.success === false &&
      typeof response.error === 'string' &&
      response.error.startsWith('Operation timed out.')
    )
      throw new DaemonCommandError();
    if (result.exitCode || response.success === false) throw new DaemonCommandError();
    return response.data ?? {};
  }

  async function evaluate(
    state: BrowserState,
    script: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return (await command(state, ['eval', '--stdin'], { input: script, signal })).result;
  }

  async function observationCommand(
    state: BrowserState,
    args: string[],
    options: Parameters<typeof command>[2],
  ) {
    try {
      return await command(state, args, options);
    } catch (error) {
      if (error instanceof DaemonCommandError)
        throw new BrowserActionError('browser_observation_failed');
      throw error;
    }
  }

  async function pendingDialog(state: BrowserState, signal?: AbortSignal) {
    const dialog = await observationCommand(state, ['dialog', 'status'], { signal });
    if (dialog.hasDialog !== true) return;
    return `A ${String(dialog.type)} dialog blocks the page: "${redactBrowserText(String(dialog.message ?? ''), state.secrets).slice(0, 1000)}". Use accept_dialog {text?} or dismiss_dialog.`;
  }

  async function currentUrl(state: BrowserState, signal?: AbortSignal): Promise<string> {
    if (await pendingDialog(state, signal)) throw new BrowserActionError('browser_dialog_open');
    const data = await observationCommand(state, ['get', 'url'], { signal });
    const url = String(data.url ?? data.value ?? '');
    if (url === 'about:blank') return url;
    browserUrl(url);
    const storedUrl = new URL(url);
    storedUrl.search = '';
    storedUrl.hash = '';
    if (redactBrowserText(storedUrl.pathname, state.secrets) !== storedUrl.pathname)
      storedUrl.pathname = '/';
    state.saved.url = storedUrl.href;
    return url;
  }

  async function browserTabs(state: BrowserState, signal?: AbortSignal, timeoutMs?: number) {
    const data = await command(state, ['tab', 'list'], { signal, timeoutMs });
    return browserTabList.parse(data.tabs);
  }

  async function settleTabs(
    state: BrowserState,
    before: z.infer<typeof browserTabList>,
    signal?: AbortSignal,
  ) {
    const known = new Set(before.map((tab) => tab.tabId));
    const opener = before.find((tab) => tab.active)?.tabId;
    const deadline = Date.now() + 5000;
    let candidate: string | undefined;
    for (;;) {
      const tabs = await browserTabs(state, signal, Math.max(1, deadline - Date.now()));
      const opened = tabs.filter((tab) => !known.has(tab.tabId));
      const loading = opened.some((tab) => !/^https?:/.test(tab.url));
      const loaded = opened.findLast((tab) => /^https?:/.test(tab.url));
      const settled = loaded && `${loaded.tabId} ${loaded.url}`;
      const expired = Date.now() >= deadline;
      const target = loading
        ? expired
          ? opener
          : undefined
        : !loaded
          ? opener
          : settled === candidate
            ? loaded.tabId
            : expired
              ? opener
              : undefined;
      if (target) {
        if (!tabs.some((tab) => tab.tabId === target && !tab.active)) return;
        try {
          await command(state, ['tab', 'switch', target], {
            signal,
            timeoutMs: Math.max(1, deadline - Date.now()),
          });
          return;
        } catch (error) {
          if (target === opener || !(error instanceof DaemonCommandError)) throw error;
          known.add(target);
          continue;
        }
      }
      if (expired) return;
      candidate = loading ? undefined : settled;
      await delay(25, undefined, { signal });
    }
  }

  async function saveState(state: BrowserState) {
    state.saved.sensitive ||= state.secrets.size > 0;
    state.saved.active = state.started && !state.closed;
    await screens.save(state.id, state.saved);
  }

  async function recoverBrowser(
    id: string,
    allowSensitive = false,
  ): Promise<BrowserState | undefined> {
    threadIdentity(id);
    const existing = browsers.get(id);
    if (existing) return existing;
    if (disposed) return undefined;
    const saved = await screens.load(id);
    if (
      !saved ||
      (!saved.active && !saved.navigationFailed) ||
      (saved.sensitive && !allowSensitive)
    )
      return undefined;
    try {
      const result = await run(
        executable,
        ['--namespace', namespace, '--session', browserSessionId(id), 'session', 'info', '--json'],
        {
          env: serviceEnvironment(),
          timeoutMs: 5000,
          maxBytes: 16_384,
        },
      );
      const response = JSON.parse(result.stdout);
      const info = response.data;
      if (
        result.exitCode ||
        !response.success ||
        !info?.active ||
        info.namespace !== namespace ||
        info.session !== browserSessionId(id) ||
        typeof info.socketDir !== 'string'
      )
        return undefined;
      const state = stateFor(id);
      state.saved = saved;
      state.socket = resolve(info.socketDir, `${browserSessionId(id)}.sock`);
      state.recovered = true;
      state.started = !saved.navigationFailed;
      return state;
    } catch {
      return undefined;
    }
  }

  async function daemonSocket(state: BrowserState, signal?: AbortSignal): Promise<string> {
    if (state.socket) return state.socket;
    const result = await run(
      executable,
      [
        '--namespace',
        namespace,
        '--session',
        browserSessionId(state.id),
        'session',
        'info',
        '--json',
      ],
      {
        env: serviceEnvironment(),
        timeoutMs: 5000,
        maxBytes: 16_384,
        signal,
      },
    );
    const response = JSON.parse(result.stdout);
    const info = response.data;
    if (
      result.exitCode ||
      !response.success ||
      !info?.active ||
      info.namespace !== namespace ||
      info.session !== browserSessionId(state.id) ||
      typeof info.socketDir !== 'string'
    )
      throw new Error('The browser session is no longer available.');
    state.socket = resolve(info.socketDir, `${browserSessionId(state.id)}.sock`);
    return state.socket;
  }

  async function observe(
    state: BrowserState,
    signal?: AbortSignal,
    input?: BrowserAction,
  ): Promise<BrowserObservation> {
    if (state.injecting) throw new BrowserLockedError();
    let url: string;
    try {
      url = await currentUrl(state, signal);
    } catch (error) {
      const dialog =
        error instanceof BrowserActionError &&
        error.code === 'browser_dialog_open' &&
        (await pendingDialog(state, signal));
      if (dialog) return { text: dialog, url: state.saved.url };
      throw error;
    }
    if (url === 'about:blank')
      return {
        text: 'The page opened a new tab that has not loaded. Take a snapshot again.',
        url,
      };
    const scope =
      input?.action === 'snapshot' && input.selector ? selector(input.selector) : undefined;
    const offset = input?.action === 'snapshot' ? (input.offset ?? 0) : 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000)
      throw new Error('Choose a page offset of at most 100000 characters.');
    const snapshot = () =>
      observationCommand(state, scope ? ['snapshot', '-c', '-s', scope] : ['snapshot', '-c'], {
        signal,
        maxBytes: 1024 * 1024,
      });
    let data = await snapshot();
    for (let attempt = 0; attempt < 4 && !String(data.snapshot ?? '').trim(); attempt++) {
      await delay(750, undefined, { signal });
      data = await snapshot();
    }
    const page = redactBrowserText(String(data.snapshot ?? ''), state.secrets);
    return {
      text: `Page (${offset}-${Math.min(offset + 16_000, page.length)} of ${page.length} characters):\n${page.slice(offset, offset + 16_000)}`,
      url: redactBrowserUrl(url, state.secrets, Boolean(state.saved.profileId)),
    };
  }

  async function movePointer(
    state: BrowserState,
    gesture: NonNullable<ReturnType<typeof visualGesture>>,
    signal?: AbortSignal,
  ) {
    const [width, height] = z
      .tuple([z.number().positive(), z.number().positive()])
      .parse(await evaluate(state, '[innerWidth, innerHeight]', signal));
    const move = (point: { x: number; y: number }) =>
      command(
        state,
        [
          'mouse',
          'move',
          String(Math.min(Math.ceil(width) - 1, Math.round(point.x * width))),
          String(Math.min(Math.ceil(height) - 1, Math.round(point.y * height))),
        ],
        { signal },
      );
    await move(gesture.points[0]);
    try {
      await command(state, ['mouse', 'down', 'left'], { signal });
      if (gesture.points.length === 1 && gesture.durationMs)
        await delay(gesture.durationMs, undefined, { signal });
      for (const point of gesture.points.slice(1)) {
        if (gesture.durationMs)
          await delay(gesture.durationMs / (gesture.points.length - 1), undefined, { signal });
        await move(point);
      }
    } finally {
      if (state.started && !state.closed && !state.closing) {
        try {
          await command(state, ['mouse', 'up', 'left'], { timeoutMs: 5000 });
        } catch (error) {
          if (!state.closing) await closeInterruptedBrowser(state);
          throw error;
        }
      }
    }
  }

  async function browserAction(
    id: string,
    input: BrowserAction,
    signal?: AbortSignal,
  ): Promise<BrowserObservation> {
    if (disposed) throw new Error('The browser service has stopped.');
    const gesture = visualGesture(input);
    if (
      input.waitMs !== undefined &&
      (!Number.isInteger(input.waitMs) || input.waitMs < 0 || input.waitMs > 15_000)
    )
      throw new Error('Choose a wait of at most 15 seconds.');
    const savedProfile = input.action === 'open' ? await screens.load(id) : null;
    if (input.action === 'open' && !browsers.has(id)) await recoverBrowser(id, true);
    const existing = input.action === 'open' ? browsers.get(id) : undefined;
    if (
      existing &&
      (existing.recovered || existing.closed || existing.closing || existing.saved.navigationFailed)
    )
      await closeBrowser(id);
    const state = stateFor(id);
    if (input.action === 'open' && savedProfile?.profileId && !state.saved.profileId) {
      state.saved.profileId = savedProfile.profileId;
      state.saved.restoreSession = savedProfile.restoreSession;
      state.saved.sensitive = savedProfile.sensitive;
    }
    if (input.action !== 'open' && !state.started) {
      const saved = await screens.load(id);
      if (saved?.navigationFailed) state.saved = saved;
    }
    if (state.injecting) throw new BrowserLockedError();
    return serialize(state, async () => {
      if (state.injecting) throw new BrowserLockedError();
      signal?.throwIfAborted();
      if (input.action === 'open') {
        const url = browserUrl(input.url ?? '');
        const previous = state.saved.restoreSession ? state.saved : await screens.load(id);
        if (previous?.restoreSession) {
          state.saved.restoreSession = true;
          state.saved.sensitive = true;
        }
        if (state.closing || disposed) throw new BrowserLockedError();
        signal?.throwIfAborted();
        const resumeUrl = new URL(url);
        resumeUrl.search = '';
        resumeUrl.hash = '';
        if (redactBrowserText(resumeUrl.pathname, state.secrets) !== resumeUrl.pathname)
          resumeUrl.pathname = '/';
        state.saved.resumeUrl = resumeUrl.href;
        await reserveBrowser(state);
        markActivity(id);
        if (!state.socket) {
          state.saved.timeZone = browserTimeZone(input.timeZone);
          state.saved.locale = browserLocale(input.locale);
        }
        try {
          if (!state.socket && viewport) await command(state, ['open', 'about:blank'], { signal });
          await command(state, ['open', url.href], { signal });
          state.saved.navigationFailed = false;
        } catch (error) {
          if (error instanceof DaemonCommandError && !signal?.aborted) {
            try {
              const loaded = new URL(await currentUrl(state, signal));
              if (
                loaded.origin === url.origin &&
                loaded.pathname.replace(/\/+$/, '') === url.pathname.replace(/\/+$/, '') &&
                loaded.search === url.search
              ) {
                const observation = await observe(state, signal);
                if (observation.text.slice(observation.text.indexOf('\n') + 1).trim()) {
                  state.saved.navigationFailed = false;
                  return observation;
                }
              }
            } catch {}
          }
          if (!signal?.aborted && !state.closing) {
            state.started = false;
            state.saved.navigationFailed = true;
            const destination = new URL(url);
            destination.search = '';
            destination.hash = '';
            if (redactBrowserText(destination.pathname, state.secrets) !== destination.pathname)
              destination.pathname = '/';
            state.saved.url = destination.href;
            await saveState(state);
          }
          throw error;
        }
      } else {
        if (state.saved.navigationFailed) {
          if (input.action !== 'snapshot')
            throw new BrowserActionError('browser_navigation_failed');
          markActivity(id);
          return {
            text: new BrowserActionError('browser_navigation_failed').message,
            url: state.saved.url,
          };
        }
        if (!state.started) throw new Error('Open a website first.');
        markActivity(id);
        if (!['snapshot', 'accept_dialog', 'dismiss_dialog'].includes(input.action))
          await currentUrl(state, signal);
        if (input.action === 'tab_list') {
          const tabs = await browserTabs(state, signal);
          return {
            text: tabs
              .map(
                (tab) =>
                  `${tab.active ? 'Active' : 'Open'} ${tab.tabId}: ${redactBrowserUrl(tab.url, state.secrets, true)}`,
              )
              .join('\n'),
            url: redactBrowserUrl(await currentUrl(state, signal), state.secrets, true),
          };
        }
        if (input.action === 'tab_switch') {
          const tabs = await browserTabs(state, signal);
          if (!tabs.some((tab) => tab.tabId === input.tabId))
            throw new Error('Choose a tab from the current browser list.');
          await command(state, ['tab', 'switch', input.tabId!], { signal });
        }
        if (input.action === 'click') {
          const tabs = await browserTabs(state, signal);
          if (gesture) await movePointer(state, gesture, signal);
          else await command(state, ['click', selector(input.selector)], { signal });
          await settleTabs(state, tabs, signal);
        }
        if (input.action === 'fill' || input.action === 'type') {
          const target = selector(input.selector);
          const type = await command(state, ['get', 'attr', target, 'type'], { signal });
          const autocomplete = await command(state, ['get', 'attr', target, 'autocomplete'], {
            signal,
          });
          if (
            /password|one-time-code|username/i.test([type.value, autocomplete.value].join(' ')) ||
            state.protectedSelectors.has(target)
          )
            throw new Error('Use the secure credential request tool for this field.');
          const text = input.text ?? '';
          if (
            text.length > 8000 ||
            [...state.secrets].some((secret) => secret && text.includes(secret))
          )
            throw new Error('This field must use the secure credential flow.');
          if (input.action === 'fill') await command(state, ['fill', target, text], { signal });
          else {
            await command(state, ['focus', target], { signal });
            for (const character of text)
              await command(
                state,
                /^[\x20-\x7e]$/.test(character)
                  ? ['press', character]
                  : character === '\n'
                    ? ['press', 'Enter']
                    : ['keyboard', 'type', character],
                { signal },
              );
          }
        }
        if (input.action === 'scroll')
          await command(
            state,
            input.selector
              ? ['scroll', input.direction ?? 'down', '600', '-s', selector(input.selector)]
              : ['scroll', input.direction ?? 'down', '600'],
            { signal },
          );
        if (input.action === 'press') {
          if (!input.key) throw new Error('Choose a key to press.');
          const tabs = await browserTabs(state, signal);
          await command(state, ['press', input.key], { signal });
          await settleTabs(state, tabs, signal);
        }
        if (input.action === 'accept_dialog' || input.action === 'dismiss_dialog') {
          const text = input.action === 'accept_dialog' ? input.text : undefined;
          if (
            text !== undefined &&
            (text.length > 2000 ||
              [...state.secrets].some((secret) => secret && text.includes(secret)))
          )
            throw new Error('Answer the dialog without private details.');
          await command(
            state,
            [
              'dialog',
              input.action === 'accept_dialog' ? 'accept' : 'dismiss',
              ...(text ? [text] : []),
            ],
            { signal },
          );
        }
        if (input.action === 'wait') {
          const [flag, value] = input.text
            ? ['--text', input.text]
            : input.url
              ? ['--url', input.url]
              : input.load
                ? ['--load', input.load]
                : [];
          if (
            !flag ||
            !value ||
            value.length > 2000 ||
            [input.text, input.url, input.load].filter(Boolean).length > 1 ||
            (flag === '--load' && !['load', 'domcontentloaded', 'networkidle'].includes(value))
          )
            throw new Error('Wait for one of text, url or load.');
          const timeout = input.waitMs || 15_000;
          try {
            await command(state, ['wait', flag, value, '--timeout', String(timeout)], { signal });
          } catch (error) {
            if (!(error instanceof DaemonCommandError)) throw error;
            const observation = await observe(state, signal);
            return {
              ...observation,
              text: `The wait condition was not met within ${timeout / 1000} seconds.\n${observation.text}`,
            };
          }
        }
        if (input.action === 'select') {
          const value = input.text ?? '';
          if (
            !value ||
            value.length > 8000 ||
            [...state.secrets].some((secret) => secret && value.includes(secret))
          )
            throw new Error('Choose a visible option without private details.');
          await command(state, ['select', selector(input.selector), value], { signal });
        }
        if (['check', 'uncheck', 'hover'].includes(input.action))
          await command(state, [input.action, selector(input.selector)], { signal });
        if (input.action === 'drag') {
          if (gesture) await movePointer(state, gesture, signal);
          else
            await command(
              state,
              ['drag', selector(input.selector), selector(input.targetSelector)],
              { signal },
            );
        }
        if (['back', 'forward', 'reload'].includes(input.action))
          await command(state, [input.action], { signal });
        if (input.action === 'evaluate') {
          const script = input.script ?? '';
          if (!script.trim() || script.length > 20_000)
            throw new Error('Provide a script of at most 20,000 characters.');
          const url = await currentUrl(state, signal);
          const value = await evaluate(
            state,
            `Promise.race([Promise.resolve().then(() => (${script})), new Promise((resolve) => setTimeout(() => resolve({ __ottoTimedOut: true }), 5000))])`,
            signal,
          );
          if (value && typeof value === 'object' && '__ottoTimedOut' in value)
            throw new Error('The script did not finish within 5 seconds.');
          const result = redactBrowserText(JSON.stringify(value ?? null) ?? 'null', state.secrets);
          return {
            text: `Script result (JSON${result.length > 20_000 ? ', first 20,000 characters' : ''}):\n${result.slice(0, 20_000)}`,
            url: redactBrowserUrl(url, state.secrets, Boolean(state.saved.profileId)),
          };
        }
      }
      if (input.waitMs && input.action !== 'wait') await delay(input.waitMs, undefined, { signal });
      return observe(state, signal, input);
    }).catch((error: unknown) => {
      if (error instanceof DaemonCommandError)
        throw new BrowserActionError('browser_action_failed');
      throw error;
    });
  }

  async function upload(id: string, input: BrowserUploadInput, signal?: AbortSignal) {
    if (
      !input.bytes.length ||
      input.bytes.length > browserUploadBytes ||
      !/^[^/\\\u0000-\u001f\u007f]{1,200}$/.test(input.name)
    )
      throw new Error('Choose a file of at most 12 MB.');
    const state = await recoverBrowser(id);
    if (!state?.started) throw new Error('Open the upload website first.');
    if (state.injecting) throw new BrowserLockedError();
    return serialize(state, async () => {
      if (state.injecting) throw new BrowserLockedError();
      signal?.throwIfAborted();
      if (state.uploads.size >= 8)
        throw new Error('Close this browser before uploading more files.');
      markActivity(id);
      const current = await currentUrl(state, signal);
      const directory = resolve(uploadRoot, randomUUID());
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = resolve(directory, input.name);
      try {
        await writeFile(file, input.bytes, { mode: 0o600 });
        await command(state, ['upload', selector(input.selector), file], { signal });
        state.uploads.add(directory);
        return observe(state, signal);
      } catch (error) {
        if (!state.uploads.has(directory)) await rm(directory, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async function download(id: string, input: BrowserDownloadInput, signal?: AbortSignal) {
    if (input.selector && input.url) throw new Error('Choose a download link or URL.');
    if (input.name !== undefined) downloadName(input.name);
    const state = await recoverBrowser(id);
    if (!state?.started) throw new Error('Open the file website first.');
    if (state.injecting) throw new BrowserLockedError();
    return serialize(state, async () => {
      if (state.injecting) throw new BrowserLockedError();
      signal?.throwIfAborted();
      markActivity(id);
      const current = await currentUrl(state, signal);
      const directory = resolve(runtimeRoot, 'downloads', state.id);
      let target = input.selector ? selector(input.selector) : undefined;
      let url = input.url;
      if (target) {
        const href = await command(state, ['get', 'attr', target, 'href'], { signal });
        if (typeof href.value === 'string' && href.value.trim()) {
          const destination = new URL(href.value, current);
          const source = new URL(current);
          destination.hash = '';
          source.hash = '';
          if (
            !href.value.trim().startsWith('#') &&
            destination.protocol !== 'javascript:' &&
            destination.href !== source.href
          )
            url = new URL(href.value, current).href;
        }
      }
      if (!target && !url) {
        const type = await evaluate(state, 'document.contentType', signal);
        if (type === 'application/pdf') url = current;
        else {
          const file = await waitForDownload(directory, signal);
          const result = await readDownload(directory, file, input.name);
          signal?.throwIfAborted();
          return result;
        }
      }
      const crossOrigin = url && new URL(url).origin !== new URL(current).origin;
      if (url) {
        if (!url.startsWith(`blob:${new URL(current).origin}/`)) browserUrl(url);
      }
      if (url && !crossOrigin) {
        const result = await command(state, ['eval', '--stdin'], {
          input: fetchDownloadScript(url),
          signal,
          maxBytes: 17 * 1024 * 1024,
        });
        signal?.throwIfAborted();
        return decodeDownload(result.result, input.name);
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const capture = await createDownloadCapture(directory);
      const anchor = !target ? `otto-download-${randomUUID()}` : undefined;
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let watching: Promise<void> | undefined;
      let completed = false;
      const watch = setInterval(() => {
        if (watching) return;
        watching = capture
          .inspect()
          .then(() => {})
          .catch(() => controller.abort())
          .finally(() => {
            watching = undefined;
          });
      }, 25);
      try {
        if (anchor) {
          await evaluate(
            state,
            `(() => {
            const anchor = document.createElement('a');
            anchor.id = ${JSON.stringify(anchor)};
            anchor.href = ${JSON.stringify(url)};
            anchor.textContent = 'Download file';
            anchor.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;background:white;color:black;padding:8px';
            document.documentElement.append(anchor);
          })()`,
            combined,
          );
          target = `#${anchor}`;
        }
        await command(state, ['download', target!, resolve(directory, capture.file)], {
          signal: combined,
        });
        combined.throwIfAborted();
        const files = await capture.inspect();
        if (files.length !== 1 || files[0] !== capture.file)
          throw new Error('The browser download did not finish.');
        const result = await readDownload(directory, capture.file, input.name);
        combined.throwIfAborted();
        completed = true;
        return result;
      } catch (error) {
        if (!completed && !state.closed && !state.closing)
          await drainInterruptedCommand(state, 'download', async () => {
            throw new Error('The browser download did not finish.');
          });
        throw error;
      } finally {
        clearInterval(watch);
        await watching;
        try {
          if (anchor && !state.closed && !state.closing)
            await evaluate(state, `document.getElementById(${JSON.stringify(anchor)})?.remove()`);
        } finally {
          if (completed || state.closed) await capture.cleanup();
        }
      }
    });
  }

  async function injectCredentials(input: CredentialInput): Promise<CredentialSubmission> {
    const state = browsers.get(threadIdentity(input.threadId));
    if (!state?.started) throw new Error('The browser session has expired. Reopen the login page.');
    if (state.injecting) throw new BrowserLockedError();
    if (browserUrl(input.origin).origin !== input.origin)
      throw new Error('An exact login origin is required.');
    const fields = credentialFields(input);
    state.injecting = true;
    markActivity(input.threadId);
    try {
      return await serialize(state, async () => {
        const onOrigin = async () => {
          if (new URL(await currentUrl(state)).origin !== input.origin)
            throw new Error(
              'The page is not on the website for this login. Inspect the page and request the credential again.',
            );
        };
        await onOrigin();
        const socket = await daemonSocket(state);
        const secrets = state.secretsByOrigin.get(input.origin) ?? new Set<string>();
        for (const field of fields) {
          state.secrets.add(field.value);
          secrets.add(field.value);
        }
        state.secretsByOrigin.set(input.origin, secrets);
        await saveState(state);
        for (const field of fields) {
          await onOrigin();
          await requestDaemon(socket, {
            action: 'fill',
            selector: field.selector,
            value: field.code ? '' : field.value,
          });
          if (field.code)
            for (const key of field.value) {
              await onOrigin();
              await requestDaemon(socket, { action: 'press', key });
            }
          if (!field.selector.startsWith('@')) state.protectedSelectors.add(field.selector);
        }
        await onOrigin();
        return { status: 'submitted' as const };
      });
    } finally {
      state.injecting = false;
    }
  }

  async function currentPage(id: string): Promise<BrowserPage> {
    const state = await recoverBrowser(id);
    if (state?.saved.navigationFailed || (!state && (await screens.load(id))?.navigationFailed))
      throw new BrowserActionError('browser_navigation_failed');
    if (!state?.started) throw new Error('Open the login page in this task browser first.');
    if (state.injecting) throw new BrowserLockedError();
    return serialize(state, async () => {
      if (state.injecting) throw new BrowserLockedError();
      const url = await currentUrl(state);
      return {
        origin: browserUrl(url).origin,
        url: redactBrowserUrl(url, state.secrets, Boolean(state.saved.profileId)),
      };
    });
  }

  async function hold(id: string, until: number | null): Promise<void> {
    const state = browsers.get(threadIdentity(id));
    if (!state?.started) return;
    await serialize(state, async () => {
      if (until !== null && !Number.isFinite(until))
        throw new Error('A valid browser hold expiry is required.');
      state.heldUntil = until === null ? 0 : Math.min(until, Date.now() + 30 * 60_000);
      if (state.heldUntil > Date.now()) await currentUrl(state);
      if (state.heldUntil > Date.now()) await captureScreen(state);
    });
  }

  async function captureScreen(state: BrowserState, signal?: AbortSignal): Promise<Buffer> {
    if (state.saved.navigationFailed) throw new BrowserActionError('browser_navigation_failed');
    if (state.recovered && state.saved.sensitive && !state.secrets.size)
      throw new Error('Reopen the login page before continuing this browser session.');
    const url = await currentUrl(state, signal);
    const path = resolve(runtimeRoot, `screen-${state.id}.capture.png`);
    await observationCommand(state, ['screenshot', path], { signal });
    const buffer = await screens.accept(state.id, path);
    state.saved.capturedAt = new Date().toISOString();
    await saveState(state);
    screenStatuses.set(state.id, { state: 'live', capturedAt: state.saved.capturedAt });
    return buffer;
  }

  async function lastKnownScreen(id: string): Promise<Buffer | null> {
    const saved = await screens.load(id);
    if (saved?.navigationFailed) throw new BrowserActionError('browser_navigation_failed');
    const buffer = saved?.capturedAt ? await screens.read(id) : null;
    screenStatuses.set(
      id,
      buffer ? { state: 'last_known', capturedAt: saved?.capturedAt } : { state: 'unavailable' },
    );
    return buffer;
  }

  async function control(id: string, input: BrowserHandoffInput, signal?: AbortSignal) {
    const state = await recoverBrowser(id);
    if (!state?.started) throw new Error('Open a page in this task browser first.');
    if (state.injecting) throw new BrowserLockedError();
    markActivity(id);
    await serialize(state, async () => {
      if (state.injecting) throw new BrowserLockedError();
      const socket = await daemonSocket(state, signal);
      if (input.type === 'click') {
        const [width, height] = z
          .tuple([z.number().positive(), z.number().positive()])
          .parse(await evaluate(state, '[innerWidth, innerHeight]', signal));
        await requestDaemon(
          socket,
          { action: 'mousemove', x: Math.round(input.x * width), y: Math.round(input.y * height) },
          signal,
        );
        await requestDaemon(socket, { action: 'mousedown', button: 'left' }, signal);
        await requestDaemon(socket, { action: 'mouseup', button: 'left' }, signal);
      }
      if (input.type === 'scroll')
        await requestDaemon(socket, { action: 'wheel', deltaX: 0, deltaY: input.deltaY }, signal);
      if (input.type === 'type') {
        await requestDaemon(
          socket,
          { action: 'keyboard', subaction: 'type', text: input.text },
          signal,
        );
        const typed = await evaluate(
          state,
          "(() => { const field = document.activeElement; return field instanceof HTMLInputElement && field.type === 'password' ? [field.value, [...document.querySelectorAll('input[type=\"password\"]')].indexOf(field)] : null; })()",
          signal,
        );
        const [secret, field] = z.tuple([z.string(), z.number()]).catch(['', -1]).parse(typed);
        if (secret) {
          const origin = new URL(await currentUrl(state, signal)).origin;
          const secrets = state.secretsByOrigin.get(origin) ?? new Set<string>();
          const earlier = state.typed;
          if (
            earlier?.fresh &&
            earlier.origin === origin &&
            earlier.field === field &&
            secret.startsWith(earlier.value)
          ) {
            state.secrets.delete(earlier.value);
            secrets.delete(earlier.value);
          }
          state.typed = { value: secret, origin, field, fresh: !state.secrets.has(secret) };
          state.secrets.add(secret);
          secrets.add(secret);
          state.secretsByOrigin.set(origin, secrets);
          await saveState(state);
        }
      }
      if (input.type === 'key')
        await requestDaemon(socket, { action: 'press', key: input.key }, signal);
    });
  }

  async function getScreenshot(id: string, signal?: AbortSignal): Promise<Buffer | null> {
    const state = await recoverBrowser(id);
    if (!state?.started) return lastKnownScreen(id);
    if (state.injecting) throw new BrowserLockedError();
    return serialize(state, async () => {
      if (state.injecting) throw new BrowserLockedError();
      signal?.throwIfAborted();
      try {
        return await captureScreen(state, signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (!state.recovered) throw error;
        return lastKnownScreen(id);
      }
    });
  }

  async function closeBrowser(id: string, idleAt?: number): Promise<void> {
    const state = browsers.get(threadIdentity(id)) ?? (await recoverBrowser(id, true));
    if (!state) return;
    if (idleAt === undefined) state.closing = true;
    const close = async () => {
      if (browsers.get(id) !== state) return;
      if (
        idleAt !== undefined &&
        (state.lastUsed !== idleAt || state.busy || state.injecting || state.heldUntil > Date.now())
      )
        return;
      state.closing = true;
      if (state.started && !state.closed && !state.injecting)
        await captureScreen(state).catch(() => {});
      state.closed = true;
      if (state.started || state.saved.navigationFailed) await command(state, ['close']);
      state.started = false;
      await saveState(state);
      state.secrets.clear();
      state.secretsByOrigin.clear();
      state.protectedSelectors.clear();
      for (const directory of state.uploads) await rm(directory, { recursive: true, force: true });
      state.uploads.clear();
      await rm(cachePath(state), { recursive: true, force: true });
      if (browsers.get(id) === state) browsers.delete(id);
      screenStatuses.set(
        id,
        state.saved.capturedAt
          ? { state: 'last_known', capturedAt: state.saved.capturedAt }
          : { state: 'unavailable' },
      );
    };
    const pending = state.queue.then(close, close);
    state.queue = pending.then(
      () => undefined,
      () => undefined,
    );
    await pending;
  }

  async function bindProfile(id: string, rawProfileId: string): Promise<void> {
    const profileId = z.uuid().parse(rawProfileId);
    assertNotDiscarded(id);
    await allocate(async () => {
      assertNotDiscarded(id);
      const previous = browsers.get(id) ?? (await recoverBrowser(id, true));
      if (previous?.saved.profileId === profileId) {
        if (!previous.saved.restoreSession) {
          previous.saved.restoreSession = true;
          previous.saved.sensitive = true;
          previous.saved.capturedAt = undefined;
          await screens.clearImage(id);
          await saveState(previous);
        }
        return;
      }
      if (previous?.injecting) throw new BrowserLockedError();
      if (previous) await closeBrowser(id);
      const relatedIds = await screens.profileScreens(profileId);
      for (const otherId of relatedIds) {
        if (otherId === id) continue;
        const other = browsers.get(otherId) ?? (await recoverBrowser(otherId, true));
        if (!other) continue;
        if (other.busy || other.injecting || other.heldUntil > Date.now())
          throw new BrowserLockedError();
        await closeBrowser(otherId);
      }
      const state = stateFor(id);
      state.saved = {
        version: 1,
        url: '',
        sensitive: true,
        active: false,
        profileId,
        restoreSession: true,
      };
      await screens.clearImage(id);
      await saveState(state);
    });
  }

  async function deleteProfile(rawProfileId: string): Promise<void> {
    const profileId = z.uuid().parse(rawProfileId);
    await allocate(async () => {
      const ids = await screens.profileScreens(profileId);
      for (const id of ids) {
        const state = browsers.get(id) ?? (await recoverBrowser(id, true));
        if (state && (state.busy || state.injecting || state.heldUntil > Date.now()))
          throw new BrowserLockedError();
        if (state) await closeBrowser(id);
      }
      await rm(resolve(runtimeRoot, 'profiles', profileId), { recursive: true, force: true });
      for (const id of ids) {
        await Promise.all([
          screens.delete(id),
          rm(resolve(runtimeRoot, 'downloads', id), { recursive: true, force: true }),
        ]);
        screenStatuses.delete(id);
      }
    });
  }

  async function discard(rawId: string): Promise<void> {
    const id = threadIdentity(rawId);
    discarded.add(id);
    await closeBrowser(id);
    await Promise.all([
      rm(resolve(runtimeRoot, 'profiles', id), { recursive: true, force: true }),
      rm(resolve(runtimeRoot, 'downloads', id), { recursive: true, force: true }),
      rm(resolve(runtimeRoot, `screen-${id}.capture.png`), { force: true }),
      screens.delete(id),
    ]);
    screenStatuses.delete(id);
  }

  function browserStatus(): string {
    const count = [...browsers.values()].filter(
      (state) => state.started || state.saved.navigationFailed,
    ).length;
    return `${count} task browser session${count === 1 ? '' : 's'}; workspace browser proxy enabled`;
  }
  const cleanup = setInterval(
    () => {
      for (const state of browsers.values()) {
        if (
          !state.busy &&
          !state.injecting &&
          state.heldUntil <= Date.now() &&
          Date.now() - state.lastUsed >= idleTimeoutMs
        )
          void closeBrowser(state.id, state.lastUsed).catch(() => {});
      }
    },
    Math.min(60_000, Math.max(10, idleTimeoutMs)),
  );
  cleanup.unref();
  return {
    canCheckpoint: () => {
      const now = Date.now();
      return (
        !disposed &&
        !activeCalls &&
        [...browsers.values()].every(
          (state) => !state.busy && !state.closing && !state.injecting && state.heldUntil <= now,
        )
      );
    },
    currentSession: () => lastSession,
    bindProfile: tracked(bindProfile),
    deleteProfile: tracked(deleteProfile),
    act: tracked(browserAction),
    upload: tracked(upload),
    download: tracked(download),
    screenshot: tracked(getScreenshot),
    control: tracked(control),
    screenStatus: (id) => screenStatuses.get(threadIdentity(id)) ?? { state: 'unavailable' },
    injectCredentials: tracked(injectCredentials),
    currentPage: tracked(currentPage),
    hold: tracked(hold),
    close: tracked(closeBrowser),
    discard: tracked(discard),
    status: browserStatus,
    dispose: async () => {
      disposed = true;
      clearInterval(cleanup);
      const results = await Promise.allSettled([...browsers.keys()].map((id) => closeBrowser(id)));
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('The browser service could not finish closing its sessions.');
      await proxy.dispose();
    },
  };
}
