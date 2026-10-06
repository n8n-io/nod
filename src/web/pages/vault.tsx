import { PageTitle } from '../components/page-title';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronRight, CreditCard, Globe, Plus } from 'lucide-react';
import type { VaultListEntry } from '../../shared/contracts';
import { usePageData } from '../hooks/use-page-data';
import { VaultDetails } from '../components/vault-details';
import { VaultEntryIcon, VaultSurface } from '../components/vault-surface';
import { formatCardExpiry, VaultItemForm } from '../components/vault-item-form';
import { originLabel } from '../lib/vault-name';
import { cn } from '../lib/utils';
import { Loading, Notice, SearchField } from '../components/ui';

const phoneQuery = '(max-width: 720px)';

function usePhone() {
  return useSyncExternalStore(
    (change) => {
      const media = window.matchMedia?.(phoneQuery);
      media?.addEventListener('change', change);
      return () => media?.removeEventListener('change', change);
    },
    () => window.matchMedia?.(phoneQuery).matches ?? false,
  );
}

function subtitle(entry: VaultListEntry) {
  return entry.kind === 'card'
    ? `${entry.brand} •••• ${entry.last4} · ${formatCardExpiry(entry.expiryMonth, entry.expiryYear)}`
    : entry.username || originLabel(entry.origin);
}

export function Vault() {
  const {
    data: entries,
    error: loadError,
    loading,
    refresh,
    update,
  } = usePageData<VaultListEntry[]>('/api/vault');
  const phone = usePhone();
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState(false);
  const [adding, setAdding] = useState<'login' | 'card' | null>(null);
  const [selectedId, setSelectedId] = useState<string | null | undefined>(undefined);
  const [savingNew, setSavingNew] = useState(false);
  const [chosen, setChosen] = useState(false);
  const returnTo = useRef<string | null>(null);
  const newTrigger = useRef<HTMLButtonElement>(null);
  const split = !phone;
  const search = query.trim().toLowerCase();
  const visible = [...(entries ?? [])]
    .filter(
      (entry) =>
        !search ||
        [entry.label, subtitle(entry), entry.kind === 'login' ? originLabel(entry.origin) : '']
          .join(' ')
          .toLowerCase()
          .includes(search),
    )
    .sort((a, b) => a.label.localeCompare(b.label));
  const selected =
    entries?.find((entry) => entry.id === selectedId) ??
    (selectedId === undefined && split && !adding ? visible[0] : undefined);
  const detailOpen = Boolean(adding || selected);
  const pageMode = detailOpen && !split;

  useEffect(() => {
    if (pageMode || !returnTo.current) return;
    const id = returnTo.current;
    returnTo.current = null;
    (id === 'new'
      ? newTrigger.current
      : [...document.querySelectorAll<HTMLElement>('[data-vault-item]')].find(
          (item) => item.dataset.vaultItem === id,
        )
    )?.focus();
  }, [pageMode, adding, selectedId]);

  function save(entry: VaultListEntry) {
    update((current) => [entry, ...(current ?? []).filter((value) => value.id !== entry.id)]);
    void refresh();
  }

  function open(entry: VaultListEntry) {
    setAdding(null);
    setChosen(true);
    setSelectedId(entry.id);
  }

  function closeDetail() {
    if (split) return;
    returnTo.current = selectedId ?? null;
    setChosen(false);
    setSelectedId(null);
  }

  function start(kind: 'login' | 'card') {
    setMenu(false);
    setChosen(true);
    setAdding(kind);
  }

  function closeAdd() {
    if (savingNew) return;
    returnTo.current = 'new';
    setChosen(false);
    setAdding(null);
  }

  function row(entry: VaultListEntry) {
    return (
      <button
        key={entry.id}
        type="button"
        className={cn(
          'button vault-item',
          split && selected?.id === entry.id ? 'button-secondary' : 'button-ghost',
        )}
        data-vault-item={entry.id}
        aria-current={split && selected?.id === entry.id ? 'true' : undefined}
        onClick={() => open(entry)}
      >
        <span className="vault-item-icon" aria-hidden="true">
          <VaultEntryIcon entry={entry} size={24} />
        </span>
        <span className="vault-item-text">
          <strong>{entry.label}</strong>
          <span>{subtitle(entry)}</span>
        </span>
        {!split && <ChevronRight className="vault-item-chevron" size={16} aria-hidden="true" />}
      </button>
    );
  }

  const detail = adding ? (
    <VaultSurface
      key={`new-${adding}`}
      label={adding === 'card' ? 'New payment card' : 'New login'}
      autoFocus={false}
      onClose={closeAdd}
    >
      <VaultItemForm
        kind={adding}
        onCancel={closeAdd}
        onSavingChange={setSavingNew}
        onSaved={(entry) => {
          setSavingNew(false);
          save(entry);
          setAdding(null);
          setSelectedId(entry.id);
        }}
      />
    </VaultSurface>
  ) : selected ? (
    <VaultDetails
      key={selected.id}
      entry={selected}
      autoFocus={chosen && selectedId === selected.id}
      onClose={closeDetail}
      onSaved={(entry) => {
        save(entry);
        setSelectedId(entry.id);
      }}
      onDeleted={(id) => {
        update((current) => current?.filter((value) => value.id !== id) ?? current);
        returnTo.current = 'new';
        setSelectedId(null);
        void refresh();
      }}
    />
  ) : null;

  return (
    <div
      className={cn(
        'content-page secondary-page vault-page',
        split && 'is-split',
        pageMode && 'is-detail',
      )}
    >
      {!pageMode && (
        <header className="page-heading secondary-heading">
          <div>
            <PageTitle path="/vault" />
            <p>Your saved logins and payment cards.</p>
          </div>
          <Popover.Root open={menu} onOpenChange={setMenu}>
            <Popover.Trigger asChild>
              <button
                ref={newTrigger}
                type="button"
                className="button button-primary button-sm vault-new"
              >
                <Plus size={16} aria-hidden="true" />
                New
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                className="connection-menu-options menu vault-new-menu"
                align="end"
                sideOffset={6}
              >
                <button type="button" className="menu-item" onClick={() => start('login')}>
                  <Globe size={16} aria-hidden="true" />
                  New login
                </button>
                <button type="button" className="menu-item" onClick={() => start('card')}>
                  <CreditCard size={16} aria-hidden="true" />
                  New payment card
                </button>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </header>
      )}
      {loadError && <Notice>Could not load your vault.</Notice>}
      <div className="vault-layout">
        {!pageMode && (
          <div className="vault-browser">
            <SearchField
              className="vault-search"
              type="search"
              value={query}
              placeholder="Search"
              aria-label="Search Vault"
              onChange={(event) => setQuery(event.target.value)}
            />
            {!entries ? (
              loading && <Loading label="Opening your vault…" />
            ) : !entries.length ? (
              <div className="secondary-empty">
                <h2>Your vault is empty</h2>
                <p>Add a login or payment card to your vault.</p>
              </div>
            ) : visible.length ? (
              <div className="vault-items">{visible.map(row)}</div>
            ) : (
              <p className="vault-no-results">No items match “{query.trim()}”.</p>
            )}
          </div>
        )}
        {detail && <div className="vault-detail-column">{detail}</div>}
      </div>
    </div>
  );
}
