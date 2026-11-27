import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const revision = git('rev-parse', 'HEAD') + (git('status', '--porcelain') ? '-dirty' : '');
const targets = process.argv.slice(2);
if (targets.some((target) => !['server', 'workspace', 'browser'].includes(target))) {
  console.error('Usage: node deployment/self-host/build.mjs [server|workspace|browser ...]');
  process.exit(1);
}
const common = {
  context: '.',
  ...(process.env.DOCKER_DEFAULT_PLATFORM && { platforms: [process.env.DOCKER_DEFAULT_PLATFORM] }),
  labels: { 'org.opencontainers.image.revision': revision },
};
const definition = {
  group: { default: { targets: targets.length ? targets : ['server', 'workspace', 'browser'] } },
  target: {
    server: {
      ...common,
      dockerfile: 'deployment/self-host/Dockerfile',
      tags: [`nod-server:${revision}`],
    },
    workspace: {
      ...common,
      dockerfile: 'Dockerfile.workspace',
      tags: [`nod-workspace:${revision}`],
    },
    browser: {
      ...common,
      dockerfile: 'Dockerfile.browser',
      tags: [`nod-browser:${revision}`],
    },
  },
};
const result = spawnSync('docker', ['buildx', 'bake', '--file', '-', '--load'], {
  cwd: root,
  input: JSON.stringify(definition),
  stdio: ['pipe', 'inherit', 'inherit'],
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
