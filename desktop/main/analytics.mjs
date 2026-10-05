import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const recordingRequests = new WeakMap();
const sessionRequests = new WeakMap();

function sessionRecordings(session) {
  let recordings = sessionRequests.get(session);
  if (recordings) return recordings;
  recordings = new Map();
  const filter = { urls: ['https://eu.i.posthog.com/*'] };
  session.webRequest.onBeforeRequest(filter, (details, callback) => {
    recordings.get(details.webContentsId)?.started(details.id);
    callback({});
  });
  const completed = (details) => {
    for (const recording of recordings.values()) recording.completed(details.id);
  };
  session.webRequest.onCompleted(filter, completed);
  session.webRequest.onErrorOccurred(filter, completed);
  sessionRequests.set(session, recordings);
  return recordings;
}

export function trackDesktopAnalytics(window) {
  if (recordingRequests.has(window)) return;
  const pending = new Set();
  let idleTimer;
  let drained;
  let disposed = false;
  let recordings;
  let id;
  const settle = () => {
    clearTimeout(idleTimer);
    if (drained && pending.size === 0) idleTimer = setTimeout(drained, 100);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(idleTimer);
    recordings?.delete(id);
    pending.clear();
    recordingRequests.delete(window);
    drained?.();
  };
  try {
    id = window.webContents.id;
    recordings = sessionRecordings(window.webContents.session);
    recordings.set(id, {
      started: (requestId) => {
        pending.add(requestId);
        settle();
      },
      completed: (requestId) => {
        if (pending.delete(requestId)) settle();
      },
    });
    recordingRequests.set(window, {
      drain: () =>
        new Promise((accept) => {
          if (disposed) return accept();
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
