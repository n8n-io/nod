import { connectSessionBus } from './session-bus.mjs';

const name = 'org.freedesktop.portal.Flatpak';
const monitorInterface = `${name}.UpdateMonitor`;
const signalType = 4;
const status = { running: 0, empty: 1, done: 2 };

function refused(error) {
  if (/new permissions/i.test(error.message))
    return new Error(
      'This update needs permissions your desktop has not granted yet. Install it with: flatpak install --user --reinstall io.n8n.Nod//stable',
      { cause: error },
    );
  return /not\s*allowed/i.test(error.message)
    ? new Error(
        'Your desktop does not let Nod update itself. Allow it in your privacy settings, or run flatpak permission-reset io.n8n.Nod and try again.',
        { cause: error },
      )
    : error;
}

export async function connectFlatpakPortal() {
  let path;
  let handlers = {};
  let bufferedAvailable;
  let pendingReject;
  const bus = await connectSessionBus({
    onSignal: (message) => {
      if (message.type !== signalType) return;
      if (path === undefined) {
        if (message.member === 'UpdateAvailable') bufferedAvailable = message.values[0] ?? {};
        return;
      }
      if (message.path !== path) return;
      const handler = handlers[message.member];
      if (handler) handler(message.values[0] ?? {});
      else if (message.member === 'UpdateAvailable') bufferedAvailable = message.values[0] ?? {};
    },
  });
  const call = (target, interfaceName, member, signature, values) =>
    bus.call({
      destination: name,
      path: target,
      interface: interfaceName,
      member,
      signature,
      values,
    });
  try {
    [path] = await call('/org/freedesktop/portal/Flatpak', name, 'CreateUpdateMonitor', 'a{sv}', [
      {},
    ]);
  } catch (error) {
    bus.close();
    throw error;
  }
  return {
    onAvailable(handler) {
      handlers.UpdateAvailable = handler;
      if (bufferedAvailable) {
        const value = bufferedAvailable;
        bufferedAvailable = undefined;
        handler(value);
      }
    },
    update(onProgress) {
      return new Promise((resolve, reject) => {
        pendingReject = reject;
        handlers.Progress = (info) => {
          if (info.status === status.running) return onProgress(info.progress / 100);
          handlers.Progress = undefined;
          pendingReject = undefined;
          if (info.status === status.done) resolve();
          else if (info.status === status.empty)
            reject(
              Object.assign(new Error('The Flatpak portal found nothing to install.'), {
                code: 'FLATPAK_UPDATE_EMPTY',
              }),
            );
          else reject(refused(new Error(info.error_message || 'The Flatpak update failed.')));
        };
        call(path, monitorInterface, 'Update', 'sa{sv}', ['', {}]).catch((error) => {
          handlers.Progress = undefined;
          pendingReject = undefined;
          reject(refused(error));
        });
      });
    },
    close() {
      handlers = {};
      pendingReject?.(new Error('Nod is closing.'));
      pendingReject = undefined;
      call(path, monitorInterface, 'Close', '', [])
        .catch(() => {})
        .finally(() => bus.close());
    },
  };
}

export function createFlatpakUpdater({
  connect,
  source,
  currentVersion,
  restart,
  onStatus = () => {},
  installTimeout = 30 * 60 * 1000,
}) {
  const controller = new AbortController();
  let portal;
  let available;
  let localCommit;
  let ready;
  let checking;
  let restarting;
  let disposed = false;
  let started;
  let connected = false;
  let generation = 0;
  const beginConnect = () => {
    connected = false;
    const current = ++generation;
    started = connect().then((value) => {
      if (current !== generation) return value.close();
      portal = value;
      connected = true;
      if (disposed) return value.close();
      value.onAvailable((info) => {
        available = info['remote-commit'];
        localCommit = info['local-commit'];
      });
    });
    started.catch(() => {});
  };
  beginConnect();
  return {
    get ready() {
      return ready;
    },
    check() {
      if (disposed) return Promise.reject(new Error('Nod is closing.'));
      if (restarting) return Promise.reject(new Error('Nod is restarting.'));
      if (checking) return checking;
      checking = (async () => {
        onStatus('checking');
        if (connected) await started;
        else {
          let connectTimer;
          let onAbort;
          try {
            await Promise.race([
              started,
              new Promise((_, reject) => {
                connectTimer = setTimeout(
                  () => reject(new Error('Nod could not reach the Flatpak portal. Try again.')),
                  installTimeout,
                );
                connectTimer.unref?.();
              }),
              new Promise((_, reject) => {
                if (controller.signal.aborted) return reject(new Error('Nod is closing.'));
                onAbort = () => reject(new Error('Nod is closing.'));
                controller.signal.addEventListener('abort', onAbort, { once: true });
              }),
            ]);
          } catch (connectError) {
            if (!connected && !disposed) beginConnect();
            throw connectError;
          } finally {
            clearTimeout(connectTimer);
            if (onAbort) controller.signal.removeEventListener('abort', onAbort);
          }
        }
        if (!available || available === ready?.commit) return ready;
        const candidate = await source.latest(currentVersion, controller.signal);
        if (candidate?.commit !== available) return ready;
        onStatus('downloading');
        let timer;
        try {
          await Promise.race([
            portal.update((progress) => onStatus('downloading', progress)),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                reject(
                  new Error(
                    'The update did not finish. If your desktop asked to allow Nod to update itself, answer it and try again.',
                  ),
                );
              }, installTimeout);
              timer.unref?.();
            }),
          ]);
        } catch (installError) {
          if (installError.code === 'FLATPAK_UPDATE_EMPTY' && localCommit === candidate.commit) {
            controller.signal.throwIfAborted();
            ready = { ...candidate };
            return ready;
          }
          const stale = portal;
          if (!disposed) beginConnect();
          stale.close();
          throw installError;
        } finally {
          clearTimeout(timer);
        }
        controller.signal.throwIfAborted();
        ready = { ...candidate };
        return ready;
      })().finally(() => {
        checking = undefined;
        onStatus(ready ? 'ready' : 'idle');
      });
      return checking;
    },
    restart() {
      if (checking) return Promise.reject(new Error('A desktop update check is still running.'));
      if (!ready || disposed) return Promise.reject(new Error('No desktop update is ready.'));
      if (restarting) return restarting;
      restarting = restart(ready).finally(() => {
        restarting = undefined;
      });
      return restarting;
    },
    dispose() {
      disposed = true;
      controller.abort();
      portal?.close();
      return checking?.catch(() => {});
    },
  };
}
