import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Scenario } from '../scenario.ts';

const directory = dirname(fileURLToPath(import.meta.url));
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

export function fingerprint(id: string) {
  const world = join(directory, '../world');
  return createHash('sha256')
    .update(readFileSync(join(directory, `${id}.ts`), 'utf8'))
    .update(
      JSON.stringify(
        readdirSync(world)
          .filter((name) => name.endsWith('.ts'))
          .sort()
          .map((name) => [name, readFileSync(join(world, name), 'utf8')]),
      ),
    )
    .digest('hex')
    .slice(0, 12);
}
