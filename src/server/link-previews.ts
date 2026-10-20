import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LinkPreviewProvider, PreviewImage, SiteIcon } from '../ports/link-preview.ts';
import { previewableUrl, publicMediaUrl, type LinkPreview } from '../shared/link-preview.ts';

type CachedPreview = { expiresAt: number; preview: LinkPreview | null; imageId?: string };
type CachedImage = {
  expiresAt: number;
  url: string;
  value?: PreviewImage | null;
  pending?: Promise<PreviewImage | null>;
};

export function createLinkPreviews(
  provider: LinkPreviewProvider,
  options: { now?: () => number } = {},
) {
  const now = options.now ?? Date.now;
  const previews = new Map<string, CachedPreview>();
  const images = new Map<string, CachedImage>();
  const pending = new Map<string, Promise<LinkPreview | null>>();
  let active = 0;
  const queue: Array<() => void> = [];
  async function run<T>(action: () => Promise<T>): Promise<T | null> {
    if (active >= 4) {
      if (queue.length >= 96) throw new Error('Link previews are busy.');
      await new Promise<void>((resolve) => queue.push(resolve));
    } else active++;
    try {
      return await action();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  }
  function prune() {
    for (const [key, entry] of previews) {
      if (entry.expiresAt <= now()) {
        previews.delete(key);
        if (entry.imageId) images.delete(entry.imageId);
      }
    }
    for (const [key, entry] of images) if (entry.expiresAt <= now()) images.delete(key);
    while (previews.size > 128) {
      const key = previews.keys().next().value!;
      const entry = previews.get(key)!;
      previews.delete(key);
      if (entry.imageId) images.delete(entry.imageId);
    }
    while (images.size > 128) {
      const imageId = images.keys().next().value!;
      images.delete(imageId);
      for (const [url, entry] of previews) if (entry.imageId === imageId) previews.delete(url);
    }
    let bytes = 0;
    for (const entry of images.values()) bytes += entry.value?.bytes.byteLength ?? 0;
    for (const entry of images.values()) {
      if (bytes <= 32 * 1024 * 1024) break;
      if (!entry.value) continue;
      bytes -= entry.value.bytes.byteLength;
      entry.value = undefined;
    }
  }
  function acceptable(value: PreviewImage) {
    return value.bytes.byteLength <= 5 * 1024 * 1024 &&
      ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value.mimeType)
      ? value
      : null;
  }
  async function preview(value: string): Promise<LinkPreview | null> {
    const url = previewableUrl(value);
    if (!url) return null;
    prune();
    const cached = previews.get(url);
    if (cached) {
      previews.delete(url);
      previews.set(url, cached);
      return cached.preview;
    }
    if (pending.has(url)) return pending.get(url)!;

    const work = (async () => {
      try {
        const fetched = await run(async () => {
          const metadata = await provider.metadata(url);
          const imageUrl = metadata?.image && publicMediaUrl(metadata.image);
          const picture = imageUrl ? await provider.image(imageUrl) : null;
          return { metadata, imageUrl, picture: picture && acceptable(picture) };
        });
        const result = fetched?.metadata;
        const finalUrl = result && previewableUrl(result.url);
        if (!result || !finalUrl || !fetched.imageUrl || !fetched.picture) {
          previews.set(url, { expiresAt: now() + 60000, preview: null });
          return null;
        }
        const expiresAt = now() + 600000;
        const imageId = randomUUID();
        images.set(imageId, { expiresAt, url: fetched.imageUrl, value: fetched.picture });
        const playerUrl = result.player && publicMediaUrl(result.player);
        const output: LinkPreview = {
          url: finalUrl,
          imageUrl: `/api/link-preview/image/${imageId}`,
          ...(result.title ? { title: result.title } : {}),
          ...(result.description ? { description: result.description } : {}),
          ...(result.siteName ? { siteName: result.siteName } : {}),
          ...(playerUrl?.startsWith('https:') ? { playerUrl } : {}),
        };
        previews.set(url, { expiresAt, preview: output, imageId });
        return output;
      } catch (error) {
        if (!(error instanceof Error && error.message === 'Link previews are busy.'))
          previews.set(url, { expiresAt: now() + 60000, preview: null });
        return null;
      } finally {
        prune();
        pending.delete(url);
      }
    })();
    pending.set(url, work);
    return work;
  }
  async function image(id: string): Promise<PreviewImage | null> {
    prune();
    const cached = images.get(id);
    if (!cached) return null;
    images.delete(id);
    images.set(id, cached);
    if (cached.value !== undefined) return cached.value;
    if (cached.pending) return cached.pending;
    cached.pending = run(() => provider.image(cached.url))
      .catch(() => null)
      .then((value) => {
        cached.value = value && acceptable(value);
        if (!cached.value) {
          images.delete(id);
          for (const [url, entry] of previews) if (entry.imageId === id) previews.delete(url);
        }
        return cached.value;
      })
      .finally(() => {
        cached.pending = undefined;
        prune();
      });
    return cached.pending;
  }
  function registerRoutes(app: FastifyInstance) {
    app.post('/api/link-preview', async (request) => {
      const input = z
        .object({ url: z.string().max(2048) })
        .strict()
        .parse(request.body);
      return { preview: await preview(input.url) };
    });
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
    app.get<{ Params: { id: string } }>('/api/link-preview/image/:id', async (request, reply) => {
      const id = z.uuid().safeParse(request.params.id);
      const value = id.success ? await image(id.data) : null;
      if (!value) return reply.code(404).send({ error: 'Preview image is unavailable.' });
      return reply
        .header('Content-Type', value.mimeType)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cache-Control', 'private, max-age=300')
        .header('Referrer-Policy', 'no-referrer')
        .send(Buffer.from(value.bytes));
    });
  }
  return { preview, image, registerRoutes };
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
