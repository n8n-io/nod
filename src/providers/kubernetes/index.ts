import { spawn } from 'node:child_process';
import type { Computer, Workspace } from '../../ports/computer.ts';
import { threadIdentity } from '../../ports/thread-identity.ts';
import { createBridgeComputer } from '../container-browser/client.ts';
import { browserNamespace } from '../container-browser/index.ts';
import { createCommandWorkspace } from '../docker/index.ts';
import { connectedUser, runSupervisedCommand, workspaceCommandProgram } from '../docker/command.ts';
import { serviceEnvironment } from '../process.ts';

function exec(namespace: string, pod: string, args: string[]) {
  if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(namespace))
    throw new Error('NOD_KUBERNETES_NAMESPACE must identify a Kubernetes namespace.');
  return spawn(
    'kubectl',
    ['--namespace', namespace, 'exec', '-i', pod, '--container', 'runtime', '--', ...args],
    {
      env: {
        ...serviceEnvironment(),
        KUBECONFIG: process.env.KUBECONFIG,
        KUBERNETES_SERVICE_HOST: process.env.KUBERNETES_SERVICE_HOST,
        KUBERNETES_SERVICE_PORT: process.env.KUBERNETES_SERVICE_PORT,
      },
      shell: false,
    },
  );
}

export function createKubernetesWorkspace(options: {
  namespace: string;
  workspaceRoot: string;
}): Workspace {
  const run = (
    id: string,
    args: string[],
    input: Omit<Parameters<typeof runSupervisedCommand>[0], 'args' | 'launch'>,
  ) =>
    runSupervisedCommand({
      ...input,
      args,
      transportGraceMs: 10_000,
      launch: () =>
        exec(options.namespace, 'nod-workspace-0', [
          '/usr/bin/setpriv',
          '--reuid',
          String(input.cli ? connectedUser(input.cli) : 1000),
          '--regid',
          input.cli ? '1002' : '1000',
          '--clear-groups',
          '--no-new-privs',
          '--bounding-set=-all',
          '/usr/bin/env',
          '-i',
          'HOME=/home/node',
          'LANG=C.UTF-8',
          'PATH=/opt/nod-artifacts/bin:/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin',
          'NPM_CONFIG_PREFIX=/home/node/.local',
          'PIPX_HOME=/home/node/.local/pipx',
          'PIPX_BIN_DIR=/home/node/.local/bin',
          '/bin/sh',
          '-c',
          'cd "$1" && shift && exec "$@"',
          'nod-command',
          input.cli ? '/var/tmp' : `/workspace/${threadIdentity(id)}`,
          '/usr/bin/python3',
          '-I',
          '-u',
          '-c',
          workspaceCommandProgram,
        ]),
    });
  return createCommandWorkspace({
    workspaceRoot: options.workspaceRoot,
    instructions:
      'Your Linux workspace runs in a Kubernetes pod. Network access follows the deployment’s egress policy. Node, Python, pipx, git, curl, ripgrep, jq, ffmpeg, yt-dlp, PDF tools, Tesseract OCR and LibreOffice are installed. Install trusted tools with pip, npm or pipx; /home/node persists across tasks and restarts. A connected app CLI runs from its own sealed installation, never from this workspace. You run as an unprivileged user without sudo or a graphical display. Keep outputs in this workspace, not on the user’s device.',
    runCommand: run,
    runConnectedCommand: run,
  });
}

export function createKubernetesComputer(options: {
  namespace: string;
  dataRoot: string;
}): Computer {
  return createBridgeComputer({
    namespace: browserNamespace(options.dataRoot),
    launch: () => exec(options.namespace, 'nod-browser-0', ['node', '/app/bridge.mjs']),
  });
}
