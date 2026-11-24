import { getIdentityHeaders, type ClientIdentity } from '@earendil-works/pi-ai';

export const nodIdentity: ClientIdentity = {
  userAgent: { custom: 'nod' },
  attribution: { name: 'nod', url: 'https://nod.n8n.io', categories: ['personal-agent'] },
};

export const nodHeaders = (provider: string, baseUrl: string) =>
  getIdentityHeaders({ provider, baseUrl }, nodIdentity);
