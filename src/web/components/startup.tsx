import { useEffect, useState } from 'react';
import { ArrowUp, Paperclip } from './icons';
import { BrandMark } from './brand';
import { Skeleton } from './ui';
import { readUiPreference } from '../lib/ui-preferences';
import { desktopSettingsAvailable } from '../lib/desktop';

function useElapsed(afterMs: number) {
  const [passed, setPassed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setPassed(true), afterMs);
    return () => clearTimeout(timer);
  }, [afterMs]);
  return passed;
}

const ghostTurns = [
  { user: '46%', lines: ['94%', '88%', '61%'] },
  { user: '28%', lines: ['72%'] },
  { user: '36%', lines: ['90%', '83%', '86%', '42%'] },
];

export function ChatSkeleton({
  slowAfterMs = 3000,
  longAfterMs = 12_000,
}: {
  slowAfterMs?: number;
  longAfterMs?: number;
}) {
  const slow = useElapsed(slowAfterMs);
  const long = useElapsed(longAfterMs);
  const conversation = readUiPreference('nod.chat-layout') === 'conversation';
  return (
    <div className="chat-page chat-skeleton" aria-busy="true">
      {!desktopSettingsAvailable() && <div className="chat-report-action" aria-hidden="true" />}
      <div className="conversation-scroll">
        <div className="conversation-column" aria-hidden="true">
          {conversation ? (
            <div className="messages">
              {ghostTurns.flatMap((turn, index) => [
                <div key={`user-${index}`} className="message message-user">
                  <Skeleton className="ghost-bubble" style={{ width: turn.user }} />
                </div>,
                <div key={`assistant-${index}`} className="message message-assistant">
                  <div className="assistant-mark">
                    <BrandMark small />
                  </div>
                  <div className="skeleton-lines">
                    {turn.lines.map((width, line) => (
                      <Skeleton key={line} style={{ width }} />
                    ))}
                  </div>
                </div>,
              ])}
            </div>
          ) : (
            <div className="welcome ghost-welcome">
              <BrandMark />
              <h2>What’s on your mind?</h2>
            </div>
          )}
        </div>
      </div>
      <div className="chat-bottom conversation-column">
        <p className="skeleton-note" role="status">
          {long ? (
            <span key="long">Still working on it.</span>
          ) : slow ? (
            <span key="slow">Getting things ready…</span>
          ) : (
            <span className="sr-only">Opening nod…</span>
          )}
        </p>
        <div className="composer ghost-composer" aria-hidden="true">
          <p>Message nod…</p>
          <div className="composer-tools">
            <div className="composer-left">
              <span className="button button-ghost button-icon">
                <Paperclip size={16} />
              </span>
            </div>
            <span className="button button-icon send-button ghost-send">
              <ArrowUp size={18} />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
