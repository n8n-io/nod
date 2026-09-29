import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createPageDataCache } from '../src/web/lib/page-data-cache.ts';

function fixture() {
  const requests: Array<{
    path: string;
    signal: AbortSignal;
    resolve(value: unknown): void;
    reject(error: Error): void;
  }> = [];
  const cache = createPageDataCache(
    (path, signal) =>
      new Promise((resolve, reject) => requests.push({ path, signal, resolve, reject })),
    0,
  );
  return { cache, requests };
}

test('account invalidation aborts every pending read and prevents old private data returning', async () => {
  const { cache, requests } = fixture();
  cache.update('/api/vault', () => [{ id: 'alex-private' }]);
  cache.update('/api/apps', () => [{ id: 'alex-account' }]);
  const pending = [cache.refresh('/api/vault'), cache.refresh('/api/apps')];
  await Promise.resolve();
  cache.clear();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].signal.aborted, true);
  assert.equal(cache.getSnapshot('/api/vault').data, null);
  assert.equal(cache.getSnapshot('/api/apps').data, null);
  cache.update('/api/vault', () => [{ id: 'sam-private' }]);
  cache.update('/api/apps', () => [{ id: 'sam-account' }]);
  requests[0].resolve([{ id: 'alex-private' }]);
  requests[1].resolve([{ id: 'alex-account' }]);
  await Promise.all(pending);
  assert.deepEqual(cache.getSnapshot('/api/vault').data, [{ id: 'sam-private' }]);
  assert.deepEqual(cache.getSnapshot('/api/apps').data, [{ id: 'sam-account' }]);
});

test('page cache retains last-good data across subscribers and deduplicates overlapping reads', async () => {
  const { cache, requests } = fixture();
  assert.equal(cache.getSnapshot('/goals').loading, true);
  const stop = cache.subscribe('/goals', () => {});
  const first = cache.refresh('/goals');
  const duplicate = cache.refresh('/goals');
  assert.equal(duplicate, first);
  await Promise.resolve();
  assert.equal(requests.length, 1);
  stop();
  requests[0].resolve([{ id: 'saved-goal' }]);
  await first;
  const nextStop = cache.subscribe('/goals', () => {});
  assert.deepEqual(cache.getSnapshot('/goals').data, [{ id: 'saved-goal' }]);
  const refresh = cache.refresh('/goals');
  assert.equal(cache.getSnapshot('/goals').loading, false);
  assert.equal(cache.getSnapshot('/goals').refreshing, true);
  assert.deepEqual(cache.getSnapshot('/goals').data, [{ id: 'saved-goal' }]);
  await Promise.resolve();
  requests[1].reject(new Error('Refresh unavailable'));
  await refresh;
  assert.deepEqual(cache.getSnapshot('/goals').data, [{ id: 'saved-goal' }]);
  assert.equal(cache.getSnapshot('/goals').error, 'Refresh unavailable');
  nextStop();
});

test('accepted mutation and forced refresh reject obsolete responses even when fetch ignores abort', async () => {
  const { cache, requests } = fixture();
  cache.update<string[]>('/accounts', () => ['removed', 'retained']);
  const old = cache.refresh('/accounts');
  await Promise.resolve();
  cache.update<string[]>('/accounts', (accounts) =>
    accounts!.filter((value) => value !== 'removed'),
  );
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve(['removed', 'retained']);
  await old;
  assert.deepEqual(cache.getSnapshot('/accounts').data, ['retained']);
  const before = cache.refresh('/accounts');
  await Promise.resolve();
  const after = cache.refresh('/accounts', true);
  await Promise.resolve();
  requests[2].resolve(['new']);
  await after;
  requests[1].resolve(['retained']);
  await before;
  assert.deepEqual(cache.getSnapshot('/accounts').data, ['new']);
  assert.equal(cache.getSnapshot('/accounts').refreshing, false);
});

test('first-load failures remain explicit and active update bursts queue one silent follow-up', async () => {
  const { cache, requests } = fixture();
  const first = cache.refresh('/schedules');
  await Promise.resolve();
  requests[0].reject(new Error('First load failed'));
  await first;
  assert.deepEqual(cache.getSnapshot('/schedules'), {
    data: null,
    error: 'First load failed',
    loading: false,
    refreshing: false,
  });
  cache.update('/schedules', () => [{ id: 'cached' }]);
  const stop = cache.subscribe('/schedules', () => {});
  const active = cache.refresh('/schedules');
  await Promise.resolve();
  cache.revalidateActive();
  cache.revalidateActive();
  cache.revalidateActive();
  assert.equal(requests.length, 2);
  requests[1].resolve([{ id: 'first-refresh' }]);
  await active;
  await delay(5);
  assert.equal(requests.length, 3);
  assert.equal(cache.getSnapshot('/schedules').loading, false);
  requests[2].resolve([{ id: 'latest' }]);
  await cache.refresh('/schedules');
  assert.deepEqual(cache.getSnapshot('/schedules').data, [{ id: 'latest' }]);
  stop();
  cache.revalidateActive();
  await delay(5);
  assert.equal(requests.length, 3);
});

test('a prefetched read serves the first page visit without a second loading state', async () => {
  const { cache, requests } = fixture();
  const prefetch = cache.refresh('/api/vault');
  const stop = cache.subscribe('/api/vault', () => {});
  assert.equal(cache.refresh('/api/vault'), prefetch);
  await Promise.resolve();
  assert.equal(requests.length, 1);
  requests[0].resolve([]);
  await prefetch;
  stop();
  const visit = cache.subscribe('/api/vault', () => {});
  void cache.refresh('/api/vault');
  assert.deepEqual(cache.getSnapshot('/api/vault'), {
    data: [],
    error: '',
    loading: false,
    refreshing: true,
  });
  visit();
});

test('unused prefetches expire before the first visit while visited pages retain last-good data', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const { cache, requests } = fixture();
  try {
    const read = cache.refresh('/api/vault');
    await Promise.resolve();
    requests[0].resolve([{ id: 'old-login' }]);
    await read;
    assert.deepEqual(cache.getSnapshot('/api/vault').data, [{ id: 'old-login' }]);
    t.mock.timers.tick(30_000);
    assert.equal(cache.getSnapshot('/api/vault').data, null);
    assert.equal(cache.getSnapshot('/api/vault').loading, true);
    const stop = cache.subscribe('/api/vault', () => {});
    const fresh = cache.refresh('/api/vault');
    await Promise.resolve();
    requests[1].resolve([{ id: 'current-login' }]);
    await fresh;
    stop();
    t.mock.timers.tick(60_000);
    assert.deepEqual(cache.getSnapshot('/api/vault').data, [{ id: 'current-login' }]);
  } finally {
    cache.clear();
    t.mock.timers.reset();
  }
});

test('state events invalidate unused prefetches and fence their late responses', async () => {
  const { cache, requests } = fixture();
  try {
    const read = cache.refresh('/api/apps');
    await Promise.resolve();
    cache.revalidateActive();
    assert.equal(requests[0].signal.aborted, true);
    requests[0].resolve([{ id: 'removed-account' }]);
    await read;
    assert.equal(cache.getSnapshot('/api/apps').data, null);
    const fresh = cache.refresh('/api/apps');
    await Promise.resolve();
    requests[1].resolve([{ id: 'current-account' }]);
    await fresh;
    cache.revalidateActive();
    assert.equal(cache.getSnapshot('/api/apps').data, null);
  } finally {
    cache.clear();
  }
});
