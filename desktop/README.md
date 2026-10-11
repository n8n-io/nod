# Otto desktop

The Electron app that packages Otto for Mac and Windows. It starts the same server, web app, workspace and browser as a source install, inside a private virtual machine.

- [Install the desktop app](https://n8n-io.github.io/otto/get-started/install-desktop/)
- [Desktop app internals](https://n8n-io.github.io/otto/deploy/desktop-app/): what runs locally, data locations, updates and limits
- [Desktop releases](https://n8n-io.github.io/otto/contribute/desktop-releases/): how a version is built, signed and published

```sh
pnpm install --frozen-lockfile
pnpm --dir desktop install --frozen-lockfile
pnpm run desktop:prepare
pnpm run build
pnpm run desktop:test
pnpm run desktop:dev       # unpackaged development run
pnpm run desktop:build     # app, DMG and runtime pack in dist/desktop
```

Set `OTTO_DESKTOP_USER_DATA` to a new directory for a fresh development profile.
