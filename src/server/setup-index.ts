import { dataRoot, desktopAccess, desktopMode, ownerId, port, webRoot } from './config.ts';
import { createDesktopSetupAdapters, createDesktopSetupKeyStore } from './composition.ts';
import { createDesktopSetup } from './desktop-setup.ts';

const parent = (
  process as NodeJS.Process & {
    parentPort?: {
      postMessage(message: unknown): void;
      on(event: 'message', listener: (message: { data: unknown }) => void): void;
    };
  }
).parentPort;
if (!desktopMode || !desktopAccess || !parent) throw new Error('Desktop setup requires Otto.');
const setup = await createDesktopSetup({
  root: dataRoot,
  ownerId,
  port,
  token: desktopAccess.token,
  keyStore: createDesktopSetupKeyStore(),
  adapters: createDesktopSetupAdapters,
  complete: () => parent.postMessage({ type: 'otto-setup-complete' }),
  retry: () => parent.postMessage({ type: 'otto-setup-retry' }),
});
await setup.app.register((await import('@fastify/static')).default, {
  root: webRoot,
  index: 'index.html',
  wildcard: false,
});
setup.app.setNotFoundHandler((request, reply) =>
  request.url.startsWith('/api/')
    ? reply.code(404).send({ error: 'Route not found.' })
    : reply.sendFile('index.html'),
);
parent.on('message', (event) => {
  const message = event.data as { type?: string; phase?: string; id?: string };
  if (
    message?.type === 'otto-setup-runtime' &&
    ['preparing', 'ready', 'error'].includes(message.phase ?? '')
  )
    setup.status({
      phase: message.phase as 'preparing' | 'ready' | 'error',
      message:
        message.phase === 'error'
          ? 'Setup needs another try. Your progress is saved.'
          : message.phase === 'ready'
            ? 'Your computer is ready.'
            : 'Preparing your computer…',
    });
  if (message?.type === 'otto-setup-ack' && typeof message.id === 'string')
    void setup
      .acknowledge(message.id)
      .then(() => parent.postMessage({ type: 'otto-setup-cleaned' }))
      .catch(() => parent.postMessage({ type: 'otto-setup-cleanup-failed' }));
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await setup.app.close().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
process.on('disconnect', () => void stop());
await setup.app.listen({ port, host: '127.0.0.1' });
parent.postMessage({ type: 'otto-setup-ready', port });
setup.resume();
