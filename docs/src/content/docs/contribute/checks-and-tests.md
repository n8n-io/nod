---
title: Checks and tests
description: Choose checks for your change, use the Git hooks, and understand which tests and CI checks apply.
sidebar:
  order: 2
---

Choose checks that match the files and behavior you change. This page explains the available commands, Git hooks, test policy, and CI checks.

## Choose the checks

Start with focused checks. Run broader checks only when the change affects shared behavior or the focused checks cannot verify it.

| If you change                              | Check                                                                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| README, contributor instructions, or media | Format the changed text files, check links, and review the rendered text and media. Application lint, tests, and builds are not needed. |
| Docs site pages, configuration, or code    | Run `pnpm --dir docs build` and review the affected pages.                                                                              |
| Application code                           | Run focused tests and the type, import, formatting, or build checks needed for the affected behavior.                                   |

For example, check README formatting with:

```sh title="Terminal"
pnpm exec prettier --check README.md
```

To run one test file while you work:

```sh title="Terminal"
pnpm exec tsx --test tests/approvals.test.ts
```

## Available application checks

Use these commands when needed to verify an application change. They are not a condition for opening every pull request.

```sh title="Terminal"
pnpm run check
pnpm test
pnpm run test:integration
pnpm run build
```

`pnpm run check` checks types, import boundaries, and formatting. `pnpm test` runs deterministic tests and skips database cases without `TEST_DATABASE_URL`. The integration command runs every test in Linux with disposable PostgreSQL and Chromium fixtures. The build command checks types and builds the app.

## Git hooks

`pnpm install` sets up Git hooks with [Lefthook](https://github.com/evilmartians/lefthook).

| Hook       | What runs                                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Pre-commit | Prettier formats your staged files. If [Gitleaks](https://github.com/gitleaks/gitleaks) is installed, it scans them for secrets. |
| Pre-push   | `pnpm run lint`: `pnpm run check` without formatting. It type-checks and checks import boundaries.                               |

Secret scanning skips its generic keyword check in tests and fixtures. Known key formats fail everywhere, so keep test values synthetic.

## Checks for affected areas

| If you change                           | Also run                                                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop/`                              | `pnpm run desktop:test`                                                                                                                       |
| `deployment/self-host/`                 | The server and standalone bundle checks in [Self-host bundle](https://github.com/n8n-io/nod/blob/main/.github/workflows/self-host-bundle.yml) |
| `evals/`                                | `pnpm --dir evals run check` and `pnpm --dir evals test`                                                                                      |
| Docs site pages, configuration, or code | `pnpm --dir docs build`                                                                                                                       |

For Linux release packaging, run **Build Linux desktop** in Actions. It builds the x64 runtime and Flatpak, installs the bundle, and checks the engine inside it. It saves checked bundle parts as `desktop-linux-x64`. The desktop release workflow requires this build. Full KVM startup and desktop integration still need a Linux desktop check. See [Linux builds](/contribute/desktop-releases/#build-a-linux-flatpak).

The [capability evals](/contribute/evals/) call live models, so they aren't part of these checks. They run nightly and on request.

When the evaluation harness changes, CI starts PostgreSQL for its database checks. These checks use synthetic data and disposable schemas.

## Security checks

The **Security analysis** workflow runs on pull requests, on `main`, and each week. Semgrep runs its `p/ci` rules on the repository. Error-level findings fail the job. Metrics and version checks are off. Review parser warnings because a partial parse can leave code unchecked. Run the same check locally:

```sh
semgrep scan --config p/ci --severity ERROR --metrics off --disable-version-check --error .
```

CodeQL checks JavaScript, TypeScript, and Python when the repository is public. To use it while the repository is private, enable GitHub Code Security and set `NOD_PRIVATE_CODEQL` to `true`. The workflow does not change repository access or branch protection.

CI also runs Gitleaks on all fetched Git refs and the checkout. It downloads the pinned scanner through the authenticated GitHub API and checks its SHA-256 before extraction. The exceptions in `.gitleaks.toml` name exact public values, source hashes, or synthetic fixtures. Do not add an exception for a live credential.

Windows CI downloads Electron through the authenticated GitHub API. The download, cached archives, native fixtures and release build use the checksums shipped with the pinned Electron package. The download token is scoped to its preparation step and is not passed to the test apps.

Native Mac update fixtures also use the checksums shipped with the pinned Electron package. They verify the archive without a separate checksum download.

Check dependency advisories in each package:

```sh
pnpm audit
pnpm --dir desktop audit
pnpm --dir docs audit
```

The workspace image installs Python packages from `src/providers/docker/workspace-artifacts.txt` and `workspace-video.txt` with `--require-hashes`. Their `.in` files hold the direct requirements. To update a file, change its `.in` file and compile it with `uv`:

```sh
uv pip compile src/providers/docker/workspace-artifacts.in --python-version 3.11 --python-platform x86_64-manylinux_2_28 --generate-hashes --no-header --no-annotate --output-file src/providers/docker/workspace-artifacts.txt
```

Use the same command for `workspace-video.in`. Check both Linux AMD64 and ARM64 installs. The desktop runtime fingerprint includes both lockfiles, so a change requires a new runtime pack.

Before changing repository visibility, scan all branches and tags. Review existing releases, Actions logs, and downloadable artifacts for private content. GitHub makes the existing Actions history and logs public with the repository. Rotate any exposed credential before publication; deleting its current file does not remove Git history.

## Integration tests

`pnpm run test:integration` runs every test file in Linux, with Chromium and a throwaway PostgreSQL database. It never uses your local database or credentials.

```mermaid
flowchart LR
  build[Build the web bundle<br/>and browser image] --> net[Create an internal<br/>Docker network]:::muted
  net --> db[(Throwaway<br/>PostgreSQL)]
  net --> run[Run every test<br/>with Chromium]:::accent
  run --> clean[Remove containers<br/>and network]
```

The network has no internet access, and your source folders are mounted read-only. The run fails if any test is skipped.

Wait for a controlled frame to finish loading before checking an old control binding. A reload can still show the previous document while navigation is pending.

## Manual acceptance harness

[`scripts/e2e-nod.ts`](https://github.com/n8n-io/nod/blob/main/scripts/e2e-nod.ts) runs manual scenarios with a configured model key, disposable local database schema, and isolated browser and workspace containers. The harness supplies memory and classification curators. Its onboarding and trust reviews use the selected model at its lightest effort, as production does. This is the first advertised `off`, `minimal`, `low`, or `medium` level, or the model's first advertised level if none of those is supported. You can check typed approval, decline, and expiry through the configured application path. Automated tests use synthetic curators and actions. They never call a live model or connected account.

## Mac guest protection

Run this check on a Mac with Docker running. It creates a disposable Lima VM from a prepared runtime pack. It tests normal startup, stacked AppArmor signals, mount restrictions, and PostgreSQL data after a restart with the old profile restored. It does not use your Nod profile or connected accounts. The check needs 3 GiB of VM memory. It stops the VM before deleting its files. If the VM cannot stop, the check keeps its control files for recovery.

```sh title="Terminal"
pnpm run desktop:prepare
NOD_TEST_GUEST_ASSETS="$PWD/.local/desktop-runtime-assets" node --test --test-name-pattern='guest repair' desktop/test/runtime-assets.test.mjs
```

The normal desktop tests skip this check when `NOD_TEST_GUEST_ASSETS` is absent or the host is not macOS.

## Write tests that catch real regressions

Add a test only when it would catch a real regression in one of these areas. Extend the existing file for that area instead of adding a new one.

| Area                  | For example                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Core harness          | One thread per owner, saved chat and task sessions, one turn per session at a time, stop, interruption, reset and session rebase |
| Sandbox isolation     | Nothing on the host, no keys in the sandbox, contained paths                                                                     |
| Safety                | Approvals, uncertain actions, Vault and sign-in fencing, onboarding task cards                                                   |
| Owner isolation       | Owner scoping, local access, URL guards, redaction                                                                               |
| Integration contracts | Channel delivery, schedule firing, downloads, OAuth completion                                                                   |

Leave out tautological tests, mocks that return what they were told, and tests of UI copy, wording, CSS, constants or configuration. For a change in `src/web`, check it in the running app instead.

## Keep test data synthetic

- Use made-up names, addresses such as `example.com` and fake keys.
- Use disposable database schemas. Never reset or write to your normal local database.
- Never call a live model, a connected account or a real recipient from a test.
- Keep keys, real accounts and private content out of fixtures, logs and screenshots.

## RTK workspace check

The workspace image includes [RTK](https://github.com/rtk-ai/rtk), which shortens command output for the model. This check measures its savings and confirms that exports and file searches stay unfiltered. It runs 15 synthetic cases in disposable containers with networking off. It doesn't call a model or a connected account.

```sh title="Terminal"
docker build -f Dockerfile.workspace -t nod-eval-workspace:latest .
pnpm exec tsx scripts/eval-rtk.ts --smoke
```

`--smoke` runs each case once. Leave it out for three repetitions. Results go to `.local/rtk-eval/candidate`.

To compare with an image built without RTK, run `--phase baseline --baseline <commit> --image <baseline-image>` with the same case version and repetition count. Then run `node scripts/eval-rtk-report.mjs` for the chart and summary.

## What CI checks

CI reads the changed files on pull requests, merge queue checks and pushes to `main`. Formatting, CI selection tests and secret scanning always run. The run summary lists the selected checks and the number of integration test files.

The required **Checks, tests and build** result keeps its existing name. It waits for each selected job. A failed scope check, missing scope output, failed job or selected job that was skipped makes this result fail. The native Windows result is included. No branch protection change is needed.

Application, desktop, native, eval and container jobs can run in parallel after file selection. Linux checks do not wait for Mac checks. Type checks run once in the quality job. Integration tests build their own web fixture inside the cached test image. They use the dependencies in that image without an install on the runner, and run up to four test files at a time, within the available CPU count.

```mermaid
flowchart TD
  files[Changed files] --> scope{{Select checks}}:::accent
  scope -- text only --> light[Formatting and secrets]:::muted
  scope -- web --> web[Client build and web tests]:::go
  scope -- tests only --> tests[Changed test files]
  scope -- server --> core[Full Linux test suite]:::go
  scope -- platform or container --> area[Checks for that area]
  scope -- unknown input --> all[Every check]:::go
```

| You change                                                                  | CI also runs                                                                                                                                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/`, Markdown files, `LICENSE` or `NOTICE`                              | No application checks. Docs changes also run the **Docs** workflow.                                                                                                             |
| Only a release's version, manifest and changelog                            | The release metadata and source check. Installers are built after merge.                                                                                                        |
| Web code or public HTML and JavaScript                                      | The client build and tests that refer to web code, built web files or public files. Web source changes also run type and import checks.                                         |
| Web CSS or public images and fonts                                          | The client build. Web source changes also run type and import checks.                                                                                                           |
| Test files only                                                             | Type checks and the changed test files that still exist. A renamed test runs under its new name. A change to a shared test fixture runs the full Linux suite.                   |
| Server, runtime, provider, shared or port code                              | Type and import checks, the full Linux suite and eval harness checks. Shared and port code also select client and desktop checks.                                               |
| Container recipes, container provider code or self-host deployment files    | Container build and deployment checks, plus desktop contracts.                                                                                                                  |
| Desktop files                                                               | Desktop contracts. Desktop UI changes also select the client build and type checks. Native Mac and Windows checks run only for their source, package, fixture and build inputs. |
| `evals/`                                                                    | Eval harness type and contract checks with disposable PostgreSQL schemas.                                                                                                       |
| `deployment/n8n/`                                                           | n8n delivery contracts, plus Windows checks when installer inputs change.                                                                                                       |
| Root package files, dependency patches, CI selection code or unknown inputs | Every check.                                                                                                                                                                    |

A daily CI run at 03:17 UTC uses every check, including both Mac architectures and full Windows update acceptance. A manual CI run also uses every check, except a run on `release/desktop`, which compares that branch with `main`. The scope job reads full Git history so a base branch update does not hide the diff base. If that base is unavailable, CI runs every check. New pull request commits cancel older runs for that pull request. Main runs stay bound to each commit because releases require CI to pass on their exact source. Daily runs have a separate group so a push cannot cancel them.

The **Self-host bundle** workflow builds and checks both Linux architectures when package, container, deployment, or bundled documentation inputs change. It also runs each Sunday at 04:47 UTC and on request. Ordinary web and server changes do not create both bundles. To get a bundle for a specific revision, run that workflow on the revision. Draft release creation still needs its separate manual input.

The selection and required-result rules are in [`.github/scripts/ci-scope.mjs`](https://github.com/n8n-io/nod/blob/main/.github/scripts/ci-scope.mjs). CI tests these rules with disposable Git repositories, including renames, removed tests and version-only releases. Workflow changes also run a pinned, checksum-verified actionlint to check syntax and expressions.

Actionlint 1.7.12 [does not yet accept GitHub's `queue` key](https://github.com/rhysd/actionlint/issues/657). CI ignores that specific parser error and checks the queue values and cancellation settings in its own tests.

Nod keeps no Git notes. Push and manual CI runs on `main` delete any `refs/notes/*` ref on GitHub, such as the AI authorship notes that [git-ai](https://usegitai.com) pushes after each `git push`. GitHub can't block notes refs, and git-ai skips Git hooks, so don't run tools that push notes in this repository.

Pull requests that change Linux build inputs also run **Build Linux desktop**. It builds and installs the Linux x64 Flatpak preview, checks the engine and bundle parts, and uploads the files.

**Build desktop release** packages all desktop apps before publication. It checks Mac updates, signature rejection and profile preservation on both Mac architectures. It also checks Windows workspace paths, installation, startup and updates, and requires the Linux build to pass. A failed check blocks publication. See [Desktop releases](/contribute/desktop-releases/).

## Related resources

- [Contribute to Nod](/contribute/)
- [Capability evals](/contribute/evals/)
- [Pull requests](/contribute/pull-requests/)
- [Desktop releases](/contribute/desktop-releases/)
