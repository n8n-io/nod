# nod docs

The source of the nod documentation site, built with [Astro Starlight](https://starlight.astro.build). When a pull request or a push to `main` changes the site, the **Docs** workflow builds it, checks every internal link, and attaches the built site to the run as the `nod-docs` artifact.

```sh
pnpm --dir docs install --frozen-lockfile
pnpm --dir docs dev     # http://localhost:4321/nod/
pnpm --dir docs build   # fails on a broken link
```

| Path                       | What it holds                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/content/docs/`        | Every page. The folder and file name make the URL.                                                |
| `src/assets/`              | Logos and screenshots, with synthetic data only.                                                  |
| `src/styles/theme.css`     | The nod theme, from the n8n brand palette.                                                        |
| `src/pages/waitlist.astro` | The waitlist page at `/waitlist/`. Sign-ups go to the waitlist workflow on n8n, then Customer.io. |
| `astro.config.mjs`         | Sidebar sections, plugins and the site address.                                                   |

Read [Write docs](src/content/docs/contribute/write-docs.mdx) for the house style, the page template, components and diagrams.
