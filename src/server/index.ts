import { pool } from './db.ts';
import {
  dataRoot,
  desktopMode,
  port,
  ownerId,
  runtimeMode,
  runtimeGeneration,
  webRoot,
} from './config.ts';
import { accessKey } from './access.ts';
import {
  createApplication,
  createDefaultAdapters,
  createGatewayApplication,
} from './composition.ts';
import { createRuntimeLease } from './runtime-lease.ts';

let stopping = false;
let closeApplication: (() => Promise<void>) | undefined;
const lease =
  runtimeMode === 'tenant'
    ? createRuntimeLease({
        expiresAt: process.env.OTTO_RUNTIME_LEASE_EXPIRES || '',
        fence: () => {
          const timer = setTimeout(() => process.exit(1), 2_000);
          timer.unref();
          void shutdown(true);
        },
      })
    : undefined;
const { app } =
  runtimeMode === 'gateway'
    ? await createGatewayApplication()
    : await createApplication(createDefaultAdapters());
closeApplication = () => app.close();
lease?.register(app);
if (runtimeMode !== 'tenant' && !desktopMode && process.env.NODE_ENV !== 'production') {
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
} else if (runtimeMode !== 'tenant') {
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
  lease?.close();
  if (failed) console.error('Some application resources could not close.');
  process.exit(failed ? 1 : 0);
}
process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
if (runtimeMode === 'tenant' || desktopMode)
  process.on('disconnect', () => {
    void shutdown(true);
  });
await app.listen({
  port,
  host:
    runtimeMode === 'local' || process.env.OTTO_BIND_HOST === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0',
});
const address = app.server?.address();
const listeningPort = address && typeof address === 'object' ? address.port : port;
if (runtimeMode === 'tenant')
  process.send?.({
    type: 'otto-ready',
    port: listeningPort,
    ownerId,
    generation: runtimeGeneration,
  });
else if (desktopMode)
  (
    process as NodeJS.Process & { parentPort?: { postMessage(message: unknown): void } }
  ).parentPort?.postMessage({ type: 'otto-ready', port: listeningPort });
else
  console.log(
    `Otto is ready at http://localhost:${listeningPort}${runtimeMode === 'local' ? `/#access=${await accessKey(dataRoot)}` : ''}`,
  );
