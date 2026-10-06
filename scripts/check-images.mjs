import { readFile } from 'node:fs/promises';

const images = [
  'Dockerfile.workspace',
  'deployment/cloudflare/Dockerfile.workspace',
  'deployment/e2b/Dockerfile.workspace',
  'deployment/e2b/Dockerfile.computer',
];

function contents(text) {
  const source = text.replaceAll('\\\n', ' ');
  const apt = source.match(/apt-get install -y --no-install-recommends ([^&]+)&&/)?.[1] ?? '';
  const pip = [...source.matchAll(/\/bin\/pip install --no-cache-dir ([^\n&]+)/g)].map((match) =>
    match[1].trim(),
  );
  return { apt: new Set(apt.split(/\s+/).filter(Boolean)), pip };
}

const [reference, ...others] = await Promise.all(
  images.map(async (path) => ({ path, ...contents(await readFile(path, 'utf8')) })),
);
const failures = others.flatMap(({ path, apt, pip }) => [
  ...[...reference.apt].filter((name) => !apt.has(name)).map((name) => `${path} lacks ${name}`),
  ...reference.pip.filter((spec) => !pip.includes(spec)).map((spec) => `${path} lacks ${spec}`),
]);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Workspace images match.');
