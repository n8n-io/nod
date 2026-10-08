import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Computer, Workspace } from '../../ports/computer.ts';
import { createBridgeComputer } from '../container-browser/client.ts';
import { createCommandWorkspace } from '../docker/index.ts';
import { runSupervisedCommand, WorkspaceCommandError } from '../docker/command.ts';
import { cloudflareBrowserLive, launchCloudflareCommand } from './transport.ts';

export function createCloudflareAdapters(options: {
  ownerId: string;
  generation: string;
  workspaceRoot: string;
  browserTimeoutMs?: number;
  drainTimeoutMs?: number;
  transportGraceMs?: number;
  fetch?: typeof fetch;
  launch?: typeof launchCloudflareCommand;
}): { computer: Computer; workspace: Workspace } {
  const {
    ownerId,
    generation,
    workspaceRoot,
    browserTimeoutMs = 300_000,
    drainTimeoutMs = 30_000,
    transportGraceMs = 300_000,
    fetch: requestFetch,
    launch = launchCloudflareCommand,
  } = options;
  if (!z.uuid().safeParse(ownerId).success || !/^[1-9]\d{0,18}$/.test(generation))
    throw new Error('The remote computer configuration is invalid.');
  let browserUsed = false;
  let browserDisposed = false;
  let workspaceUnavailable = false;
  const computer = createBridgeComputer({
    namespace: `sk-${createHash('sha256').update(ownerId.toLowerCase()).digest('hex').slice(0, 24)}`,
    timeoutMs: browserTimeoutMs,
    drainTimeoutMs,
    launch: () => {
      if (browserDisposed) throw new Error('The remote browser is stopped.');
      browserUsed = true;
      return launch({
        role: 'browser',
        generation,
        fetch: requestFetch,
        onUncertain() {},
      });
    },
  });
  const workspace = createCommandWorkspace({
    workspaceRoot,
    status: 'Remote Linux workspace is ready.',
    instructions:
      'Your remote Linux workspace is separate from the trusted browser. Node, Python (with pdfplumber and pillow_heif), pipx, git, curl, ripgrep, jq, ffmpeg, yt-dlp, poppler-utils, qpdf, Ghostscript and Tesseract OCR are installed. Python also has pypdf, openpyxl, python-docx and python-pptx, and LibreOffice (soffice) converts office files. Install trusted Python libraries with pip install <package>, trusted CLIs with npm install -g <package> or pipx install <package>. A connected app CLI never runs from here: Otto installs its own copy from the source you propose. You run as an unprivileged user without sudo or a graphical display; use a CLI or browser web app. Internet follows server provider policy. Keep outputs in this workspace.',
    runCommand: (threadId, args, { session, ...input }) => run(threadId, args, input, { session }),
    runConnectedCommand: (threadId, args, input) => run(threadId, args, input, { connected: true }),
  });
  function run(
    threadId: string,
    args: string[],
    input: Omit<Parameters<typeof runSupervisedCommand>[0], 'args' | 'launch'>,
    mode: { connected?: boolean; session?: boolean },
  ) {
    if (workspaceUnavailable)
      throw new WorkspaceCommandError(
        true,
        'The workspace is unavailable. Restart Otto before continuing.',
      );
    return runSupervisedCommand({
      args,
      ...input,
      drainTimeoutMs,
      transportGraceMs,
      launch: () =>
        launch({
          role: 'workspace',
          generation,
          threadId,
          ...mode,
          fetch: requestFetch,
          onUncertain: () => {
            workspaceUnavailable = true;
          },
        }),
    });
  }
  return {
    computer: {
      ...computer,
      async hold(threadId, until) {
        if (
          browserUsed &&
          !browserDisposed &&
          (await cloudflareBrowserLive({ generation, fetch: requestFetch }))
        )
          await computer.hold(threadId, until);
      },
      status: () => (browserDisposed ? 'Workspace browser is stopped.' : computer.status()),
      async dispose() {
        if (browserUsed) await computer.dispose();
        browserDisposed = true;
      },
    },
    workspace,
  };
}
