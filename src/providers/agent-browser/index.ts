import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type {
  BrowserAction,
  BrowserDownloadInput,
  BrowserUploadInput,
  BrowserObservation,
  Computer,
  CardEntry,
  CardFields,
  CardExpiryField,
  CredentialInput,
  CredentialSubmission,
  BrowserControl,
  BrowserPage,
} from '../../ports/computer.ts';
import { BrowserActionError } from '../../ports/computer.ts';
import { fileBytes } from '../../shared/files.ts';
import type { BrowserHandoffInput } from '../../shared/browser-handoff.ts';
import { threadIdentity } from '../../ports/thread-identity.ts';
import { runProcess, serviceEnvironment } from '../process.ts';
import { createBrowserProxy, browserUrl } from './network.ts';
import { credentialFields } from './credentials.ts';
import { openDevtools, type BoundSignInControl } from './devtools.ts';
import {
  createScreenStore,
  daemonDeadline,
  existingDaemonCommand,
  DaemonCommandError,
  DaemonTransportError,
  type StoredScreen,
} from './screens.ts';
import {
  completedDownloads,
  createDownloadCapture,
  decodeDownloadChunk,
  downloadFile,
  downloadName,
  fetchChunkBytes,
  fetchChunkScript,
  fetchDownloadScript,
  readDownload,
} from './downloads.ts';

interface BrowserState {
  id: string;
  queue: Promise<unknown>;
  injecting: boolean;
  secrets: Set<string>;
  refs: Map<string, BrowserControl>;
  refVersions: Map<string, number>;
  typed?: { value: string; origin: string; field: number; fresh: boolean };
  pageSize?: [number, number];
  signInMethods?: { document: string; origin: string; controls: Map<string, BoundSignInControl> };
  privateDocument?: string;
  sealedDocument?: string;
  uploads: Set<string>;
  proxy?: ReturnType<typeof createBrowserProxy>;
  started: boolean;
  lastUsed: number;
  busy: number;
  closed: boolean;
  closing: boolean;
  heldAt?: number;
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

const streamFrame = z.object({
  type: z.literal('frame'),
  seq: z.number().int(),
  data: z.string().max(4 * 1024 * 1024),
  metadata: z.object({
    deviceWidth: z.number().positive(),
    deviceHeight: z.number().positive(),
    pageScaleFactor: z.number().positive().default(1),
  }),
});

const holdMs = 30 * 60_000;
const snapshotChars = 40_000;

const withoutPasskeys = `(() => {
  const container = window.CredentialsContainer && CredentialsContainer.prototype;
  if (!container) return;
  const unavailable = () =>
    Promise.reject(new DOMException('Passkeys are not available in this browser.', 'NotAllowedError'));
  const { get, create } = container;
  container.get = function (options) {
    return options && options.publicKey ? unavailable() : get.call(this, options);
  };
  container.create = function (options) {
    return options && options.publicKey ? unavailable() : create.call(this, options);
  };
  const key = window.PublicKeyCredential;
  if (!key) return;
  key.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(false);
  key.isConditionalMediationAvailable = () => Promise.resolve(false);
  const capabilities = key.getClientCapabilities;
  if (capabilities)
    key.getClientCapabilities = () =>
      capabilities.call(key).then((all) => Object.fromEntries(Object.keys(all).map((name) => [name, false])));
})();`;

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
    variants.add(JSON.stringify(secret).slice(1, -1));
    try {
      variants.add(encodeURIComponent(secret));
      variants.add(encodeURI(secret));
      variants.add(new URLSearchParams({ value: secret }).toString().slice(6));
    } catch {}
  }
  for (const value of variants)
    variants.add(value.replace(/%[0-9A-F]{2}/g, (code) => code.toLowerCase()));
  for (const secret of secrets)
    if (/^\d{12,19}$/.test(secret))
      text = text.replace(new RegExp(secret.split('').join('\\D{0,3}'), 'g'), secret);
  let parts: Array<string | null> = [text];
  for (const value of [...variants].sort((a, b) => b.length - a.length))
    parts = parts.flatMap((part) => {
      if (part === null) return [null];
      return part.split(value).flatMap((section, index) => (index ? [null, section] : [section]));
    });
  return parts.map((part) => part ?? '[redacted]').join('');
}

const browserTabList = z.array(
  z.object({ tabId: z.string(), active: z.boolean(), url: z.string() }),
);
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
        ? z.array(browserPoint).min(2).parse(input.points)
        : undefined;
  if (!points) throw new Error('Use screenshot coordinates with click or drag.');
  const durationMs = z
    .number()
    .int()
    .min(0)
    .parse(input.durationMs ?? (input.action === 'click' ? 0 : 500));
  return { points, durationMs };
}

export function redactBrowserUrl(value: string, secrets: Iterable<string>): string {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  const sensitive =
    /^(?:token|accesstoken|idtoken|refreshtoken|password|otp|session|sessionid|ticket|assertion|authorization|apikey|xapikey|clientsecret|signature|sig|xamzsignature|xamzcredential|xgoogsignature|xgoogcredential)$/i;
  const secret = (name: string) => sensitive.test(name.replace(/[-_]/g, ''));
  for (const name of url.searchParams.keys())
    if (secret(name)) url.searchParams.set(name, '[redacted]');
  if (
    url.hash
      .slice(1)
      .split(/[?&]/)
      .some((part) => {
        if (!part.includes('=')) return false;
        try {
          return secret(decodeURIComponent(part.split('=')[0]!));
        } catch {
          return true;
        }
      })
  )
    url.hash = '[redacted]';
  return redactBrowserText(url.href, secrets);
}

export function createAgentBrowserComputer(options: {
  dataRoot: string;
  executable?: string;
  browserExecutable?: string;
  sandbox?: boolean;
  platform?: NodeJS.Platform;
  headless?: boolean;
  evictIdleMs?: number;
  maxLiveSessions?: number;
  viewport?: { width: number; height: number };
  run?: typeof runProcess;
  daemonCommand?: typeof existingDaemonCommand;
  privateNetwork?: boolean;
  onDiagnostic?(event: BrowserDiagnostic): void;
}): Computer & { canCheckpoint(): boolean } {
  const browsers = new Map<string, BrowserState>();
  const targetKey = randomBytes(32);
  let refSequence = 0;
  const discarded = new Set<string>();
  const runtimeRoot = resolve(options.dataRoot, 'runtime');
  const profilePath = (state: BrowserState) =>
    resolve(runtimeRoot, 'profiles', state.saved.profileId ?? state.id);
  const screens = createScreenStore(runtimeRoot);
  const screenStatuses = new Map<string, ReturnType<NonNullable<Computer['screenStatus']>>>();
  const namespace = `sk-${createHash('sha256').update(runtimeRoot).digest('hex').slice(0, 12)}`;
  const uploadRoot = resolve('/tmp/nod-browser-uploads', namespace);
  const cachePath = (state: BrowserState) => resolve('/tmp/nod-browser-cache', namespace, state.id);
  const executable =
    options.executable ?? resolve(process.cwd(), 'node_modules/.bin/agent-browser');
  const run = options.run ?? runProcess;
  const privateNetwork = options.privateNetwork;
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
  const evictIdleMs = options.evictIdleMs ?? 5 * 60_000;
  const maxLiveSessions = Math.max(1, options.maxLiveSessions ?? 4);
  const holding = (state: BrowserState) =>
    state.heldAt !== undefined && Date.now() - state.heldAt < holdMs;
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
        refs: new Map(),
        refVersions: new Map(),
        uploads: new Set(),
        started: false,
        lastUsed: Date.now(),
        busy: 0,
        closed: false,
        closing: false,
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

  async function reserveBrowser(state: BrowserState, signal?: AbortSignal): Promise<void> {
    const stopped = new Promise<never>((_, reject) => {
      if (signal?.aborted) reject(signal.reason);
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    stopped.catch(() => {});
    const reserve = () =>
      allocate(async () => {
        if (state.started || state.saved.navigationFailed) return true;
        if (signal?.aborted) return false;
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
                !holding(entry) &&
                Date.now() - entry.lastUsed >= evictIdleMs,
            )
            .sort((a, b) => a.lastUsed - b.lastUsed)[0];
          if (!candidate) return false;
          attempted.add(candidate.id);
          try {
            await closeBrowser(candidate.id, candidate.lastUsed);
          } catch {
            throw new Error(
              'The browser sessions are busy. Finish an open browser task and retry.',
            );
          }
        }
        if (disposed || state.closed || state.closing)
          throw new Error('The browser session has expired. Open the URL again.');
        if (signal?.aborted) return false;
        state.started = true;
        return true;
      });
    while (!(await Promise.race([reserve(), stopped]))) {
      if (disposed || state.closed || state.closing)
        throw new Error('The browser session has expired. Open the URL again.');
      await delay(500, undefined, { signal });
    }
  }

  function selector(value: string | undefined): string {
    if (!value?.trim() || value.includes('\0'))
      throw new Error('A valid observed selector or element reference is required.');
    return value;
  }

  const referenceOf = (value: string | undefined) =>
    /^@?(?:ref=)?(e\d+)$/.exec(value?.trim() ?? '')?.[1];

  async function shutDown(state: BrowserState) {
    try {
      await command(state, { action: 'close' }, { timeoutMs: 5000 });
    } catch {
      await kill(state);
    }
  }

  async function kill(state: BrowserState) {
    const socket = state.socket ?? (await daemonSocket(state).catch(() => undefined));
    const pidFile = socket?.replace(/\.sock$/, '.pid');
    const host = `${hostname()}-`;
    const profile = profilePath(state);
    const lock = await readlink(resolve(profile, 'SingletonLock')).catch(() => '');
    const owned = async (pid: number, file: string, marker: string) =>
      Number.isInteger(pid) &&
      pid > 1 &&
      pid !== process.pid &&
      (process.platform !== 'linux' ||
        (await readFile(`/proc/${pid}/${file}`, 'utf8').catch(() => '')).includes(marker));
    const chrome = lock.startsWith(host) ? Number(lock.slice(host.length)) : 0;
    const daemon = Number(pidFile ? await readFile(pidFile, 'utf8').catch(() => '') : '');
    const targets = [
      ...((await owned(chrome, 'cmdline', `--user-data-dir=${profile}\0`)) ? [chrome] : []),
      ...((await owned(daemon, 'environ', `AGENT_BROWSER_SESSION=${browserSessionId(state.id)}\0`))
        ? [daemon]
        : []),
    ];
    const signal = (pid: number, value: NodeJS.Signals | 0) => {
      try {
        process.kill(pid, value);
        return true;
      } catch {
        return false;
      }
    };
    for (const pid of targets) {
      signal(-pid, 'SIGKILL');
      signal(pid, 'SIGKILL');
    }
    for (let waited = 0; waited < 5000 && targets.some((pid) => signal(pid, 0)); waited += 50)
      await delay(50);
    await Promise.all([socket, pidFile].map((path) => path && rm(path, { force: true })));
    delete state.socket;
  }

  async function closeInterruptedBrowser(state: BrowserState) {
    state.closing = true;
    await shutDown(state);
    state.started = false;
    state.closed = true;
    await saveState(state);
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
    request: Record<string, unknown>,
    options: { signal?: AbortSignal; maxBytes?: number; timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    options.signal?.throwIfAborted();
    const action = String(request.action);
    if (state.socket) {
      const result = await drainInterruptedCommand(state, action, () =>
        requestDaemon(state.socket!, request, options.signal, options.timeoutMs, options.maxBytes),
      );
      if (action === 'close') {
        const started = Date.now();
        while (await stat(state.socket!).catch(() => null)) {
          if (Date.now() - started > 5000) throw new Error('The previous browser did not stop.');
          await delay(50);
        }
      }
      return result;
    }
    if (action !== 'navigate' && action !== 'close')
      throw new Error('Reopen this page before continuing browser actions.');
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const config = resolve(runtimeRoot, 'browser-config.json');
    await writeFile(config, '{}', { mode: 0o600 });
    const initScript = resolve(runtimeRoot, 'browser-init.js');
    await writeFile(initScript, withoutPasskeys, { mode: 0o600 });
    state.proxy ??= createBrowserProxy({ privateNetwork });
    const proxyUrl = await state.proxy.url();
    const profile = profilePath(state);
    const timeZone = browserTimeZone(state.saved.timeZone);
    const locale = browserLocale(state.saved.locale);
    const result = await drainInterruptedCommand(state, action, () =>
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
          '--init-script',
          initScript,
          '--json',
          '--proxy',
          proxyUrl,
          '--proxy-bypass',
          '<-loopback>',
          '--args',
          '--disable-quic,--force-webrtc-ip-handling-policy=disable_non_proxied_udp,--disable-background-networking,--disable-crash-reporter,--disable-breakpad,--disable-gpu-rasterization,--enable-unsafe-swiftshader,--disable-blink-features=AutomationControlled,--disable-features=BackForwardCache' +
            `,--disk-cache-dir=${cachePath(state)},--disk-cache-size=67108864` +
            (locale ? `,--accept-lang=${locale}` : '') +
            (sandbox ? '' : ',--no-sandbox') +
            (headed && platform === 'darwin' ? ',--start-minimized' : '') +
            (state.saved.restoreSession ? ',--restore-last-session' : ''),
          '--download-path',
          resolve(runtimeRoot, 'downloads', state.id),
          '--idle-timeout',
          '86400s',
          ...(action === 'close' ? ['close'] : ['open', String(request.url)]),
        ],
        {
          cwd: runtimeRoot,
          env: {
            ...serviceEnvironment(),
            ...(timeZone && { TZ: timeZone }),
          },
          signal: options.signal,
          timeoutMs: options.timeoutMs ?? daemonDeadline(request) + 30_000,
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
    if (action === 'navigate') {
      await drainInterruptedCommand(state, 'connect', () => daemonSocket(state, options.signal));
      state.recovered = false;
      state.pageSize = undefined;
      if (viewport)
        await command(
          state,
          { action: 'viewport', width: viewport.width, height: viewport.height },
          { signal: options.signal },
        );
    }
    if (
      action === 'navigate' &&
      response.success === false &&
      typeof response.error === 'string' &&
      /^Navigation failed: net::ERR_[A-Z_]+/.test(response.error)
    )
      throw new BrowserActionError('browser_navigation_failed');
    if (
      action === 'navigate' &&
      response.success === false &&
      typeof response.error === 'string' &&
      response.error.startsWith('Operation timed out.')
    )
      throw new DaemonCommandError();
    if (result.exitCode || response.success === false)
      throw new DaemonCommandError(typeof response.error === 'string' ? response.error : undefined);
    return response.data ?? {};
  }

  async function evaluate(
    state: BrowserState,
    script: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return (await command(state, { action: 'evaluate', script }, { signal })).result;
  }

  async function observationCommand(
    state: BrowserState,
    request: Record<string, unknown>,
    options: Parameters<typeof command>[2],
  ) {
    try {
      return await command(state, request, options);
    } catch (error) {
      if (error instanceof DaemonCommandError)
        throw new BrowserActionError('browser_observation_failed');
      throw error;
    }
  }

  async function openDialog(state: BrowserState, signal?: AbortSignal) {
    const dialog = await observationCommand(
      state,
      { action: 'dialog', response: 'status' },
      { signal },
    );
    if (dialog.hasDialog !== true) return;
    return {
      type: String(dialog.type),
      message: redactBrowserText(String(dialog.message ?? ''), state.secrets),
    };
  }

  async function pendingDialog(state: BrowserState, signal?: AbortSignal) {
    const dialog = await openDialog(state, signal);
    if (dialog)
      return `A ${dialog.type} dialog blocks the page: "${dialog.message}". Use accept_dialog {text?} or dismiss_dialog.`;
  }

  async function currentUrl(state: BrowserState, signal?: AbortSignal): Promise<string> {
    if (await pendingDialog(state, signal)) throw new BrowserActionError('browser_dialog_open');
    const data = await observationCommand(state, { action: 'url' }, { signal });
    const url = String(data.url ?? data.value ?? '');
    const storedUrl = new URL(url);
    if (!['http:', 'https:'].includes(storedUrl.protocol)) return url;
    browserUrl(url);
    storedUrl.search = '';
    storedUrl.hash = '';
    if (redactBrowserText(storedUrl.pathname, state.secrets) !== storedUrl.pathname)
      storedUrl.pathname = '/';
    state.saved.url = storedUrl.href;
    return url;
  }

  async function browserTabs(state: BrowserState, signal?: AbortSignal) {
    const data = await command(state, { action: 'tab_list' }, { signal });
    return browserTabList.parse(data.tabs);
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
    if (state.injecting || (await privateDocumentOpen(state, signal)))
      throw new BrowserLockedError();
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
    if (!Number.isInteger(offset) || offset < 0)
      throw new Error('Choose a non-negative page offset.');
    const snapshot = async () => {
      const devtools = state.secrets.size ? await inspector(state) : undefined;
      try {
        await devtools?.mask(true, [], false, true);
        return await observationCommand(
          state,
          { action: 'snapshot', urls: true, ...(scope ? { selector: scope } : {}) },
          { signal },
        );
      } finally {
        await devtools?.mask(false, [], false).catch(() => {});
        devtools?.close();
      }
    };
    const data = await snapshot();
    if (await privateDocumentOpen(state, signal)) throw new BrowserLockedError();
    const incoming =
      data.refs && typeof data.refs === 'object' ? (data.refs as Record<string, unknown>) : {};
    if (!scope) {
      state.refs.clear();
      for (const ref of state.refVersions.keys())
        if (!(ref in incoming)) state.refVersions.delete(ref);
    }
    for (const ref of Array.isArray(data.removedRefs) ? data.removedRefs : []) {
      state.refs.delete(String(ref));
      state.refVersions.delete(String(ref));
    }
    for (const [ref, control] of Object.entries(incoming))
      if (control && typeof control === 'object') {
        if (!state.refVersions.has(ref)) state.refVersions.set(ref, ++refSequence);
        state.refs.set(ref, {
          role: String((control as { role?: unknown }).role ?? ''),
          name: redactBrowserText(
            String((control as { name?: unknown }).name ?? ''),
            state.secrets,
          ).slice(0, 300),
        });
      }
    const page = redactBrowserText(String(data.snapshot ?? ''), state.secrets);
    const end = Math.min(page.length, offset + snapshotChars);
    return {
      text: `Page (${offset}-${end} of ${page.length} characters${end < page.length ? `; snapshot with offset ${end} continues` : ''}):\n${page.slice(offset, end)}`,
      url: redactBrowserUrl(url, state.secrets),
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
        {
          action: 'mousemove',
          x: Math.min(Math.ceil(width) - 1, Math.round(point.x * width)),
          y: Math.min(Math.ceil(height) - 1, Math.round(point.y * height)),
        },
        { signal },
      );
    await move(gesture.points[0]);
    try {
      await command(state, { action: 'mousedown', button: 'left' }, { signal });
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
          await command(state, { action: 'mouseup', button: 'left' }, { timeoutMs: 5000 });
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
    if (input.waitMs !== undefined && (!Number.isInteger(input.waitMs) || input.waitMs < 0))
      throw new Error('Choose a non-negative wait.');
    const savedProfile = input.action === 'open' ? await screens.load(id) : null;
    if (input.action === 'open' && !browsers.has(id)) await recoverBrowser(id, true);
    const existing = input.action === 'open' ? browsers.get(id) : undefined;
    if (
      existing &&
      (existing.recovered ||
        existing.closed ||
        existing.closing ||
        existing.saved.navigationFailed ||
        existing.privateDocument)
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
        await reserveBrowser(state, signal);
        if (!state.socket) {
          state.saved.timeZone = browserTimeZone(input.timeZone);
          state.saved.locale = browserLocale(input.locale);
        }
        try {
          if (!state.socket && viewport)
            await command(state, { action: 'navigate', url: 'about:blank' }, { signal });
          await command(state, { action: 'navigate', url: url.href }, { signal });
          state.saved.navigationFailed = false;
        } catch (error) {
          if (
            (error instanceof DaemonCommandError ||
              (error instanceof BrowserActionError &&
                error.code === 'browser_navigation_failed')) &&
            !signal?.aborted
          ) {
            try {
              const loaded = new URL(await currentUrl(state, signal));
              if (['http:', 'https:'].includes(loaded.protocol)) {
                const observation = await observe(state, signal);
                if (observation.text.slice(observation.text.indexOf('\n') + 1).trim()) {
                  state.saved.navigationFailed = false;
                  return {
                    ...observation,
                    text: `Opening ${redactBrowserUrl(url.href, state.secrets)} did not finish loading. This is the page the browser shows now.\n${observation.text}`,
                  };
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
          return {
            text: new BrowserActionError('browser_navigation_failed').message,
            url: state.saved.url,
          };
        }
        if (!state.started) throw new BrowserActionError('browser_not_open');
        if (input.action !== 'reload' && (await privateDocumentOpen(state, signal)))
          throw new BrowserActionError('browser_card_paused');
        await onTarget(state, input, signal);
        if (input.action === 'tab_list') {
          const tabs = await browserTabs(state, signal);
          return {
            text: tabs
              .map(
                (tab) =>
                  `${tab.active ? 'Active' : 'Open'} ${tab.tabId}: ${redactBrowserUrl(tab.url, state.secrets)}`,
              )
              .join('\n'),
            url: redactBrowserUrl(await currentUrl(state, signal), state.secrets),
          };
        }
        if (input.action === 'tab_switch') {
          await command(state, { action: 'tab_switch', tabId: input.tabId }, { signal });
        }
        if (input.action === 'click') {
          if (gesture) await movePointer(state, gesture, signal);
          else
            await command(
              state,
              { action: 'click', selector: selector(input.selector) },
              { signal },
            );
        }
        if (input.action === 'fill' || input.action === 'type') {
          const target = selector(input.selector);
          const text = input.text ?? '';
          await command(
            state,
            input.action === 'fill'
              ? { action: 'fill', selector: target, value: text }
              : { action: 'type', selector: target, text },
            { signal },
          );
        }
        if (input.action === 'scroll')
          await command(
            state,
            {
              action: 'scroll',
              direction: input.direction ?? 'down',
              amount: input.amount ?? 600,
              ...(input.selector ? { selector: selector(input.selector) } : {}),
            },
            { signal },
          );
        if (input.action === 'press') {
          if (!input.key) throw new Error('Choose a key to press.');
          await command(state, { action: 'press', key: input.key }, { signal });
        }
        if (input.action === 'accept_dialog' || input.action === 'dismiss_dialog') {
          const text = input.action === 'accept_dialog' ? input.text : undefined;
          await command(
            state,
            {
              action: 'dialog',
              response: input.action === 'accept_dialog' ? 'accept' : 'dismiss',
              ...(text ? { promptText: text } : {}),
            },
            { signal },
          );
        }
        if (input.action === 'wait') {
          if (
            [input.text, input.url, input.load].filter(Boolean).length !== 1 ||
            (input.load && !['load', 'domcontentloaded', 'networkidle'].includes(input.load))
          )
            throw new Error('Wait for one of text, url or load.');
          try {
            await command(
              state,
              {
                ...(input.text
                  ? { action: 'wait', text: input.text }
                  : input.url
                    ? { action: 'waitforurl', url: input.url }
                    : { action: 'waitforloadstate', state: input.load }),
                ...(input.waitMs === undefined ? {} : { timeout: input.waitMs }),
              },
              { signal },
            );
          } catch (error) {
            if (!(error instanceof DaemonCommandError)) throw error;
            const observation = await observe(state, signal);
            return {
              ...observation,
              text: `The wait condition was not met.\n${observation.text}`,
            };
          }
        }
        if (input.action === 'select') {
          const value = input.text ?? '';
          if (!value) throw new Error('Choose a visible option.');
          await command(
            state,
            { action: 'select', selector: selector(input.selector), value },
            { signal },
          );
        }
        if (['check', 'uncheck', 'hover'].includes(input.action))
          await command(
            state,
            { action: input.action, selector: selector(input.selector) },
            { signal },
          );
        if (input.action === 'drag') {
          if (gesture) await movePointer(state, gesture, signal);
          else
            await command(
              state,
              {
                action: 'drag',
                source: selector(input.selector),
                target: selector(input.targetSelector),
              },
              { signal },
            );
        }
        if (['back', 'forward', 'reload'].includes(input.action)) {
          const devtools = await inspector(state, signal).catch(() => undefined);
          try {
            const before = await devtools?.document().catch(() => undefined);
            const entry =
              input.action === 'reload'
                ? await devtools?.navigation().catch(() => undefined)
                : undefined;
            const native =
              input.action !== 'reload' || (!!entry?.type && entry.type !== 'form_submit');
            const target = native
              ? undefined
              : browserUrl(entry?.url ?? (await currentUrl(state, signal))).href;
            const failure = await command(
              state,
              target ? { action: 'navigate', url: target } : { action: input.action },
              { signal },
            ).then(
              () => undefined,
              (error: unknown) => error,
            );
            const after = await devtools?.document().catch(() => undefined);
            const moved = Boolean(before && after && before !== after);
            if (failure && !(failure instanceof DaemonCommandError && moved)) throw failure;
            if (moved && (state.saved.scripted || state.sealedDocument)) {
              delete state.saved.scripted;
              delete state.sealedDocument;
              await saveState(state);
            }
          } finally {
            devtools?.close();
          }
        }
        if (input.action === 'evaluate') {
          const script = input.script ?? '';
          if (!script.trim()) throw new Error('Provide a script.');
          const url = await currentUrl(state, signal);
          const devtools = await inspector(state);
          let read;
          try {
            if (state.sealedDocument) {
              const current = await devtools.document().catch(() => undefined);
              if (!current || current === state.sealedDocument)
                throw new BrowserActionError('browser_script_paused');
              delete state.sealedDocument;
            }
            if (state.secrets.size && (await devtools.holding()))
              throw new BrowserActionError('browser_script_paused');
            read = await devtools.readOnly(script);
            if (!read) {
              if (input.readOnly) throw new BrowserActionError('browser_script_writes');
              await devtools.scripted(true);
              await saveState(state);
            }
          } finally {
            devtools.close();
          }
          const value = read ? read.value : await evaluate(state, script, signal);
          if (!read) {
            await markScripted(state);
            await observe(state, signal).catch(() => state.refs.clear());
          }
          const result = redactBrowserText(JSON.stringify(value ?? null) ?? 'null', state.secrets);
          return {
            text: `Script result (JSON):\n${result}`,
            url: redactBrowserUrl(url, state.secrets),
          };
        }
      }
      if (input.waitMs && input.action !== 'wait') await delay(input.waitMs, undefined, { signal });
      return observe(state, signal, input);
    }).catch((error: unknown) => {
      if (error instanceof DaemonCommandError)
        throw new BrowserActionError(
          'browser_action_failed',
          error.detail ? redactBrowserText(error.detail, state.secrets) : undefined,
        );
      throw error;
    });
  }

  async function upload(id: string, input: BrowserUploadInput, signal?: AbortSignal) {
    if (
      !input.bytes.length ||
      input.bytes.length > fileBytes ||
      !/^[^/\\\u0000-\u001f\u007f]{1,200}$/.test(input.name)
    )
      throw new Error(`Choose a file of at most ${fileBytes / 1024 / 1024} MB.`);
    const state = await recoverBrowser(id);
    if (!state?.started) throw new Error('Open the upload website first.');
    if (state.injecting) throw new BrowserLockedError();
    return serialize(state, async () => {
      if (state.injecting) throw new BrowserLockedError();
      signal?.throwIfAborted();
      if (await privateDocumentOpen(state, signal))
        throw new BrowserActionError('browser_card_paused');
      await onTarget(state, input, signal);
      const directory = resolve(uploadRoot, randomUUID());
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = resolve(directory, input.name);
      try {
        await writeFile(file, input.bytes, { mode: 0o600 });
        await command(
          state,
          { action: 'upload', selector: selector(input.selector), file },
          { signal },
        );
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
      if (await privateDocumentOpen(state, signal)) throw new BrowserLockedError();
      const current = await currentUrl(state, signal);
      const directory = resolve(runtimeRoot, 'downloads', state.id);
      let url = input.url;
      let target: string | undefined;
      if (input.selector) {
        const href = await command(
          state,
          { action: 'getattribute', selector: selector(input.selector), attribute: 'href' },
          { signal },
        );
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
        if (!url) {
          if (input.expectOrigin === undefined)
            throw new BrowserActionError('browser_download_control');
          await onTarget(state, input, signal);
          target = selector(input.selector);
        }
      }
      if (!url && !target) {
        const type = await evaluate(state, 'document.contentType', signal);
        if (type === 'application/pdf') url = current;
        else {
          let files = await completedDownloads(directory);
          if (!files.length) {
            await command(state, { action: 'waitfordownload' }, { signal });
            files = await completedDownloads(directory);
          }
          if (!files.length) throw new Error('Choose the specific download link or URL.');
          const result = await readDownload(directory, files[0]!, input.name);
          await rm(resolve(directory, files[0]!), { force: true });
          signal?.throwIfAborted();
          return result;
        }
      }
      const crossOrigin = url && new URL(url).origin !== new URL(current).origin;
      if (url) {
        if (!url.startsWith(`blob:${new URL(current).origin}/`)) browserUrl(url);
      }
      if (url && !crossOrigin) {
        const key = `nod-download-${randomUUID()}`;
        try {
          const fetched = z
            .object({ size: z.number().int().min(0).max(fileBytes), mimeType: z.string() })
            .nullable()
            .parse(await evaluate(state, fetchDownloadScript(url, key), signal));
          if (!fetched) throw new Error('The browser file is unavailable.');
          const chunks: Buffer[] = [];
          for (let offset = 0; offset < fetched.size; offset += fetchChunkBytes)
            chunks.push(
              decodeDownloadChunk(await evaluate(state, fetchChunkScript(key, offset), signal)),
            );
          const bytes = Buffer.concat(chunks);
          if (bytes.length !== fetched.size) throw new Error('The browser file is unavailable.');
          signal?.throwIfAborted();
          return downloadFile(bytes, input.name, fetched.mimeType);
        } finally {
          if (!state.closed && !state.closing)
            await evaluate(state, `delete window[${JSON.stringify(key)}]`).catch(() => {});
        }
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const capture = await createDownloadCapture(directory);
      const anchor = target ? undefined : `nod-download-${randomUUID()}`;
      try {
        if (anchor)
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
            signal,
          );
        await command(
          state,
          {
            action: 'download',
            selector: target ?? `#${anchor}`,
            path: resolve(directory, capture.file),
          },
          { signal },
        );
        signal?.throwIfAborted();
        const result = await readDownload(directory, capture.file, input.name);
        signal?.throwIfAborted();
        return result;
      } finally {
        try {
          if (anchor && !state.closed && !state.closing)
            await evaluate(state, `document.getElementById(${JSON.stringify(anchor)})?.remove()`);
        } finally {
          await capture.cleanup(state.closed);
        }
      }
    });
  }

  async function privateEntry<T>(
    state: BrowserState,
    submitSelector: string | undefined,
    operation: (devtools: Awaited<ReturnType<typeof openDevtools>>, document: string) => Promise<T>,
    submitOrigins: string[] = [],
  ): Promise<T> {
    if (state.injecting) throw new BrowserLockedError();
    state.injecting = true;
    try {
      return await serialize(state, async () => {
        const devtools = await inspector(state);
        try {
          const document = await checkout(state, devtools);
          state.privateDocument = document;
          state.saved.sensitive = true;
          await saveState(state);
          const result = await operation(devtools, document);
          if (submitSelector && (await devtools.document()) !== document)
            throw new BrowserActionError('browser_card_changed');
          if ((await devtools.document()) === document) {
            if (submitSelector) {
              const field = await focusField(state, devtools, selector(submitSelector));
              const origin = new URL(await currentUrl(state)).origin;
              if (
                (field.origin !== origin && !submitOrigins.includes(field.origin)) ||
                (await devtools.document()) !== document
              )
                throw new Error('The submit control is not on this page.');
              await command(state, {
                action: 'scrollintoview',
                selector: selector(submitSelector),
              });
              await command(state, { action: 'click', selector: selector(submitSelector) });
            }
          }
          state.privateDocument = undefined;
          if (state.secrets.size) state.sealedDocument = document;
          return result;
        } finally {
          devtools.close();
        }
      });
    } finally {
      state.injecting = false;
    }
  }

  async function injectCredentials(input: CredentialInput): Promise<CredentialSubmission> {
    const state = browsers.get(threadIdentity(input.threadId));
    if (!state?.started) throw new Error('The browser session has expired. Reopen the login page.');
    if (browserUrl(input.origin).origin !== input.origin)
      throw new Error('An exact login origin is required.');
    const fields = credentialFields(input);
    return privateEntry(state, input.submitSelector, async (devtools, document) => {
      if (new URL(await currentUrl(state)).origin !== input.origin)
        throw new Error('The page is not on the website for this login.');
      for (const step of fields) {
        const secret = input.kind === 'otp' ? input.code! : step.value;
        const identifier = input.kind === 'identifier' || step.value === input.username;
        if (!identifier) state.secrets.add(secret);
        const field = await focusField(state, devtools, step.selector);
        if (field.origin !== input.origin)
          throw new Error('The login field is on a different origin.');
        if (step.code) {
          if (!(await devtools.code(field, step.selector, step.value)))
            throw new Error('The code fields changed during private entry.');
          continue;
        }
        if (!(await devtools.arm(field)))
          throw new Error('The login field is no longer available.');
        if ((await devtools.document()) !== document || !(await devtools.insert(field, step.value)))
          throw new Error(
            'The login field changed during entry. Check the result before another attempt.',
          );
      }
      await saveState(state);
      return { status: 'submitted' as const };
    });
  }

  async function privateDocumentOpen(state: BrowserState, signal?: AbortSignal) {
    if (!state.privateDocument) return false;
    signal?.throwIfAborted();
    const devtools = await inspector(state).catch(() => undefined);
    if (!devtools) return true;
    try {
      const alive = await devtools.alive(state.privateDocument);
      if (!alive) state.privateDocument = undefined;
      return alive;
    } catch {
      return true;
    } finally {
      devtools.close();
    }
  }

  async function markScripted(state: BrowserState) {
    const devtools = await inspector(state).catch(() => undefined);
    try {
      if (!devtools || !(await devtools.scripted(true).catch(() => false))) {
        state.saved.scripted = true;
        await saveState(state);
      }
    } finally {
      devtools?.close();
    }
  }

  async function inspector(state: BrowserState, signal?: AbortSignal) {
    const { cdpUrl } = z
      .object({ cdpUrl: z.string() })
      .passthrough()
      .parse(await command(state, { action: 'cdp_url' }, { signal }));
    const tab = z
      .array(z.object({ active: z.boolean(), targetId: z.string() }).passthrough())
      .parse((await command(state, { action: 'tab_list' }, { signal })).tabs)
      .find((item) => item.active);
    if (!tab) throw new Error('The checkout tab is no longer open.');
    return openDevtools(cdpUrl, tab.targetId, signal);
  }

  async function focusField(
    state: BrowserState,
    devtools: Awaited<ReturnType<typeof openDevtools>>,
    selector: string,
  ) {
    await devtools.blur();
    await command(state, { action: 'focus', selector }).catch(() => {
      throw new BrowserActionError('browser_card_field');
    });
    const field = await devtools.focused();
    if (!field) throw new BrowserActionError('browser_card_field');
    return field;
  }

  async function checkout(state: BrowserState, devtools: Awaited<ReturnType<typeof openDevtools>>) {
    const document = await devtools.document();
    if (state.saved.scripted || (await devtools.scripted()))
      throw new BrowserActionError('browser_card_reload');
    return document;
  }

  async function cardDestinations(
    id: string,
    fields: CardFields,
  ): Promise<{ document: string; destinations: Partial<Record<keyof CardFields, string>> }> {
    const state = browsers.get(threadIdentity(id));
    if (!state?.started) throw new Error('The checkout page is no longer open.');
    if (state.injecting) throw new BrowserLockedError();
    return serialize(state, async () => {
      if (state.injecting || (await privateDocumentOpen(state))) throw new BrowserLockedError();
      const devtools = await inspector(state);
      try {
        const document = await checkout(state, devtools);
        const destinations: Partial<Record<keyof CardFields, string>> = {};
        for (const [name, field] of Object.entries(fields) as Array<
          [keyof CardFields, CardExpiryField]
        >)
          if (field)
            destinations[name] = (
              await focusField(state, devtools, typeof field === 'string' ? field : field.selector)
            ).origin;
        await devtools.blur();
        if ((await devtools.document()) !== document)
          throw new BrowserActionError('browser_card_changed');
        return { document, destinations };
      } finally {
        devtools.close();
      }
    });
  }

  async function checkoutImage(id: string): Promise<Uint8Array> {
    const state = browsers.get(threadIdentity(id));
    if (!state?.started) throw new Error('The checkout page is no longer open.');
    if (state.injecting) throw new BrowserLockedError();
    return serialize(state, async () => {
      if (await privateDocumentOpen(state)) throw new BrowserActionError('browser_card_paused');
      await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
      const path = resolve(runtimeRoot, `checkout-${state.id}.jpg`);
      const devtools = await inspector(state);
      try {
        await devtools.mask(true);
        await observationCommand(
          state,
          {
            action: 'screenshot',
            path,
            fullPage: true,
            annotate: false,
            format: 'jpeg',
            quality: 70,
          },
          {},
        );
        const bytes = await readFile(path);
        if (!bytes.byteLength || bytes.byteLength > 12 * 1024 * 1024)
          throw new Error('The checkout page could not be captured.');
        return new Uint8Array(bytes);
      } finally {
        await devtools.mask(false).catch(() => {});
        devtools.close();
        await rm(path, { force: true });
      }
    });
  }

  async function fillCard(input: CardEntry): Promise<void> {
    const state = browsers.get(threadIdentity(input.threadId));
    if (!state?.started) throw new Error('The checkout page is no longer open.');
    if (state.injecting) throw new BrowserLockedError();
    const { card, fields } = input;
    if (fields.securityCode && !card.securityCode)
      throw new Error('The security code is needed for this card.');
    const month = String(card.expiryMonth).padStart(2, '0');
    const year = String(card.expiryYear);
    const monthName = (length: 'long' | 'short', locale = 'en') =>
      new Intl.DateTimeFormat(locale, { month: length, timeZone: 'UTC' }).format(
        new Date(Date.UTC(card.expiryYear, card.expiryMonth - 1, 1)),
      );
    const expiry = (field: CardExpiryField | undefined, defaults: string[]) => {
      if (!field || typeof field === 'string') return defaults;
      return [
        field.format.replace(/MMMM|MMM|MM|M|YYYY|YY/g, (token) => {
          if (token === 'M') return String(card.expiryMonth);
          if (token === 'MM') return month;
          if (token === 'YYYY') return year;
          if (token === 'YY') return year.slice(-2);
          return monthName(token === 'MMM' ? 'short' : 'long', field.locale);
        }),
      ];
    };
    const plan: Array<{ field: keyof CardFields; values: string[] }> = [
      { field: 'number', values: [card.cardNumber] },
      { field: 'expiry', values: expiry(fields.expiry, [`${month}/${year.slice(-2)}`]) },
      {
        field: 'expiryMonth',
        values: expiry(fields.expiryMonth, [
          month,
          String(card.expiryMonth),
          monthName('long'),
          monthName('short'),
        ]),
      },
      { field: 'expiryYear', values: expiry(fields.expiryYear, [year, year.slice(-2)]) },
      { field: 'securityCode', values: card.securityCode ? [card.securityCode] : [] },
      { field: 'name', values: [card.cardholder] },
    ];
    const steps = plan.filter((step) => fields[step.field] && step.values.length);
    for (const step of steps)
      if (!input.destinations[step.field])
        throw new Error('The approved card destinations are missing.');
    await privateEntry(
      state,
      input.submitSelector,
      async (devtools, document) => {
        if (document !== input.document) throw new BrowserActionError('browser_card_changed');
        for (const step of steps) {
          const privateValue = step.field === 'number' || step.field === 'securityCode';
          if (privateValue) for (const value of step.values) state.secrets.add(value);
          const selection = fields[step.field]!;
          const field = await focusField(
            state,
            devtools,
            typeof selection === 'string' ? selection : selection.selector,
          );
          if (field.origin !== input.destinations[step.field])
            throw new BrowserActionError('browser_card_site');
          const tag = await devtools.arm(field, privateValue);
          if (!tag) throw new BrowserActionError('browser_card_field');
          if (tag === 'SELECT') {
            if (!(await devtools.choose(field, step.values)))
              throw new BrowserActionError('browser_card_field');
          } else if (
            (await devtools.document()) !== document ||
            !(await devtools.insert(field, step.values[0]!))
          )
            throw new BrowserActionError('browser_card_site');
        }
      },
      steps.map((step) => input.destinations[step.field]!),
    );
  }

  async function controlsOf(
    state: BrowserState,
    target: { selector?: string; point?: { x: number; y: number }; focused?: boolean },
  ) {
    const ref = referenceOf(target.selector);
    if (ref)
      return {
        controls: state.refs.has(ref) ? [state.refs.get(ref)!] : [],
        identity: state.refVersions.has(ref) ? { ref, version: state.refVersions.get(ref)! } : null,
      };
    if (!target.selector && !target.point && !target.focused)
      return { controls: [], identity: { kind: 'page' } };
    const devtools = await inspector(state).catch(() => undefined);
    try {
      const resolved = await devtools?.target(target).catch(() => undefined);
      return {
        controls: (resolved?.controls ?? []).map((control) => ({
          role: control.role,
          name: redactBrowserText(control.name, state.secrets).slice(0, 300),
        })),
        identity: resolved?.identity ?? null,
      };
    } finally {
      devtools?.close();
    }
  }

  async function pointOf(state: BrowserState, ref: string) {
    await command(state, { action: 'scrollintoview', selector: `@${ref}` });
    const box = z
      .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
      .passthrough()
      .parse(await command(state, { action: 'boundingbox', selector: `@${ref}` }));
    return { pixel: { x: box.x + box.width / 2, y: box.y + box.height / 2 } };
  }

  async function submissionOf(
    state: BrowserState,
    target: { selector?: string; point?: { x: number; y: number }; focused?: boolean },
    enter: boolean,
  ) {
    const ref = referenceOf(target.selector);
    if (ref && !state.refs.has(ref)) return undefined;
    const devtools = await inspector(state).catch(() => undefined);
    try {
      const found = devtools
        ? await (ref ? pointOf(state, ref) : Promise.resolve(target))
            .then((query) => devtools.submits(query, enter))
            .catch(() => 'unknown' as const)
        : ('unknown' as const);
      if (found === 'unknown' || !found) return found ?? undefined;
      return { method: found.method, to: found.to };
    } finally {
      devtools?.close();
    }
  }

  async function stepControls(state: BrowserState, step: BrowserAction) {
    const point =
      step.x !== undefined && step.y !== undefined ? { x: step.x, y: step.y } : step.points?.[0];
    const target =
      step.action === 'press'
        ? { focused: true }
        : step.selector
          ? { selector: step.selector }
          : point
            ? { point }
            : { focused: step.action === 'type' };
    const { controls, identity: sourceIdentity } = await controlsOf(state, target);
    const enter =
      (step.action === 'press' && step.key === 'Enter') ||
      (step.action === 'type' && /[\r\n]/.test(step.text ?? ''));
    const submits =
      step.action === 'click' || enter ? await submissionOf(state, target, enter) : undefined;
    if (step.action !== 'drag')
      return { controls, sourceIdentity, ...(submits ? { rawSubmits: submits } : {}) };
    const drop = step.targetSelector
      ? { selector: step.targetSelector }
      : step.points && step.points.length > 1
        ? { point: step.points.at(-1)! }
        : {};
    const dropResolved = await controlsOf(state, drop);
    return {
      controls,
      sourceIdentity,
      dropTarget: dropResolved.controls,
      dropIdentity: dropResolved.identity,
    };
  }

  async function targetDetails(
    state: BrowserState,
    step: BrowserAction,
    url: string,
    dialog?: string,
  ) {
    const details = step.action ? await stepControls(state, step) : undefined;
    const target = createHmac('sha256', targetKey)
      .update(
        JSON.stringify({
          url,
          dialog,
          action: step.action,
          key: step.key,
          details,
        }),
      )
      .digest('hex');
    return { target, details };
  }

  async function onTarget(
    state: BrowserState,
    input: Omit<BrowserAction, 'action'> & { action?: BrowserAction['action'] },
    signal?: AbortSignal,
  ) {
    if (
      input.expectOrigin === undefined &&
      input.expectUrl === undefined &&
      input.expectTarget === undefined
    )
      return;
    const dialog = input.action === 'accept_dialog' ? await openDialog(state, signal) : undefined;
    const at = dialog
      ? await dialogPageUrl(state, signal).catch(() => '')
      : await currentUrl(state, signal).catch(() => '');
    const refs = [referenceOf(input.selector), referenceOf(input.targetSelector)];
    const checked =
      input.expectTarget !== undefined && at
        ? await targetDetails(
            state,
            { ...input, action: input.action ?? 'click' },
            at,
            dialog?.message.slice(0, 2000),
          )
        : undefined;
    const unresolved =
      checked?.details &&
      (checked.details.sourceIdentity === null ||
        ('dropIdentity' in checked.details && checked.details.dropIdentity === null));
    if (
      !at ||
      (input.expectOrigin !== undefined && originOf(at) !== input.expectOrigin) ||
      (input.expectUrl !== undefined && redactBrowserUrl(at, state.secrets) !== input.expectUrl) ||
      (input.expectTarget !== undefined && checked?.target !== input.expectTarget) ||
      unresolved ||
      refs.some((ref) => ref !== undefined && !state.refs.has(ref))
    )
      throw new BrowserActionError('browser_target_changed');
  }

  async function dialogPageUrl(state: BrowserState, signal?: AbortSignal) {
    const active = (await browserTabs(state, signal)).find((tab) => tab.active);
    if (!active?.url) throw new BrowserActionError('browser_target_changed');
    return active.url;
  }

  function originOf(url: string) {
    try {
      return browserUrl(url).origin;
    } catch {
      return '';
    }
  }

  async function currentPage(id: string, step?: BrowserAction): Promise<BrowserPage> {
    const state = await recoverBrowser(id);
    if (state?.saved.navigationFailed || (!state && (await screens.load(id))?.navigationFailed))
      throw new BrowserActionError('browser_navigation_failed');
    if (!state?.started) throw new Error('Open the login page in this task browser first.');
    if (state.injecting) throw new BrowserLockedError();
    return serialize(state, async () => {
      if (state.injecting) throw new BrowserLockedError();
      if (await privateDocumentOpen(state)) throw new BrowserLockedError();
      const dialog = step?.action === 'accept_dialog' ? await openDialog(state) : undefined;
      const url = dialog ? await dialogPageUrl(state) : await currentUrl(state);
      const page = { origin: browserUrl(url).origin, url: redactBrowserUrl(url, state.secrets) };
      const { target, details } = await targetDetails(
        state,
        step ?? ({ action: 'snapshot' } as BrowserAction),
        url,
        dialog?.message.slice(0, 2000),
      );
      if (dialog) return { ...page, dialog: dialog.message.slice(0, 2000), target };
      const submits = details && 'rawSubmits' in details ? details.rawSubmits : undefined;
      return {
        ...page,
        target,
        ...(details?.controls ? { controls: details.controls } : {}),
        ...(submits
          ? {
              submits:
                submits === 'unknown'
                  ? 'unknown'
                  : { method: submits.method, to: redactBrowserUrl(submits.to, state.secrets) },
            }
          : {}),
        ...(details?.dropTarget ? { dropTarget: details.dropTarget } : {}),
      };
    });
  }

  async function signInMethods(
    id: string,
    origin: string,
    methods: { label: string; selector: string }[],
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (browserUrl(origin).origin !== origin || !methods.length || methods.length > 10)
      throw new BrowserActionError('browser_target_changed');
    const state = await recoverBrowser(id);
    if (!state?.started || state.saved.navigationFailed)
      throw new BrowserActionError('browser_target_changed');
    return serialize(state, async () => {
      state.signInMethods = undefined;
      signal?.throwIfAborted();
      if (state.injecting || (await privateDocumentOpen(state, signal)))
        throw new BrowserLockedError();
      if (originOf(await currentUrl(state, signal)) !== origin)
        throw new BrowserActionError('browser_target_changed');
      const devtools = await inspector(state, signal);
      try {
        const document = await checkout(state, devtools);
        const controls = new Map<string, BoundSignInControl>();
        const choices: { id: string; label: string; page: BrowserPage }[] = [];
        for (const method of methods) {
          signal?.throwIfAborted();
          const target = selector(method.selector);
          const ref = referenceOf(target);
          const observed = ref ? state.refs.get(ref) : undefined;
          if (ref && !observed) throw new BrowserActionError('browser_target_changed');
          const control = await devtools.signInControl(
            ref ? await pointOf(state, ref) : { selector: target },
          );
          if (
            control.origin !== origin ||
            [...controls.values()].some(
              (previous) => previous.backendNodeId === control.backendNodeId,
            )
          )
            throw new BrowserActionError('browser_target_changed');
          const methodId = randomUUID();
          controls.set(methodId, control);
          const page: BrowserPage = {
            origin,
            url: redactBrowserUrl(control.url, state.secrets),
            controls: control.controls.map((item) => ({
              role: item.role,
              name: redactBrowserText(item.name, state.secrets).slice(0, 300),
            })),
            ...(control.submits
              ? {
                  submits: {
                    method: control.submits.method,
                    to: redactBrowserUrl(control.submits.to, state.secrets),
                  },
                }
              : {}),
          };
          const bound = page.controls![0]!;
          if (observed && (observed.role !== bound.role || observed.name !== bound.name))
            throw new BrowserActionError('browser_target_changed');
          choices.push({ id: methodId, label: bound.name, page });
        }
        if ((await devtools.document()) !== document)
          throw new BrowserActionError('browser_target_changed');
        state.signInMethods = { document, origin, controls };
        return { document, methods: choices };
      } finally {
        devtools.close();
      }
    });
  }

  async function selectSignInMethod(
    id: string,
    input: { origin: string; document: string; methodId: string },
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const state = browsers.get(threadIdentity(id));
    if (!state?.started) throw new BrowserActionError('browser_target_changed');
    await serialize(state, async () => {
      signal?.throwIfAborted();
      const batch = state.signInMethods;
      state.signInMethods = undefined;
      const control = batch?.controls.get(input.methodId);
      if (
        !batch ||
        !control ||
        batch.origin !== input.origin ||
        batch.document !== input.document ||
        state.saved.navigationFailed
      )
        throw new BrowserActionError('browser_target_changed');
      if (state.injecting || (await privateDocumentOpen(state, signal)))
        throw new BrowserLockedError();
      const devtools = await inspector(state, signal);
      try {
        if (
          (await checkout(state, devtools)) !== batch.document ||
          originOf(await currentUrl(state, signal)) !== batch.origin
        )
          throw new BrowserActionError('browser_target_changed');
        signal?.throwIfAborted();
        await devtools.selectSignInControl(control);
      } finally {
        devtools.close();
      }
    });
  }

  async function hold(id: string, held: boolean): Promise<void> {
    const state = browsers.get(threadIdentity(id));
    if (!state?.started) return;
    await serialize(state, async () => {
      state.heldAt = held ? Date.now() : undefined;
      if (!held) return;
      await currentUrl(state);
      await captureScreen(state).catch((error: unknown) => {
        if (!(error instanceof BrowserLockedError)) throw error;
      });
    });
  }

  async function captureScreen(state: BrowserState, signal?: AbortSignal): Promise<Buffer> {
    if (state.saved.navigationFailed) throw new BrowserActionError('browser_navigation_failed');
    if (state.recovered && state.saved.sensitive && !state.secrets.size)
      throw new Error('Reopen the login page before continuing this browser session.');
    await currentUrl(state, signal);
    if (await privateDocumentOpen(state, signal)) throw new BrowserLockedError();
    const path = resolve(runtimeRoot, `screen-${state.id}.capture.png`);
    const devtools = state.secrets.size ? await inspector(state) : undefined;
    try {
      await devtools?.mask(true, [...state.secrets], false);
      await observationCommand(
        state,
        { action: 'screenshot', path, fullPage: false, annotate: false },
        { signal },
      );
      if (await privateDocumentOpen(state, signal)) {
        await rm(path, { force: true });
        throw new BrowserLockedError();
      }
    } finally {
      await devtools?.mask(false).catch(() => {});
      devtools?.close();
    }
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

  async function control(
    id: string,
    input: BrowserHandoffInput,
    signal?: AbortSignal,
  ): Promise<string | void> {
    const state = await recoverBrowser(id);
    if (!state?.started) throw new Error('Open a page in this task browser first.');
    if (state.injecting) throw new BrowserLockedError();
    return serialize(state, async () => {
      if (state.injecting) throw new BrowserLockedError();
      if (await privateDocumentOpen(state, signal)) throw new BrowserLockedError();
      if (input.type === 'copy') {
        const devtools = await inspector(state, signal);
        try {
          return await devtools.copySelection();
        } finally {
          devtools.close();
        }
      }
      const socket = await daemonSocket(state, signal);
      if (input.type === 'mouse') {
        const [width, height] = (state.pageSize ??= z
          .tuple([z.number().positive(), z.number().positive()])
          .parse(await evaluate(state, '[innerWidth, innerHeight]', signal)));
        await requestDaemon(
          socket,
          { action: 'mousemove', x: Math.round(input.x * width), y: Math.round(input.y * height) },
          signal,
        );
        if (input.event !== 'move')
          await requestDaemon(
            socket,
            { action: `mouse${input.event}`, button: input.button ?? 'left' },
            signal,
          );
      }
      if (input.type === 'wheel')
        await requestDaemon(
          socket,
          { action: 'wheel', deltaX: input.deltaX, deltaY: input.deltaY },
          signal,
        );
      if (input.type === 'text') {
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
          const earlier = state.typed;
          if (
            earlier?.fresh &&
            earlier.origin === origin &&
            earlier.field === field &&
            secret.startsWith(earlier.value)
          )
            state.secrets.delete(earlier.value);
          state.typed = { value: secret, origin, field, fresh: !state.secrets.has(secret) };
          state.secrets.add(secret);
          await saveState(state);
        }
      }
      if (input.type === 'key')
        await requestDaemon(socket, { action: 'press', key: input.key }, signal);
    });
  }

  async function* view(id: string, signal: AbortSignal): AsyncGenerator<Buffer> {
    const state = await recoverBrowser(id);
    if (!state?.started) throw new Error('Open a page in this task browser first.');
    if (state.recovered && state.saved.sensitive && !state.secrets.size)
      throw new Error('Reopen the login page before continuing this browser session.');
    const { port } = z
      .object({ port: z.number().int().min(1).max(65_535) })
      .parse(
        await requestDaemon(await daemonSocket(state, signal), { action: 'stream_status' }, signal),
      );
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?pacing=ack&maxFps=30`);
    let latest: z.infer<typeof streamFrame> | undefined;
    let open = true;
    let wake = () => {};
    const stop = () => {
      open = false;
      wake();
    };
    socket.addEventListener('message', (event) => {
      try {
        const frame = streamFrame.safeParse(JSON.parse(String(event.data)));
        if (!frame.success) return;
        latest = frame.data;
        wake();
      } catch {
        return;
      }
    });
    socket.addEventListener('close', stop);
    socket.addEventListener('error', stop);
    signal.addEventListener('abort', stop, { once: true });
    try {
      while (open) {
        const frame = latest;
        latest = undefined;
        if (!frame) {
          await new Promise<void>((resolve) => (wake = resolve));
          continue;
        }
        state.pageSize = [
          frame.metadata.deviceWidth / frame.metadata.pageScaleFactor,
          frame.metadata.deviceHeight / frame.metadata.pageScaleFactor,
        ];
        if (!state.injecting && !(await privateDocumentOpen(state, signal)))
          yield Buffer.from(frame.data, 'base64');
        if (socket.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ type: 'ack', seq: frame.seq }));
      }
    } finally {
      signal.removeEventListener('abort', stop);
      socket.close();
    }
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
        if (!state.recovered || error instanceof BrowserLockedError) throw error;
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
      if (idleAt !== undefined && (state.lastUsed !== idleAt || state.busy || state.injecting))
        return;
      state.closing = true;
      if (state.started && !state.closed && !state.injecting)
        await captureScreen(state).catch(() => {});
      state.closed = true;
      if (state.started || state.saved.navigationFailed) await shutDown(state);
      state.started = false;
      await state.proxy?.dispose();
      await saveState(state);
      state.secrets.clear();
      delete state.sealedDocument;
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
        if (other.busy || other.injecting || holding(other)) throw new BrowserLockedError();
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
        if (state && (state.busy || state.injecting || holding(state)))
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

  async function clear(rawId: string): Promise<void> {
    await remove(threadIdentity(rawId));
  }

  async function discard(rawId: string): Promise<void> {
    const id = threadIdentity(rawId);
    discarded.add(id);
    await remove(id);
  }

  async function remove(id: string): Promise<void> {
    await closeBrowser(id);
    await Promise.all([
      rm(resolve(runtimeRoot, 'profiles', id), { recursive: true, force: true }),
      rm(resolve(runtimeRoot, 'downloads', id), { recursive: true, force: true }),
      rm(resolve(runtimeRoot, `screen-${id}.capture.png`), { force: true }),
      screens.delete(id),
    ]);
    screenStatuses.delete(id);
  }

  return {
    canCheckpoint: () =>
      !disposed &&
      !activeCalls &&
      [...browsers.values()].every(
        (state) => !state.busy && !state.closing && !state.injecting && !holding(state),
      ),
    bindProfile: tracked(bindProfile),
    deleteProfile: tracked(deleteProfile),
    act: tracked(browserAction),
    upload: tracked(upload),
    download: tracked(download),
    screenshot: tracked(getScreenshot),
    control: tracked(control),
    view,
    screenStatus: (id) => screenStatuses.get(threadIdentity(id)) ?? { state: 'unavailable' },
    injectCredentials: tracked(injectCredentials),
    fillCard: tracked(fillCard),
    cardDestinations: tracked(cardDestinations),
    checkoutImage: tracked(checkoutImage),
    currentPage: tracked(currentPage),
    signInMethods: tracked(signInMethods),
    selectSignInMethod: tracked(selectSignInMethod),
    hold: tracked(hold),
    close: tracked(closeBrowser),
    clear: tracked(clear),
    discard: tracked(discard),
    dispose: async () => {
      disposed = true;
      const results = await Promise.allSettled([...browsers.keys()].map((id) => closeBrowser(id)));
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('The browser service could not finish closing its sessions.');
    },
  };
}
