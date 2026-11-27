import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const name = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, '');
const program = /^[a-z\d][a-z\d ._-]{0,95}(?:\.exe)?$/i;
const idPattern = /^[a-f0-9-]{36}$/;
const reads = new Set(['windows', 'locate', 'snapshot', 'inspect', 'find']);
const changes = new Set([
  'open',
  'press',
  'focus',
  'select',
  'set_value',
  'type',
  'key',
  'screenshot',
]);

function discordChatInput(input) {
  if (input.ownerChat !== true || name(input.app || input.bundle) !== 'discord') return false;
  if (input.op === 'open') return true;
  if (!input.window) return false;
  if (input.op === 'key')
    return (
      Boolean(input.expected && input.expectedFocus && input.noSecureFocus) &&
      /^(ctrl\+[akf]|backspace|enter|return|esc|escape|tab|shift\+tab|up|down|arrowup|arrowdown)$/i.test(
        input.keys,
      )
    );
  if (!input.ref || !input.control || !input.role) return false;
  if (input.op === 'focus') return true;
  return Boolean(input.expected) && ['type', 'set_value', 'press', 'select'].includes(input.op);
}

export function scopedWindowsRequest(helper, application, approve, policy, discordOrders = false) {
  const selected = application && name(application);
  const eligible = (value) =>
    typeof value === 'string' &&
    program.test(value) &&
    (!selected || name(value) === selected) &&
    policy.computerAppRule(value).kind !== 'blocked';
  return async (input, id, signal) => {
    signal.throwIfAborted();
    if (!idPattern.test(id) || !input || typeof input !== 'object')
      throw Error('Invalid Windows step.');
    if (input.op === 'permissions') return helper.request({ op: 'permissions' });
    if (input.op === 'apps') {
      const { apps } = await helper.request({ op: 'apps' });
      return {
        apps: apps.filter((app) => eligible(app.name) && eligible(app.program || app.name)),
      };
    }
    if (input.op === 'cancel') return helper.cancel().then(() => ({}));
    if (!reads.has(input.op) && !changes.has(input.op))
      throw Error('This operation is unavailable during Windows sharing.');
    const targets = [input.app, input.bundle].filter((value) => value !== undefined);
    if (
      !targets.length ||
      !targets.every(eligible) ||
      targets.some((x) => name(x) !== name(targets[0]))
    )
      throw Error('That application was not shared on this PC.');
    if (
      targets.some((x) => policy.computerAppRule(x).kind === 'view') &&
      !reads.has(input.op) &&
      !['open', 'screenshot'].includes(input.op)
    )
      throw Error('This application is view-only.');
    if (
      input.op === 'key' &&
      (typeof input.keys !== 'string' || policy.systemShortcut(input.keys, 'win32'))
    )
      throw Error('System shortcuts are unavailable.');
    if (
      changes.has(input.op) &&
      !(discordOrders && discordChatInput(input)) &&
      !(await approve(input, signal))
    )
      throw Error('The Windows user declined this step.');
    signal.throwIfAborted();
    return helper.request({ ...input, step: id, deadline: Date.now() + 45_000 });
  };
}

export function windowsSharing({
  helper,
  profile,
  configuredOrigin,
  menu,
  dialog,
  changed,
  sshExecutable,
  loadPolicy,
}) {
  let active,
    choosing = false,
    generation = 0;
  function stop() {
    generation++;
    const current = active;
    if (!current) return;
    active = undefined;
    current.controller.abort();
    for (const pending of current.jobs.values()) pending.abort();
    void helper.cancel().catch(() => {});
    current.ssh.kill();
    changed();
  }
  async function start(config, origin, application, discordOrders = false) {
    const choice = generation;
    if (active || (await configuredOrigin()) !== origin) return;
    const policy = await loadPolicy();
    const label = application || 'Windows desktop';
    const confirmation = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Cancel', discordOrders ? 'Share desktop' : 'Share app'],
      defaultId: 0,
      cancelId: 0,
      message: label + ' – share with Nod?',
      detail:
        origin +
        (discordOrders
          ? '\nNod can read windows of shared apps. During this session, Nod can search, type and send in Discord for requests you give in chat. Stop desktop sharing in the Nod toolbar at any time.'
          : '\nNod can read the windows of the apps you share. You confirm input and window pictures on this PC. Stop in the Nod menu or disconnect to end sharing.'),
    });
    if (
      confirmation.response !== 1 ||
      (await configuredOrigin()) !== origin ||
      active ||
      choice !== generation
    )
      return;
    const args = [
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ConnectTimeout=8',
      '-o',
      'ServerAliveInterval=10',
      '-o',
      'ServerAliveCountMax=2',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      'ForwardAgent=no',
      config.sshHost,
      'docker',
      'exec',
      '-i',
      '--user',
      'node',
      config.container,
      'node',
      '/app/src/providers/attach-windows.mjs',
    ];
    const ssh = spawn(sshExecutable, args, {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const current = (active = {
      ssh,
      controller: new AbortController(),
      jobs: new Map(),
      ready: false,
    });
    changed();
    const failed = () => {
      if (active !== current) return;
      const wasReady = current.ready;
      stop();
      if (!wasReady)
        dialog.showErrorBox(
          'Windows sharing',
          'Could not connect to Nod. Check the SSH connection and the NOD_PAIRED_WINDOWS server setting.',
        );
    };
    ssh.on('error', failed);
    ssh.on('close', failed);
    ssh.stdin.on('error', failed);
    const reader = createInterface({ input: ssh.stdout, crlfDelay: Infinity });
    const timeout = setTimeout(failed, 15_000);
    ssh.once('close', () => {
      clearTimeout(timeout);
      reader.close();
    });
    const scoped = scopedWindowsRequest(
      helper,
      application,
      async (input, signal) => {
        const details = [
          input.app || input.bundle || label,
          input.op,
          input.control?.name,
          input.keys,
          input.option,
          input.text,
        ]
          .filter((value) => typeof value === 'string')
          .join('\n');
        if (details.length > 2000)
          throw Error('Split this action into smaller steps for review on the PC.');
        return (
          (
            await dialog.showMessageBox({
              type: 'question',
              message: 'Allow this Nod step?',
              detail: details,
              buttons: ['Decline', 'Allow once'],
              defaultId: 0,
              cancelId: 0,
              signal,
            })
          ).response === 1
        );
      },
      policy,
      discordOrders,
    );
    reader.on('line', async (line) => {
      if (active !== current) return;
      let msg;
      try {
        if (line.length > 200_000) throw Error();
        msg = JSON.parse(line);
      } catch {
        stop();
        return;
      }
      if (!current.ready) {
        if (msg?.version !== 1 || msg?.ready !== true) {
          failed();
          return;
        }
        current.ready = true;
        clearTimeout(timeout);
        changed();
        return;
      }
      if (idPattern.test(msg?.cancel)) {
        current.jobs.get(msg.cancel)?.abort();
        void helper.cancel(msg.cancel).catch(() => {});
        return;
      }
      const id = msg?.id;
      if (!idPattern.test(id) || current.jobs.has(id) || current.jobs.size >= 48) {
        stop();
        return;
      }
      const controller = new AbortController();
      current.jobs.set(id, controller);
      let answer;
      try {
        answer = { result: await scoped(msg.request, id, controller.signal) };
      } catch (err) {
        answer = { error: String(err.message).slice(0, 400) };
      } finally {
        current.jobs.delete(id);
      }
      if (active === current && !controller.signal.aborted && !ssh.stdin.destroyed)
        ssh.stdin.write(JSON.stringify({ id, ...answer }) + '\n');
    });
  }
  async function choose(wholeDesktop = false, discordOrders = false) {
    if (active) return discordOrders ? undefined : stop();
    if (choosing) return;
    choosing = true;
    try {
      const origin = await configuredOrigin();
      const config = JSON.parse(await readFile(join(profile, 'paired-windows.json'), 'utf8'));
      if (
        !origin ||
        config.origin !== origin ||
        !/^[a-z0-9][a-z0-9_.-]{0,62}$/i.test(config.sshHost) ||
        !/^[a-z0-9][a-z0-9_.-]{0,95}$/i.test(config.container)
      )
        throw Error('Check the server origin, SSH alias and container in paired-windows.json.');
      if (wholeDesktop) return await start(config, origin, null, discordOrders);
      const policy = await loadPolicy();
      const { apps } = await helper.request({ op: 'apps' });
      const names = [
        ...new Set([
          'notepad.exe',
          ...apps
            .map((app) => app.program || app.name)
            .filter(
              (value) =>
                typeof value === 'string' &&
                program.test(value) &&
                policy.computerAppRule(value).kind !== 'blocked',
            ),
        ]),
      ].sort();
      menu
        .buildFromTemplate(
          names.map((label) => ({
            label,
            click: () =>
              void start(config, origin, label).catch((err) =>
                dialog.showErrorBox('Windows sharing', err.message),
              ),
          })),
        )
        .popup();
    } catch (err) {
      dialog.showErrorBox(
        'Windows sharing',
        err.code === 'ENOENT'
          ? 'Set up paired-windows.json in your local desktop profile first.'
          : err.message,
      );
    } finally {
      choosing = false;
    }
  }
  return {
    choose: () => choose(false),
    shareDesktop: () => choose(true),
    shareForChat: () => choose(true, true),
    get state() {
      return active ? (active.ready ? 'active' : 'connecting') : 'off';
    },
    stop,
    get enabled() {
      return Boolean(active);
    },
  };
}
