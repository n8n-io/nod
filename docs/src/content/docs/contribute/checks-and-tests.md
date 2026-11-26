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

App connector changes must pass `pnpm check:apps`. The required CI workflow always runs this command. See [Test the app](/contribute/apps/test/) for fixtures and separate provider acceptance.

Use these commands when needed to verify an application change. They are not a condition for opening every pull request.

```sh title="Terminal"
pnpm run check
pnpm test
pnpm run test:integration
pnpm run build
```

`pnpm run check` checks types, lint rules, import boundaries, and formatting. `pnpm run typecheck` uses the pinned Bun type checker. `pnpm run lint` runs Oxlint and the import checks. `pnpm install` installs both tools. The application and its tests still run on Node.js. `pnpm test` runs deterministic tests and skips database cases without `TEST_DATABASE_URL`. The integration command runs every test in Linux with disposable PostgreSQL and Chromium fixtures. The build command checks types and builds the app.

## Git hooks

`pnpm install` sets up Git hooks with [Lefthook](https://github.com/evilmartians/lefthook).

| Hook       | What runs                                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Pre-commit | Prettier formats your staged files. If [Gitleaks](https://github.com/gitleaks/gitleaks) is installed, it scans them for secrets. |
| Pre-push   | `pnpm run typecheck` and `pnpm run lint` run in parallel.                                                                        |

Secret scanning skips its generic keyword check in tests and fixtures. Known key formats fail everywhere, so keep test values synthetic.

## Checks for affected areas

| If you change                           | Also run                                                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop/`                              | `pnpm run desktop:test`                                                                                                                       |
| `deployment/self-host/`                 | The server and standalone bundle checks in [Self-host bundle](https://github.com/n8n-io/nod/blob/main/.github/workflows/self-host-bundle.yml) |
| `evals/`                                | `pnpm --dir evals run check` and `pnpm --dir evals test`                                                                                      |
| Docs site pages, configuration, or code | `pnpm --dir docs build`                                                                                                                       |

For Linux release packaging, run **Build Linux desktop** in Actions. It builds the x64 runtime and Flatpak, installs the bundle, and checks the engine inside it. It also sends and releases sleep prevention requests through the installed sandbox to private D-Bus services. Removing either power-service permission must block its request. These checks do not suspend the runner. The workflow saves the checked bundle as `desktop-linux-x64`. The desktop release workflow requires this build. Full KVM startup and desktop integration still need a Linux desktop check. See [Linux builds](/contribute/desktop-releases/#build-a-linux-flatpak).

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

Windows CI downloads NSIS 3.13 from its publisher and checks the pinned SHA-256 before installation. Both Windows jobs use this compiler. They do not need the Chocolatey package feed.

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

Keep independent browser cases in the matching test files so they can run in separate processes. Use short retry intervals in fixtures that check retry results, not the delay. Keep the same request count and failure checks.

Don't let a test sleep through a real-time window, such as a timeout, a backoff, a rate limit or a refresh interval. Pass a short value through an option, move the stored deadline, or use the test runner's mock timers. A test that only waits makes every run slower for everyone.

The approval application cases share one app and run in order, so they can't run in parallel inside one process. [`tests/approvals-application-cases.ts`](https://github.com/n8n-io/nod/blob/main/tests/approvals-application-cases.ts) holds the cases in three sections, and three small test files each run one section in their own process. Add a case to the section it belongs with. To run them all:

```sh title="Terminal"
pnpm exec tsx --test tests/approvals-application-*.test.ts
```

Wait for a controlled frame to finish loading before checking an old control binding. A reload can still show the previous document while navigation is pending.

## End-to-end tests

[`tests/e2e.test.ts`](https://github.com/n8n-io/nod/blob/main/tests/e2e.test.ts) checks what a user feels when they send several messages, steer and stop work, or Nod restarts. It starts the real Nod in a child process: the server, the thread worker, the Pi runtime, task sessions, schedules and the trust check, on a disposable schema in the PostgreSQL database at `TEST_DATABASE_URL`. Only the model is scripted. There is no memory or trust model, so an outside action asks, except in the approval scenarios: they add a scripted checker that allows a schedule pause only when an earlier owner message asks to pause the synthetic schedules, to check that the request still reaches the trust check in a task started from a short reply, and that a step nobody asked for still waits for the approval card. The run needs no key and gives the same result every time. The test talks to Nod over its HTTP API, like the web app, and restarts it after a real `SIGKILL`.

```mermaid
flowchart LR
  test([Scenario]):::accent -- messages, replies, Stop --> nod[Real Nod<br/>in a child process]
  nod --> pi[Pi runtime]
  pi -- each request --> model[Scripted model]:::muted
  nod --> db[(Disposable<br/>schema)]
  test -- invariants --> db
```

The scripted model behaves like a real one in the ways that matter for the harness. It reads each owner message from the request data and acknowledges every new message with a reaction before it starts work, so steered messages pile up the way they do with a live model. Its tools go through `codemode`.

| Message starts with | What the scripted model does                                                            |
| ------------------- | --------------------------------------------------------------------------------------- |
| `task:`             | Starts a task for that message. The task finishes with `Done:` and its instruction      |
| `hold:`             | Waits until the scenario calls `release` with the same text, or the turn stops          |
| Anything else       | Answers `Answer:` and the message. A scheduled run sends the answer with `send_message` |

A `task:` message that also contains `linger:` keeps the chat turn working after it starts the task, until the scenario calls `release` with the same text. Add `hold:` to keep the task working too, as in `task: linger: hold: book the venue`. Use both to interrupt Nod while the chat and its new task run.

After each scenario, `nod.violations()` checks the invariants a user relies on:

- No turn stays queued or running, and no task stays open.
- No turn failed, apart from the ones the scenario expects.
- Each task's first turn starts from the owner message it serves, and its title matches that message.
- Every owner message gets a reply, a reaction or a task.
- No owner message runs more than once.

To add a scenario, add a subtest to `tests/e2e.test.ts`. Drive Nod with `send`, `release`, `stopTask`, `stopAll`, `crash` and `restart`, check the user-visible result, then assert that `nod.violations()` is empty. A scenario must fail on the code without the fix it protects: run it against `main` once before you rely on it. Set `NOD_E2E_KEEP=1` to keep the data folder with the saved Pi sessions after a run.

Point `TEST_DATABASE_URL` at a disposable PostgreSQL, never your normal local database:

```sh title="Terminal"
docker run -d --rm --name nod-e2e-db -p 127.0.0.1:55432:5432 -e POSTGRES_USER=nod -e POSTGRES_PASSWORD=nod postgres:17-alpine
TEST_DATABASE_URL=postgres://nod:nod@127.0.0.1:55432/nod pnpm exec tsx --test tests/e2e.test.ts
```

CI runs it with the other tests whenever a change reaches the code it imports. Capability evals grade related outcomes with a real model every night, such as `two-requests-flight-then-tickets` for two requests in a row and `send-it-after-a-draft` for a send that needs no second question. See [evals](/contribute/evals/).

## Manual acceptance harness

[`scripts/e2e-nod.ts`](https://github.com/n8n-io/nod/blob/main/scripts/e2e-nod.ts) runs manual scenarios with a configured model key, disposable local database schema, and isolated browser and workspace containers. The harness supplies memory and classification curators. Its onboarding and trust reviews use the selected model at `medium`, as production does, then `low`, then `minimal`, or the model's first advertised level if none of those is supported. You can check typed approval, decline, and expiry through the configured application path. Without a `nod-workspace` container, set `NOD_E2E_NETWORK` to a Docker network you created for the harness and `NOD_E2E_WORKSPACE_IMAGE` to a workspace image, such as `nod-eval-workspace:latest`. Automated tests use synthetic curators and actions. They never call a live model or connected account.

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

CI reads the changed files on pull requests, merge queue checks and pushes to `main`. Formatting, CI selection tests and secret scanning always run. Formatting checks changed files. A change to formatter settings or root dependencies checks all files. The run summary lists the selected checks and the number of integration test files.

The required **Checks, tests and build** result keeps its existing name. One Linux runner installs dependencies once. It runs formatting, Oxlint, type checks, desktop contracts, eval contracts and application tests in parallel. A failed command fails the result. Failed or incomplete check selection also fails the result. No branch protection change is needed.

The runner builds the clients before application tests. It uses the runner's Google Chrome and a disposable PostgreSQL service that keeps its data in memory. CI uses Chromium only when Google Chrome is missing. Each test file has its own process. Half the runner's processors set how many files run at once, which is eight on CI. Independent native browser control cases and interface cases also run in parallel inside their file, with separate profiles, servers and processes. Recorded file times put the slowest files first. Without recorded times, file size sets the order. Successful runs cache file paths and times. Test results and private content do not enter this cache.

Pull requests and merge queue checks run the selected Linux checks and security scans. Native Mac, Windows installer and container deployment acceptance run on `main` when their inputs change. Daily and manual runs use every check. The desktop publication rehearsal also runs outside pull requests and the merge queue. Other selected desktop contracts stay on the PR path. Release packaging requires successful CI for the exact source revision. Release workflows also check the packaged apps before publication.

On a pull request, Vitest lists files with `--changed` against the merge base. It follows imports and does not execute the tests. The existing Node.js runner executes the selected files with PostgreSQL and Chromium. A failed selection runs all files. Merge queue checks and pushes to `main` always run the full Linux suite.

Inputs outside the import graph force a full test run. These include lockfiles, type and test configuration, client build settings, shared test fixtures, runtime skills and JSON data. Dynamically started provider worker entry points, mounted desktop code and self-host files also use full runs. Desktop runtime changes select desktop and network checks. Web source, public HTML and desktop UI code also use a full run because tests read the generated clients. Oxlint enables each stable rule that the current code can pass. Its configuration lists the rules disabled for existing findings.

```mermaid
flowchart TD
  files[Changed files] --> scope{{Select checks}}:::accent
  scope -- text only --> light[Formatting and secrets]:::muted
  scope -- web --> web[Client build and Linux tests]:::go
  scope -- tests only --> tests[Changed test files]
  scope -- server --> core[Tests reached through imports]:::go
  scope -- platform or container --> area[Linux contracts for that area]
  scope -- unknown input --> all[Every check for this stage]:::go
```

| You change                                                                  | CI also runs                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/`, Markdown files, `LICENSE` or `NOTICE`                              | No application checks. Docs changes also run the **Docs** workflow.                                                                                                                                                                                                                                                                                                      |
| Only a release's version, manifest and changelog                            | The release metadata and source check. Installers are built after merge.                                                                                                                                                                                                                                                                                                 |
| Web code or public HTML and JavaScript                                      | The client build and full Linux suite. Web source changes also run type, lint and import checks.                                                                                                                                                                                                                                                                         |
| Web CSS or public images and fonts                                          | The client build. Web source changes also run type and import checks.                                                                                                                                                                                                                                                                                                    |
| Test files only                                                             | Type, lint, import and formatting checks, plus the changed test files that still exist. A renamed test runs under its new name. A change to a shared test fixture runs the full Linux suite.                                                                                                                                                                             |
| Server, runtime, provider, shared or port code                              | Type, lint and import checks, tests reached through imports, and eval harness checks. Shared and port code also select client and desktop checks.                                                                                                                                                                                                                        |
| Container recipes, container provider code or self-host deployment files    | Desktop contracts and affected Linux tests. Self-host files select the full Linux suite. Main also runs container build and deployment acceptance.                                                                                                                                                                                                                       |
| Desktop files                                                               | Desktop contracts. Desktop main, preload and UI changes also select the full Linux suite. Runtime changes select desktop and network checks. UI changes select the client build and type checks. Application-only changes skip desktop release and runtime fixtures. Main selects native Mac and Windows acceptance for their source, package, fixture and build inputs. |
| `evals/`                                                                    | Eval harness type and contract checks with disposable PostgreSQL schemas.                                                                                                                                                                                                                                                                                                |
| `deployment/n8n/`                                                           | n8n delivery contracts. Main also selects Windows acceptance when installer inputs change.                                                                                                                                                                                                                                                                               |
| Root package files, dependency patches, CI selection code or unknown inputs | Every check for the current stage.                                                                                                                                                                                                                                                                                                                                       |

A daily CI run at 03:17 UTC uses every check, including both Mac architectures and full Windows update acceptance. A manual CI run also uses every check, except a run on `release/desktop`, which compares that branch with `main`. The shared runner fetches two commits to read the merge base. A manual run on `release/desktop` fetches full history. If that base is unavailable, CI runs every check. New pull request commits cancel older runs for that pull request. Main runs stay bound to each commit because releases require CI to pass on their exact source. Daily runs have a separate group so a push cannot cancel them.

The daily and manual Windows startup job also tests WSL errors, unfinished registrations, occupied disk folders, and a computer that lost its WSL registration but kept its disk.

The **Self-host bundle** workflow builds and checks both Linux architectures on `main` when package, container, deployment, or bundled documentation inputs change. Pull requests do not export these release bundles. It also runs each Sunday at 04:47 UTC and on request. Ordinary web and server changes do not create both bundles. To get a bundle for a specific revision, run that workflow on the revision. Draft release creation still needs its separate manual input.

The selection rules are in [`.github/scripts/ci-scope.mjs`](https://github.com/n8n-io/nod/blob/main/.github/scripts/ci-scope.mjs). The shared runner selects checks and affected tests after installing the tools. It starts without waiting for a separate selection job. CI tests these rules with disposable Git repositories, including renames, removed tests and version-only releases. Workflow changes also run a pinned, checksum-verified actionlint to check syntax and expressions.

Actionlint 1.7.12 [does not yet accept GitHub's `queue` key](https://github.com/rhysd/actionlint/issues/657). CI ignores that specific parser error and checks the queue values and cancellation settings in its own tests.

Nod keeps no Git notes. Push and manual CI runs on `main` delete any `refs/notes/*` ref on GitHub, such as the AI authorship notes that [git-ai](https://usegitai.com) pushes after each `git push`. GitHub can't block notes refs, and git-ai skips Git hooks, so don't run tools that push notes in this repository.

Pull requests that change Linux build inputs also run **Build Linux desktop**. It builds and installs the Linux x64 Flatpak preview, checks the engine and the bundle, builds, installs and uploads the Fedora RPM, and uploads the Flatpak files.

**Build desktop release** packages all desktop apps before publication. It checks Mac updates, signature rejection and profile preservation on both Mac architectures. It also checks Windows workspace paths, installation, startup and updates, and requires the Linux build to pass. A failed check blocks publication. See [Desktop releases](/contribute/desktop-releases/).

## Related resources

- [Contribute to Nod](/contribute/)
- [Capability evals](/contribute/evals/)
- [Pull requests](/contribute/pull-requests/)
- [Desktop releases](/contribute/desktop-releases/)
