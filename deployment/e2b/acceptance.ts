import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import ts from 'typescript';
import type {
  ComputerAllocation,
  ComputerAllocationStore,
} from '../../src/ports/computer-allocation.ts';
import type { E2BClient } from '../../src/providers/e2b/client.ts';
import { runAcceptanceJourney } from './acceptance-journey.ts';

const failure = () => new Error('The development acceptance needs inspection before continuing.');
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const root = fileURLToPath(new URL('../..', import.meta.url));
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const planSchema = z
  .object({
    version: z.literal(1),
    environment: z.literal('development'),
    project: z.literal('otto-development'),
    disposable: z.literal(true),
    nonce: z.string().uuid(),
    ownerId: z.string().uuid(),
    threadId: z.string().uuid(),
    templateId: identifier,
    credentialSha256: digest,
    sourceSha256: digest,
    createdAt: z.string().datetime(),
  })
  .strict();
export type AcceptancePlan = z.infer<typeof planSchema>;
type Configuration = { apiKey: string; templateId: string };
type Entry = { type: string; [key: string]: unknown };
export type ResourceInfo = {
  id: string;
  templateId: string;
  metadata: Record<string, string>;
  state: 'running' | 'paused';
};
type BoundaryResult = { [key: string]: boolean | number | BoundaryResult };
export interface AcceptanceDriver {
  client: E2BClient;
  inspect(id: string): Promise<ResourceInfo | null>;
  find(metadata: Record<string, string>): Promise<ResourceInfo[]>;
  boundary(id: string): Promise<BoundaryResult>;
  kill(id: string): Promise<void>;
}
export interface AcceptanceJournal {
  plan: AcceptancePlan;
  hash: string;
  entries: Entry[];
  append(entry: Entry): Promise<void>;
  store: ComputerAllocationStore;
}
const allocationSchema = z
  .object({
    ownerId: z.string().uuid(),
    role: z.literal('computer'),
    provider: z.literal('e2b'),
    templateId: identifier,
    resourceId: identifier.nullable(),
    generation: z.string().uuid(),
    version: z.number().int().positive(),
    state: z.enum(['allocating', 'ready', 'uncertain']),
    leaseId: z.string().uuid().nullable(),
    leaseExpiresAt: z.number().int().positive().nullable(),
  })
  .strict();

async function privateBytes(path: string, limit = 1024 * 1024) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit || info.mode & 0o077 || info.uid !== process.getuid?.())
      throw failure();
    const bytes = await file.readFile();
    if (bytes.length !== info.size) throw failure();
    return bytes;
  } finally {
    await file.close();
  }
}
async function privateDirectory(path: string) {
  if ((await realpath(path)) !== resolve(path)) throw failure();
  const info = await lstat(path);
  if (!info.isDirectory() || info.mode & 0o077 || info.uid !== process.getuid?.()) throw failure();
}
async function save(path: string, value: unknown) {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(value) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function readDevelopmentConfiguration(path: string): Promise<Configuration> {
  const values = parseEnv((await privateBytes(path, 64 * 1024)).toString('utf8'));
  if (
    values.OTTO_ENVIRONMENT !== 'development' ||
    values.COMPUTER_PROVIDER !== 'e2b' ||
    !values.E2B_API_KEY?.trim() ||
    values.E2B_API_KEY.length > 4096 ||
    Object.keys(values).some((key) => /^E2B_(DOMAIN|API_URL|SANDBOX_URL|DEBUG)$/.test(key))
  )
    throw failure();
  return { apiKey: values.E2B_API_KEY, templateId: identifier.parse(values.E2B_COMPUTER_TEMPLATE) };
}
export async function acceptanceSourceHash(sourceRoot = root) {
  const canonicalRoot = await realpath(sourceRoot);
  if (canonicalRoot !== resolve(sourceRoot)) throw failure();
  const queued = [
    'deployment/e2b/acceptance.ts',
    'deployment/e2b/acceptance-driver.ts',
    'deployment/e2b/acceptance-journey.ts',
    'deployment/e2b/context.ts',
    'deployment/e2b/browser-ready.ts',
    'deployment/e2b/live-boundary.py',
    'deployment/e2b/Dockerfile.computer',
    'deployment/e2b/computer-guard.py',
    'src/providers/container-browser/worker.ts',
    'src/providers/container-browser/bridge.ts',
    'src/providers/container-browser/chromium.sh',
    'src/providers/container-browser/xvfb.sh',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
  ];
  const fixed = new Set(queued);
  const files = new Map<string, Buffer>();
  let total = 0;
  for (const name of queued) {
    if (files.has(name)) continue;
    if (files.size >= 256 || (!fixed.has(name) && !/^(src\/|deployment\/e2b\/).+\.ts$/.test(name)))
      throw failure();
    const path = resolve(canonicalRoot, name);
    if (relative(canonicalRoot, path) !== name || (await realpath(path)) !== path) throw failure();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw failure();
      const buffer = Buffer.alloc(info.size + 1);
      const read = await file.read(buffer, 0, buffer.length, 0);
      if (read.bytesRead !== info.size || (await file.stat()).size !== info.size) throw failure();
      bytes = buffer.subarray(0, read.bytesRead);
    } finally {
      await file.close();
    }
    total += bytes.length;
    if (total > 16 * 1024 * 1024) throw failure();
    files.set(name, bytes);
    if (name.endsWith('.ts')) {
      const imports = ts.preProcessFile(bytes.toString('utf8'), true, true).importedFiles;
      for (const imported of imports) {
        if (imported.fileName.startsWith('.'))
          queued.push(
            relative(canonicalRoot, resolve(canonicalRoot, dirname(name), imported.fileName)),
          );
      }
    }
  }
  const hash = createHash('sha256');
  for (const [path, bytes] of [...files].sort(([left], [right]) => left.localeCompare(right)))
    hash.update(path).update('\0').update(bytes).update('\0');
  return hash.digest('hex');
}
export async function prepareAcceptance(
  directory: string,
  configuration: Configuration,
  sourceSha256: string,
) {
  await mkdir(directory, { mode: 0o700 });
  await privateDirectory(directory);
  const plan = planSchema.parse({
    version: 1,
    environment: 'development',
    project: 'otto-development',
    disposable: true,
    nonce: randomUUID(),
    ownerId: randomUUID(),
    threadId: randomUUID(),
    templateId: configuration.templateId,
    credentialSha256: sha(configuration.apiKey),
    sourceSha256,
    createdAt: new Date().toISOString(),
  });
  await save(join(directory, 'plan.json'), plan);
  return { plan, hash: sha(JSON.stringify(plan)) };
}
export async function openAcceptance(
  directory: string,
  configuration: Configuration,
  expectedHash: string,
  sourceSha256: string,
): Promise<AcceptanceJournal> {
  await privateDirectory(directory);
  const plan = planSchema.parse(
    JSON.parse((await privateBytes(join(directory, 'plan.json'))).toString('utf8')),
  );
  const hash = sha(JSON.stringify(plan));
  if (
    hash !== expectedHash ||
    plan.credentialSha256 !== sha(configuration.apiKey) ||
    plan.templateId !== configuration.templateId ||
    plan.sourceSha256 !== sourceSha256
  )
    throw failure();
  const files = (await readdir(directory)).filter((name) => /^event-/.test(name)).sort();
  if (files.length > 1000) throw failure();
  const entries: Entry[] = [];
  for (const [index, name] of files.entries()) {
    if (name !== `event-${String(index).padStart(4, '0')}.json`) throw failure();
    const envelope = JSON.parse(
      (await privateBytes(join(directory, name), 64 * 1024)).toString('utf8'),
    );
    if (envelope.planHash !== hash || typeof envelope.entry?.type !== 'string') throw failure();
    entries.push(envelope.entry);
  }
  let serial = Promise.resolve();
  function exclusive<T>(operation: () => Promise<T>) {
    const next = serial.then(operation);
    serial = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  async function append(entry: Entry) {
    if (entries.length >= 1000 || JSON.stringify(entry).length > 32 * 1024) throw failure();
    await save(join(directory, `event-${String(entries.length).padStart(4, '0')}.json`), {
      planHash: hash,
      at: new Date().toISOString(),
      entry,
    });
    entries.push(structuredClone(entry));
  }
  function record() {
    const entry = entries.findLast((item) => item.type === 'allocation');
    return entry ? allocationSchema.parse(entry.record) : undefined;
  }
  return {
    plan,
    hash,
    entries,
    append: (entry) => exclusive(() => append(entry)),
    store: {
      read: async (ownerId, role) => {
        if (ownerId !== plan.ownerId) throw failure();
        return role === 'computer' ? record() : undefined;
      },
      compareAndSwap: (version, value) =>
        exclusive(async () => {
          const next = allocationSchema.parse(value);
          const previous = record();
          if (
            next.ownerId !== plan.ownerId ||
            next.templateId !== plan.templateId ||
            next.version !== (version ?? 0) + 1 ||
            (previous &&
              (next.generation !== previous.generation ||
                (previous.resourceId && next.resourceId !== previous.resourceId)))
          )
            throw failure();
          if ((previous?.version ?? null) !== version) return false;
          await append({ type: 'allocation', record: next });
          return true;
        }),
    },
  };
}
export function acceptanceMetadata(plan: AcceptancePlan) {
  return {
    otto_acceptance: plan.nonce,
    otto_disposable: 'development',
    otto_owner: sha(plan.ownerId),
    otto_role: 'computer',
  };
}
function owned(info: ResourceInfo, plan: AcceptancePlan, generation: string) {
  const expected = acceptanceMetadata(plan);
  if (
    !identifier.safeParse(info.id).success ||
    info.templateId !== plan.templateId ||
    !['running', 'paused'].includes(info.state) ||
    info.metadata.otto_generation !== generation ||
    Object.entries(expected).some(([key, value]) => info.metadata[key] !== value)
  )
    throw failure();
  return info;
}
export async function inspectAcceptance(journal: AcceptanceJournal, driver: AcceptanceDriver) {
  const allocation = await journal.store.read(journal.plan.ownerId, 'computer');
  const created = journal.entries.find((item) => item.type === 'created');
  if (created) {
    const id = identifier.parse(created.id);
    const info = await driver.inspect(id);
    if (info && info.id !== id) throw failure();
    if (!allocation) throw failure();
    return info ? [owned(info, journal.plan, allocation.generation)] : [];
  }
  if (!journal.entries.some((item) => item.type === 'create-start')) return [];
  if (!allocation) throw failure();
  const found = await driver.find(acceptanceMetadata(journal.plan));
  if (found.length > 1) throw failure();
  return found.map((info) => owned(info, journal.plan, allocation.generation));
}
export async function runAcceptance(
  journal: AcceptanceJournal,
  driver: AcceptanceDriver,
  journey = runAcceptanceJourney,
) {
  const age = Date.now() - Date.parse(journal.plan.createdAt);
  if (journal.entries.length || age < -30_000 || age > 24 * 60 * 60_000) throw failure();
  await journal.append({ type: 'run-start', pid: process.pid });
  let accepting = true;
  let selected: string | undefined;
  let creates = 0;
  const check = () => {
    if (!accepting) throw failure();
  };
  async function inspect(id: string) {
    check();
    if (id !== selected) throw failure();
    const info = await driver.inspect(id);
    if (!info || info.id !== id) throw failure();
    const allocation = await journal.store.read(journal.plan.ownerId, 'computer');
    if (!allocation) throw failure();
    return owned(info, journal.plan, allocation.generation);
  }
  const wrap = (sandbox: Awaited<ReturnType<E2BClient['create']>>) => ({
    id: sandbox.id,
    ready: async () => {
      check();
      await sandbox.ready();
      check();
      await journal.append({ type: 'readiness', id: sandbox.id });
    },
    start: async (input: Parameters<typeof sandbox.start>[0]) => {
      check();
      if (journal.entries.filter((entry) => entry.type === 'command-start').length >= 100)
        throw failure();
      const commandId = randomUUID();
      await journal.append({ type: 'command-start', commandId, role: input.role });
      const command = await sandbox.start(input);
      let waiting: ReturnType<typeof command.wait> | undefined;
      return {
        ...command,
        wait: () =>
          (waiting ??= command.wait().then(async (result) => {
            if (!Number.isSafeInteger(result.exitCode)) throw failure();
            await journal.append({
              type: 'command-complete',
              commandId,
              exitCode: result.exitCode,
            });
            return result;
          })),
      };
    },
    keepAlive: async () => {
      check();
      await sandbox.keepAlive();
    },
    pause: async () => {
      check();
      await journal.append({ type: 'pause-start', id: sandbox.id });
      const result = await sandbox.pause();
      if ((await inspect(sandbox.id)).state !== 'paused') throw failure();
      await journal.append({ type: 'paused', id: sandbox.id });
      return result;
    },
  });
  const client: E2BClient = {
    create: async (template, metadata) => {
      check();
      if (++creates !== 1 || selected || template !== journal.plan.templateId) throw failure();
      await journal.append({ type: 'create-start' });
      const sandbox = await driver.client.create(template, {
        ...metadata,
        ...acceptanceMetadata(journal.plan),
      });
      selected = identifier.parse(sandbox.id);
      await journal.append({ type: 'created', id: selected });
      await inspect(selected);
      return wrap(sandbox);
    },
    connect: async (id) => {
      check();
      await inspect(id);
      await journal.append({ type: 'connect-start', id });
      const sandbox = await driver.client.connect(id);
      if (sandbox.id !== selected) throw failure();
      await journal.append({ type: 'connected', id });
      return wrap(sandbox);
    },
  };
  async function stage<T>(name: string, operation: () => Promise<T>) {
    check();
    await journal.append({ type: 'stage-start', name });
    const result = await operation();
    check();
    await journal.append({ type: 'stage-complete', name });
    return result;
  }
  try {
    await journey({
      plan: journal.plan,
      client,
      store: journal.store,
      stage,
      boundary: async () => {
        if (!selected || (await inspect(selected)).state !== 'running') throw failure();
        const result = await driver.boundary(selected);
        if (result.passed !== true || result.cleanupComplete !== true) throw failure();
        await journal.append({ type: 'boundary', result });
      },
    });
    if (creates !== 1 || !selected || (await inspect(selected)).state !== 'paused') throw failure();
    const record = await journal.store.read(journal.plan.ownerId, 'computer');
    if (
      !record ||
      record.resourceId !== selected ||
      record.leaseId !== null ||
      record.state !== 'ready'
    )
      throw failure();
    const started = journal.entries.filter((entry) => entry.type === 'command-start');
    const completed = journal.entries.filter((entry) => entry.type === 'command-complete');
    if (
      started.length !== completed.length ||
      started.some((entry) => !completed.some((result) => result.commandId === entry.commandId))
    )
      throw failure();
    await journal.append({ type: 'passed', resourceCount: 1, state: 'paused' });
    return { passed: true, resourceCount: 1, cleanupRequired: true };
  } catch {
    accepting = false;
    await journal.append({ type: 'failed', uncertain: true }).catch(() => {});
    throw failure();
  } finally {
    accepting = false;
  }
}
export async function cleanupAcceptance(journal: AcceptanceJournal, driver: AcceptanceDriver) {
  if (!journal.entries.some((item) => item.type === 'run-start')) throw failure();
  if (journal.entries.some((item) => item.type === 'cleanup-start')) throw failure();
  const resources = await inspectAcceptance(journal, driver);
  if (resources.length !== 1) throw failure();
  const id = resources[0]!.id;
  await journal.append({ type: 'cleanup-start', id });
  await driver.kill(id);
  if (await driver.inspect(id)) throw failure();
  await journal.append({ type: 'cleaned', absent: true });
  return { cleaned: true, absent: true };
}
async function lock(directory: string, action: () => Promise<unknown>) {
  const path = join(directory, 'operation.lock');
  await save(path, { pid: process.pid });
  try {
    return await action();
  } finally {
    await unlink(path);
  }
}
export async function acceptanceMain(args: string[]) {
  const [action, envFlag, envPath, dirFlag, directory, hashFlag, hash, liveFlag] = args;
  if (
    !['plan', 'run', 'inspect', 'cleanup'].includes(action ?? '') ||
    envFlag !== '--env' ||
    !envPath ||
    dirFlag !== '--journal' ||
    !directory ||
    (action === 'plan'
      ? args.length !== 5
      : args.length !== 8 ||
        hashFlag !== '--confirm-plan' ||
        !digest.safeParse(hash).success ||
        liveFlag !== '--development-only')
  )
    throw failure();
  if (
    process.env.CI ||
    Object.keys(process.env).some((key) => /^E2B_(DOMAIN|API_URL|SANDBOX_URL|DEBUG)$/.test(key))
  )
    throw failure();
  const configuration = await readDevelopmentConfiguration(envPath);
  const source = await acceptanceSourceHash();
  if (action === 'plan')
    return prepareAcceptance(directory, configuration, source).then((value) => ({
      planHash: value.hash,
      live: false,
    }));
  const journal = await openAcceptance(directory, configuration, hash!, source);
  const { createAcceptanceDriver } = await import('./acceptance-driver.ts');
  const driver = createAcceptanceDriver(configuration.apiKey, journal.plan);
  return lock(directory, async () => {
    if (action === 'run') return runAcceptance(journal, driver);
    if (action === 'cleanup') return cleanupAcceptance(journal, driver);
    const resources = await inspectAcceptance(journal, driver);
    await save(join(directory, `inspection-${randomUUID()}.json`), {
      planHash: journal.hash,
      resources,
    });
    return {
      resourceCount: resources.length,
      state: resources[0]?.state ?? 'not-observed',
      replayAllowed: false,
    };
  });
}
export async function runAcceptanceCli(
  operation: () => Promise<unknown>,
  deadlineMs = 15 * 60_000,
) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 15 * 60_000)
    throw failure();
  const deadline = setTimeout(() => {
    process.stderr.write('The development acceptance deadline expired; inspect its journal.\n');
    process.exit(1);
  }, deadlineMs);
  try {
    process.stdout.write(JSON.stringify(await operation()) + '\n');
  } catch {
    process.stderr.write('The development acceptance needs inspection before continuing.\n');
    process.exitCode = 1;
  } finally {
    deadline.unref();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runAcceptanceCli(() => acceptanceMain(process.argv.slice(2)));
