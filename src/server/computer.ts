import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { MacApp, MacAppAction, OwnerComputer } from '../ports/owner-computer.ts';
import type { ComputerStatus } from '../shared/computer.ts';
import type { TurnRef } from './thread.ts';
import type { TrustBasis } from './trust-basis.ts';
import { fileBytes } from '../shared/files.ts';

type Verdict = { confirm: false; basis: TrustBasis } | { confirm: true; reason: string };
type Request = (
  turn: TurnRef,
  action: string,
  args: Record<string, unknown>,
  options: Record<string, unknown>,
) => Promise<unknown>;

const blockedApps = [
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'dev.warp.Warp-Stable',
  'com.mitchellh.ghostty',
  'net.kovidgoyal.kitty',
  'org.alacritty',
  'com.apple.ScriptEditor2',
  'com.apple.Automator',
  'com.apple.shortcuts',
  'com.apple.SecurityAgent',
  'com.apple.loginwindow',
  'com.apple.UserNotificationCenter',
  'com.apple.keychainaccess',
  'com.apple.Passwords',
  'com.apple.systempreferences',
  'com.apple.systempreferences.securityandprivacy',
];
const blockedNames = [
  'terminal',
  'iterm',
  'iterm2',
  'warp',
  'ghostty',
  'kitty',
  'alacritty',
  'script editor',
  'automator',
  'shortcuts',
  'keychain access',
  'passwords',
  'system settings',
  'system preferences',
  'otto',
  'nod',
];

export const computerInput = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('shell'),
      command: z.string().min(1).max(20_000),
      timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('share_file'),
      path: z
        .string()
        .min(1)
        .max(4096)
        .regex(/^\/[^\0]*$/),
    })
    .strict(),
  z.object({ action: z.literal('apps') }).strict(),
  z.object({ action: z.literal('open'), app: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal('look'), app: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal('screenshot'), app: z.string().min(1).max(200) }).strict(),
  z
    .object({
      action: z.literal('share_screenshot'),
      app: z.string().min(1).max(200),
      name: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.png$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('act'),
      app: z.string().min(1).max(200),
      step: z.enum(['press', 'set', 'focus', 'showMenu', 'raise', 'type', 'key']),
      ref: z
        .string()
        .regex(/^e\d+$/)
        .optional(),
      value: z.string().max(20_000).optional(),
      text: z.string().max(20_000).optional(),
      key: z.string().max(40).optional(),
    })
    .strict(),
]);

async function unavailable(): Promise<never> {
  throw new Error('Your computer is available only in nod on a Mac.');
}

export function isBlockedApp(app: { name?: string; bundleId?: string }) {
  const bundle = app.bundleId?.trim().toLowerCase();
  return (
    (bundle !== undefined &&
      bundle !== '' &&
      (blockedApps.some((id) => id.toLowerCase() === bundle) ||
        /^(io\.n8n\.(otto|nod)|dev\.(otto|nod))/.test(bundle))) ||
    (app.name !== undefined && blockedNames.includes(app.name.trim().toLowerCase()))
  );
}

export function createComputerPolicy(options: {
  pool: Pool;
  ownerId: string;
  computer?: OwnerComputer;
  check(turn: TurnRef, action: string, args: Record<string, unknown>): Promise<Verdict>;
  hasRules?(): Promise<boolean>;
  request: Request;
  lock(turnId: string, write: () => Promise<void>): Promise<void>;
  signalFor(turnId: string): AbortSignal | undefined;
  record?(turnId: string, action: string, basis: TrustBasis): Promise<void>;
  publishScreenshot?(
    turn: TurnRef,
    bytes: Uint8Array,
    name: string | undefined,
    signal: AbortSignal,
  ): Promise<unknown>;
  publishFile?(
    turn: TurnRef,
    bytes: Uint8Array,
    path: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  using?(apps: string[]): void;
}) {
  const { pool, ownerId, request } = options;
  const computer = options.computer ?? { shell: unavailable, dispose() {} };
  const active = new Map<string, ReturnType<typeof setTimeout>>();
  const turns = new Set<string>();
  let fileTransfers = 0;
  let access = new AbortController();
  const apps = new Map<string, AbortController>();

  function activeTurns() {
    for (const id of turns) {
      const signal = options.signalFor(id);
      if (!signal || signal.aborted) turns.delete(id);
    }
    return [...turns];
  }

  function track(turnId: string) {
    activeTurns();
    turns.add(turnId);
  }

  function operation(signal: AbortSignal, app?: string) {
    if (!app) return AbortSignal.any([signal, access.signal]);
    let controller = apps.get(app);
    if (!controller) apps.set(app, (controller = new AbortController()));
    return AbortSignal.any([signal, access.signal, controller.signal]);
  }

  function touch(name: string) {
    clearTimeout(active.get(name));
    active.set(
      name,
      setTimeout(() => {
        active.delete(name);
        options.using?.([...active.keys()]);
      }, 30_000).unref(),
    );
    options.using?.([...active.keys()]);
  }

  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS computer_settings (
        owner_id text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false,
        revision integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE computer_settings ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS computer_apps (
        owner_id text NOT NULL, bundle_id text NOT NULL, name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (owner_id, bundle_id)
      );
    `);
  }

  async function settings() {
    return (
      (
        await pool.query<{ enabled: boolean; revision: number }>(
          'SELECT enabled,revision FROM computer_settings WHERE owner_id=$1',
          [ownerId],
        )
      ).rows[0] ?? { enabled: false, revision: 0 }
    );
  }

  async function allowedApps() {
    return (
      await pool.query<MacApp>(
        'SELECT bundle_id AS "bundleId",name FROM computer_apps WHERE owner_id=$1 ORDER BY name',
        [ownerId],
      )
    ).rows;
  }

  async function status(): Promise<ComputerStatus> {
    const appControlAvailable = computer.appControlAvailable === true;
    let permissions = { accessibility: false, screen: false };
    let permissionError: string | undefined;
    if (appControlAvailable) {
      try {
        if (!computer.permissions) throw new Error();
        permissions = await computer.permissions();
      } catch {
        permissionError = 'Could not check Mac permissions.';
      }
    }
    return {
      available: Boolean(options.computer),
      appControlAvailable,
      enabled: (await settings()).enabled,
      permissions,
      ...(permissionError ? { permissionError } : {}),
      apps: await allowedApps(),
    };
  }

  async function permitted(app: MacApp) {
    if (!app.bundleId) return false;
    return (
      (
        await pool.query('SELECT 1 FROM computer_apps WHERE owner_id=$1 AND bundle_id=$2', [
          ownerId,
          app.bundleId,
        ])
      ).rowCount! > 0
    );
  }

  function refuse(app: { name?: string; bundleId?: string }) {
    if (isBlockedApp(app))
      throw new Error(
        `nod never uses ${app.name || app.bundleId} on the owner's computer. Use the shell action for commands, or ask the owner to do this step.`,
      );
  }

  async function target(query: string, signal: AbortSignal, launch: boolean) {
    if (query.includes('/')) throw new Error('Name the Mac app, not a path.');
    refuse({ name: query, bundleId: query });
    if (!computer.resolve) throw new Error('Mac app control needs the nod desktop app.');
    const running = await computer.resolve(query, signal);
    if (running) {
      refuse(running);
      return { app: running, running: true };
    }
    if (!launch) throw new Error(`${query} is not running. Open it first.`);
    const app = computer.identify ? await computer.identify(query, signal) : null;
    if (!app?.bundleId) throw new Error(`Could not identify ${query}. Name the Mac app again.`);
    refuse(app);
    return { app, running: false };
  }

  async function remember(turnId: string, app: MacApp, revision: number, signal: AbortSignal) {
    refuse(app);
    if (!app.bundleId || app.bundleId === app.name) return;
    await options.lock(turnId, async () => {
      signal.throwIfAborted();
      const result = await pool.query(
        `WITH allowed AS (
           SELECT owner_id FROM computer_settings
           WHERE owner_id=$1 AND enabled AND revision=$4 FOR SHARE
         )
         INSERT INTO computer_apps(owner_id,bundle_id,name)
         SELECT owner_id,$2,$3 FROM allowed
         ON CONFLICT(owner_id,bundle_id) DO UPDATE SET name=EXCLUDED.name
         RETURNING bundle_id`,
        [ownerId, app.bundleId, app.name, revision],
      );
      if (!result.rowCount)
        throw new Error('Computer access changed before the app could be remembered.');
    });
  }

  async function observe(
    action: 'look' | 'screenshot',
    app: MacApp,
    signal: AbortSignal,
    turnId: string,
  ) {
    touch(app.name);
    if (action === 'look') return computer.look!(app.bundleId, signal, turnId);
    const shot = await computer.screenshot!(app.bundleId, signal);
    return { app: shot.app, png: shot.png.toString('base64') };
  }

  async function observeCompleted(
    app: MacApp,
    action: 'open' | 'act',
    signal: AbortSignal,
    turnId: string,
  ) {
    try {
      signal.throwIfAborted();
      const observation = await computer.look!(app.bundleId, signal, turnId);
      signal.throwIfAborted();
      refuse(observation.app);
      if (observation.app.bundleId !== app.bundleId) throw new Error('The observed app changed.');
      return { done: true, app: observation.app, tree: observation.tree };
    } catch {
      signal.throwIfAborted();
      return {
        done: true,
        observation: 'unavailable',
        next:
          action === 'open'
            ? 'The app is open, but its view is unavailable. Look again before acting; do not repeat the open action.'
            : 'The action completed, but its result could not be observed. Look again before acting; do not repeat the action.',
      };
    }
  }

  async function complete<T>(
    turnId: string,
    action: string,
    basis: TrustBasis,
    signal: AbortSignal,
    result: T,
  ): Promise<T> {
    signal.throwIfAborted();
    await options.lock(turnId, async () => {
      signal.throwIfAborted();
      await options.record?.(turnId, `NOD_computer_${action}`, basis);
    });
    return result;
  }

  async function run(
    turn: TurnRef,
    raw: Record<string, unknown>,
    provenance: {
      admit?: (asks: boolean) => Promise<void>;
      sourceMessageId?: string | null;
      rooted?: boolean;
    },
    signal: AbortSignal,
  ) {
    signal = operation(signal);
    signal.throwIfAborted();
    const { enabled, revision } = await settings();
    if (!enabled)
      throw new Error(
        'Your computer is off. The owner can turn it on in Settings, under Your computer.',
      );
    const input = computerInput.parse(raw);
    track(turn.turnId);
    if (input.action === 'shell' || input.action === 'share_file') {
      const verdict = await options.check(turn, 'NOD_computer', input);
      return request(turn, 'NOD_computer', input, {
        ...provenance,
        signal,
        expectedRevision: revision,
        allowed: !verdict.confirm,
        run: () =>
          execute('NOD_computer', input, {
            threadId: turn.threadId,
            turnId: turn.turnId,
            signal,
            expectedRevision: revision,
            basis: verdict.confirm ? { kind: 'approved' } : verdict.basis,
          }),
        details: verdict.confirm ? { reason: verdict.reason } : {},
      });
    }
    if (input.action === 'apps') {
      if (!computer.apps) throw new Error('Mac app control needs the nod desktop app.');
      await provenance.admit?.(false);
      const result = (await computer.apps(signal)).filter((app) => !isBlockedApp(app));
      return complete(turn.turnId, input.action, { kind: 'read' }, signal, result);
    }
    const { app, running } = await target(input.app, signal, input.action === 'open');
    signal = operation(signal, app.bundleId);
    refuse(app);
    const allowed = await permitted(app);
    if (input.action === 'open' && running) {
      if (allowed && !(await options.hasRules?.())) {
        await provenance.admit?.(false);
        signal.throwIfAborted();
        return execute(
          'NOD_computer',
          { action: 'open', app: app.name, bundleId: app.bundleId, running: true },
          {
            threadId: turn.threadId,
            turnId: turn.turnId,
            signal,
            expectedRevision: revision,
            basis: { kind: 'read' },
          },
        );
      }
    } else if (
      allowed &&
      input.action !== 'act' &&
      input.action !== 'open' &&
      input.action !== 'share_screenshot' &&
      !(await options.hasRules?.())
    ) {
      await provenance.admit?.(false);
      signal.throwIfAborted();
      const result = await observe(input.action, app, signal, turn.turnId);
      return complete(turn.turnId, input.action, { kind: 'read' }, signal, result);
    }
    let args: Record<string, unknown> = {
      action: input.action,
      app: app.name,
      bundleId: app.bundleId,
      ...(input.action === 'share_screenshot' && input.name !== undefined
        ? { name: input.name }
        : {}),
    };
    if (input.action === 'act') {
      const { step, ref, value, text, key } = input;
      if (step === 'type' && text === undefined) throw new Error('Pass text for type.');
      if (step === 'key' && !key) throw new Error('Pass key for key.');
      if (step === 'set' && value === undefined) throw new Error('Pass value for set.');
      if (['press', 'focus', 'showMenu', 'raise', 'set'].includes(step) && !ref)
        throw new Error('Pass the ref from a fresh look.');
      if (!computer.inspect) throw new Error('Mac app control needs the nod desktop app.');
      const target = await computer.inspect(app.bundleId, ref, signal, turn.turnId);
      args = {
        ...args,
        step,
        control: target.label,
        targetToken: target.token,
        ...(ref ? { ref } : {}),
        ...(value !== undefined ? { value } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(key !== undefined ? { key } : {}),
      };
    }
    if (input.action === 'open' && running) args = { ...args, running: true };
    const verdict = await options.check(turn, 'NOD_computer', args);
    const action = allowed ? 'NOD_computer' : 'NOD_computer_app';
    return request(turn, action, args, {
      ...provenance,
      signal,
      expectedRevision: revision,
      allowed: !verdict.confirm,
      run: () =>
        execute(action, args, {
          threadId: turn.threadId,
          turnId: turn.turnId,
          signal,
          expectedRevision: revision,
          rememberApp: provenance.rooted === true,
          read: true,
          basis: verdict.confirm ? { kind: 'approved' } : verdict.basis,
        }),
      details: verdict.confirm ? { reason: verdict.reason } : {},
    });
  }

  async function execute(
    action: string,
    args: Record<string, unknown>,
    provenance?: {
      basis: TrustBasis;
      threadId?: string;
      turnId?: string;
      signal?: AbortSignal;
      expectedRevision?: number;
      rememberApp?: boolean;
      read?: boolean;
    },
  ) {
    const currentSignal =
      provenance?.signal ?? (provenance?.turnId ? options.signalFor(provenance.turnId) : undefined);
    if (!currentSignal || !provenance?.turnId)
      throw Object.assign(new Error('This turn is no longer running.'), { notRun: true });
    const app = { name: String(args.app), bundleId: String(args.bundleId) };
    const fileAction = args.action === 'shell' || args.action === 'share_file';
    const signal = operation(currentSignal, fileAction ? undefined : app.bundleId);
    const revision = provenance.expectedRevision ?? 0;
    await options.lock(provenance.turnId, async () => {
      signal.throwIfAborted();
      const current = await settings();
      if (!current.enabled)
        throw Object.assign(new Error('Your computer was turned off before this ran.'), {
          notRun: true,
        });
      if (current.revision !== revision)
        throw Object.assign(new Error('Computer access changed. Ask the owner again.'), {
          notRun: true,
        });
      if (!fileAction) {
        refuse(app);
        if (action === 'NOD_computer' && !(await permitted(app)))
          throw Object.assign(new Error(`Access to ${app.name} was removed before this ran.`), {
            notRun: true,
          });
      }
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
    track(provenance.turnId);
    const completed = <T>(result: T) =>
      complete(provenance.turnId!, String(args.action), provenance.basis, signal, result);
    if (args.action === 'share_file') {
      if (fileTransfers >= 2)
        throw Object.assign(
          new Error('Two file transfers are already running. Wait for them to finish.'),
          { notRun: true },
        );
      if (!computer.readFile || !options.publishFile || !provenance.threadId)
        throw Object.assign(new Error('File sharing from your computer is unavailable.'), {
          notRun: true,
        });
      const input = computerInput.parse(args);
      if (input.action !== 'share_file') throw new Error('A file path is required.');
      fileTransfers++;
      try {
        const bytes = await computer.readFile(input.path, fileBytes, signal);
        signal.throwIfAborted();
        const result = await options.publishFile(
          { threadId: provenance.threadId, turnId: provenance.turnId },
          bytes,
          input.path,
          signal,
        );
        signal.throwIfAborted();
        return completed(result);
      } finally {
        fileTransfers--;
      }
    }
    if (args.action === 'shell') {
      const { command, timeoutSeconds } = computerInput.parse(args) as {
        command: string;
        timeoutSeconds?: number;
      };
      const result = await computer.shell(command, {
        signal,
        timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined,
      });
      signal.throwIfAborted();
      return result.exitCode === 0 ? completed(result) : result;
    }
    const rememberAllowed = () =>
      action === 'NOD_computer_app' && provenance?.turnId && provenance.rememberApp !== false
        ? remember(provenance.turnId, app, revision, signal)
        : Promise.resolve();
    if (args.action === 'share_screenshot') {
      if (!options.publishScreenshot || !provenance.threadId)
        throw Object.assign(new Error('Screenshot publishing is unavailable.'), { notRun: true });
      touch(app.name);
      const shot = await computer.screenshot!(app.bundleId, signal);
      signal.throwIfAborted();
      const result = await options.publishScreenshot(
        { threadId: provenance.threadId, turnId: provenance.turnId },
        shot.png,
        typeof args.name === 'string' ? args.name : undefined,
        signal,
      );
      signal.throwIfAborted();
      await rememberAllowed();
      return completed(result);
    }
    if (args.action === 'open') {
      const running = args.running ? await computer.resolve!(app.bundleId, signal) : null;
      signal.throwIfAborted();
      if (!running && args.running && provenance.basis.kind === 'read')
        throw Object.assign(new Error(`${app.name} is no longer running. Open it again.`), {
          notRun: true,
        });
      const opened = running ?? (await computer.open!(app.bundleId, signal));
      signal.throwIfAborted();
      refuse(opened);
      if (opened.bundleId !== app.bundleId)
        throw new Error('The opened app changed. Check its identity before continuing.');
      if (action === 'NOD_computer_app' && provenance?.turnId && provenance.rememberApp !== false)
        await remember(provenance.turnId, opened, revision, signal);
      touch(opened.name);
      return completed(await observeCompleted(opened, 'open', signal, provenance.turnId));
    }
    if (args.action === 'look' || args.action === 'screenshot') {
      if (provenance.read || action === 'NOD_computer') {
        const result = await observe(args.action, app, signal, provenance.turnId);
        signal.throwIfAborted();
        await rememberAllowed();
        return completed(result);
      }
      await rememberAllowed();
      return completed(
        `The owner allowed nod to use ${app.name}. ${args.action === 'look' ? 'Look' : 'Take the screenshot'} again to continue.`,
      );
    }
    if (typeof args.targetToken !== 'string' || !args.targetToken)
      throw Object.assign(new Error(`${app.name} needs a fresh look before acting.`), {
        notRun: true,
      });
    touch(app.name);
    const step: MacAppAction = {
      app: app.bundleId,
      action: args.step as MacAppAction['action'],
      targetToken: args.targetToken,
      ...(typeof args.ref === 'string' ? { ref: args.ref } : {}),
      ...(typeof args.value === 'string' ? { value: args.value } : {}),
      ...(typeof args.text === 'string' ? { text: args.text } : {}),
      ...(typeof args.key === 'string' ? { key: args.key } : {}),
    };
    await computer.act!(step, signal);
    signal.throwIfAborted();
    await rememberAllowed();
    return completed(await observeCompleted(app, 'act', signal, provenance.turnId));
  }

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/computer', status);
    app.patch('/api/computer', async (req) => {
      const { enabled: on } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
      await pool.query(
        `INSERT INTO computer_settings(owner_id,enabled,revision) VALUES($1,$2,CASE WHEN $2 THEN 0 ELSE 1 END)
         ON CONFLICT(owner_id) DO UPDATE SET enabled=$2,
           revision=computer_settings.revision+CASE WHEN $2 THEN 0 ELSE 1 END,updated_at=now()`,
        [ownerId, on],
      );
      if (!on) {
        access.abort(new Error('Your computer was turned off.'));
        access = new AbortController();
        computer.dispose();
      }
      return status();
    });
    app.post('/api/computer/permissions', async (req) => {
      const { permission } = z
        .object({ permission: z.enum(['accessibility', 'screen']) })
        .strict()
        .parse(req.body);
      if (!computer.appControlAvailable || !computer.requestPermission)
        throw Object.assign(new Error('Mac app control needs the nod desktop app.'), {
          statusCode: 409,
        });
      await computer.requestPermission(permission);
      return status();
    });
    app.delete<{ Params: { bundleId: string } }>('/api/computer/apps/:bundleId', async (req) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO computer_settings(owner_id,revision) VALUES($1,1)
           ON CONFLICT(owner_id) DO UPDATE SET revision=computer_settings.revision+1,updated_at=now()`,
          [ownerId],
        );
        await client.query('DELETE FROM computer_apps WHERE owner_id=$1 AND bundle_id=$2', [
          ownerId,
          req.params.bundleId,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      apps.get(req.params.bundleId)?.abort(new Error('Access to this Mac app was removed.'));
      apps.delete(req.params.bundleId);
      computer.dispose();
      return status();
    });
  }

  return {
    initialize,
    run,
    execute,
    activeTurns,
    registerRoutes,
  };
}
