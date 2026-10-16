import assert from 'node:assert/strict';
import test from 'node:test';
import { assertContainerStartupSettled, startContainer } from '../src/container-startup.ts';
import { stopContainer } from '../src/container-stop.ts';
import { RuntimeControlError } from '../src/protocol.ts';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}

test('stop waits after SIGTERM acknowledgement and synchronizes terminal SDK state', async () => {
  let running = true;
  let state = 'healthy';
  const signalled = deferred();
  const container = {
    async stop() {
      if (running) signalled.resolve();
      else state = 'stopped';
    },
    async getState() {
      return { status: state };
    },
  };
  let confirmed = false;
  const stopping = stopContainer(container, { running: () => running, timeoutMs: 1_000 }).then(
    () => {
      confirmed = true;
    },
  );
  await signalled.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(confirmed, false);
  running = false;
  await stopping;
  assert.equal(confirmed, true);
});

test('neither a terminal SDK state nor a native stop alone grants a receipt', async () => {
  for (const [running, status] of [
    [true, 'stopped'],
    [false, 'healthy'],
  ] as const) {
    await assert.rejects(
      stopContainer(
        { stop: async () => {}, getState: async () => ({ status }) },
        { running: () => running, timeoutMs: 10 },
      ),
      RuntimeControlError,
    );
  }
  for (const status of ['stopped', 'stopped_with_code'])
    await stopContainer(
      { stop: async () => {}, getState: async () => ({ status }) },
      { running: () => false },
    );
});

test('the deadline bounds the stop request and a late acknowledgement cannot continue polling', async () => {
  const raw = deferred();
  let polls = 0;
  await assert.rejects(
    stopContainer(
      {
        stop: () => raw.promise,
        async getState() {
          polls++;
          return { status: 'stopped' };
        },
      },
      { running: () => false, timeoutMs: 10 },
    ),
    RuntimeControlError,
  );
  raw.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(polls, 0);
});

test('unsettled startup prevents both sending the signal and returning a clean receipt', async () => {
  const raw = deferred();
  let stops = 0;
  const container = {
    startAndWaitForPorts: () => raw.promise,
    async stop() {
      stops++;
    },
    getState: async () => ({ status: 'stopped' }),
  };
  await assert.rejects(startContainer(container, { timeoutMs: 10 }), RuntimeControlError);
  await assert.rejects(stopContainer(container, { running: () => false }), RuntimeControlError);
  assert.equal(stops, 0);
  assert.throws(() => assertContainerStartupSettled(container), RuntimeControlError);
  raw.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await stopContainer(container, { running: () => false });
  assert.equal(stops, 1);
  const late = deferred();
  let starting: Promise<void> | undefined;
  const restarting = {
    startAndWaitForPorts: () => late.promise,
    async stop() {
      starting = startContainer(restarting, { timeoutMs: 1_000 });
    },
    getState: async () => ({ status: 'stopped' }),
  };
  await assert.rejects(stopContainer(restarting, { running: () => false }), RuntimeControlError);
  late.resolve();
  await starting;
});
