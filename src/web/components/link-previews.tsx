import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { LinkPreview } from '../../shared/link-preview';
import { previewableUrl } from '../../shared/link-preview';
import { post } from '../lib/api';
import { safeMessageLink } from '../lib/message-links';
import { loadLinkPreview } from '../lib/link-previews';

type Source = 'text' | 'preview' | 'tooltip' | 'player';
type Link = { url: string; page: string; label: string };
type Row = LinkPreview & Link & { position: number };

const shownRows = 5;

function autoplay(value: string) {
  const url = new URL(value);
  url.searchParams.set('autoplay', '1');
  return url.href;
}

function opened(url: string, source: Source, position?: number) {
  void post('/api/link-preview/opened', {
    url,
    source,
    ...(position ? { position } : {}),
  }).catch(() => undefined);
}

function externalAnchor(target: EventTarget | null) {
  const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null;
  const url = anchor?.getAttribute('href') ?? '';
  const link = safeMessageLink(url, window.location.origin);
  return anchor && link?.kind === 'external' ? { anchor, url } : null;
}

function messageLinks(content: HTMLDivElement | null): Link[] {
  if (!content || content.querySelector('[data-setup]')) return [];
  const links = new Map<string, Link>();
  for (const anchor of content.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const url = anchor.getAttribute('href') ?? '';
    const link = safeMessageLink(url, window.location.origin);
    if (link?.kind === 'setup') return [];
    const page = link?.kind === 'external' ? previewableUrl(url) : null;
    if (page && !links.has(page))
      links.set(page, {
        url,
        page,
        label: anchor.textContent?.trim().replace(/\s+/g, ' ') || url,
      });
  }
  return [...links.values()];
}

function PreviewRow({
  row,
  active,
  onImageError,
}: {
  row: Row;
  active: boolean;
  onImageError: (url: string) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const copy = (
    <span className="message-link-preview-copy">
      <strong>{row.label}</strong>
      {row.title && row.title !== row.label && <span>{row.title}</span>}
      <small>{row.url}</small>
    </span>
  );
  const image = (
    <span className="message-link-preview-image">
      <img src={row.imageUrl} alt="" loading="lazy" onError={() => onImageError(row.url)} />
    </span>
  );
  const className = `message-link-preview${active ? ' message-link-preview-active' : ''}`;
  if (!row.playerUrl)
    return (
      <a
        className={className}
        href={row.url}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        data-url={row.page}
        onClick={() => opened(row.url, 'preview', row.position)}
      >
        {image}
        {copy}
      </a>
    );
  return (
    <div
      className={`${className} message-link-preview-video${playing ? ' message-link-preview-playing' : ''}`}
      data-url={row.page}
    >
      {playing ? (
        <span className="message-link-preview-player">
          <iframe
            src={autoplay(row.playerUrl)}
            title={row.title ?? row.label}
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            {...{ credentialless: 'true' }}
          />
        </span>
      ) : (
        <button
          type="button"
          className="message-link-preview-play"
          aria-label={`Play ${row.label}`}
          onClick={() => {
            setPlaying(true);
            opened(row.url, 'player', row.position);
          }}
        >
          {image}
          <span className="message-link-preview-play-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
            </svg>
          </span>
        </button>
      )}
      <a
        className="message-link-preview-link"
        href={row.url}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        onClick={() => opened(row.url, 'preview', row.position)}
      >
        {copy}
      </a>
    </div>
  );
}

export function MessageLinkPreviews({
  content,
  text,
}: {
  content: RefObject<HTMLDivElement | null>;
  text: string;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [tip, setTip] = useState<{
    url: string;
    anchor: HTMLAnchorElement;
    x: number;
    y: number;
    below: boolean;
  } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const tipElement = useRef<HTMLAnchorElement>(null);
  const tipId = useId();
  const retry = useRef<(url: string) => void>(() => undefined);

  useEffect(() => {
    let current = true;
    const links = messageLinks(content.current);
    setRows((previous) => (previous.length ? [] : previous));
    setExpanded(false);
    const load = () => {
      if (!current || !links.length) return;
      const found = new Map<number, LinkPreview & Link>();
      const retried = new Set<string>();
      const show = () =>
        setRows(
          [...found]
            .sort(([a], [b]) => a - b)
            .map(([, row], position) => ({ ...row, position: position + 1 })),
        );
      const fetch = (index: number, fresh = false) => {
        const link = links[index];
        const previous = found.get(index)?.imageUrl;
        void loadLinkPreview(link.url, fresh).then((value) => {
          if (!current) return;
          if (value && value.imageUrl !== previous) found.set(index, { ...value, ...link });
          else found.delete(index);
          show();
        });
      };
      retry.current = (url) => {
        const index = links.findIndex((link) => link.url === url);
        if (index < 0) return;
        if (retried.has(url)) {
          found.delete(index);
          show();
        } else {
          retried.add(url);
          fetch(index, true);
        }
      };
      links.forEach((_, index) => fetch(index));
    };
    const target = content.current;
    let observer: IntersectionObserver | undefined;
    if (links.length && target && typeof IntersectionObserver !== 'undefined') {
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

  useLayoutEffect(() => {
    const tooltip = tipElement.current;
    if (!tip || !tooltip) return;
    const { width, height } = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(tip.x, window.innerWidth - width - 8))}px`;
    const top = tip.below ? tip.y : tip.y - height;
    tooltip.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8)) + (tip.below ? 0 : height)}px`;
    tip.anchor.setAttribute('aria-describedby', tipId);
    return () => tip.anchor.removeAttribute('aria-describedby');
  }, [tip, tipId]);

  useEffect(() => {
    const target = content.current;
    if (!target) return;
    let timer: number | undefined;
    const show = (event: Event) => {
      const link = externalAnchor(event.target);
      if (!link) return;
      window.clearTimeout(timer);
      setActive(previewableUrl(link.url));
      timer = window.setTimeout(() => {
        const rect = link.anchor.getBoundingClientRect();
        const below = rect.top < 72;
        setTip({
          ...link,
          x: rect.left,
          y: below ? rect.bottom + 6 : rect.top - 6,
          below,
        });
      }, 150);
    };
    const hide = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        setTip(null);
        setActive(null);
      }, 250);
    };
    const leave = (event: Event) => {
      if (externalAnchor(event.target)) hide();
    };
    const click = (event: Event) => {
      const link = externalAnchor(event.target);
      if (link) opened(link.url, 'text');
    };
    const keep = () => window.clearTimeout(timer);
    const tooltip = tipElement.current;
    const dismiss = () => {
      window.clearTimeout(timer);
      setTip(null);
      setActive(null);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !tip) return;
      if (document.activeElement === tooltip) tip.anchor.focus();
      dismiss();
    };
    const moved = (event: Event) => {
      if (!tooltip?.contains(event.target as Node)) dismiss();
    };
    target.addEventListener('mouseover', show);
    target.addEventListener('mouseout', leave);
    target.addEventListener('focusin', show);
    target.addEventListener('focusout', leave);
    target.addEventListener('click', click);
    tooltip?.addEventListener('mouseenter', keep);
    tooltip?.addEventListener('mouseleave', hide);
    tooltip?.addEventListener('focusin', keep);
    tooltip?.addEventListener('focusout', hide);
    if (tip) {
      document.addEventListener('keydown', keydown);
      document.addEventListener('scroll', moved, true);
      window.addEventListener('resize', dismiss);
    }
    return () => {
      window.clearTimeout(timer);
      target.removeEventListener('mouseover', show);
      target.removeEventListener('mouseout', leave);
      target.removeEventListener('focusin', show);
      target.removeEventListener('focusout', leave);
      target.removeEventListener('click', click);
      tooltip?.removeEventListener('mouseenter', keep);
      tooltip?.removeEventListener('mouseleave', hide);
      tooltip?.removeEventListener('focusin', keep);
      tooltip?.removeEventListener('focusout', hide);
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [content, text, tip]);

  useEffect(() => {
    const target = list.current;
    const anchors = () =>
      [...(content.current?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? [])].map(
        (anchor) => ({ anchor, url: externalAnchor(anchor)?.url }),
      );
    if (!target) return;
    const over = (event: Event) => {
      const url = (event.target as Element).closest<HTMLElement>('[data-url]')?.dataset.url;
      for (const item of anchors())
        item.anchor.classList.toggle(
          'message-link-highlight',
          Boolean(url && item.url && previewableUrl(item.url) === url),
        );
    };
    const leave = () => {
      for (const item of anchors()) item.anchor.classList.remove('message-link-highlight');
    };
    target.addEventListener('mouseover', over);
    target.addEventListener('mouseleave', leave);
    target.addEventListener('focusin', over);
    target.addEventListener('focusout', leave);
    return () => {
      target.removeEventListener('mouseover', over);
      target.removeEventListener('mouseleave', leave);
      target.removeEventListener('focusin', over);
      target.removeEventListener('focusout', leave);
      leave();
    };
  }, [content, rows]);

  const visible = expanded ? rows : rows.slice(0, shownRows);
  return (
    <>
      {rows.length > 0 && (
        <div className="message-link-previews" ref={list}>
          {visible.map((row) => (
            <PreviewRow
              key={row.url}
              row={row}
              active={active === row.page}
              onImageError={(url) => retry.current(url)}
            />
          ))}
          {rows.length > shownRows && !expanded && (
            <button
              type="button"
              className="message-link-previews-more"
              onClick={() => setExpanded(true)}
            >
              Show {rows.length - shownRows} more
            </button>
          )}
        </div>
      )}
      {tip &&
        createPortal(
          <a
            ref={tipElement}
            id={tipId}
            tabIndex={-1}
            className={`message-link-tooltip${tip.below ? ' message-link-tooltip-below' : ''}`}
            href={tip.url}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            style={{
              left: tip.x,
              top: tip.y,
              transform: tip.below ? undefined : 'translateY(-100%)',
            }}
            onClick={() => opened(tip.url, 'tooltip')}
          >
            <span>{tip.url}</span>
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path
                d="M6 3h7v7M13 3 4 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </a>,
          document.body,
        )}
    </>
  );
}
