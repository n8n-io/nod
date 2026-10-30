import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SiteIcon } from '../ports/link-preview.ts';

export function registerLinkOpened(app: FastifyInstance) {
  app.post('/api/link-preview/opened', async (request, reply) => {
    z.object({
      url: z.string().max(2048),
      source: z.enum(['text', 'preview', 'tooltip', 'player']),
      position: z.number().int().min(1).max(100).optional(),
    })
      .strict()
      .parse(request.body);
    return reply.code(204).send();
  });
}

export function cachedIcons(fetchIcon: (origin: string) => Promise<SiteIcon | null>) {
  const icons = new Map<string, { expiresAt: number; value: Promise<SiteIcon | null> }>();
  return (origin: string) => {
    const cached = icons.get(origin);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    icons.delete(origin);
    const entry = {
      expiresAt: Date.now() + 86_400_000,
      value: fetchIcon(origin)
        .catch(() => null)
        .then((value) => {
          if (
            !value ||
            value.bytes.byteLength > 128 * 1024 ||
            !['image/png', 'image/jpeg', 'image/webp', 'image/x-icon'].includes(value.mimeType)
          ) {
            entry.expiresAt = Date.now() + 600_000;
            return null;
          }
          return value;
        }),
    };
    icons.set(origin, entry);
    while (icons.size > 128) icons.delete(icons.keys().next().value!);
    return entry.value;
  };
}
