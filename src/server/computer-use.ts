import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { DesktopControl } from '../ports/desktop.ts';
import { IntegrationError } from './integration-connection.ts';
import { addKeepOut, removeKeepOut } from './keep-out.ts';
import { assertStartedByOwner as startedByOwner, type OwnedTurn } from './owner-started.ts';
import { redactSecretText } from './redaction.ts';

type Query = Pick<Pool, 'query'>;

const keepOutLimit = 100;
const grantLimit = 20;
const rootLimit = 50;
const refLimit = 5_000;
const treeChars = 24_000;
const pid = z.number().int().positive();
const ref = z
  .string()
  .regex(/^@[a-z0-9]{6,32}:e\d{1,7}$/, 'Use a ref like @s8f3k2p9:e12 from your latest snapshot.');
const window = z
  .string()
  .regex(/^[A-Za-z0-9:._-]{1,200}$/)
  .optional();
const bundle = z.string().min(1).max(255);
const schemas = {
  COMPUTER_APPS: z.object({}).strict(),
  COMPUTER_OPEN: z.object({ bundle }).strict(),
  COMPUTER_SNAPSHOT: z
    .object({ pid, window, ref: ref.optional(), menu: z.boolean().optional() })
    .strict(),
  COMPUTER_FIND: z
    .object({
      pid,
      window,
      text: z.string().min(1).max(200).optional(),
      role: z
        .string()
        .regex(/^[a-z]{1,40}$/)
        .optional(),
    })
    .strict()
    .refine((input) => input.text || input.role, 'Name the text or role to find.'),
  COMPUTER_SCREENSHOT: z.object({ pid, window }).strict(),
  COMPUTER_PRESS: z.object({ ref }).strict(),
  COMPUTER_FOCUS: z.object({ ref }).strict(),
  COMPUTER_SELECT: z.object({ ref, option: z.string().min(1).max(200) }).strict(),
  COMPUTER_SET_VALUE: z.object({ ref, text: z.string().max(100_000) }).strict(),
  COMPUTER_TYPE: z.object({ ref, text: z.string().min(1).max(10_000) }).strict(),
  COMPUTER_KEY: z.object({ pid, window, keys: z.string().min(1).max(40) }).strict(),
  COMPUTER_KEEP_OUT: z.object({ bundle: z.string().trim().min(1).max(200) }).strict(),
};
type Action = keyof typeof schemas;
const observing = new Set<Action>([
  'COMPUTER_APPS',
  'COMPUTER_SNAPSHOT',
  'COMPUTER_FIND',
  'COMPUTER_SCREENSHOT',
]);
const findLimit = 40;
const targeted = new Set<Action>([
  'COMPUTER_PRESS',
  'COMPUTER_FOCUS',
  'COMPUTER_SELECT',
  'COMPUTER_SET_VALUE',
  'COMPUTER_TYPE',
]);
const beforeDelivery =
  /^(OWNER_ACTIVE|STALE_REF|ACTION_NOT_SUPPORTED|POLICY_DENIED|AMBIGUOUS_TARGET|PERM_DENIED|STOPPED|INVALID):/;
const step = (action: Action) => action.slice('COMPUTER_'.length).toLowerCase();
export const computerInternalArgs = ['pid', 'ref', 'window', 'windowBinding'];
export const computerRequestArgs = [
  ...computerInternalArgs,
  'windowContext',
  'typedKey',
  'typedInApp',
  'typedInAppIncomplete',
  'replacesText',
  'windowContextIncomplete',
];
const systemKeys = new Set([
  'cmd+shift+esc',
  'cmd+shift+q',
  'cmd+opt+shift+q',
  'cmd+ctrl+q',
  'cmd+opt+esc',
  'cmd+space',
  'ctrl+space',
  'cmd+tab',
  'cmd+shift+tab',
  'cmd+opt+d',
  'cmd+ctrl+f',
  'cmd+opt+shift+esc',
  'cmd+shift+3',
  'cmd+shift+4',
  'cmd+shift+5',
  'cmd+shift+6',
  'cmd+ctrl+shift+3',
  'cmd+ctrl+shift+4',
  'cmd+ctrl+power',
  'ctrl+opt+power',
  'cmd+opt+power',
  'ctrl+up',
  'ctrl+down',
  'ctrl+left',
  'ctrl+right',
]);
const otherSystemKeys = new Set([
  'opt+space',
  'opt+tab',
  'opt+shift+tab',
  'ctrl+opt+tab',
  'ctrl+esc',
  'opt+f1',
  'ctrl+opt+backspace',
  'opt+f2',
  'opt+f3',
  'opt+f4',
  'ctrl+opt+delete',
  'ctrl+opt+del',
  'ctrl+shift+esc',
  'ctrl+opt+t',
  'ctrl+opt+l',
  'ctrl+opt+up',
  'ctrl+opt+down',
  'ctrl+opt+left',
  'ctrl+opt+right',
  'print',
  'shift+print',
  'opt+print',
  ...Array.from({ length: 12 }, (_, index) => `ctrl+opt+f${index + 1}`),
]);
const modifierNames: Record<string, string> = {
  command: 'cmd',
  meta: 'cmd',
  super: 'cmd',
  win: 'cmd',
  windows: 'cmd',
  lwin: 'cmd',
  rwin: 'cmd',
  logo: 'cmd',
  mod4: 'cmd',
  '⌘': 'cmd',
  control: 'ctrl',
  ctl: 'ctrl',
  '⌃': 'ctrl',
  option: 'opt',
  alt: 'opt',
  '⌥': 'opt',
  '⇧': 'shift',
  escape: 'esc',
};
const systemMenu =
  /^(apple|services|restart|shut down|log out\b.*|lock screen|force quit\b.*|system settings|system preferences|sleep|about this mac|recent items)(…|\.\.\.)?$/i;

export function systemShortcut(keys: string, platform: string = process.platform) {
  const parts = keys
    .toLowerCase()
    .replace(/\s/g, '')
    .split('+')
    .map((part) => modifierNames[part.trim()] ?? part.trim());
  const key = parts.pop() ?? '';
  const pressed = [...parts, key];
  return (
    (platform !== 'darwin' &&
      (pressed.includes('cmd') || pressed.includes('print') || pressed.includes('sysrq'))) ||
    [...(platform === 'darwin' ? systemKeys : otherSystemKeys)].some((blocked) => {
      const needed = blocked.split('+');
      return needed.at(-1) === key && needed.slice(0, -1).every((part) => parts.includes(part));
    })
  );
}

function leaf(id: string) {
  return id.trim().toLowerCase().split(/[\\/]/).at(-1) ?? '';
}

export function appKey(id: string) {
  return leaf(id).replace(/\.(exe|desktop)$/, '');
}

const blockedApps: Array<[RegExp, string]> = [
  [/^(dev\.nod\.desktop(\..+)?|com\.github\.electron|io\.n8n\.nod|nod)$/, 'Nod itself'],
  [
    /^(com\.apple\.terminal|com\.googlecode\.iterm2|dev\.warp\.warp.*|com\.mitchellh\.ghostty|net\.kovidgoyal\.kitty|(io|org)\.alacritty|co\.zeit\.hyper|com\.github\.wez\.wezterm|org\.wezfurlong\.wezterm|com\.raphaelamorim\.rio|org\.tabby|wt|windowsterminal|cmd|powershell(_ise)?|pwsh|conhost|openconsole|wsl|bash|mintty|org\.gnome\.terminal|org\.gnome\.console|org\.gnome\.ptyxis|ptyxis|kgx|gnome-terminal(-server)?|org\.kde\.konsole|konsole|org\.kde\.yakuake|yakuake|guake|xterm|uxterm|com\.gexperts\.tilix|tilix|terminator|kitty|alacritty|wezterm|xfce4-terminal|lxterminal|terminology|foot|x-terminal-emulator)$/,
    'a terminal',
  ],
  [
    /^(com\.apple\.scripteditor2|com\.apple\.automator|com\.apple\.shortcuts|com\.raycast\.macos|com\.runningwithcrayons\.alfred|com\.docker\.docker|docker desktop|wscript|cscript|mshta|rundll32|regsvr32|python[w0-9.]*|node)$/,
    'an app that runs scripts or commands',
  ],
  [
    /^(com\.apple\.systempreferences|com\.apple\.settings|com\.apple\.keychainaccess|com\.apple\.activitymonitor|com\.apple\.diskutility|com\.apple\.securityagent|com\.apple\.migrateassistant|com\.apple\.installer|com\.apple\.loginwindow|systemsettings|control|mmc|regedit|regedt32|taskmgr|gpedit|msconfig|secpol|lusrmgr|compmgmt|services|eventvwr|devmgmt|diskmgmt|consent|credentialuibroker|logonui|lockapp|org\.gnome\.settings|gnome-control-center|org\.kde\.systemsettings|org\.gnome\.seahorse\.application|seahorse|org\.gnome\.diskutility|gnome-disks|org\.gnome\.systemmonitor|gnome-system-monitor|org\.kde\.plasma-systemmonitor|org\.kde\.kwalletmanager5?|kwalletmanager5?|polkit-.*|org\.gnome\.software|software-properties-.*|synaptic|sechealthui|securityhealthsystray|gcr-prompter|pinentry.*|quickassist|msra|mstsc|logoff|tsdiscon|shutdown|schtasks|certutil|reg|sc|net1?|wmic|msiexec|systemreset|rstrui|credwiz|systemproperties.*|msdt|resmon|perfmon|netplwiz|useraccountcontrolsettings|rekeywiz|sysdm)$/,
    'system settings or security',
  ],
  [
    /^(searchhost|searchapp|searchui|startmenuexperiencehost|shellexperiencehost|applicationframehost|gnome-shell|org\.gnome\.shell.*|plasmashell|krunner|org\.kde\.krunner)$/,
    'the system shell or search, which can start any app',
  ],
  [
    /^(com\.apple\.finder|explorer|org\.gnome\.nautilus|nautilus|org\.kde\.dolphin|dolphin|nemo|thunar|pcmanfm|caja)$/,
    'a file manager; use the files tool for local files',
  ],
  [
    /(^com\.apple\.passwords$)|1password|onepassword|bitwarden|dashlane|lastpass|keepass|nordpass|enpass|proton\.pass|keeper/,
    'a password manager',
  ],
  [/ledger\.live|exodus|electrum|trezor|metamask|phantom|wallet/, 'a crypto wallet'],
];
const viewOnlyApps: Array<[RegExp, string]> = [
  [
    /^(com\.google\.chrome.*|com\.apple\.safari.*|company\.thebrowser\..*|org\.mozilla\..*|com\.microsoft\.edge.*|com\.brave\.browser.*|com\.operasoftware\..*|com\.vivaldi\..*|app\.zen-browser\..*|com\.kagi\..*|ai\.perplexity\..*|com\.openai\.atlas.*|org\.chromium\..*|chrome|google-chrome(-stable|-beta)?|chromium(-browser)?|msedge|microsoft-edge(-stable)?|firefox(-esr)?|brave(-browser)?|opera|vivaldi(-stable)?|arc|librewolf|zen|org\.gnome\.epiphany|epiphany)$/,
    "a web browser; use Nod's own browser for websites",
  ],
  [
    /^(com\.microsoft\.vscode.*|com\.visualstudio\.code.*|com\.todesktop\..*|com\.exafunction\..*|dev\.zed\..*|com\.jetbrains\..*|com\.apple\.dt\.xcode|com\.stablyai\.orca|code(-insiders)?|cursor|windsurf|zed|devenv|jetbrains-.*|idea64|pycharm64|webstorm64)$/,
    'a code editor that can run commands',
  ],
];

type Window = { id: string; title: string; hidden?: boolean };
type App = {
  pid: number;
  bundle: string;
  program?: string;
  name: string;
  windows?: Window[];
  windowsError?: string;
};
type Identity = { bundle: string; program?: string; name: string; pid?: number };
type Node = {
  role?: string;
  name?: string | null;
  value?: string | null;
  ref_id?: string;
  states?: string[];
  available_actions?: string[];
  children?: Node[];
  children_count?: number;
};
type Control = {
  bundle: string;
  program?: string;
  pid?: number;
  app: string;
  window: string;
  windowId?: string;
  menu: boolean;
  role: string;
  name: string;
  secure: boolean;
};
export type ComputerPrepared = Record<string, unknown> & {
  app?: Identity;
  control?: { role: string; name: string; window: string };
  windowBinding?: {
    state: string;
    window?: string;
    menu?: boolean;
    focus?: string;
    target?: { role: string; name: string };
  };
};
type Refusal = IntegrationError & { notRun?: boolean };

export function isComputerAction(action: string): action is Action {
  return Object.hasOwn(schemas, action);
}

export function computerAppRule(bundleId: string, keptOut: string[] = []) {
  const names = [appKey(bundleId), leaf(bundleId)];
  const matches = (pattern: RegExp) => names.some((name) => pattern.test(name));
  if (keptOut.some((entry) => names.includes(appKey(entry))))
    return { kind: 'blocked' as const, why: 'an app the owner keeps Nod out of' };
  for (const [pattern, why] of blockedApps)
    if (matches(pattern)) return { kind: 'blocked' as const, why };
  for (const [pattern, why] of viewOnlyApps)
    if (matches(pattern)) return { kind: 'view' as const, why };
  return { kind: 'use' as const };
}

function shownWindow(app: App) {
  return app.windows?.find((window) => !window.hidden) ?? app.windows?.[0];
}

function holdsText(node: Node) {
  return node.value !== '';
}

function secure(node: Node) {
  return (node.states?.includes('secure') ?? false) || /secure|password/i.test(node.role ?? '');
}

function renderComputerTree(tree: Node | undefined, menuBar = false, mac = true) {
  const lines: string[] = [];
  const refs: Array<Node & { ref_id: string }> = [];
  let length = 0;
  const walk = (node: Node, depth: number, index: number) => {
    if (
      length > treeChars ||
      (mac && menuBar && depth === 1 && index < 2) ||
      (mac && /menu/i.test(node.role ?? '') && systemMenu.test(node.name?.trim() ?? ''))
    )
      return;
    const hidden = secure(node);
    let line = `${'  '.repeat(depth)}- ${node.role ?? 'element'}`;
    if (node.name) line += ` "${node.name.replaceAll('\n', ' ').slice(0, 120)}"`;
    if (hidden) line += ' [password, hidden]';
    else if (node.value != null && node.value !== '')
      line += ` = "${String(node.value).replaceAll('\n', '⏎').slice(0, 300)}"`;
    if (node.ref_id && !hidden) {
      line += ` ${node.ref_id}`;
      refs.push({ ...node, children: undefined, ref_id: node.ref_id });
    }
    const states = node.states?.filter((state) => state !== 'secure');
    if (states?.length) line += ` (${states.join(', ')})`;
    if (node.children_count && !node.children?.length) line += ` [${node.children_count} inside]`;
    if (node.role || node.name || node.ref_id) {
      lines.push(line);
      length += line.length + 1;
    }
    node.children?.forEach((child, position) => walk(child, depth + 1, position));
  };
  if (tree) walk(tree, 0, 0);
  return { text: lines.join('\n'), refs, truncated: length > treeChars };
}

export function createComputerUse(
  pool: Pool,
  ownerId: string,
  options: { desktop?: DesktopControl; platform?: string },
) {
  const { desktop, platform = process.platform } = options;
  const mac = platform === 'darwin';
  const identity = (app: { bundle?: string; pid?: number }) =>
    app.bundle ? `id:${appKey(app.bundle)}` : app.pid ? `pid:${app.pid}` : '';
  const sameApp = (item: Identity, target: { bundle?: string }) =>
    Boolean(item.bundle) && appKey(item.bundle) === appKey(target.bundle ?? '');
  const isGranted = (root: string, app: Identity) =>
    [...(grants.get(root)?.values() ?? [])].some((ids) => ids.includes(identity(app)));
  const grants = new Map<string, Map<string, string[]>>();
  const controls = new Map<string, Map<string, Control>>();
  let access = new AbortController();
  let listing: { at: number; apps: Promise<App[]> } | undefined;

  function unavailable() {
    return new IntegrationError('Computer use works only in the Nod desktop app.', 503);
  }

  async function settings(database: Query = pool) {
    const { rows } = await database.query<{ computer_use: boolean; computer_keep_out: string[] }>(
      'SELECT computer_use,computer_keep_out FROM preferences WHERE owner_id=$1',
      [ownerId],
    );
    return { enabled: rows[0]?.computer_use ?? false, keptOut: rows[0]?.computer_keep_out ?? [] };
  }

  async function lineage(turn: OwnedTurn, database: Query = pool) {
    return startedByOwner(
      database,
      ownerId,
      turn,
      "Computer use only works in work the owner started: a message, or a schedule the owner set up. Nod didn't touch any app.",
    );
  }

  async function ask(request: Record<string, unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!desktop) throw unavailable();
    if (
      !['apps', 'windows', 'locate', 'snapshot', 'inspect', 'screenshot'].includes(
        String(request.op),
      )
    )
      listing = undefined;
    try {
      const result = await desktop.request(request as { op: string }, signal);
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      throw new IntegrationError(error instanceof Error ? error.message : String(error), 409);
    }
  }

  function running(signal?: AbortSignal) {
    if (!listing || Date.now() - listing.at > 1_000) {
      const apps = ask({ op: 'apps' }, signal).then((result) => (result.apps as App[]) ?? []);
      listing = { at: Date.now(), apps };
      apps.catch(() => (listing = undefined));
    }
    return listing.apps;
  }

  function ruleFor(app: Identity, keptOut: string[]) {
    if (!mac && !app.bundle && !app.program)
      return { kind: 'blocked' as const, why: 'an app Nod can’t identify' };
    const rules = [app.bundle, app.program]
      .filter((id): id is string => Boolean(id))
      .map((id) => computerAppRule(id, keptOut));
    return (
      rules.find((rule) => rule.kind === 'blocked') ??
      rules.find((rule) => rule.kind === 'view') ?? { kind: 'use' as const }
    );
  }

  function allowed(app: Identity, keptOut: string[], acting: boolean) {
    const rule = ruleFor(app, keptOut);
    if (rule.kind === 'blocked')
      throw new IntegrationError(`${app.name} is ${rule.why}, so Nod never uses it.`, 403);
    if (acting && rule.kind === 'view')
      throw new IntegrationError(`${app.name} is ${rule.why}. Nod can only look at it.`, 403);
  }

  function granted(root: string, app: Identity) {
    if (!isGranted(root, app))
      throw new IntegrationError(
        `Nod hasn't opened ${app.name} in this request. Use open {bundle: "${app.bundle}"} first.`,
        403,
      );
  }

  function forRoot<T>(map: Map<string, T>, root: string, create: () => T) {
    const current = map.get(root) ?? create();
    map.delete(root);
    map.set(root, current);
    for (const key of map.keys()) {
      if (map.size <= rootLimit) break;
      map.delete(key);
    }
    return current;
  }

  function grant(root: string, target: Identity, app?: Identity) {
    const current = forRoot(grants, root, () => new Map<string, string[]>());
    const key = identity(target);
    if (current.size >= grantLimit && !current.has(key))
      throw new IntegrationError(`This request already opened ${grantLimit} apps.`, 409);
    const ids = new Set([key, ...(current.get(key) ?? []), ...(app ? [identity(app)] : [])]);
    current.set(
      key,
      [...ids].filter((id) => id),
    );
  }

  function remember(root: string, entries: Array<[string, Control]>) {
    const current = forRoot(controls, root, () => new Map<string, Control>());
    for (const [key, value] of entries) current.set(key, value);
    for (const key of current.keys()) {
      if (current.size <= refLimit) break;
      current.delete(key);
    }
  }

  async function live(found: Control, ref: string, signal?: AbortSignal) {
    const { tree } = (await ask(
      {
        op: 'snapshot',
        app: found.app,
        ref,
        ...(found.windowId ? { window: found.windowId } : {}),
      },
      signal,
    )) as { tree?: Node };
    if (!tree) throw new IntegrationError('That control is gone. Take a new snapshot.', 409);
    if (secure(tree)) throw new IntegrationError('Nod never uses password fields.', 403);
    if (tree.role !== found.role || (tree.name ?? '') !== found.name)
      throw new IntegrationError('That control changed. Take a new snapshot.', 409);
    return tree;
  }

  async function windowContext(
    app: string,
    window: string | undefined,
    signal?: AbortSignal,
    focus = false,
    menu = false,
    target?: { role: string; name: string },
  ) {
    const result = await ask(
      {
        op: 'inspect',
        app,
        ...(window ? { window } : {}),
        ...(focus ? { focus: true } : {}),
        ...(menu ? { menu: true } : {}),
        ...(target ? { control: target } : {}),
      },
      signal,
    );
    const context = typeof result.context === 'string' ? result.context : '';
    const text =
      focus && context ? `${context}\n\nFocused: ${JSON.stringify(result.focused)}` : context;
    if (
      !text ||
      typeof result.state !== 'string' ||
      !/^[a-f0-9]{64}$/.test(result.state) ||
      (focus && (typeof result.focus !== 'string' || !/^[a-f0-9]{64}$/.test(result.focus))) ||
      text.length > treeChars
    )
      throw new IntegrationError(
        'Nod could not read the complete window within its size limit, so this step did not run.',
        409,
      );
    return {
      windowContext: redactSecretText(text),
      ...(result.incomplete ? { windowContextIncomplete: true } : {}),
      windowBinding: {
        state: result.state,
        ...(window ? { window } : {}),
        ...(menu ? { menu: true } : {}),
        ...(focus ? { focus: String(result.focus) } : {}),
        ...(target ? { target } : {}),
      },
    };
  }

  function checkedWindow(prepared: ComputerPrepared) {
    if (!prepared.windowBinding)
      throw new IntegrationError('This step has no checked window. Take a new snapshot.', 409);
  }

  async function windowsOf(app: App, signal?: AbortSignal): Promise<App> {
    const { windows } = await ask({ op: 'windows', app: app.name, pid: app.pid }, signal);
    return { ...app, windows: (windows as Window[]) ?? [] };
  }

  async function windowsOrReason(app: App, signal?: AbortSignal): Promise<App> {
    try {
      return await windowsOf(app, signal);
    } catch (error) {
      signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('STOPPED:')) throw error;
      return { ...app, windowsError: message };
    }
  }

  function shown(root: string, refId: string) {
    const found = controls.get(root)?.get(refId);
    if (!found)
      throw new IntegrationError(
        'Nod has no snapshot with that ref in this request. Take a snapshot and use a ref from it.',
        404,
      );
    return found;
  }

  function targetOf(root: string, refId: string, keptOut: string[]) {
    const found = shown(root, refId);
    if (found.secure) throw new IntegrationError('Nod never uses password fields.', 403);
    const app = { bundle: found.bundle, program: found.program, pid: found.pid, name: found.app };
    allowed(app, keptOut, true);
    granted(root, app);
    return found;
  }

  async function appFor(
    root: string,
    processId: number,
    keptOut: string[],
    acting: boolean,
    signal?: AbortSignal,
  ) {
    const apps = await running(signal);
    const app = apps.find((item) => item.pid === processId);
    if (!app)
      throw new IntegrationError(`No running app has pid ${processId}. List apps again.`, 404);
    allowed(app, keptOut, acting);
    granted(root, app);
    unique(apps, app.name);
    return windowsOf(app, signal);
  }

  function unique(apps: App[], name: string) {
    if (apps.filter((item) => item.name === name).length > 1)
      throw new IntegrationError(
        `More than one running app is named ${name}, so Nod can't tell them apart.`,
        409,
      );
  }

  function validate(action: Action, args: Record<string, unknown>) {
    const parsed = schemas[action].safeParse(args);
    if (!parsed.success)
      throw new IntegrationError(`Invalid ${action} input: ${z.prettifyError(parsed.error)}`);
    return parsed.data as Record<string, unknown> & {
      pid?: number;
      ref?: string;
      bundle?: string;
      window?: string;
      menu?: boolean;
      keys?: string;
    };
  }

  async function ready(turn: OwnedTurn) {
    if (!desktop) throw unavailable();
    const [{ enabled, keptOut }, root] = await Promise.all([settings(), lineage(turn)]);
    if (!enabled)
      throw new IntegrationError(
        'Computer use is off. The owner can turn it on in Settings, Computer use.',
        403,
      );
    return { root, keptOut };
  }

  async function prepare(
    turn: OwnedTurn,
    action: Action,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ComputerPrepared> {
    signal = signal ? AbortSignal.any([signal, access.signal]) : access.signal;
    const { root, keptOut } = await ready(turn);
    const input = validate(action, args);
    if (action === 'COMPUTER_APPS') return input;
    if (action === 'COMPUTER_OPEN') {
      const app =
        (await running(signal)).find((item) => sameApp(item, { bundle: input.bundle })) ??
        ((await ask({ op: 'locate', bundle: input.bundle }, signal)) as Identity);
      allowed(app, keptOut, false);
      return {
        app: {
          bundle: app.bundle,
          name: app.name,
          program: app.program,
        },
      };
    }
    if (targeted.has(action)) {
      const found = targetOf(root, input.ref!, keptOut);
      const node = await live(found, input.ref!, signal);
      const app = await appFor(root, found.pid!, keptOut, true, signal);
      const chosen = found.menu ? undefined : (found.windowId ?? shownWindow(app)?.id);
      if (!chosen && !found.menu)
        throw new IntegrationError(`${found.app} has no open window.`, 409);
      return {
        ...input,
        app: { bundle: found.bundle, name: found.app },
        control: { role: found.role, name: found.name, window: found.window },
        ...(['COMPUTER_SET_VALUE', 'COMPUTER_TYPE'].includes(action)
          ? { replacesText: holdsText(node) }
          : {}),
        ...(action !== 'COMPUTER_FOCUS'
          ? await windowContext(found.app, chosen, signal, false, !chosen && found.menu, {
              role: found.role,
              name: found.name,
            })
          : {}),
      };
    }
    if (action === 'COMPUTER_KEY' && systemShortcut(input.keys!, platform))
      throw new IntegrationError(
        `${input.keys} is a system shortcut, so Nod never sends it. Use the app's own controls.`,
        403,
      );
    const app = await appFor(root, input.pid!, keptOut, !observing.has(action), signal);
    const base = { ...input, app: { bundle: app.bundle, name: app.name } };
    if (input.ref) {
      const part = shown(root, input.ref);
      if (identity(part) !== identity(app))
        throw new IntegrationError(`That ref is not part of ${app.name}.`, 403);
      return {
        ...base,
        menu: part.menu,
        windowTitle: part.window,
        ...(part.windowId ? { window: part.windowId } : {}),
      };
    }
    if (input.menu) return { ...base, menu: true, windowTitle: 'menu bar' };
    const chosen = input.window
      ? app.windows?.find((item) => item.id === input.window)
      : shownWindow(app);
    if (!chosen)
      throw new IntegrationError(
        input.window
          ? `${app.name} has no window ${input.window}.`
          : `${app.name} has no open window.`,
        404,
      );
    return {
      ...base,
      menu: false,
      window: chosen.id,
      windowTitle: chosen.title,
      ...(action === 'COMPUTER_KEY' ? await windowContext(app.name, chosen.id, signal, true) : {}),
    };
  }

  function needsCheck(action: Action, _prepared?: ComputerPrepared) {
    return !observing.has(action) && action !== 'COMPUTER_FOCUS';
  }

  function checked(action: Action, prepared: ComputerPrepared): Record<string, unknown> {
    const visible = Object.fromEntries(
      Object.entries(prepared).filter(([key]) => !computerInternalArgs.includes(key)),
    );
    return { ...visible, step: step(action) };
  }

  async function snapshot(
    root: string,
    app: App,
    prepared: ComputerPrepared,
    signal?: AbortSignal,
  ) {
    const menu = Boolean(prepared.menu);
    const request = {
      op: 'snapshot',
      app: app.name,
      ...(prepared.window ? { window: prepared.window } : {}),
      ...(prepared.ref ? { ref: prepared.ref } : {}),
      ...(menu && !prepared.ref ? { menu: true } : {}),
    };
    let rendered = renderComputerTree(
      ((await ask(request, signal)) as { tree?: Node }).tree,
      Boolean(request.menu),
      mac,
    );
    let note = '';
    if (rendered.truncated && !prepared.ref && !menu) {
      rendered = renderComputerTree(
        ((await ask({ ...request, skeleton: true }, signal)) as { tree?: Node }).tree,
        false,
        mac,
      );
      note =
        'This window is large, so this is its outline. Snapshot again with the ref of one part to read it.\n';
    }
    remember(
      root,
      rendered.refs.map((node) => [node.ref_id, control(app, prepared, node, menu)]),
    );
    return { window: prepared.windowTitle ?? '', tree: note + redactSecretText(rendered.text) };
  }

  function control(app: App, prepared: ComputerPrepared, node: Node, menu = false): Control {
    return {
      bundle: app.bundle,
      program: app.program,
      pid: app.pid,
      app: app.name,
      window: String(prepared.windowTitle ?? ''),
      ...(prepared.window ? { windowId: String(prepared.window) } : {}),
      menu,
      role: node.role ?? '',
      name: node.name ?? '',
      secure: secure(node),
    };
  }

  async function find(root: string, app: App, prepared: ComputerPrepared, signal?: AbortSignal) {
    const { matches = [] } = (await ask(
      {
        op: 'find',
        app: app.name,
        ...(prepared.window ? { window: prepared.window } : {}),
        ...(prepared.text ? { text: prepared.text } : {}),
        ...(prepared.role ? { role: prepared.role } : {}),
      },
      signal,
    )) as { matches?: Node[] };
    const shownMatches = matches.filter((node) => node.ref_id).slice(0, findLimit);
    const rendered = shownMatches.map((node) => renderComputerTree(node, false, mac));
    remember(
      root,
      rendered.flatMap(({ refs }) =>
        refs.map((node): [string, Control] => [node.ref_id, control(app, prepared, node)]),
      ),
    );
    const more =
      matches.length > shownMatches.length
        ? `\n${matches.length - shownMatches.length} more matches; narrow the search.`
        : '';
    return {
      window: prepared.windowTitle ?? '',
      matches: redactSecretText(
        (rendered.map(({ text }) => text).join('\n') || 'Nothing matched.') + more,
      ),
    };
  }

  async function plan(
    turn: OwnedTurn,
    action: Action,
    prepared: ComputerPrepared,
    signal?: AbortSignal,
  ): Promise<() => Promise<unknown>> {
    signal?.throwIfAborted();
    const { root, keptOut } = await ready(turn);
    if (action === 'COMPUTER_APPS') {
      const apps = await Promise.all(
        (await running(signal)).map((app) =>
          ruleFor(app, keptOut).kind !== 'blocked' && isGranted(root, app)
            ? windowsOrReason(app, signal)
            : app,
        ),
      );
      return async () => ({
        apps: apps.map((app) => {
          const rule = ruleFor(app, keptOut);
          return {
            pid: app.pid,
            bundle: app.bundle,
            name: app.name,
            ...(rule.kind === 'blocked'
              ? { blocked: rule.why }
              : {
                  ...(rule.kind === 'view' ? { viewOnly: rule.why } : {}),
                  ...(isGranted(root, app)
                    ? {
                        opened: true,
                        ...(app.windowsError
                          ? { windowsError: app.windowsError }
                          : { windows: app.windows }),
                      }
                    : { opened: false }),
                }),
          };
        }),
      });
    }
    if (action === 'COMPUTER_OPEN') {
      const target = prepared.app!;
      allowed(target, keptOut, false);
      return async () => {
        listing = undefined;
        const before = await running(signal);
        const already = before.find((item) => sameApp(item, target));
        if (already) unique(before, already.name);
        let pid = already?.pid;
        if (pid === undefined)
          try {
            pid = (
              (await ask({ op: 'open', bundle: target.bundle, app: target.name }, signal)) as {
                pid?: number;
              }
            ).pid;
          } catch (error) {
            pid = (await running(signal)).find((item) => sameApp(item, target))?.pid;
            if (pid === undefined) throw error;
          }
        listing = undefined;
        const after = await running(signal);
        const app =
          after.find((item) => item.pid === pid) ?? after.find((item) => sameApp(item, target));
        if (app) unique(after, app.name);
        grant(root, target, app);
        return {
          pid: app?.pid ?? pid,
          bundle: target.bundle,
          name: target.name,
          ...(app
            ? await windowsOrReason(app, signal).then((read) =>
                read.windowsError ? { windowsError: read.windowsError } : { windows: read.windows },
              )
            : { windows: [] }),
        };
      };
    }
    if (targeted.has(action)) {
      const found = targetOf(root, String(prepared.ref), keptOut);
      if (
        found.role !== prepared.control?.role ||
        found.name !== prepared.control?.name ||
        found.window !== prepared.control?.window
      )
        throw new IntegrationError('That control changed since this step was checked.', 409);
      unique(await running(signal), found.app);
      const current = await live(found, String(prepared.ref), signal);
      const unsettable =
        action === 'COMPUTER_TYPE' &&
        current.role === 'textfield' &&
        current.available_actions &&
        !current.available_actions.some((name) => ['SetValue', 'TypeText'].includes(name)) &&
        !current.states?.includes('readonly');
      if (needsCheck(action)) checkedWindow(prepared);
      return async () => {
        const result = (await ask(
          {
            op: step(action),
            ref: prepared.ref,
            app: found.app,
            role: found.role,
            control: { role: found.role, name: found.name },
            ...(prepared.windowBinding
              ? {
                  ...(prepared.windowBinding.window
                    ? { window: prepared.windowBinding.window }
                    : {}),
                  ...(prepared.windowBinding.menu ? { menu: true } : {}),
                  expected: prepared.windowBinding.state,
                }
              : found.windowId
                ? { window: found.windowId }
                : {}),
            ...(prepared.text !== undefined ? { text: prepared.text } : {}),
            ...(unsettable ? { settable: false } : {}),
            ...(prepared.option !== undefined ? { option: prepared.option } : {}),
          },
          signal,
        )) as { disposition?: { delivery?: string } };
        return {
          done: true,
          ...(result.disposition?.delivery ? { delivery: result.disposition.delivery } : {}),
        };
      };
    }
    const app = await appFor(root, Number(prepared.pid), keptOut, !observing.has(action), signal);
    if (app.bundle !== prepared.app?.bundle)
      throw new IntegrationError('That app closed or changed since this step was checked.', 409);
    if (action === 'COMPUTER_SNAPSHOT') return () => snapshot(root, app, prepared, signal);
    if (action === 'COMPUTER_FIND') return () => find(root, app, prepared, signal);
    const scope = { app: app.name, window: prepared.window };
    if (action === 'COMPUTER_SCREENSHOT')
      return () => ask({ op: 'screenshot', ...scope, noSecureFocus: true }, signal);
    checkedWindow(prepared);
    return async () => {
      await ask(
        {
          op: 'key',
          keys: prepared.keys,
          ...scope,
          expected: prepared.windowBinding!.state,
          expectedFocus: prepared.windowBinding!.focus,
          noSecureFocus: true,
        },
        signal,
      );
      return { done: true };
    };
  }

  async function execute(
    turn: OwnedTurn,
    action: Action,
    prepared: ComputerPrepared,
    signal?: AbortSignal,
  ) {
    signal = signal ? AbortSignal.any([signal, access.signal]) : access.signal;
    const run = await plan(turn, action, prepared, signal).catch((error: Refusal) => {
      error.notRun = true;
      throw error;
    });
    return run().catch((error: Refusal) => {
      if (beforeDelivery.test(error.message)) error.notRun = true;
      throw error;
    });
  }

  async function keepOut(turn: OwnedTurn, bundleId: string, database: Query) {
    if (!desktop) throw unavailable();
    await lineage(turn, database);
    const input = validate('COMPUTER_KEEP_OUT', { bundle: bundleId });
    if (
      mac
        ? !/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(input.bundle!)
        : !/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(input.bundle!)
    )
      throw new IntegrationError(
        mac
          ? 'Name the app by its bundle ID, such as com.apple.MobileSMS for Messages; apps lists them.'
          : platform === 'win32'
            ? 'Name the app by its program name, such as slack.exe; apps lists them.'
            : 'Name the app by its desktop ID, such as org.gnome.TextEditor; apps lists them.',
      );
    return addKeepOut(database, ownerId, 'computer_keep_out', input.bundle!, keepOutLimit, 'apps');
  }

  async function status() {
    const { enabled, keptOut } = desktop ? await settings() : { enabled: false, keptOut: [] };
    const permissions =
      desktop && enabled
        ? ((await desktop
            .request({ op: 'permissions' }, AbortSignal.timeout(3_000))
            .catch(() => undefined)) as
            | { accessibility?: string; screen?: string; surfaces?: string[]; sandboxed?: boolean }
            | undefined)
        : undefined;
    return {
      available: Boolean(desktop),
      platform,
      enabled,
      keptOut,
      permissions: {
        accessibility: permissions?.accessibility ?? 'unknown',
        screen: permissions?.screen ?? 'unknown',
        ready: (permissions?.surfaces?.length ?? 0) > 0,
        sandboxed: permissions?.sandboxed ?? false,
      },
    };
  }

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/computer-use', status);
    app.patch('/api/computer-use', async (request, reply) => {
      if (!desktop) return reply.code(503).send({ error: unavailable().message });
      const input = z.object({ enabled: z.boolean() }).strict().safeParse(request.body);
      if (!input.success) return reply.code(400).send({ error: 'Send enabled as true or false.' });
      await pool.query(
        `INSERT INTO preferences(owner_id,computer_use) VALUES($1,$2)
         ON CONFLICT(owner_id) DO UPDATE SET computer_use=EXCLUDED.computer_use`,
        [ownerId, input.data.enabled],
      );
      if (!input.data.enabled) {
        access.abort(
          new IntegrationError('Computer use was turned off, so this step did not run.', 403),
        );
        grants.clear();
        controls.clear();
        await desktop.request({ op: 'cancel' }).catch(() => {});
      } else if (access.signal.aborted) access = new AbortController();
      return status();
    });
    app.post('/api/computer-use/permission', async (request, reply) => {
      if (!desktop) return reply.code(503).send({ error: unavailable().message });
      const input = z
        .object({ which: z.enum(['accessibility', 'screen']) })
        .strict()
        .safeParse(request.body);
      if (!input.success) return reply.code(400).send({ error: 'Name accessibility or screen.' });
      try {
        await desktop.request({ op: 'request', which: input.data.which });
      } catch (error) {
        return reply.code(409).send({
          error: `Nod couldn't ask for this permission: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return status();
    });
    app.delete('/api/computer-use/keep-out', async (request, reply) => {
      if (!desktop) return reply.code(503).send({ error: unavailable().message });
      const input = z.object({ bundle }).strict().safeParse(request.body);
      if (!input.success) return reply.code(400).send({ error: 'Name the app to let Nod use.' });
      await removeKeepOut(pool, ownerId, 'computer_keep_out', input.data.bundle);
      return status();
    });
  }

  return {
    available: Boolean(desktop),
    prepare,
    needsCheck,
    checked,
    execute,
    keepOut,
    registerRoutes,
  };
}

export type ComputerUse = ReturnType<typeof createComputerUse>;
