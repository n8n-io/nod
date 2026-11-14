import type { FastifyInstance } from 'fastify';
import { clientCapabilities } from '../shared/client-api.ts';

export function registerClientApi(app: FastifyInstance) {
  app.get('/api/client/capabilities', async (request, reply) => {
    if (!/^Bearer [^\s]+$/i.test(request.headers.authorization ?? ''))
      return reply.code(401).send({ error: 'Enter your server authentication token.' });
    return clientCapabilities;
  });
}
