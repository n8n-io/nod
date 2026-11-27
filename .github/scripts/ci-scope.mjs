import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { affectedTests, orderTests, readTimings } from './ci-tests.mjs';

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

export function selectChecks(paths, event = 'workflow_dispatch') {
  const scope = Object.fromEntries(checks.map((name) => [name, false]));
  let testMode = 'changed';
  const testFiles = [];
  const enable = (...names) =>
    names.forEach((name) => {
      scope[name] = true;
    });
  const integration = (mode = 'affected') => {
    enable('types', 'integration', 'evals');
    if (testMode !== 'all') testMode = mode;
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
        testMode = 'all';
      }
      continue;
    }
    if (path.startsWith('public/') || /^(vite\.config\.ts|index\.html)$/.test(path)) {
      enable('build');
      if (path === 'vite.config.ts') {
        integration('all');
        enable('types');
      }
      if (/\.(html|js)$/.test(path)) {
        enable('integration');
        testMode = 'all';
      }
      continue;
    }
    if (path.startsWith('src/')) {
      integration();
      if (
        !/\.[cm]?[jt]sx?$/.test(path) ||
        /(?:^|[-_.])worker\.[cm]?[jt]sx?$/i.test(path.split('/').at(-1))
      )
        testMode = 'all';
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
      if (path === 'tests/desktop-database.test.ts') enable('windows');
      if (/^tests\/[^/]+\.test\.ts$/.test(path)) testFiles.push(path);
      else testMode = 'all';
      continue;
    }
    if (path === 'tsconfig.json') {
      integration('all');
      enable('build');
      continue;
    }
    if (path.startsWith('desktop/')) {
      enable('desktop');
      if (/^desktop\/(main|preload)\//.test(path)) {
        enable('integration');
        testMode = 'all';
      }
      if (path.startsWith('desktop/ui/') || path === 'desktop/scripts/build-ui.mjs') {
        enable('types', 'build', 'integration');
        testMode = 'all';
      }
      if (
        /^desktop\/(package\.json|pnpm-(lock|workspace)\.yaml|main\/(settings|mac-encryption|artifact-files|artifact-file-handlers|updates)\.mjs|scripts\/(check-native-updates|release-tools|patch-osx-sign|build-app|runtime-inputs)\.mjs)$/.test(
          path,
        )
      )
        enable('macos');
      if (
        /^desktop\/(package\.json|pnpm-(lock|workspace)\.yaml|main\/(settings|system-awake|windows-update)\.mjs|runtime\/(index\.mjs|windows\.mjs|database\.mjs|protect-profile\.ps1)|scripts\/(drop-admin-privileges\.ps1|check-windows-updates\.mjs|postgres-binaries\.mjs|prepare-windows-electron\.mjs|windows-installer\.nsi)|test\/settings\.test\.mjs)$/.test(
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
      if (path.startsWith('deployment/self-host/')) {
        enable('integration');
        testMode = 'all';
      }
      continue;
    }
    if (path === 'scripts/Dockerfile.integration' || path === 'scripts/test-integration.mjs') {
      integration('all');
      continue;
    }
    if (path === 'scripts/check-architecture.mjs') {
      enable('types');
      continue;
    }
    if (/^(\.oxlintrc\.json|bunfig\.toml)$/.test(path)) {
      enable('types', 'ci');
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
  if (['pull_request', 'merge_group'].includes(event)) {
    scope.macos = false;
    scope.windows = false;
    scope.images = false;
  }
  return { ...scope, testMode, testFiles };
}

export function selectDesktopTests(paths, available) {
  const applicationOnly =
    paths !== null &&
    paths.every(
      (path) =>
        /^(src\/(web|shared|ports|server|runtime)\/|tests\/|docs\/|public\/|evals\/|desktop\/ui\/)/.test(
          path,
        ) || /\.md$/.test(path),
    );
  return applicationOnly
    ? available.filter((path) => !/\/(runtime-assets|linux-release)\.test\.mjs$/.test(path))
    : available;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--format')) {
    const files = JSON.parse(process.env.NOD_FORMAT_FILES);
    if (files === null || files.length)
      execFileSync(
        'pnpm',
        ['exec', 'prettier', '--check', '--ignore-unknown', '--', ...(files ?? ['.'])],
        { stdio: 'inherit' },
      );
  } else if (process.argv.includes('--desktop-tests')) {
    execFileSync(
      process.execPath,
      [
        '--test',
        ...(process.env.NOD_DESKTOP_RELEASE_ACCEPTANCE === 'false'
          ? [
              '--test-skip-pattern',
              '^all four checked bundles publish together as one regular Nod release$',
            ]
          : []),
        ...JSON.parse(process.env.NOD_DESKTOP_TEST_FILES),
      ],
      {
        stdio: 'inherit',
      },
    );
  } else {
    let base = process.env.CI_DIFF_BASE;
    if (!base && process.env.GITHUB_REF === 'refs/heads/release/desktop')
      base = git('merge-base', 'HEAD', 'origin/main').trim();
    let paths = null;
    if (base && !/^0+$/.test(base)) {
      if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('The CI base revision is invalid.');
      try {
        git('cat-file', '-e', `${base}^{commit}`);
        base = git('merge-base', base, 'HEAD').trim();
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
    let { testMode, testFiles, ...scope } = selectChecks(paths, process.env.GITHUB_EVENT_NAME);
    if (['push', 'merge_group'].includes(process.env.GITHUB_EVENT_NAME)) {
      scope.integration = true;
      testMode = 'all';
    }
    const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
    const available = tracked.filter((path) => /^tests\/[^/]+\.test\.ts$/.test(path));
    const selected = new Set(testFiles.filter((path) => available.includes(path)));
    if (testMode === 'all') available.forEach((path) => selected.add(path));
    if (testMode === 'affected') {
      const incremental =
        !process.env.GITHUB_EVENT_NAME || process.env.GITHUB_EVENT_NAME === 'pull_request';
      let affected = available;
      if (incremental) {
        try {
          affected = affectedTests(base, available);
        } catch (error) {
          console.error(
            `${error.message}\nTest dependency selection failed. All integration test files will run.`,
          );
        }
      }
      affected.forEach((path) => selected.add(path));
    }
    if (scope.integration && testMode === 'all' && !selected.size)
      throw new Error('No integration test files were selected.');
    if (!selected.size) scope.integration = false;
    const timings = process.env.CI_TEST_TIMINGS
      ? await readTimings(process.env.CI_TEST_TIMINGS)
      : {};
    const selectedFiles = [...selected].sort();
    const formatAll =
      paths === null ||
      paths.some((path) => /^(\.prettier|package\.json$|pnpm-lock\.yaml$)/.test(path));
    const quality = ['format'];
    if (
      scope.types ||
      scope.ci ||
      paths === null ||
      paths.some((path) => /\.[cm]?[jt]sx?$|\.oxlintrc\.json$/.test(path))
    )
      quality.push('lint');
    if (scope.types) quality.push('types');
    if (scope.build) quality.push('build');
    const output = {
      ...scope,
      test_files: JSON.stringify(await orderTests(selectedFiles, timings)),
      desktop_test_files: JSON.stringify(
        selectDesktopTests(
          paths,
          tracked.filter((path) => /^desktop\/test\/[^/]+\.test\.mjs$/.test(path)),
        ),
      ),
      quality_checks: JSON.stringify(quality),
      format_files: JSON.stringify(
        formatAll ? null : paths.filter((path) => tracked.includes(path)),
      ),
    };
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
