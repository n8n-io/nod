import { useEffect, useRef, useState } from 'react';
import { ActionMenu, ActionMenuItem } from '../components/action-menu';
import { ChevronRight, CreditCard, Globe, Import, KeyRound, Plus } from '../components/icons';
import type { VaultListEntry } from '../../shared/contracts';
import { usePageData } from '../hooks/use-page-data';
import { usePhone } from '../hooks/use-phone';
import { VaultDetails } from '../components/vault-details';
import { VaultSiteAccess } from '../components/vault-site';
import { VaultEntryIcon, VaultSurface } from '../components/vault-surface';
import { formatCardExpiry, VaultItemForm } from '../components/vault-item-form';
import { VaultCardPayments } from '../components/vault-card';
import { VaultImportDialog } from '../components/vault-import-dialog';
import { originLabel } from '../lib/vault-name';
import { cn } from '../lib/utils';
import { Loading, Notice, SearchField } from '../components/ui';

function subtitle(item: VaultListEntry) {
  if (item.kind === 'card')
    return `${item.brand} •••• ${item.last4} · ${formatCardExpiry(item.expiryMonth, item.expiryYear)}`;
  if (item.unreadable) return 'Can’t be opened';
  return item.username || originLabel(item.origin);
}

function requested() {
  const search =
    window.location.pathname === '/vault' && !window.location.hash ? window.location.search : '';
  return {
    add: search === '?add=login' ? 'login' : search === '?add=card' ? 'card' : null,
    item: /^\?item=([\w-]+)$/.exec(search)?.[1],
  } as const;
}

export function Vault({ hidden = false }: { hidden?: boolean }) {
  const {
    data: entries,
    error: loadError,
    loading,
    refresh,
    update,
  } = usePageData<VaultListEntry[]>('/api/vault');
  const phone = usePhone();
  const [request] = useState(requested);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState(false);
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState<'login' | 'card' | null>(request.add);
  const [selectedId, setSelectedId] = useState<string | null | undefined>(request.item);
  const [fromUsage, setFromUsage] = useState(request.item);
  const [savingNew, setSavingNew] = useState(false);
  const [chosen, setChosen] = useState(Boolean(request.add || request.item));
  const returnTo = useRef<string | null>(null);
  const newTrigger = useRef<HTMLButtonElement>(null);
  const openingDialog = useRef(false);
  const returnFromImportMenu = useRef(false);
  const items = entries ?? [];
  const empty = Boolean(entries) && !items.length;
  const split = !phone && !empty;
  const search = query.trim().toLowerCase();
  const visible = items
    .filter(
      (item) =>
        !search ||
        [item.label, subtitle(item), item.kind === 'card' ? '' : originLabel(item.origin)]
          .join(' ')
          .toLowerCase()
          .includes(search),
    )
    .sort((a, b) => a.label.localeCompare(b.label));
  const selected =
    items.find((item) => item.id === selectedId) ??
    (selectedId === undefined && split && !adding ? visible[0] : undefined);
  const pageMode = Boolean(adding || selected) && !split;
  const backToUsage = Boolean(fromUsage) && selected?.id === fromUsage;

  useEffect(() => {
    if (importing || !returnFromImportMenu.current) return;
    returnFromImportMenu.current = false;
    newTrigger.current?.focus({ preventScroll: true });
  }, [importing]);

  useEffect(() => {
    if (hidden || !window.location.search) return;
    const { add, item } = requested();
    window.history.replaceState(null, '', '/vault');
    if (add) {
      setAdding(add);
      setChosen(true);
    } else if (item) {
      setAdding(null);
      setSelectedId(item);
      setFromUsage(item);
      setChosen(true);
    }
  }, [hidden]);

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

  function open(item: VaultListEntry) {
    setAdding(null);
    setChosen(true);
    setSelectedId(item.id);
  }

  function closeDetail() {
    if (split) return;
    if (backToUsage) {
      setChosen(false);
      setSelectedId(null);
      setFromUsage(undefined);
      window.history.back();
      return;
    }
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

  function removed(id: string) {
    const entry = entries?.find((value) => value.id === id);
    const remaining =
      entry?.kind === 'login'
        ? entries?.filter(
            (value) => value.id !== id && value.kind === 'login' && value.origin === entry.origin,
          )
        : undefined;
    const next =
      remaining?.find((value) => value.kind === 'login' && !value.unreadable) ?? remaining?.[0];
    update((current) => current?.filter((value) => value.id !== id) ?? current);
    returnTo.current = next?.id ?? 'new';
    setSelectedId(next?.id ?? null);
    void refresh();
  }

  function row(item: VaultListEntry) {
    const current = split && selected?.id === item.id;
    return (
      <button
        key={item.id}
        type="button"
        className={cn('button vault-item', current ? 'button-secondary' : 'button-ghost')}
        data-vault-item={item.id}
        aria-current={current ? 'true' : undefined}
        onClick={() => open(item)}
      >
        <span className="vault-item-icon" aria-hidden="true">
          <VaultEntryIcon entry={item} size={24} />
        </span>
        <span className="vault-item-text">
          <strong>{item.label}</strong>
          <span>{subtitle(item)}</span>
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
      visible={!hidden}
      autoFocus={chosen && selectedId === selected.id}
      backLabel={backToUsage ? 'Usage' : 'Vault'}
      onClose={closeDetail}
      onSaved={(entry) => {
        save(entry);
        setSelectedId(entry.id);
      }}
      onDeleted={removed}
    >
      {() => (
        <>
          {selected.kind === 'login' && <VaultSiteAccess origin={selected.origin} />}
          {selected.kind === 'card' && <VaultCardPayments cardId={selected.id} />}
        </>
      )}
    </VaultDetails>
  ) : null;

  return (
    <div
      className={cn(
        'content-page secondary-page vault-page',
        split && 'is-split',
        pageMode && 'is-detail',
      )}
      hidden={hidden}
    >
      {!pageMode && (
        <header className="page-heading secondary-heading">
          <div className="secondary-heading-actions">
            <ActionMenu
              label="Add to Vault"
              open={menu}
              onOpenChange={setMenu}
              contentClassName="vault-new-menu"
              onCloseAutoFocus={(event) => {
                if (!openingDialog.current) return;
                openingDialog.current = false;
                event.preventDefault();
              }}
              trigger={
                <button ref={newTrigger} type="button" className="button button-primary button-sm">
                  <Plus size={16} aria-hidden="true" />
                  Add
                </button>
              }
            >
              <ActionMenuItem onClick={() => start('login')}>
                <Globe size={16} aria-hidden="true" />
                Login
              </ActionMenuItem>
              <ActionMenuItem onClick={() => start('card')}>
                <CreditCard size={16} aria-hidden="true" />
                Payment card
              </ActionMenuItem>
              <ActionMenuItem
                onClick={() => {
                  openingDialog.current = true;
                  returnFromImportMenu.current = true;
                  setMenu(false);
                  setImporting(true);
                }}
              >
                <Import size={16} aria-hidden="true" />
                Import passwords
              </ActionMenuItem>
            </ActionMenu>
          </div>
        </header>
      )}
      {loadError && <Notice>{loadError}</Notice>}
      <div className="vault-layout">
        {!pageMode && empty && (
          <div className="statement vault-start">
            <p className="statement-summary">
              Nod has <b>no logins</b> and <b>no cards</b> yet.
            </p>
            <div className="vault-doors">
              {[
                {
                  icon: Import,
                  label: 'Import passwords',
                  detail: 'From Chrome, 1Password or another manager',
                  run: () => setImporting(true),
                },
                {
                  icon: KeyRound,
                  label: 'Add a login',
                  detail: 'Nod signs in when a task needs it',
                  run: () => start('login'),
                },
                {
                  icon: CreditCard,
                  label: 'Add a card',
                  detail: 'You approve each payment with its security code',
                  run: () => start('card'),
                },
              ].map(({ icon: Icon, label, detail, run }) => (
                <button key={label} type="button" className="vault-door" onClick={run}>
                  <span className="vault-door-icon" aria-hidden="true">
                    <Icon size={20} />
                  </span>
                  <span className="vault-door-text">
                    <strong>{label}</strong>
                    <span>{detail}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        {!pageMode && !empty && (
          <div className="vault-browser">
            <SearchField
              className="vault-search"
              type="search"
              value={query}
              placeholder="Search"
              aria-label="Search logins and cards"
              onChange={(event) => setQuery(event.target.value)}
            />
            {!entries ? (
              loading && <Loading label="Opening logins and cards…" />
            ) : visible.length ? (
              <div className="vault-items">{visible.map(row)}</div>
            ) : (
              items.length > 0 && (
                <p className="vault-no-results">No items match “{query.trim()}”.</p>
              )
            )}
          </div>
        )}
        {detail && <div className="vault-detail-column">{detail}</div>}
      </div>
      <VaultImportDialog
        open={importing}
        onOpenChange={setImporting}
        onImported={() => void refresh()}
      />
    </div>
  );
}
