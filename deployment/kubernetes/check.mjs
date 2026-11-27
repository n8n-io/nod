import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'nod-kubernetes-check-'));
const name = `nod-check-${randomUUID()}`;
const kubeconfig = join(scratch, 'kubeconfig');
const tag = process.env.NOD_IMAGE_TAG || 'local';
const images = ['server', 'workspace', 'browser'].map((component) => `nod-${component}:${tag}`);
const token = randomBytes(32).toString('base64url');
const password = randomBytes(32).toString('hex');
const vault = randomBytes(32).toString('base64');
const command = (executable, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      args,
      { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${executable} failed: ${error.message}\n${stderr}`));
        else resolve(stdout);
      },
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
const kube = (args, input) =>
  command('kubectl', ['--kubeconfig', kubeconfig, '--namespace', 'nod', ...args], input);
const env = (values) => Object.entries(values).map(([name, value]) => ({ name, value }));
const resource = (apiVersion, kind, name, body) => ({
  apiVersion,
  kind,
  metadata: { name, namespace: 'nod' },
  ...body,
});
const mount = (mountPath, subPath) => ({ name: 'data', mountPath, subPath });
const restricted = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ['ALL'] },
};
const pod = (name, image, container, extra = {}) =>
  resource('v1', 'Pod', name, {
    spec: {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      restartPolicy: 'Never',
      securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{ name: 'runtime', image, imagePullPolicy: 'Never', ...container }],
      volumes: [
        { name: 'data', persistentVolumeClaim: { claimName: 'data' } },
        { name: 'tmp', emptyDir: {} },
      ],
      ...extra,
    },
  });
try {
  await command('kind', [
    'create',
    'cluster',
    '--name',
    name,
    '--kubeconfig',
    kubeconfig,
    '--wait',
    '120s',
  ]);
  await command('kind', ['load', 'docker-image', '--name', name, ...images]);
  await kube(['create', 'namespace', 'nod']);
  const resources = [
    resource('v1', 'PersistentVolumeClaim', 'data', {
      spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '2Gi' } } },
    }),
    resource('v1', 'ServiceAccount', 'nod-server', {}),
    resource('rbac.authorization.k8s.io/v1', 'Role', 'runtime', {
      rules: [
        {
          apiGroups: [''],
          resources: ['pods'],
          resourceNames: ['nod-workspace-0', 'nod-browser-0'],
          verbs: ['get'],
        },
        {
          apiGroups: [''],
          resources: ['pods/exec'],
          resourceNames: ['nod-workspace-0', 'nod-browser-0'],
          verbs: ['get', 'create'],
        },
      ],
    }),
    resource('rbac.authorization.k8s.io/v1', 'RoleBinding', 'runtime', {
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'runtime' },
      subjects: [{ kind: 'ServiceAccount', name: 'nod-server', namespace: 'nod' }],
    }),
    resource('v1', 'Secret', 'server', {
      stringData: {
        NOD_AUTH_TOKEN: token,
        NOD_VAULT_KEY: vault,
        DATABASE_URL: `postgresql://nod:${password}@postgres:5432/nod`,
      },
    }),
    resource('v1', 'Service', 'postgres', {
      spec: { selector: { app: 'postgres' }, ports: [{ port: 5432 }] },
    }),
    {
      ...resource('v1', 'Pod', 'postgres', {}),
      metadata: { name: 'postgres', namespace: 'nod', labels: { app: 'postgres' } },
      spec: {
        automountServiceAccountToken: false,
        containers: [
          {
            name: 'postgres',
            image:
              'postgres:17-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb',
            env: env({ POSTGRES_USER: 'nod', POSTGRES_DB: 'nod', POSTGRES_PASSWORD: password }),
            readinessProbe: { exec: { command: ['pg_isready', '-U', 'nod'] }, periodSeconds: 2 },
          },
        ],
      },
    },
    pod('prepare', images[1], {
      securityContext: { runAsUser: 0, runAsGroup: 0 },
      command: [
        'sh',
        '-ec',
        'mkdir -p /data/server /data/workspaces /data/home /data/cli /data/browser; chown 1000:1000 /data/server /data/workspaces /data/home /data/browser; chmod 700 /data/server /data/workspaces /data/home /data/browser; chmod 1777 /data/cli',
      ],
      volumeMounts: [mount('/data')],
    }),
  ];
  await kube(
    ['create', '-f', '-'],
    JSON.stringify({ apiVersion: 'v1', kind: 'List', items: resources }),
  );
  await kube(['wait', '--for=jsonpath={.status.phase}=Succeeded', 'pod/prepare', '--timeout=120s']);
  await kube(['wait', '--for=condition=Ready', 'pod/postgres', '--timeout=120s']);
  const workloads = [
    pod('nod-workspace-0', images[1], {
      command: ['sleep', 'infinity'],
      securityContext: {
        ...restricted,
        runAsUser: 0,
        capabilities: { drop: ['ALL'], add: ['SETUID', 'SETGID', 'SETPCAP'] },
      },
      volumeMounts: [
        mount('/workspace', 'workspaces'),
        mount('/home/node', 'home'),
        mount('/var/tmp', 'cli'),
        { name: 'tmp', mountPath: '/tmp' },
      ],
    }),
    pod(
      'nod-browser-0',
      images[2],
      {
        securityContext: { ...restricted, runAsUser: 1000, runAsGroup: 1000 },
        volumeMounts: [
          mount('/data', 'browser'),
          { name: 'tmp', mountPath: '/tmp' },
          { name: 'home', mountPath: '/home/node' },
          { name: 'shm', mountPath: '/dev/shm' },
        ],
        readinessProbe: {
          exec: {
            command: [
              'node',
              '-e',
              'const s=require("node:net").connect("/data/control.sock");s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1))',
            ],
          },
          periodSeconds: 2,
        },
      },
      {
        securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
        volumes: [
          { name: 'data', persistentVolumeClaim: { claimName: 'data' } },
          { name: 'tmp', emptyDir: {} },
          { name: 'home', emptyDir: {} },
          { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '512Mi' } },
        ],
      },
    ),
    pod(
      'nod-server',
      images[0],
      {
        securityContext: { ...restricted, runAsUser: 1000, runAsGroup: 1000 },
        envFrom: [{ secretRef: { name: 'server' } }],
        env: env({
          NOD_RUNTIME: 'kubernetes',
          NOD_KUBERNETES_NAMESPACE: 'nod',
          NOD_PUBLIC_URL: 'http://localhost:4310',
          NOD_ANALYTICS_ENABLED: 'false',
          NOD_FEEDBACK_ENABLED: 'false',
          NOD_COMPOSIO_PROXY_URL: '',
          TELEGRAM_ENABLED: 'false',
          WHATSAPP_ENABLED: 'false',
        }),
        volumeMounts: [
          mount('/var/lib/nod', 'server'),
          mount('/var/lib/nod/workspaces', 'workspaces'),
          { name: 'tmp', mountPath: '/tmp' },
        ],
        readinessProbe: {
          exec: { command: ['node', '/app/healthcheck.mjs'] },
          timeoutSeconds: 10,
          periodSeconds: 5,
        },
      },
      { serviceAccountName: 'nod-server', automountServiceAccountToken: true },
    ),
  ];
  await kube(
    ['create', '-f', '-'],
    JSON.stringify({ apiVersion: 'v1', kind: 'List', items: workloads }),
  );
  await kube([
    'wait',
    '--for=condition=Ready',
    'pod/nod-workspace-0',
    'pod/nod-browser-0',
    'pod/nod-server',
    '--timeout=180s',
  ]);
  const probe = async () => {
    const { default: assert } = await import('node:assert/strict');
    const { execFileSync } = await import('node:child_process');
    const { randomUUID } = await import('node:crypto');
    const { mkdir, readFile, rm } = await import('node:fs/promises');
    const { setTimeout: delay } = await import('node:timers/promises');
    const { createDefaultAdapters } = await import('/app/src/server/composition.ts');
    const { pool } = await import('/app/src/server/db.ts');
    const id = randomUUID();
    const root = '/var/lib/nod/workspaces';
    await mkdir(`${root}/${id}`, { mode: 0o700 });
    const adapters = createDefaultAdapters(process.env);
    const { workspace, computer: browser } = adapters;
    try {
      const session = workspace.open({
        threadId: id,
        workspacePath: `${root}/${id}`,
        signal: AbortSignal.timeout(120_000),
      });
      let output = '';
      const result = await session.exec(
        'id -u; grep -E "^(CapEff|CapBnd|NoNewPrivs):" /proc/self/status; printf stderr >&2; exit 37',
        {
          onData: (chunk) => {
            output += chunk;
          },
        },
      );
      assert.equal(result.exitCode, 37);
      assert.match(output, /^1000\n/);
      assert.match(output, /CapEff:\s+0000000000000000/);
      assert.match(output, /CapBnd:\s+0000000000000000/);
      assert.match(output, /NoNewPrivs:\s+1/);
      assert.match(output, /stderr/);
      assert.equal(
        (
          await session.exec(
            'test -z "$NOD_AUTH_TOKEN" && test -z "$NOD_VAULT_KEY" && test ! -e /var/run/secrets/kubernetes.io/serviceaccount/token && test ! -S /var/run/docker.sock',
          )
        ).exitCode,
        0,
      );
      const bytes = Buffer.from([0, 255, 17, 128, 42]);
      await workspace.writeArtifact(id, 'nested/test.bin', bytes);
      assert.deepEqual(Buffer.from(await workspace.readArtifact(id, 'nested/test.bin', 5)), bytes);
      assert.deepEqual(await readFile(`${root}/${id}/nested/test.bin`), bytes);
      await assert.rejects(workspace.readArtifact(id, 'nested/test.bin', 4));
      const controller = new AbortController();
      let ready;
      const started = new Promise((resolve) => {
        ready = resolve;
      });
      const running = session.exec(
        `python3 -c 'import os,time; p=os.fork(); os.setsid() if p==0 else None; print("ready",flush=True) if p else None; time.sleep(3); open("escaped", "w").write("bad")'`,
        {
          signal: controller.signal,
          onData: (chunk) => {
            if (chunk.toString().includes('ready')) ready();
          },
        },
      );
      const cancelled = assert.rejects(running, /cancelled/);
      await started;
      controller.abort();
      await cancelled;
      await delay(4000);
      assert.equal((await session.exec('test ! -e escaped')).exitCode, 0);
      for (const args of [
        ['get', 'secrets'],
        ['get', 'secret/server', '-o', 'name'],
        ['get', 'pods'],
        ['exec', 'nod-server', '--', 'true'],
      ])
        assert.throws(
          () => execFileSync('kubectl', ['-n', 'nod', ...args], { stdio: 'pipe' }),
          /Forbidden|forbidden/,
        );
      for (const name of ['nod-workspace-0', 'nod-browser-0', 'nod-server']) {
        for (const verb of ['get', 'create']) {
          const review = JSON.parse(
            execFileSync(
              'kubectl',
              [
                'create',
                '--raw',
                '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews',
                '-f',
                '-',
              ],
              {
                encoding: 'utf8',
                input: JSON.stringify({
                  apiVersion: 'authorization.k8s.io/v1',
                  kind: 'SelfSubjectAccessReview',
                  spec: {
                    resourceAttributes: {
                      namespace: 'nod',
                      verb,
                      group: '',
                      resource: 'pods',
                      subresource: 'exec',
                      name,
                    },
                  },
                }),
              },
            ),
          );
          assert.equal(review.status.allowed, name !== 'nod-server', `${verb} pods/${name}/exec`);
        }
      }
      const page = await browser.act(id, { action: 'open', url: 'https://example.com/' });
      assert.equal(new URL(page.url).hostname, 'example.com');
      assert.match(page.text, /This domain is for use in documentation examples/);
      await browser.act(id, {
        action: 'evaluate',
        script:
          'const button=document.createElement("button");button.textContent="Check";button.onclick=()=>{button.textContent="12345"};document.body.replaceChildren(button)',
      });
      await browser.act(id, { action: 'click', selector: 'button' });
      assert.match((await browser.act(id, { action: 'snapshot' })).text, /12345/);
      assert.ok((await browser.screenshot(id)).length > 1000);
      const request = (token) =>
        fetch('http://localhost:4310/api/session', {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
      assert.equal((await request()).status, 401);
      assert.equal((await request('synthetic-invalid-token')).status, 401);
      assert.equal((await request(process.env.NOD_AUTH_TOKEN)).status, 200);
      console.log(
        'PASS Kubernetes startup, authentication, workspace identity, binary files, cancellation, token isolation, restricted RBAC, and Chromium interaction.',
      );
    } finally {
      await browser.dispose();
      await workspace.dispose();
      await adapters.models?.close();
      await adapters.integrationBrowser?.close();
      await adapters.passwordManager?.close();
      await adapters.localSpeech?.close();
      await adapters.telemetry?.shutdown();
      await pool.end();
      await rm(`${root}/${id}`, { recursive: true, force: true });
    }
  };
  console.log(
    await kube(
      ['exec', '-i', 'nod-server', '--', 'node', '--import', 'tsx', '--input-type=module'],
      `await (${probe.toString()})();`,
    ),
  );
  const logs = await kube(['logs', 'nod-server']);
  for (const secret of [token, password, vault]) assert.ok(!logs.includes(secret));
} finally {
  try {
    await command('kind', ['delete', 'cluster', '--name', name, '--kubeconfig', kubeconfig]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
