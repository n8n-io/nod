import type { FastifyInstance } from 'fastify';

export function registerClientApi(app: FastifyInstance, bearer: boolean) {
  if (!bearer) return;
  app.get('/api/client/capabilities', async (request, reply) => {
    if (!/^Bearer [^\s]+$/i.test(request.headers.authorization ?? ''))
      return reply.code(401).send({ error: 'Enter your server authentication token.' });
    return {
      contractVersion: 1,
      authentication: { mode: 'bearer' },
      features: { attachments: true },
    };
  });
}
