import type { createAgentBrowserComputer } from '../agent-browser/index.ts';

export function containerBrowserOptions(
  dataRoot: string,
  architecture: NodeJS.Architecture = process.arch,
): Parameters<typeof createAgentBrowserComputer>[0] {
  if (architecture !== 'arm64' && architecture !== 'x64')
    throw new Error('The workspace browser architecture is unsupported.');
  return {
    dataRoot,
    executable: `/app/node_modules/agent-browser/bin/agent-browser-linux-${architecture}`,
    browserExecutable: '/app/src/providers/container-browser/chromium.sh',
    platform: 'linux',
    headless: false,
    sandbox: false,
    maxLiveSessions: 4,
    viewport: { width: 1440, height: 900 },
  };
}
