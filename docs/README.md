# Otto docs

The source of the Otto documentation site, built with [Astro Starlight](https://starlight.astro.build). Every merge to `main` that changes this folder publishes the site to GitHub Pages.

```sh
pnpm --dir docs install --frozen-lockfile
pnpm --dir docs dev     # http://localhost:4321/otto/
pnpm --dir docs build   # fails on a broken link
```

| Path                  | What it holds                                      |
| --------------------- | -------------------------------------------------- |
| `src/content/docs/`   | Every page. The folder and file name make the URL. |
| `src/assets/`         | Logos and screenshots, with synthetic data only.   |
| `src/styles/otto.css` | The Otto theme, from the n8n brand palette.        |
| `astro.config.mjs`    | Sidebar sections, plugins and the site address.    |
| `research/`           | Hash evidence the secret-scanning self-test reads. |

Read [Write docs](src/content/docs/contribute/write-docs.mdx) for the house style, the page template, components and diagrams.
