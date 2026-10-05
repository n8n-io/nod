import type { Stack } from './stack.ts';
import type { World } from './scenario.ts';

async function call(
  stack: Stack,
  method: string,
  path: string,
  body?: unknown,
  redirect: RequestRedirect = 'follow',
) {
  const response = await fetch(new URL(path, stack.baseUrl), {
    method,
    redirect,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok && !(redirect === 'manual' && response.status < 400))
    throw new Error(
      `${method} ${path} failed (${response.status}): ${(await response.text()).slice(0, 200)}`,
    );
  return response;
}

export async function prepare(stack: Stack, world: World, timeZone: string) {
  await call(stack, 'PATCH', '/api/preferences', { timeZone, quietHoursEnabled: false });
  const slugs = world.apps?.services ?? [];
  for (const slug of slugs) {
    await call(stack, 'POST', `/api/apps/${slug}/connect`, { returnTo: 'apps' });
  }
  for (const [accountId, callback] of world.apps?.callbacks ?? []) {
    const url = new URL(callback);
    url.searchParams.set('account_ref', accountId);
    url.searchParams.set('outcome', 'success');
    await call(stack, 'GET', url.pathname + url.search, undefined, 'manual');
  }
  for (const card of world.cards ?? [])
    await call(stack, 'POST', '/api/vault', { kind: 'card', ...card });
  for (const login of world.logins ?? [])
    await call(stack, 'POST', '/api/vault', { kind: 'login', ...login });
}
