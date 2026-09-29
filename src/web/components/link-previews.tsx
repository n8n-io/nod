import { useEffect, useState, type RefObject } from 'react';
import type { LinkPreview } from '../../shared/link-preview';
import { previewableUrl } from '../../shared/link-preview';
import { safeMessageLink } from '../lib/message-links';
import { loadLinkPreview } from '../lib/link-previews';

export function MessageLinkPreviews({
  content,
  text,
}: {
  content: RefObject<HTMLDivElement | null>;
  text: string;
}) {
  const [previews, setPreviews] = useState<LinkPreview[]>([]);
  useEffect(() => {
    let current = true;
    const links = [...(content.current?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? [])].map(
      (anchor) => safeMessageLink(anchor.getAttribute('href') ?? '', window.location.origin),
    );
    const urls =
      links.some((link) => link?.kind === 'setup') || content.current?.querySelector('[data-setup]')
        ? []
        : [
            ...new Set(
              links.flatMap((link) => {
                const url = link?.kind === 'external' ? previewableUrl(link.href) : null;
                return url ? [url] : [];
              }),
            ),
          ].slice(0, 2);
    setPreviews((previous) => (previous.length ? [] : previous));
    const load = () => {
      if (!current || !urls.length) return;
      void Promise.all(urls.map(loadLinkPreview)).then((values) => {
        if (current) setPreviews(values.filter((value): value is LinkPreview => value !== null));
      });
    };
    const target = content.current;
    let observer: IntersectionObserver | undefined;
    if (urls.length && target && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          observer?.disconnect();
          load();
        },
        { rootMargin: '300px' },
      );
      observer.observe(target);
    } else load();
    return () => {
      current = false;
      observer?.disconnect();
    };
  }, [content, text]);
  if (!previews.length) return null;
  return (
    <div className="message-link-previews">
      {previews.map((preview) => (
        <a
          className="message-link-preview"
          href={preview.url}
          target="_blank"
          rel="noopener noreferrer"
          key={preview.url}
        >
          <div className="message-link-preview-copy">
            <small>{preview.siteName || new URL(preview.url).hostname}</small>
            <strong>{preview.title}</strong>
            {preview.description && <span>{preview.description}</span>}
          </div>
          {preview.imageUrl && (
            <img
              src={preview.imageUrl}
              alt=""
              loading="lazy"
              onError={(event) => {
                event.currentTarget.hidden = true;
              }}
            />
          )}
        </a>
      ))}
    </div>
  );
}
