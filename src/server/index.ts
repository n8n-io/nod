import { pool } from './db.ts';
import { authToken, dataRoot, desktopMode, host, port, publicOrigin, webRoot } from './config.ts';
import { accessKey } from './access.ts';
import { createApplication, createDefaultAdapters } from './composition.ts';

let stopping = false;
let closeApplication: (() => Promise<void>) | undefined;
const parent = (
  process as NodeJS.Process & {
    parentPort?: {
      on(event: 'message', listener: (event: { data: unknown }) => void): void;
      removeListener(event: 'message', listener: (event: { data: unknown }) => void): void;
    };
  }
).parentPort;
const runtimeReady =
  desktopMode && process.env.NOD_DESKTOP_RUNTIME_PENDING === 'true'
    ? new Promise<void>((resolve) => {
        if (!parent) throw new Error('Desktop startup requires Nod.');
        const ready = (event: { data: unknown }) => {
          if ((event.data as { type?: string })?.type !== 'nod-runtime-ready') return;
          parent.removeListener('message', ready);
          resolve();
        };
        parent.on('message', ready);
      })
    : undefined;
const { app } = await createApplication(createDefaultAdapters(process.env), {
  runtimeReady,
});
closeApplication = () => app.close();
if (!desktopMode && process.env.NODE_ENV !== 'production') {
  const { createServer } = await import('vite');
  const vite = await createServer({
    server: {
      middlewareMode: true,
      ws: { server: app.server },
      watch: { ignored: ['**/.local/**', '**/.env*'] },
      fs: {
        deny: [
          '.env',
          '.env.*',
          '**/.git/**',
          '**/.local/**',
          '**/src/server/**',
          '**/src/runtime/**',
          '**/src/providers/**',
          '**/src/ports/**',
          '**/*.pem',
        ],
      },
    },
    appType: 'spa',
  });
  await app.register((await import('@fastify/middie')).default);
  app.use((request, response, next) =>
    request.url?.startsWith('/api/') ? next() : vite.middlewares(request, response, next),
  );
  app.addHook('preClose', async () => {
    await vite.close();
  });
} else {
  await app.register((await import('@fastify/static')).default, {
    root: webRoot,
    index: 'index.html',
    wildcard: false,
  });
  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith('/api/')
      ? reply.code(404).send({ error: 'Route not found.' })
      : reply.sendFile('index.html'),
  );
}
async function shutdown(fenced = false) {
  if (stopping) return;
  stopping = true;
  let failed = fenced;
  for (const close of [() => closeApplication?.(), () => pool.end()]) {
    try {
      await close();
    } catch {
      failed = true;
    }
  }
  if (failed) console.error('Some application resources could not close.');
  process.exit(failed ? 1 : 0);
}
process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
if (desktopMode)
  process.on('disconnect', () => {
    void shutdown(true);
  });
await app.listen({
  port,
  host,
});
const address = app.server?.address();
const listeningPort = address && typeof address === 'object' ? address.port : port;
if (desktopMode)
  (
    process as NodeJS.Process & { parentPort?: { postMessage(message: unknown): void } }
  ).parentPort?.postMessage({
    type: 'nod-ready',
    port: listeningPort,
  });
else if (authToken) console.log(`Nod is ready at ${publicOrigin}`);
else console.log(`Nod is ready at ${publicOrigin}/#access=${await accessKey(dataRoot)}`);
