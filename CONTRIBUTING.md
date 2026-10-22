# Contributing to nod

Thanks for helping improve nod. The full guide is in the docs: [Contribute to nod](docs/src/content/docs/contribute/index.mdx). This page has the essentials.

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Report a bug** with the [bug report form](https://github.com/n8n-io/nod/issues/new/choose).
- **Ask a question or share an idea** in [Discussions](https://github.com/n8n-io/nod/discussions).
- **Report a vulnerability** privately, as described in the [security policy](SECURITY.md). Never in a public issue.
- **Send a pull request.** For anything larger than a small fix, open an issue or discussion first.

## Set up and check

Follow [Install from source](docs/src/content/docs/get-started/install-from-source.mdx), then run nod with automatic reload:

```sh
pnpm run dev
```

Use your own model key and accounts. Before you open a pull request, run:

```sh
pnpm run check             # types, import boundaries, formatting
pnpm test                  # deterministic tests
pnpm run test:integration  # every test in Linux with a disposable PostgreSQL and Chromium
pnpm run build             # types and web bundle
```

Some areas need extra checks, such as `pnpm run desktop:test` or `pnpm --dir docs build`. See [Checks and tests](docs/src/content/docs/contribute/checks-and-tests.md).

## Pull requests

- Use a [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) title, such as `fix(backend): handle a missing session`.
- Keep each pull request to one change, fill in the template, and explain why and how you tested it.
- Call out changes to approvals, the trust check, Vault, sign-in, the sandbox or owner isolation.
- Keep keys, credentials and private content out of code, tests, logs and screenshots.
- Update the docs in [`docs/`](docs/README.md) when setup or behaviour changes.

A member of [@n8n-io/n8n-labs](.github/CODEOWNERS) reviews every change. See [Pull requests](docs/src/content/docs/contribute/pull-requests.md) for review, merge and release details.

## License

nod is licensed under the [Apache License 2.0](LICENSE). Contributions you submit are licensed under the same terms, as section 5 of the license describes.
