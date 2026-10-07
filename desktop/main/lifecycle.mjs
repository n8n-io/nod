export function desktopSetupMode({ completed, replaying, running }) {
  if (!completed || replaying) return 'onboarding';
  return running ? 'settings' : 'loading';
}

export function createDesktopLifecycle({
  prepareRuntime,
  stopRuntime,
  validateStart,
  startEngine,
  stopEngine,
  onRuntimeStatus,
}) {
  let runtime;
  let warming;
  let starting;
  let installing;
  let closing;
  let closed = false;
  let failure;
  let engineStarting = false;
  let cleanupRequired = false;
  const controllers = new Set();

  function checkOpen(signal) {
    if (closed || signal?.aborted) throw new Error('Otto is closing.');
  }

  function report(value) {
    if (closed) return;
    onRuntimeStatus({
      phase: 'preparing',
      progress: undefined,
      needsRuntimeArchive: false,
      ...value,
    });
  }

  function runtimeFailure(error) {
    failure = error;
    report({
      phase: 'error',
      message: error.message,
      needsRuntimeArchive: error.code === 'RUNTIME_ARCHIVE_REQUIRED',
    });
  }

  function warmup({ retry = false } = {}) {
    checkOpen();
    if (runtime) return Promise.resolve(runtime);
    if (warming) return warming;
    if (installing) return installing;
    if (failure && !retry) return Promise.reject(failure);
    failure = undefined;
    const controller = new AbortController();
    controllers.add(controller);
    warming = Promise.resolve()
      .then(async () => {
        checkOpen(controller.signal);
        report({ message: 'Preparing your local computer.' });
        const prepared = await prepareRuntime({
          signal: controller.signal,
          onStatus: (value) =>
            report({
              message: typeof value === 'string' ? value : value.message,
              progress: typeof value === 'object' ? value.progress : undefined,
            }),
        });
        runtime = prepared;
        checkOpen(controller.signal);
        report({ phase: 'ready', message: 'Your local computer is ready.' });
        return runtime;
      })
      .catch((error) => {
        if (error.code === 'OTTO_RUNTIME_STOP_FAILED') cleanupRequired = true;
        runtimeFailure(error);
        throw error;
      })
      .finally(() => {
        warming = undefined;
        controllers.delete(controller);
      });
    return warming;
  }

  function start(options) {
    checkOpen();
    if (starting) return starting;
    const controller = new AbortController();
    controllers.add(controller);
    starting = Promise.resolve()
      .then(async () => {
        checkOpen(controller.signal);
        await validateStart();
        const prepared = await warmup(options);
        checkOpen(controller.signal);
        await validateStart();
        checkOpen(controller.signal);
        engineStarting = true;
        return startEngine({ runtime: prepared, signal: controller.signal });
      })
      .finally(() => {
        engineStarting = false;
        starting = undefined;
        controllers.delete(controller);
      });
    return starting;
  }

  function install(installer) {
    checkOpen();
    if (warming || starting || installing || runtime)
      throw new Error('Wait for Otto to finish its current setup step.');
    const controller = new AbortController();
    controllers.add(controller);
    installing = Promise.resolve()
      .then(async () => {
        checkOpen(controller.signal);
        report({ message: 'Installing your local computer.' });
        await installer({ signal: controller.signal, onStatus: report });
        checkOpen(controller.signal);
        failure = undefined;
      })
      .catch((error) => {
        runtimeFailure(error);
        throw error;
      })
      .finally(() => {
        installing = undefined;
        controllers.delete(controller);
      })
      .then(() => warmup({ retry: true }));
    return installing;
  }

  function close() {
    if (closing) return closing;
    closed = true;
    for (const controller of controllers) controller.abort();
    closing = (async () => {
      await Promise.allSettled([warming, starting, installing].filter(Boolean));
      try {
        await stopEngine();
      } finally {
        if (runtime) await runtime.close?.();
        else if (cleanupRequired) await stopRuntime?.();
        runtime = undefined;
        cleanupRequired = false;
      }
    })().catch((error) => {
      closing = undefined;
      throw error;
    });
    return closing;
  }

  return {
    warmup,
    start,
    install,
    close,
    get busy() {
      return Boolean(warming || starting || installing);
    },
    get engineStarting() {
      return engineStarting;
    },
  };
}
