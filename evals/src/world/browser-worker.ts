import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createAgentBrowserComputer } from '../../../src/providers/agent-browser/index.ts';
import { startContainerBrowserWorker } from '../../../src/providers/container-browser/worker.ts';
import { containerBrowserOptions } from '../../../src/providers/container-browser/config.ts';
import { createFixtureProxy } from './fixture-proxy.ts';

const hosts = (process.env.EVAL_SITE_HOSTS ?? '').split(',').filter(Boolean);
const upstream = new URL(process.env.EVAL_SITE_UPSTREAM ?? '');
const hermetic = process.env.EVAL_SITE_HERMETIC === '1';

const worker = await startContainerBrowserWorker({
  createComputer: async (dataRoot) => {
    const proxy = await createFixtureProxy(
      join(dataRoot, 'certificate'),
      hosts,
      (request: IncomingMessage, response: ServerResponse) => {
        const forward = httpRequest(
          upstream,
          { method: request.method, path: request.url, headers: request.headers },
          (result) => {
            response.writeHead(result.statusCode ?? 502, result.headers);
            result.pipe(response);
          },
        );
        forward.on('error', () => response.writeHead(502).end());
        request.pipe(forward);
      },
      hermetic,
    );
    const computer = createAgentBrowserComputer({
      ...containerBrowserOptions(dataRoot),
      run: proxy.run,
    });
    return {
      ...computer,
      act: async (...args: Parameters<typeof computer.act>) => {
        try {
          return await computer.act(...args);
        } catch (error) {
          console.error(
            JSON.stringify({
              event: 'browser_error',
              action: (args[1] as { action?: unknown })?.action,
              message: String(error instanceof Error ? error.message : error).slice(0, 500),
            }),
          );
          throw error;
        }
      },
      dispose: async () => {
        try {
          await computer.dispose?.();
        } finally {
          await proxy.close();
        }
      },
    };
  },
});
const stop = () => void worker.close().finally(() => process.exit(0));
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
