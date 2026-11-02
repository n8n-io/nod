import type { UpdatesSubscription } from '../../ports/updates.ts';

export function createN8nUpdates(options: {
  url?: string;
  token?: string;
  request?: typeof fetch;
}): UpdatesSubscription | undefined {
  if (!options.url || !options.token) return undefined;
  const token = options.token;
  const endpoint = new URL(options.url);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('The updates URL must use HTTPS without credentials, queries or fragments.');
  const request = options.request ?? fetch;
  return async (email, signal) => {
    const response = await request(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-nod-updates-token': token },
      body: JSON.stringify({ version: 1, email }),
      signal: AbortSignal.any([AbortSignal.timeout(15_000), signal]),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`The updates webhook answered ${response.status}.`);
  };
}
