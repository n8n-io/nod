import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WorkspaceSession } from '../src/ports/computer.ts';
import { createDockerWorkspace } from '../src/providers/docker/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = options.indexOf(name);
  return index === -1 ? fallback : options[index + 1];
};
const image = option('--image', 'nod-eval-workspace:latest');
const phase = option('--phase', 'candidate');
const output = resolve(option('--output', join(root, '.local', 'rtk-eval', phase)));
const baseline = option('--baseline', '437687bb17a3944ce9aa01ac37239e5163515365');
const sourceRef = option('--source-ref', phase === 'baseline' ? baseline : '');
const repeatCount = options.includes('--smoke') ? 1 : 3;
const caseVersion = Number(option('--case-version', '7'));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const harnessSha256 = hash(await readFile(fileURLToPath(import.meta.url)));
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const command = (file: string, args: string[]) =>
  execFileSync(file, args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

const definitions = [
  {
    id: `RTK-B1.v${caseVersion >= 3 ? 2 : 1}`,
    split: 'base',
    prompt: 'Tell me which files in this invoice project have changed and whether they are staged.',
    command: 'git status',
    semantic: [
      'config.json',
      'src/alpha.ts',
      'src/beta.ts',
      'src/export.ts',
      'obsolete.txt',
      'notes.md',
    ],
    compact: true,
  },
  {
    id: 'RTK-B2.v1',
    split: 'base',
    prompt: 'Review the changed invoice calculation and explain the change in values.',
    command: 'git diff',
    semantic: ['invoiceRate = 0.15', 'invoiceRate = 0.20', 'batchSize = 20', 'batchSize = 25'],
    compact: true,
  },
  {
    id: 'RTK-H1.v1',
    split: 'holdout',
    prompt: 'Summarize the last five changes to this shipment project.',
    command: 'git log -5',
    semantic: [
      'Add shipment export',
      'Validate shipment totals',
      'Add shipment records',
      'Set shipment currency',
      'Seed shipment project',
    ],
    compact: true,
  },
  {
    id: `RTK-H2.v${caseVersion >= 3 ? 2 : 1}`,
    split: 'holdout',
    prompt: 'List the pending changes in the shipment project, including staged and deleted files.',
    command: 'git status',
    semantic: [
      'config.json',
      'src/alpha.ts',
      'src/beta.ts',
      'src/export.ts',
      'obsolete.txt',
      'notes.md',
    ],
    compact: true,
  },
  {
    id: 'RTK-R1.v1',
    split: 'regression',
    prompt: 'Export the ledger exactly so another tool can process every record.',
    command: 'cat ledger.csv > exported.csv',
    semantic: [],
    compact: false,
    artifact: 'exported.csv',
  },
  {
    id: 'RTK-R2.v1',
    split: 'regression',
    prompt: 'Return machine-readable repository status for another program.',
    command: 'git status --porcelain',
    semantic: [],
    compact: false,
  },
  {
    id: `RTK-R3.v${caseVersion >= 4 ? 2 : 1}`,
    split: 'regression',
    prompt:
      caseVersion >= 4
        ? 'Save the full patch of staged and unstaged tracked changes for another tool to inspect and apply.'
        : 'Save the full patch for another tool to inspect and apply.',
    command: caseVersion >= 4 ? 'git diff HEAD > changes.patch' : 'git diff > changes.patch',
    semantic: [],
    compact: false,
    artifact: 'changes.patch',
  },
  {
    id: 'RTK-R4.v1',
    split: 'regression',
    prompt: 'Run the local validation command and retain its failure status.',
    command: "printf 'synthetic validation failure\\n'; exit 23",
    semantic: ['synthetic validation failure', 'Command exited with code 23'],
    compact: false,
    exitCode: 23,
  },
  ...(caseVersion >= 2
    ? [
        {
          id: `RTK-R5.v${caseVersion >= 4 ? 2 : 1}`,
          split: 'regression',
          prompt:
            caseVersion >= 4
              ? 'Save the complete patch of staged and unstaged tracked changes using Git output-file support so another tool can apply it.'
              : 'Save the complete patch using Git output-file support so another tool can apply it.',
          command:
            caseVersion >= 4
              ? 'git diff HEAD --output=changes.patch'
              : 'git diff --output=changes.patch',
          semantic: [],
          compact: false,
          artifact: 'changes.patch',
        },
      ]
    : []),
  ...(caseVersion >= 3
    ? [
        {
          id: `RTK-R6.v${caseVersion >= 6 ? 2 : 1}`,
          split: 'regression',
          prompt:
            caseVersion >= 6
              ? 'Show the main files and folders in this project.'
              : 'List the directory files without changing the ordinary listing format.',
          command: 'ls',
          semantic: caseVersion >= 6 ? ['config.json', 'ledger.csv', 'src'] : [],
          compact: caseVersion >= 6,
        },
      ]
    : []),
  ...(caseVersion >= 5
    ? [
        {
          id: 'RTK-R7.v1',
          split: 'regression',
          variant: 'merge',
          prompt: 'Show the complete repository history, including branch merges.',
          command: 'git log',
          semantic: ['Merge synthetic feature', 'Add synthetic feature', 'Add synthetic main'],
          compact: false,
        },
      ]
    : []),
  ...(caseVersion >= 6
    ? [
        {
          id: 'RTK-B3.v1',
          split: 'base',
          prompt: 'Inspect the main files in the project directory.',
          command: 'ls -la',
          semantic: ['config.json', 'ledger.csv', 'src'],
          compact: true,
        },
        {
          id: 'RTK-H3.v1',
          split: 'holdout',
          prompt: 'Show how the shipment calculation rules work.',
          command: 'cat src/alpha.ts',
          semantic: ['alphaRule0', 'invoiceRate = 0.20', 'alphaRule11'],
          compact: true,
        },
        {
          id: 'RTK-B4.v1',
          split: 'base',
          prompt: 'Find where the invoice rate is defined and used.',
          command: "rg 'invoiceRate' src",
          semantic: [
            'alpha.ts',
            'invoiceRate = 0.20',
            'invoiceRate = 0.15',
            'return amount * invoiceRate',
          ],
          compact: true,
        },
        caseVersion >= 7
          ? {
              id: 'RTK-H4.v2',
              split: 'holdout',
              prompt: 'Find the JSON files in this project, including the saved run plan.',
              command: "find . -name '*.json'",
              semantic: ['config.json', '.nod/plan.json'],
              compact: false,
            }
          : {
              id: 'RTK-H4.v1',
              split: 'holdout',
              prompt: 'Find the source files in this project.',
              command: 'find src -type f',
              semantic: ['alpha.ts', 'beta.ts', 'export.ts'],
              compact: true,
            },
      ]
    : []),
];

const manifest = {
  version: caseVersion,
  evidenceClass:
    'Controlled Pi bash tool execution against synthetic files in disposable Linux containers; no model or live account.',
  model: null,
  repeatCount,
  timeoutSeconds: 30,
  metric:
    'Measured UTF-8 bytes and Unicode characters; estimated input tokens = ceil(characters / 4), not tokenizer counts.',
  caseGate:
    'Every applicable required check passes in the same run. Availability and compact checks intentionally fail on the red baseline.',
  checks: {
    'C1-installed': 'RTK 0.51.0 executes successfully in the workspace; applies to every case.',
    'C2-exit': 'The Pi result reports the expected success or failure; applies to every case.',
    'C3-semantic': `Every independent expected filename, changed value or commit subject occurs in the visible result; applies to compact cases and explicit failure${caseVersion >= 5 ? ' and R7 merge history' : ''}${caseVersion >= 7 ? ' and H4.v2 files in a hidden, ignored folder' : ''}.`,
    'C4-compact':
      caseVersion >= 6
        ? 'In each repetition, the sum of visible characters across the equally used display commands is lower than the matching raw sum. Applies to the display cases as one shared aggregate gate; individual outputs may grow.'
        : 'Visible output contains fewer characters than the equivalent raw shell command; applies only to the four compact cases.',
    'C5-exact': `Machine status is byte-identical to raw output, exported CSV bytes match the independent input, and patch bytes match raw Git output; applies to R1, R2 and R3${caseVersion >= 2 ? ' and R5' : ''}${caseVersion >= 3 && caseVersion < 6 ? ' and R6 (ordinary listing)' : ''}${caseVersion >= 5 ? ' and R7 (complete merge history)' : ''}.`,
    ...(caseVersion >= 3
      ? {
          'C6-status-class':
            'Staged addition, three unstaged modifications, unstaged deletion and untracked file retain their correct status classes; applies to B1.v2 and H2.v2.',
        }
      : {}),
    ...(caseVersion >= 4
      ? {
          'C7-patch-content':
            'Saved patches contain the independent fixture expectations: the staged export file addition and all changed values and deleted content in the unstaged tracked files; applies to R3.v2 and R5.v2.',
        }
      : {}),
    ...(caseVersion >= 6
      ? {
          'C8-rtk-used':
            'The execution trace records a real RTK command invocation beyond rewrite probing. A disposable PATH shim logs arguments then execs the installed binary without changing output; applies to the display cases.',
        }
      : {}),
  },
  cases: definitions,
};

const inputFiles = (variant: string) => {
  const files: Record<string, string> = {
    '.gitignore': '.nod/\nexported.csv\nchanges.patch\n',
    'config.json': `${JSON.stringify({ project: variant, currency: variant === 'invoice' ? 'EUR' : 'USD', precision: 2 }, null, 2)}\n`,
    'ledger.csv': `id,description,amount,currency\n${Array.from({ length: 120 }, (_, index) => `${index + 1},${variant} record ${index + 1},${((index + 1) * 1.37).toFixed(2)},${variant === 'invoice' ? 'EUR' : 'USD'}`).join('\n')}\n`,
    'obsolete.txt': `Unused ${variant} export path\n`,
    'audit.txt': '',
    ...(caseVersion >= 7 ? { '.nod/plan.json': `{"project": "${variant}", "step": 1}\n` } : {}),
  };
  for (const [name, value] of [
    ['alpha', 'invoiceRate = 0.15'],
    ['beta', 'batchSize = 20'],
  ] as const) {
    files[`src/${name}.ts`] = Array.from(
      { length: 12 },
      (_, index) =>
        `export function ${name}Rule${index}(amount: number) {\n  const ${value};\n  return amount * ${name === 'alpha' ? 'invoiceRate' : 'batchSize'};\n}\n`,
    ).join('\n');
  }
  return files;
};

await mkdir(output, { recursive: true });
await writeFile(join(output, 'cases.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const startedAt = new Date().toISOString();
const hostRoot = await mkdtemp(join(tmpdir(), 'nod-rtk-workspaces-'));
await chmod(hostRoot, 0o755);
const container = `nod-workspace-rtk-eval-${randomUUID().slice(0, 8)}`;
const temporaryModule = await mkdtemp(join(root, 'scripts', '.rtk-eval-'));
const sourcePath = 'src/providers/pi/sandbox.ts';
const source = sourceRef
  ? command('git', ['show', `${sourceRef}:${sourcePath}`]) + '\n'
  : await readFile(join(root, sourcePath), 'utf8');
const testedCommit = command('git', ['rev-parse', sourceRef || 'HEAD']);
const sourceState =
  sourceRef || hash(command('git', ['show', `HEAD:${sourcePath}`]) + '\n') === hash(source)
    ? 'committed'
    : 'working-tree';
await writeFile(join(temporaryModule, 'sandbox.ts'), source);
const { createSandbox } = await import(pathToFileURL(join(temporaryModule, 'sandbox.ts')).href);
const provider = createDockerWorkspace({ container, workspaceRoot: hostRoot });
const controller = new AbortController();
const sessions = new Map<string, WorkspaceSession>();
const fixtures: Record<string, Record<string, string>> = {};
const attempts: unknown[] = [];
let running = false;

async function exec(session: WorkspaceSession, script: string) {
  const chunks: Buffer[] = [];
  const { exitCode } = await session.exec(script, {
    timeoutMs: 30000,
    onData: (chunk) => chunks.push(chunk),
  });
  return { exitCode, output: Buffer.concat(chunks).toString('utf8') };
}

function statusClasses(text: string) {
  const staged =
    text.match(/Changes to be committed:([\s\S]*?)Changes not staged for commit:/)?.[1] ?? '';
  const unstaged =
    text.match(/Changes not staged for commit:([\s\S]*?)Untracked files:/)?.[1] ?? '';
  const untracked = text.match(/Untracked files:([\s\S]*)/)?.[1] ?? '';
  return (
    (text.includes('\nA  src/export.ts\n') || /new file:\s+src\/export\.ts/.test(staged)) &&
    ['config.json', 'src/alpha.ts', 'src/beta.ts'].every(
      (path) =>
        text.includes(`\n M ${path}\n`) ||
        unstaged.split('\n').some((line) => line.trim() === `modified:   ${path}`),
    ) &&
    (text.includes('\n D obsolete.txt\n') || /deleted:\s+obsolete\.txt/.test(unstaged)) &&
    (text.includes('\n?? notes.md\n') ||
      untracked.split('\n').some((line) => line.trim() === 'notes.md'))
  );
}

try {
  command('docker', [
    'run',
    '--detach',
    '--rm',
    '--network',
    'none',
    '--name',
    container,
    '--entrypoint',
    'sleep',
    '--mount',
    `type=bind,src=${hostRoot},dst=/workspace`,
    image,
    'infinity',
  ]);
  running = true;
  for (const variant of ['invoice', 'shipment', ...(caseVersion >= 5 ? ['merge'] : [])]) {
    const files = inputFiles(variant);
    const directory = join(hostRoot, variant);
    await mkdir(join(directory, 'src'), { recursive: true });
    await mkdir(join(directory, '.nod'));
    await chmod(directory, 0o777);
    await chmod(join(directory, 'src'), 0o777);
    await chmod(join(directory, '.nod'), 0o777);
    for (const [path, contents] of Object.entries(files)) {
      await writeFile(join(directory, path), contents);
      await chmod(join(directory, path), 0o666);
    }
    const session = provider.open({
      threadId: variant,
      workspacePath: directory,
      signal: controller.signal,
    });
    sessions.set(variant, session);
    const setup = await exec(
      session,
      [
        'git config --global --add safe.directory "$(pwd -P)"',
        'git init -q --initial-branch=main',
        "git config user.email 'synthetic@example.invalid'",
        "git config user.name 'Synthetic Evaluator'",
        'git config commit.gpgsign false',
        'git add .',
        `GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z git commit -qm ${shellQuote(`Seed ${variant} project`)}`,
        ...['Set', 'Add', 'Validate', 'Add'].flatMap((verb, index) => [
          `printf '%s\\n' ${shellQuote(`${variant} audit step ${index + 1}`)} >> audit.txt`,
          'git add audit.txt',
          `GIT_AUTHOR_DATE=2026-01-0${index + 2}T00:00:00Z GIT_COMMITTER_DATE=2026-01-0${index + 2}T00:00:00Z git commit -qm ${shellQuote(`${verb} ${variant} ${['currency', 'records', 'totals', 'export'][index]}`)}`,
        ]),
      ].join(' && '),
    );
    assert.equal(setup.exitCode, 0, setup.output);
    const mergeFiles =
      variant === 'merge'
        ? {
            'merge-feature.txt': 'Synthetic feature branch\n',
            'merge-main.txt': 'Synthetic main branch\n',
          }
        : {};
    if (variant === 'merge') {
      const merged = await exec(
        session,
        [
          'git switch -qc feature',
          `printf %s ${shellQuote(mergeFiles['merge-feature.txt']!)} > merge-feature.txt`,
          'git add merge-feature.txt',
          "GIT_AUTHOR_DATE=2026-01-06T00:00:00Z GIT_COMMITTER_DATE=2026-01-06T00:00:00Z git commit -qm 'Add synthetic feature'",
          'git switch -q main',
          `printf %s ${shellQuote(mergeFiles['merge-main.txt']!)} > merge-main.txt`,
          'git add merge-main.txt',
          "GIT_AUTHOR_DATE=2026-01-07T00:00:00Z GIT_COMMITTER_DATE=2026-01-07T00:00:00Z git commit -qm 'Add synthetic main'",
          "GIT_AUTHOR_DATE=2026-01-08T00:00:00Z GIT_COMMITTER_DATE=2026-01-08T00:00:00Z git merge --no-ff -m 'Merge synthetic feature' feature",
        ].join(' && '),
      );
      assert.equal(merged.exitCode, 0, merged.output);
    }
    const changes = {
      'src/alpha.ts': files['src/alpha.ts'].replace('invoiceRate = 0.15', 'invoiceRate = 0.20'),
      'src/beta.ts': files['src/beta.ts'].replace('batchSize = 20', 'batchSize = 25'),
      'config.json': files['config.json'].replace('"precision": 2', '"precision": 3'),
      'src/export.ts': `export const format = '${variant}-csv';\n`,
      'notes.md': `Review ${variant} totals before export.\n`,
    };
    for (const [path, contents] of Object.entries(changes)) {
      await writeFile(join(directory, path), contents);
      await chmod(join(directory, path), 0o666);
    }
    await rm(join(directory, 'obsolete.txt'));
    assert.equal((await exec(session, 'git add src/export.ts')).exitCode, 0);
    fixtures[variant] = Object.fromEntries(
      Object.entries({ ...files, ...changes, ...mergeFiles }).map(([path, contents]) => [
        path,
        hash(contents),
      ]),
    );
  }
  const first = sessions.get('invoice')!;
  const version = await exec(first, 'rtk --version');
  const installed = version.exitCode === 0 && /^rtk 0\.51\.0\s*$/.test(version.output);
  if (caseVersion >= 6 && installed) {
    const shim =
      '#!/bin/sh\nprintf "%s\\n" "$*" >> /tmp/rtk-eval-invocations.log\nexec /usr/local/bin/rtk "$@"\n';
    assert.equal(
      (
        await exec(
          first,
          `mkdir -p /tmp/rtk-eval-bin && printf %s ${shellQuote(shim)} > /tmp/rtk-eval-bin/rtk && chmod 755 /tmp/rtk-eval-bin/rtk`,
        )
      ).exitCode,
      0,
    );
    for (const [name, session] of sessions)
      sessions.set(name, {
        ...session,
        exec: (script, options) =>
          session.exec(`export PATH=/tmp/rtk-eval-bin:$PATH\n${script}`, options),
      });
  }
  const system = await exec(first, 'uname -sm; node --version; git --version; python3 --version');
  for (let repetition = 1; repetition <= repeatCount; repetition++) {
    for (const definition of definitions) {
      const variant =
        'variant' in definition
          ? definition.variant
          : definition.split === 'holdout'
            ? 'shipment'
            : 'invoice';
      const session = sessions.get(variant)!;
      if (caseVersion >= 6 && /^ls(?: |$)/.test(definition.command)) {
        command('docker', [
          'exec',
          '--user',
          'root',
          '--workdir',
          `/workspace/${variant}`,
          container,
          'find',
          '.',
          '-maxdepth',
          '1',
          '-exec',
          'touch',
          '-t',
          '202601010000',
          '--',
          '{}',
          '+',
        ]);
      }
      const began = new Date().toISOString();
      const raw = await exec(session, definition.command);
      const expectedArtifact = definition.artifact
        ? await readFile(join(hostRoot, variant, definition.artifact))
        : undefined;
      if (definition.artifact) await rm(join(hostRoot, variant, definition.artifact));
      if (caseVersion >= 6)
        assert.equal((await exec(session, ': > /tmp/rtk-eval-invocations.log')).exitCode, 0);
      const bash = createSandbox(session).find((tool: { name: string }) => tool.name === 'bash');
      const result = await bash.execute(
        `${definition.id}-${repetition}`,
        { command: definition.command, timeout: 30 },
        undefined,
        undefined,
        undefined,
      );
      const text = result.content
        .filter((part: { type: string }) => part.type === 'text')
        .map((part: { text: string }) => part.text)
        .join('');
      const rtkInvocations =
        caseVersion >= 6
          ? (await exec(session, 'cat /tmp/rtk-eval-invocations.log')).output
              .split('\n')
              .filter(Boolean)
          : [];
      const expectedExit = definition.exitCode ?? 0;
      const characters = [...text].length;
      const rawCharacters = [...raw.output].length;
      const actualArtifact = definition.artifact
        ? await readFile(join(hostRoot, variant, definition.artifact))
        : undefined;
      let exact: boolean | null = null;
      if (definition.artifact) exact = hash(actualArtifact!) === hash(expectedArtifact!);
      if (definition.id === 'RTK-R1.v1')
        exact = exact && hash(expectedArtifact!) === fixtures[variant]['ledger.csv'];
      if (definition.id === 'RTK-R2.v1') exact = text === raw.output;
      if (definition.id === 'RTK-R6.v1') exact = text === raw.output;
      if (definition.id === 'RTK-R7.v1') exact = text === raw.output;
      const checks = {
        'C1-installed': installed,
        'C2-exit':
          raw.exitCode === expectedExit && Boolean(result.isError) === Boolean(expectedExit),
        'C3-semantic': definition.semantic.length
          ? definition.semantic.every((expected) => text.includes(expected))
          : null,
        'C4-compact': definition.compact ? characters < rawCharacters : null,
        'C5-exact': exact,
        ...(caseVersion >= 3
          ? {
              'C6-status-class': ['RTK-B1.v2', 'RTK-H2.v2'].includes(definition.id)
                ? statusClasses(text)
                : null,
            }
          : {}),
        ...(caseVersion >= 6
          ? {
              'C8-rtk-used': definition.compact
                ? rtkInvocations.some((invocation) => !invocation.startsWith('rewrite '))
                : null,
            }
          : {}),
        ...(caseVersion >= 4
          ? {
              'C7-patch-content': ['RTK-R3.v2', 'RTK-R5.v2'].includes(definition.id)
                ? [
                    'diff --git a/src/export.ts b/src/export.ts',
                    "+export const format = 'invoice-csv';",
                    '-  const invoiceRate = 0.15;',
                    '+  const invoiceRate = 0.20;',
                    '-  const batchSize = 20;',
                    '+  const batchSize = 25;',
                    '-  "precision": 2',
                    '+  "precision": 3',
                    '-Unused invoice export path',
                  ].every((expected) => actualArtifact!.toString('utf8').includes(expected))
                : null,
            }
          : {}),
      };
      attempts.push({
        case: definition.id,
        repetition,
        startedAt: began,
        endedAt: new Date().toISOString(),
        command: definition.command,
        ...(caseVersion >= 6 ? { rtkInvocations } : {}),
        checks,
        result: Object.values(checks).every((value) => value !== false) ? 'pass' : 'fail',
        raw: {
          ...raw,
          sha256: hash(raw.output),
          bytes: Buffer.byteLength(raw.output),
          characters: rawCharacters,
          estimatedTokens: Math.ceil(rawCharacters / 4),
        },
        pi: {
          output: text,
          isError: Boolean(result.isError),
          sha256: hash(text),
          bytes: Buffer.byteLength(text),
          characters,
          estimatedTokens: Math.ceil(characters / 4),
        },
        ...(expectedArtifact
          ? {
              artifact: {
                path: definition.artifact,
                expectedSha256: hash(expectedArtifact),
                actualSha256: hash(actualArtifact!),
                ...(caseVersion >= 4 ? { content: actualArtifact!.toString('utf8') } : {}),
              },
            }
          : {}),
      });
    }
  }
  if (caseVersion >= 6) {
    const display = new Set(
      definitions.filter((definition) => definition.compact).map((definition) => definition.id),
    );
    const measured = attempts as Array<{
      case: string;
      repetition: number;
      checks: Record<string, boolean | null>;
      result: string;
      raw: { characters: number };
      pi: { characters: number };
    }>;
    for (let repetition = 1; repetition <= repeatCount; repetition++) {
      const grouped = measured.filter(
        (attempt) => attempt.repetition === repetition && display.has(attempt.case),
      );
      const reduced =
        grouped.reduce((total, attempt) => total + attempt.pi.characters, 0) <
        grouped.reduce((total, attempt) => total + attempt.raw.characters, 0);
      for (const attempt of grouped) {
        attempt.checks['C4-compact'] = reduced;
        attempt.result = Object.values(attempt.checks).every((value) => value !== false)
          ? 'pass'
          : 'fail';
      }
    }
  }
  const report = {
    phase,
    startedAt,
    endedAt: new Date().toISOString(),
    commit: testedCommit,
    sourceSha256: hash(source),
    sourceState,
    harnessSha256,
    manifestSha256: hash(JSON.stringify(manifest)),
    image,
    imageId: command('docker', ['image', 'inspect', image, '--format', '{{.Id}}']),
    architecture: command('docker', ['image', 'inspect', image, '--format', '{{.Architecture}}']),
    environment: system.output,
    rtk: version,
    model: null,
    measuredModelCost: null,
    fixtureHashes: fixtures,
    attempts,
  };
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const failures = (attempts as Array<{ case: string; repetition: number; result: string }>)
    .filter((attempt) => attempt.result !== 'pass')
    .map(({ case: id, repetition }) => ({ case: id, repetition }));
  process.stdout.write(
    `${JSON.stringify({ phase, attempts: attempts.length, failures, report: join(output, 'report.json') }, null, 2)}\n`,
  );
  if (phase !== 'baseline' && failures.length) process.exitCode = 1;
} finally {
  controller.abort();
  try {
    await provider.dispose();
  } catch {}
  if (running) {
    for (const args of [
      ['exec', '--user', 'root', container, 'chmod', '-R', 'a+rwX', '/workspace'],
      ['rm', '--force', container],
    ]) {
      try {
        command('docker', args);
      } catch {}
    }
  }
  const cleaned = await Promise.allSettled([
    rm(hostRoot, { recursive: true, force: true }),
    rm(temporaryModule, { recursive: true, force: true }),
  ]);
  for (const result of cleaned)
    if (result.status === 'rejected') {
      process.stderr.write(`Evaluation cleanup failed: ${String(result.reason)}\n`);
      process.exitCode = 1;
    }
}
