import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  createComputerLifecycle,
  type ComputerIdentity,
  type ComputerState,
} from '../src/computer-lifecycle.ts';
import { CheckpointTooLarge, type ComputerCheckpoint } from '../src/computer-checkpoints.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  role: 'browser' | 'workspace' = 'workspace',
  claims = new Set<string>(),
  ownerId = randomUUID(),
) {
  let stored: ComputerState | undefined;
  let running = false;
  let permitted = true;
  const events: string[] = [];
  const writes: ComputerState[] = [];
  const restored: ComputerState[] = [];
  const removed: ComputerCheckpoint[] = [];
  let beforeWrite = async (_state: ComputerState) => {};
  let beforeClaim = async (_identity: ComputerIdentity, _id: string) => {};
  let beforeCheckpoint = async (_state: ComputerState) => {};
  let beforeLaunch = async (_state: ComputerState) => {};
  let beforeDestroy = async () => {};
  let beforeStart = async () => {};
  let beforeRestore = async () => {};
  let canQuiesce = true;
  let checkpointIndex = 0;
  const options: Parameters<typeof createComputerLifecycle>[0] = {
    role,
    environment: 'development',
    settleMs: 5,
    async read() {
      return stored && structuredClone(stored);
    },
    async write(state) {
      await beforeWrite(state);
      events.push(`write:${state.phase}:${state.stopped}`);
      stored = structuredClone(state);
      writes.push(structuredClone(state));
    },
    async claimCommand(identity, id) {
      await beforeClaim(identity, id);
      const key = JSON.stringify([
        identity.ownerId,
        identity.environment,
        identity.role,
        identity.generation,
        id,
      ]);
      if (claims.has(key)) return false;
      claims.add(key);
      events.push(`claim:${id}`);
      return true;
    },
    async authorize(_identity, _stopping) {
      if (!permitted) throw new Error('Synthetic private authorization failure');
    },
    running: () => running,
    async start() {
      events.push('start');
      await beforeStart();
      running = true;
    },
    async destroy() {
      events.push('destroy');
      await beforeDestroy();
      running = false;
    },
    async restore(state, assertCurrent) {
      events.push('restore');
      await beforeRestore();
      await assertCurrent();
      restored.push(structuredClone(state));
    },
    async checkpoint(state, assertCurrent) {
      events.push('checkpoint');
      await beforeCheckpoint(state);
      await assertCurrent();
      return {
        format: 'otto-computer-tar-v1',
        id: randomUUID(),
        ownerId,
        environment: 'development',
        role,
        bytes: 1024,
        sha256: (++checkpointIndex).toString(16).padStart(64, '0'),
        etag: `snapshot-${checkpointIndex}`,
      };
    },
    async removeCheckpoint(checkpoint, assertCurrent) {
      await assertCurrent();
      removed.push(checkpoint);
    },
    async quiesce(_state, stopping) {
      events.push(`quiesce:${stopping}`);
      return canQuiesce;
    },
    async launch(state) {
      await beforeLaunch(state);
      assert.equal(stored?.phase, 'dirty');
      events.push('launch');
      return {
        pid: 1,
        isPty: false,
        stdin: null,
        stdout: null,
        stderr: null,
        exitCode: Promise.resolve(0),
        kill() {},
        resize() {},
        async output() {
          throw new Error('Unused synthetic operation');
        },
      };
    },
  };
  let lifecycle = createComputerLifecycle(options);
  return {
    ownerId,
    options,
    events,
    writes,
    restored,
    removed,
    claims,
    get lifecycle() {
      return lifecycle;
    },
    state: () => stored && structuredClone(stored),
    seed(state: ComputerState) {
      stored = structuredClone(state);
    },
    claimed(id: string, generation = '1') {
      return claims.has(JSON.stringify([ownerId, 'development', role, generation, id]));
    },
    running: () => running,
    launch: (id: string = randomUUID(), generation = '1') =>
      lifecycle.launch(ownerId, {
        id,
        generation,
        threadId: role === 'workspace' ? 'thread' : undefined,
      }),
    completed: (id: string, generation = '1', code = 0) =>
      lifecycle.completed(ownerId, { id, generation, code }),
    settled: () => delay(30),
    restart() {
      lifecycle = createComputerLifecycle(options);
    },
    loseVm() {
      running = false;
    },
    revoke() {
      permitted = false;
    },
    beforeWrite(value: typeof beforeWrite) {
      beforeWrite = value;
    },
    beforeClaim(value: typeof beforeClaim) {
      beforeClaim = value;
    },
    beforeCheckpoint(value: typeof beforeCheckpoint) {
      beforeCheckpoint = value;
    },
    beforeLaunch(value: typeof beforeLaunch) {
      beforeLaunch = value;
    },
    beforeDestroy(value: typeof beforeDestroy) {
      beforeDestroy = value;
    },
    beforeStart(value: typeof beforeStart) {
      beforeStart = value;
    },
    beforeRestore(value: typeof beforeRestore) {
      beforeRestore = value;
    },
    canQuiesce(value: boolean) {
      canQuiesce = value;
    },
  };
}

test('durable dirty intent and command identity precede native launch', async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  const id = randomUUID();
  f.beforeWrite(async (state) => {
    if (state.phase === 'dirty') {
      entered.resolve();
      await release.promise;
    }
  });
  const launching = f.launch(id);
  await entered.promise;
  assert.equal(f.events.includes('launch'), false);
  release.resolve();
  await launching;
  assert.equal(f.state()?.phase, 'dirty');
  assert.equal(f.state()?.commands, undefined);
  assert.equal(f.claimed(id), true);
  assert.deepEqual(f.events.slice(0, 7), [
    'destroy',
    'write:restoring:false',
    'start',
    'restore',
    'write:ready:false',
    `claim:${id}`,
    'write:dirty:false',
  ]);
  assert.equal(f.events.at(-1), 'launch');
  assert.equal(f.lifecycle.active, 1);
});

test('a workspace checkpoints once its commands settle and rotates only older manifests', async () => {
  const f = fixture();
  const first = randomUUID();
  await f.launch(first);
  await f.completed(first);
  assert.equal(f.state()?.phase, 'unsaved');
  assert.equal(f.lifecycle.active, 0);
  const second = randomUUID();
  await f.launch(second);
  await f.settled();
  assert.equal(f.events.includes('checkpoint'), false);
  assert.equal(f.state()?.phase, 'dirty');
  await f.completed(second);
  await f.settled();
  assert.deepEqual(
    f.events.filter((event) => event === 'checkpoint'),
    ['checkpoint'],
  );
  const checkpoint = f.state()!.checkpoint!;
  assert.equal(f.state()?.phase, 'ready');
  for (const removed of [[], [checkpoint]]) {
    const next = randomUUID();
    await f.launch(next);
    await f.completed(next);
    await f.settled();
    assert.deepEqual(f.removed, removed);
  }
  assert.equal(f.running(), true);
});

test('lost isolate or VM cannot replay an uncheckpointed action', async () => {
  for (const loss of ['isolate', 'vm']) {
    const f = fixture();
    const id = randomUUID();
    await f.launch(id);
    if (loss === 'isolate') f.restart();
    else f.loseVm();
    await assert.rejects(f.launch(id));
    assert.equal(f.events.filter((event) => event === 'launch').length, 1);
    assert.equal(f.state()?.phase, 'uncertain');
    assert.equal(f.running(), false);
    await assert.rejects(f.launch());
  }
});

test('clean restoration keeps durable command tombstones after a fresh controller', async () => {
  const f = fixture();
  const id = randomUUID();
  await f.launch(id);
  await f.completed(id);
  await f.settled();
  const checkpoint = f.state()?.checkpoint;
  assert.ok(checkpoint);
  f.restart();
  await assert.rejects(f.launch(id), { status: 409 });
  assert.equal(f.events.filter((event) => event === 'launch').length, 1);
  assert.deepEqual(f.restored.at(-1)?.checkpoint, checkpoint);
  const next = randomUUID();
  await f.launch(next);
  assert.equal(f.state()?.commands, undefined);
  assert.equal(f.claimed(id), true);
  assert.equal(f.claimed(next), true);
});

test('owner, environment, role and active generation cannot be replaced', async () => {
  const f = fixture();
  const id = randomUUID();
  await f.launch(id);
  await f.completed(id);
  await f.settled();
  const state = f.state();
  const destroys = f.events.filter((event) => event === 'destroy').length;
  await assert.rejects(
    f.lifecycle.launch(randomUUID(), { id: randomUUID(), generation: '1', threadId: 'thread' }),
  );
  await assert.rejects(f.launch(randomUUID(), '2'));
  await assert.rejects(
    createComputerLifecycle({ ...f.options, role: 'browser' }).launch(f.ownerId, {
      id: randomUUID(),
      generation: '1',
    }),
  );
  await assert.rejects(
    createComputerLifecycle({ ...f.options, environment: 'production' }).launch(f.ownerId, {
      id: randomUUID(),
      generation: '1',
      threadId: 'thread',
    }),
  );
  assert.deepEqual(f.state(), state);
  assert.equal(f.events.filter((event) => event === 'destroy').length, destroys);
});

test('confirmed clean stop permits a newer generation while stale stop and fence cannot affect it', async () => {
  const f = fixture();
  const first = randomUUID();
  await f.launch(first);
  await f.completed(first);
  await f.lifecycle.stop(f.ownerId, '1');
  assert.equal(f.state()?.stopped, true);
  assert.equal(f.running(), false);
  const second = randomUUID();
  await f.launch(second, '2');
  await f.completed(second, '2');
  await f.settled();
  const current = f.state();
  const destroys = f.events.filter((event) => event === 'destroy').length;
  await assert.rejects(f.lifecycle.stop(f.ownerId, '1'));
  await assert.rejects(f.lifecycle.uncertain(f.ownerId, '1'));
  await f.lifecycle.authorize(f.ownerId, '2');
  assert.deepEqual(f.state(), current);
  assert.equal(f.running(), true);
  assert.equal(f.events.filter((event) => event === 'destroy').length, destroys);
  assert.equal(f.state()?.commands, undefined);
  assert.equal(f.claimed(first, '1'), true);
  assert.equal(f.claimed(second, '2'), true);
});

test('an unused role records confirmed destruction before allowing a newer generation', async (t) => {
  for (const role of ['browser', 'workspace'] as const) {
    for (const restart of [false, true]) {
      await t.test(`${role}, ${restart ? 'fresh' : 'same'} controller`, async () => {
        const f = fixture(role);
        const entered = deferred();
        const release = deferred();
        f.beforeDestroy(async () => {
          entered.resolve();
          await release.promise;
        });
        let acknowledged = false;
        const stopping = f.lifecycle.stop(f.ownerId, '1').then(() => {
          acknowledged = true;
        });
        await entered.promise;
        assert.equal(acknowledged, false);
        assert.equal(f.state(), undefined);
        assert.deepEqual(f.events, ['destroy']);
        release.resolve();
        await stopping;
        assert.deepEqual(f.state(), {
          ownerId: f.ownerId,
          environment: 'development',
          generation: '1',
          role,
          phase: 'ready',
          stopped: true,
        });
        assert.deepEqual(f.events, ['destroy', 'write:ready:true']);
        if (restart) f.restart();
        await assert.rejects(f.launch(randomUUID(), '1'));
        const id = randomUUID();
        await f.launch(id, '2');
        await f.completed(id, '2');
        const current = f.state();
        const events = [...f.events];
        await assert.rejects(f.lifecycle.stop(f.ownerId, '1'), { status: 409 });
        assert.deepEqual(f.state(), current);
        assert.deepEqual(f.events, events);
        assert.equal(f.running(), true);
        assert.equal(f.state()?.generation, '2');
      });
    }
  }
});

test('failed or unconfirmed destruction of an unused role cannot publish a stopped identity', async (t) => {
  for (const outcome of ['rejected', 'still-running'] as const) {
    await t.test(outcome, async () => {
      const f = fixture();
      const lifecycle = createComputerLifecycle({
        ...f.options,
        destroy: async () => {
          if (outcome === 'rejected') throw new Error('Synthetic private destruction failure');
        },
        running: () => outcome === 'still-running',
      });
      await assert.rejects(lifecycle.stop(f.ownerId, '1'));
      assert.equal(f.state(), undefined);
      assert.equal(f.writes.length, 0);
      await assert.rejects(
        lifecycle.launch(f.ownerId, { id: randomUUID(), generation: '2', threadId: 'thread' }),
      );
      assert.equal(f.events.includes('launch'), false);
      assert.equal(f.state(), undefined);
    });
  }
});

test('unused-role stop requires authority before destruction and before publishing its identity', async (t) => {
  for (const revokeDuringDestruction of [false, true]) {
    await t.test(
      revokeDuringDestruction ? 'revoked during destruction' : 'unauthorized',
      async () => {
        const f = fixture();
        if (revokeDuringDestruction) f.beforeDestroy(async () => f.revoke());
        else f.revoke();
        await assert.rejects(f.lifecycle.stop(f.ownerId, '1'));
        assert.equal(f.state(), undefined);
        assert.equal(f.writes.length, 0);
        assert.deepEqual(f.events, revokeDuringDestruction ? ['destroy'] : []);
      },
    );
  }
});

test('deployment drain leaves held browsers running and checkpoints only after non-forced quiescence', async () => {
  const f = fixture('browser');
  const id = randomUUID();
  await f.launch(id);
  await f.completed(id);
  f.canQuiesce(false);
  const input = {
    nonce: randomUUID(),
    targetRelease: 'a'.repeat(40),
    deadline: Date.now() + 60_000,
  };
  const controls = { authorize: async () => {}, active: () => 0 };
  const before = f.events.length;
  assert.equal((await f.lifecycle.drain(f.ownerId, '1', input, controls)).status, 'busy');
  assert.deepEqual(f.events.slice(before), ['quiesce:false']);
  assert.equal(f.running(), true);
  assert.equal(f.state()?.phase, 'dirty');
  f.canQuiesce(true);
  assert.equal((await f.lifecycle.drain(f.ownerId, '1', input, controls)).status, 'drained');
  assert.equal(f.running(), false);
  assert.equal(f.state()?.phase, 'ready');
  assert.equal(f.state()?.stopped, true);
  assert.equal(f.events.includes('quiesce:true'), false);
  await assert.rejects(f.launch());
});

test('deployment authority never reopens ordinary grants and cannot drain active command registries', async () => {
  const f = fixture();
  const id = randomUUID();
  await f.launch(id);
  await f.completed(id);
  const input = {
    nonce: randomUUID(),
    targetRelease: 'a'.repeat(40),
    deadline: Date.now() + 60_000,
  };
  const controls = { authorize: async () => {}, active: () => 1 };
  const before = f.events.length;
  assert.equal((await f.lifecycle.drain(f.ownerId, '1', input, controls)).status, 'busy');
  assert.equal(f.events.length, before);
  f.revoke();
  await assert.rejects(f.lifecycle.authorize(f.ownerId, '1'));
  controls.active = () => 0;
  assert.equal((await f.lifecycle.drain(f.ownerId, '1', input, controls)).status, 'drained');
  await assert.rejects(f.lifecycle.authorize(f.ownerId, '1'));
});

test('a newer tenant stop cannot accept live, dirty, uncertain, newer or foreign prior computer state', async () => {
  const changes: Array<Partial<ComputerState>> = [
    { stopped: false },
    { phase: 'dirty' },
    { phase: 'restoring' },
    { phase: 'uncertain' },
    { generation: '3' },
    { ownerId: randomUUID() },
    { environment: 'production' },
    { role: 'browser' },
  ];
  for (const change of changes) {
    const f = fixture();
    f.seed({
      ownerId: f.ownerId,
      environment: 'development',
      generation: '1',
      role: 'workspace',
      phase: 'ready',
      stopped: true,
      ...change,
    });
    const saved = f.state();
    await assert.rejects(f.lifecycle.stop(f.ownerId, '2'));
    assert.deepEqual(f.state(), saved);
    assert.deepEqual(f.events, []);
  }
  const active = fixture();
  await active.launch();
  active.seed({ ...active.state()!, phase: 'ready', stopped: true });
  const saved = active.state();
  const events = [...active.events];
  await assert.rejects(active.lifecycle.stop(active.ownerId, '2'));
  assert.equal(active.running(), true);
  assert.deepEqual(active.state(), saved);
  assert.deepEqual(active.events, events);
  active.loseVm();
  await assert.rejects(active.lifecycle.stop(active.ownerId, '2'));
  assert.deepEqual(active.state(), saved);
});

test('stale or foreign uncertainty cannot fence a healthy active generation', async () => {
  const f = fixture();
  const id = randomUUID();
  await f.launch(id);
  const state = f.state();
  await assert.rejects(f.lifecycle.uncertain(randomUUID(), '1'));
  await assert.rejects(f.lifecycle.uncertain(f.ownerId, '2'));
  await f.lifecycle.authorize(f.ownerId, '1');
  await f.completed(id);
  await f.settled();
  assert.equal(f.state()?.phase, 'ready');
  assert.deepEqual(f.state()?.commands, state?.commands);
});

test('failed checkpoint preserves its predecessor and quarantines the whole role', async () => {
  const f = fixture();
  const first = randomUUID();
  await f.launch(first);
  await f.completed(first);
  await f.settled();
  const checkpoint = f.state()?.checkpoint;
  const second = randomUUID();
  await f.launch(second);
  f.beforeCheckpoint(async () => {
    throw new Error('Synthetic private checkpoint failure');
  });
  await f.completed(second);
  await f.settled();
  assert.equal(f.state()?.phase, 'uncertain');
  assert.deepEqual(f.state()?.checkpoint, checkpoint);
  assert.deepEqual(f.removed, []);
  assert.equal(f.running(), false);
  await assert.rejects(f.launch());
});

async function session(f: ReturnType<typeof fixture>, generation = '1') {
  const id = randomUUID();
  const process = await f.lifecycle.launch(f.ownerId, {
    id,
    generation,
    threadId: 'thread',
    session: true,
  });
  const output = process.stdout ? await new Response(process.stdout).text() : '';
  await f.completed(id, generation);
  if (!output) return { id };
  const frame = JSON.parse(output);
  assert.equal(frame.type, 'stdout');
  return { id, message: Buffer.from(frame.data, 'base64').toString('utf8').trim() };
}

test('a workspace too large to save keeps running and tells the next bash command once without refusing it', async () => {
  const f = fixture();
  const first = randomUUID();
  await f.launch(first);
  await f.completed(first);
  await f.settled();
  const checkpoint = f.state()?.checkpoint;
  f.beforeCheckpoint(async () => {
    throw new CheckpointTooLarge('Synthetic report: 2 GiB to save.');
  });
  const second = randomUUID();
  await f.launch(second);
  await f.completed(second);
  await f.settled();
  assert.equal(f.state()?.phase, 'unsaved');
  assert.deepEqual(f.state()?.checkpoint, checkpoint);
  assert.deepEqual(f.state()?.oversize, {
    message: 'Synthetic report: 2 GiB to save.',
    shown: false,
  });
  assert.equal(f.running(), true);
  const launches = f.events.filter((event) => event === 'launch').length;
  const helper = randomUUID();
  await f.launch(helper);
  await f.completed(helper);
  assert.equal(f.state()?.oversize?.shown, false);
  assert.equal((await session(f)).message, 'Synthetic report: 2 GiB to save.');
  assert.equal(f.state()?.oversize?.shown, true);
  assert.equal((await session(f)).message, undefined);
  assert.equal(f.events.filter((event) => event === 'launch').length, launches + 3);
  await f.settled();
  assert.equal(await f.lifecycle.idle(), true);
  assert.equal(f.running(), false);
  assert.equal(f.state()?.phase, 'ready');
  assert.deepEqual(f.state()?.checkpoint, checkpoint);
  assert.equal(f.state()?.oversize, undefined);
  assert.match(f.state()!.notice!, /too large/);
  f.beforeCheckpoint(async () => {});
  assert.match((await session(f)).message!, /too large/);
  assert.deepEqual(f.restored.at(-1)?.checkpoint, checkpoint);
  assert.equal(f.state()?.notice, undefined);
  assert.notEqual(f.state()?.phase, 'uncertain');
});

test('unsaved workspace changes lost with their computer, stop or deployment are reported without a fence', async (t) => {
  for (const event of ['vm', 'stop', 'drain', 'vm-drain'] as const) {
    await t.test(event, async () => {
      const f = fixture();
      const first = randomUUID();
      await f.launch(first);
      await f.completed(first);
      await f.settled();
      const checkpoint = f.state()?.checkpoint;
      const second = randomUUID();
      await f.launch(second);
      if (event === 'vm') {
        f.beforeCheckpoint(async () => {
          throw new Error('Synthetic checkpoint that never runs');
        });
        await f.completed(second);
        f.loseVm();
        await f.settled();
      } else {
        f.beforeCheckpoint(async () => {
          throw event === 'vm-drain'
            ? new Error('Synthetic checkpoint that never runs')
            : new CheckpointTooLarge('Synthetic report: too large.');
        });
        await f.completed(second);
        if (event === 'vm-drain') f.loseVm();
        if (event === 'stop') await f.lifecycle.stop(f.ownerId, '1');
        else {
          const drained = await f.lifecycle.drain(
            f.ownerId,
            '1',
            { nonce: randomUUID(), targetRelease: 'a'.repeat(40), deadline: Date.now() + 60_000 },
            { authorize: async () => {}, active: () => 0 },
          );
          assert.equal(drained.status, 'drained');
        }
        assert.equal(f.state()?.stopped, true);
        assert.equal(f.state()?.phase, 'ready');
        assert.equal(f.running(), false);
        f.restart();
      }
      f.beforeCheckpoint(async () => {});
      const generation = event === 'vm' ? '1' : '2';
      const { message } = await session(f, generation);
      assert.match(message!, event.startsWith('vm') ? /stopped/ : /too large/);
      assert.deepEqual(f.restored.at(-1)?.checkpoint, checkpoint);
      await f.settled();
      assert.equal(f.state()?.phase, 'ready');
      assert.equal(f.state()?.notice, undefined);
      await f.launch(randomUUID(), generation);
      assert.equal(f.state()?.phase, 'dirty');
    });
  }
});

test('browser idle checkpoint waits for all calls and successful private quiescence', async () => {
  const f = fixture('browser');
  const first = randomUUID();
  const second = randomUUID();
  await f.launch(first);
  await f.launch(second);
  await f.completed(first);
  assert.equal(await f.lifecycle.idle(), false);
  assert.equal(f.events.includes('checkpoint'), false);
  await f.completed(second);
  f.canQuiesce(false);
  assert.equal(await f.lifecycle.idle(), false);
  assert.equal(f.running(), true);
  assert.equal(f.state()?.phase, 'dirty');
  f.canQuiesce(true);
  assert.equal(await f.lifecycle.idle(), true);
  assert.equal(f.state()?.phase, 'ready');
  assert.equal(f.running(), false);
  const checkpoint = f.state()?.checkpoint;
  await f.launch();
  assert.deepEqual(f.restored.at(-1)?.checkpoint, checkpoint);
});

test('failed native launch and nonzero bridge exit remain durably uncertain', async () => {
  for (const failLaunch of [true, false]) {
    const f = fixture();
    const id = randomUUID();
    if (failLaunch) {
      f.beforeLaunch(async () => {
        throw new Error('Synthetic private launch failure');
      });
      await assert.rejects(f.launch(id));
    } else {
      await f.launch(id);
      await assert.rejects(f.completed(id, '1', 1));
    }
    assert.equal(f.state()?.phase, 'uncertain');
    assert.equal(f.running(), false);
    await assert.rejects(f.launch());
  }
});

test('late native launch and delayed destruction finish before stopped state or replacement startup', async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  f.beforeLaunch(async () => {
    entered.resolve();
    await release.promise;
  });
  const launching = f.launch();
  await entered.promise;
  let stopped = false;
  const stopping = f.lifecycle.stop(f.ownerId, '1').then(() => {
    stopped = true;
  });
  await delay(5);
  assert.equal(stopped, false);
  assert.equal(f.state()?.stopped, false);
  release.resolve();
  await launching;
  await stopping;
  assert.equal(f.state()?.phase, 'uncertain');
  assert.equal(f.state()?.stopped, true);
  assert.equal(f.running(), false);
  f.restart();
  await assert.rejects(f.launch(randomUUID(), '2'));
});

test('a controller from a stopped generation cannot stop or fence its replacement', async () => {
  const f = fixture();
  const first = randomUUID();
  await f.launch(first);
  await f.completed(first);
  const stale = f.lifecycle;
  await stale.stop(f.ownerId, '1');
  f.restart();
  const second = randomUUID();
  await f.launch(second, '2');
  await f.completed(second, '2');
  await f.settled();
  const state = f.state();
  const destroys = f.events.filter((event) => event === 'destroy').length;
  await assert.rejects(stale.stop(f.ownerId, '1'));
  await assert.rejects(stale.uncertain(f.ownerId, '1'));
  assert.deepEqual(f.state(), state);
  assert.equal(f.running(), true);
  assert.equal(f.events.filter((event) => event === 'destroy').length, destroys);
  await f.lifecycle.authorize(f.ownerId, '2');
});

test('a settling checkpoint publishes before the next command and cannot outlive a concurrent fence', async () => {
  for (const fence of [false, true]) {
    const f = fixture();
    const first = randomUUID();
    await f.launch(first);
    await f.completed(first);
    await f.settled();
    const prior = f.state()?.checkpoint;
    const second = randomUUID();
    await f.launch(second);
    const entered = deferred();
    const release = deferred();
    f.beforeWrite(async (state) => {
      if (state.phase === 'ready') {
        entered.resolve();
        await release.promise;
      }
    });
    await f.completed(second);
    await entered.promise;
    assert.equal(f.state()?.phase, 'unsaved');
    assert.deepEqual(f.state()?.checkpoint, prior);
    let launched = false;
    const next = fence
      ? f.lifecycle.uncertain(f.ownerId, '1')
      : f.launch().then(() => {
          launched = true;
        });
    await delay(10);
    assert.equal(launched, false);
    release.resolve();
    await next;
    assert.equal(f.state()?.phase, fence ? 'uncertain' : 'dirty');
    assert.deepEqual(f.state()?.previousCheckpoint, prior);
    assert.deepEqual(f.removed, []);
    assert.equal(f.running(), !fence);
  }
});

test('no native action runs when durable intent cannot be written', async () => {
  const f = fixture();
  f.beforeWrite(async (state) => {
    if (state.phase === 'dirty') throw new Error('Synthetic private intent failure');
  });
  await assert.rejects(f.launch());
  assert.equal(f.events.includes('launch'), false);
  assert.equal(f.lifecycle.active, 0);
  assert.equal(f.state()?.phase, 'ready');
  assert.equal(f.state()?.commands, undefined);
});

test('restoration authorization expiry blocks dispatch and destroys the partial computer', async () => {
  const f = fixture();
  f.beforeRestore(async () => {
    f.revoke();
  });
  await assert.rejects(f.launch(), {
    message: 'The runtime request could not be completed.',
  });
  assert.equal(f.events.includes('launch'), false);
  assert.equal(f.running(), false);
  assert.equal(f.lifecycle.active, 0);
  assert.equal(f.state()?.phase, 'restoring');
});

test('stopped confirmation and new generation wait for real destruction', async () => {
  const f = fixture();
  const id = randomUUID();
  await f.launch(id);
  await f.completed(id);
  const entered = deferred();
  const release = deferred();
  f.beforeDestroy(async () => {
    entered.resolve();
    await release.promise;
  });
  let stopped = false;
  const stopping = f.lifecycle.stop(f.ownerId, '1').then(() => {
    stopped = true;
  });
  await entered.promise;
  assert.equal(stopped, false);
  assert.equal(f.state()?.stopped, false);
  const starts = f.events.filter((event) => event === 'start').length;
  const replacement = f.launch(randomUUID(), '2');
  await delay(5);
  assert.equal(f.events.filter((event) => event === 'start').length, starts);
  release.resolve();
  await stopping;
  await replacement;
  assert.equal(f.state()?.generation, '2');
  assert.equal(f.running(), true);
});

test('failed destruction cannot record stopped or permit a replacement generation', async () => {
  const f = fixture();
  const id = randomUUID();
  await f.launch(id);
  await f.completed(id);
  f.beforeDestroy(async () => {
    throw new Error('Synthetic private destroy failure');
  });
  await assert.rejects(f.lifecycle.stop(f.ownerId, '1'));
  assert.equal(f.state()?.phase, 'uncertain');
  assert.equal(f.state()?.stopped, false);
  assert.equal(f.running(), true);
  f.restart();
  await assert.rejects(f.launch(randomUUID(), '2'));
});

test('failed uncertainty persistence still attempts confirmed destruction without accepting new work', async () => {
  const f = fixture();
  await f.launch();
  f.beforeWrite(async (state) => {
    if (state.phase === 'uncertain') throw new Error('Synthetic private fence failure');
  });
  await assert.rejects(f.lifecycle.uncertain(f.ownerId, '1'));
  assert.equal(f.running(), false);
  assert.equal(f.lifecycle.active, 0);
  assert.equal(f.state()?.phase, 'dirty');
  await assert.rejects(f.launch());
});

test('browser uncertainty fences every concurrent action and never checkpoints partial work', async () => {
  const f = fixture('browser');
  const first = randomUUID();
  const second = randomUUID();
  await f.launch(first);
  await f.launch(second);
  await f.lifecycle.uncertain(f.ownerId, '1');
  await assert.rejects(f.completed(first));
  await assert.rejects(f.completed(second));
  assert.equal(f.state()?.phase, 'uncertain');
  assert.equal(f.lifecycle.active, 0);
  assert.equal(f.running(), false);
  assert.equal(f.events.includes('checkpoint'), false);
  await assert.rejects(f.launch());
});

test('durable claims allow more than 1024 completed commands and survive controller replacement', async () => {
  const f = fixture();
  const first = randomUUID();
  for (let index = 0; index < 1100; index++) {
    const id = index === 0 ? first : randomUUID();
    await f.launch(id);
    await f.completed(id);
    assert.equal(f.state()?.commands, undefined);
  }
  assert.equal(f.claims.size, 1100);
  await f.settled();
  f.restart();
  await assert.rejects(f.launch(first), { status: 409 });
  assert.equal(f.events.filter((event) => event === 'launch').length, 1100);
  const next = randomUUID();
  await f.launch(next);
  await f.completed(next);
  await f.settled();
  assert.equal(f.claims.size, 1101);
  assert.equal(f.state()?.phase, 'ready');
});

test('claim identity separates owners, roles and confirmed replacement generations', async () => {
  const claims = new Set<string>();
  const owner = randomUUID();
  const workspace = fixture('workspace', claims, owner);
  const browser = fixture('browser', claims, owner);
  const otherOwner = fixture('workspace', claims);
  const id = randomUUID();
  for (const f of [workspace, browser, otherOwner]) {
    await f.launch(id);
    await f.completed(id);
    await assert.rejects(f.launch(id), { status: 409 });
  }
  await workspace.lifecycle.stop(owner, '1');
  await workspace.launch(id, '2');
  await workspace.completed(id, '2');
  assert.equal(claims.size, 4);
  assert.equal(workspace.claimed(id, '1'), true);
  assert.equal(workspace.claimed(id, '2'), true);
});

test('legacy command IDs migrate before accepted work and stay rejected after array removal', async () => {
  const f = fixture();
  const legacy = [randomUUID(), randomUUID(), randomUUID()];
  f.seed({
    ownerId: f.ownerId,
    environment: 'development',
    generation: '1',
    role: 'workspace',
    phase: 'ready',
    stopped: false,
    commands: legacy,
  });
  await assert.rejects(f.launch(legacy[0]), { status: 409 });
  assert.equal(f.events.includes('launch'), false);
  assert.deepEqual(f.state()?.commands, legacy);
  const id = randomUUID();
  await f.launch(id);
  assert.equal(f.state()?.commands, undefined);
  for (const previous of [...legacy, id]) assert.equal(f.claimed(previous), true);
  const intent = f.events.indexOf('write:dirty:false');
  for (const previous of legacy) assert.ok(f.events.indexOf(`claim:${previous}`) < intent);
  await f.completed(id);
  await f.settled();
  f.restart();
  for (const previous of legacy) await assert.rejects(f.launch(previous), { status: 409 });
  assert.equal(f.events.filter((event) => event === 'launch').length, 1);
});

test('interrupted legacy migration retains its source IDs and never dispatches an action', async () => {
  const f = fixture();
  const legacy = [randomUUID(), randomUUID()];
  f.seed({
    ownerId: f.ownerId,
    environment: 'development',
    generation: '1',
    role: 'workspace',
    phase: 'ready',
    stopped: false,
    commands: legacy,
  });
  f.beforeClaim(async (_identity, id) => {
    if (id === legacy[1]) throw new Error('Synthetic private migration failure');
  });
  await assert.rejects(f.launch());
  assert.deepEqual(f.state()?.commands, legacy);
  assert.equal(f.claimed(legacy[0]), true);
  assert.equal(f.events.includes('launch'), false);
  f.beforeClaim(async () => {});
  f.restart();
  const id = randomUUID();
  await f.launch(id);
  assert.equal(f.state()?.commands, undefined);
  assert.equal(f.claimed(legacy[1]), true);
  assert.equal(f.claimed(id), true);
});

test('an interrupted intent write burns its claimed ID without running native code', async () => {
  const f = fixture();
  const id = randomUUID();
  f.beforeWrite(async (state) => {
    if (state.phase === 'dirty') throw new Error('Synthetic private intent write failure');
  });
  await assert.rejects(f.launch(id));
  assert.equal(f.claimed(id), true);
  assert.equal(f.events.includes('launch'), false);
  f.beforeWrite(async () => {});
  f.restart();
  await assert.rejects(f.launch(id), { status: 409 });
  assert.equal(f.events.includes('launch'), false);
  await f.launch();
  assert.equal(f.events.filter((event) => event === 'launch').length, 1);
});

test('native dispatch and dirty intent wait for the durable claim to settle', async () => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  const id = randomUUID();
  f.beforeClaim(async () => {
    entered.resolve();
    await release.promise;
  });
  const launching = f.launch(id);
  await entered.promise;
  assert.equal(f.state()?.phase, 'ready');
  assert.equal(f.events.includes('launch'), false);
  assert.equal(f.events.includes('write:dirty:false'), false);
  release.resolve();
  await launching;
  assert.equal(f.claimed(id), true);
  assert.equal(f.state()?.phase, 'dirty');
});

test('idle recovery after controller eviction preserves clean checkpoints and quarantines unobserved dirty work', async (t) => {
  for (const phase of ['ready', 'restoring', 'dirty', 'uncertain'] as const) {
    await t.test(phase, async () => {
      const f = fixture();
      const id = randomUUID();
      await f.launch(id);
      await f.completed(id);
      await f.settled();
      const state = { ...f.state()!, phase };
      f.seed(state);
      f.restart();
      const previous = f.events.length;
      assert.equal(await f.lifecycle.idle(), true);
      assert.equal(f.running(), false);
      assert.deepEqual(f.state()?.checkpoint, state.checkpoint);
      assert.equal(f.events.slice(previous).includes('checkpoint'), false);
      assert.equal(
        f.events.slice(previous).some((event) => event.startsWith('quiesce')),
        false,
      );
      if (phase === 'dirty' || phase === 'uncertain') {
        assert.equal(f.state()?.phase, 'uncertain');
        await assert.rejects(f.launch(), { status: 503 });
      } else {
        assert.equal(f.state()?.phase, phase);
        await f.launch();
        assert.deepEqual(f.restored.at(-1)?.checkpoint, state.checkpoint);
      }
    });
  }
});

test('idle hydration refuses a foreign role or environment before destroying its process', async () => {
  const f = fixture();
  const id = randomUUID();
  await f.launch(id);
  await f.completed(id);
  await f.settled();
  const state = f.state();
  const previous = f.events.length;
  for (const options of [
    { ...f.options, role: 'browser' as const },
    { ...f.options, environment: 'production' },
  ])
    await assert.rejects(createComputerLifecycle(options).idle(), { status: 503 });
  assert.equal(f.running(), true);
  assert.deepEqual(f.state(), state);
  assert.equal(f.events.length, previous);
});

test('read-only computer stop inspection waits for lifecycle cleanup and preserves all state', async () => {
  const f = fixture();
  const id = randomUUID();
  await f.launch(id);
  await f.completed(id);
  const destroying = deferred();
  const finish = deferred();
  f.beforeDestroy(async () => {
    destroying.resolve();
    await finish.promise;
  });
  const stop = f.lifecycle.stop(f.ownerId, '1');
  await destroying.promise;
  let inspected = false;
  let registryActive = 0;
  const inspect = (version: string | null = '1') =>
    f.lifecycle.inspectStopped(f.ownerId, version, {
      authorize: async () => {},
      active: () => registryActive,
      physicallyStopped: async () => {
        inspected = true;
        return !f.running();
      },
    });
  const proof = inspect();
  await Promise.resolve();
  assert.equal(inspected, false);
  finish.resolve();
  await stop;
  const before = { state: f.state(), writes: f.writes.length, events: [...f.events] };
  assert.equal(await proof, true);
  assert.equal(await inspect('2'), true);
  assert.equal(await inspect(null), false);
  registryActive = 1;
  assert.equal(await inspect(), false);
  assert.deepEqual({ state: f.state(), writes: f.writes.length, events: f.events }, before);
});
