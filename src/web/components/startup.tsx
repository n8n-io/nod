import { useEffect, useState, type ReactNode } from 'react';
import { ArrowUp, Paperclip } from 'lucide-react';
import { BrandMark } from './brand';
import { Skeleton } from './ui';
import { navigationItems } from '../lib/navigation';
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
  const conversation = readUiPreference('otto.chat-layout') === 'conversation';
  return (
    <div className="chat-page chat-skeleton" aria-busy="true">
      <div className="chat-report-action" aria-hidden="true">
        <span className="chat-title">Chat</span>
      </div>
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
              <div className="starter-actions">
                {[120, 214, 118].map((width) => (
                  <Skeleton key={width} className="ghost-chip" style={{ width }} />
                ))}
              </div>
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
            <span className="sr-only">Opening Otto…</span>
          )}
        </p>
        <div className="composer ghost-composer" aria-hidden="true">
          <p>Message Otto…</p>
          <div className="composer-tools">
            <div className="composer-left">
              <span className="button button-ghost button-icon">
                <Paperclip size={18} />
              </span>
            </div>
            <span className="button button-icon send-button ghost-send">
              <ArrowUp size={19} />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function StartupShell({ children }: { children: ReactNode }) {
  return (
    <div
      className={`app-shell startup-shell ${readUiPreference('otto.sidebar') !== 'expanded' ? 'sidebar-collapsed' : ''}`}
    >
      <aside className="sidebar" aria-hidden="true" inert>
        <span className="brand">
          <BrandMark />
          <span>otto</span>
        </span>
        <nav className="main-nav">
          <ul>
            {navigationItems.map((item) => (
              <li key={item.path}>
                <span className="nav-link">
                  <Skeleton className="ghost-nav-icon" />
                  <span className="nav-label">{item.label}</span>
                </span>
              </li>
            ))}
          </ul>
        </nav>
        <div className="mobile-top-bar">
          <span className="mobile-chat-link">
            <BrandMark />
          </span>
          <span className="mobile-menu-trigger">
            <Skeleton className="ghost-avatar" />
          </span>
        </div>
        <div className="sidebar-bottom">
          {[0, 1].map((row) => (
            <span key={row} className="nav-link">
              <Skeleton className="ghost-nav-icon" />
              <Skeleton className="ghost-nav-label" />
            </span>
          ))}
          <Skeleton className="ghost-account" />
        </div>
      </aside>
      <div className="workspace-frame">
        <div className="workspace-body">
          <main className="main-workspace">{children}</main>
        </div>
      </div>
    </div>
  );
}

export function Splash() {
  return (
    <StartupShell>
      <ChatSkeleton />
    </StartupShell>
  );
}
