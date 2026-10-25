# nod docs

The source of [nod's documentation](https://nod-docs.pages.dev), built with [Astro Starlight](https://starlight.astro.build) and hosted on Cloudflare Pages. The **Docs** workflow builds and checks the site, then attaches a `nod-docs` artifact. Publishing is a separate step; see [Publish the docs](src/content/docs/contribute/write-docs.mdx#publish-the-docs).

```sh
pnpm --dir docs install --frozen-lockfile
pnpm --dir docs dev
pnpm --dir docs build
```

The dev server opens at `http://localhost:4321/`. The build fails on a broken link.

| Path                       | What it holds                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/content/docs/`        | Every page. The folder and file name make the URL.                                                |
| `src/assets/`              | Logos and screenshots, with synthetic data only.                                                  |
| `src/styles/theme.css`     | The nod theme, from the n8n brand palette.                                                        |
| `src/pages/waitlist.astro` | The waitlist page at `/waitlist/`. Sign-ups go to the waitlist workflow on n8n, then Customer.io. |
| `astro.config.mjs`         | Sidebar sections, plugins and the site address.                                                   |

Read [Write docs](src/content/docs/contribute/write-docs.mdx) for the house style, the page template, components and diagrams.
