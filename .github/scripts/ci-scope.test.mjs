import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { selectChecks, selectDesktopTests } from './ci-scope.mjs';
import { readTimings, orderTests } from './ci-tests.mjs';

const ciWorkflow = parse(await readFile(new URL('../workflows/ci.yml', import.meta.url), 'utf8'));
const requireChecks = (needs) =>
  new Function(
    'process',
    ciWorkflow.jobs.checks.steps.find((step) => step.name === 'Require valid check selection').run,
  )({
    env: { CI_SCOPE_RESULT: needs.scope?.result, CI_SCOPE: JSON.stringify(needs.scope?.outputs) },
  });

const enabled = (paths) =>
  Object.entries(selectChecks(paths))
    .filter(([, value]) => value === true)
    .map(([name]) => name)
    .sort();

test('text and media changes do not select application tests or native checks', () => {
  assert.deepEqual(enabled(['README.md', 'AGENTS.md', 'docs/src/content/docs/use/chat.md']), []);
  assert.deepEqual(enabled(['public/logos/nod.svg', 'src/web/styles.css']), ['build', 'types']);
  assert.deepEqual(enabled(['src/web/components/message.tsx']), ['build', 'integration', 'types']);
  assert.equal(selectChecks(['src/web/components/message.tsx']).testMode, 'all');
});

test('test-only changes select those files without image or platform checks', () => {
  const paths = ['tests/pi.test.ts', 'tests/thread.test.ts'];
  assert.deepEqual(enabled(paths), ['integration', 'types']);
  assert.deepEqual(selectChecks(paths).testFiles, paths);
  assert.equal(selectChecks(paths).testMode, 'changed');
  assert.equal(selectChecks(['tests/fixtures/composio-defaults.mts']).testMode, 'all');
});

test('server changes select affected Linux tests without native checks', () => {
  assert.deepEqual(enabled(['src/server/thread.ts']), ['evals', 'integration', 'types']);
  assert.equal(selectChecks(['src/server/thread.ts', 'tests/pi.test.ts']).testMode, 'affected');
  assert.equal(selectChecks(['src/web/app.tsx', 'src/server/thread.ts']).testMode, 'all');
  assert.equal(selectChecks(['src/server/thread.ts', 'src/web/app.tsx']).testMode, 'all');
});

test('container and native checks follow their inputs', () => {
  assert.equal(selectChecks(['src/providers/docker/index.ts']).images, true);
  assert.equal(selectChecks(['src/providers/agent-browser/index.ts']).images, true);
  assert.equal(selectChecks(['src/providers/composio/identity.ts']).macos, true);
  assert.equal(selectChecks(['src/server/vault-crypto.ts']).windows, true);
  assert.equal(selectChecks(['desktop/main/settings.mjs']).macos, true);
  assert.equal(selectChecks(['desktop/main/settings.mjs']).windows, true);
  assert.equal(selectChecks(['desktop/runtime/database.mjs']).windows, true);
  assert.equal(selectChecks(['desktop/ui/setup.tsx']).macos, false);
  assert.equal(selectChecks(['desktop/runtime/index.mjs']).network, true);
  assert.equal(selectChecks(['desktop/runtime/index.mjs']).desktop, true);
  assert.equal(selectChecks(['desktop/runtime/index.mjs']).integration, false);
  for (const name of ['worker.ts', 'audio-codec-worker.ts', 'phonemizer-worker.ts'])
    assert.equal(selectChecks([`src/providers/synthetic/${name}`]).testMode, 'all');
  for (const name of ['workerpool.ts', 'workerless.ts', 'networkworker.ts'])
    assert.equal(selectChecks([`src/providers/synthetic/${name}`]).testMode, 'affected');
  assert.equal(selectChecks(['deployment/n8n/install.ps1']).windows, true);
  assert.deepEqual(enabled(['evals/src/cli.ts']), ['evals']);
});

test('application changes do not select desktop release and runtime fixtures', () => {
  const files = [
    'desktop/test/settings.test.mjs',
    'desktop/test/notifications.test.mjs',
    'desktop/test/runtime-assets.test.mjs',
    'desktop/test/linux-release.test.mjs',
  ];
  assert.deepEqual(
    selectDesktopTests(['src/shared/model.ts', 'tests/pi.test.ts'], files),
    files.slice(0, 2),
  );
  assert.deepEqual(
    selectDesktopTests(['src/web/app.tsx', 'src/shared/model.ts'], files),
    files.slice(0, 2),
  );
  for (const path of [
    'desktop/main/app.mjs',
    'desktop/preload/index.mjs',
    'deployment/self-host/docker-proxy.mjs',
  ]) {
    assert.equal(selectChecks([path]).integration, true);
    assert.equal(selectChecks([path]).testMode, 'all');
  }
  for (const paths of [
    null,
    ['desktop/runtime/index.mjs'],
    ['src/providers/docker/index.ts'],
    ['.github/workflows/ci.yml'],
    ['package.json'],
  ])
    assert.deepEqual(selectDesktopTests(paths, files), files);
});

test('unknown inputs, dependency changes and CI selection changes run all checks', () => {
  const full = enabled(null);
  for (const path of [
    'unknown/file',
    'package.json',
    'pnpm-lock.yaml',
    'patches/new.patch',
    '.github/workflows/ci.yml',
    '.github/scripts/ci-scope.mjs',
  ])
    assert.deepEqual(enabled([path]), full);
});

function results(paths) {
  const scope = selectChecks(paths);
  const outputs = Object.fromEntries(
    Object.entries(scope)
      .filter(([, value]) => typeof value === 'boolean')
      .map(([name, value]) => [name, String(value)]),
  );
  return { scope: { result: 'success', outputs } };
}

test('the required result rejects failed selection and missing scope flags', () => {
  for (const paths of [[], ['src/web/app.tsx'], ['src/server/thread.ts'], null])
    assert.doesNotThrow(() => requireChecks(results(paths)));
  for (const result of ['failure', 'cancelled', 'skipped']) {
    const needs = results(null);
    needs.scope.result = result;
    assert.throws(() => requireChecks(needs), /could not select/);
  }
  assert.throws(() => requireChecks({}), /could not select/);
  for (const name of enabled(null)) {
    const needs = results(null);
    delete needs.scope.outputs[name];
    assert.throws(() => requireChecks(needs), /scope is missing or invalid/);
    needs.scope.outputs[name] = 'invalid';
    assert.throws(() => requireChecks(needs), /scope is missing or invalid/);
  }
});

test('PRs keep release acceptance off the merge path and retain it on main', () => {
  for (const event of ['pull_request', 'merge_group']) {
    const scope = selectChecks(null, event);
    assert.equal(scope.integration, true);
    assert.equal(scope.testMode, 'all');
    for (const name of ['macos', 'windows', 'images']) assert.equal(scope[name], false);
  }
  for (const event of ['push', 'schedule', 'workflow_dispatch'])
    for (const name of ['macos', 'windows', 'images'])
      assert.equal(selectChecks(null, event)[name], true);
});

test('the shared runner and qualification jobs use the selected scope', async () => {
  const jobs = ciWorkflow.jobs;
  assert.equal(jobs.checks.name, 'Checks, tests and build');
  assert.equal(jobs.checks.needs, undefined);
  for (const name of ['macos', 'windows', 'images']) {
    assert.equal(jobs[name].needs, 'checks');
    assert.equal(jobs[name].if, `needs.checks.outputs.${name} == 'true'`);
  }
  for (const name of enabled(null))
    assert.equal(jobs.checks.outputs[name], '${{ steps.scope.outputs.' + name + ' }}');
  assert.ok(ciWorkflow.on.schedule.length);
  assert.ok(ciWorkflow.on.merge_group);
  const bundle = parse(
    await readFile(new URL('../workflows/self-host-bundle.yml', import.meta.url), 'utf8'),
  );
  assert.equal(bundle.on.pull_request, undefined);
  const titles = parse(
    await readFile(new URL('../workflows/pr-title.yml', import.meta.url), 'utf8'),
  );
  assert.ok(titles.on.merge_group);
});

test('shared checks start in parallel and preserve a failure from any command', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nod-ci-parallel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = join(root, 'commands.log');
  const program = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const label = path.basename(process.argv[1]) + ' ' + process.argv.slice(2).join(' ');
const log = process.env.CI_COMMAND_LOG;
const newline = String.fromCharCode(10);
fs.appendFileSync(log, 'start ' + label + newline);
const start = Date.now();
const timer = setInterval(() => {
  const count = fs.readFileSync(log, 'utf8').split(newline).filter(line => line.startsWith('start ')).length;
  if (count < 8 && Date.now() - start < 5000) return;
  clearInterval(timer);
  fs.appendFileSync(log, 'end ' + label + newline);
  if (count < 8) process.exit(3);
  if (process.env.CI_FAIL_LINT === 'true' && process.argv.includes('lint')) {
    process.stderr.write('Synthetic lint failure.' + newline);
    process.exit(7);
  }
}, 10);
`;
  for (const name of ['node', 'pnpm', 'sudo'])
    await writeFile(join(root, name), program, { mode: 0o755 });
  const step = ciWorkflow.jobs.checks.steps.find(
    (step) => step.name === 'Run checks in parallel with shared setup',
  );
  const execute = (fail) =>
    execFileSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: 'pipe',
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        CI_COMMAND_LOG: log,
        CI_FAIL_LINT: String(fail),
        ...Object.fromEntries(
          ['LINT', 'TYPES', 'BUILD', 'INTEGRATION', 'DESKTOP', 'EVALS', 'N8N', 'NETWORK'].map(
            (name) => [`NOD_CHECK_${name}`, 'true'],
          ),
        ),
      },
    });
  await writeFile(log, '');
  execute(false);
  const lines = (await readFile(log, 'utf8')).trim().split(String.fromCharCode(10));
  assert.ok(lines.findIndex((line) => line.startsWith('end ')) >= 8);
  await writeFile(log, '');
  assert.throws(
    () => execute(true),
    (error) => error.status === 1 && error.stderr.includes('Synthetic lint failure.'),
  );
});

test('release publication acceptance stays enabled outside PR checks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nod-ci-release-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'release.test.mjs');
  const marker = join(root, 'core-ran');
  await writeFile(
    file,
    `import test from 'node:test';
import { writeFileSync } from 'node:fs';
test('all four checked bundles publish together as one regular Nod release', () => { throw new Error('Synthetic release acceptance failure.'); });
test('runtime isolation contract', () => writeFileSync(${JSON.stringify(marker)}, 'checked'));
`,
  );
  const helper = fileURLToPath(new URL('./ci-scope.mjs', import.meta.url));
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const execute = (release) =>
    execFileSync(process.execPath, [helper, '--desktop-tests'], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...environment,
        NOD_DESKTOP_TEST_FILES: JSON.stringify([file]),
        NOD_DESKTOP_RELEASE_ACCEPTANCE: String(release),
      },
    });
  execute(false);
  assert.equal(await readFile(marker, 'utf8'), 'checked');
  assert.throws(
    () => execute(true),
    (error) => error.status !== 0 && error.stdout.includes('Synthetic release acceptance failure.'),
  );
});

test('workflow queues use supported values and do not cancel queued releases', async () => {
  const directory = new URL('../workflows/', import.meta.url);
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.yml')) continue;
    const workflow = parse(await readFile(new URL(name, directory), 'utf8'));
    for (const concurrency of [
      workflow.concurrency,
      ...Object.values(workflow.jobs).map((job) => job.concurrency),
    ]) {
      if (!concurrency || typeof concurrency !== 'object' || !Object.hasOwn(concurrency, 'queue'))
        continue;
      assert.ok(['single', 'max'].includes(concurrency.queue), `${name} has an invalid queue.`);
      assert.ok(
        concurrency.queue !== 'max' || concurrency['cancel-in-progress'] !== true,
        `${name} cancels a release queue.`,
      );
    }
  }
});

test('Git diffs handle renamed files, removed tests, release metadata and missing bases', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nod-ci-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = () => {
    git('add', '.');
    git(
      '-c',
      'user.name=Synthetic CI',
      '-c',
      'user.email=ci@example.test',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--quiet',
      '-m',
      'Synthetic change',
    );
    return git('rev-parse', 'HEAD');
  };
  const script = new URL('./ci-scope.mjs', import.meta.url);
  const run = (base, event = 'pull_request') =>
    JSON.parse(
      execFileSync(process.execPath, [fileURLToPath(script)], {
        cwd: root,
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          PATH: process.env.PATH,
          CI_DIFF_BASE: base,
          GITHUB_EVENT_NAME: event,
          GITHUB_OUTPUT: join(root, '.git', 'scope-output'),
          GITHUB_STEP_SUMMARY: join(root, '.git', 'scope-summary'),
        },
      }),
    );
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  await mkdir(join(root, 'tests'));
  await mkdir(join(root, 'desktop'));
  await writeFile(join(root, 'README.md'), 'Synthetic text.\n');
  await writeFile(join(root, 'tests/a.test.ts'), "import '../src/web/app.tsx';\n");
  await writeFile(join(root, 'tests/b.test.ts'), 'Synthetic test.\n');
  await writeFile(
    join(root, 'desktop/package.json'),
    JSON.stringify({ version: '1.0.0', name: 'synthetic' }),
  );
  const base = commit();
  await writeFile(join(root, 'README.md'), 'Changed text.\n');
  commit();
  assert.equal(run(base).integration, false);
  assert.equal(run(base, 'push').integration, true);
  assert.equal(run(base, 'merge_group').integration, true);
  await writeFile(join(root, 'tests/b.test.ts'), 'Changed test.\n');
  const testChange = commit();
  assert.deepEqual(JSON.parse(run(base).test_files), ['tests/b.test.ts']);
  git('mv', 'tests/b.test.ts', 'tests/copy with space.test.ts');
  const renamed = commit();
  assert.deepEqual(JSON.parse(run(testChange).test_files), ['tests/copy with space.test.ts']);
  git('rm', 'tests/copy with space.test.ts');
  const removed = commit();
  assert.equal(run(renamed).integration, false);
  await writeFile(
    join(root, 'desktop/package.json'),
    JSON.stringify({ version: '1.1.0', name: 'synthetic' }),
  );
  const release = commit();
  assert.equal(run(removed).macos, false);
  await mkdir(join(root, 'src/web'), { recursive: true });
  await writeFile(join(root, 'src/web/app.tsx'), 'Synthetic web fixture.\n');
  commit();
  assert.deepEqual(JSON.parse(run(release).test_files), ['tests/a.test.ts']);
  await writeFile(join(root, 'tests/new.test.ts'), 'Synthetic new test.\n');
  commit();
  assert.deepEqual(JSON.parse(run(release).test_files), ['tests/a.test.ts', 'tests/new.test.ts']);
  assert.equal(run('').macos, false);
  assert.equal(run('', 'workflow_dispatch').macos, true);
  assert.equal(run('0'.repeat(40)).integration, true);
  assert.equal(run('f'.repeat(40)).integration, true);
  assert.throws(() => run('not-a-commit'), /base revision is invalid/);
  assert.match(await readFile(join(root, '.git', 'scope-summary'), 'utf8'), /Selected checks/);
  const beforeLock = git('rev-parse', 'HEAD');
  await writeFile(join(root, 'pnpm-lock.yaml'), 'synthetic: true\n');
  commit();
  assert.ok(JSON.parse(run(beforeLock).quality_checks).includes('lint'));
});

test('slow test files start first and every selected file stays in the queue', async () => {
  const files = [
    'tests/slow.test.ts',
    'tests/medium.test.ts',
    'tests/short.test.ts',
    'tests/tiny.test.ts',
  ];
  const times = Object.fromEntries(files.map((file, index) => [file, [90, 50, 30, 10][index]]));
  assert.deepEqual(await orderTests([...files].reverse(), times), files);
  assert.deepEqual(await orderTests([], {}), []);
  const cold = await orderTests(['tests/accounts.test.ts', 'tests/pi.test.ts']);
  assert.deepEqual(cold.sort(), ['tests/accounts.test.ts', 'tests/pi.test.ts']);
});

test('new test times replace old values and keep files outside a partial run', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nod-ci-times-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = join(root, 'old');
  const latest = join(root, 'latest');
  await mkdir(old);
  await mkdir(latest);
  await writeFile(
    join(old, 'timings.json'),
    JSON.stringify({ 'tests/a.test.ts': 10, 'tests/b.test.ts': 20 }),
  );
  await writeFile(
    join(latest, '1.json'),
    JSON.stringify({
      'tests/a.test.ts': 5,
      'tests/c.test.ts': 30,
      'tests/bad.test.ts': -1,
      'unrelated.txt': 100,
    }),
  );
  assert.deepEqual(await readTimings(old, latest), {
    'tests/a.test.ts': 5,
    'tests/b.test.ts': 20,
    'tests/c.test.ts': 30,
  });
  assert.deepEqual(await readTimings(join(root, 'absent')), {});
});

test('Vitest follows imports without running test files and reruns non-imported inputs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nod-ci-related-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  for (const directory of ['src', 'tests']) await mkdir(join(root, directory));
  await writeFile(join(root, 'src/leaf.ts'), 'export const value = 1;\n');
  await writeFile(join(root, 'src/route.ts'), "export { value } from './leaf';\n");
  await writeFile(join(root, 'src/other.ts'), 'export const value = 2;\n');
  await writeFile(
    join(root, 'tests/route.test.ts'),
    "import '../src/route';\nthrow new Error('Test selection must not execute this file.');\n",
  );
  await writeFile(
    join(root, 'tests/other.test.ts'),
    "import '../src/other';\nthrow new Error('Test selection must not execute this file.');\n",
  );
  git('add', '.');
  git(
    '-c',
    'user.name=Synthetic CI',
    '-c',
    'user.email=ci@example.test',
    'commit',
    '--quiet',
    '-m',
    'Synthetic base',
  );
  const base = git('rev-parse', 'HEAD');
  await writeFile(join(root, 'src/leaf.ts'), 'export const value = 3;\n');
  const helper = fileURLToPath(new URL('./ci-tests.mjs', import.meta.url));
  const files = ['tests/other.test.ts', 'tests/route.test.ts'];
  const select = () =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { affectedTests } from ${JSON.stringify('file://' + helper)}; console.log(JSON.stringify(affectedTests(${JSON.stringify(base)}, ${JSON.stringify(files)})));`,
        ],
        { cwd: root, encoding: 'utf8' },
      ),
    );
  assert.deepEqual(select(), ['tests/route.test.ts']);
  await writeFile(join(root, 'pnpm-lock.yaml'), 'synthetic: true\n');
  assert.deepEqual(select().sort(), files);
  await rm(join(root, 'pnpm-lock.yaml'));
  for (const path of [
    'desktop/main/engine.mjs',
    'deployment/self-host/docker-proxy.mjs',
    'src/providers/synthetic/worker.ts',
  ]) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(
      join(root, path),
      'throw new Error("This input must not execute during selection.");\n',
    );
    assert.deepEqual(select().sort(), files, path);
    await rm(join(root, path));
  }
  for (const path of [
    'desktop/runtime/index.mjs',
    'src/providers/synthetic/workerpool.ts',
    'src/providers/synthetic/workerless.ts',
  ]) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(
      join(root, path),
      'throw new Error("This input must not execute during selection.");\n',
    );
    assert.deepEqual(select(), ['tests/route.test.ts'], path);
    await rm(join(root, path));
  }
});
