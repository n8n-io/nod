import type { Computer, Workspace } from '../src/ports/computer.ts';
import type { ExecutionScope } from '../src/shared/execution.ts';
import { randomUUID } from 'node:crypto';

export function fakeExecution(threadId: string, turnId = randomUUID()): ExecutionScope {
  return { threadId, sessionId: threadId, turnId, runId: turnId, browserId: threadId };
}

export function fakeComputer(overrides: Partial<Computer> = {}): Computer {
  return {
    bindProfile: async () => {},
    deleteProfile: async () => {},
    act: async () => ({ text: 'Fixture page', url: 'https://example.com' }),
    download: async () => ({
      bytes: Buffer.from('fixture'),
      name: 'fixture.txt',
      mimeType: 'text/plain',
    }),
    upload: async () => ({ text: 'Fixture page', url: 'https://example.com' }),
    control: async () => {},
    view: async function* () {},
    screenStatus: () => ({ state: 'unavailable' }),
    clear: async () => {},
    discard: async () => {},
    screenshot: async () => null,
    injectCredentials: async () => {},
    currentPage: async () => ({ origin: 'https://example.com', url: 'https://example.com' }),
    hold: async () => {},
    close: async () => {},
    fillCard: async () => {},
    cardDestinations: async () => ({ document: 'fixture', destinations: {} }),
    checkoutImage: async () => new Uint8Array(),
    dispose: async () => {},
    ...overrides,
  };
}

export function fakeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    open: () => ({
      path: '/fixture/workspace',
      instructions: 'Fixture workspace only.',
      exec: async () => ({ exitCode: 0 }),
    }),
    writeArtifact: async () => {},
    readArtifact: async () => new Uint8Array(),
    dispose: () => {},
    ...overrides,
  };
}
