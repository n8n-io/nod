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
  openDatabase,
  prepareRuntime,
  stopRuntime,
  validateStart,
  startEngine,
  stopEngine,
  onRuntimeStatus,
  onRuntime,
}) {
  let database;
  let opened;
  let runtime;
  let warming;
  let serving;
  let installing;
  let closing;
  let closed = false;
  let failure;
  let cleanupRequired = false;
  let movedWaiters = [];
  let choose;
  const chosen = new Promise((resolve) => {
    choose = resolve;
  });
  const controllers = new Set();

  function checkOpen(signal) {
    if (closed || signal?.aborted) throw new Error('Nod is closing.');
  }

  function controlled() {
    const controller = new AbortController();
    controllers.add(controller);
    return controller;
  }

  function aborted(signal) {
    return new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('Nod is closing.')), { once: true }),
    );
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
      needsStorage: false,
      ...value,
    });
  }

  function runtimeFailure(error) {
    failure = error;
    report({
      phase: 'error',
      message: error.message,
      details: startupErrorDetails(error),
      failure: error,
      needsRuntimeArchive: error.code === 'RUNTIME_ARCHIVE_REQUIRED',
      needsWsl: error.code === 'NOD_WSL_REQUIRED',
      needsStorage: error.code === 'NOD_COMPUTER_STORAGE_FULL',
    });
    if (!closed) onRuntime?.({ error });
  }

  function storage(signal) {
    database ??= openDatabase({ signal }).then(
      (value) => (opened = value),
      (error) => {
        database = undefined;
        throw error;
      },
    );
    return database;
  }

  function moved() {
    for (const resolve of movedWaiters.splice(0)) resolve();
  }

  function warmup({ retry = false } = {}) {
    checkOpen();
    void serve().catch((error) => {
      if (!closed) runtimeFailure(error);
    });
    return computer({ retry });
  }

  function computer({ retry = false } = {}) {
    checkOpen();
    if (runtime) return Promise.resolve(runtime);
    if (warming) return warming;
    if (installing) return installing;
    if (failure && !retry) return Promise.reject(failure);
    failure = undefined;
    const controller = controlled();
    warming = Promise.resolve()
      .then(async () => {
        const value = await storage(controller.signal);
        checkOpen(controller.signal);
        report({ message: 'Setting up Nod on this computer…' });
        const prepared = await prepareRuntime({
          signal: controller.signal,
          database: value,
          onMoved: moved,
          onStatus: (status) =>
            report({
              message: typeof status === 'string' ? status : status.message,
              stage: typeof status === 'object' ? (status.stage ?? 'computer') : 'computer',
              progress: typeof status === 'object' ? status.progress : undefined,
              secondsLeft: typeof status === 'object' ? status.secondsLeft : undefined,
            }),
        });
        runtime = prepared;
        checkOpen(controller.signal);
        report({ phase: 'ready', stage: 'ready', message: 'Your private computer is ready.' });
        onRuntime?.({ environment: prepared.environment });
        return prepared;
      })
      .catch((error) => {
        if ([error.code, error.cause?.code].includes('NOD_RUNTIME_STOP_FAILED'))
          cleanupRequired = true;
        runtimeFailure(error);
        throw error;
      })
      .finally(() => {
        warming = undefined;
        controllers.delete(controller);
      });
    return warming;
  }

  function serve(options) {
    checkOpen();
    if (serving) return serving;
    const controller = controlled();
    serving = Promise.resolve()
      .then(async () => {
        const value = await storage(controller.signal);
        checkOpen(controller.signal);
        if (value.pendingMove) {
          const waiting = new Promise((resolve) => movedWaiters.push(resolve));
          await Promise.race([waiting, computer(options), aborted(controller.signal)]);
          if (value.pendingMove) throw failure ?? new Error('Nod could not move your saved data.');
        }
        await Promise.race([chosen, aborted(controller.signal)]);
        checkOpen(controller.signal);
        await validateStart();
        checkOpen(controller.signal);
        await startEngine({ database: value, signal: controller.signal });
      })
      .finally(() => {
        serving = undefined;
        controllers.delete(controller);
      });
    return serving;
  }

  function start(options) {
    checkOpen();
    choose();
    return validateStart()
      .then(() => serve(options))
      .then(() => {
        if (!runtime && !warming && !installing && (!failure || options?.retry))
          void computer(options).catch(() => {});
      });
  }

  function install(installer, { warmup: prepare = true } = {}) {
    checkOpen();
    if (warming || installing || runtime)
      throw new Error('Wait for Nod to finish its current setup step.');
    const controller = controlled();
    installing = Promise.resolve()
      .then(async () => {
        checkOpen(controller.signal);
        report({ message: 'Setting up Nod on this computer…' });
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
      .then(() => (prepare ? computer({ retry: true }) : undefined));
    return installing;
  }

  function close() {
    if (closing) return closing;
    closed = true;
    for (const controller of controllers) controller.abort();
    closing = (async () => {
      await Promise.allSettled([warming, serving, installing, database].filter(Boolean));
      try {
        await stopEngine();
      } finally {
        try {
          if (runtime) await runtime.close?.();
          else if (cleanupRequired) await stopRuntime?.();
          runtime = undefined;
          cleanupRequired = false;
        } finally {
          await opened?.close();
          opened = undefined;
          database = undefined;
        }
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
      return Boolean(warming || serving || installing);
    },
  };
}
