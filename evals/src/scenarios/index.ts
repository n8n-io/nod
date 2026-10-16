import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Scenario } from '../scenario.ts';

const directory = dirname(fileURLToPath(import.meta.url));
const world = join(directory, '../world');
const ids = readdirSync(directory)
  .filter((name) => name.endsWith('.ts') && name !== 'index.ts')
  .map((name) => name.slice(0, -3))
  .sort();

export const scenarios: Scenario[] = await Promise.all(
  ids.map(async (id) => {
    const definition = (await import(`./${id}.ts`)).default as Scenario;
    if (definition.id !== id) throw new Error(`Scenario ${id}.ts must declare id "${id}".`);
    if (!definition.capabilities.length || definition.seconds <= 0)
      throw new Error(`Scenario ${id} needs capabilities and a time limit.`);
    return definition;
  }),
);

function sources(file: string, found: Set<string>) {
  if (found.has(file)) return found;
  found.add(file);
  for (const [, type, path] of readFileSync(file, 'utf8').matchAll(
    /^(?:import|export)\s+(type\s)?[^;]*?'(\.{1,2}\/[^']+\.ts)'/gm,
  )) {
    if (type) continue;
    const target = resolve(dirname(file), path);
    if (dirname(target) === directory || dirname(target) === world) sources(target, found);
  }
  return found;
}

export function fingerprint(id: string) {
  const hash = createHash('sha256');
  for (const file of [...sources(join(directory, `${id}.ts`), new Set())].sort())
    hash.update(relative(directory, file)).update('\0').update(readFileSync(file, 'utf8'));
  return hash.digest('hex').slice(0, 12);
}
