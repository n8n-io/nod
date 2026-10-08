import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const image = process.argv[2];
if (!image || !/^[a-z0-9][a-z0-9._/:@-]+$/.test(image) || process.argv.length !== 3)
  throw new Error('Provide a locally built combined computer image.');
const name = `otto-e2b-boundary-${randomUUID()}`;
const rejectedName = `${name}-rejected`;
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => /^(PATH|HOME|DOCKER_CONFIG|TMPDIR)$/.test(key)),
);
function docker(args, allowFailure = false) {
  const result = spawnSync('docker', args, {
    env: environment,
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 1024 * 1024,
  });
  if (!allowFailure && (result.error || result.status !== 0))
    throw new Error('The isolated computer boundary check failed.');
  return result;
}
try {
  docker(['image', 'inspect', image]);
  const rejected = docker(
    [
      'run',
      '--platform',
      'linux/amd64',
      '--rm',
      '--name',
      rejectedName,
      '--network',
      'none',
      '--entrypoint',
      'python3',
      image,
      '/opt/otto/computer-guard.py',
      'start',
    ],
    true,
  );
  if (rejected.status !== 1 || rejected.stderr.trim() !== 'The private computer is not ready.')
    throw new Error('A computer without network administration must fail closed.');
  docker([
    'run',
    '--platform',
    'linux/amd64',
    '--detach',
    '--name',
    name,
    '--cap-add',
    'NET_ADMIN',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '256',
    '--memory',
    '3g',
    '--network',
    'bridge',
    '--entrypoint',
    '/bin/sh',
    image,
    '-c',
    'ip address add 169.254.169.254/32 dev lo && ip -6 address add fd00:ec2::254/128 dev lo && exec python3 /opt/otto/computer-guard.py start',
  ]);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const ready = docker(
      ['exec', '--user', 'root', name, 'python3', '/opt/otto/computer-guard.py', 'check'],
      true,
    );
    if (ready.status === 0 && ready.stdout === '{"ready":true}\n' && ready.stderr === '') break;
    if (Date.now() >= deadline) throw new Error('The isolated computer did not become ready.');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  docker([
    'cp',
    fileURLToPath(new URL('./computer-boundary.py', import.meta.url)),
    `${name}:/tmp/otto-boundary.py`,
  ]);
  const result = docker(['exec', '--user', 'root', name, 'python3', '/tmp/otto-boundary.py'], true);
  if (result.error || result.status !== 0) {
    let check = 'unknown';
    try {
      const failure = JSON.parse(result.stdout);
      if (
        failure.passed === false &&
        typeof failure.check === 'string' &&
        /^(xauthority-creation|chromium-exited|xvfb-exited|browser-readiness|browser-network-[0-5]|workspace-network-[0-5]|connected-network-[0-5]|workspace-private-[0-7]|connected-private-[0-7]|connected-home-write|workspace-connected-home-denied|connected-cli|connected-cli-planted|workspace-firewall|workspace-x11|workspace-files-dns-privileges|workspace-https|unchanged-firewall-readiness|changed-firewall-readiness|fixture-error)$/.test(
          failure.check,
        )
      )
        check = failure.check;
    } catch {}
    throw new Error(`The isolated computer boundary check failed (${check}).`);
  }
  process.stdout.write(result.stdout);
} finally {
  docker(['rm', '--force', rejectedName], true);
  docker(['rm', '--force', name], true);
}
