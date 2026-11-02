import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { Slot } from '@radix-ui/react-slot';

let dismissActive: (() => void) | undefined;
const forcedHints = new Set<string>();

export interface TooltipProps {
  content?: string;
  shortcut?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  delay?: number;
  forceOpen?: boolean;
  children: ReactElement;
}

export function Tooltip({
  content,
  shortcut,
  side = 'top',
  delay = 100,
  forceOpen = false,
  children,
}: TooltipProps) {
  const id = useId();
  const anchor = useRef<HTMLElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hovered = useRef(false);
  const panelHovered = useRef(false);
  const dismissed = useRef(false);
  const [open, setOpen] = useState(false);
  const visible = forceOpen || open;
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    panelHovered.current = false;
    setOpen(false);
  }, []);
  useLayoutEffect(() => {
    if (!forceOpen) return;
    forcedHints.add(id);
    dismissActive?.();
    dismissActive = undefined;
    return () => {
      forcedHints.delete(id);
    };
  }, [forceOpen, id]);
  function dismiss() {
    dismissed.current = true;
    hide();
  }
  function hasKeyboardFocus() {
    const focused = document.activeElement;
    return Boolean(
      focused instanceof Element &&
      focused.matches(':focus-visible') &&
      anchor.current?.contains(focused) &&
      focused.closest('[data-tooltip-trigger]') === anchor.current,
    );
  }
  function show(wait: number) {
    clearTimeout(timer.current);
    if (!content || dismissed.current || (forcedHints.size && !forceOpen)) return;
    timer.current = setTimeout(() => {
      if (forcedHints.size && !forceOpen) return;
      const element = anchor.current;
      if (
        !element?.isConnected ||
        !element.getClientRects().length ||
        (!element.matches(':hover') && !hasKeyboardFocus())
      )
        return;
      const bounds = element.getBoundingClientRect();
      if (
        bounds.bottom <= 0 ||
        bounds.top >= innerHeight ||
        bounds.right <= 0 ||
        bounds.left >= innerWidth
      )
        return;
      dismissActive?.();
      dismissActive = hide;
      setOpen(true);
    }, wait);
  }
  function leave() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!hovered.current && !panelHovered.current && !hasKeyboardFocus()) hide();
    }, 120);
  }
  useEffect(() => {
    if (!content) hide();
  }, [content, hide]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (dismissActive === hide) dismissActive = undefined;
    },
    [hide],
  );
  useEffect(() => {
    if (!visible) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) hide();
    };
    document.addEventListener('keydown', escape, true);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
      if (dismissActive === hide) dismissActive = undefined;
    };
  }, [visible, hide]);
  useLayoutEffect(() => {
    const trigger = anchor.current;
    const element = panel.current;
    if (!visible || !trigger || !element) return;
    let frame = 0;
    let disposed = false;
    let observed: DOMRect | undefined;
    let movement: IntersectionObserver | undefined;
    const schedule = () => {
      if (disposed || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    const place = () => {
      if (!trigger.isConnected || !trigger.getClientRects().length) {
        hide();
        return;
      }
      const bounds = trigger.getBoundingClientRect();
      const { width, height } = element.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const gap = 8;
      const locations = {
        top: { x: bounds.left + (bounds.width - width) / 2, y: bounds.top - height - gap },
        right: { x: bounds.right + gap, y: bounds.top + (bounds.height - height) / 2 },
        bottom: { x: bounds.left + (bounds.width - width) / 2, y: bounds.bottom + gap },
        left: { x: bounds.left - width - gap, y: bounds.top + (bounds.height - height) / 2 },
      };
      const opposite = { top: 'bottom', right: 'left', bottom: 'top', left: 'right' } as const;
      const preferred = [side, opposite[side]];
      const selected = preferred.find((position) => {
        const point = locations[position];
        return position === 'top' || position === 'bottom'
          ? point.y >= gap && point.y + height <= viewportHeight - gap
          : point.x >= gap && point.x + width <= viewportWidth - gap;
      });
      const position = selected ?? side;
      const point = locations[position];
      const left = `${Math.max(gap, Math.min(point.x, viewportWidth - width - gap))}px`;
      const top = `${Math.max(gap, Math.min(point.y, viewportHeight - height - gap))}px`;
      if (element.style.left !== left) element.style.left = left;
      if (element.style.top !== top) element.style.top = top;
      element.style.visibility = 'visible';
      element.dataset.side = position;
      if (
        typeof IntersectionObserver !== 'undefined' &&
        (!observed ||
          bounds.left !== observed.left ||
          bounds.top !== observed.top ||
          bounds.width !== observed.width ||
          bounds.height !== observed.height)
      ) {
        observed = bounds;
        movement?.disconnect();
        const width = document.documentElement.clientWidth || window.innerWidth;
        const height = document.documentElement.clientHeight || window.innerHeight;
        const margins = [bounds.top, width - bounds.right, height - bounds.bottom, bounds.left];
        movement = new IntersectionObserver(
          ([entry]) => {
            if (
              entry &&
              (entry.boundingClientRect.left !== bounds.left ||
                entry.boundingClientRect.top !== bounds.top ||
                entry.boundingClientRect.width !== bounds.width ||
                entry.boundingClientRect.height !== bounds.height)
            )
              schedule();
          },
          { rootMargin: margins.map((value) => `${-Math.floor(value)}px`).join(' '), threshold: 1 },
        );
        movement.observe(trigger);
      }
    };
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : undefined;
    resize?.observe(trigger);
    resize?.observe(element);
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    place();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      movement?.disconnect();
      resize?.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
    };
  }, [visible, content, shortcut, side, hide]);
  const child = children as ReactElement<{ title?: string; 'aria-describedby'?: string }>;
  const description = [child.props['aria-describedby'], visible && content ? id : undefined]
    .filter(Boolean)
    .join(' ');
  return (
    <>
      <Slot
        ref={anchor}
        aria-describedby={description || undefined}
        data-tooltip-trigger={content ? id : undefined}
        onPointerEnter={(event) => {
          if (
            event.pointerType !== 'mouse' ||
            (event.target instanceof Element &&
              event.target.closest('[data-tooltip-trigger]') !== anchor.current)
          )
            return;
          hovered.current = true;
          dismissed.current = false;
          show(delay);
        }}
        onPointerLeave={() => {
          hovered.current = false;
          dismissed.current = false;
          leave();
        }}
        onPointerDown={dismiss}
        onPointerCancel={dismiss}
        onFocus={() => {
          if (!hasKeyboardFocus()) return;
          dismissed.current = false;
          show(0);
        }}
        onBlur={() => {
          dismissed.current = false;
          hide();
        }}
        onKeyDown={(event) => {
          if (['Escape', 'Enter', ' ', 'Tab'].includes(event.key)) dismiss();
        }}
        onClick={dismiss}
      >
        {cloneElement(child, { title: undefined, 'aria-describedby': description || undefined })}
      </Slot>
      {visible &&
        content &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="tooltip"
            className="tooltip-surface tooltip"
            data-analytics-private
            style={{ visibility: 'hidden' }}
            onPointerEnter={(event) => {
              if (event.pointerType !== 'mouse') return;
              panelHovered.current = true;
              clearTimeout(timer.current);
            }}
            onPointerLeave={() => {
              panelHovered.current = false;
              leave();
            }}
          >
            <span className="tooltip-label">{content}</span>
            {shortcut && <kbd>{shortcut}</kbd>}
          </div>,
          document.body,
        )}
    </>
  );
}
