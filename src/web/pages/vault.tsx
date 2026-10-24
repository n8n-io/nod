import { PageTitle } from '../components/page-title';
import { useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronRight, CreditCard, Globe, KeyRound, Plus, Upload } from '../components/icons';
import type { VaultListEntry, VaultSession } from '../../shared/contracts';
import { usePageData } from '../hooks/use-page-data';
import { usePhone } from '../hooks/use-phone';
import { VaultDetails } from '../components/vault-details';
import { VaultSessionDetails, VaultSiteAccess } from '../components/vault-site';
import { VaultEntryIcon, VaultSurface } from '../components/vault-surface';
import { formatCardExpiry, VaultItemForm } from '../components/vault-item-form';
import { VaultCardPayments } from '../components/vault-card';
import { VaultImportDialog } from '../components/vault-import-dialog';
import { WebsiteSessionDialog } from '../components/website-session-dialog';
import { originLabel } from '../lib/vault-name';
import { cn } from '../lib/utils';
import { Loading, Notice, SearchField } from '../components/ui';

export type VaultItem = VaultListEntry | VaultSession;

const sessionLabels: Record<VaultSession['state'], string> = {
  saved: 'Saved session',
  needs_sign_in: 'Sign-in needed',
  pending: 'Sign-in not finished',
  disconnecting: 'Signing out…',
};

export function vaultItems(entries: VaultListEntry[], sessions: VaultSession[]): VaultItem[] {
  const logins = new Set(
    entries.flatMap((entry) => (entry.kind === 'login' && !entry.unreadable ? [entry.origin] : [])),
  );
  return [...entries, ...sessions.filter((session) => !logins.has(session.origin))];
}

function subtitle(item: VaultItem) {
  if (item.kind === 'card')
    return `${item.brand} •••• ${item.last4} · ${formatCardExpiry(item.expiryMonth, item.expiryYear)}`;
  if (item.kind === 'session') return `${originLabel(item.origin)} · ${sessionLabels[item.state]}`;
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

export function Vault({ hidden = false, onAsk }: { hidden?: boolean; onAsk?(text: string): void }) {
  const {
    data: entries,
    error: loadError,
    loading,
    refresh,
    update,
  } = usePageData<VaultListEntry[]>('/api/vault');
  const sessions = usePageData<VaultSession[]>('/api/vault/sessions');
  const phone = usePhone();
  const [request] = useState(requested);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState(false);
  const [website, setWebsite] = useState(false);
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState<'login' | 'card' | null>(request.add);
  const [selectedId, setSelectedId] = useState<string | null | undefined>(request.item);
  const [fromUsage, setFromUsage] = useState(request.item);
  const [savingNew, setSavingNew] = useState(false);
  const [chosen, setChosen] = useState(Boolean(request.add || request.item));
  const returnTo = useRef<string | null>(null);
  const newTrigger = useRef<HTMLButtonElement>(null);
  const openingDialog = useRef(false);
  const items = vaultItems(entries ?? [], sessions.data ?? []);
  const empty = Boolean(entries && sessions.data) && !items.length;
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

  function open(item: VaultItem) {
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
      remaining?.find((value) => value.kind === 'login' && !value.unreadable) ??
      (entry?.kind === 'login'
        ? sessions.data?.find((value) => value.origin === entry.origin)
        : undefined) ??
      remaining?.[0];
    update((current) => current?.filter((value) => value.id !== id) ?? current);
    sessions.update((current) => current?.filter((value) => value.id !== id) ?? current);
    returnTo.current = next?.id ?? 'new';
    setSelectedId(next?.id ?? null);
    void refresh();
    void sessions.refresh();
  }

  function row(item: VaultItem) {
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
          {item.kind === 'session' ? (
            <Globe size={24} />
          ) : (
            <VaultEntryIcon entry={item} size={24} />
          )}
        </span>
        <span className="vault-item-text">
          <strong>{item.label}</strong>
          <span>{subtitle(item)}</span>
        </span>
        {!split && <ChevronRight className="vault-item-chevron" size={16} aria-hidden="true" />}
      </button>
    );
  }

  const sessionsFor = (origin: string) =>
    sessions.data?.filter((value) => value.origin === origin) ?? [];

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
  ) : selected?.kind === 'session' ? (
    <VaultSessionDetails
      key={selected.id}
      session={selected}
      autoFocus={chosen && selectedId === selected.id}
      backLabel={backToUsage ? 'Usage' : 'Vault'}
      onClose={closeDetail}
      onRemoved={removed}
      onAsk={onAsk}
    />
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
          {selected.kind === 'login' && (
            <VaultSiteAccess
              origin={selected.origin}
              sessions={sessionsFor(selected.origin)}
              onSessionRemoved={(id) =>
                sessions.update((current) => current?.filter((value) => value.id !== id) ?? current)
              }
              onAsk={onAsk}
            />
          )}
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
          <PageTitle path="/vault" />
          <div className="secondary-heading-actions">
            <Popover.Root open={menu} onOpenChange={setMenu}>
              <Popover.Trigger asChild>
                <button ref={newTrigger} type="button" className="button button-primary button-sm">
                  <Plus size={16} aria-hidden="true" />
                  Add
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  className="connection-menu-options menu vault-new-menu"
                  align="end"
                  sideOffset={6}
                  onCloseAutoFocus={(event) => {
                    if (!openingDialog.current) return;
                    openingDialog.current = false;
                    event.preventDefault();
                  }}
                >
                  <button type="button" className="menu-item" onClick={() => start('login')}>
                    <Globe size={16} aria-hidden="true" />
                    Login
                  </button>
                  <button type="button" className="menu-item" onClick={() => start('card')}>
                    <CreditCard size={16} aria-hidden="true" />
                    Payment card
                  </button>
                  {onAsk && (
                    <button
                      type="button"
                      className="menu-item"
                      onClick={() => {
                        openingDialog.current = true;
                        setMenu(false);
                        setWebsite(true);
                      }}
                    >
                      <Globe size={16} aria-hidden="true" />
                      Website session
                    </button>
                  )}
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      openingDialog.current = true;
                      setMenu(false);
                      setImporting(true);
                    }}
                  >
                    <Upload size={16} aria-hidden="true" />
                    Import passwords
                  </button>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </div>
        </header>
      )}
      {loadError && <Notice>{loadError}</Notice>}
      {sessions.error && (
        <Notice>
          {sessions.error}{' '}
          <button type="button" onClick={() => void sessions.refresh()}>
            Try again
          </button>
        </Notice>
      )}
      <div className="vault-layout">
        {!pageMode && empty && (
          <div className="statement vault-start">
            <p className="statement-summary">
              nod has <b>no logins</b> and <b>no cards</b> yet.
              <br />
              It fills them in for you. The AI never sees your passwords or card numbers.
            </p>
            <div className="vault-doors">
              {[
                {
                  icon: Upload,
                  label: 'Import passwords',
                  detail: 'From Chrome, 1Password or another manager',
                  run: () => setImporting(true),
                },
                {
                  icon: KeyRound,
                  label: 'Add a login',
                  detail: 'nod signs in when a task needs it',
                  run: () => start('login'),
                },
                {
                  icon: CreditCard,
                  label: 'Add a card',
                  detail: 'You approve each payment with its security code',
                  run: () => start('card'),
                },
                ...(onAsk
                  ? [
                      {
                        icon: Globe,
                        label: 'Sign in to a website',
                        detail: 'Sign in once, later tasks reuse it',
                        run: () => setWebsite(true),
                      },
                    ]
                  : []),
              ].map(({ icon: Icon, label, detail, run }) => (
                <button key={label} type="button" className="vault-door" onClick={run}>
                  <span className="vault-door-icon" aria-hidden="true">
                    <Icon size={20} />
                  </span>
                  <strong>{label}</strong>
                  <span>{detail}</span>
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
            {!entries || (!sessions.data && !sessions.error) ? (
              (loading || sessions.loading) && <Loading label="Opening logins and cards…" />
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
      {onAsk && <WebsiteSessionDialog open={website} onOpenChange={setWebsite} onAsk={onAsk} />}
      <VaultImportDialog
        open={importing}
        onOpenChange={setImporting}
        onImported={() => void refresh()}
      />
    </div>
  );
}
