import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createDesktopAnalytics(path, { packaged = false, env = process.env } = {}) {
  let configuration;
  return () => {
    configuration ??= (async () => {
      let id = env.NOD_ANALYTICS_ID;
      if (id && !uuid.test(id)) throw new Error('The analytics installation ID is invalid.');
      if (!id) {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.pending`;
        try {
          await writeFile(temporary, randomUUID(), { flag: 'wx', mode: 0o600 });
          await link(temporary, path).catch((error) => {
            if (error.code !== 'EEXIST') throw error;
          });
        } finally {
          await rm(temporary, { force: true });
        }
        id = (await readFile(path, 'utf8')).trim();
        if (!uuid.test(id)) throw new Error('The analytics installation ID is invalid.');
      }
      return {
        enabled:
          env.NOD_ANALYTICS_ENABLED === 'true' ||
          (env.NOD_ANALYTICS_ENABLED !== 'false' && packaged),
        distinctId: `local:${id.toLowerCase()}`,
      };
    })();
    return configuration;
  };
}
