import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, CreditCard, Globe } from './icons';
import type { VaultEntry } from '../../shared/contracts';
import { Button } from './ui';
import { apiResponse } from '../lib/api';

export function VaultEntryIcon({ entry, size = 20 }: { entry: VaultEntry; size?: number }) {
  const [loaded, setLoaded] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setLoaded(false);
    setUrl(null);
    if (entry.kind === 'login')
      void apiResponse(`/api/vault/${encodeURIComponent(entry.id)}/icon`, {
        cache: 'no-store',
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok || response.status === 204) return;
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        })
        .catch(() => {});
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [entry.id, entry.kind]);
  if (entry.kind === 'card') return <CreditCard size={size} aria-hidden="true" />;
  return (
    <>
      {!loaded && <Globe size={size} aria-hidden="true" />}
      {url && (
        <img
          className="vault-site-icon"
          src={url}
          alt=""
          width={size}
          height={size}
          decoding="async"
          referrerPolicy="no-referrer"
          hidden={!loaded}
          onLoad={() => setLoaded(true)}
          onError={() => setUrl(null)}
        />
      )}
    </>
  );
}

export function VaultTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="vault-hero-title" data-vault-title tabIndex={-1}>
      {children}
    </h2>
  );
}

export function VaultSurface({
  label,
  autoFocus = true,
  onClose,
  children,
}: {
  label: string;
  autoFocus?: boolean;
  onClose(): void;
  children: React.ReactNode;
}) {
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (autoFocus) section.current?.querySelector<HTMLElement>('[data-vault-title]')?.focus();
  }, [autoFocus]);
  return (
    <section
      ref={section}
      className="vault-surface"
      aria-label={label}
      onKeyDown={(event) => {
        if (
          event.key === 'Escape' &&
          !event.defaultPrevented &&
          event.currentTarget.contains(event.target as Node)
        )
          onClose();
      }}
    >
      {children}
    </section>
  );
}

export function VaultBackButton({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <Button type="button" variant="ghost" size="sm" className="vault-back" onClick={onClick}>
      <ChevronLeft size={16} aria-hidden="true" />
      {label}
    </Button>
  );
}
