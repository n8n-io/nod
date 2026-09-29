import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type {
  BrowserAction,
  BrowserDownloadInput,
  BrowserObservation,
  Computer,
  CredentialInput,
  CredentialSubmission,
  LoginInspection,
  ManualBrowserInput,
} from '../../ports/computer.ts';
import { BrowserActionError } from '../../ports/computer.ts';
import { taskId } from '../../ports/task-identity.ts';
import { runProcess, serviceEnvironment } from '../process.ts';
import { createBrowserProxy, browserUrl } from './network.ts';
import {
  credentialFeedback,
  credentialFeedbackScript,
  credentialFields,
  credentialScript,
} from './credentials.ts';
import { credentialSubmitScript, loginInspectionSchema, loginInspectionScript } from './login.ts';
import {
  manualInputSchema,
  protectFocusedField,
  maskPageScript,
  maskSnapshotInputValues,
} from './manual.ts';
import {
  createScreenStore,
  existingDaemonCommand,
  DaemonCommandError,
  type StoredScreen,
} from './screens.ts';
import { createBrowserSignIn, resolveSignInBrowser, type BrowserSignInHandle } from './sign-in.ts';
import { createSignInDesktop, type SignInDesktop } from './desktop.ts';
import { browserViewScript } from './view.ts';
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
  manualUntil: number;
  manualAbort?: AbortController;
  manualTimer?: ReturnType<typeof setTimeout>;
  secrets: Set<string>;
  nativeText?: { value: string; added: boolean };
  protectedSelectors: Set<string>;
  started: boolean;
  lastUsed: number;
  busy: number;
  closed: boolean;
  closing: boolean;
  heldUntil: number;
  socket?: string;
  recovered?: boolean;
  saved: StoredScreen;
  signInWindow?: BrowserSignInHandle;
  browserExecutable?: string;
  desktop?: SignInDesktop;
}
class BrowserLockedError extends Error {
  statusCode = 423;
  constructor() {
    super('Browser observations are paused during credential entry.');
  }
}
export function browserSessionId(id: string): string {
  return `sk-${createHash('sha256').update(taskId(id)).digest('hex').slice(0, 24)}`;
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

export function browserCandidates(snapshot: string): Array<{ id: string; label: string }> {
  const candidates: Array<{ id: string; label: string }> = [];
  for (const line of snapshot.split('\n')) {
    const match = line.match(/\[ref=(e\d+)\]/);
    if (
      match &&
      /\b(button|link|checkbox|radio|tab|menuitem|option)\b/.test(line) &&
      !/disabled/i.test(line)
    )
      candidates.push({ id: '@' + match[1], label: line.trim().slice(0, 350) });
  }
  return candidates.slice(0, 100);
}

export function createAgentBrowserComputer(options: {
  dataRoot: string;
  executable?: string;
  browserExecutable?: string;
  sandbox?: boolean;
  platform?: NodeJS.Platform;
  headless?: boolean;
  desktop?: (directory: string) => Promise<SignInDesktop>;
  idleTimeoutMs?: number;
  manualTimeoutMs?: number;
  maxLiveSessions?: number;
  run?: typeof runProcess;
  daemonCommand?: typeof existingDaemonCommand;
  signInLauncher?: ReturnType<typeof createBrowserSignIn>;
  resolveSignInBrowser?: typeof resolveSignInBrowser;
}): Computer & { canCheckpoint(): boolean } {
  const browsers = new Map<string, BrowserState>();
  let lastSession: { taskId: string; lastActivityAt: string } | undefined;
  const markActivity = (id: string) => {
    lastSession = { taskId: id, lastActivityAt: new Date().toISOString() };
  };
  const runtimeRoot = resolve(options.dataRoot, 'runtime');
  const profilePath = (state: BrowserState) =>
    resolve(runtimeRoot, 'profiles', state.saved.profileId ?? state.id);
  const screens = createScreenStore(runtimeRoot);
  const screenStatuses = new Map<string, ReturnType<NonNullable<Computer['screenStatus']>>>();
  const namespace = `sk-${createHash('sha256').update(runtimeRoot).digest('hex').slice(0, 12)}`;
  const executable =
    options.executable ?? resolve(process.cwd(), 'node_modules/.bin/agent-browser');
  const run = options.run ?? runProcess;
  const requestDaemon = options.daemonCommand ?? existingDaemonCommand;
  const sandbox = options.sandbox !== false;
  const platform = options.platform ?? process.platform;
  const headed = options.headless === undefined ? platform === 'darwin' : !options.headless;
  const privateDisplay = headed && platform === 'linux';
  const createDesktop = options.desktop ?? createSignInDesktop();
  const idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60_000;
  const manualTimeoutMs = Math.min(options.manualTimeoutMs ?? 30 * 60_000, 30 * 60_000);
  const maxLiveSessions = Math.max(1, Math.min(4, options.maxLiveSessions ?? 4));
  const proxy = createBrowserProxy();
  const signInLauncher =
    options.signInLauncher ?? createBrowserSignIn({ sandbox: options.sandbox });
  const signInBrowser = options.browserExecutable
    ? async () => options.browserExecutable!
    : (options.resolveSignInBrowser ?? resolveSignInBrowser);
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
    taskId(id);
    let state = browsers.get(id);
    if (!state) {
      state = {
        id,
        queue: Promise.resolve(),
        injecting: false,
        manualUntil: 0,
        secrets: new Set(),
        protectedSelectors: new Set(),
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
      if (state.started || state.saved.navigationFailed || state.saved.signInPending) return;
      const occupied = () =>
        [...browsers.values()].filter(
          (entry) => entry.started || entry.saved.navigationFailed || entry.saved.signInPending,
        );
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
              !entry.manualUntil &&
              !entry.saved.signInPending &&
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
      if (!state.saved.signInPending) state.closing = true;
      try {
        await command(state, ['close']);
        state.started = false;
        state.closed = !state.saved.signInPending;
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
    if (state.socket) {
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
      if (args[0] === 'close') await closeDisplay(state);
      return result;
    }
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const config = resolve(runtimeRoot, 'browser-config.json');
    await writeFile(config, '{}', { mode: 0o600 });
    const proxyUrl = await proxy.url();
    const profile = profilePath(state);
    if (args[0] === 'open' && privateDisplay && !state.desktop) {
      try {
        state.desktop = await createDesktop(runtimeRoot);
      } catch {
        state.started = false;
        state.closed = !state.saved.signInPending;
        await saveState(state);
        throw new Error('The workspace browser display could not start. Try again.');
      }
    }
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
            ...state.desktop?.environment,
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
      await drainInterruptedCommand(state, 'connect', () => manualSocket(state, options.signal));
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
    if (result.exitCode || response.success === false)
      throw new Error('Browser action could not complete. Observe the page again before retrying.');
    if (args[0] === 'close') await closeDisplay(state);
    return response.data ?? {};
  }

  async function closeDisplay(state: BrowserState): Promise<void> {
    await state.desktop?.close();
    state.desktop = undefined;
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
    taskId(id);
    const existing = browsers.get(id);
    if (existing) return existing;
    if (disposed) return undefined;
    const saved = await screens.load(id);
    if (saved?.signInPending) {
      const state = stateFor(id);
      state.saved = saved;
      return state;
    }
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

  async function manualSocket(state: BrowserState, signal?: AbortSignal): Promise<string> {
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

  function stopManual(state: BrowserState) {
    state.nativeText = undefined;
    state.manualUntil = 0;
    state.manualAbort?.abort();
    state.manualAbort = undefined;
    clearTimeout(state.manualTimer);
    state.manualTimer = undefined;
  }

  async function takeControl(id: string): Promise<void> {
    const state = await recoverBrowser(id);
    if (state?.saved.signInPending) throw new BrowserLockedError();
    if (!state?.started || state.injecting)
      throw new Error('Open a live browser session before taking control.');
    stopManual(state);
    const controller = new AbortController();
    state.manualAbort = controller;
    state.manualUntil = Date.now() + manualTimeoutMs;
    state.manualTimer = setTimeout(() => controller.abort(), manualTimeoutMs);
    state.manualTimer.unref();
    try {
      await serialize(state, async () => {
        controller.signal.throwIfAborted();
        if (state.injecting) throw new BrowserLockedError();
        await currentUrl(state, controller.signal);
        await manualSocket(state, controller.signal);
        controller.signal.throwIfAborted();
        state.heldUntil = state.manualUntil;
        markActivity(id);
      });
    } catch {
      if (state.manualAbort === controller) stopManual(state);
      throw new Error('The browser session is no longer available for control.');
    }
  }

  async function manualControl(id: string, raw: ManualBrowserInput): Promise<void> {
    const input = manualInputSchema.parse(raw);
    const state = browsers.get(taskId(id));
    if (!state?.started) throw new Error('The browser session is no longer available.');
    const controller = state.manualAbort;
    const check = () => {
      if (
        !controller ||
        controller !== state.manualAbort ||
        controller.signal.aborted ||
        state.manualUntil <= Date.now() ||
        state.injecting ||
        state.closed ||
        state.closing
      )
        throw new Error('Take control before interacting with this browser.');
    };
    check();
    await serialize(state, async () => {
      check();
      markActivity(id);
      const signal = controller!.signal;
      await currentUrl(state, signal);
      const socket = await manualSocket(state, signal);
      const send = (command: Record<string, unknown>) => {
        if (
          !controller ||
          controller !== state.manualAbort ||
          signal.aborted ||
          state.manualUntil <= Date.now() ||
          state.closed ||
          state.closing
        )
          throw new Error('Take control before interacting with this browser.');
        return requestDaemon(socket, command, signal);
      };
      if (input.action === 'click') {
        const viewport = (await evaluate(
          state,
          '({width:innerWidth,height:innerHeight})',
          signal,
        )) as { width: number; height: number };
        if (
          !Number.isFinite(viewport?.width) ||
          !Number.isFinite(viewport?.height) ||
          viewport.width < 1 ||
          viewport.height < 1
        )
          throw new Error('The browser viewport is unavailable.');
        await send({
          action: 'mousemove',
          x: Math.min(viewport.width - 1, Math.floor(input.x * viewport.width)),
          y: Math.min(viewport.height - 1, Math.floor(input.y * viewport.height)),
        });
        await send({ action: 'mousedown', button: 'left' });
        await send({ action: 'mouseup', button: 'left' });
      } else if (input.action === 'type') {
        const field = await evaluate(state, protectFocusedField, signal);
        if (field === 'unsupported_frame')
          throw new Error('Use Take control to type in this embedded field.');
        if (field !== true) throw new Error('Click a text field in the browser first.');
        state.secrets.add(input.text);
        state.protectedSelectors.add('[data-otto-manual-field="true"]');
        await saveState(state);
        state.injecting = true;
        try {
          await maskFields(state, signal);
          await send({ action: 'keyboard', subaction: 'insertText', text: input.text });
          await maskFields(state, signal);
        } finally {
          state.injecting = false;
        }
      } else if (input.action === 'press') {
        await send({ action: 'press', key: [...(input.modifiers ?? []), input.key].join('+') });
      } else if (input.action === 'wheel') {
        await send({ action: 'wheel', deltaX: input.deltaX, deltaY: input.deltaY });
      } else {
        await send({ action: 'wheel', deltaX: 0, deltaY: input.direction === 'up' ? -500 : 500 });
      }
    });
  }

  async function releaseControl(id: string): Promise<void> {
    const state = browsers.get(taskId(id));
    if (!state) return;
    stopManual(state);
    await serialize(state, async () => {
      await state.signInWindow?.close({ force: true });
      state.signInWindow = undefined;
      state.heldUntil = 0;
    });
  }

  async function openSignIn(id: string): Promise<void> {
    let state = await recoverBrowser(id, true);
    if (!state) {
      state = stateFor(id);
      state.saved = (await screens.load(id)) ?? state.saved;
    }
    if (state.injecting) throw new BrowserLockedError();
    stopManual(state);
    const controller = new AbortController();
    state.manualAbort = controller;
    state.manualUntil = Date.now() + manualTimeoutMs;
    try {
      await serialize(state, async () => {
        controller.signal.throwIfAborted();
        if (state.injecting) throw new BrowserLockedError();
        const path = profilePath(state);
        const executablePath = await signInBrowser(path);
        if (state.closing || disposed) throw new BrowserLockedError();
        if (state.started) await currentUrl(state);
        const destination = state.saved.resumeUrl || state.saved.url;
        const url = destination ? browserUrl(destination).href : 'about:blank';
        const wasStarted = state.started;
        await reserveBrowser(state);
        state.saved.signInPending = true;
        state.started = wasStarted;
        await state.signInWindow?.close();
        state.signInWindow = undefined;
        state.saved.signInPending = true;
        state.saved.restoreSession = true;
        state.saved.sensitive = true;
        await saveState(state);
        if (state.started) {
          await command(state, ['close']);
          state.started = false;
          state.socket = undefined;
          await saveState(state);
        }
        state.browserExecutable = executablePath;
        if (state.closing || disposed) throw new BrowserLockedError();
        state.signInWindow = await signInLauncher.start({
          profilePath: path,
          proxyUrl: await proxy.url(),
          url,
          executablePath,
        });
        if (state.closing || disposed || controller.signal.aborted) {
          await state.signInWindow.close({ force: true });
          state.signInWindow = undefined;
          throw new BrowserLockedError();
        }
        state.heldUntil = state.manualUntil;
        state.manualTimer = setTimeout(() => {
          if (state.manualAbort !== controller) return;
          void releaseControl(id)
            .then(async () => {
              if (!state.saved.url && !state.manualAbort) await closeBrowser(id);
            })
            .catch(() => {});
        }, manualTimeoutMs);
        state.manualTimer.unref();
        if (state.saved.url) markActivity(id);
      });
    } catch {
      stopManual(state);
      throw new Error(
        'The sign-in window could not open. Close any previous sign-in window and try again.',
      );
    }
  }

  async function withSignIn<T>(
    id: string,
    operation: (
      window: BrowserSignInHandle,
      signal: AbortSignal,
      state: BrowserState,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const state = browsers.get(taskId(id));
    const controller = state?.manualAbort;
    const window = state?.signInWindow;
    const check = () => {
      signal?.throwIfAborted();
      if (
        !state ||
        !controller ||
        !window ||
        controller !== state.manualAbort ||
        window !== state.signInWindow ||
        controller.signal.aborted ||
        window.closed ||
        state.closed ||
        state.closing ||
        !state.saved.signInPending ||
        state.manualUntil <= Date.now()
      )
        throw new Error('The sign-in session is no longer active.');
    };
    check();
    return serialize(state!, async () => {
      check();
      const combined = signal ? AbortSignal.any([signal, controller!.signal]) : controller!.signal;
      const result = await operation(window!, combined, state!);
      check();
      return result;
    });
  }

  function signInScreenshot(id: string, signal?: AbortSignal): Promise<Buffer> {
    return withSignIn(
      id,
      (window, combined) => {
        if (!window.screenshot) throw new Error('The sign-in screen is unavailable.');
        return window.screenshot(combined);
      },
      signal,
    );
  }

  async function signInControl(id: string, raw: ManualBrowserInput): Promise<void> {
    const input = manualInputSchema.parse(raw);
    await withSignIn(id, async (window, signal, state) => {
      if (!window.control) throw new Error('Sign-in control is unavailable.');
      const previous = state.nativeText;
      if (input.action === 'type') {
        const continuing = previous && previous.value.length + input.text.length <= 8192;
        const value = continuing ? previous.value + input.text : input.text;
        if (continuing && previous.added) state.secrets.delete(previous.value);
        state.nativeText = { value, added: !state.secrets.has(value) };
        state.secrets.add(value);
      } else state.nativeText = undefined;
      if (state.saved.url) markActivity(id);
      try {
        await window.control(input, signal);
      } catch (error) {
        if (previous) state.secrets.add(previous.value);
        if (input.action === 'type') state.secrets.add(input.text);
        state.nativeText = undefined;
        throw error;
      }
    });
  }

  async function finishSignIn(id: string): Promise<void> {
    const state = await recoverBrowser(id, true);
    if (!state?.saved.signInPending) return;
    await serialize(state, async () => {
      await state.signInWindow?.close();
      state.signInWindow = undefined;
      const destination = state.saved.resumeUrl || state.saved.url;
      const url = destination ? browserUrl(destination).href : 'about:blank';
      state.browserExecutable ??= await signInBrowser(profilePath(state));
      state.saved.restoreSession = true;
      if (state.closing || disposed) throw new BrowserLockedError();
      try {
        if (state.started) {
          await command(state, ['close']);
          state.started = false;
          state.socket = undefined;
        }
        await command(state, ['open', url]);
        state.started = true;
        if (state.closing || disposed) throw new BrowserLockedError();
        state.saved.navigationFailed = false;
        state.saved.signInPending = false;
        stopManual(state);
        state.heldUntil = 0;
        await saveState(state);
        markActivity(id);
      } catch {
        throw new Error('The workspace browser could not resume. Try Resume agent again.');
      }
    });
  }

  async function maskFields(state: BrowserState, signal?: AbortSignal): Promise<string[]> {
    const result = await evaluate(
      state,
      maskPageScript([...state.protectedSelectors], [...state.secrets]),
      signal,
    );
    if (
      result &&
      typeof result === 'object' &&
      'values' in result &&
      Array.isArray(result.values)
    ) {
      for (const value of result.values) {
        if (typeof value !== 'string' || value.length > 8192)
          throw new Error('This protected field cannot be observed.');
        if (value) state.secrets.add(value);
      }
    }
    const inputValues =
      result && typeof result === 'object' && 'inputValues' in result ? result.inputValues : [];
    if (
      !Array.isArray(inputValues) ||
      inputValues.length > 40 ||
      inputValues.some((value) => typeof value !== 'string' || value.length > 8192)
    )
      throw new Error('These protected fields cannot be observed.');
    await saveState(state);
    return inputValues;
  }

  async function observe(
    state: BrowserState,
    signal?: AbortSignal,
    input?: BrowserAction,
  ): Promise<BrowserObservation> {
    if (state.injecting || state.manualUntil || state.saved.signInPending)
      throw new BrowserLockedError();
    const url = await currentUrl(state, signal);
    if (url === 'about:blank')
      return {
        text: 'The page opened a new tab that has not loaded. Take a snapshot again.',
        url,
        candidates: [],
      };
    if (state.saved.allowedOrigin && new URL(url).origin !== state.saved.allowedOrigin)
      throw new BrowserActionError('browser_origin_changed');
    let inputValues = await maskFields(state, signal);
    const scope =
      input?.action === 'snapshot' && input.selector ? selector(input.selector) : undefined;
    const offset = input?.action === 'snapshot' ? (input.offset ?? 0) : 0;
    const controlOffset = input?.action === 'snapshot' ? (input.controlOffset ?? 0) : 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000)
      throw new Error('Choose a page offset of at most 100000 characters.');
    if (!Number.isInteger(controlOffset) || controlOffset < 0 || controlOffset > 100_000)
      throw new Error('Choose a control offset of at most 100000.');
    let visible = (await evaluate(
      state,
      browserViewScript(scope, offset, controlOffset),
      signal,
    )) as {
      missing?: boolean;
      text?: string;
      total?: number;
      controls?: Array<{ selector: string; label: string }>;
      controlsTotal?: number;
      scrollAreas?: Array<{ selector: string; height: number; viewport: number }>;
      scrollAreasTotal?: number;
    };
    for (
      let attempt = 0;
      attempt < 4 && !visible?.missing && !String(visible?.text ?? '').trim();
      attempt++
    ) {
      await delay(750, undefined, { signal });
      inputValues = await maskFields(state, signal);
      visible = (await evaluate(
        state,
        browserViewScript(scope, offset, controlOffset),
        signal,
      )) as typeof visible;
    }
    if (visible?.missing)
      return {
        text: 'The selected page area is no longer available. Take a full snapshot.',
        url: redactBrowserUrl(url, state.secrets, Boolean(state.saved.allowedOrigin)),
        candidates: [],
      };
    const data = await command(
      state,
      scope ? ['snapshot', '-c', '-s', scope] : ['snapshot', '-c'],
      { signal, maxBytes: 1024 * 1024 },
    );
    const fullStructure = maskSnapshotInputValues(
      redactBrowserText(String(data.snapshot ?? data.text ?? JSON.stringify(data)), state.secrets),
      inputValues,
    );
    const structure = fullStructure.slice(offset, offset + 16_000);
    const body = redactBrowserText(String(visible?.text ?? ''), state.secrets);
    const controls = (visible?.controls ?? [])
      .filter((item) => typeof item.selector === 'string' && typeof item.label === 'string')
      .slice(0, 80)
      .map((item) => ({ id: item.selector, label: redactBrowserText(item.label, state.secrets) }));
    const scrollAreas = (visible?.scrollAreas ?? [])
      .filter((item) => typeof item.selector === 'string')
      .slice(0, 20)
      .map((item) => `${item.selector} (${item.viewport} of ${item.height} pixels)`);
    const text = `Page text (${offset}-${Math.min(offset + 16_000, visible?.total ?? 0)} of ${visible?.total ?? 0} characters):\n${body}\n\nPage structure (${offset}-${Math.min(offset + 16_000, fullStructure.length)} of ${fullStructure.length} characters):\n${structure}\n\nControls (${controlOffset}-${Math.min(controlOffset + 80, visible?.controlsTotal ?? 0)} of ${visible?.controlsTotal ?? 0}):\n${controls.map((item) => `${item.label}: ${item.id}`).join('\n') || 'None'}\n\nScrollable areas (${controlOffset}-${Math.min(controlOffset + 20, visible?.scrollAreasTotal ?? 0)} of ${visible?.scrollAreasTotal ?? 0}):\n${scrollAreas.join('\n') || 'None'}`;
    return {
      text,
      url: redactBrowserUrl(url, state.secrets, Boolean(state.saved.allowedOrigin)),
      candidates: [...browserCandidates(structure), ...controls].slice(0, 100),
    };
  }

  async function browserAction(
    id: string,
    input: BrowserAction,
    signal?: AbortSignal,
  ): Promise<BrowserObservation> {
    if (disposed) throw new Error('The browser service has stopped.');
    const savedProfile = input.action === 'open' ? await screens.load(id) : null;
    if ((await recoverBrowser(id))?.saved.signInPending) throw new BrowserLockedError();
    if (browsers.get(id)?.manualUntil) throw new BrowserLockedError();
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
    if (state.injecting || state.manualUntil || state.saved.signInPending)
      throw new BrowserLockedError();
    return serialize(state, async () => {
      if (state.injecting || state.manualUntil || state.saved.signInPending)
        throw new BrowserLockedError();
      signal?.throwIfAborted();
      if (input.action === 'open') {
        const url = browserUrl(input.url ?? '');
        if (state.saved.allowedOrigin && url.origin !== state.saved.allowedOrigin)
          throw new BrowserActionError('browser_origin_changed');
        const previous = state.saved.restoreSession ? state.saved : await screens.load(id);
        if (previous?.restoreSession) {
          state.saved.restoreSession = true;
          state.saved.sensitive = true;
          state.browserExecutable ??= await signInBrowser(profilePath(state));
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
                const pageText = observation.text
                  .split('\n\nPage structure (', 1)[0]
                  .replace(/^Page text [^\n]*\n/, '')
                  .trim();
                if (pageText) {
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
          const manualField = await command(
            state,
            ['get', 'attr', target, 'data-otto-manual-field'],
            { signal },
          );
          if (
            /password|one-time-code|username/i.test([type.value, autocomplete.value].join(' ')) ||
            /identifier|password|otp/.test(String(loginField.value ?? '')) ||
            manualField.value === 'true' ||
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
      }
      if (input.waitMs !== undefined) {
        if (!Number.isInteger(input.waitMs) || input.waitMs < 0 || input.waitMs > 15_000)
          throw new Error('Choose a wait of at most 15 seconds.');
        if (input.waitMs) await delay(input.waitMs, undefined, { signal });
      }
      return observe(state, signal, input);
    });
  }

  async function download(id: string, input: BrowserDownloadInput, signal?: AbortSignal) {
    if (input.selector && input.url) throw new Error('Choose a download link or URL.');
    if (input.name !== undefined) downloadName(input.name);
    const state = await recoverBrowser(id);
    if (!state?.started) throw new Error('Open the file website first.');
    if (state.injecting || state.manualUntil || state.saved.signInPending)
      throw new BrowserLockedError();
    return serialize(state, async () => {
      if (state.injecting || state.manualUntil || state.saved.signInPending)
        throw new BrowserLockedError();
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
    const state = browsers.get(taskId(input.taskId));
    if (state?.saved.signInPending) throw new BrowserLockedError();
    if (!state?.started) throw new Error('The browser session has expired. Reopen the login page.');
    if (state.injecting || state.manualUntil) throw new BrowserLockedError();
    const url = browserUrl(input.origin);
    if (url.origin !== input.origin) throw new Error('An exact login origin is required.');
    const fields = credentialFields(input);
    for (const field of fields) {
      state.secrets.add(field.value);
      state.protectedSelectors.add(field.selector);
    }
    state.injecting = true;
    markActivity(input.taskId);
    try {
      return await serialize(state, async () => {
        if (state.manualUntil || state.saved.signInPending) throw new BrowserLockedError();
        try {
          await saveState(state);
          if (new URL(await currentUrl(state)).origin !== input.origin)
            throw new Error('The login page origin changed. Request credentials again.');
          const attempt = randomUUID();
          const before = input.submitSelector
            ? credentialFeedback(
                await evaluate(
                  state,
                  credentialFeedbackScript(input.origin, input.kind ?? 'password', attempt, true),
                ),
              )
            : undefined;
          const result = await evaluate(
            state,
            credentialScript(input.origin, fields, input.submitSelector),
          );
          if (!(result && typeof result === 'object' && 'ok' in result && result.ok))
            throw new Error('The login fields changed. Request credentials again.');
          if ('submitPending' in result && result.submitPending && input.submitSelector) {
            const submitted = await evaluate(
              state,
              credentialSubmitScript(input.origin, input.submitSelector),
            );
            if (!(submitted && typeof submitted === 'object' && 'ok' in submitted && submitted.ok))
              throw new Error('The login form could not advance.');
          }
          if (input.submitSelector && before) {
            const signal = AbortSignal.timeout(2000);
            while (!signal.aborted) {
              const feedback = credentialFeedback(
                await evaluate(
                  state,
                  credentialFeedbackScript(input.origin, input.kind ?? 'password', attempt),
                  signal,
                ).catch((error: unknown) => {
                  if (!state.started || state.closed || state.closing) throw error;
                  return undefined;
                }),
              );
              if (!state.started || state.closed || state.closing)
                throw new Error('The browser session is unavailable.');
              if (feedback?.advanced) break;
              if (
                feedback?.rejected &&
                (!feedback.sameDocument || feedback.fingerprint !== before.fingerprint)
              )
                return { status: 'rejected' as const };
              await delay(80, undefined, { signal }).catch(() => {});
            }
          }
          if (!state.started || state.closed || state.closing)
            throw new Error('The browser session is unavailable.');
          return { status: 'submitted' as const };
        } catch {
          if (state.started && !state.closed && !state.closing)
            await evaluate(
              state,
              `(() => { if(location.origin!==${JSON.stringify(input.origin)}) return false; for(const s of ${JSON.stringify(fields.map((field) => field.selector))}) { for(const e of document.querySelectorAll(s)) { e.value=''; e.dispatchEvent(new Event('input',{bubbles:true})); } } return true; })()`,
            ).catch(() => {});
          throw new Error(
            'Secure entry could not be confirmed. Check the login page before continuing.',
          );
        }
      });
    } finally {
      state.injecting = false;
    }
  }

  async function inspectPage(state: BrowserState): Promise<LoginInspection> {
    const url = await currentUrl(state);
    if (state.saved.allowedOrigin && new URL(url).origin !== state.saved.allowedOrigin)
      throw new BrowserActionError('browser_origin_changed');
    await maskFields(state);
    const inspection = loginInspectionSchema.parse(await evaluate(state, loginInspectionScript()));
    if (inspection.origin !== new URL(url).origin)
      throw new Error('The login page changed. Inspect it again.');
    browserUrl(inspection.url);
    return {
      ...inspection,
      url: redactBrowserUrl(inspection.url, state.secrets, Boolean(state.saved.allowedOrigin)),
    };
  }

  async function inspectLogin(id: string): Promise<LoginInspection> {
    const state = await recoverBrowser(id);
    if (state?.saved.signInPending) throw new BrowserLockedError();
    if (state?.saved.navigationFailed || (!state && (await screens.load(id))?.navigationFailed))
      throw new BrowserActionError('browser_navigation_failed');
    if (!state?.started) throw new Error('Open the login page in this task browser first.');
    if (state.injecting || state.manualUntil) throw new BrowserLockedError();
    return serialize(state, () => {
      if (state.injecting || state.manualUntil || state.saved.signInPending)
        throw new BrowserLockedError();
      return inspectPage(state);
    });
  }

  async function selectLoginMethod(id: string, origin: string, methodId: string): Promise<void> {
    const state = browsers.get(taskId(id));
    if (state?.saved.signInPending) throw new BrowserLockedError();
    if (!state?.started) throw new Error('Open the login page in this task browser first.');
    if (state.injecting || state.manualUntil) throw new BrowserLockedError();
    await serialize(state, async () => {
      if (state.injecting || state.manualUntil || state.saved.signInPending)
        throw new BrowserLockedError();
      const current = await inspectPage(state);
      const method = current.methods.find((item) => item.id === methodId);
      if (
        current.origin !== origin ||
        !method?.supported ||
        !(['oauth', 'credentials'].includes(method.kind) && method.id !== 'credentials') ||
        !method.selector
      )
        throw new Error('This sign-in method is no longer available on the current page.');
      const result = await evaluate(state, credentialSubmitScript(origin, method.selector));
      if (!(result && typeof result === 'object' && 'ok' in result && result.ok))
        throw new Error('The sign-in method could not be opened.');
    });
  }

  async function hold(id: string, until: number | null): Promise<void> {
    const state = browsers.get(taskId(id));
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
    if (state.saved.signInPending) throw new BrowserLockedError();
    if (state.saved.navigationFailed) throw new BrowserActionError('browser_navigation_failed');
    if (state.recovered && state.saved.sensitive && !state.secrets.size)
      throw new Error('Reopen the login page before continuing this browser session.');
    const url = await currentUrl(state, signal);
    if (state.saved.allowedOrigin && new URL(url).origin !== state.saved.allowedOrigin)
      throw new BrowserActionError('browser_origin_changed');
    await maskFields(state, signal);
    const path = resolve(runtimeRoot, `screen-${state.id}.capture.png`);
    await command(state, ['screenshot', path], { signal });
    const buffer = await screens.accept(state.id, path);
    state.saved.capturedAt = new Date().toISOString();
    await saveState(state);
    screenStatuses.set(state.id, { state: 'live', capturedAt: state.saved.capturedAt });
    return buffer;
  }

  async function lastKnownScreen(id: string): Promise<Buffer | null> {
    const saved = await screens.load(id);
    if (saved?.signInPending) throw new BrowserLockedError();
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
    if (state?.saved.signInPending) throw new BrowserLockedError();
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
    const state = browsers.get(taskId(id)) ?? (await recoverBrowser(id, true));
    if (!state) return;
    if (idleAt === undefined) {
      state.closing = true;
      stopManual(state);
    }
    const close = async () => {
      if (browsers.get(id) !== state) return;
      if (
        idleAt !== undefined &&
        (state.lastUsed !== idleAt ||
          state.busy ||
          state.injecting ||
          state.manualUntil > Date.now() ||
          state.heldUntil > Date.now())
      )
        return;
      state.closing = true;
      stopManual(state);
      await state.signInWindow?.close({ force: true });
      state.signInWindow = undefined;
      if (state.started && !state.closed && !state.injecting)
        await captureScreen(state).catch(() => {});
      state.closed = true;
      if (state.started || state.saved.navigationFailed) await command(state, ['close']);
      await closeDisplay(state);
      state.started = false;
      if (!state.saved.url) state.saved.signInPending = false;
      await saveState(state);
      state.secrets.clear();
      state.protectedSelectors.clear();
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
    taskId(id);
    await allocate(async () => {
      const previous = browsers.get(id) ?? (await recoverBrowser(id, true));
      if (previous?.saved.profileId === profileId) {
        if (previous.saved.allowedOrigin !== allowedOrigin) {
          previous.saved.allowedOrigin = allowedOrigin;
          previous.saved.capturedAt = undefined;
          await screens.clearImage(id);
          await saveState(previous);
        }
        return;
      }
      if (previous?.injecting || previous?.manualUntil || previous?.saved.signInPending)
        throw new BrowserLockedError();
      if (previous) await closeBrowser(id);
      const relatedIds = await screens.profileScreens(profileId);
      const restoreSession = (
        await Promise.all(relatedIds.map((relatedId) => screens.load(relatedId)))
      ).some((saved) => saved?.restoreSession);
      for (const otherId of relatedIds) {
        if (otherId === id) continue;
        const other = browsers.get(otherId) ?? (await recoverBrowser(otherId, true));
        if (!other) continue;
        if (other.busy || other.injecting || other.manualUntil || other.heldUntil > Date.now())
          throw new BrowserLockedError();
        await closeBrowser(otherId);
      }
      const state = stateFor(id);
      state.saved = {
        version: 1,
        url: '',
        sensitive: restoreSession,
        active: false,
        profileId,
        allowedOrigin,
        restoreSession,
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
        if (
          state &&
          (state.busy || state.injecting || state.manualUntil || state.heldUntil > Date.now())
        )
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
      (state) => state.started || state.saved.navigationFailed || state.saved.signInPending,
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
          (state) =>
            !state.busy &&
            !state.closing &&
            !state.injecting &&
            state.heldUntil <= now &&
            state.manualUntil <= now &&
            (!state.signInWindow || state.signInWindow.closed),
        )
      );
    },
    currentSession: () => {
      const manual = [...browsers.values()].find(
        (state) => state.saved.url && state.manualUntil > Date.now(),
      );
      return manual
        ? { taskId: manual.id, lastActivityAt: new Date(manual.lastUsed).toISOString() }
        : lastSession;
    },
    bindProfile: tracked(bindProfile),
    deleteProfile: tracked(deleteProfile),
    takeControl: tracked(takeControl),
    openSignIn: tracked(openSignIn),
    finishSignIn: tracked(finishSignIn),
    signInScreenshot: tracked(signInScreenshot),
    signInControl: tracked(signInControl),
    control: tracked(manualControl),
    releaseControl: tracked(releaseControl),
    act: tracked(browserAction),
    download: tracked(download),
    screenshot: tracked(getScreenshot),
    screenStatus: (id) => screenStatuses.get(taskId(id)) ?? { state: 'unavailable' },
    injectCredentials: tracked(injectCredentials),
    inspectLogin: tracked(inspectLogin),
    selectLoginMethod: tracked(selectLoginMethod),
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
