import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createDeploymentBarrier, type DeploymentState } from '../src/deployment-barrier.ts';
import type { DeploymentRequest } from '../../../src/ports/deployment.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  let state: unknown;
  let time = 1_000_000;
  const input: DeploymentRequest = {
    action: 'prepare',
    nonce: randomUUID(),
    targetRelease: 'b'.repeat(40),
    previousRelease: 'a'.repeat(40),
    deadline: time + 300_000,
  };
  const receipts = [{ ownerId: randomUUID(), generation: '2' }];
  const calls: string[] = [];
  const options = {
    read: async () => state,
    write: async (next: DeploymentState) => {
      state = structuredClone(next);
    },
    currentRelease: input.previousRelease,
    now: () => time,
    prepare: async () => {
      calls.push('prepare');
      return receipts;
    },
    resume: async () => {
      calls.push('abort');
    },
  };
  return {
    options,
    input,
    receipts,
    calls,
    state: () => state as DeploymentState,
    corrupt: () => {
      state = { phase: 'complete' };
    },
    advance: (ms: number) => {
      time += ms;
    },
    request: new Request('https://otto.example.test/api/deployment', { method: 'POST' }),
  };
}

test('barrier persists before drain, remains closed across activation and opens only on the target release', async () => {
  const f = fixture();
  const waiting = deferred<typeof f.receipts>();
  const old = createDeploymentBarrier({ ...f.options, prepare: async () => waiting.promise });
  const preparation = old.handle(f.input, f.request);
  await setImmediate();
  assert.equal(f.state().phase, 'draining');
  assert.equal(await old.closed(), true);
  assert.equal(await createDeploymentBarrier(f.options).closed(), true);
  waiting.resolve(f.receipts);
  assert.equal((await preparation).state?.phase, 'prepared');
  await old.handle({ ...f.input, action: 'activate' }, f.request);
  await assert.rejects(old.handle({ ...f.input, action: 'complete' }, f.request));
  await assert.rejects(old.handle({ ...f.input, action: 'abort' }, f.request));
  const replacement = createDeploymentBarrier({
    ...f.options,
    currentRelease: f.input.targetRelease,
  });
  assert.equal(await replacement.closed(), true);
  await replacement.handle({ ...f.input, action: 'complete' }, f.request);
  assert.equal(await replacement.closed(), false);
  await replacement.handle({ ...f.input, action: 'complete' }, f.request);
});

test('same-nonce preparation is idempotent and foreign target or nonce cannot take the barrier', async () => {
  const f = fixture();
  const waiting = deferred<typeof f.receipts>();
  let calls = 0;
  const barrier = createDeploymentBarrier({
    ...f.options,
    prepare: async () => {
      calls += 1;
      return waiting.promise;
    },
  });
  const one = barrier.handle(f.input, f.request);
  await setImmediate();
  const two = barrier.handle(f.input, f.request);
  await setImmediate();
  await assert.rejects(barrier.handle({ ...f.input, nonce: randomUUID() }, f.request));
  await assert.rejects(barrier.handle({ ...f.input, targetRelease: 'c'.repeat(40) }, f.request));
  assert.equal(calls, 1);
  waiting.resolve(f.receipts);
  await Promise.all([one, two]);
  await barrier.handle(f.input, f.request);
  assert.equal(calls, 1);
});

test('failed drain and unknown stored state remain closed without implicit recovery', async () => {
  const f = fixture();
  const barrier = createDeploymentBarrier({
    ...f.options,
    prepare: async () => {
      throw new Error('private detail');
    },
  });
  await assert.rejects(
    barrier.handle(f.input, f.request),
    (error: Error) => !error.message.includes('private detail'),
  );
  assert.equal(f.state().phase, 'failed');
  assert.equal(await barrier.closed(), true);
  await assert.rejects(barrier.handle({ ...f.input, action: 'activate' }, f.request));
  f.corrupt();
  await assert.rejects(barrier.closed());
});

test('deadline fences late preparation and never expires maintenance into open admission', async () => {
  const f = fixture();
  const waiting = deferred<typeof f.receipts>();
  const barrier = createDeploymentBarrier({ ...f.options, prepare: async () => waiting.promise });
  const preparation = barrier.handle(f.input, f.request);
  await setImmediate();
  f.advance(300_001);
  waiting.resolve(f.receipts);
  await assert.rejects(preparation);
  assert.equal(f.state().phase, 'failed');
  assert.equal(await createDeploymentBarrier(f.options).closed(), true);
  await assert.rejects(barrier.handle({ ...f.input, action: 'activate' }, f.request));
});

test('abort waits for actual work completion and failed resume does not open admission', async () => {
  const f = fixture();
  const waiting = deferred<typeof f.receipts>();
  const barrier = createDeploymentBarrier({ ...f.options, prepare: async () => waiting.promise });
  const preparation = barrier.handle(f.input, f.request);
  await setImmediate();
  await assert.rejects(barrier.handle({ ...f.input, action: 'abort' }, f.request), { status: 409 });
  waiting.resolve(f.receipts);
  await preparation;
  const broken = createDeploymentBarrier({
    ...f.options,
    resume: async () => {
      throw new Error();
    },
  });
  await assert.rejects(broken.handle({ ...f.input, action: 'abort' }, f.request));
  assert.equal(await broken.closed(), true);
  await barrier.handle({ ...f.input, action: 'abort' }, f.request);
  assert.equal(await barrier.closed(), false);
  assert.equal(f.state().phase, 'aborted');
});
