import {
  previewableUrl,
  publicMediaUrl,
  type LinkPreview,
  type LinkPreviewResponse,
} from '../../shared/link-preview';
import { post } from './api';

const previews = new Map<string, { expiresAt: number; value: Promise<LinkPreview | null> }>();

export function previewImageUrl(value?: string) {
  return value &&
    /^\/api\/link-preview\/image\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value
    : undefined;
}

export function loadLinkPreview(value: string): Promise<LinkPreview | null> {
  const url = previewableUrl(value);
  if (!url) return Promise.resolve(null);
  const existing = previews.get(url);
  if (existing && existing.expiresAt > Date.now()) return existing.value;
  const request = post<LinkPreviewResponse>('/api/link-preview', { url })
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
    .catch(() => null);
  previews.delete(url);
  previews.set(url, { expiresAt: Date.now() + 5 * 60_000, value: request });
  void request.then((preview) => {
    if (!preview && previews.get(url)?.value === request) previews.delete(url);
  });
  while (previews.size > 64) previews.delete(previews.keys().next().value!);
  return request;
}
