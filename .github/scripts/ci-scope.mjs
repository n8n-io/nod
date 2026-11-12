import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

const checks = [
  'types',
  'build',
  'integration',
  'desktop',
  'macos',
  'windows',
  'n8n',
  'evals',
  'images',
  'network',
  'ci',
];
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

export function selectChecks(paths) {
  const scope = Object.fromEntries(checks.map((name) => [name, false]));
  let testMode = 'changed';
  const testFiles = [];
  const enable = (...names) =>
    names.forEach((name) => {
      scope[name] = true;
    });
  const integration = () => {
    enable('types', 'integration', 'evals');
    testMode = 'all';
  };
  const full = () => {
    enable(...checks);
    testMode = 'all';
  };
  if (paths === null) full();
  for (const path of paths ?? []) {
    if (
      path.startsWith('docs/') ||
      /(^|\/)(README|CONTRIBUTING|AGENTS|CHANGELOG)\.md$/.test(path) ||
      /^[^/]+\.md$/.test(path) ||
      /^desktop\/.*\.md$/.test(path) ||
      /^(LICENSE|NOTICE)$/.test(path) ||
      path === 'desktop/release.json'
    )
      continue;
    if (
      /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(path) ||
      path.startsWith('patches/')
    ) {
      full();
      continue;
    }
    if (path.startsWith('src/web/')) {
      enable('types', 'build');
      if (!/\.(css|svg|png|jpe?g|webp|gif|woff2?|ico)$/.test(path)) {
        enable('integration');
        if (testMode !== 'all') testMode = 'web';
      }
      continue;
    }
    if (path.startsWith('public/') || /^(vite\.config\.ts|index\.html)$/.test(path)) {
      enable('build');
      if (path === 'vite.config.ts') enable('types');
      if (/\.(html|js)$/.test(path)) {
        enable('integration');
        if (testMode !== 'all') testMode = 'web';
      }
      continue;
    }
    if (path.startsWith('src/')) {
      integration();
      if (/^src\/(shared|ports)\//.test(path)) enable('build', 'desktop');
      if (/^src\/providers\/(docker|container-browser|agent-browser)\//.test(path))
        enable('images', 'desktop');
      if (['src/shared/public-address.ts', 'src/providers/process.ts'].includes(path))
        enable('images');
      if (path === 'src/providers/composio/identity.ts') enable('desktop', 'macos');
      if (
        [
          'src/server/vault-crypto.ts',
          'src/server/local-files.ts',
          'src/server/integration-browser.ts',
        ].includes(path)
      )
        enable('windows');
      continue;
    }
    if (path.startsWith('tests/')) {
      enable('types', 'integration');
      if (/^tests\/[^/]+\.test\.ts$/.test(path)) testFiles.push(path);
      else testMode = 'all';
      continue;
    }
    if (path === 'tsconfig.json') {
      integration();
      enable('build');
      continue;
    }
    if (path.startsWith('desktop/')) {
      enable('desktop');
      if (path.startsWith('desktop/ui/') || path === 'desktop/scripts/build-ui.mjs')
        enable('types', 'build');
      if (
        /^desktop\/(package\.json|pnpm-(lock|workspace)\.yaml|main\/(settings|mac-encryption|artifact-files|artifact-file-handlers|updates)\.mjs|scripts\/(check-native-updates|release-tools|patch-osx-sign|build-app|runtime-inputs)\.mjs)$/.test(
          path,
        )
      )
        enable('macos');
      if (
        /^desktop\/(package\.json|pnpm-(lock|workspace)\.yaml|main\/(settings|windows-update)\.mjs|runtime\/(index\.mjs|windows\.mjs|protect-profile\.ps1)|scripts\/(drop-admin-privileges\.ps1|check-windows-updates\.mjs|prepare-windows-electron\.mjs|windows-installer\.nsi)|test\/settings\.test\.mjs)$/.test(
          path,
        )
      )
        enable('windows');
      if (/^desktop\/runtime\/|^desktop\/test\/runtime-assets\.test\.mjs$/.test(path))
        enable('network');
      if (path === 'desktop/main/updates.mjs') enable('n8n');
      if (path === 'desktop/scripts/check-browser-image.mjs') enable('images');
      continue;
    }
    if (path.startsWith('deployment/n8n/')) {
      enable('n8n');
      if (
        /^deployment\/n8n\/(install\.ps1|(install\.test|install-workflow|desktop-releases)\.mjs)$/.test(
          path,
        )
      )
        enable('windows');
      continue;
    }
    if (path.startsWith('evals/')) {
      enable('evals');
      continue;
    }
    if (path.startsWith('deployment/self-host/') || /^(\.dockerignore|Dockerfile\.)/.test(path)) {
      enable('images', 'desktop');
      continue;
    }
    if (path === 'scripts/Dockerfile.integration' || path === 'scripts/test-integration.mjs') {
      integration();
      continue;
    }
    if (path === 'scripts/check-architecture.mjs') {
      enable('types');
      continue;
    }
    if (/^scripts\/eval-rtk(?:-report)?\.(ts|mjs)$/.test(path)) {
      enable('images');
      continue;
    }
    if (
      /^\.github\/(scripts\/(prepare-desktop-release|desktop-release|desktop-release-recovery|with-apple-signing)\.mjs|workflows\/(prepare-desktop-release|desktop-release|recover-desktop-release)\.yml)$/.test(
        path,
      )
    ) {
      enable('desktop', 'ci');
      if (path.endsWith('/with-apple-signing.mjs')) enable('macos');
      continue;
    }
    if (path.startsWith('.github/scripts/ci-') || path === '.github/workflows/ci.yml') {
      full();
      continue;
    }
    if (path === '.github/scripts/server-release.mjs') {
      enable('desktop');
      continue;
    }
    if (
      /^\.github\/(workflows\/|fixtures\/|ISSUE_TEMPLATE\/|CODEOWNERS$|dependabot\.yml$|pull_request_template\.md$|scripts\/check-secret-config\.py$)/.test(
        path,
      ) ||
      path === '.gitleaks.toml'
    ) {
      enable('ci');
      continue;
    }
    if (/^(\.gitignore|\.prettierignore|\.prettierrc(?:\.json)?)$/.test(path)) continue;
    full();
  }
  return { ...scope, testMode, testFiles };
}

export function requireChecks(needs) {
  if (needs.scope?.result !== 'success')
    throw new Error('CI could not select the required checks.');
  for (const name of checks) {
    if (!['true', 'false'].includes(needs.scope.outputs?.[name]))
      throw new Error(`The ${name} scope is missing or invalid.`);
  }
  for (const [name, job] of Object.entries(needs)) {
    if (!['success', 'skipped'].includes(job.result))
      throw new Error(`The ${name} check did not pass: ${job.result}.`);
  }
  for (const name of [
    'quality',
    'secrets',
    ...checks.filter((name) => !['types', 'build', 'ci', 'network'].includes(name)),
  ]) {
    const required = ['quality', 'secrets'].includes(name) || needs.scope.outputs[name] === 'true';
    if (required && needs[name]?.result !== 'success')
      throw new Error(`${name} check did not pass: ${needs[name]?.result ?? 'missing'}.`);
  }
}

if (import.meta.main) {
  if (process.argv.includes('--require-checks')) {
    requireChecks(JSON.parse(process.env.CI_NEEDS));
  } else {
    let base = process.env.CI_DIFF_BASE;
    if (!base && process.env.GITHUB_REF === 'refs/heads/release/desktop')
      base = git('merge-base', 'HEAD', 'origin/main').trim();
    let paths = null;
    if (base && !/^0+$/.test(base)) {
      if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('The CI base revision is invalid.');
      try {
        git('cat-file', '-e', `${base}^{commit}`);
        paths = git('diff', '--name-only', '--no-renames', '-z', base, 'HEAD')
          .split('\0')
          .filter(Boolean);
      } catch (error) {
        console.error(
          `${error.message}\nThe CI base revision is unavailable. All checks will run.`,
        );
      }
      if (paths?.includes('desktop/package.json')) {
        const old = JSON.parse(git('show', `${base}:desktop/package.json`));
        const current = JSON.parse(git('show', 'HEAD:desktop/package.json'));
        if (
          typeof current.version !== 'string' ||
          !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(current.version)
        )
          throw new Error('The desktop package version is invalid.');
        delete old.version;
        delete current.version;
        if (isDeepStrictEqual(old, current))
          paths = paths.filter((path) => path !== 'desktop/package.json');
      }
    }
    const { testMode, testFiles, ...scope } = selectChecks(paths);
    const available = git('ls-files', '-z', '--', 'tests/*.test.ts').split('\0').filter(Boolean);
    const selected = new Set(testFiles.filter((path) => available.includes(path)));
    if (testMode === 'all') available.forEach((path) => selected.add(path));
    if (testMode === 'web') {
      for (const path of available)
        if (/src\/web\/|dist\/web|public\//.test(await readFile(path, 'utf8'))) selected.add(path);
    }
    if (testMode === 'changed' && !selected.size) scope.integration = false;
    if (scope.integration && !selected.size)
      throw new Error('No integration test files were selected.');
    const output = { ...scope, test_files: JSON.stringify([...selected].sort()) };
    if (process.env.GITHUB_OUTPUT)
      await appendFile(
        process.env.GITHUB_OUTPUT,
        Object.entries(output)
          .map(([name, value]) => `${name}=${value}\n`)
          .join(''),
      );
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `## Selected checks\n\n${checks.map((name) => `- ${name}: ${scope[name] ? 'run' : 'skip'}`).join('\n')}\n\nIntegration test files: ${scope.integration ? selected.size : 0} of ${available.length}.\n`,
      );
    console.log(JSON.stringify(output));
  }
}
