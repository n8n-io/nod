import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { Computer } from '../../ports/computer.ts';
import { serviceEnvironment } from '../process.ts';
import { createBridgeComputer } from './client.ts';

export type BrowserBridgeLauncher = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;
export function browserNamespace(dataRoot: string) {
  return `sk-${createHash('sha256').update(resolve(dataRoot)).digest('hex').slice(0, 24)}`;
}

export function createContainerBrowserComputer(options: {
  dataRoot: string;
  container?: string;
  spawn?: BrowserBridgeLauncher;
  timeoutMs?: number;
  drainTimeoutMs?: number;
}): Computer {
  const container = options.container ?? 'nod-browser';
  if (!/^nod-browser(?:-[a-zA-Z0-9_-]+)?$/.test(container))
    throw new Error('BROWSER_CONTAINER must identify a Nod browser.');
  const launch = options.spawn ?? spawn;
  return createBridgeComputer({
    namespace: browserNamespace(options.dataRoot),
    timeoutMs: options.timeoutMs,
    drainTimeoutMs: options.drainTimeoutMs,
    launch: () =>
      launch('docker', ['exec', '-i', '--user', 'node', container, 'node', '/app/bridge.mjs'], {
        env: serviceEnvironment(),
        shell: false,
      }),
  });
}
