import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquarePlus, X } from './icons';
import { BrandMark } from './brand';
import { Button } from './ui';

export function FeedbackLauncher({
  onFeedback,
  onDismissDiscovery,
}: {
  onFeedback(): void;
  onDismissDiscovery?(): void;
}) {
  const launcher = useRef<HTMLButtonElement>(null);
  const hint = useRef<HTMLElement>(null);
  const title = useId();
  const description = useId();
  const shown = !!onDismissDiscovery;
  const [position, setPosition] = useState<{ left: number; top: number; arrow: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    if (!shown || !launcher.current || !hint.current) return;
    const place = () => {
      if (!launcher.current || !hint.current) return;
      const bounds = launcher.current.getBoundingClientRect();
      const width = hint.current.offsetWidth;
      const left = Math.max(12, Math.min(bounds.right - width, window.innerWidth - width - 12));
      const next = {
        left,
        top: bounds.bottom + 6,
        arrow: Math.max(18, Math.min(bounds.left + bounds.width / 2 - left, width - 18)),
      };
      setPosition((current) =>
        current?.left === next.left && current.top === next.top && current.arrow === next.arrow
          ? current
          : next,
      );
    };
    const resize = new ResizeObserver(place);
    resize.observe(launcher.current);
    resize.observe(hint.current);
    const header = launcher.current.closest('header');
    if (header) resize.observe(header);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    place();
    return () => {
      resize.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [shown]);

  useEffect(() => {
    if (!onDismissDiscovery) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      if (
        !hint.current?.contains(document.activeElement) &&
        document.activeElement !== launcher.current
      )
        return;
      if (!hint.current?.getClientRects().length) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]')) return;
      if (hint.current?.contains(document.activeElement))
        launcher.current?.focus({ preventScroll: true });
      onDismissDiscovery();
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [onDismissDiscovery]);

  return (
    <>
      <Button
        ref={launcher}
        id="feedback-launcher"
        type="button"
        variant="ghost"
        size="sm"
        className="chat-report-button"
        aria-describedby={shown ? description : undefined}
        data-discovery={shown || undefined}
        onClick={onFeedback}
      >
        <MessageSquarePlus size={16} aria-hidden="true" />
        Send feedback
      </Button>
      {onDismissDiscovery &&
        createPortal(
          <aside
            ref={hint}
            aria-labelledby={title}
            className="feedback-discovery-hint"
            style={
              {
                left: position?.left ?? 0,
                top: position?.top ?? 0,
                '--hint-arrow': `${position?.arrow ?? 18}px`,
                visibility: position ? 'visible' : 'hidden',
              } as CSSProperties
            }
          >
            <div className="feedback-discovery-heading">
              <BrandMark small />
              <h2 id={title}>Help shape nod</h2>
            </div>
            <p id={description}>
              Tell us what’s working, what went wrong, or what you’d like to see. We read every
              message.
            </p>
            <button
              type="button"
              className="feedback-discovery-dismiss"
              aria-label="Dismiss feedback hint"
              onClick={() => {
                onDismissDiscovery();
                launcher.current?.focus({ preventScroll: true });
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </aside>,
          document.body,
        )}
    </>
  );
}
