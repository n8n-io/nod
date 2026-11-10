# Nod docs

The source of [Nod's documentation](https://nod.n8n.io/docs/), built with [Astro Starlight](https://starlight.astro.build) and hosted on Cloudflare Pages. The **Docs** workflow builds and checks the site, and on `main` deploys it with the landing page to nod.n8n.io; see [Publish the docs](src/content/docs/contribute/write-docs.mdx#publish-the-docs).

```sh
pnpm --dir docs install --frozen-lockfile
pnpm --dir docs dev
pnpm --dir docs build
```

The dev server opens at `http://localhost:4321/docs/`. The build fails on a broken link.

| Path                       | What it holds                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/content/docs/`        | Every page. The folder and file name make the URL.                                                     |
| `src/assets/`              | Logos and screenshots, with synthetic data only.                                                       |
| `src/styles/theme.css`     | The Nod theme, from the n8n brand palette.                                                             |
| `src/pages/waitlist.astro` | The waitlist page at `/waitlist/`. Sign-ups go to the waitlist workflow on n8n, then Customer.io.      |
| `src/pages/next.astro`     | The landing page at `/next/` and the root of nod.n8n.io, with `src/scripts/` and `src/styles/nod.css`. |
| `astro.config.mjs`         | Sidebar sections, plugins and the site address.                                                        |

Read [Write docs](src/content/docs/contribute/write-docs.mdx) for the house style, the page template, components and diagrams.
