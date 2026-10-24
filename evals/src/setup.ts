import type { Stack } from './stack.ts';
import type { World } from './scenario.ts';

async function call(
  stack: Stack,
  method: string,
  path: string,
  body?: unknown,
  redirect: RequestRedirect = 'follow',
) {
  const response = await stack.request(path, {
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
  await call(stack, 'PATCH', '/api/preferences', {
    timeZone,
    quietHoursEnabled: false,
    notificationRule: world.notificationRule ?? '',
    ...(world.rules ? { rules: world.rules } : {}),
  });
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
  for (const remote of world.apps?.remote ?? []) {
    const started = (await (
      await call(stack, 'POST', `/api/apps/${remote.service}/connect`, { returnTo: 'apps' })
    ).json()) as { url?: string };
    if (!started.url) throw new Error(`${remote.service} did not start a sign-in.`);
    const authorized = await fetch(started.url, { redirect: 'manual' });
    const location = authorized.headers.get('location');
    if (!location) throw new Error(`${remote.service} sign-in did not return to nod.`);
    const back = new URL(location);
    await call(stack, 'GET', back.pathname + back.search, undefined, 'manual');
    const apps = (await (await call(stack, 'GET', '/api/apps')).json()) as unknown;
    const list = (
      Array.isArray(apps) ? apps : ((apps as { apps?: unknown[] }).apps ?? [])
    ) as Array<{
      slug?: string;
      status?: string;
    }>;
    if (!list.some((app) => app.slug === remote.service && app.status === 'connected'))
      throw new Error(`${remote.service} did not connect in the evaluation.`);
  }
  for (const { securityCode: _code, ...card } of world.cards ?? [])
    await call(stack, 'POST', '/api/vault', { kind: 'card', ...card });
  for (const login of world.logins ?? [])
    await call(stack, 'POST', '/api/vault', { kind: 'login', ...login });
}
