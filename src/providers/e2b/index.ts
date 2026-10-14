import { createHash } from 'node:crypto';
import type { Computer, Workspace } from '../../ports/computer.ts';
import type { ComputerAllocationStore } from '../../ports/computer-allocation.ts';
import { threadIdentity } from '../../ports/thread-identity.ts';
import { createBridgeComputer } from '../container-browser/client.ts';
import { createCommandWorkspace } from '../docker/index.ts';
import { runSupervisedCommand } from '../docker/command.ts';
import { createE2BAllocation } from './allocation.ts';
import { createE2BClient, type E2BClient } from './client.ts';
import { launchE2BCommand } from './transport.ts';

export function createE2BAdapters(options: {
  apiKey: string;
  ownerId: string;
  templateId: string;
  workspaceRoot: string;
  allocations: ComputerAllocationStore;
  sandboxTimeoutMs?: number;
  requestTimeoutMs?: number;
  leaseMs?: number;
  idlePauseMs?: number;
  maxActiveMs?: number;
  browserTimeoutMs?: number;
  drainTimeoutMs?: number;
  client?: E2BClient;
}): {
  computer: Computer;
  workspace: Workspace;
  prepare(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  dispose(): Promise<void>;
} {
  const client = options.client ?? createE2BClient(options);
  const allocation = createE2BAllocation({
    ownerId: options.ownerId,
    role: 'computer',
    templateId: options.templateId,
    store: options.allocations,
    client,
    leaseMs: options.leaseMs,
    idlePauseMs: options.idlePauseMs,
    maxActiveMs: options.maxActiveMs,
  });
  let browserUsed = false;
  let browserDisposed = false;
  let workspaceDisposed = false;
  let closing = false;
  let draining = false;
  let preparing: Promise<void> | undefined;
  let pausing: Promise<void> | undefined;
  let browserDisposal: Promise<void> | undefined;
  let workspaceDisposal: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  const computer = createBridgeComputer({
    namespace: `sk-${createHash('sha256').update(options.ownerId).digest('hex').slice(0, 24)}`,
    available: (input) => !draining || input.method === 'quiesce',
    launch: (input) => {
      if (browserDisposed || (draining && input.method !== 'quiesce' && input.method !== 'dispose'))
        throw new Error('The remote browser is stopped.');
      browserUsed = true;
      return launchE2BCommand(
        allocation,
        'browser',
        'cd /app && exec node --import tsx /app/src/providers/container-browser/bridge.ts',
      );
    },
    timeoutMs: options.browserTimeoutMs,
    drainTimeoutMs: options.drainTimeoutMs,
  });
  const workspace = createCommandWorkspace({
    workspaceRoot: options.workspaceRoot,
    instructions:
      'Your remote Linux workspace cannot access protected browser profiles or controls. Node, Python (with pdfplumber and pillow_heif), pipx, git, curl, ripgrep, jq, ffmpeg, yt-dlp, poppler-utils, qpdf, Ghostscript and Tesseract OCR are installed. Python also has pypdf, openpyxl, python-docx and python-pptx, and LibreOffice (soffice) converts office files. Install trusted Python libraries with pip install <package>, trusted CLIs with npm install -g <package> or pipx install <package>. A connected app CLI never runs from here: Otto installs its own copy from the source you propose. You run as an unprivileged user without sudo or a graphical display; use a CLI or browser web app. Internet follows server provider policy. Keep outputs in this workspace.',
    runCommand: (id, args, input) => {
      if (draining) return Promise.reject(new Error('The remote computer is paused.'));
      return runSupervisedCommand({
        args,
        ...input,
        drainTimeoutMs: options.drainTimeoutMs,
        launch: () =>
          launchE2BCommand(
            allocation,
            'workspace',
            `mkdir -p /workspace/${threadIdentity(id)} && cd /workspace/${threadIdentity(id)} && exec /usr/bin/setpriv --no-new-privs /usr/bin/python3 -I -u /opt/otto/workspace-command.py`,
          ),
      });
    },
    runConnectedCommand: (id, args, input) => {
      if (draining) return Promise.reject(new Error('The remote computer is paused.'));
      return runSupervisedCommand({
        args,
        ...input,
        drainTimeoutMs: options.drainTimeoutMs,
        launch: () =>
          launchE2BCommand(
            allocation,
            'connected',
            'cd /home/otto-connected && exec /usr/bin/setpriv --no-new-privs /usr/bin/python3 -I -u /opt/otto/workspace-command.py',
          ),
      });
    },
  });
  async function release() {
    if (browserDisposed && workspaceDisposed) {
      await preparing?.catch(() => {});
      await allocation.dispose();
    }
  }
  function disposeComputer() {
    closing = true;
    browserDisposal ??= (async () => {
      if (browserUsed) await computer.dispose();
      browserDisposed = true;
      await release();
    })().catch((error) => {
      browserDisposal = undefined;
      throw error;
    });
    return browserDisposal;
  }
  function disposeWorkspace() {
    closing = true;
    workspaceDisposal ??= (async () => {
      await workspace.dispose();
      workspaceDisposed = true;
      await release();
    })().catch((error) => {
      workspaceDisposal = undefined;
      throw error;
    });
    return workspaceDisposal;
  }
  const { quiesce, ...browserComputer } = computer;
  return {
    computer: {
      ...browserComputer,
      dispose: disposeComputer,
    },
    workspace: {
      ...workspace,
      dispose: disposeWorkspace,
    },
    prepare() {
      if (closing || draining) return Promise.reject(new Error('The remote computer is stopped.'));
      preparing ??= allocation.get().then(
        () => {
          preparing = undefined;
        },
        (error) => {
          preparing = undefined;
          throw error;
        },
      );
      return preparing;
    },
    pause() {
      if (closing) return Promise.reject(new Error('The remote computer is stopped.'));
      draining = true;
      pausing ??= (async () => {
        await preparing;
        if (browserUsed) {
          if (!(await quiesce())) throw new Error('The remote browser is busy.');
          browserUsed = false;
        }
        await allocation.pause();
      })();
      return pausing;
    },
    async resume() {
      if (closing) throw new Error('The remote computer is stopped.');
      await pausing?.catch(() => {});
      await allocation.resume();
      draining = false;
      pausing = undefined;
    },
    dispose() {
      disposal ??= (async () => {
        const results = await Promise.allSettled([disposeComputer(), disposeWorkspace()]);
        if (results.some((result) => result.status === 'rejected'))
          throw new Error('The remote computer needs recovery before continuing.');
        await release();
      })().catch((error) => {
        disposal = undefined;
        throw error;
      });
      return disposal;
    },
  };
}
