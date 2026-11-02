import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { post } from '../lib/api';
import { safeMessageLink } from '../lib/message-links';
import { ArrowUpRight } from './icons';

function opened(url: string, source: 'text' | 'tooltip') {
  void post('/api/link-preview/opened', { url, source }).catch(() => undefined);
}

function externalAnchor(target: EventTarget | null) {
  const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null;
  const url = anchor?.getAttribute('href') ?? '';
  const link = safeMessageLink(url, window.location.origin);
  return anchor && link?.kind === 'external' ? { anchor, url } : null;
}

export function MessageLinkTooltip({
  content,
  text,
}: {
  content: RefObject<HTMLDivElement | null>;
  text: string;
}) {
  const [tip, setTip] = useState<{
    url: string;
    anchor: HTMLAnchorElement;
    x: number;
    y: number;
    below: boolean;
  } | null>(null);
  const tipElement = useRef<HTMLAnchorElement>(null);
  const tipId = useId();

  useLayoutEffect(() => {
    const tooltip = tipElement.current;
    if (!tip || !tooltip) return;
    if (!content.current?.contains(tip.anchor) || tip.anchor.getAttribute('href') !== tip.url) {
      setTip(null);
      return;
    }
    const { width, height } = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(tip.x, window.innerWidth - width - 8))}px`;
    const top = tip.below ? tip.y : tip.y - height;
    tooltip.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8)) + (tip.below ? 0 : height)}px`;
    const descriptions =
      tip.anchor.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? [];
    tip.anchor.setAttribute('aria-describedby', [...new Set([...descriptions, tipId])].join(' '));
    return () => {
      const remaining = tip.anchor
        .getAttribute('aria-describedby')
        ?.split(/\s+/)
        .filter((value) => value && value !== tipId);
      if (remaining?.length) tip.anchor.setAttribute('aria-describedby', remaining.join(' '));
      else tip.anchor.removeAttribute('aria-describedby');
    };
  }, [content, text, tip, tipId]);

  useEffect(() => {
    const target = content.current;
    if (!target) return;
    let timer: number | undefined;
    const show = (event: Event) => {
      if (event.type === 'pointerover' && (event as PointerEvent).pointerType !== 'mouse') return;
      const link = externalAnchor(event.target);
      if (!link || (event.type === 'focusin' && !link.anchor.matches(':focus-visible'))) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => {
          if (!target.contains(link.anchor) || link.anchor.getAttribute('href') !== link.url)
            return;
          const rect = link.anchor.getBoundingClientRect();
          const below = rect.top < 72;
          setTip({
            ...link,
            x: rect.left,
            y: below ? rect.bottom + 6 : rect.top - 6,
            below,
          });
        },
        event.type === 'focusin' ? 0 : 100,
      );
    };
    const hide = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        setTip(null);
      }, 250);
    };
    const leave = (event: Event) => {
      if (externalAnchor(event.target)) hide();
    };
    const click = (event: Event) => {
      const link = externalAnchor(event.target);
      if (link) opened(link.url, 'text');
      dismiss();
    };
    const keep = () => window.clearTimeout(timer);
    const tooltip = tipElement.current;
    const dismiss = () => {
      window.clearTimeout(timer);
      setTip(null);
    };
    const pointerdown = () => dismiss();
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !tip) return;
      if (document.activeElement === tooltip) tip.anchor.focus();
      dismiss();
    };
    const moved = (event: Event) => {
      if (!tooltip?.contains(event.target as Node)) dismiss();
    };
    target.addEventListener('pointerover', show);
    target.addEventListener('pointerdown', pointerdown);
    target.addEventListener('pointerout', leave);
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
      target.removeEventListener('pointerover', show);
      target.removeEventListener('pointerdown', pointerdown);
      target.removeEventListener('pointerout', leave);
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

  return (
    <>
      {tip &&
        createPortal(
          <a
            ref={tipElement}
            id={tipId}
            data-analytics-private
            tabIndex={-1}
            className={`tooltip-surface message-link-tooltip${tip.below ? ' message-link-tooltip-below' : ''}`}
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
            <ArrowUpRight size={14} />
          </a>,
          document.body,
        )}
    </>
  );
}
