# Cloudflare deployment

Hosted Otto on Cloudflare: a public Worker, a private gateway, and one tenant, browser and workspace container per user. The operator guide is [Hosted on Cloudflare](../../docs/src/content/docs/deploy/cloudflare.mdx), and the design is in [Hosted mode](../../docs/src/content/docs/how-it-works/hosted-mode.mdx).

```sh
pnpm install --frozen-lockfile && pnpm run build
pnpm --dir deployment/cloudflare install --frozen-lockfile
pnpm --dir deployment/cloudflare run check
pnpm --dir deployment/cloudflare test
cd deployment/cloudflare
pnpm exec wrangler deploy --env development --dry-run --containers-rollout=none
pnpm exec wrangler deploy --env production --dry-run --containers-rollout=none
```
