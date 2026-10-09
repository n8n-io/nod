# Contributing to Otto

Thanks for helping improve Otto. This guide covers how to report problems, set up a development copy and get a change merged.

## Code of conduct

Everyone taking part in Otto follows the [code of conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Report a bug** with the [bug report form](https://github.com/n8n-io/otto/issues/new/choose).
- **Ask a question or share an idea** in [Discussions](https://github.com/n8n-io/otto/discussions).
- **Report a vulnerability** privately, as described in the [security policy](SECURITY.md). Never in a public issue.
- **Send a pull request.** For anything larger than a small fix, open an issue or discussion first so we can agree on the approach before you build it.

## Development setup

You need Node.js 24.21.0 or newer, pnpm 10.34.5, Docker with Compose v2 and Git, on macOS or Linux. Follow [Install from source](README.md#install-from-source) for the first start, including the Vault key on Linux. Then run Otto with automatic reload:

```sh
pnpm run dev
```

`pnpm run dev` disables analytics by default. Use your own model key and accounts. Never use shared, production or customer credentials.

To work on the desktop app, see [desktop/README.md](desktop/README.md#development-checks). Set `OTTO_DESKTOP_USER_DATA` to a new directory to use a fresh profile.

The app, desktop build tools and Cloudflare adapter have separate pnpm lockfiles. The install uses a flat `node_modules` directory so the desktop build can copy the complete engine and its dependencies.

## How the code is organised

Read [architecture](docs/architecture.md) for how a turn flows through Otto and [AGENTS.md](AGENTS.md) for the rules every change follows, including the safety invariants. In short, `src/ports` defines capabilities, `src/providers` holds vendor SDKs, `src/runtime` owns the agent's tools and prompts, `src/server` owns policy, storage and HTTP, `src/shared` holds browser-safe types and `src/web` is the client. `src/server/composition.ts` is the only place that picks implementations.

| Area                            | Main code                                                                            | Tests                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Thread, turns, stop and reset   | `src/server/thread.ts`, `src/runtime/`                                               | `tests/thread.test.ts`, `tests/pi.test.ts`                                                                               |
| Approvals and the trust check   | `src/server/trust.ts`, `src/server/approvals.ts`, `src/shared/action-effect.ts`      | `tests/approvals.test.ts`, `tests/approvals-application.test.ts`, `tests/agent-guard.test.ts`                            |
| Vault and sign-in               | `src/server/vault.ts`, `src/runtime/browser-flows.ts`                                | `tests/vault.test.ts`, `tests/vault-chat-code.test.ts`, `tests/browser-sign-in.test.ts`                                  |
| Workspace and browser isolation | `src/providers/docker/`, `src/providers/agent-browser/`, `Dockerfile.*`              | `tests/sandbox.test.ts`, `tests/browser.test.ts`, `tests/computers.test.ts`                                              |
| Connected apps                  | `src/server/integrations.ts`, `src/providers/composio/`, `src/providers/discovered/` | `tests/integrations.test.ts`                                                                                             |
| Channels                        | `src/server/channels.ts`, `src/providers/chat-sdk/`                                  | `tests/channels.test.ts`, `tests/channel-delivery.test.ts`, `tests/channel-application.test.ts`                          |
| Schedules and background checks | `src/server/schedules.ts`, `src/server/triage.ts`                                    | `tests/schedules.test.ts`                                                                                                |
| Memory                          | `src/server/memory.ts`, `src/server/memory-learning.ts`                              | `tests/memory-application.test.ts`                                                                                       |
| Files and downloads             | `src/server/artifacts.ts`                                                            | `tests/downloads.test.ts`, `tests/download-delivery.test.ts`                                                             |
| Hosted gateway and tenants      | `src/server/gateway.ts`, `src/server/tenants.ts`, `deployment/cloudflare/`           | `tests/tenancy-auth.test.ts`, `tests/tenant-runtime.test.ts`, `tests/url-guards.test.ts`, `deployment/cloudflare/tests/` |
| Web client                      | `src/web/`                                                                           | Check the change in the running app                                                                                      |
| Desktop app                     | `desktop/`                                                                           | `desktop/test/`                                                                                                          |
| Capability evals                | `evals/`                                                                             | `evals/tests/`                                                                                                           |

Run one test file while you work:

```sh
pnpm exec tsx --test tests/approvals.test.ts
```

## Checks

Run these before you open a pull request:

```sh
pnpm run check             # types, import boundaries, formatting
pnpm test                  # deterministic tests; database cases skip without TEST_DATABASE_URL
pnpm run test:integration  # every test in Linux with a disposable PostgreSQL and Chromium
pnpm run build             # types and web bundle
```

`pnpm run test:integration` runs in an isolated Docker network, removes its containers afterwards and never uses your local database or credentials. `pnpm run format` fixes formatting.

Changes in some areas need extra checks:

| Area                     | Also run                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop/`               | `pnpm run desktop:test`                                                                                                                   |
| `evals/`                 | `pnpm --dir evals run check` and `pnpm --dir evals test`                                                                                  |
| `deployment/cloudflare/` | `pnpm --dir deployment/cloudflare run check`, `pnpm --dir deployment/cloudflare test` and the [dry runs](deployment/cloudflare/README.md) |

The capability evals call live models, so maintainers run them on releases and on request. See [evals](evals/README.md).

## Tests

Add a test when it would catch a real regression in the core harness, sandbox isolation, safety, owner and tenant isolation, or an integration contract. Extend the existing file for that area. The [test policy](AGENTS.md#tests) explains what to leave out.

Tests use synthetic data and disposable database schemas. They never call a live model, a connected account or a real recipient, and never touch your normal local database.

### RTK workspace check

Build the workspace image and run the 15 synthetic cases once:

```sh
docker build -f Dockerfile.workspace -t otto-eval-workspace:latest .
pnpm exec tsx scripts/eval-rtk.ts --smoke
```

Omit `--smoke` for three repetitions. Results go to `.local/rtk-eval/candidate`. The check uses disposable containers with networking disabled and does not call a model or connected account.

For a comparison, run `--phase baseline --baseline <commit> --image <baseline-image>` with a workspace image built from the baseline without RTK. Use the same case version and repetition count for both runs, then generate the chart and summary:

```sh
node scripts/eval-rtk-report.mjs
```

## Pull requests

- Use a [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) title: `type(scope): description`. The scope is optional. For example, use `fix(backend): handle a missing session` or `feat(web): add keyboard controls`.
- Use one of these types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style` or `revert`. Use `feat` for a feature and `fix` for a bug fix. Add `!` before the colon for a breaking change, for example `feat(api)!: remove the old route`.
- Keep each pull request focused on one change, and fill in the template.
- Explain why the change is needed and how you tested it. Add screenshots or a short video for UI changes.
- Call out changes to approvals, the trust check, Vault, sign-in, the sandbox or owner isolation. They get a closer review and need tests.
- Keep keys, credentials and private content out of code, tests, logs and screenshots.
- Follow the existing style. Otto's code has no comments or JSDoc, and its docs use short, plain sentences.

CI checks the PR title and the code. Workflows from first-time contributors start after a maintainer approves them. A member of [@n8n-io/n8n-labs](.github/CODEOWNERS) reviews every change. Use a squash merge for a normal PR. Merge commits are also allowed, as in `n8n-io/n8n`. Rebase merges are disabled. Keep the PR title as the commit title when you merge.

Require `Conventional PR title` in the status checks for `main`. In the repository merge settings, use the PR title and a blank body for both squash merges and merge commits.

## From merge to release

Merged changes go into the next desktop release. Run **Release desktop** in GitHub Actions to open a version PR. After that PR is merged and CI passes, the binary is built, signed, checked and published as a GitHub release; installed apps then update automatically. See [desktop releases](desktop/RELEASING.md). Source installs pick up changes with `git pull`.

## Coding agents

Coding agents follow [AGENTS.md](AGENTS.md), and so does everyone else. The same rules, checks and review apply whether you or an agent wrote the change.

## License

Otto is licensed under the [Apache License 2.0](LICENSE). Contributions you submit are licensed under the same terms, as section 5 of the license describes.
