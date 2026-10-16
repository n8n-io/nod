import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { runComputerExec } from '../src/computer-exec.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function processFixture(exitCode: Promise<number> = Promise.resolve(0)) {
  const events: string[] = [];
  const process = {
    pid: 1,
    isPty: false,
    exitCode,
    stdin: new WritableStream({
      write() {
        events.push('write');
      },
      abort() {
        events.push('abort-input');
      },
    }),
    stdout: new ReadableStream({
      cancel() {
        events.push('cancel-output');
      },
    }),
    stderr: null,
    kill(signal: number) {
      events.push(`kill:${signal}`);
    },
    resize() {},
    async output() {
      throw new Error('Unused fixture');
    },
  } as ExecProcess;
  return { process, events };
}

test('timed-out native creation kills a late handle without handing it to an input writer', async () => {
  const launch = deferred<ExecProcess>();
  const current = processFixture();
  let launchSignal: AbortSignal | undefined;
  let consumed = false;
  const operation = runComputerExec({
    timeoutMs: 10,
    launch: (signal) => {
      launchSignal = signal;
      return launch.promise;
    },
    consume: async (process) => {
      consumed = true;
      await process.stdin!.getWriter().write(new Uint8Array([1]));
    },
  });
  await assert.rejects(operation, { status: 503 });
  assert.equal(launchSignal?.aborted, true);
  launch.resolve(current.process);
  await delay(0);
  assert.equal(consumed, false);
  assert.ok(current.events.includes('kill:9'));
});

test('launch, stream, and native exit failures expose only fixed errors and release process resources', async (t) => {
  for (const mode of ['launch', 'stream', 'exit', 'code'] as const) {
    await t.test(mode, async () => {
      const exit = deferred<number>();
      const current = processFixture(
        mode === 'exit' ? exit.promise : Promise.resolve(mode === 'code' ? 1 : 0),
      );
      const operation = runComputerExec({
        timeoutMs: 100,
        launch: () => {
          if (mode === 'launch') throw new Error('synthetic private launch output');
          return current.process;
        },
        consume: async () => {
          if (mode === 'stream') throw new Error('synthetic private stream output');
        },
      });
      if (mode === 'exit') exit.resolve(Number.NaN);
      await assert.rejects(operation, {
        status: 503,
        message: 'The runtime request could not be completed.',
      });
      if (mode !== 'launch') {
        assert.ok(current.events.includes('kill:9'));
        assert.ok(current.events.includes('abort-input'));
      }
    });
  }
});
