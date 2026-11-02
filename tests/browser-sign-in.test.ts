import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { BrowserConnectionRequest } from '../src/ports/agent.ts';
import type { Computer } from '../src/ports/computer.ts';
import { createBrowserConnections } from '../src/server/browser-connections.ts';
import { createAnalytics } from '../src/server/analytics.ts';
import type { ProductAnalytics } from '../src/ports/analytics.ts';

test(
  'browser profiles require an explicit observed sign-in outcome and retain owner and turn fences',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `browser_connections_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    let location = 'https://example.test/login';
    const page = (path = '/account') => {
      location = `https://example.test${path}`;
    };
    try {
      await pool.query(
        'CREATE TABLE threads (id uuid PRIMARY KEY,owner_id text,status text,archived_at timestamptz)',
      );
      await pool.query(
        'CREATE TABLE turns (id uuid PRIMARY KEY,owner_id text,thread_id uuid,status text,background boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),session_id uuid GENERATED ALWAYS AS (CASE WHEN background THEN id ELSE thread_id END) STORED)',
      );
      const first = { threadId: randomUUID(), turnId: randomUUID() };
      const second = { threadId: randomUUID(), turnId: randomUUID() };
      for (const turn of [first, second]) {
        await pool.query("INSERT INTO threads(id,owner_id,status) VALUES($1,'owner-a','running')", [
          turn.threadId,
        ]);
        await pool.query(
          "INSERT INTO turns(id,owner_id,thread_id,status) VALUES($1,'owner-a',$2,'running')",
          [turn.turnId, turn.threadId],
        );
      }
      let cancelTurnId: string | undefined;
      let changeOrigin = false;
      let held = false;
      let retainedHold = false;
      const bindings: string[] = [];
      const removed: string[] = [];
      const computer = {
        async bindProfile(_threadId: string, profileId: string) {
          if (held) throw Object.assign(new Error('Synthetic held profile'), { statusCode: 423 });
          bindings.push(profileId);
        },
        async act() {
          return { url: location, text: 'Synthetic page with a password field' };
        },
        async currentPage() {
          if (cancelTurnId)
            await pool.query("UPDATE turns SET status='cancelled' WHERE id=$1", [cancelTurnId]);
          if (changeOrigin) location = 'https://other.test/account';
          return { origin: new URL(location).origin, url: location };
        },
        async hold(_id: string, value: boolean) {
          retainedHold = value;
        },
        async close() {},
        async deleteProfile(profileId: string) {
          if (retainedHold)
            throw Object.assign(new Error('Synthetic retained browser hold'), { statusCode: 423 });
          removed.push(profileId);
        },
      } as unknown as Computer;
      const service = await createBrowserConnections(pool, { ownerId: 'owner-a', computer });
      const opened = await service.request(
        { action: 'connect', url: 'https://example.test/login' },
        first,
      );
      assert.equal(opened.status, 'profile_opened');
      assert.ok('connectionId' in opened);
      const connectionId = opened.connectionId;
      assert.deepEqual(
        await service.target({ action: 'use', url: 'https://example.test/login', connectionId }),
        {
          origin: 'https://example.test',
          account: 'example.test',
          kind: 'session',
          itemId: connectionId,
        },
      );
      assert.equal(
        (
          await service.request(
            { action: 'use', url: 'https://example.test/login', connectionId },
            first,
          )
        ).status,
        'session_opened',
      );
      assert.equal((await service.list())[0].browserState, 'pending');
      const save = {
        action: 'save' as const,
        url: 'https://example.test/login',
        connectionId,
        signedIn: true as const,
      };
      for (const state of ['pending', 'needs_sign_in']) {
        page();
        await pool.query('UPDATE browser_connections SET state=$2,checked_at=NULL WHERE id=$1', [
          connectionId,
          state,
        ]);
        const opened = await service.request(
          { action: 'use', url: 'https://example.test/account', connectionId },
          first,
        );
        assert.equal(opened.status, 'session_opened');
        for (const signedIn of [undefined, false]) {
          const unconfirmed = {
            action: 'save',
            url: 'https://example.test/account',
            connectionId,
            ...(signedIn === undefined ? {} : { signedIn }),
          } as BrowserConnectionRequest;
          assert.equal((await service.request(unconfirmed, first)).status, 'rejected');
        }
        const stored = (await service.list())[0];
        assert.equal(stored.browserState, state);
        assert.equal(stored.status, 'disconnected');
        assert.equal(stored.checkedAt, undefined);
      }
      page('/login');
      changeOrigin = true;
      assert.equal((await service.request(save, first)).status, 'needs_sign_in');
      assert.equal((await service.list())[0].browserState, 'needs_sign_in');
      changeOrigin = false;
      page('/login');
      cancelTurnId = first.turnId;
      await assert.rejects(service.request(save, first), /no longer active|unavailable/);
      assert.equal((await service.list())[0].browserState, 'needs_sign_in');
      await pool.query("UPDATE turns SET status='running' WHERE id=$1", [first.turnId]);
      cancelTurnId = undefined;
      assert.equal((await service.request(save, first)).status, 'session_saved');
      assert.equal((await service.list())[0].browserState, 'saved');
      await pool.query(
        "UPDATE browser_connections SET checked_at='2001-01-01T00:00:00Z' WHERE id=$1",
        [connectionId],
      );
      const checkedAt = (await service.list())[0].checkedAt;
      assert.deepEqual(
        await service.request(
          { action: 'use', url: 'https://example.test/account', connectionId },
          second,
        ),
        { status: 'rejected', code: 'browser_connection_unavailable' },
      );
      await pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [first.turnId]);
      const priorBindings = bindings.length;
      cancelTurnId = second.turnId;
      await assert.rejects(
        service.request(
          { action: 'use', url: 'https://example.test/account', connectionId },
          second,
        ),
        /no longer active/,
      );
      assert.equal((await service.list())[0].browserState, 'saved');
      assert.equal((await service.list())[0].checkedAt, checkedAt);
      await pool.query("UPDATE turns SET status='running' WHERE id=$1", [second.turnId]);
      cancelTurnId = undefined;
      page();
      held = true;
      assert.deepEqual(
        await service.request(
          { action: 'use', url: 'https://example.test/account', connectionId },
          second,
        ),
        { status: 'rejected', code: 'browser_connection_busy' },
      );
      held = false;
      assert.equal(
        (
          await service.request(
            { action: 'use', url: 'https://example.test/account', connectionId },
            second,
          )
        ).status,
        'session_opened',
      );
      assert.equal((await service.list())[0].browserState, 'saved');
      assert.equal((await service.list())[0].checkedAt, checkedAt);
      assert.equal(bindings.length, priorBindings + 2);
      assert.equal(new Set(bindings).size, 1);
      page();
      assert.equal((await service.request(save, second)).status, 'session_saved');
      const recheckedAt = (await service.list())[0].checkedAt;
      assert.notEqual(recheckedAt, checkedAt);
      changeOrigin = true;
      assert.equal(
        (
          await service.request(
            { action: 'use', url: 'https://example.test/account', connectionId },
            second,
          )
        ).status,
        'needs_sign_in',
      );
      assert.equal((await service.list())[0].browserState, 'needs_sign_in');
      assert.equal((await service.list())[0].checkedAt, recheckedAt);
      changeOrigin = false;
      location = 'https://other.test/';
      assert.equal(
        (await service.request({ action: 'use', url: 'https://other.test/', connectionId }, second))
          .status,
        'session_opened',
      );
      assert.equal((await service.list())[0].browserState, 'needs_sign_in');
      assert.equal(
        (await service.request({ ...save, url: 'https://other.test/' }, second)).status,
        'rejected',
      );
      page();
      const other = await createBrowserConnections(pool, { ownerId: 'owner-b', computer });
      const foreign = { threadId: randomUUID(), turnId: randomUUID() };
      await pool.query("INSERT INTO threads(id,owner_id,status) VALUES($1,'owner-b','running')", [
        foreign.threadId,
      ]);
      await pool.query(
        "INSERT INTO turns(id,owner_id,thread_id,status) VALUES($1,'owner-b',$2,'running')",
        [foreign.turnId, foreign.threadId],
      );
      await assert.rejects(
        other.request({ action: 'use', url: 'https://example.test/', connectionId }, foreign),
        /unavailable/,
      );
      assert.deepEqual(
        await service.target({ action: 'use', url: 'https://other.test/deep', connectionId }),
        {
          origin: 'https://other.test',
          account: (await service.sessions())[0]!.label,
          kind: 'session',
          itemId: connectionId,
          sessionOrigin: 'https://example.test',
        },
      );
      assert.equal(
        await service.target({ action: 'connect', url: 'https://new.test/a' }),
        undefined,
      );
      assert.equal(await service.target(save), undefined);
      assert.equal(
        await other.target({ action: 'use', url: 'https://example.test/', connectionId }),
        undefined,
      );
      assert.deepEqual(
        (await service.sessions()).map((session) => [session.kind, session.origin]),
        [['session', 'https://example.test']],
      );
      assert.deepEqual(await other.sessions(), []);
      await pool.query(
        "UPDATE browser_connections SET start_url='https://example.test/login?token=synthetic-private#code' WHERE id=$1",
        [connectionId],
      );
      assert.equal((await service.sessions())[0]!.url, 'https://example.test/login');
      await computer.hold(second.threadId, true);
      for (const status of ['queued', 'running', 'waiting']) {
        await pool.query('UPDATE turns SET status=$2 WHERE id=$1', [second.turnId, status]);
        await assert.rejects(service.disconnect(connectionId), /Stop the active work/);
        assert.equal(retainedHold, true);
        assert.equal(removed.length, 0);
      }
      await pool.query("UPDATE turns SET status='completed' WHERE id=$1", [second.turnId]);
      await assert.rejects(
        service.request({ action: 'use', url: 'https://example.test/', connectionId }, second),
        /no longer active/,
      );
      await service.disconnect(connectionId);
      assert.deepEqual(removed, [bindings[0]]);
      await pool.query(
        "INSERT INTO browser_connections(id,owner_id,origin,start_url,label,profile_id,state) VALUES($1,'owner-a','https://example.test','https://example.test','Synthetic', $2,'disconnecting')",
        [connectionId, randomUUID()],
      );
      assert.equal(
        await service.target({ action: 'use', url: 'https://example.test/', connectionId }),
        undefined,
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'saved browser analytics exclude private browsing details and stay off after consent changes mid-use',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `browser_analytics_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const events: Parameters<ProductAnalytics['capture']>[0][] = [];
    const analytics = await createAnalytics({
      environment: 'development',
      dataRoot: '',
      installationId: randomUUID(),
      provider: { capture: (event) => events.push(event), shutdown: async () => {} },
    });
    try {
      const ownerId = 'synthetic-browser-owner';
      const turn = { threadId: randomUUID(), turnId: randomUUID() };
      await pool.query(
        'CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text,archived_at timestamptz)',
      );
      await pool.query(
        'CREATE TABLE turns(id uuid PRIMARY KEY,thread_id uuid,owner_id text,status text)',
      );
      await pool.query('INSERT INTO threads VALUES($1,$2,NULL)', [turn.threadId, ownerId]);
      await pool.query("INSERT INTO turns VALUES($1,$2,$3,'running')", [
        turn.turnId,
        turn.threadId,
        ownerId,
      ]);
      let location = 'https://tenant.example.com/account';
      let waiting: Promise<void> | undefined;
      let entered = () => {};
      const computer = {
        bindProfile: async () => {},
        hold: async () => {},
        close: async () => {},
        deleteProfile: async () => {},
        act: async () => {
          entered();
          await waiting;
          return { url: location, text: 'Synthetic private account page' };
        },
        currentPage: async () => ({ origin: new URL(location).origin, url: location }),
      } as unknown as Computer;
      analytics.setUsageData(ownerId, true, randomUUID());
      const service = await createBrowserConnections(pool, {
        ownerId,
        computer,
        analytics: analytics.forOwner(ownerId),
        analyticsConsent: () => analytics.consent(ownerId),
      });
      const opened = await service.request(
        {
          action: 'connect',
          url: 'https://tenant.example.com/login?secret=synthetic-private',
          label: 'Private fixture account',
        },
        turn,
      );
      assert.ok('connectionId' in opened && opened.connectionId);
      const id = opened.connectionId;
      const use = () => service.request({ action: 'use', url: location, connectionId: id }, turn);
      await use();
      assert.equal(events.filter((event) => event.event === 'service_used').length, 0);
      await service.request(
        { action: 'save', url: location, connectionId: id, signedIn: true },
        turn,
      );
      await use();
      const count = events.length;
      location = 'https://other.example.org/private-path?secret=synthetic-private';
      await use();
      assert.equal(events.length, count);
      location = 'https://tenant.example.com/account';
      let release = () => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const inFlight = use();
      await started;
      analytics.setUsageData(ownerId, false, randomUUID());
      analytics.setUsageData(ownerId, true, randomUUID());
      release();
      await inFlight;
      assert.equal(events.length, count);
      waiting = undefined;
      analytics.setUsageData(ownerId, false, randomUUID());
      await use();
      assert.equal(events.length, count);
      analytics.setUsageData(ownerId, true, randomUUID());
      await use();
      assert.equal(events.length, count + 1);
      const serialized = JSON.stringify(events);
      for (const value of [
        'tenant.',
        'private-path',
        'synthetic-private',
        'Private fixture account',
        id,
      ])
        assert.ok(!serialized.includes(value));
    } finally {
      await analytics.shutdown();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
