import type { Computer, Workspace } from '../src/ports/computer.ts';

export function fakeComputer(overrides: Partial<Computer> = {}): Computer {
  return {
    act: async () => ({ text: 'Fixture page', url: 'https://example.com', candidates: [] }),
    screenshot: async () => null,
    injectCredentials: async () => {},
    currentPage: async () => ({ origin: 'https://example.com', url: 'https://example.com' }),
    hold: async () => {},
    close: async () => {},
    dispose: async () => {},
    status: () => 'fixture computer',
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
    status: () => 'fixture workspace',
    dispose: () => {},
    ...overrides,
  };
}
