import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const scope = Object.fromEntries(
  ['core', 'desktop', 'windows', 'n8n', 'evals', 'images', 'network'].map((name) => [name, false]),
);
const full = () =>
  Object.keys(scope).forEach((name) => {
    scope[name] = true;
  });
const core = () =>
  ['core', 'desktop', 'evals', 'images'].forEach((name) => {
    scope[name] = true;
  });
let base = process.env.CI_DIFF_BASE;
if (!base && process.env.GITHUB_REF === 'refs/heads/release/desktop')
  base = git('merge-base', 'HEAD', 'origin/main');
if (!base || /^0+$/.test(base)) full();
else {
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('The CI base revision is invalid.');
  git('cat-file', '-e', `${base}^{commit}`);
  const paths = git('diff', '--name-only', '--no-renames', '-z', base, 'HEAD')
    .split('\0')
    .filter(Boolean);
  for (const path of paths) {
    if (
      /^docs\//.test(path) ||
      /(^|\/)(README|CONTRIBUTING|AGENTS|CHANGELOG)\.md$/.test(path) ||
      /^[^/]+\.md$/.test(path) ||
      /^desktop\/.*\.md$/.test(path) ||
      /^(LICENSE|NOTICE)$/.test(path)
    )
      continue;
    if (['desktop/release.json', 'desktop/CHANGELOG.md'].includes(path)) continue;
    if (path === 'desktop/package.json') {
      const old = JSON.parse(git('show', `${base}:${path}`));
      const current = JSON.parse(git('show', `HEAD:${path}`));
      if (
        typeof current.version !== 'string' ||
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(current.version)
      )
        throw new Error('The desktop package version is invalid.');
      delete old.version;
      delete current.version;
      if (isDeepStrictEqual(old, current)) continue;
    }
    if (
      /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.json|vite\.config\.ts|index\.html|\.dockerignore|Dockerfile\.)/.test(
        path,
      )
    ) {
      core();
      if (/^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(path)) scope.windows = true;
      scope.n8n = true;
      continue;
    }
    if (/^(src|public|tests)\//.test(path)) {
      core();
      if (
        path === 'src/server/vault-crypto.ts' ||
        path === 'src/server/local-files.ts' ||
        path === 'src/server/integration-browser.ts'
      )
        scope.windows = true;
      continue;
    }
    if (path.startsWith('desktop/')) {
      scope.desktop = true;
      if (
        /^desktop\/(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|main\/(settings|windows-update)\.mjs|runtime\/(index\.mjs|windows\.mjs|protect-profile\.ps1)|scripts\/(drop-admin-privileges\.ps1|check-windows-updates\.mjs|windows-installer\.nsi)|test\/settings\.test\.mjs)$/.test(
          path,
        )
      )
        scope.windows = true;
      if (/^desktop\/runtime\/|^desktop\/test\/runtime-assets\.test\.mjs$/.test(path))
        scope.network = true;
      if (path === 'desktop/main/updates.mjs') scope.n8n = true;
      if (path === 'desktop/scripts/check-browser-image.mjs') scope.images = true;
      continue;
    }
    if (path.startsWith('deployment/n8n/')) {
      scope.n8n = true;
      if (
        /^deployment\/n8n\/(install\.ps1|(install\.test|install-workflow|desktop-releases)\.mjs)$/.test(
          path,
        )
      )
        scope.windows = true;
      continue;
    }
    if (path.startsWith('evals/')) {
      scope.evals = true;
      continue;
    }
    if (
      /^\.github\/(scripts\/(prepare-desktop-release|desktop-release|with-apple-signing)\.mjs|workflows\/(prepare-desktop-release|desktop-release)\.yml)$/.test(
        path,
      )
    ) {
      scope.desktop = true;
      continue;
    }
    if (
      /^(\.gitignore|\.prettierignore|\.prettierrc(?:\.json)?|\.github\/ISSUE_TEMPLATE\/|\.github\/pull_request_template\.md|\.github\/workflows\/docs\.yml$)/.test(
        path,
      )
    )
      continue;
    full();
  }
}
if (process.env.GITHUB_OUTPUT)
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(scope)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(''),
  );
console.log(JSON.stringify(scope));
