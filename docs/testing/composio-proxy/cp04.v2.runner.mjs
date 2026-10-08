import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(process.env.OTTO_EVAL_ROOT || process.cwd());
assert.ok(process.env.OTTO_PROXY_ROOT, 'OTTO_PROXY_ROOT must select the companion checkout.');
const proxy = resolve(process.env.OTTO_PROXY_ROOT);
const directory = resolve(root, 'docs/testing/composio-proxy');
const original = JSON.parse(await readFile(resolve(directory, 'cp04.v1.inputs.json'), 'utf8'));
const inputPath = resolve(directory, 'cp04.v2.inputs.json');
const resultPath = resolve(directory, 'cp04.v2.results.json');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const serialize = async (value) =>
  (await import('prettier')).format(JSON.stringify(value), { parser: 'json' });
const now = () => new Date().toISOString();
const roots = { otto: root, proxy };
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function portable(source) {
  for (const [scope, before] of Object.entries(original.setup).filter(([key]) => key in roots)) {
    source = source.replace(/import (\{[^\n]+\}) from '([^']+)';/g, (statement, names, path) =>
      path.startsWith(before + '/')
        ? `const ${names} = await import(pathToFileURL(resolve(${scope}Root, ${JSON.stringify(relative(before, path))})).href);`
        : statement,
    );
    source = source.replaceAll(
      JSON.stringify(before + '/package.json'),
      `resolve(${scope}Root, 'package.json')`,
    );
    source = source.replaceAll(JSON.stringify(before), `${scope}Root`);
  }
  return `import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const ottoRoot = process.env.OTTO_EVAL_ROOT;
const proxyRoot = process.env.OTTO_PROXY_ROOT;
if (!ottoRoot || !proxyRoot || !['base', 'holdout'].includes(process.env.CP04_VARIANT)) throw new Error('Explicit roots and base or holdout variant are required.');
${source}`;
}

function execute(args, cwd, variant, timeout = 120_000) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: { ...process.env, OTTO_EVAL_ROOT: root, OTTO_PROXY_ROOT: proxy, CP04_VARIANT: variant },
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    startedAt: new Date(started).toISOString(),
    elapsedMs: Date.now() - started,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message,
  };
}

if (process.argv[2] === '--freeze') {
  const sources = [];
  for (const path of Object.keys(original.build.source_files_sha256)) {
    const scope = path.startsWith(original.setup.otto + '/') ? 'otto' : 'proxy';
    const name = relative(original.setup[scope], path);
    sources.push({ scope, path: name, sha256: hash(await readFile(resolve(roots[scope], name))) });
  }
  sources.push({
    scope: 'otto',
    path: 'docs/testing/composio-proxy/cp04.v2.runner.mjs',
    sha256: hash(await readFile(new URL(import.meta.url))),
  });
  const runners = Object.fromEntries(
    Object.entries(original.runners).map(([name, source]) => [name, portable(source)]),
  );
  const input = {
    case: 'CP04.v2',
    frozenAt: now(),
    reason:
      'Repeat installation isolation after filesystem hardening, with portable roots, exact Worker selectors and strict variant validation. Original checks and historical records remain unchanged.',
    prompt: original.prompt,
    checks: original.checks,
    variants: original.variants,
    runRule: original.run_rule,
    node: process.version,
    proxyCommit: original.build.proxy_commit,
    sourceInputsSha256: hash(await readFile(resolve(directory, 'cp04.v1.inputs.json'))),
    sources,
    runners,
    runnerSha256: Object.fromEntries(
      Object.entries(runners).map(([name, source]) => [name, hash(source)]),
    ),
    workerPatterns: Object.fromEntries(
      ['base', 'holdout'].map((variant) => [
        variant,
        `^(?:${original.worker_tests[variant].map(escape).join('|')})$`,
      ]),
    ),
    evidenceLimits: original.evidence_limits,
  };
  await writeFile(inputPath, await serialize(input), { flag: 'wx' });
  console.log(JSON.stringify({ frozen: true, inputsSha256: hash(await readFile(inputPath)) }));
} else if (process.argv[2] === '--run') {
  const bytes = await readFile(inputPath);
  const input = JSON.parse(bytes);
  async function verifySources() {
    assert.equal(
      hash(await readFile(resolve(directory, 'cp04.v1.inputs.json'))),
      input.sourceInputsSha256,
    );
    assert.equal(
      spawnSync('git', ['rev-parse', 'HEAD'], { cwd: proxy, encoding: 'utf8' }).stdout.trim(),
      input.proxyCommit,
    );
    for (const source of input.sources)
      assert.equal(
        hash(await readFile(resolve(roots[source.scope], source.path))),
        source.sha256,
        source.path,
      );
    for (const [name, source] of Object.entries(input.runners))
      assert.equal(hash(source), input.runnerSha256[name], name);
  }
  await verifySources();
  const result = {
    case: input.case,
    inputsSha256: hash(bytes),
    startedAt: now(),
    status: 'error',
    variants: [],
  };
  try {
    const invalid = execute(
      [
        '--experimental-transform-types',
        '--input-type=module-typescript',
        '-e',
        input.runners.runtime_replay,
      ],
      root,
      'misspelled',
    );
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Explicit roots and base or holdout variant are required/);
    result.invalidVariantRejected = true;
    for (const variant of ['base', 'holdout']) {
      const started = Date.now();
      const observed = { variant, startedAt: now(), components: [] };
      result.variants.push(observed);
      for (const name of [`sdk_${variant}`, 'runtime_replay']) {
        const component = {
          name,
          ...execute(
            [
              '--experimental-transform-types',
              '--input-type=module-typescript',
              '-e',
              input.runners[name],
            ],
            root,
            variant,
          ),
        };
        observed.components.push(component);
        assert.equal(component.status, 0, name);
        const summary = JSON.parse(component.stdout.trim().split('\n').at(-1));
        assert.equal(summary.passed, true);
        if (name === 'runtime_replay') assert.equal(summary.variant, variant);
        else {
          assert.equal(summary.remainingSessions, 0);
          assert.equal(summary.storedFiles, 0);
        }
      }
      const worker = {
        name: 'worker_boundaries',
        ...execute(
          [
            '--test',
            '--test-reporter=tap',
            `--test-name-pattern=${input.workerPatterns[variant]}`,
            'test/broker.test.ts',
          ],
          proxy,
          variant,
        ),
      };
      observed.components.push(worker);
      assert.equal(worker.status, 0);
      assert.match(worker.stdout, new RegExp(`# pass ${original.worker_tests[variant].length}\\b`));
      observed.elapsedMs = Date.now() - started;
      assert.ok(observed.elapsedMs <= 600_000);
      observed.status = 'pass';
    }
    result.regression = execute(
      ['--test', '--test-reporter=tap', 'test/broker.test.ts'],
      proxy,
      'base',
    );
    assert.equal(result.regression.status, 0);
    assert.match(result.regression.stdout, /# pass 31\b/);
    await verifySources();
    result.status = 'pass';
  } catch (error) {
    result.error = error.message;
    process.exitCode = 1;
  } finally {
    result.endedAt = now();
    await writeFile(resultPath, await serialize(result), { flag: 'wx' });
    console.log(
      JSON.stringify({
        status: result.status,
        variants: result.variants.map(({ variant, status }) => ({ variant, status })),
        error: result.error,
      }),
    );
  }
} else {
  throw new Error('Choose --freeze or --run.');
}
