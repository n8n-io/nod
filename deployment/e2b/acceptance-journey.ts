import { setTimeout as delay } from 'node:timers/promises';
import type { ComputerAllocationStore } from '../../src/ports/computer-allocation.ts';
import type { E2BClient, E2BSandbox } from '../../src/providers/e2b/client.ts';
import { createE2BAdapters } from '../../src/providers/e2b/index.ts';
import { WorkspaceCommandError } from '../../src/providers/docker/command.ts';
import type { AcceptancePlan } from './acceptance.ts';

const fail = () => new Error('The development journey did not complete safely.');
const python = (code: string) => `python3 -c '${code.replaceAll("'", "'\\''")}'`;
export type JourneyInput = {
  plan: AcceptancePlan;
  client: E2BClient;
  store: ComputerAllocationStore;
  stage<T>(name: string, operation: () => Promise<T>): Promise<T>;
  boundary(): Promise<void>;
};

export async function runAcceptanceJourney(input: JourneyInput) {
  const { plan, stage } = input;
  const signal = AbortSignal.timeout(12 * 60_000);
  let providerPauses = 0;
  const observe = (sandbox: E2BSandbox): E2BSandbox => ({
    ...sandbox,
    pause: async () => {
      providerPauses++;
      return sandbox.pause();
    },
  });
  const client: E2BClient = {
    create: async (...args) => observe(await input.client.create(...args)),
    connect: async (...args) => observe(await input.client.connect(...args)),
  };
  const create = () =>
    createE2BAdapters({
      apiKey: 'injected-development-client',
      ownerId: plan.ownerId,
      templateId: plan.templateId,
      workspaceRoot: '/workspace',
      allocations: input.store,
      client,
      browserTimeoutMs: 60_000,
      drainTimeoutMs: 30_000,
    });
  let adapters = create();
  const workspace = (selected = adapters, selectedSignal = signal) => {
    const session = selected.workspace.open({
      threadId: plan.threadId,
      workspacePath: `/workspace/${plan.threadId}`,
      signal: selectedSignal,
    });
    const execute = async (command: string, timeoutSeconds = 30) => {
      const chunks: Buffer[] = [];
      const { exitCode } = await session.exec(command, {
        timeoutMs: timeoutSeconds * 1000,
        onData: (chunk) => chunks.push(chunk),
      });
      if (exitCode) throw fail();
      return Buffer.concat(chunks).toString('utf8');
    };
    return { execute, readFile: (path: string) => execute(`cat -- '${path}'`) };
  };
  const marker = `otto-e2b-${plan.nonce}`;
  const expected = Buffer.from(`marker,value\n${marker},144\n`);
  const cookie = `otto_e2b=${marker}`;
  const observeCookie = async () => {
    const page = await adapters.computer.act(
      plan.threadId,
      { action: 'open', url: 'https://httpbin.org/cookies' },
      signal,
    );
    if (
      new URL(page.url).origin !== 'https://httpbin.org' ||
      !page.text.includes(marker) ||
      !page.text.includes('otto_e2b')
    )
      throw fail();
  };
  await stage('prepare-once', () => Promise.all([adapters.prepare(), adapters.prepare()]));
  const original = await input.store.read(plan.ownerId, 'computer');
  if (!original?.resourceId || original.state !== 'ready') throw fail();
  await stage('guest-boundary', input.boundary);
  await stage('workspace-and-artifact', async () => {
    const code = `from pathlib import Path\np=Path('acceptance.csv')\nwith p.open('x') as f: f.write(${JSON.stringify(expected.toString())})\nprint(12*12)`;
    if ((await workspace().execute(python(code))).trim() !== '144') throw fail();
    const bytes = await adapters.workspace.readArtifact!(
      plan.threadId,
      'acceptance.csv',
      1024,
      'publication',
    );
    if (!Buffer.from(bytes).equals(expected)) throw fail();
  });
  await stage('browser-and-profile-seed', async () => {
    const page = await adapters.computer.act(
      plan.threadId,
      { action: 'open', url: 'https://example.com/' },
      signal,
    );
    if (page.url !== 'https://example.com/' || !page.text.includes('Example Domain')) throw fail();
    const url = new URL('https://httpbin.org/response-headers');
    url.searchParams.set('Set-Cookie', `${cookie}; Max-Age=3600; Path=/; Secure; SameSite=Lax`);
    const set = await adapters.computer.act(
      plan.threadId,
      { action: 'open', url: url.href },
      signal,
    );
    if (new URL(set.url).origin !== url.origin) throw fail();
    await observeCookie();
  });
  await stage('held-browser-refuses-pause', async () => {
    const before = providerPauses;
    await adapters.computer.hold(plan.threadId, true);
    let rejected = false;
    try {
      await adapters.pause();
    } catch {
      rejected = true;
    }
    if (!rejected || providerPauses !== before) throw fail();
    await adapters.resume();
    await adapters.computer.hold(plan.threadId, false);
  });
  await stage('descendant-cancellation', async () => {
    const controller = new AbortController();
    const child =
      "import os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); open('cancel-child.pid','x').write(str(os.getpid())); time.sleep(90)";
    const program = `import subprocess,sys,time\np=subprocess.Popen([sys.executable,'-c',${JSON.stringify(child)}])\ntime.sleep(90)`;
    const running = workspace(adapters, AbortSignal.any([signal, controller.signal]))
      .execute(python(program), 120)
      .then(
        () => ({ cancelled: false }),
        (error: unknown) => ({
          cancelled:
            error instanceof WorkspaceCommandError && !error.uncertain && controller.signal.aborted,
        }),
      );
    let observed = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await workspace().execute(
        python(
          "from pathlib import Path\nprint('ready' if Path('cancel-child.pid').exists() else 'waiting')",
        ),
      );
      if (result.trim() === 'ready') {
        observed = true;
        break;
      }
      await delay(500, undefined, { signal });
    }
    if (!observed) throw fail();
    controller.abort();
    if (!(await running).cancelled) throw fail();
    const check =
      "from pathlib import Path\npid=int(Path('cancel-child.pid').read_text())\np=Path('/proc')/str(pid)/'stat'\nassert not p.exists() or p.read_text().split()[2]=='Z'\nprint('drained')";
    if ((await workspace().execute(python(check))).trim() !== 'drained') throw fail();
  });
  await stage('same-resource-pause-resume', async () => {
    await adapters.pause();
    await adapters.resume();
    if ((await workspace().readFile('acceptance.csv')) !== expected.toString()) throw fail();
    await observeCookie();
  });
  await stage('adapter-restart-recovery', async () => {
    await adapters.dispose();
    adapters = create();
    await adapters.prepare();
    if ((await workspace().readFile('acceptance.csv')) !== expected.toString()) throw fail();
    await observeCookie();
    const restored = await input.store.read(plan.ownerId, 'computer');
    if (restored?.resourceId !== original.resourceId || restored.generation !== original.generation)
      throw fail();
  });
  await stage('confirmed-final-pause', () => adapters.dispose());
}
