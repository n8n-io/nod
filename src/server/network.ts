import { isIP } from 'node:net';

export function serverNetwork(environment: Record<string, string | undefined>) {
  const desktop = environment.NOD_DESKTOP === 'true';
  const port = Number(environment.PORT ?? 4310);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error('PORT must be an integer from 1 to 65535.');
  const host = environment.NOD_HOST ?? '127.0.0.1';
  if (host !== 'localhost' && !isIP(host))
    throw new Error('NOD_HOST must be an IP address or localhost.');
  const address =
    environment.NOD_PUBLIC_URL ?? `http://${desktop ? '127.0.0.1' : 'localhost'}:${port}`;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error('NOD_PUBLIC_URL must be an HTTP or HTTPS origin.');
  }
  const local = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    (address !== url.origin && address !== `${url.origin}/`) ||
    (url.protocol !== 'https:' && !local.has(url.hostname))
  )
    throw new Error('NOD_PUBLIC_URL must be an HTTPS origin, or HTTP on localhost.');
  const authToken = desktop ? undefined : environment.NOD_AUTH_TOKEN;
  if (authToken !== undefined && !/^[A-Za-z0-9_-]{43,}$/.test(authToken))
    throw new Error(
      'NOD_AUTH_TOKEN must contain at least 43 letters, digits, underscores or hyphens.',
    );
  if (!desktop && (!local.has(host) || !local.has(url.hostname)) && !authToken)
    throw new Error('Set NOD_AUTH_TOKEN before making Nod available beyond localhost.');
  return {
    port,
    host,
    publicOrigin: url.origin,
    authToken,
    accessOrigin: environment.NOD_PUBLIC_URL !== undefined || authToken ? url.origin : undefined,
  };
}
