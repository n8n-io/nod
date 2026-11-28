import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { pairedWindows } from '../src/providers/paired-windows.ts';

test(
  'one attended peer owns the session and disconnect never replays an input',
  { skip: process.platform === 'win32' },
  async (t) => {
    async function read(lines: AsyncIterator<string>) {
      const line = await lines.next();
      assert.equal(line.done, false);
      assert.equal(typeof line.value, 'string');
      return JSON.parse(line.value as string);
    }
    const dir = await mkdtemp(join(tmpdir(), 'nod-pc-'));
    const { control, start } = pairedWindows(dir);
    await start();
    t.after(async () => {
      await control.close?.();
      await rm(dir, { recursive: true, force: true });
    });
    await assert.rejects(control.request({ op: 'apps' }), /start sharing/);
    const first = connect(join(dir, 'current'));
    const lines = createInterface({ input: first })[Symbol.asyncIterator]();
    assert.equal((await read(lines)).ready, true);
    const session = control.session;
    const extra = connect(join(dir, 'current'));
    await once(extra, 'close');
    const result = control.request({ op: 'apps' });
    const sent = await read(lines);
    first.write(JSON.stringify({ id: sent.id, result: { apps: [] } }) + '\n');
    assert.deepEqual(await result, { apps: [] });
    const controller = new AbortController();
    const interrupted = control.request({ op: 'snapshot' }, controller.signal);
    const snapshot = await read(lines);
    controller.abort();
    await assert.rejects(interrupted, /stopped/);
    assert.deepEqual(await read(lines), { cancel: snapshot.id });
    const uncertain = control.request({ op: 'press' });
    const delivery = await read(lines);
    assert.equal(delivery.request.op, 'press');
    first.destroy();
    await assert.rejects(uncertain, /sharing ended/);
    assert.equal(control.session, undefined);
    const second = connect(join(dir, 'current'));
    const next = createInterface({ input: second })[Symbol.asyncIterator]();
    assert.equal((await read(next)).ready, true);
    assert.notEqual(session, control.session);
    const fresh = control.request({ op: 'permissions' });
    const firstDelivery = await read(next);
    assert.equal(firstDelivery.request.op, 'permissions');
    second.write(JSON.stringify({ id: firstDelivery.id, result: { ok: true } }) + '\n');
    assert.deepEqual(await fresh, { ok: true });
    second.destroy();
  },
);
