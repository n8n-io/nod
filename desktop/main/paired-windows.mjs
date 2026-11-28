import { monitorSharing } from './paired-screen.mjs';
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

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
  'activate',
  'press',
  'focus',
  'select',
  'set_value',
  'type',
  'key',
  'screenshot',
]);

const exec = promisify(execFile);
const desktopCodex = { program: 'ChatGPT.exe', appId: 'OpenAI.Codex_2p2nqsd0c76g0!App' };
const taskApps = new Map([
  ['codex', desktopCodex],
  ['chatgpt', desktopCodex],
  ['claude', { program: 'Claude.exe', appId: 'Claude_pzs8sxrjxfjjc!Claude' }],
  ['cloudroom', { program: 'Cloudroom.exe', appId: 'dev.cloudroom.gui' }],
]);

async function registeredTaskApp(target, op, signal, helper) {
  const command =
    "$ErrorActionPreference='Stop'; $item=(New-Object -ComObject Shell.Application).NameSpace('shell:AppsFolder').ParseName($env:NOD_TASK_APP_ID); if ($null -ne $item) { if ($env:NOD_TASK_APP_ACTION -eq 'open') { $item.InvokeVerb() }; [Console]::Write('registered') }";
  const { stdout } = await exec(
    join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    {
      windowsHide: true,
      timeout: 10_000,
      signal,
      env: { ...process.env, NOD_TASK_APP_ID: target.appId, NOD_TASK_APP_ACTION: op },
    },
  );
  if (stdout !== 'registered') return;
  if (op === 'locate')
    return { bundle: target.program, program: target.program, name: target.program };
  for (let n = 0; n < 24; n++) {
    signal.throwIfAborted();
    const { apps } = await helper.request({ op: 'apps' });
    const found = apps.filter((app) => name(app.name) === name(target.program));
    if (found.length === 1) return { pid: found[0].pid };
    await delay(400, undefined, { signal });
  }
  throw Error(
    'Windows accepted the launch but a unique application window has not appeared. Check the running apps.',
  );
}

const taskComposer = (control) =>
  ['textfield', 'textarea', 'textbox'].includes(control?.role) &&
  /^(?:prompt|mit codex arbeiten|(?:work with|ask|message|reply to) (?:codex|claude|chatgpt)|(?:nachricht an|frage an) (?:codex|claude|chatgpt)|build anything|describe (?:a|your) task|write (?:a message|your prompt)(?: to claude)?)[.!…\s]*$/i.test(
    control?.name ?? '',
  );

const taskButton =
  /^(?:send(?: message| prompt)?|submit(?: prompt)?|senden|nachricht senden|start task|new (?:chat|thread|task|session)|neue[rn]? (?:chat|thread|aufgabe|sitzung)|code|coding)(?:\s+\((?:ctrl|strg)\s*\+\s*[a-z]\))?$/i;
const projectThread = /^(?:new (?:thread|chat)|neuer chat) in [\p{L}\p{N} ._()–-]{1,90}$/iu;

async function chatInput(input, taskApp, helper, id, signal) {
  if (input.ownerChat !== true) return false;
  if (input.op === 'open') return true;
  if (!input.window) return false;
  if (input.op === 'activate') return true;
  if (input.op === 'screenshot') return input.noSecureFocus === true;
  if (input.op === 'key') {
    if (!input.expected || !input.expectedFocus || !input.noSecureFocus) return false;
    if (taskApp) {
      if (!/^(enter|return)$/i.test(input.keys)) return false;
      const check = await helper.request({
        op: 'inspect',
        app: input.app,
        window: input.window,
        step: id,
      });
      signal.throwIfAborted();
      return (
        check.focus === input.expectedFocus &&
        check.focused?.length === 1 &&
        taskComposer(check.focused[0])
      );
    }
    return /^(ctrl\+[abfknpsuyz]|backspace|delete|enter|return|esc|escape|(?:shift\+)?tab|(?:ctrl\+|shift\+)?(?:home|end|pageup|pagedown|(?:arrow)?(?:left|right|up|down)))$/i.test(
      input.keys,
    );
  }
  if (!input.ref || !input.control || !input.role || input.role !== input.control.role)
    return false;
  if (
    taskApp &&
    !taskComposer(input.control) &&
    !(
      input.op === 'press' &&
      ['button', 'tab', 'tabitem'].includes(input.role) &&
      (taskButton.test(input.control.name) || projectThread.test(input.control.name))
    )
  )
    return false;
  if (input.op === 'focus') return true;
  return Boolean(input.expected) && ['type', 'set_value', 'press', 'select'].includes(input.op);
}

export function scopedWindowsRequest(
  helper,
  application,
  approve,
  policy,
  chatOrders = false,
  registeredApp = registeredTaskApp,
  monitor,
) {
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
    if (['screen', 'displays', 'point'].includes(input.op)) {
      if (!chatOrders || selected || !monitor || input.ownerChat !== true)
        throw Error('Use Share PC in the Windows toolbar for monitor access in your chat.');
      return monitor(input, signal);
    }
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
    const taskApp = taskApps.get(name(targets[0]));
    if (changes.has(input.op)) {
      const covered = chatOrders && (await chatInput(input, taskApp, helper, id, signal));
      signal.throwIfAborted();
      if (!covered && chatOrders && taskApp && input.ownerChat && input.op !== 'screenshot')
        throw Error(
          'Use the coding app’s task composer. Handle other controls and permission prompts directly in the app.',
        );
      if (!covered && !(await approve(input, signal)))
        throw Error('The Windows user declined this step.');
    }
    signal.throwIfAborted();
    if (chatOrders && taskApp && registeredApp && ['locate', 'open'].includes(input.op)) {
      const result = await registeredApp(taskApp, input.op, signal, helper);
      signal.throwIfAborted();
      if (result) return result;
    }
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
    current.monitor?.clear();
    for (const pending of current.jobs.values()) pending.abort();
    void helper.cancel().catch(() => {});
    current.ssh.kill();
    changed();
  }
  async function start(config, origin, application, chatOrders = false) {
    const choice = generation;
    if (active || (await configuredOrigin()) !== origin) return;
    const policy = await loadPolicy();
    const label = application || 'Windows desktop';
    const confirmation = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Cancel', chatOrders ? 'Share desktop' : 'Share app'],
      defaultId: 0,
      cancelId: 0,
      message: label + ' – share with Nod?',
      detail:
        origin +
        (chatOrders
          ? '\nFor your chat requests, Nod can operate Windows apps, including sending messages, and send pictures of a whole monitor to your configured AI provider. Pictures may include other windows and notifications. This applies across chats until you stop sharing in the Nod toolbar, exit the app or disconnect.'
          : '\nNod can read the windows of the apps you share. You confirm input and window pictures on this PC. Stop in the Nod menu or disconnect to end sharing.'),
    });
    if (
      confirmation.response !== 1 ||
      (await configuredOrigin()) !== origin ||
      active ||
      choice !== generation
    )
      return;
    const monitor =
      chatOrders && !application
        ? monitorSharing({ ...(await import('electron')), policy })
        : undefined;
    if ((await configuredOrigin()) !== origin || active || choice !== generation) return;
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
      monitor,
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
      chatOrders,
      registeredTaskApp,
      monitor,
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
  async function choose(wholeDesktop = false, chatOrders = false) {
    if (active) return chatOrders ? undefined : stop();
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
      if (wholeDesktop) return await start(config, origin, null, chatOrders);
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
