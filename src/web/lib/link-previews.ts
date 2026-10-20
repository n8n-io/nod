import {
  previewableUrl,
  publicMediaUrl,
  type LinkPreview,
  type LinkPreviewResponse,
} from '../../shared/link-preview';
import { post, requestAccountVersion } from './api';

const previews = new Map<string, { expiresAt: number; value: LinkPreview }>();
const pending = new Map<string, Promise<LinkPreview | null>>();
const queue: Array<() => void> = [];
let active = 0;
let accountVersion = requestAccountVersion();

async function fetchPreview(url: string, version: number) {
  if (active >= 4) await new Promise<void>((resolve) => queue.push(resolve));
  else active++;
  try {
    if (version !== requestAccountVersion()) return { preview: null };
    return await post<LinkPreviewResponse>('/api/link-preview', { url });
  } finally {
    const next = queue.shift();
    if (next) next();
    else active--;
  }
}

export function previewImageUrl(value?: string) {
  return value &&
    /^\/api\/link-preview\/image\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value
    : undefined;
}

export function loadLinkPreview(value: string, fresh = false): Promise<LinkPreview | null> {
  const url = previewableUrl(value);
  if (!url) return Promise.resolve(null);
  const version = requestAccountVersion();
  if (version !== accountVersion) {
    previews.clear();
    pending.clear();
    accountVersion = version;
  }
  if (fresh) previews.delete(url);
  const existing = previews.get(url);
  if (existing && existing.expiresAt > Date.now()) return Promise.resolve(existing.value);
  if (pending.has(url)) return pending.get(url)!;
  previews.delete(url);
  const request = fetchPreview(url, version)
    .then(({ preview }) => {
      const destination = preview && previewableUrl(preview.url);
      const imageUrl = previewImageUrl(preview?.imageUrl);
      if (!preview || !destination || !imageUrl) return null;
      const playerUrl =
        typeof preview.playerUrl === 'string' ? publicMediaUrl(preview.playerUrl) : null;
      return {
        url: destination,
        imageUrl,
        ...(typeof preview.title === 'string' && preview.title.trim()
          ? { title: preview.title }
          : {}),
        ...(typeof preview.description === 'string' ? { description: preview.description } : {}),
        ...(typeof preview.siteName === 'string' ? { siteName: preview.siteName } : {}),
        ...(playerUrl?.startsWith('https:') ? { playerUrl } : {}),
      };
    })
    .catch(() => null)
    .then((preview) => {
      if (pending.get(url) === request) pending.delete(url);
      if (version !== requestAccountVersion()) return null;
      if (preview) previews.set(url, { expiresAt: Date.now() + 5 * 60_000, value: preview });
      while (previews.size > 64) previews.delete(previews.keys().next().value!);
      return preview;
    });
  pending.set(url, request);
  return request;
}
