import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  constants,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rm,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const answerMs = 30_000;
const ref = /^@[a-z0-9]{6,32}:e\d{1,7}$/;
const windowId = /^[A-Za-z0-9:._-]{1,200}$/;
const appName = /^[^\0\r\n]{1,200}$/;
const keys = /^[a-z0-9+.,\-=/ ]{1,40}$/i;
const focusRefusal =
  /focus fallback is denied|no verified focused element|focus could not be confirmed|physical input is disabled|requires --headed|requires focus permission/i;
const unready = (error) =>
  error.kind === 'deadline' ||
  /has not published its accessibility tree|tree is still thin/i.test(error.message);
const needsFocus = (error) =>
  focusRefusal.test(error.message) ||
  (error.delivery === 'not_delivered' &&
    (error.kind === 'actionability_timeout' || unready(error)));
const activation = ['focused', 'hovered', 'disabled'];
const pasteRoles = new Set(['scrollarea', 'webarea', 'group', 'document']);
const appSteps = new Set([
  'open',
  'snapshot',
  'inspect',
  'find',
  'screenshot',
  'press',
  'focus',
  'select',
  'set_value',
  'type',
  'key',
]);
const chromiumFrameworks =
  /Electron Framework|Chromium|Chrome Framework|Edge Framework|Brave Browser Framework/i;
const passedEnvironment = [
  'HOME',
  'PATH',
  'LANG',
  'DBUS_SESSION_BUS_ADDRESS',
  'AT_SPI_BUS_ADDRESS',
  'DISPLAY',
  'XAUTHORITY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'XDG_DATA_HOME',
  'XDG_DATA_DIRS',
  'XDG_SESSION_TYPE',
  'XDG_CURRENT_DESKTOP',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'USERPROFILE',
  'TEMP',
  'TMP',
  'LOCALAPPDATA',
  'APPDATA',
  'PATHEXT',
  'ComSpec',
];
const desktopId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
const programName = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,99}$/;
const refusedCategories = /(^|;)(Settings|System|FileManager|Security)(;|$)/;

const isFocused = (node) =>
  node.states?.includes('focused') && !['window', 'dialog'].includes(node.role);

function focusClaims(tree) {
  const claims = new Map();
  const visit = (node, list) => {
    const own = listRoles.has(node.role) ? node : list;
    const claim = own ?? node;
    if (isFocused(node)) claims.set(claim, claims.has(claim) ? claim : node);
    node.children?.forEach((child) => visit(child, own));
  };
  visit(tree);
  return claims;
}

function secure(node) {
  return node.states?.includes('secure') || /secure|password/i.test(node.role ?? '');
}

function secureFocus(node) {
  return Boolean(
    node &&
    ((secure(node) && node.states?.includes('focused')) || node.children?.some(secureFocus)),
  );
}

const listRoles = new Set([
  'list',
  'listbox',
  'table',
  'outline',
  'grid',
  'tree',
  'treegrid',
  'menu',
]);
const listLimit = 20;
const contextChars = 12_000;
const deadline = ['--timeout-ms', '25000'];

const emptyGroup = (node) =>
  node.role === 'group' &&
  !node.name &&
  node.value == null &&
  !node.states?.length &&
  !node.children?.length &&
  !Object.keys(node).some((key) =>
    ['description', 'hint', 'placeholder', 'native_id', 'secure'].includes(key),
  );

function inspectResult(data, menu = false, target) {
  if (data.complete !== true || !data.tree || data.truncated || data.identity_unproven)
    throw new Error(
      'POLICY_DENIED: Nod could not read the complete window, so this step did not run.',
    );
  const isTarget = (node) =>
    Boolean(target) && node.role === target.role && (node.name ?? '') === target.name;
  const relevance = new WeakMap();
  const relevant = (node) => {
    if (!relevance.has(node))
      relevance.set(
        node,
        Boolean(
          node.states?.includes('selected') ||
          isTarget(node) ||
          holders.has(node) ||
          node.children?.some(relevant),
        ),
      );
    return relevance.get(node);
  };
  let trimmed = false;
  let found = 0;
  let targetNode;
  let focusNode;
  const selected = [];
  const focused = [];
  const focus = (node, path = []) => {
    if (holders.has(node))
      focused.push({ path, role: node.role ?? '', name: secure(node) ? '' : (node.name ?? '') });
    if (secure(node)) return;
    node.children?.forEach((child, index) => focus(child, [...path, index]));
  };
  const walk = (node, inFocus = false) => {
    if (node.subtree_truncated || (node.children_count ?? 0) > (node.children?.length ?? 0))
      throw new Error('POLICY_DENIED: Part of the window is missing, so this step did not run.');
    if (secure(node)) return { role: node.role ?? '', secure: true };
    if (isTarget(node)) found++;
    const all = node.children ?? [];
    const kept = listRoles.has(node.role) && all.length > listLimit ? all.filter(relevant) : all;
    const more = kept.length < all.length;
    if (more) trimmed = true;
    const read = {
      role: node.role ?? '',
      name: node.name ?? '',
      value: node.value ?? null,
      ...Object.fromEntries(
        [...described, 'native_id']
          .filter((key) => node[key] != null)
          .map((key) => [key, node[key]]),
      ),
      states: (node.states ?? []).filter((state) => !activation.includes(state)).sort(),
      ...(more ? { more: true } : {}),
      children: kept
        .map((child) => walk(child, inFocus || claims.has(node)))
        .filter((child) => !emptyGroup(child)),
    };
    if (isTarget(node)) targetNode ??= read;
    if (holders.has(node)) focusNode ??= read;
    if (inFocus && node.states?.includes('selected')) selected.push(read);
    return read;
  };
  const source = menu
    ? {
        ...data.tree,
        children: data.tree.children?.slice(2),
        children_count:
          data.tree.children_count == null ? undefined : Math.max(0, data.tree.children_count - 2),
      }
    : data.tree;
  const claims = focusClaims(source);
  const holders = new Set(claims.values());
  const tree = walk(source);
  focus(source);
  if (target && !found)
    throw new Error(
      'STALE_REF: That control is no longer in the window, so this step did not run.',
    );
  const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const placed = around(
    tree,
    targetNode ?? selected[0] ?? focusNode ?? tree,
    targetNode ? [] : selected,
  );
  const checked = placed ?? around(tree, tree);
  if (target && checked !== tree && (found > 1 || !placed))
    throw new Error(
      'POLICY_DENIED: This window is too large to check whole, and Nod could not tell which part holds that control, so this step did not run.',
    );
  return {
    context: render(checked).join('\n'),
    state: hash(checked),
    focus: hash(focused),
    focused,
    incomplete: trimmed || checked !== tree,
  };
}

const quote = (text) => JSON.stringify(String(text));
const described = ['description', 'hint', 'placeholder', 'subrole', 'role_description'];

function line(node, depth) {
  let text = `${'  '.repeat(depth)}- ${node.role || 'element'}`;
  if (node.secure) return `${text} [password, hidden]`;
  if (node.name) text += ` ${quote(node.name)}`;
  if (node.value != null) text += ` = ${quote(node.value)}`;
  for (const key of described) if (node[key] != null) text += ` ${key}: ${quote(node[key])}`;
  if (node.states?.length) text += ` (${node.states.join(', ')})`;
  if (node.more) text += ' [more not shown]';
  return text;
}

function render(node, depth = 0) {
  const inner = depth + (wrapper(node) ? 0 : 1);
  const children = (node.children ?? []).flatMap((child) => render(child, inner));
  return wrapper(node) ? children : [line(node, depth), ...children];
}

function wrapper(node) {
  return (
    ['group', ''].includes(node.role) &&
    !node.name &&
    node.value == null &&
    !node.states?.length &&
    !node.more &&
    !described.some((key) => node[key] != null)
  );
}

function around(tree, anchor, required = []) {
  const sizes = new WeakMap();
  const whole = (node, depth) => {
    const known = sizes.get(node) ?? new Map();
    sizes.set(node, known);
    if (!known.has(depth)) known.set(depth, render(node, depth).join('\n').length + 1);
    return known.get(depth);
  };
  if (whole(tree, 0) - 1 <= contextChars) return tree;
  const pathTo = (wanted) => {
    const path = [];
    const find = (node) => {
      path.push(node);
      if (node === wanted || node.children?.some(find)) return true;
      path.pop();
      return false;
    };
    return find(tree) ? path : undefined;
  };
  const path = pathTo(anchor);
  if (!path) return undefined;
  const open = new Set(path);
  const kept = new Set();
  for (const node of required) {
    const route = pathTo(node);
    if (!route) return undefined;
    route.forEach((step) => open.add(step));
    kept.add(node);
  }
  const part = (node) => {
    const shown = node.children.filter((child) => kept.has(child) || open.has(child));
    return {
      node: { ...node, ...(shown.length < node.children.length ? { more: true } : {}) },
      shown,
    };
  };
  const size = (node, depth) => {
    if (kept.has(node)) return whole(node, depth);
    const { node: self, shown } = part(node);
    const own = wrapper(self) ? 0 : line(self, depth).length + 1;
    const inner = depth + (wrapper(self) ? 0 : 1);
    return own + shown.reduce((sum, child) => sum + size(child, inner), 0);
  };
  const fits = () => size(tree, 0) - 1 <= contextChars;
  const fit = (node, backwards = false) => {
    if (kept.has(node)) return;
    kept.add(node);
    if (fits()) return;
    kept.delete(node);
    if (!node.children?.length) return;
    const opened = !open.has(node);
    open.add(node);
    if (!fits()) {
      if (opened) open.delete(node);
      return;
    }
    for (const child of backwards ? [...node.children].reverse() : node.children)
      fit(child, backwards);
  };
  fit(anchor);
  for (let depth = path.length - 1; depth > 0; depth--) {
    const siblings = path[depth - 1].children;
    const at = siblings.indexOf(path[depth]);
    const order = siblings
      .map((_, index) => index)
      .filter((index) => index !== at)
      .sort((a, b) => Math.abs(a - at) - Math.abs(b - at) || a - b);
    for (const index of order) fit(siblings[index], index < at);
  }
  const build = (node) => {
    if (kept.has(node)) return node;
    const { node: self, shown } = part(node);
    return { ...self, children: shown.map(build) };
  };
  return build(tree);
}

async function windowsProgram(path) {
  const file = await open(path).catch(() => undefined);
  if (!file) return undefined;
  try {
    const header = Buffer.alloc(1024);
    await file.read(header, 0, header.length, 0);
    const pe = header.readUInt32LE(0x3c);
    return (
      header.toString('latin1', 0, 2) === 'MZ' &&
      pe + 0x5e <= header.length &&
      header.toString('latin1', pe, pe + 4) === 'PE\0\0' &&
      header.readUInt16LE(pe + 0x5c) === 2
    );
  } finally {
    await file.close();
  }
}

function launcher(exec = '') {
  const words = [...exec.matchAll(/"((?:\\.|[^"\\])*)"|(\S+)/g)]
    .map((match) => (match[1] ?? match[2]).replace(/\\(.)/g, '$1'))
    .filter((word) => word && !/^[A-Z_]+=/.test(word));
  if (words[0] && basename(words[0]) === 'env') words.shift();
  if (words[0] && basename(words[0]) === 'flatpak' && words[1] === 'run')
    return words.slice(2).find((word) => !word.startsWith('-')) ?? 'flatpak';
  return words[0] ? basename(words[0]) : '';
}

function output(file, args) {
  return new Promise((resolve) =>
    execFile(file, args, { timeout: 5000 }, (error, stdout) => resolve(error ? '' : stdout)),
  );
}

export function createComputerHelper({
  binary,
  helper,
  home,
  presence,
  platform = process.platform,
  sandboxed = false,
  requestPermission,
  ownerIdleSeconds = 1,
  ownerWaitMs = 15_000,
  lingerMs = 2000,
  backgroundLingerMs = 10_000,
}) {
  let queue = Promise.resolve();
  let generation = 0;
  const children = new Set();
  const steps = new AsyncLocalStorage();
  const active = new Map();
  const stopped = () => new Error('STOPPED: Nod stopped, so this step did not run.');
  function alive(started, current) {
    if (
      started !== generation ||
      (current && current.generation !== generation) ||
      current?.cancelled ||
      (current?.deadline !== undefined && Date.now() > current.deadline)
    )
      throw stopped();
  }
  function run(args, input, command = spawnCommand) {
    const started = generation;
    const current = steps.getStore();
    const next = queue.then(() => {
      alive(started, current);
      return command(args, input, current);
    });
    queue = next.catch(() => {});
    return next;
  }

  function launchEntry(args, input, current) {
    return new Promise((resolve, reject) => {
      const child = execFile('/usr/bin/gio', args, { timeout: 10_000 }, (error) => {
        children.delete(child);
        current?.children.delete(child);
        if (error)
          reject(new Error(`ACTION_NOT_SUPPORTED: gio could not start the app: ${error.message}`));
        else resolve({});
      });
      children.add(child);
      current?.children.add(child);
    });
  }

  function spawnCommand(args, input, current) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        binary,
        args,
        {
          timeout: answerMs,
          maxBuffer: 32 * 1024 * 1024,
          env: {
            ...Object.fromEntries(
              passedEnvironment.flatMap((name) =>
                process.env[name] === undefined ? [] : [[name, process.env[name]]],
              ),
            ),
            AGENT_DESKTOP_HOME: home,
            ...(helper ? { AGENT_DESKTOP_MACOS_HELPER_PATH: helper } : {}),
          },
        },
        (error, stdout) => {
          children.delete(child);
          current?.children.delete(child);
          let envelope;
          try {
            envelope = JSON.parse(stdout);
          } catch {
            return reject(
              new Error(
                error
                  ? `agent-desktop failed: ${error.killed ? 'it did not answer within 30 seconds' : error.message}`
                  : 'agent-desktop returned no result.',
              ),
            );
          }
          if (envelope.ok) return resolve(envelope.data ?? {});
          const failure = envelope.error ?? {};
          reject(
            Object.assign(
              new Error(
                `${failure.code ?? 'ERROR'}: ${failure.message ?? 'agent-desktop failed.'}`,
              ),
              { kind: failure.details?.kind, delivery: failure.disposition?.delivery },
            ),
          );
        },
      );
      children.add(child);
      current?.children.add(child);
      child.stdin?.end(input ?? '');
    });
  }

  const check = (value, pattern, what) => {
    if (typeof value !== 'string' || !pattern.test(value))
      throw new Error(`INVALID: Invalid ${what}.`);
    return value;
  };
  const scope = (request) => [
    '--app',
    check(request.app, appName, 'app'),
    ...(request.window ? ['--window-id', check(request.window, windowId, 'window')] : []),
  ];
  const inspectArgs = (request) => [
    'snapshot',
    ...scope(request),
    ...(request.menu ? ['--surface', 'menubar'] : []),
    '--max-depth',
    '50',
    ...deadline,
  ];

  function guarded(request, args, input) {
    if (!request.expected && !request.control && !request.noSecureFocus) return run(args, input);
    const started = generation;
    return run(args, input, async (args, input, current) => {
      const read = (args) => {
        alive(started, current);
        return spawnCommand(args, undefined, current);
      };
      if (request.noSecureFocus && !request.expected) {
        const data = await read([
          'find',
          ...scope(request),
          '--state',
          'focused',
          '--limit',
          '0',
          ...deadline,
        ]);
        if (
          !Array.isArray(data.matches) ||
          data.truncated ||
          data.matches.some(
            (node) =>
              secure(node) ||
              node.path?.some(
                (step) => typeof step !== 'string' || secure({ role: step.split(':')[0] }),
              ),
          )
        )
          throw new Error('POLICY_DENIED: A password field has focus, so this step did not run.');
      }
      if (request.expected) {
        const data = await read(inspectArgs(request));
        const inspected = inspectResult(
          data,
          platform === 'darwin' && Boolean(request.menu),
          request.control,
        );
        if (inspected.state !== request.expected)
          throw new Error('STALE_REF: That window changed since this step was checked.');
        if (request.expectedFocus && inspected.focus !== request.expectedFocus)
          throw new Error('STALE_REF: The keyboard target changed since this step was checked.');
        if (request.noSecureFocus && secureFocus(data.tree))
          throw new Error('POLICY_DENIED: A password field has focus, so this step did not run.');
      }
      if (request.control) {
        const data = await read([
          'snapshot',
          '--root',
          check(request.ref, ref, 'ref'),
          '--max-depth',
          '50',
          ...deadline,
        ]);
        inspectResult(data);
        const node = data.tree;
        if (secure(node)) throw new Error('POLICY_DENIED: Nod never uses password fields.');
        if (node.role !== request.control.role || (node.name ?? '') !== request.control.name)
          throw new Error('STALE_REF: That control changed since this step was checked.');
      }
      alive(started, current);
      return spawnCommand(args, input, current);
    });
  }

  async function permissions() {
    const data = await run(['status']);
    surfaces = data.supported_surfaces ?? [];
    return {
      platform,
      accessibility: data.permissions?.accessibility?.state ?? 'unknown',
      screen: data.permissions?.screen_recording?.state ?? 'unknown',
      surfaces,
      sandboxed,
    };
  }
  let surfaces;

  async function screenshot(request) {
    await mkdir(join(home, 'tmp'), { recursive: true, mode: 0o700 });
    const path = join(home, 'tmp', `window-${process.pid}-${Date.now()}.png`);
    try {
      await guarded(request, ['screenshot', ...scope(request), path]);
      return { image: (await readFile(path)).toString('base64') };
    } finally {
      await rm(path, { force: true });
    }
  }

  const chromiumApps = new Map();
  const stale = new Set();
  let session;

  function chromium(pid) {
    if (platform !== 'darwin') return false;
    if (!chromiumApps.has(pid))
      chromiumApps.set(
        pid,
        output('/bin/ps', ['-o', 'comm=', '-p', String(pid)]).then(async (path) => {
          const bundle = path.trim().match(/^(.*?\.app)\/Contents\/MacOS\//)?.[1];
          if (!bundle) return false;
          const frameworks = await readdir(join(bundle, 'Contents', 'Frameworks')).catch(() => []);
          return frameworks.some((name) => chromiumFrameworks.test(name));
        }),
      );
    return chromiumApps.get(pid);
  }

  async function frontmost() {
    return (await run(['list-windows']).catch(() => [])).find((item) => item.is_focused);
  }

  async function windowOf(target) {
    if (!target.window) return undefined;
    const windows = await run(['list-windows', '--app', check(target.app, appName, 'app')]);
    return windows.find((window) => window.id === target.window);
  }

  let followed;
  let following;
  let polling = false;
  function frame(target, bounds, waiting = false) {
    const changed = followed?.waiting !== waiting || followed?.target.window !== target.window;
    followed = { target, bounds: followed && !changed ? followed.bounds : bounds, waiting };
    if (changed) presence.show({ app: target.app, bounds: followed.bounds, waiting });
    following ??= steps.exit(() => setInterval(follow, 300).unref());
  }

  async function follow() {
    const current = followed;
    if (!current || polling) return;
    polling = true;
    try {
      const windows = await run(['list-windows', ...scope({ app: current.target.app })]).catch(
        () => [],
      );
      const bounds = windows.find((item) => item.id === current.target.window)?.bounds;
      if (
        !bounds ||
        followed !== current ||
        JSON.stringify(bounds) === JSON.stringify(current.bounds)
      )
        return;
      current.bounds = bounds;
      presence.show({ app: current.target.app, bounds, waiting: current.waiting });
    } finally {
      polling = false;
    }
  }

  function unframe() {
    followed = undefined;
    clearInterval(following);
    following = undefined;
    presence.hide();
  }

  async function waitForOwner(target, bounds) {
    const until = Date.now() + ownerWaitMs;
    const started = generation;
    const current = steps.getStore();
    const awake = () => {
      try {
        alive(started, current);
      } catch (error) {
        unframe();
        throw error;
      }
    };
    while (presence.idleSeconds() < ownerIdleSeconds) {
      awake();
      if (Date.now() > until) {
        unframe();
        throw new Error(
          `OWNER_ACTIVE: The owner kept using the computer, so Nod didn't bring ${target.app} to the front and sent nothing. Try again when they pause.`,
        );
      }
      frame(target, bounds, true);
      await delay(250);
    }
    awake();
  }

  function giveBack(previous, pid, window) {
    return steps.exit(async () => {
      if (!previous) return;
      const front = await frontmost();
      if (front?.pid !== pid || (window && front.id !== window)) return;
      if (previous.pid === presence.ownPid) return presence.focusSelf();
      if (previous.window)
        await run(['focus-window', '--app', previous.app, '--window-id', previous.window]).catch(
          () => {},
        );
    });
  }

  async function release(handover = false) {
    const ending = session;
    session = undefined;
    if (!ending) return;
    clearTimeout(ending.timer);
    unframe();
    if (handover) return ending;
    await giveBack(ending.previous, ending.pid, ending.window);
  }

  async function focused(target, window, work) {
    if (session?.window !== target.window) {
      const handed = await release(true);
      let previous = handed?.previous;
      try {
        await waitForOwner(target, window.bounds);
        if (!handed) {
          const back = await frontmost();
          previous =
            back && back.id !== target.window
              ? { pid: back.pid, app: back.app_name, window: back.id }
              : undefined;
        }
        frame(target, window.bounds);
        await run(['focus-window', ...scope(target)]);
      } catch (error) {
        unframe();
        if (handed) await giveBack(handed.previous, handed.pid, handed.window);
        else await giveBack(previous, window.pid, target.window);
        throw error;
      }
      session = { window: target.window, pid: window.pid, previous };
    } else {
      clearTimeout(session.timer);
      try {
        await waitForOwner(target, window.bounds);
      } catch (error) {
        await release();
        throw error;
      }
      frame(target, window.bounds);
    }
    try {
      return await work();
    } finally {
      if (session) session.timer = setTimeout(() => void release(), lingerMs);
    }
  }

  let backgroundTimer;
  async function shown(request, work) {
    clearTimeout(backgroundTimer);
    if (!followed) presence.show({ app: request.app ?? request.bundle, background: true });
    try {
      return await work();
    } finally {
      backgroundTimer = setTimeout(() => {
        if (!followed) presence.hide();
      }, backgroundLingerMs);
    }
  }

  async function cancel(step) {
    if (step !== undefined) {
      const current = active.get(step);
      if (!current) return;
      current.cancelled = true;
      for (const child of current.children) child.kill();
      return;
    }
    generation++;
    for (const child of children) child.kill();
    clearTimeout(backgroundTimer);
    if (session) await release();
    else unframe();
  }

  async function act(
    request,
    args,
    { input, found = windowOf(request), front = false, ready } = {},
  ) {
    const target = { app: request.app, window: request.window };
    const window = await found;
    const inFront = window && (front || (await chromium(window.pid)));
    if (!inFront)
      try {
        return await guarded(request, args, input);
      } catch (error) {
        if (!window || !needsFocus(error)) throw error;
      }
    if (inFront) stale.add(target.window);
    return focused(target, window, async () => {
      const headed = async () =>
        guarded(ready ? await ready() : request, [...args, '--headed'], input);
      if (front || args[0] === 'press')
        try {
          return await guarded(request, [...args, '--headed'], input);
        } catch (error) {
          if (!ready || error.delivery !== 'not_delivered' || !/focus/i.test(error.message))
            throw error;
          return headed();
        }
      try {
        return await guarded(request, args, input);
      } catch (error) {
        if (!needsFocus(error)) throw error;
        return headed();
      }
    });
  }

  const focusArgs = (at) => ['focus', at, ...(platform === 'darwin' ? [] : ['--headed'])];

  async function hasFocus(at) {
    const { tree } = await run(['snapshot', '--root', at, '--max-depth', '0', ...deadline]);
    return Boolean(tree && isFocused(tree));
  }

  async function keyboardFocus(request) {
    const at = check(request.ref, ref, 'ref');
    const focus = await guarded(request, focusArgs(at)).catch((error) => {
      if (
        error.delivery !== 'not_delivered' ||
        !/^ACTION_(FAILED|NOT_SUPPORTED):/.test(error.message)
      )
        throw error;
    });
    const placed = { ...request, expected: undefined };
    const input = { ...placed, noSecureFocus: true };
    if (focus?.disposition?.delivery === 'delivered_verified' || (await hasFocus(at))) return input;
    await guarded(placed, ['click', at, '--headed']);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await hasFocus(at)) return input;
      await delay(150);
    }
    throw new Error(
      'ACTION_NOT_SUPPORTED: That field did not take keyboard focus, so Nod typed nothing.',
    );
  }

  async function type(request) {
    const target = { app: request.app, window: request.window };
    const window = await windowOf(target);
    if (window && (pasteRoles.has(request.role) || (await chromium(window.pid))))
      return paste(request, target, window);
    if (pasteRoles.has(request.role))
      throw new Error('ACTION_NOT_SUPPORTED: Nod can type into this area only in its own window.');
    const field = request.role === 'textfield';
    if (platform === 'darwin' && window && field && request.settable === false)
      return paste(request, target, window, () => keyboardFocus(request));
    return act(request, ['type', check(request.ref, ref, 'ref'), '--stdin'], {
      input: String(request.text ?? ''),
      found: Promise.resolve(window),
      front: platform === 'win32',
      ready: field ? () => keyboardFocus(request) : undefined,
    });
  }

  async function paste(
    request,
    target,
    window,
    focus = async () => {
      await guarded(request, focusArgs(check(request.ref, ref, 'ref')));
      return request;
    },
  ) {
    stale.add(target.window);
    return focused(target, window, async () => {
      const placed = await focus();
      const saved = await presence.clipboard.save();
      try {
        await presence.clipboard.write(String(request.text ?? ''));
        return await guarded({ ...placed, noSecureFocus: true }, [
          'press',
          platform === 'darwin' ? 'cmd+v' : 'ctrl+v',
          ...scope(target),
          '--headed',
        ]);
      } finally {
        await delay(400);
        try {
          await presence.clipboard.restore(saved);
        } catch {
          await Promise.resolve(presence.clipboard.write('')).catch(() => {});
        }
      }
    });
  }

  async function observe(request, work) {
    const target = { app: request.app, window: request.window };
    if (!stale.has(target.window))
      try {
        return await work();
      } catch (error) {
        if (!target.window || !needsFocus(error)) throw error;
      }
    const window = await windowOf(target);
    if (!window) return work();
    const result = await focused(target, window, work);
    stale.delete(target.window);
    return result;
  }

  const operations = {
    permissions,
    request: async (request) => {
      if (platform === 'darwin' && requestPermission)
        await requestPermission(request.which === 'screen' ? 'screen' : 'accessibility');
      else await run(['permissions', request.which === 'screen' ? '--guide' : '--request']);
      return permissions();
    },
    apps: async () => ({
      apps: await Promise.all(
        (await run(['list-apps'])).apps.map(async (app) => ({
          pid: app.pid,
          bundle: app.bundle_id ?? (platform === 'linux' ? '' : app.name),
          ...(platform === 'linux'
            ? {
                program: sandboxed
                  ? ''
                  : await readlink(`/proc/${app.pid}/exe`).then(basename, () => ''),
              }
            : platform === 'win32'
              ? { program: app.name }
              : {}),
          name: app.name,
        })),
      ),
    }),
    windows: async (request) => ({
      windows: (await run(['list-windows', '--app', check(request.app, appName, 'app')]))
        .filter((window) => window.pid === request.pid && window.accessible !== false)
        .map((window) => ({
          id: window.id,
          title: window.title ?? '',
          ...(window.visible === false ? { hidden: true } : {}),
        })),
    }),
    locate: async (request) => {
      const { bundle, name, program } = await locate(request);
      return { bundle, name, program };
    },
    open: async (request) => {
      if (platform === 'darwin')
        return { pid: (await run(['launch', check(request.bundle, appName, 'app')])).pid };
      const found = await locate(request);
      if (platform === 'win32') return { pid: (await run(['launch', found.path])).pid };
      const before = new Set((await run(['list-apps'])).apps.map((app) => app.pid));
      await run(['launch', found.entry], undefined, launchEntry);
      for (let attempt = 0; attempt < 40; attempt++) {
        await delay(250);
        for (const app of (await run(['list-apps'])).apps)
          if (
            app.bundle_id === found.bundle ||
            (!before.has(app.pid) &&
              (await readlink(`/proc/${app.pid}/exe`).then(basename, () => '')) === found.program)
          )
            return { pid: app.pid };
      }
      throw new Error(
        `ACTION_FAILED: ${found.name} was started but its window didn't appear within 10 seconds. List apps to find it.`,
      );
    },
    snapshot: (request) =>
      observe(request, async () => {
        const args = request.ref
          ? ['snapshot', '--root', check(request.ref, ref, 'ref')]
          : [
              'snapshot',
              ...scope(request),
              ...(request.menu ? ['--surface', await menuBar()] : []),
              ...(request.skeleton ? ['--skeleton'] : []),
            ];
        const data = await run([...args, '-i', '--compact', ...deadline]);
        return { tree: data.tree };
      }),
    inspect: async (request) => {
      const read = async () =>
        inspectResult(
          await run(inspectArgs(request)),
          platform === 'darwin' && Boolean(request.menu),
          request.control,
        );
      if (!request.focus) return observe(request, read);
      const window = await windowOf(request);
      if (!window) throw new Error('STALE_REF: That window is gone.');
      return focused(request, window, read);
    },
    find: (request) =>
      observe(request, () =>
        run([
          'find',
          ...scope(request),
          ...(request.text ? ['--text', check(request.text, appName, 'text')] : []),
          ...(request.role ? ['--role', check(request.role, /^[a-z]{1,40}$/, 'role')] : []),
          ...deadline,
        ]),
      ),
    screenshot: (request) => observe(request, () => screenshot(request)),
    press: (request) => act(request, ['click', check(request.ref, ref, 'ref')]),
    focus: (request) =>
      act(request, ['focus', check(request.ref, ref, 'ref')], { front: platform === 'win32' }),
    select: (request) =>
      act(request, [
        'select',
        check(request.ref, ref, 'ref'),
        check(request.option, appName, 'option'),
      ]),
    set_value: (request) =>
      act(request, ['set-value', check(request.ref, ref, 'ref'), '--stdin'], {
        input: String(request.text ?? ''),
      }),
    type,
    key: (request) =>
      act(request, ['press', check(request.keys, keys, 'keys'), ...scope(request)], {
        front: platform === 'win32',
      }),
  };

  async function menuBar() {
    surfaces ??= (await run(['status'])).supported_surfaces ?? [];
    if (!surfaces.includes('menubar'))
      throw new Error(
        'ACTION_NOT_SUPPORTED: This computer has no separate menu bar; the menus are in the window.',
      );
    return 'menubar';
  }

  async function locate(request) {
    if (platform === 'darwin') {
      const bundle = check(request.bundle, /^[A-Za-z0-9.-]{1,200}$/, 'bundle ID');
      const path = (await output('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == "${bundle}"`]))
        .split('\n')
        .find((line) => line.endsWith('.app'));
      if (!path) throw new Error('No app with that bundle ID is installed.');
      return { bundle, name: path.split('/').at(-1).slice(0, -4) };
    }
    if (platform === 'win32') {
      const name = check(request.bundle, programName, 'program name').replace(/\.exe$/i, '');
      const root = process.env.SystemRoot ?? 'C:\\Windows';
      const registered = () =>
        Promise.all(
          ['HKCU', 'HKLM'].map(async (hive) =>
            (
              await output('reg', [
                'query',
                `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${name}.exe`,
                '/ve',
              ])
            )
              .match(/REG_(?:EXPAND_)?SZ\s+"?([^"\r\n]+?)"?\s*$/m)?.[1]
              ?.replace(/%([^%]+)%/g, (whole, variable) => process.env[variable] ?? whole),
          ),
        );
      for (const paths of [
        async () => [join(root, 'System32', `${name}.exe`), join(root, `${name}.exe`)],
        registered,
      ])
        for (const path of (await paths()).filter(Boolean)) {
          const windowed = await windowsProgram(path);
          if (windowed === undefined) continue;
          if (!windowed) throw new Error(`${name} is not a windowed app, so Nod never starts it.`);
          return { bundle: `${name}.exe`, name, path, program: basename(path) };
        }
      throw new Error(`No program named ${name} is installed. Use the name of its .exe file.`);
    }
    if (sandboxed)
      throw new Error(
        'ACTION_NOT_SUPPORTED: Nod runs in a Flatpak sandbox, so it can only use apps that are already open. Ask the owner to open the app, then try again.',
      );
    const id = check(request.bundle, desktopId, 'desktop ID').replace(/\.desktop$/, '');
    const directories = [
      process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
      ...(process.env.XDG_DATA_DIRS ?? '/usr/local/share:/usr/share').split(':'),
    ];
    for (const directory of directories) {
      const path = join(directory, 'applications', `${id}.desktop`);
      const entry = await readFile(path, 'utf8').catch(() => undefined);
      if (entry === undefined) continue;
      const fields = Object.fromEntries(
        (entry.split(/^\[/m).find((section) => section.startsWith('Desktop Entry]')) ?? '')
          .split('\n')
          .map((line) => line.match(/^([A-Za-z]+)=(.*)$/))
          .filter(Boolean)
          .map((match) => [match[1], match[2].trim()]),
      );
      if (fields.Type !== 'Application' || fields.Hidden === 'true')
        throw new Error(`${id} is not an app Nod can open.`);
      if (fields.Terminal === 'true' || /(^|;)TerminalEmulator(;|$)/.test(fields.Categories ?? ''))
        throw new Error(`${fields.Name ?? id} runs in a terminal, so Nod never opens it.`);
      if (refusedCategories.test(fields.Categories ?? ''))
        throw new Error(
          `${fields.Name ?? id} is a system, settings or file manager app, so Nod never opens it.`,
        );
      return {
        bundle: id,
        name: fields.Name || id,
        program: launcher(fields.Exec),
        entry: path,
      };
    }
    throw new Error(
      `No app with the desktop ID ${id} is installed. Use the ID from its .desktop file, such as org.gnome.TextEditor.`,
    );
  }

  let ready;
  async function operate(request) {
    await access(binary, constants.X_OK).catch(() => {
      throw new Error(`agent-desktop is missing at ${binary}.`);
    });
    ready ??= mkdir(home, { recursive: true, mode: 0o700 }).then(() => chmod(home, 0o700));
    await ready.catch((error) => {
      ready = undefined;
      throw error;
    });
    const operation = operations[request?.op];
    if (!operation) throw new Error(`Unknown computer use step ${String(request?.op)}.`);
    return appSteps.has(request.op) ? shown(request, () => operation(request)) : operation(request);
  }

  return {
    cancel,
    async request(request) {
      if (request?.op === 'cancel') return cancel(request.step).then(() => ({}));
      const current = {
        cancelled: false,
        generation,
        children: new Set(),
        deadline: typeof request?.deadline === 'number' ? request.deadline : undefined,
      };
      const step = typeof request?.step === 'string' ? request.step : undefined;
      if (step) active.set(step, current);
      try {
        return await steps.run(current, () => operate(request));
      } finally {
        if (step) active.delete(step);
      }
    },
  };
}
