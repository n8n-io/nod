import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { cleanStoppedComputer, drainComputerForDeployment } from '../src/computer-deployment.ts';
import type { ComputerState } from '../src/computer-lifecycle.ts';

function fixture(role: 'browser' | 'workspace' = 'browser') {
  const identity = { ownerId: randomUUID(), environment: 'development', generation: '2', role };
  const checkpoint = {
    format: 'otto-computer-tar-v1' as const,
    id: randomUUID(),
    ownerId: identity.ownerId,
    environment: identity.environment,
    role,
    bytes: 1024,
    sha256: 'a'.repeat(64),
    etag: 'synthetic',
  };
  let state: ComputerState = {
    ...identity,
    phase: role === 'browser' ? 'dirty' : 'ready',
    stopped: false,
    checkpoint,
  };
  let running = true;
  const events: string[] = [];
  let time = 1000;
  const options: Parameters<typeof drainComputerForDeployment>[0] = {
    identity,
    nonce: randomUUID(),
    deadline: 10_000,
    state,
    active: 0,
    observed: true,
    fenced: false,
    now: () => time,
    running: () => running,
    async authorize() {},
    admission(closed) {
      events.push(`admission:${closed}`);
    },
    async quiesce() {
      events.push('quiesce');
      return true;
    },
    async checkpoint(input) {
      events.push('checkpoint');
      state = { ...input, phase: 'ready', checkpoint: { ...checkpoint, id: randomUUID() } };
      return state;
    },
    async stop() {
      events.push('stop');
      running = false;
    },
    async write(input) {
      events.push('write');
      state = structuredClone(input);
    },
    async quarantine(input) {
      events.push('quarantine');
      state = { ...input, phase: 'uncertain' };
    },
  };
  return {
    options,
    events,
    state: () => state,
    running: () => running,
    setRunning(value: boolean) {
      running = value;
    },
    expire() {
      time = options.deadline;
    },
    run: () => drainComputerForDeployment(options),
  };
}

test('deployment drain checkpoints each role before confirmed stop and durable acknowledgement', async () => {
  for (const role of ['browser', 'workspace'] as const) {
    const f = fixture(role);
    assert.deepEqual(await f.run(), {
      status: 'drained',
      generation: '2',
      clean: true,
      stopped: true,
    });
    assert.deepEqual(f.events, [
      'admission:true',
      ...(role === 'browser' ? ['quiesce'] : []),
      'checkpoint',
      'stop',
      'write',
      'admission:false',
    ]);
    assert.equal(f.state().phase, 'ready');
    assert.equal(f.state().stopped, true);
    assert.equal(f.running(), false);
  }
});

test('active work and refused browser quiescence never checkpoint, cancel or stop', async () => {
  const active = fixture();
  active.options.active = 1;
  assert.equal((await active.run()).status, 'busy');
  assert.deepEqual(active.events, []);
  for (const condition of ['held', 'manual', 'native']) {
    const f = fixture();
    f.options.quiesce = async () => {
      f.events.push(condition);
      return false;
    };
    assert.equal((await f.run()).status, 'busy');
    assert.deepEqual(f.events, ['admission:true', condition, 'admission:false']);
    assert.equal(f.running(), true);
    assert.equal(f.state().phase, 'dirty');
  }
});

test('deployment drain refuses uncertain, unobserved, foreign and newer computer state without mutation', async () => {
  const changes: Array<Partial<ComputerState>> = [
    { phase: 'uncertain' },
    { phase: 'restoring' },
    { generation: '3' },
    { ownerId: randomUUID() },
    { environment: 'production' },
    { role: 'workspace' },
  ];
  for (const change of changes) {
    const f = fixture();
    f.options.state = { ...f.options.state!, ...change };
    assert.equal((await f.run()).status, 'unsafe');
    assert.deepEqual(f.events, []);
  }
  for (const condition of ['lost', 'unobserved', 'fenced']) {
    const f = fixture();
    if (condition === 'lost') f.setRunning(false);
    if (condition === 'unobserved') f.options.observed = false;
    if (condition === 'fenced') f.options.fenced = true;
    assert.equal((await f.run()).status, 'unsafe');
    assert.deepEqual(f.events, []);
  }
});

test('only clean stopped state permits idempotent drain or an unused newer generation', async () => {
  for (const generation of ['1', '2']) {
    const f = fixture();
    f.options.state = { ...f.options.state!, phase: 'ready', stopped: true, generation };
    f.setRunning(false);
    assert.equal((await f.run()).status, 'drained');
    assert.deepEqual(f.events, []);
    f.setRunning(true);
    assert.equal((await f.run()).status, 'unsafe');
    assert.deepEqual(f.events, []);
  }
});

test('checkpoint, quiescence, stop and persistence failures quarantine without a clean receipt', async () => {
  for (const stage of ['quiesce', 'checkpoint', 'stop', 'write'] as const) {
    const f = fixture();
    f.options[stage] = async () => {
      f.events.push(stage);
      throw new Error('synthetic failure');
    };
    assert.equal((await f.run()).status, 'unsafe');
    assert.equal(f.state().phase, 'uncertain');
    if (stage === 'quiesce' || stage === 'checkpoint') {
      assert.equal(f.events.includes('stop'), false);
      assert.equal(f.running(), true);
    }
  }
  const f = fixture();
  f.options.stop = async () => {
    f.events.push('stop');
  };
  assert.equal((await f.run()).status, 'unsafe');
  assert.equal(f.state().phase, 'uncertain');
  assert.equal(f.events.includes('write'), false);
});

test('deadline and authority checks fence late checkpoint completion without stopping the VM', async () => {
  for (const condition of ['deadline', 'authority']) {
    const f = fixture();
    const checkpoint = f.options.checkpoint;
    f.options.checkpoint = async (state) => {
      const result = await checkpoint(state);
      if (condition === 'deadline') f.expire();
      else
        f.options.authorize = async () => {
          throw new Error('synthetic revoked authority');
        };
      return result;
    };
    assert.equal((await f.run()).status, 'unsafe');
    assert.equal(f.events.includes('stop'), false);
    assert.equal(f.running(), true);
    assert.equal(f.state().phase, 'uncertain');
  }
});

test('read-only stopped inspection accepts only absent or clean exact-owner current-or-older generations', () => {
  const ownerId = randomUUID();
  const state = {
    ownerId,
    environment: 'development',
    role: 'browser' as const,
    generation: '2',
    phase: 'ready' as const,
    stopped: true,
  };
  const input = {
    ownerId,
    environment: 'development',
    role: 'browser' as const,
    generation: '2',
    state,
    active: 0,
    fenced: false,
    running: false,
  };
  assert.equal(cleanStoppedComputer(input), true);
  assert.equal(cleanStoppedComputer({ ...input, generation: '3' }), true);
  assert.equal(cleanStoppedComputer({ ...input, generation: null, state: undefined }), true);
  for (const changed of [
    { generation: null },
    { generation: '1' },
    { active: 1 },
    { fenced: true },
    { running: true },
    { state: { ...state, stopped: false } },
    { state: { ...state, phase: 'dirty' as const } },
    { state: { ...state, phase: 'restoring' as const } },
    { state: { ...state, phase: 'uncertain' as const } },
    { state: { ...state, ownerId: randomUUID() } },
    { state: { ...state, environment: 'production' } },
    { state: { ...state, role: 'workspace' as const } },
  ])
    assert.equal(cleanStoppedComputer({ ...input, ...changed }), false);
});
