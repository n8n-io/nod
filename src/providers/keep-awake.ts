import type { KeepAwake } from '../ports/keep-awake.ts';

export function desktopKeepAwake(): KeepAwake {
  const parent = (
    process as NodeJS.Process & { parentPort?: { postMessage(message: unknown): void } }
  ).parentPort;
  return {
    set: (working) => parent?.postMessage({ type: 'nod-working', working }),
  };
}
