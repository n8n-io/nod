# Nod desktop

The Electron app that packages Nod for Mac and Windows. It starts the same server, web app, workspace and browser as a source install, inside a private virtual machine.

- [Install the desktop app](../docs/src/content/docs/get-started/install-desktop.mdx)
- [Desktop app internals](../docs/src/content/docs/deploy/desktop-app.mdx): what runs locally, data locations, updates and limits
- [Desktop releases](../docs/src/content/docs/contribute/desktop-releases.mdx): how a version is built, signed and published

```sh
pnpm install --frozen-lockfile
pnpm --dir desktop install --frozen-lockfile
pnpm run desktop:prepare
pnpm run build
pnpm run desktop:test
pnpm run desktop:dev       # unpackaged development run
pnpm run desktop:build     # app, DMG and runtime pack in dist/desktop
```

Set `NOD_DESKTOP_USER_DATA` to a new directory for a fresh development profile.
