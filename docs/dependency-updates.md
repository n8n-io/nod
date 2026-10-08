# Dependency updates

[Dependabot](../.github/dependabot.yml) checks npm dependencies in the application, desktop app and Cloudflare adapter, GitHub Actions, Dockerfiles and Compose images every Monday at 06:00 Europe/Lisbon. Version updates wait until a release is at least three days old. Security updates are not delayed by this cooldown.

Related npm packages update together, including Pi, Tiptap, the chat SDK, React and Tailwind. Docker image updates are grouped by dependency across directories. Major updates still get pull requests for manual review. Each ecosystem allows up to ten open version-update pull requests; security updates have a separate GitHub-managed limit.

The [merge workflow](../.github/workflows/dependabot-auto-merge.yml) approves and squash-merges verified Dependabot patch and minor updates once required checks pass. Every dependency in a group must qualify. Pre-1.0 npm versions, npm prereleases, major updates and unclassified updates require manual review. Version numbers and passing CI reduce risk but do not guarantee compatibility.

The workflow runs without checking out pull request code and binds the approval and merge to a single signed Dependabot commit. It waits for required CI on a runner, with a 60-minute timeout. Failed checks, changed commits or unsatisfied branch protection leave the pull request open. After fixing or rerunning CI, rerun the merge workflow if needed.

Repository requirements:

- Keep `Checks, tests and build` and `Secret scanning` required on `main`, with the branch required to be up to date. The workflow waits for these check names to appear before watching all required checks.
- Allow GitHub Actions to approve pull requests. The workflow satisfies the existing one-review requirement.
- [CODEOWNERS](../.github/CODEOWNERS) leaves npm manifests, lockfiles, Dockerfiles and `compose.yaml` without owners, so the workflow's approval can merge those updates. GitHub Actions updates change workflow files, which need a code owner's review, so they stay open for a maintainer.
- Do not require the `auto-merge` job itself, since it waits for required checks.

This uses `GITHUB_TOKEN` and does not need a separate token or the repository's native auto-merge setting. GitHub suppresses ordinary workflow triggers from that token's merge, so the workflow explicitly dispatches CI on `main` after verifying the merge. The existing successful-main-CI deployment workflow then applies normally. If the dispatch fails after a merge, rerun CI manually on `main`.

Dependabot does not manage Python packages installed inline in Dockerfiles, downloaded tools pinned in workflow shell commands, or the desktop runtime's custom build lock. Those pins still need manual updates.

The weekly cadence collects routine updates into one review window. The three-day delay gives package registries and maintainers time to pull broken or malicious releases before Otto installs them. See GitHub's [Dependabot options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference) and [workflow token trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).
