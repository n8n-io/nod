import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { requireChecks, selectChecks } from './ci-scope.mjs';

const enabled = (paths) =>
  Object.entries(selectChecks(paths))
    .filter(([, value]) => value === true)
    .map(([name]) => name)
    .sort();

test('text and media changes do not select application tests or native checks', () => {
  assert.deepEqual(enabled(['README.md', 'AGENTS.md', 'docs/src/content/docs/use/chat.md']), []);
  assert.deepEqual(enabled(['public/logos/nod.svg', 'src/web/styles.css']), ['build', 'types']);
  assert.deepEqual(enabled(['src/web/components/message.tsx']), ['build', 'integration', 'types']);
  assert.equal(selectChecks(['src/web/components/message.tsx']).testMode, 'web');
});

test('test-only changes select those files without image or platform checks', () => {
  const paths = ['tests/pi.test.ts', 'tests/thread.test.ts'];
  assert.deepEqual(enabled(paths), ['integration', 'types']);
  assert.deepEqual(selectChecks(paths).testFiles, paths);
  assert.equal(selectChecks(paths).testMode, 'changed');
  assert.equal(selectChecks(['tests/fixtures/composio-defaults.mts']).testMode, 'all');
});

test('server changes keep the full Linux suite without native checks', () => {
  assert.deepEqual(enabled(['src/server/thread.ts']), ['evals', 'integration', 'types']);
  assert.equal(selectChecks(['src/server/thread.ts', 'tests/pi.test.ts']).testMode, 'all');
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
  assert.equal(selectChecks(['desktop/ui/setup.tsx']).macos, false);
  assert.equal(selectChecks(['desktop/runtime/index.mjs']).network, true);
  assert.equal(selectChecks(['desktop/runtime/index.mjs']).desktop, true);
  assert.equal(selectChecks(['deployment/n8n/install.ps1']).windows, true);
  assert.deepEqual(enabled(['evals/src/cli.ts']), ['evals']);
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
  return {
    scope: { result: 'success', outputs },
    quality: { result: 'success' },
    secrets: { result: 'success' },
    ...Object.fromEntries(
      ['integration', 'desktop', 'macos', 'windows', 'n8n', 'evals', 'images'].map((name) => [
        name,
        { result: scope[name] ? 'success' : 'skipped' },
      ]),
    ),
  };
}

test('the required result accepts only valid scopes and successful selected jobs', () => {
  for (const paths of [[], ['src/web/app.tsx'], ['src/server/thread.ts'], null])
    assert.doesNotThrow(() => requireChecks(results(paths)));
  for (const name of [
    'scope',
    'quality',
    'secrets',
    'integration',
    'desktop',
    'macos',
    'windows',
    'n8n',
    'evals',
    'images',
  ]) {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      const needs = results(null);
      needs[name].result = result;
      assert.throws(() => requireChecks(needs), /did not pass|could not select/);
    }
    const needs = results(null);
    delete needs[name];
    assert.throws(() => requireChecks(needs), /missing|could not select/);
  }
  const missing = results([]);
  delete missing.scope.outputs.windows;
  assert.throws(() => requireChecks(missing), /windows scope is missing/);
});

test('every selected job is part of the required result and can run in parallel', async () => {
  const workflow = parse(await readFile(new URL('../workflows/ci.yml', import.meta.url), 'utf8'));
  const jobs = workflow.jobs;
  for (const name of [
    'quality',
    'secrets',
    'integration',
    'desktop',
    'macos',
    'windows',
    'n8n',
    'evals',
    'images',
  ]) {
    assert.ok(jobs.checks.needs.includes(name), `${name} must be required.`);
    if (!['quality', 'secrets'].includes(name)) {
      assert.equal(jobs[name].needs, 'scope');
      assert.equal(jobs[name].if, `needs.scope.outputs.${name} == 'true'`);
    }
  }
  for (const name of enabled(null))
    assert.equal(jobs.scope.outputs[name], '${{ steps.scope.outputs.' + name + ' }}');
  assert.equal(jobs.checks.name, 'Checks, tests and build');
  assert.ok(jobs.checks.if.includes('!cancelled()'));
  assert.ok(workflow.on.schedule.length);
  assert.ok(workflow.on.merge_group);
  const titles = parse(
    await readFile(new URL('../workflows/pr-title.yml', import.meta.url), 'utf8'),
  );
  assert.ok(titles.on.merge_group);
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
  const run = (base) =>
    JSON.parse(
      execFileSync(process.execPath, [fileURLToPath(script)], {
        cwd: root,
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          PATH: process.env.PATH,
          CI_DIFF_BASE: base,
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
  assert.equal(run('').macos, true);
  assert.equal(run('0'.repeat(40)).macos, true);
  assert.equal(run('f'.repeat(40)).macos, true);
  assert.throws(() => run('not-a-commit'), /base revision is invalid/);
  assert.match(await readFile(join(root, '.git', 'scope-summary'), 'utf8'), /Selected checks/);
});
