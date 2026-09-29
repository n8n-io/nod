import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { registerLocalAccess } from '../src/server/access.ts';
import { createVault, sealCredential } from '../src/server/vault.ts';
import type { SiteIcon } from '../src/ports/link-preview.ts';

test(
  'Vault website icons are owner scoped, cached per origin and skip local sites',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async () => {
    const schema = `test_vault_icon_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify({ logger: false });
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await pool.query(
        "CREATE TABLE tasks(id text PRIMARY KEY,owner_id text NOT NULL,revision integer NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'running')",
      );
      const key = randomBytes(32);
      const headers = { host: 'localhost:4310', origin: 'http://localhost:4310' };
      const fetched: string[] = [];
      const icon: SiteIcon = { bytes: Buffer.from('synthetic icon'), mimeType: 'image/x-icon' };
      registerLocalAccess(app, 4310);
      const vault = await createVault(pool, {
        keyStore: { id: 'fixture', configured: true, getKey: async () => key },
        inject: async () => assert.fail('Icons must not fill a browser.'),
        resume: async () => assert.fail('Icons must not resume a task.'),
        retry: async () => assert.fail('Icons must not restart a task.'),
        icon: async (origin) => {
          fetched.push(origin);
          return origin === 'https://missing.example.com' ? null : icon;
        },
      });
      vault.registerRoutes(app);
      const seed = async (origin: string, ownerId = 'local-development') => {
        const entry = { id: randomUUID(), owner_id: ownerId, origin };
        await pool.query(
          'INSERT INTO vault_entries(id,owner_id,label,origin,username_hint,ciphertext) VALUES($1,$2,$3,$4,$5,$6)',
          [
            entry.id,
            ownerId,
            'Synthetic login',
            origin,
            'sy…',
            sealCredential(key, entry, { username: 'synthetic', password: 'synthetic' }),
          ],
        );
        return entry.id;
      };
      const read = (id: string) =>
        app.inject({ method: 'GET', url: `/api/vault/${id}/icon`, headers });
      const first = await seed('https://example.com');
      const second = await seed('https://example.com');
      const response = await read(first);
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-type'], 'image/x-icon');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['content-security-policy'], "default-src 'none'; sandbox");
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.body, 'synthetic icon');
      assert.equal((await read(second)).statusCode, 200);
      assert.deepEqual(fetched, ['https://example.com']);

      const missing = await seed('https://missing.example.com');
      assert.equal((await read(missing)).statusCode, 404);
      assert.equal((await read(missing)).statusCode, 404);
      assert.deepEqual(fetched, ['https://example.com', 'https://missing.example.com']);

      const local = await seed('http://localhost:3000');
      const other = await seed('https://other.example.com', 'another-owner');
      for (const id of [local, other, randomUUID(), 'not-a-uuid'])
        assert.equal((await read(id)).statusCode, 404);
      assert.deepEqual(fetched, ['https://example.com', 'https://missing.example.com']);
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'Manual Vault logins reject single-label website hosts unless local',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async () => {
    const schema = `test_vault_origin_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const app = Fastify({ logger: false });
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await pool.query(
        "CREATE TABLE tasks(id text PRIMARY KEY,owner_id text NOT NULL,revision integer NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'running')",
      );
      const headers = { host: 'localhost:4310', origin: 'http://localhost:4310' };
      registerLocalAccess(app, 4310);
      const key = randomBytes(32);
      const vault = await createVault(pool, {
        keyStore: { id: 'fixture', configured: true, getKey: async () => key },
        inject: async () => undefined,
        resume: async () => undefined,
        retry: async () => undefined,
      });
      vault.registerRoutes(app);
      const save = (origin: string) =>
        app.inject({
          method: 'POST',
          url: '/api/vault',
          headers,
          payload: { label: 'Synthetic', origin, username: 'synthetic', password: 'synthetic' },
        });
      for (const origin of ['a', 'https://a', 'https://intranet', 'a.']) {
        const response = await save(origin);
        assert.equal(response.statusCode, 400, origin);
        assert.equal(response.json().error, 'Enter a full website domain, such as example.com.');
      }
      for (const [origin, saved] of [
        ['example.com', 'https://example.com'],
        ['https://sub.example.co.uk', 'https://sub.example.co.uk'],
        ['http://localhost:3000', 'http://localhost:3000'],
      ]) {
        const response = await save(origin);
        assert.equal(response.statusCode, 200, origin);
        assert.equal(response.json().origin, saved);
      }
      const { rows } = await pool.query('SELECT count(*)::int AS count FROM vault_entries');
      assert.equal(rows[0].count, 3);
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
