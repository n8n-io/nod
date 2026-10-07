import { useEffect, useId, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { MessageSquarePlus } from 'lucide-react';
import { readUiPreference, writeUiPreference } from '../lib/ui-preferences';
import { Button } from './ui';

export function FeedbackLauncher({
  ownerId,
  visible,
  onFeedback,
}: {
  ownerId: string;
  visible: boolean;
  onFeedback(): void;
}) {
  const preference = `otto.feedback.intro.${ownerId}` as const;
  const [dismissed, setDismissed] = useState(() => readUiPreference(preference) === 'dismissed');
  const [ready, setReady] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const intro = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const contentId = useId();
  const open = visible && ready && !dismissed;

  useEffect(() => {
    if (!visible || dismissed) return;
    const timer = window.setTimeout(() => setReady(true), 900);
    return () => window.clearTimeout(timer);
  }, [visible, dismissed]);

  function dismiss(restoreFocus = false) {
    writeUiPreference(preference, 'dismissed');
    setDismissed(true);
    if (restoreFocus) launcher.current?.focus();
  }

  function sendFeedback() {
    dismiss(true);
    onFeedback();
  }

  return (
    <Popover.Root open={open} onOpenChange={(open) => !open && dismiss()}>
      <Popover.Anchor asChild>
        <Button asChild variant="ghost" size="sm" className="chat-report-button">
          <button
            ref={launcher}
            id="feedback-launcher"
            type="button"
            data-feedback-intro={open || undefined}
            aria-controls={open ? contentId : undefined}
            aria-describedby={open ? descriptionId : undefined}
            aria-expanded={open}
            onClick={sendFeedback}
            onKeyDown={(event) => {
              if (!open || (event.key !== 'ArrowDown' && (event.key !== 'Tab' || event.shiftKey)))
                return;
              event.preventDefault();
              intro.current?.querySelector('button')?.focus();
            }}
          >
            <MessageSquarePlus size={16} aria-hidden="true" />
            Send feedback
          </button>
        </Button>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          ref={intro}
          id={contentId}
          className="feedback-intro"
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onFocusOutside={(event) => {
            if (launcher.current?.contains(event.target as Node)) event.preventDefault();
          }}
          onEscapeKeyDown={() => dismiss(intro.current?.contains(document.activeElement))}
        >
          <div className="feedback-intro-body">
            <h2 id={titleId}>Help shape Otto</h2>
            <p id={descriptionId} aria-live="polite">
              Use this button to share feedback, report an issue, or suggest an idea.
            </p>
            <div className="feedback-intro-actions">
              <Button type="button" variant="ghost" onClick={() => dismiss(true)}>
                Got it
              </Button>
              <Button type="button" onClick={sendFeedback}>
                Send feedback
              </Button>
            </div>
          </div>
          <Popover.Arrow className="feedback-intro-arrow" width={14} height={7} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
