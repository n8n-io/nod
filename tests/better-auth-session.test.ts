import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { makeSignature } from 'better-auth/crypto';
import { createGoogleAuthentication } from '../src/providers/better-auth/index.ts';

const origin = 'http://localhost:4399';

test(
  'real Better Auth migrations, signed session reads, revocation and rejected callbacks use a disposable schema',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 20_000 },
  async (t) => {
    const schema = `test_better_auth_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const root = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = `/${schema}`;
    url.searchParams.delete('options');
    const admin = new pg.Pool({ connectionString: url.href, max: 1 });
    const database = new pg.Pool({
      connectionString: url.href,
      options: `-c search_path=${schema}`,
      max: 2,
    });
    let created = false;
    t.after(async () => {
      await database.end();
      await admin.end();
      if (created) await root.query(`DROP DATABASE "${schema}"`);
      await root.end();
    });
    await root.query(`CREATE DATABASE "${schema}"`);
    created = true;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const secret = randomBytes(48).toString('hex');
    const authentication = createGoogleAuthentication({
      database,
      origin,
      secret,
      environment: 'fixture',
      clientId: 'synthetic.apps.googleusercontent.com',
      clientSecret: 'synthetic-google-client-secret',
    });
    const previousFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => {
      networkCalls++;
      throw new Error('Network access is disabled in this fixture.');
    };
    try {
      await authentication.initialize();
      await authentication.initialize();
      const tables = (
        await database.query(
          'SELECT table_name FROM information_schema.tables WHERE table_schema=$1',
          [schema],
        )
      ).rows.map((row) => row.table_name);
      for (const table of ['user', 'session', 'account', 'verification'])
        assert.ok(tables.includes(table));
      const user = randomUUID();
      const session = randomUUID();
      const token = randomBytes(32).toString('base64url');
      await database.query(
        'INSERT INTO "user" (id,name,email,"emailVerified",image,"givenName","createdAt","updatedAt") VALUES ($1,$2,$3,true,$4,$5,now(),now())',
        [
          user,
          'Synthetic Example',
          'synthetic@example.test',
          'https://lh3.googleusercontent.com/synthetic-avatar',
          'Synthetic',
        ],
      );
      await database.query(
        'INSERT INTO "session" (id,token,"userId","expiresAt","createdAt","updatedAt") VALUES ($1,$2,$3,now()+interval \'1 hour\',now(),now())',
        [session, token, user],
      );
      const signature = await makeSignature(token, secret);
      const headers = new Headers({
        cookie: `otto-fixture.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
        origin,
      });
      const accepted = await authentication.session(headers);
      assert.equal(accepted?.user.id, user);
      assert.equal(accepted?.id, session);
      assert.equal(accepted?.user.avatarUrl, null);
      assert.equal(accepted?.avatarSource, 'https://lh3.googleusercontent.com/synthetic-avatar');
      assert.equal(accepted?.givenName, 'Synthetic');
      assert.equal(accepted?.user.name, 'Synthetic Example');
      const tampered = new Headers({
        cookie: `otto-fixture.session_token=${encodeURIComponent(`${token}.invalid`)}`,
        origin,
      });
      assert.equal(await authentication.session(tampered), null);
      await database.query('UPDATE "user" SET "emailVerified"=false WHERE id=$1', [user]);
      assert.equal(await authentication.session(headers), null);
      await database.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [user]);
      const signedOut = await authentication.signOut(headers);
      assert.equal(signedOut.status, 200);
      assert.ok(signedOut.headers.getSetCookie().some((cookie) => cookie.includes('Max-Age=0')));
      await signedOut.body?.cancel();
      assert.equal(await authentication.session(headers), null);
      const signIn = await authentication.signIn(new Headers({ origin }));
      assert.equal(signIn.status, 200);
      const consent = new URL(((await signIn.json()) as { url: string }).url);
      assert.equal(consent.hostname, 'accounts.google.com');
      assert.equal(consent.searchParams.get('redirect_uri'), `${origin}/api/auth/callback/google`);
      assert.equal(consent.searchParams.get('client_id'), 'synthetic.apps.googleusercontent.com');
      assert.ok(consent.searchParams.get('state'));
      assert.ok(consent.searchParams.get('code_challenge'));
      const missing = await authentication.callback(
        new Request(`${origin}/api/auth/callback/google?error=access_denied`),
      );
      assert.equal(missing.status, 302);
      assert.equal(new URL(missing.headers.get('location')!, origin).pathname, '/login');
      await missing.body?.cancel();
      const cookies = signIn.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0])
        .join('; ');
      const callback = new URL(`${origin}/api/auth/callback/google`);
      callback.searchParams.set('state', consent.searchParams.get('state')!);
      callback.searchParams.set('error', 'access_denied');
      callback.searchParams.set('error_description', 'Synthetic private provider detail');
      const cancelled = await authentication.callback(
        new Request(callback, { headers: { cookie: cookies } }),
      );
      assert.equal(cancelled.status, 302);
      const destination = new URL(cancelled.headers.get('location')!, origin);
      assert.equal(destination.origin, origin);
      assert.equal(destination.pathname, '/login');
      assert.equal(destination.searchParams.has('error_description'), false);
      assert.equal(destination.searchParams.get('error'), 'sign-in');
      await cancelled.body?.cancel();
      const replay = await authentication.callback(
        new Request(callback, { headers: { cookie: cookies } }),
      );
      assert.equal(replay.headers.get('location'), `${origin}/login?error=sign-in`);
      await replay.body?.cancel();
      assert.equal(networkCalls, 0);
      assert.equal(
        (await database.query('SELECT count(*)::int AS count FROM "session"')).rows[0].count,
        0,
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  },
);
