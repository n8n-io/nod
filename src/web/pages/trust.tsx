import { PageTitle } from '../components/page-title';
import { useEffect, useId, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronRight, CreditCard, Globe, Plus, Upload } from 'lucide-react';
import type {
  VaultActivity,
  VaultActivityEntry,
  VaultListEntry,
  VaultSession,
} from '../../shared/contracts';
import type { TrustView } from '../../shared/trust';
import type { AccountPreferences } from '../../shared/account';
import { usePageData } from '../hooks/use-page-data';
import { usePhone } from '../hooks/use-phone';
import { TrustActivity } from '../components/trust-activity';
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

type Item = VaultListEntry | VaultSession;
type View = 'activity' | 'saved';

const sessionLabels: Record<VaultSession['state'], string> = {
  saved: 'Saved session',
  needs_sign_in: 'Sign-in needed',
  pending: 'Sign-in not finished',
  disconnecting: 'Signing out…',
};

function subtitle(item: Item) {
  if (item.kind === 'card')
    return `${item.brand} •••• ${item.last4} · ${formatCardExpiry(item.expiryMonth, item.expiryYear)}`;
  if (item.kind === 'session') return `${originLabel(item.origin)} · ${sessionLabels[item.state]}`;
  if (item.unreadable) return 'Can’t be opened';
  return item.username || originLabel(item.origin);
}

export function Trust({ onAsk }: { onAsk?(text: string): void }) {
  const {
    data: entries,
    error: loadError,
    loading,
    refresh,
    update,
  } = usePageData<VaultListEntry[]>('/api/vault');
  const sessions = usePageData<VaultSession[]>('/api/vault/sessions');
  const activity = usePageData<VaultActivity>('/api/vault/activity');
  const trust = usePageData<TrustView>('/api/trust');
  const preferences = usePageData<AccountPreferences>('/api/preferences');
  const phone = usePhone();
  const tabsId = useId();
  const addRequested = window.location.hash
    ? null
    : window.location.search === '?add=login'
      ? 'login'
      : window.location.search === '?add=card'
        ? 'card'
        : null;
  const [view, setView] = useState<View>(addRequested ? 'saved' : 'activity');
  const [savedOpened, setSavedOpened] = useState(Boolean(addRequested));
  useEffect(() => {
    if (view === 'saved') setSavedOpened(true);
  }, [view]);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState(false);
  const [website, setWebsite] = useState(false);
  const [importing, setImporting] = useState(false);
  const [revision, setRevision] = useState(0);
  const [adding, setAdding] = useState<'login' | 'card' | null>(addRequested);
  const [selectedId, setSelectedId] = useState<string | null | undefined>(undefined);
  const [savingNew, setSavingNew] = useState(false);
  const [chosen, setChosen] = useState(false);
  const returnTo = useRef<string | null>(null);
  const backTo = useRef<View>('saved');
  const activityTrigger = useRef<string | null>(null);
  const newTrigger = useRef<HTMLButtonElement>(null);
  const openingDialog = useRef(false);
  const split = !phone;
  const logins = new Set(
    (entries ?? []).flatMap((entry) =>
      entry.kind === 'login' && !entry.unreadable ? [entry.origin] : [],
    ),
  );
  const items: Item[] = [
    ...(entries ?? []),
    ...(sessions.data ?? []).filter((session) => !logins.has(session.origin)),
  ];
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
  const detailOpen = view === 'saved' && Boolean(adding || selected);
  const pageMode = detailOpen && !split;

  useEffect(() => {
    if (addRequested) window.history.replaceState(null, '', '/trust');
  }, [addRequested]);

  useEffect(() => {
    if (pageMode || !returnTo.current) return;
    const id = returnTo.current;
    returnTo.current = null;
    (id === 'new'
      ? newTrigger.current
      : id.startsWith('activity:')
        ? [...document.querySelectorAll<HTMLElement>('[data-vault-activity]')].find(
            (item) => item.dataset.vaultActivity === id.slice(9),
          )
        : [...document.querySelectorAll<HTMLElement>('[data-vault-item]')].find(
            (item) => item.dataset.vaultItem === id,
          )
    )?.focus();
  }, [pageMode, adding, selectedId, view]);

  function save(entry: VaultListEntry) {
    update((current) => [entry, ...(current ?? []).filter((value) => value.id !== entry.id)]);
    void refresh();
  }

  function open(item: Item, from: View = 'saved') {
    backTo.current = from;
    setView('saved');
    setAdding(null);
    setChosen(true);
    setSelectedId(item.id);
  }

  function opener(entry: VaultActivityEntry) {
    const item =
      items.find((value) => value.id === entry.itemId) ??
      (!entry.itemId &&
        items.find((value) => value.kind === 'session' && value.origin === entry.origin));
    return item
      ? () => {
          activityTrigger.current = entry.id;
          open(item, 'activity');
        }
      : undefined;
  }

  function closeDetail() {
    if (split) return;
    returnTo.current =
      backTo.current === 'activity' && activityTrigger.current
        ? `activity:${activityTrigger.current}`
        : (selectedId ?? null);
    setChosen(false);
    setSelectedId(null);
    setView(backTo.current);
  }

  function start(kind: 'login' | 'card') {
    setMenu(false);
    setView('saved');
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
    update((current) => current?.filter((value) => value.id !== id) ?? current);
    sessions.update((current) => current?.filter((value) => value.id !== id) ?? current);
    returnTo.current = 'new';
    setSelectedId(null);
    void refresh();
    void sessions.refresh();
  }

  function row(item: Item) {
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
    sessions.data?.filter((value) => value.origin === origin && value.state !== 'disconnecting') ??
    [];

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
      onClose={closeDetail}
      onRemoved={removed}
      onAsk={onAsk}
    />
  ) : selected ? (
    <VaultDetails
      key={`${selected.id}-${revision}`}
      entry={selected}
      visible={view === 'saved'}
      autoFocus={chosen && selectedId === selected.id}
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

  const views: View[] = ['activity', 'saved'];
  return (
    <div
      className={cn(
        'content-page secondary-page vault-page',
        split && view === 'saved' && 'is-split',
        pageMode && 'is-detail',
      )}
    >
      {!pageMode && (
        <>
          <header className="page-heading secondary-heading vault-heading">
            <PageTitle path="/trust" />
            <div className="vault-heading-actions">
              <div
                className="vault-seg"
                role="tablist"
                aria-label="Trust views"
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const next =
                    event.key === 'Home'
                      ? 'activity'
                      : event.key === 'End'
                        ? 'saved'
                        : view === 'activity'
                          ? 'saved'
                          : 'activity';
                  setView(next);
                  event.currentTarget
                    .querySelector<HTMLButtonElement>(`[data-view="${next}"]`)
                    ?.focus();
                }}
              >
                {views.map((item) => (
                  <button
                    key={item}
                    id={`${tabsId}-tab-${item}`}
                    data-view={item}
                    role="tab"
                    tabIndex={view === item ? 0 : -1}
                    aria-selected={view === item}
                    aria-controls={`${tabsId}-panel`}
                    onClick={() => setView(item)}
                  >
                    {item === 'activity' ? 'Activity' : 'Saved'}
                    {item === 'saved' && entries && <span>{items.length}</span>}
                  </button>
                ))}
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
                    onCloseAutoFocus={(event) => {
                      if (!openingDialog.current) return;
                      openingDialog.current = false;
                      event.preventDefault();
                    }}
                  >
                    <button type="button" className="menu-item" onClick={() => start('login')}>
                      <Globe size={16} aria-hidden="true" />
                      New login
                    </button>
                    <button type="button" className="menu-item" onClick={() => start('card')}>
                      <CreditCard size={16} aria-hidden="true" />
                      New payment card
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
        </>
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
      <div
        role={pageMode ? undefined : 'tabpanel'}
        id={`${tabsId}-panel`}
        aria-labelledby={pageMode ? undefined : `${tabsId}-tab-${view}`}
        className="vault-panel"
      >
        <div hidden={view !== 'activity'}>
          {activity.data && trust.data && preferences.data ? (
            <TrustActivity
              view={trust.data}
              vault={activity.data}
              rule={preferences.data.notificationRule}
              opener={opener}
              onSaved={() => void trust.refresh()}
            />
          ) : activity.error || trust.error || preferences.error ? (
            <Notice>{activity.error || trust.error || preferences.error}</Notice>
          ) : (
            <Loading label="Opening activity…" />
          )}
        </div>
        {(view === 'saved' || savedOpened) && (
          <div className="vault-layout" hidden={view !== 'saved'}>
            {!pageMode && (
              <div className="vault-browser">
                <SearchField
                  className="vault-search"
                  type="search"
                  value={query}
                  placeholder="Search"
                  aria-label="Search saved"
                  onChange={(event) => setQuery(event.target.value)}
                />
                {!entries ? (
                  loading && <Loading label="Opening saved items…" />
                ) : !items.length ? (
                  <div className="secondary-empty">
                    <h2>Nothing saved yet</h2>
                    <p>Add a login, a payment card or a website session.</p>
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
        )}
      </div>
      {onAsk && <WebsiteSessionDialog open={website} onOpenChange={setWebsite} onAsk={onAsk} />}
      <VaultImportDialog
        open={importing}
        onOpenChange={setImporting}
        onImported={() => {
          setView('saved');
          void refresh();
        }}
      />
    </div>
  );
}
