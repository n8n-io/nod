import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { create } from 'tar';
import { copyBundleSource } from '../scripts/engine-dependencies.mjs';
import {
  assetHash,
  ensureRuntimeAssets,
  findRuntimeAssets,
  installRuntimeArchive,
} from '../runtime/assets.mjs';

test('bundle copy includes explicit release assets under .local while excluding private descendants', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'otto-bundle-copy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, '.local', 'release');
  const target = join(root, 'bundle');
  await mkdir(join(source, '.local'), { recursive: true });
  await mkdir(target);
  await writeFile(join(source, 'runtime-release.json'), '{"synthetic":true}');
  await writeFile(join(source, 'runtime.tar.gz'), 'synthetic archive');
  await writeFile(join(source, '.env'), 'SYNTHETIC_PRIVATE=value');
  await writeFile(join(source, '.local', 'state.json'), '{"syntheticPrivate":true}');
  for (const file of ['runtime-release.json', 'runtime.tar.gz']) {
    await copyBundleSource(join(source, file), join(target, file));
    assert.equal(await assetHash(join(target, file)), await assetHash(join(source, file)));
  }
  await copyBundleSource(source, join(target, 'tree'));
  assert.deepEqual((await readdir(join(target, 'tree'))).sort(), [
    'runtime-release.json',
    'runtime.tar.gz',
  ]);
});

async function fixture(t, extra) {
  const root = await mkdtemp(join(tmpdir(), 'otto-runtime-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const resourcesPath = join(root, 'resources');
  const cacheRoot = join(root, 'cache');
  await mkdir(source);
  await mkdir(resourcesPath);
  const files = [];
  for (const path of [
    'manifest.json',
    'lima/bin/limactl',
    'docker-host/docker/docker',
    'docker-guest.tar.gz',
    'lima/share/lima/lima-guestagent.Linux-aarch64.gz',
  ]) {
    const target = join(source, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `Synthetic fixture ${path}`);
    files.push({
      path,
      bytes: (await stat(target)).size,
      mode: 0o644,
      sha256: await assetHash(target),
    });
  }
  const entries = files.map((file) => file.path);
  if (extra) entries.push(...(await extra({ root, source })));
  const archivePath = join(root, 'runtime.tar.gz');
  await create(
    {
      cwd: source,
      file: archivePath,
      portable: true,
      noMtime: true,
      gzip: true,
      preservePaths: true,
    },
    entries,
  );
  const release = {
    version: 1,
    platform: 'darwin-arm64',
    id: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    archive: { bytes: (await stat(archivePath)).size, sha256: await assetHash(archivePath) },
    files,
  };
  await writeFile(join(resourcesPath, 'runtime-release.json'), JSON.stringify(release));
  return { root, source, archivePath, resourcesPath, cacheRoot, release };
}

test('runtime archive installs atomically and detects a modified executable before reuse', async (t) => {
  const options = await fixture(t);
  const installed = await installRuntimeArchive(options);
  assert.equal(await findRuntimeAssets(options), installed);
  assert.equal(
    await readFile(join(installed, 'lima/bin/limactl'), 'utf8'),
    'Synthetic fixture lima/bin/limactl',
  );
  assert.deepEqual(await readdir(options.cacheRoot), [options.release.id]);
  await writeFile(join(installed, 'lima/bin/limactl'), 'changed');
  assert.equal(await findRuntimeAssets(options), undefined);
  assert.equal(await installRuntimeArchive(options), installed);
  assert.equal(await findRuntimeAssets(options), installed);
});

test('runtime archive hash mismatch never installs files', async (t) => {
  const options = await fixture(t);
  const bytes = await readFile(options.archivePath);
  bytes[30] ^= 1;
  await writeFile(options.archivePath, bytes);
  await assert.rejects(installRuntimeArchive(options), /does not match/);
  assert.equal(await findRuntimeAssets(options), undefined);
});

test('runtime extraction rejects traversal without changing files outside its staging directory', async (t) => {
  const options = await fixture(t, async ({ root }) => {
    await writeFile(join(root, 'outside.txt'), 'unchanged');
    return ['../outside.txt'];
  });
  await assert.rejects(installRuntimeArchive(options));
  assert.equal(await readFile(join(options.root, 'outside.txt'), 'utf8'), 'unchanged');
  assert.deepEqual(await readdir(options.cacheRoot), []);
});

test('runtime extraction rejects symlinks and unexpected files', async (t) => {
  const options = await fixture(t, async ({ source }) => {
    await symlink('/tmp/otto-outside-fixture', join(source, 'unexpected'));
    return ['unexpected'];
  });
  await assert.rejects(installRuntimeArchive(options), /unexpected files/);
  assert.deepEqual(await readdir(options.cacheRoot), []);
});

test('runtime extraction bounds decompressed content before unexpected data can fill storage', async (t) => {
  const options = await fixture(t, async ({ source }) => {
    await writeFile(join(source, 'oversized'), Buffer.alloc(2 * 1024 * 1024));
    return ['oversized'];
  });
  await assert.rejects(installRuntimeArchive(options), /expected expanded size/);
  assert.deepEqual(await readdir(options.cacheRoot), []);
});

test('missing runtime release requests the companion pack without inventing a download endpoint', async (t) => {
  const options = await fixture(t);
  await assert.rejects(ensureRuntimeAssets(options), { code: 'RUNTIME_ARCHIVE_REQUIRED' });
  await assert.rejects(installRuntimeArchive({ ...options, signal: AbortSignal.abort() }));
  assert.equal(await findRuntimeAssets(options), undefined);
});

test('runtime installation refuses insufficient storage without removing saved caches and can retry', async (t) => {
  const options = await fixture(t);
  const saved = join(options.cacheRoot, 'previous-runtime');
  await mkdir(saved, { recursive: true });
  await writeFile(join(saved, 'saved'), 'preserved');
  const archiveHash = await assetHash(options.archivePath);
  await assert.rejects(
    installRuntimeArchive({
      ...options,
      inspectDisk: async () => ({ bavail: 0n, bsize: 4096n }),
    }),
    { code: 'RUNTIME_DISK_SPACE' },
  );
  assert.deepEqual(await readdir(options.cacheRoot), ['previous-runtime']);
  assert.equal(await readFile(join(saved, 'saved'), 'utf8'), 'preserved');
  assert.equal(await assetHash(options.archivePath), archiveHash);
  const installed = await installRuntimeArchive({
    ...options,
    inspectDisk: async () => ({ bavail: 1024n ** 3n, bsize: 4096n }),
  });
  assert.equal(await findRuntimeAssets(options), installed);
  assert.equal(await readFile(join(saved, 'saved'), 'utf8'), 'preserved');
});

test('verified runtime reuse requires no additional free storage', async (t) => {
  const options = await fixture(t);
  const installed = await installRuntimeArchive(options);
  assert.equal(
    await ensureRuntimeAssets({
      ...options,
      inspectDisk: async () => {
        throw new Error('Storage inspection must not run for a verified cache.');
      },
    }),
    installed,
  );
});

test('runtime download reserves both its archive and extracted files before requesting bytes', async (t) => {
  const options = await fixture(t);
  options.release.url = 'https://runtime.example.invalid/fixture.tar.gz';
  await writeFile(
    join(options.resourcesPath, 'runtime-release.json'),
    JSON.stringify(options.release),
  );
  const expanded = options.release.files.reduce((total, file) => total + file.bytes, 0);
  const available = expanded + 512 * 1024 ** 2 + options.release.archive.bytes - 1;
  const request = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('The runtime must not download without sufficient storage.');
  });
  await assert.rejects(
    ensureRuntimeAssets({
      ...options,
      inspectDisk: async () => ({ bavail: BigInt(available), bsize: 1n }),
    }),
    { code: 'RUNTIME_DISK_SPACE' },
  );
  assert.equal(request.mock.callCount(), 0);
  assert.deepEqual(await readdir(options.cacheRoot), []);
});

test('runtime rechecks storage after downloading and removes only its incomplete installation', async (t) => {
  const options = await fixture(t);
  options.release.url = 'https://runtime.example.invalid/fixture.tar.gz';
  await writeFile(
    join(options.resourcesPath, 'runtime-release.json'),
    JSON.stringify(options.release),
  );
  const saved = join(options.cacheRoot, 'previous-runtime');
  await mkdir(saved, { recursive: true });
  await writeFile(join(saved, 'saved'), 'preserved');
  const bytes = await readFile(options.archivePath);
  const request = t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  let inspections = 0;
  await assert.rejects(
    ensureRuntimeAssets({
      ...options,
      inspectDisk: async () => ({
        bavail: inspections++ === 0 ? 1024n ** 3n : 0n,
        bsize: 4096n,
      }),
    }),
    { code: 'RUNTIME_DISK_SPACE' },
  );
  assert.equal(inspections, 2);
  assert.equal(request.mock.callCount(), 1);
  assert.deepEqual(await readdir(options.cacheRoot), ['previous-runtime']);
  assert.equal(await readFile(join(saved, 'saved'), 'utf8'), 'preserved');
  assert.equal(await findRuntimeAssets(options), undefined);
});

test('runtime download rejects an insecure redirect without fetching it or leaving partial bytes', async (t) => {
  const options = await fixture(t);
  options.release.url = 'https://runtime.example.invalid/fixture.tar.gz';
  await writeFile(
    join(options.resourcesPath, 'runtime-release.json'),
    JSON.stringify(options.release),
  );
  const request = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(null, { status: 302, headers: { location: 'http://unsafe.invalid' } }),
  );
  await assert.rejects(ensureRuntimeAssets(options), /unsafe runtime download address/);
  assert.equal(request.mock.callCount(), 1);
  assert.deepEqual(await readdir(options.cacheRoot), []);
});

test('runtime download rejects corrupt bytes, cleans its download and allows a verified retry', async (t) => {
  const options = await fixture(t);
  options.release.url = 'https://runtime.example.invalid/fixture.tar.gz';
  await writeFile(
    join(options.resourcesPath, 'runtime-release.json'),
    JSON.stringify(options.release),
  );
  const bytes = await readFile(options.archivePath);
  const corrupt = Buffer.from(bytes);
  corrupt[30] ^= 1;
  const request = t.mock.method(globalThis, 'fetch', async () => new Response(corrupt));
  await assert.rejects(ensureRuntimeAssets(options), /does not match/);
  assert.deepEqual(await readdir(options.cacheRoot), []);
  request.mock.mockImplementation(async () => new Response(bytes));
  const installed = await ensureRuntimeAssets(options);
  assert.equal(await findRuntimeAssets(options), installed);
  assert.deepEqual(await readdir(options.cacheRoot), [options.release.id]);
});

test(
  'workload firewall refresh blocks private TCP traffic without interrupting public connections',
  {
    skip:
      process.env.OTTO_TEST_RUNTIME_NETWORK !== '1' ||
      process.platform !== 'linux' ||
      process.getuid?.() !== 0,
  },
  async (t) => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { protectNetworks } = await import('../runtime/guest-config.mjs');
    const root = await mkdtemp(join(tmpdir(), 'otto-firewall-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'firewall'), protectNetworks);
    await writeFile(
      join(root, 'probe.py'),
      String.raw`import json, os, select, socket, subprocess, sys, time
from pathlib import Path
root = Path(sys.argv[1])
def run(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True)
for name, interface, network in [('workload', 'otto-workspace', '172.31.81'), ('target', 'otto-fixture', '10.70.0')]:
    run('ip', 'netns', 'add', name)
    run('ip', '-n', name, 'link', 'set', 'lo', 'up')
    run('ip', 'link', 'add', interface, 'type', 'veth', 'peer', 'name', name)
    run('ip', 'link', 'set', name, 'netns', name)
    run('ip', 'addr', 'add', network+'.1/24', 'dev', interface)
    run('ip', 'link', 'set', interface, 'up')
    run('ip', '-n', name, 'addr', 'add', network+'.2/24', 'dev', name)
    run('ip', '-n', name, 'link', 'set', name, 'up')
    run('ip', '-n', name, 'route', 'add', 'default', 'via', network+'.1')
run('ip', '-n', 'target', 'addr', 'add', '93.184.216.34/32', 'dev', 'target')
run('ip', 'route', 'add', '93.184.216.34/32', 'via', '10.70.0.2')
run('sysctl', '-w', 'net.ipv4.ip_forward=1')
run('iptables', '-N', 'DOCKER-USER')
run('iptables', '-A', 'FORWARD', '-j', 'DOCKER-USER')
server = subprocess.Popen(['ip', 'netns', 'exec', 'target', 'python3', '-u', '-c', '''
import socketserver
class Echo(socketserver.StreamRequestHandler):
    def handle(self):
        while line := self.rfile.readline():
            self.wfile.write(line)
            self.wfile.flush()
server = socketserver.ThreadingTCPServer(('0.0.0.0',19090), Echo)
print('ready', flush=True)
server.serve_forever()
'''], stdout=subprocess.PIPE, text=True)
assert server.stdout.readline().strip() == 'ready'
clients = []
def connect(address):
    process = subprocess.Popen(['ip', 'netns', 'exec', 'workload', 'python3', '-u', '-c', '''
import json, socket, sys
try:
    connection = socket.create_connection((sys.argv[1],19090), timeout=0.5)
except OSError:
    print('false', flush=True)
    sys.exit()
print('true', flush=True)
for line in sys.stdin:
    try:
        connection.sendall(line.encode())
        print(json.dumps(connection.recv(4096) == line.encode()), flush=True)
    except OSError:
        print('false', flush=True)
''', address], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    clients.append(process)
    assert select.select([process.stdout], [], [], 3)[0]
    return process, json.loads(process.stdout.readline())
def echo(process):
    process.stdin.write('synthetic-probe\n')
    process.stdin.flush()
    assert select.select([process.stdout], [], [], 3)[0]
    return json.loads(process.stdout.readline())
try:
    prior_private, connected = connect('10.70.0.2')
    assert connected and echo(prior_private)
    run('bash', str(root/'firewall'))
    assert not echo(prior_private), 'Existing forbidden private connection survived protection'
    assert not connect('10.70.0.2')[1]
    public, connected = connect('93.184.216.34')
    assert connected and echo(public)
    wrapper = root/'bin'
    wrapper.mkdir()
    for name in ['iptables', 'iptables-restore']:
        executable = run('which', name).stdout.strip()
        (wrapper/name).write_text('#!/bin/bash\n'+(
            'cat > "$OTTO_PROBE/transaction"\ntouch "$OTTO_PROBE/paused"\nwhile [ ! -f "$OTTO_PROBE/released" ]; do sleep 0.01; done\nexec '+executable+' "$@" < "$OTTO_PROBE/transaction"\n'
            if name == 'iptables-restore' else
            executable+' "$@"\nresult=$?\nif [ "$1" = -F ] && [ "$2" = OTTO-WORKLOADS ]; then\ntouch "$OTTO_PROBE/paused"\nwhile [ ! -f "$OTTO_PROBE/released" ]; do sleep 0.01; done\nfi\nexit "$result"\n'))
        (wrapper/name).chmod(0o755)
    refresh = subprocess.Popen(['bash', str(root/'firewall')], env={**os.environ, 'PATH':str(wrapper)+':'+os.environ['PATH'], 'OTTO_PROBE':str(root)})
    deadline = time.monotonic()+5
    while not (root/'paused').exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert (root/'paused').exists()
    try:
        assert not connect('10.70.0.2')[1], 'Private TCP connection opened during refresh'
        assert echo(public), 'Public response traffic stopped during refresh'
    finally:
        (root/'released').touch()
        assert refresh.wait(timeout=5) == 0
    assert not connect('10.70.0.2')[1]
    assert echo(public)
    print(json.dumps({'privateBlocked':True, 'publicPreserved':True, 'oldPrivateRevoked':True}))
finally:
    for process in clients+[server]:
        process.terminate()
        process.wait(timeout=3)
`,
    );
    const { stdout } = await promisify(execFile)(
      'unshare',
      [
        '--fork',
        '--kill-child=KILL',
        '--pid',
        '--mount-proc',
        '--net',
        '--mount',
        'bash',
        '-euc',
        'mount --make-rprivate /; mkdir -p /run/netns; mount -t tmpfs tmpfs /run/netns; exec python3 "$1/probe.py" "$1"',
        'otto-firewall-fixture',
        root,
      ],
      {
        timeout: 30_000,
        env: { PATH: process.env.PATH, LANG: 'C' },
      },
    );
    assert.deepEqual(JSON.parse(stdout), {
      privateBlocked: true,
      publicPreserved: true,
      oldPrivateRevoked: true,
    });
  },
);
