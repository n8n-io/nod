import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { BrowserConnectionRequest } from '../src/ports/agent.ts';
import type { Computer } from '../src/ports/computer.ts';
import { createBrowserConnections } from '../src/server/browser-connections.ts';

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
        'CREATE TABLE turns (id uuid PRIMARY KEY,owner_id text,thread_id uuid,status text)',
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
      const bindings: string[] = [];
      const removed: string[] = [];
      const computer = {
        async bindProfile(_threadId: string, profileId: string) {
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
        async hold() {},
        async close() {},
        async deleteProfile(profileId: string) {
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
      await pool.query("UPDATE turns SET status='completed' WHERE id=$1", [second.turnId]);
      await assert.rejects(
        service.request({ action: 'use', url: 'https://example.test/', connectionId }, second),
        /no longer active/,
      );
      await service.disconnect(connectionId);
      assert.deepEqual(removed, [bindings[0]]);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
