import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiscoveredOAuth } from '../src/providers/discovered/oauth.ts';

test('a discovered MCP server can register, sign in and refresh without service code', async () => {
  const calls: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const value = new Request(input, init);
    const url = new URL(value.url);
    calls.push(`${value.method} ${url.pathname}`);
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp')
      return Response.json({
        resource: 'https://example.com/mcp',
        authorization_servers: ['https://example.org'],
        scopes_supported: ['read', 'write'],
      });
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return Response.json({
        issuer: 'https://example.org',
        authorization_endpoint: 'https://example.org/authorize',
        token_endpoint: 'https://example.org/token',
        registration_endpoint: 'https://example.org/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
      });
    if (url.pathname === '/register')
      return Response.json({ ...JSON.parse(await value.text()), client_id: 'fixture-client' });
    if (url.pathname === '/token') {
      const form = new URLSearchParams(await value.text());
      const refresh = form.get('grant_type') === 'refresh_token';
      if (refresh) assert.equal(form.get('refresh_token'), 'fixture-refresh');
      else {
        assert.equal(form.get('grant_type'), 'authorization_code');
        assert.equal(form.get('code'), 'fixture-code');
      }
      return Response.json({
        access_token: refresh ? 'fresh-token' : 'first-token',
        refresh_token: 'fixture-refresh',
        token_type: 'Bearer',
        expires_in: refresh ? 3600 : 0,
      });
    }
    throw new Error(`Unexpected OAuth request: ${url.pathname}`);
  };
  const oauth = createDiscoveredOAuth(request);
  const started = await oauth.begin(
    'https://example.com/mcp',
    'http://127.0.0.1:4310/api/apps/callback',
    'fixture-state',
    'read write',
  );
  const authorize = new URL(started.url);
  assert.equal(authorize.origin, 'https://example.org');
  assert.equal(authorize.searchParams.get('state'), 'fixture-state');
  assert.equal(authorize.searchParams.get('scope'), 'read write');
  const finished = await oauth.finish('https://example.com/mcp', started.saved, 'fixture-code');
  assert.equal(finished.tokens?.access_token, 'first-token');
  assert.ok(finished.expiresAt !== undefined && finished.expiresAt <= Date.now());
  const refreshed = await oauth.refresh('https://example.com/mcp', finished);
  assert.equal(refreshed.tokens?.access_token, 'fresh-token');
  assert.ok(calls.includes('POST /register'));
  assert.equal(calls.filter((call) => call === 'POST /token').length, 2);
  const registered = calls.filter((call) => call === 'POST /register').length;
  const supplied = await oauth.begin(
    'https://example.com/mcp',
    'http://127.0.0.1:4310/api/apps/callback',
    'another-state',
    'read',
    'supplied-client',
  );
  assert.equal(supplied.saved.clientInformation?.client_id, 'supplied-client');
  assert.equal(calls.filter((call) => call === 'POST /register').length, registered);
});
