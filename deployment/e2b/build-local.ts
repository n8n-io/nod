import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { prepareE2BContext } from './context.ts';

const context = await prepareE2BContext({ role: 'computer' });
const image = `otto-e2b-computer:${context.sha256.slice(0, 12)}`;
try {
  await writeFile(`${context.path}/Dockerfile`, context.dockerfile, { mode: 0o600 });
  const child = spawn(
    'docker',
    [
      'buildx',
      'build',
      '--load',
      '--platform',
      'linux/amd64',
      '--tag',
      image,
      '--file',
      `${context.path}/Dockerfile`,
      context.path,
    ],
    {
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          /^(PATH|HOME|TMPDIR|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG)$/.test(key),
        ),
      ),
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) throw new Error('The local combined computer build failed.');
  process.stdout.write(JSON.stringify({ image, sourceSha256: context.sha256 }) + '\n');
} finally {
  await context.close();
}
