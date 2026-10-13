import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LinkPreviewProvider, PreviewImage, SiteIcon } from '../ports/link-preview.ts';
import { previewableUrl, type LinkPreview } from '../shared/link-preview.ts';

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
      if (queue.length >= 24) return null;
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
    while (images.size > 32) {
      const imageId = images.keys().next().value!;
      images.delete(imageId);
      for (const [url, entry] of previews) if (entry.imageId === imageId) previews.delete(url);
    }
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
        const result = await run(() => provider.metadata(url));
        const finalUrl = result && previewableUrl(result.url);
        if (!result || !finalUrl || !result.title.trim()) {
          previews.set(url, { expiresAt: now() + 60000, preview: null });
          return null;
        }
        const expiresAt = now() + 600000;
        const output: LinkPreview = {
          url: finalUrl,
          title: result.title.slice(0, 200),
          ...(result.description ? { description: result.description.slice(0, 400) } : {}),
          ...(result.siteName ? { siteName: result.siteName.slice(0, 100) } : {}),
        };
        const imageUrl = result.image && previewableUrl(result.image);
        const imageId = imageUrl ? randomUUID() : undefined;
        if (imageId && imageUrl) {
          images.set(imageId, { expiresAt, url: imageUrl });
          output.imageUrl = `/api/link-preview/image/${imageId}`;
        }
        previews.set(url, { expiresAt, preview: output, imageId });
        prune();
        return output;
      } catch {
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
    if (cached.value !== undefined) return cached.value;
    if (cached.pending) return cached.pending;
    cached.pending = run(() => provider.image(cached.url))
      .then((value) => {
        cached.value =
          value &&
          value.bytes.byteLength <= 1024 * 1024 &&
          ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value.mimeType)
            ? value
            : null;
        return cached.value;
      })
      .catch(() => {
        cached.value = null;
        return null;
      })
      .finally(() => {
        cached.pending = undefined;
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
