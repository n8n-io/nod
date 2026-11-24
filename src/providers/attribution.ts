import { getIdentityHeaders, type ClientIdentity } from '@earendil-works/pi-ai';

const app = { name: 'nod', url: 'https://nod.n8n.io' };

export const nodIdentity: ClientIdentity = {
  userAgent: { custom: app.name },
  attribution: { ...app, categories: ['personal-agent'] },
};

export const nodFetch: typeof fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const identity = {
    ...getIdentityHeaders({ provider: '', baseUrl: url }, nodIdentity),
    ...(URL.parse(url)?.hostname === 'ai-gateway.vercel.sh'
      ? { 'http-referer': app.url, 'x-title': app.name }
      : {}),
  };
  for (const [name, value] of Object.entries(identity))
    if (!headers.has(name)) headers.set(name, value);
  return fetch(input, { ...init, headers });
};
