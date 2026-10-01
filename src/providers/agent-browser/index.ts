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
import { threadIdentity } from '../../ports/thread-identity.ts';
import { runProcess, serviceEnvironment } from '../process.ts';
import { createBrowserProxy, browserUrl } from './network.ts';
import { credentialFields } from './credentials.ts';
import {
  createScreenStore,
  existingDaemonCommand,
  DaemonCommandError,
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
  run?: typeof runProcess;
  daemonCommand?: typeof existingDaemonCommand;
}): Computer & { canCheckpoint(): boolean } {
  const browsers = new Map<string, BrowserState>();
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
  const executable =
    options.executable ?? resolve(process.cwd(), 'node_modules/.bin/agent-browser');
  const run = options.run ?? runProcess;
  const requestDaemon = options.daemonCommand ?? existingDaemonCommand;
  const sandbox = options.sandbox !== false;
  const platform = options.platform ?? process.platform;
  const headed = options.headless === undefined ? platform === 'darwin' : !options.headless;
  const idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60_000;
  const maxLiveSessions = Math.max(1, Math.min(4, options.maxLiveSessions ?? 4));
  const proxy = createBrowserProxy();
  let disposed = false;
  let activeCalls = 0;
  let allocationQueue: Promise<void> = Promise.resolve();
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
  function stateFor(id: string): BrowserState {
    if (disposed) throw new Error('The browser service has stopped.');
    threadIdentity(id);
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
    state.lastUsed = Date.now();
    state.busy += 1;
    const execute = async () => {
      try {
        if (state.closed || state.closing)
          throw new Error('The browser session has expired. Open the URL again.');
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
      state.closing = true;
      try {
        await command(state, ['close']);
        state.started = false;
        state.closed = true;
        await saveState(state);
      } catch {
        state.closing = true;
        throw new Error('The browser could not stop safely. Close it before continuing.');
      }
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
      const request =
        args[0] === 'open'
          ? { action: 'navigate', url: args[1] }
          : args[0] === 'eval'
            ? { action: 'evaluate', script: options.input }
            : args[0] === 'get' && args[1] === 'url'
              ? { action: 'url' }
              : args[0] === 'get' && args[1] === 'attr'
                ? { action: 'getattribute', selector: args[2], attribute: args[3] }
                : args[0] === 'click'
                  ? { action: 'click', selector: args[1] }
                  : args[0] === 'fill'
                    ? { action: 'fill', selector: args[1], value: args[2] }
                    : args[0] === 'press'
                      ? { action: 'press', key: args[1] }
                      : args[0] === 'scroll'
                        ? {
                            action: 'scroll',
                            direction: args[1],
                            amount: Number(args[2]),
                            ...(args[4] ? { selector: args[4] } : {}),
                          }
                        : args[0] === 'screenshot'
                          ? {
                              action: 'screenshot',
                              path: args[1],
                              fullPage: false,
                              annotate: false,
                            }
                          : args[0] === 'download'
                            ? { action: 'download', selector: args[1], path: args[2] }
                            : args[0] === 'snapshot'
                              ? {
                                  action: 'snapshot',
                                  compact: true,
                                  ...(args[3] ? { selector: args[3] } : {}),
                                }
                              : args[0] === 'close'
                                ? { action: 'close' }
                                : args[0] === 'tab' && args[1] === 'list'
                                  ? { action: 'tab_list' }
                                  : args[0] === 'tab' && args[1] === 'switch'
                                    ? { action: 'tab_switch', tabId: args[2] }
                                    : null;
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
          '--json',
          '--proxy',
          proxyUrl,
          '--proxy-bypass',
          '<-loopback>',
          '--args',
          '--disable-quic,--force-webrtc-ip-handling-policy=disable_non_proxied_udp,--disable-background-networking' +
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
            AGENT_BROWSER_DEFAULT_TIMEOUT: '30000',
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

  async function currentUrl(state: BrowserState, signal?: AbortSignal): Promise<string> {
    const data = await command(state, ['get', 'url'], { signal });
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

  async function stayOnSavedOrigin(state: BrowserState, signal?: AbortSignal) {
    if (
      state.saved.allowedOrigin &&
      new URL(await currentUrl(state, signal)).origin !== state.saved.allowedOrigin
    )
      throw new BrowserActionError('browser_origin_changed');
  }

  async function observe(
    state: BrowserState,
    signal?: AbortSignal,
    input?: BrowserAction,
  ): Promise<BrowserObservation> {
    if (state.injecting) throw new BrowserLockedError();
    const url = await currentUrl(state, signal);
    if (url === 'about:blank')
      return {
        text: 'The page opened a new tab that has not loaded. Take a snapshot again.',
        url,
        candidates: [],
      };
    if (state.saved.allowedOrigin && new URL(url).origin !== state.saved.allowedOrigin)
      throw new BrowserActionError('browser_origin_changed');
    const scope =
      input?.action === 'snapshot' && input.selector ? selector(input.selector) : undefined;
    const offset = input?.action === 'snapshot' ? (input.offset ?? 0) : 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000)
      throw new Error('Choose a page offset of at most 100000 characters.');
    const snapshot = () =>
      command(state, scope ? ['snapshot', '-c', '-s', scope] : ['snapshot', '-c'], {
        signal,
        maxBytes: 1024 * 1024,
      });
    let data = await snapshot();
    for (let attempt = 0; attempt < 4 && !String(data.snapshot ?? '').trim(); attempt++) {
      await delay(750, undefined, { signal });
      data = await snapshot();
    }
    await stayOnSavedOrigin(state, signal);
    const page = redactBrowserText(String(data.snapshot ?? ''), state.secrets);
    const refs = Object.entries(
      (data.refs ?? {}) as Record<string, { role?: unknown; name?: unknown }>,
    );
    return {
      text: `Page (${offset}-${Math.min(offset + 16_000, page.length)} of ${page.length} characters):\n${page.slice(offset, offset + 16_000)}`,
      url: redactBrowserUrl(url, state.secrets, Boolean(state.saved.allowedOrigin)),
      candidates: refs
        .filter(([, ref]) =>
          ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option'].includes(
            String(ref?.role),
          ),
        )
        .slice(0, 100)
        .map(([id, ref]) => ({
          id: `@${id}`,
          label: redactBrowserText(
            `${String(ref.role)} "${String(ref.name ?? '')}"`,
            state.secrets,
          ).slice(0, 350),
        })),
    };
  }

  async function browserAction(
    id: string,
    input: BrowserAction,
    signal?: AbortSignal,
  ): Promise<BrowserObservation> {
    if (disposed) throw new Error('The browser service has stopped.');
    const savedProfile = input.action === 'open' ? await screens.load(id) : null;
    if (input.action === 'open' && !browsers.has(id)) await recoverBrowser(id, true);
    if (input.action === 'open' && browsers.get(id)?.recovered) await closeBrowser(id);
    if (input.action === 'open' && browsers.get(id)?.closed) await closeBrowser(id);
    if (input.action === 'open' && browsers.get(id)?.saved.navigationFailed) await closeBrowser(id);
    const state = stateFor(id);
    if (input.action === 'open' && savedProfile?.profileId && !state.saved.profileId) {
      state.saved.profileId = savedProfile.profileId;
      state.saved.allowedOrigin = savedProfile.allowedOrigin;
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
        if (state.saved.allowedOrigin && url.origin !== state.saved.allowedOrigin)
          throw new BrowserActionError('browser_origin_changed');
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
        try {
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
            candidates: [],
          };
        }
        if (!state.started) throw new Error('Open a website first.');
        markActivity(id);
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
            candidates: [],
          };
        }
        if (input.action === 'tab_switch') {
          const tabs = await browserTabs(state, signal);
          if (!tabs.some((tab) => tab.tabId === input.tabId))
            throw new Error('Choose a tab from the current browser list.');
          await command(state, ['tab', 'switch', input.tabId!], { signal });
        }
        if (input.action === 'click') {
          const target = selector(input.selector);
          const tabs = await browserTabs(state, signal);
          await command(state, ['click', target], { signal });
          await settleTabs(state, tabs, signal);
        }
        if (input.action === 'fill') {
          const target = selector(input.selector);
          const type = await command(state, ['get', 'attr', target, 'type'], { signal });
          const autocomplete = await command(state, ['get', 'attr', target, 'autocomplete'], {
            signal,
          });
          const loginField = await command(
            state,
            ['get', 'attr', target, 'data-otto-login-field'],
            { signal },
          );
          if (
            /password|one-time-code|username/i.test([type.value, autocomplete.value].join(' ')) ||
            /identifier|password|otp/.test(String(loginField.value ?? '')) ||
            state.protectedSelectors.has(target)
          )
            throw new Error('Use the secure credential request tool for this field.');
          const text = input.text ?? '';
          if (
            text.length > 8000 ||
            [...state.secrets].some((secret) => secret && text.includes(secret))
          )
            throw new Error('This field must use the secure credential flow.');
          await command(state, ['fill', target, text], { signal });
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
          if (
            !input.key ||
            !['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(
              input.key,
            )
          )
            throw new Error('Choose a supported browser key.');
          const tabs = await browserTabs(state, signal);
          await command(state, ['press', input.key], { signal });
          await settleTabs(state, tabs, signal);
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
        if (input.action === 'drag')
          await command(state, ['drag', selector(input.selector), selector(input.targetSelector)], {
            signal,
          });
        if (['back', 'forward', 'reload'].includes(input.action))
          await command(state, [input.action], { signal });
        if (input.action === 'evaluate') {
          const script = input.script ?? '';
          if (!script.trim() || script.length > 20_000)
            throw new Error('Provide a script of at most 20,000 characters.');
          const url = await currentUrl(state, signal);
          if (state.saved.allowedOrigin && new URL(url).origin !== state.saved.allowedOrigin)
            throw new BrowserActionError('browser_origin_changed');
          const result = redactBrowserText(
            JSON.stringify((await evaluate(state, script, signal)) ?? null) ?? 'null',
            state.secrets,
          );
          return {
            text: `Script result (JSON${result.length > 20_000 ? ', first 20,000 characters' : ''}):\n${result.slice(0, 20_000)}`,
            url: redactBrowserUrl(url, state.secrets, Boolean(state.saved.allowedOrigin)),
            candidates: [],
          };
        }
      }
      if (input.waitMs !== undefined) {
        if (!Number.isInteger(input.waitMs) || input.waitMs < 0 || input.waitMs > 15_000)
          throw new Error('Choose a wait of at most 15 seconds.');
        if (input.waitMs) await delay(input.waitMs, undefined, { signal });
      }
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
      if (state.saved.allowedOrigin && new URL(current).origin !== state.saved.allowedOrigin)
        throw new BrowserActionError('browser_origin_changed');
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
      if (state.saved.allowedOrigin && new URL(current).origin !== state.saved.allowedOrigin)
        throw new BrowserActionError('browser_origin_changed');
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
      if (state.saved.allowedOrigin && url && new URL(url).origin !== state.saved.allowedOrigin)
        throw new BrowserActionError('browser_origin_changed');
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
      if (state.saved.allowedOrigin && new URL(url).origin !== state.saved.allowedOrigin)
        throw new BrowserActionError('browser_origin_changed');
      return {
        origin: browserUrl(url).origin,
        url: redactBrowserUrl(url, state.secrets, Boolean(state.saved.allowedOrigin)),
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
    if (state.saved.allowedOrigin && new URL(url).origin !== state.saved.allowedOrigin)
      throw new BrowserActionError('browser_origin_changed');
    const path = resolve(runtimeRoot, `screen-${state.id}.capture.png`);
    await command(state, ['screenshot', path], { signal });
    await stayOnSavedOrigin(state, signal).catch(async (error: unknown) => {
      await rm(path, { force: true });
      throw error;
    });
    const buffer = await screens.accept(state.id, path);
    state.saved.capturedAt = new Date().toISOString();
    await saveState(state);
    screenStatuses.set(state.id, { state: 'live', capturedAt: state.saved.capturedAt });
    return buffer;
  }

  async function lastKnownScreen(id: string): Promise<Buffer | null> {
    const saved = await screens.load(id);
    if (saved?.navigationFailed) throw new BrowserActionError('browser_navigation_failed');
    if (saved?.allowedOrigin && saved.url && new URL(saved.url).origin !== saved.allowedOrigin)
      throw new BrowserActionError('browser_origin_changed');
    const buffer = saved?.capturedAt ? await screens.read(id) : null;
    screenStatuses.set(
      id,
      buffer ? { state: 'last_known', capturedAt: saved?.capturedAt } : { state: 'unavailable' },
    );
    return buffer;
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

  async function bindProfile(
    id: string,
    rawProfileId: string,
    rawAllowedOrigin?: string,
  ): Promise<void> {
    const profileId = z.uuid().parse(rawProfileId);
    const allowedOrigin = rawAllowedOrigin ? browserUrl(rawAllowedOrigin).origin : undefined;
    if (rawAllowedOrigin && allowedOrigin !== rawAllowedOrigin)
      throw new Error('An exact website origin is required.');
    threadIdentity(id);
    await allocate(async () => {
      const previous = browsers.get(id) ?? (await recoverBrowser(id, true));
      if (previous?.saved.profileId === profileId) {
        if (previous.saved.allowedOrigin !== allowedOrigin || !previous.saved.restoreSession) {
          previous.saved.allowedOrigin = allowedOrigin;
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
        allowedOrigin,
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
    screenStatus: (id) => screenStatuses.get(threadIdentity(id)) ?? { state: 'unavailable' },
    injectCredentials: tracked(injectCredentials),
    currentPage: tracked(currentPage),
    hold: tracked(hold),
    close: tracked(closeBrowser),
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
