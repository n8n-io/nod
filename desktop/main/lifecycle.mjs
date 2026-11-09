export function startupErrorDetails(error, seen = new Set()) {
  if (!error || seen.has(error)) return '';
  seen.add(error);
  return [
    error.code,
    error.stack || error.message,
    error.details,
    startupErrorDetails(error.cause, seen),
    ...(Array.isArray(error.errors)
      ? error.errors.map((cause) => startupErrorDetails(cause, seen))
      : []),
  ]
    .filter(Boolean)
    .join('\n');
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
  let storage;
  let warming;
  let starting;
  let installing;
  let closing;
  let closed = false;
  let failure;
  let cleanupRequired = false;
  let choose;
  const chosen = new Promise((resolve) => {
    choose = resolve;
  });
  const controllers = new Set();

  function checkOpen(signal) {
    if (closed || signal?.aborted) throw new Error('Nod is closing.');
  }

  function report(value) {
    if (closed) return;
    onRuntimeStatus({
      phase: 'preparing',
      stage: 'computer',
      progress: undefined,
      secondsLeft: undefined,
      needsRuntimeArchive: false,
      needsWsl: false,
      ...value,
    });
  }

  function runtimeFailure(error) {
    failure = error;
    report({
      phase: 'error',
      message: error.message,
      details: startupErrorDetails(error),
      needsRuntimeArchive: error.code === 'RUNTIME_ARCHIVE_REQUIRED',
      needsWsl: error.code === 'NOD_WSL_REQUIRED',
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
          onStorageReady: async (preparedStorage) => {
            await Promise.race([
              chosen,
              new Promise((_, reject) =>
                controller.signal.addEventListener(
                  'abort',
                  () => reject(new Error('Nod is closing.')),
                  { once: true },
                ),
              ),
            ]);
            checkOpen(controller.signal);
            await validateStart();
            checkOpen(controller.signal);
            await startEngine({
              runtime: preparedStorage,
              signal: controller.signal,
              pending: true,
            });
            storage = preparedStorage;
          },
          onStatus: (value) =>
            report({
              message: typeof value === 'string' ? value : value.message,
              stage: typeof value === 'object' ? (value.stage ?? 'computer') : 'computer',
              progress: typeof value === 'object' ? value.progress : undefined,
              secondsLeft: typeof value === 'object' ? value.secondsLeft : undefined,
            }),
        });
        runtime = prepared;
        checkOpen(controller.signal);
        report({ phase: 'ready', stage: 'ready', message: 'Your local computer is ready.' });
        return runtime;
      })
      .catch((error) => {
        if (error.code === 'NOD_RUNTIME_STOP_FAILED') cleanupRequired = true;
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
    choose();
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
        return startEngine({ runtime: prepared, signal: controller.signal });
      })
      .finally(() => {
        starting = undefined;
        controllers.delete(controller);
      });
    return starting;
  }

  function install(installer, { warmup: prepare = true } = {}) {
    checkOpen();
    if (warming || starting || installing || runtime)
      throw new Error('Wait for Nod to finish its current setup step.');
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
      .then(() => (prepare ? warmup({ retry: true }) : undefined));
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
        if (runtime || storage) await (runtime || storage).close?.();
        else if (cleanupRequired) await stopRuntime?.();
        runtime = undefined;
        storage = undefined;
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
    allowEngine: () => choose(),
    install,
    close,
    get busy() {
      return Boolean(warming || starting || installing);
    },
  };
}
