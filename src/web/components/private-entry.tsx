import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Check, X } from './icons';
import type { VaultListEntry } from '../../shared/contracts';
import { pageDataCache } from '../lib/page-data-cache';
import { VaultItemForm } from './vault-item-form';
import { Credentials, Payment } from '../pages/credentials';
import { Button } from './ui';

type Entry = { kind: 'credentials' | 'payment' | 'card'; id: string; path: string; serial: number };
type PrivateEntry = { open(href: string, trigger?: HTMLElement): boolean; close(): void };
const PrivateEntryContext = createContext<PrivateEntry | null>(null);

export function usePrivateEntry() {
  return useContext(PrivateEntryContext);
}

function privateRequest(href: string) {
  let url: URL;
  try {
    url = new URL(href, window.location.origin);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin || url.username || url.password || url.hash)
    return null;
  if (url.pathname === '/vault' && url.search === '?add=card')
    return { kind: 'card' as const, id: 'new', path: '/vault?add=card' };
  if (url.search) return null;
  const credential = /^\/(?:vault|credentials)\/([A-Za-z0-9_-]{20,100})\/?$/.exec(url.pathname);
  if (credential)
    return { kind: 'credentials' as const, id: credential[1], path: `/vault/${credential[1]}` };
  const payment =
    /^\/payments\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/i.exec(
      url.pathname,
    );
  return payment
    ? { kind: 'payment' as const, id: payment[1], path: `/payments/${payment[1]}` }
    : null;
}

function NewPaymentCard({ onClose }: { onClose(): void }) {
  const [saved, setSaved] = useState(false);
  return (
    <div className="private-entry-card">
      {saved ? (
        <div className="credential-complete" role="status">
          <div className="success-mark">
            <Check size={24} />
          </div>
          <h2>Card saved</h2>
          <p>Return to chat to continue. Each payment still needs your approval.</p>
          <Button onClick={onClose}>Back to chat</Button>
        </div>
      ) : (
        <VaultItemForm
          kind="card"
          onCancel={onClose}
          onSaved={(entry) => {
            pageDataCache.update<VaultListEntry[]>('/api/vault', (current) => [
              entry,
              ...(current ?? []).filter((value) => value.id !== entry.id),
            ]);
            setSaved(true);
          }}
        />
      )}
    </div>
  );
}

export function PrivateEntryWorkspace({
  active = true,
  children,
}: {
  active?: boolean;
  children: React.ReactNode;
}) {
  const [entry, setEntry] = useState<Entry | null>(null);
  const [narrow, setNarrow] = useState(false);
  const workspace = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLElement | undefined>(undefined);
  const serial = useRef(0);
  const replacements = useRef(new Map<string, string>());
  const close = () => {
    setEntry(null);
    window.requestAnimationFrame(() => {
      if (trigger.current?.isConnected) trigger.current.focus();
      else workspace.current?.querySelector<HTMLElement>('[role="textbox"]')?.focus();
    });
  };
  useEffect(() => {
    if (!active) setEntry(null);
  }, [active]);
  useEffect(() => {
    const element = workspace.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([value]) => setNarrow(value.contentRect.width < 800));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (entry && panel.current && !panel.current.contains(document.activeElement))
      panel.current.focus();
  }, [entry?.serial]);
  const shown = active && entry;
  useEffect(() => {
    const element = panel.current;
    if (!shown || !element) return;
    const update = () =>
      document.documentElement.style.setProperty(
        '--private-entry-space',
        `${element.getBoundingClientRect().width}px`,
      );
    update();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      document.documentElement.style.removeProperty('--private-entry-space');
    };
  }, [entry?.serial, active]);
  return (
    <PrivateEntryContext.Provider
      value={{
        open(href, element) {
          const requested = privateRequest(href);
          if (!active || !requested) return false;
          trigger.current = element;
          const replacement = replacements.current.get(requested.path);
          const request = (replacement && privateRequest(replacement)) || requested;
          setEntry({ ...request, serial: ++serial.current });
          return true;
        },
        close,
      }}
    >
      <div
        ref={workspace}
        className={`private-entry-workspace${shown ? ' has-private-entry' : ''}${narrow ? ' is-narrow' : ''}`}
      >
        <div className="private-entry-chat" inert={Boolean(shown && narrow)}>
          {children}
        </div>
        {shown && (
          <aside
            key={entry.serial}
            ref={panel}
            className="private-entry-panel"
            role={narrow ? 'dialog' : undefined}
            aria-modal={narrow || undefined}
            aria-label={
              entry.kind === 'card'
                ? 'New payment card'
                : entry.kind === 'payment'
                  ? 'Private payment'
                  : 'Private sign-in'
            }
            tabIndex={-1}
            data-analytics-private
            onKeyDown={(event) => {
              if (event.defaultPrevented) return;
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close();
              }
              if (event.key !== 'Tab' || !narrow) return;
              const controls = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>(
                  'button:not([disabled]), input:not([disabled]), a[href], [tabindex="0"]',
                ),
              ).filter((element) => !element.hidden && element.getClientRects().length);
              const first = controls[0];
              const last = controls.at(-1);
              if (
                event.shiftKey &&
                (document.activeElement === first || document.activeElement === panel.current)
              ) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }}
          >
            <div className="private-entry-toolbar">
              <Button variant="ghost" size="icon" aria-label="Close private entry" onClick={close}>
                <X size={18} aria-hidden="true" />
              </Button>
            </div>
            {entry.kind === 'card' ? (
              <NewPaymentCard onClose={close} />
            ) : entry.kind === 'payment' ? (
              <Payment id={entry.id} embedded onClose={close} />
            ) : (
              <Credentials
                id={entry.id}
                embedded
                onClose={close}
                onRequestChange={(id) => {
                  const next = `/vault/${id}`;
                  const previous = replacements.current.get(entry.path) ?? entry.path;
                  for (const [path, replacement] of replacements.current)
                    if (replacement === previous) replacements.current.set(path, next);
                  replacements.current.set(previous, next);
                  replacements.current.set(entry.path, next);
                }}
              />
            )}
          </aside>
        )}
      </div>
    </PrivateEntryContext.Provider>
  );
}
