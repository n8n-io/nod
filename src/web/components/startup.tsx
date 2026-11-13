import { useEffect, useState } from 'react';
import { ArrowUp, Mic, Paperclip } from './icons';
import { BrandMark } from './brand';
import { Skeleton } from './ui';
import { readUiPreference } from '../lib/ui-preferences';

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
      <div className="conversation-scroll">
        <div className="conversation-column" aria-hidden="true">
          {conversation ? (
            <div className="messages">
              {ghostTurns.flatMap((turn, index) => [
                <div key={`user-${index}`} className="message message-user">
                  <div className="message-content">
                    <div className="message-row">
                      <div className="message-bubble" style={{ width: turn.user }}>
                        <div className="message-body ghost-user-bubble">
                          <Skeleton style={{ width: '68%' }} />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>,
                <div key={`assistant-${index}`} className="message message-assistant">
                  <div className="message-content">
                    <div className="message-row">
                      <div className="message-bubble" style={{ width: '78%' }}>
                        <div className="message-body skeleton-lines">
                          {turn.lines.map((width, line) => (
                            <Skeleton key={line} style={{ width }} />
                          ))}
                        </div>
                      </div>
                    </div>
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
        <div className="chat-bottom-fade" aria-hidden="true" />
        <p className="skeleton-note" role="status">
          {long ? (
            <span key="long">Still working on it.</span>
          ) : slow ? (
            <span key="slow">Getting things ready…</span>
          ) : (
            <span className="sr-only">Opening Nod…</span>
          )}
        </p>
        <div className="composer ghost-composer" aria-hidden="true">
          <p>Message Nod…</p>
          <div className="composer-tools">
            <div className="composer-left" />
            <div className="composer-right">
              <span className="button button-ghost button-icon">
                <Paperclip size={16} />
              </span>
              <span className="button button-ghost button-icon">
                <Mic size={16} />
              </span>
              <span className="button button-icon send-button ghost-send">
                <ArrowUp size={18} />
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
