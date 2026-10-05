import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const recordingRequests = new WeakMap();

export function trackDesktopAnalytics(window) {
  const pending = new Set();
  let idleTimer;
  let drained;
  let disposed = false;
  let request;
  const settle = () => {
    clearTimeout(idleTimer);
    if (drained && pending.size === 0) idleTimer = setTimeout(drained, 100);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(idleTimer);
    for (const event of ['onBeforeRequest', 'onCompleted', 'onErrorOccurred']) {
      try {
        request?.[event](null);
      } catch {}
    }
    recordingRequests.delete(window);
    drained?.();
  };
  try {
    request = window.webContents.session.webRequest;
    const filter = { urls: ['https://eu.i.posthog.com/*'] };
    request.onBeforeRequest(filter, (details, callback) => {
      if (details.webContentsId === window.webContents.id) {
        pending.add(details.id);
        settle();
      }
      callback({});
    });
    const completed = (details) => {
      pending.delete(details.id);
      settle();
    };
    request.onCompleted(filter, completed);
    request.onErrorOccurred(filter, completed);
    recordingRequests.set(window, {
      drain: () =>
        new Promise((accept) => {
          drained = accept;
          settle();
        }),
      dispose,
    });
    window.once('closed', dispose);
  } catch {
    dispose();
  }
}

export async function completeDesktopSetup(window, timeoutMs = 5000) {
  if (!window || window.isDestroyed()) return;
  let timer;
  const requests = recordingRequests.get(window);
  try {
    await Promise.race([
      Promise.resolve()
        .then(() =>
          window.webContents.executeJavaScript('window.ottoSetupAnalytics?.completed?.()'),
        )
        .then(() => requests?.drain()),
      new Promise((accept) => {
        timer = setTimeout(accept, timeoutMs);
      }),
    ]);
  } catch {
  } finally {
    clearTimeout(timer);
    requests?.dispose();
    if (!window.isDestroyed()) window.destroy();
  }
}

export function createDesktopAnalytics(path, { packaged = false, env = process.env } = {}) {
  let configuration;
  return () => {
    configuration ??= (async () => {
      let id = env.OTTO_ANALYTICS_ID;
      if (id && !uuid.test(id)) throw new Error('The analytics installation ID is invalid.');
      if (!id) {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.pending`;
        try {
          await writeFile(temporary, randomUUID(), { flag: 'wx', mode: 0o600 });
          await link(temporary, path).catch((error) => {
            if (error.code !== 'EEXIST') throw error;
          });
        } finally {
          await rm(temporary, { force: true });
        }
        id = (await readFile(path, 'utf8')).trim();
        if (!uuid.test(id)) throw new Error('The analytics installation ID is invalid.');
      }
      return {
        enabled:
          env.OTTO_ANALYTICS_ENABLED === 'true' ||
          (env.OTTO_ANALYTICS_ENABLED !== 'false' && packaged),
        distinctId: `local:${id.toLowerCase()}`,
        deployment: 'local',
        environment: packaged ? 'production' : 'development',
      };
    })();
    return configuration;
  };
}
