import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { MacApp, MacAppAction, OwnerComputer } from '../ports/owner-computer.ts';
import type { ComputerStatus } from '../shared/computer.ts';
import type { TurnRef } from './thread.ts';

type Verdict = { confirm: false } | { confirm: true; reason: string };
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
  'otto',
];

export const computerInput = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('shell'),
      command: z.string().min(1).max(20_000),
      timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    })
    .strict(),
  z.object({ action: z.literal('apps') }).strict(),
  z.object({ action: z.literal('open'), app: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal('look'), app: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal('screenshot'), app: z.string().min(1).max(200) }).strict(),
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
  throw new Error('Your computer is available only in Otto on a Mac.');
}

export function isBlockedApp(app: { name?: string; bundleId?: string }) {
  const bundle = app.bundleId?.trim().toLowerCase();
  return (
    (bundle !== undefined &&
      bundle !== '' &&
      (blockedApps.some((id) => id.toLowerCase() === bundle) ||
        /^(io\.n8n\.otto|dev\.otto)/.test(bundle))) ||
    (app.name !== undefined && blockedNames.includes(app.name.trim().toLowerCase()))
  );
}

export function createComputerPolicy(options: {
  pool: Pool;
  ownerId: string;
  computer?: OwnerComputer;
  check(turn: TurnRef, action: string, args: Record<string, unknown>): Promise<Verdict>;
  request: Request;
  lock(turnId: string, write: () => Promise<void>): Promise<void>;
  signalFor(turnId: string): AbortSignal | undefined;
  using?(apps: string[]): void;
}) {
  const { pool, ownerId, request } = options;
  const computer = options.computer ?? { shell: unavailable, dispose() {} };
  const active = new Map<string, ReturnType<typeof setTimeout>>();

  function touch(name: string) {
    clearTimeout(active.get(name));
    active.set(
      name,
      setTimeout(() => {
        active.delete(name);
        options.using?.([...active.keys()]);
      }, 30_000),
    );
    options.using?.([...active.keys()]);
  }

  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS computer_settings (
        owner_id text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS computer_apps (
        owner_id text NOT NULL, bundle_id text NOT NULL, name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (owner_id, bundle_id)
      );
    `);
  }

  async function enabled() {
    return Boolean(
      (
        await pool.query<{ enabled: boolean }>(
          'SELECT enabled FROM computer_settings WHERE owner_id=$1',
          [ownerId],
        )
      ).rows[0]?.enabled,
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
    const permissions = await (computer.permissions?.() ?? Promise.reject()).catch(() => ({
      accessibility: false,
      screen: false,
    }));
    return {
      available: Boolean(options.computer),
      enabled: await enabled(),
      permissions,
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
        `Otto never uses ${app.name || app.bundleId} on the owner's computer. Use the shell action for commands, or ask the owner to do this step.`,
      );
  }

  async function target(query: string, signal: AbortSignal, launch: boolean) {
    if (query.includes('/')) throw new Error('Name the Mac app, not a path.');
    refuse({ name: query, bundleId: query });
    if (!computer.resolve) throw new Error('Mac app control needs the Otto desktop app.');
    const running = await computer.resolve(query, signal);
    if (running) {
      refuse(running);
      return { app: running, running: true };
    }
    if (!launch) throw new Error(`${query} is not running. Open it first.`);
    const identified = computer.identify ? await computer.identify(query, signal) : null;
    const app = identified ?? { name: query, bundleId: query };
    refuse(app);
    return { app, running: false };
  }

  async function remember(turnId: string, app: MacApp) {
    refuse(app);
    if (!app.bundleId || app.bundleId === app.name) return;
    await options.lock(turnId, async () => {
      await pool.query(
        'INSERT INTO computer_apps(owner_id,bundle_id,name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [ownerId, app.bundleId, app.name],
      );
    });
  }

  async function observe(action: 'look' | 'screenshot', app: MacApp, signal: AbortSignal) {
    touch(app.name);
    if (action === 'look') return computer.look!(app.bundleId, signal);
    const shot = await computer.screenshot!(app.bundleId, signal);
    return { app: shot.app, png: shot.png.toString('base64') };
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
    if (!(await enabled()))
      throw new Error(
        'Your computer is off. The owner can turn it on in Settings, under Your computer.',
      );
    const input = computerInput.parse(raw);
    if (input.action === 'shell') {
      const verdict = await options.check(turn, 'OTTO_computer', input);
      return request(turn, 'OTTO_computer', input, {
        ...provenance,
        allowed: !verdict.confirm,
        details: verdict.confirm ? { reason: verdict.reason } : {},
      });
    }
    if (input.action === 'apps') {
      if (!computer.apps) throw new Error('Mac app control needs the Otto desktop app.');
      return (await computer.apps(signal)).filter((app) => !isBlockedApp(app));
    }
    const { app, running } = await target(input.app, signal, input.action === 'open');
    refuse(app);
    const allowed = await permitted(app);
    if (input.action === 'open' && running) {
      if (allowed) return { app, running: true, next: 'Look at the app before acting in it.' };
    } else if (allowed && input.action !== 'act' && input.action !== 'open')
      return observe(input.action, app, signal);
    let args: Record<string, unknown> = {
      action: input.action,
      app: app.name,
      bundleId: app.bundleId,
    };
    if (input.action === 'act') {
      const { step, ref, value, text, key } = input;
      if (step === 'type' && text === undefined) throw new Error('Pass text for type.');
      if (step === 'key' && !key) throw new Error('Pass key for key.');
      if (step === 'set' && value === undefined) throw new Error('Pass value for set.');
      if (['press', 'focus', 'showMenu', 'raise', 'set'].includes(step) && !ref)
        throw new Error('Pass the ref from a fresh look.');
      const control = ref ? computer.label?.(app.bundleId, ref) : undefined;
      if (ref && !control) throw new Error(`Unknown ref ${ref}. Look at ${app.name} again first.`);
      args = {
        ...args,
        step,
        ...(ref ? { ref, control } : {}),
        ...(value !== undefined ? { value } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(key !== undefined ? { key } : {}),
      };
    }
    if (input.action === 'open' && running) args = { ...args, running: true };
    const verdict = await options.check(turn, 'OTTO_computer', args);
    if (!verdict.confirm && !allowed && provenance.rooted && !(input.action === 'open' && !running))
      await remember(turn.turnId, app);
    if (!verdict.confirm && (input.action === 'look' || input.action === 'screenshot'))
      return observe(input.action, app, signal);
    return request(turn, allowed ? 'OTTO_computer' : 'OTTO_computer_app', args, {
      ...provenance,
      allowed: !verdict.confirm,
      details: verdict.confirm ? { reason: verdict.reason } : {},
    });
  }

  async function execute(
    action: string,
    args: Record<string, unknown>,
    provenance?: { turnId?: string },
  ) {
    if (!(await enabled()))
      throw Object.assign(new Error('Your computer was turned off before this ran.'), {
        notRun: true,
      });
    const signal =
      (provenance?.turnId ? options.signalFor(provenance.turnId) : undefined) ??
      new AbortController().signal;
    if (args.action === 'shell') {
      const { command, timeoutSeconds } = computerInput.parse(args) as {
        command: string;
        timeoutSeconds?: number;
      };
      return computer.shell(command, {
        signal,
        timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined,
      });
    }
    const app = { name: String(args.app), bundleId: String(args.bundleId) };
    refuse(app);
    if (args.action === 'open') {
      const opened = args.running ? app : await computer.open!(app.bundleId, signal);
      refuse(opened);
      if (action === 'OTTO_computer_app' && provenance?.turnId)
        await remember(provenance.turnId, opened);
      touch(opened.name);
      return { app: opened, next: 'Look at the app before acting in it.' };
    }
    if (action === 'OTTO_computer_app' && provenance?.turnId)
      await remember(provenance.turnId, app);
    if (args.action === 'look' || args.action === 'screenshot')
      return `The owner allowed Otto to use ${app.name}. ${args.action === 'look' ? 'Look' : 'Take the screenshot'} again to continue.`;
    if (typeof args.ref === 'string' && computer.label?.(app.bundleId, args.ref) !== args.control)
      throw Object.assign(
        new Error(`${app.name} changed since this was checked. Look again before acting.`),
        { notRun: true },
      );
    touch(app.name);
    const step: MacAppAction = {
      app: app.bundleId,
      action: args.step as MacAppAction['action'],
      ...(typeof args.ref === 'string' ? { ref: args.ref } : {}),
      ...(typeof args.value === 'string' ? { value: args.value } : {}),
      ...(typeof args.text === 'string' ? { text: args.text } : {}),
      ...(typeof args.key === 'string' ? { key: args.key } : {}),
    };
    await computer.act!(step, signal);
    return { done: true, next: 'Look again to verify the result.' };
  }

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/computer', status);
    app.patch('/api/computer', async (req) => {
      const { enabled: on } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
      await pool.query(
        `INSERT INTO computer_settings(owner_id,enabled) VALUES($1,$2)
         ON CONFLICT(owner_id) DO UPDATE SET enabled=$2,updated_at=now()`,
        [ownerId, on],
      );
      return status();
    });
    app.post('/api/computer/permissions', async (req) => {
      const { permission } = z
        .object({ permission: z.enum(['accessibility', 'screen']) })
        .strict()
        .parse(req.body);
      if (!computer.requestPermission)
        throw Object.assign(new Error('Mac app control needs the Otto desktop app.'), {
          statusCode: 409,
        });
      await computer.requestPermission(permission);
      return status();
    });
    app.delete<{ Params: { bundleId: string } }>('/api/computer/apps/:bundleId', async (req) => {
      await pool.query('DELETE FROM computer_apps WHERE owner_id=$1 AND bundle_id=$2', [
        ownerId,
        req.params.bundleId,
      ]);
      return status();
    });
  }

  return {
    initialize,
    run,
    execute,
    registerRoutes,
  };
}
