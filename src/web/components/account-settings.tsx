import { useEffect, useId, useRef, useState } from 'react';
import {
  Clock3,
  Globe,
  MapPin,
  LogOut,
  Monitor,
  Moon,
  SlidersHorizontal,
  Sun,
  UserRound,
} from 'lucide-react';
import type { AccountPreferences, AccountTheme } from '../../shared/account';
import type { HourCycle } from '../../shared/contracts';
import type { AccountControls, AccountTab } from './account-menu';
import { AccountAvatar, GoogleMark } from './account-avatar';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Field,
  Input,
  Loading,
  Notice,
  Switch,
} from './ui';
import { usePageData } from '../hooks/use-page-data';
import { errorMessage } from '../lib/api';
import { SearchPicker, TimeZonePicker } from './time-zone-picker';
import {
  dateFormatFrom,
  formatDateTime,
  regionLocale,
  regions,
  useBrowserRegion,
} from '../lib/date-format';
import { savePreferences } from '../lib/preferences';
import { localeRegion } from '../../shared/date-locale';

const editablePreferences = ['quietHoursEnabled', 'quietStart', 'quietEnd'] as const;
const regionLabels = {
  choose: 'Choose region',
  search: 'Search regions',
  placeholder: 'Search country or region',
  clear: 'Clear region search',
  list: 'Regions',
  empty: 'No regions found.',
};
const clockOptions: Array<{ value: HourCycle; label: string }> = [
  { value: 'auto', label: 'Automatic' },
  { value: 'h12', label: '12-hour' },
  { value: 'h23', label: '24-hour' },
];

function regionOptions(current: string, detected: string) {
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  return [
    {
      value: 'auto',
      label: `Automatic (${names.of(detected) ?? detected})`,
      keywords: `location ${detected}`,
    },
    ...[...new Set([current, detected, ...regions])]
      .filter((region) => region !== 'auto')
      .map((region) => ({ value: region, label: names.of(region) ?? region, keywords: region }))
      .sort((a, b) => a.label.localeCompare(b.label, 'en')),
  ];
}

function LanguageAndRegion({ saved }: { saved: AccountPreferences }) {
  const heading = useId();
  const regionLabel = useId();
  const clockLabel = useId();
  const timeZoneLabel = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const format = dateFormatFrom(saved);
  const region = localeRegion(saved.locale) ?? 'auto';
  const detected = useBrowserRegion();
  const zones = [
    ...new Set([
      format.timeZone,
      ...(Intl.supportedValuesOf?.('timeZone') ?? [
        'Europe/Lisbon',
        'Europe/London',
        'America/New_York',
      ]),
    ]),
  ].sort();
  async function save(
    change: Partial<Pick<AccountPreferences, 'locale' | 'hourCycle' | 'timeZone'>>,
  ) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setSaving(true);
    setError('');
    try {
      await savePreferences(change, controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (!controller.signal.aborted) setSaving(false);
      }
    }
  }
  return (
    <section className="account-region" aria-labelledby={heading}>
      <h4 id={heading}>Date and time</h4>
      <div className="account-preference-row account-picker-row">
        <span id={regionLabel}>
          <MapPin size={18} aria-hidden="true" />
          Region
        </span>
        <SearchPicker
          value={region}
          options={regionOptions(region, detected)}
          labels={regionLabels}
          labelledBy={regionLabel}
          disabled={saving}
          onChange={(next) => {
            if (next !== region) void save({ locale: next === 'auto' ? null : regionLocale(next) });
          }}
        />
      </div>
      <div className="account-preference-row account-clock-row">
        <span id={clockLabel}>
          <Clock3 size={18} aria-hidden="true" />
          Clock
        </span>
        <div className="account-clock-options" role="group" aria-labelledby={clockLabel}>
          {clockOptions.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={saved.hourCycle === option.value ? 'default' : 'outline'}
              aria-pressed={saved.hourCycle === option.value}
              disabled={saving}
              onClick={() => {
                if (saved.hourCycle !== option.value) void save({ hourCycle: option.value });
              }}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
      <div className="account-preference-row account-picker-row account-time-zone">
        <span id={timeZoneLabel}>
          <Globe size={18} aria-hidden="true" />
          Time zone
        </span>
        <TimeZonePicker
          value={format.timeZone}
          zones={zones}
          labelledBy={timeZoneLabel}
          disabled={saving}
          onChange={(timeZone) => {
            if (timeZone !== saved.timeZone) void save({ timeZone });
          }}
        />
      </div>
      <p className="field-hint" aria-live="polite">
        Example: {formatDateTime(new Date(), format, { weekday: true })}
      </p>
      {error && <Notice>{error}</Notice>}
    </section>
  );
}

function PreferencesForm() {
  const {
    data,
    loading,
    error: loadError,
    refresh,
  } = usePageData<AccountPreferences>('/api/preferences');
  const [draft, setDraft] = useState<AccountPreferences | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const previous = useRef<AccountPreferences | null>(null);
  useEffect(() => {
    if (!data) return;
    const baseline = previous.current;
    setDraft((current) =>
      !current || !baseline
        ? data
        : {
            ...data,
            ...Object.fromEntries(
              editablePreferences
                .filter((key) => current[key] !== baseline[key])
                .map((key) => [key, current[key]]),
            ),
          },
    );
    previous.current = data;
  }, [data]);
  useEffect(() => () => request.current?.abort(), []);
  if (!data || !draft)
    return (
      <>
        {loading ? <Loading /> : <Notice>{loadError || 'Preferences could not be loaded.'}</Notice>}
        {!loading && (
          <Button variant="outline" onClick={() => void refresh()}>
            Try again
          </Button>
        )}
      </>
    );
  const current = draft;
  const saved = data;
  const dirty = editablePreferences.some((key) => current[key] !== saved[key]);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setSaving(true);
    setError('');
    try {
      const result = await savePreferences(
        Object.fromEntries(
          editablePreferences
            .filter((key) => current[key] !== saved[key])
            .map((key) => [key, current[key]]),
        ),
        controller.signal,
      );
      if (!controller.signal.aborted) setDraft(result);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (!controller.signal.aborted) setSaving(false);
      }
    }
  }
  return (
    <>
      <LanguageAndRegion saved={saved} />
      <form onSubmit={(event) => void save(event)}>
        <div className="account-preference-row">
          <div className="account-preference-label">
            <Moon size={18} aria-hidden="true" />
            <div>
              <strong>Quiet hours</strong>
            </div>
          </div>
          <Switch
            checked={current.quietHoursEnabled}
            aria-label="Quiet hours"
            disabled={saving}
            onCheckedChange={(quietHoursEnabled) => setDraft({ ...current, quietHoursEnabled })}
          />
        </div>
        {current.quietHoursEnabled && (
          <div className="account-quiet-times">
            <Field label="From">
              <Input
                type="time"
                value={current.quietStart}
                required
                disabled={saving}
                onChange={(event) => setDraft({ ...current, quietStart: event.target.value })}
              />
            </Field>
            <Field label="Until">
              <Input
                type="time"
                value={current.quietEnd}
                required
                disabled={saving}
                onChange={(event) => setDraft({ ...current, quietEnd: event.target.value })}
              />
            </Field>
          </div>
        )}
        {(error || loadError) && <Notice>{error || loadError}</Notice>}
        {dirty && (
          <div className="account-settings-actions">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => {
                setDraft(saved);
                setError('');
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        )}
      </form>
    </>
  );
}

export function AccountSettings({
  account,
  open,
  initialTab,
  onOpenChange,
  onName,
  returnFocus,
}: {
  account: AccountControls;
  open: boolean;
  initialTab: AccountTab;
  onOpenChange(open: boolean): void;
  onName(name: string): Promise<void>;
  returnFocus(): HTMLElement | null;
}) {
  const tabs: AccountTab[] = account.local
    ? ['Appearance', 'Preferences']
    : ['Profile', 'Appearance', 'Preferences'];
  const selectedTab = tabs.includes(initialTab) ? initialTab : 'Appearance';
  const [tab, setTab] = useState<AccountTab>(selectedTab);
  const [name, setName] = useState(account.user.name);
  const [error, setError] = useState('');
  const active = useRef(false);
  const id = useId();
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (open) {
      setTab(selectedTab);
      setName(account.user.name);
      setError('');
    }
  }, [open, selectedTab, account.user.id]);
  useEffect(() => setName(account.user.name), [account.user.name]);
  async function saveName(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || account.saving) return;
    setError('');
    try {
      await onName(name.trim());
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="account-settings"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocus();
          if (target?.isConnected) {
            event.preventDefault();
            target.focus({ preventScroll: true });
          }
        }}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <div className="account-settings-layout">
          <nav role="tablist" aria-label="Settings" aria-orientation="vertical">
            {tabs.map((value, index) => {
              const Icon =
                value === 'Profile' ? UserRound : value === 'Appearance' ? Sun : SlidersHorizontal;
              return (
                <button
                  key={value}
                  id={`${id}-${value}`}
                  type="button"
                  role="tab"
                  aria-selected={value === tab}
                  aria-label={value}
                  title={value}
                  aria-controls={`${id}-content`}
                  tabIndex={value === tab ? 0 : -1}
                  onClick={() => {
                    setTab(value);
                    setError('');
                  }}
                  onKeyDown={(event) => {
                    const next =
                      event.key === 'ArrowDown' || event.key === 'ArrowRight'
                        ? (index + 1) % tabs.length
                        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
                          ? (index - 1 + tabs.length) % tabs.length
                          : event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? tabs.length - 1
                              : null;
                    if (next === null) return;
                    event.preventDefault();
                    setTab(tabs[next]);
                    setError('');
                    document.getElementById(`${id}-${tabs[next]}`)?.focus();
                  }}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>{value}</span>
                </button>
              );
            })}
          </nav>
          <div
            className="account-settings-pane"
            id={`${id}-content`}
            role="tabpanel"
            aria-labelledby={`${id}-${tab}`}
          >
            <header className="account-settings-header">
              <h3>{tab}</h3>
            </header>
            <div key={tab} className="account-settings-body" tabIndex={0}>
              {!account.local && tab === 'Profile' && (
                <form className="account-profile-form" onSubmit={(event) => void saveName(event)}>
                  <div className="account-profile-identity">
                    <AccountAvatar user={account.user} large />
                    <Field label="Display name">
                      <Input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        required
                        maxLength={80}
                        autoComplete="name"
                        disabled={account.saving}
                      />
                    </Field>
                  </div>
                  {account.user.email && (
                    <div className="account-profile-email">
                      <span>Email</span>
                      <div>
                        <GoogleMark />
                        <span>{account.user.email}</span>
                      </div>
                    </div>
                  )}
                  {error && <Notice>{error}</Notice>}
                  {name.trim() !== account.user.name && (
                    <div className="account-settings-actions">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={account.saving}
                        onClick={() => {
                          setName(account.user.name);
                          setError('');
                        }}
                      >
                        Cancel
                      </Button>
                      <Button type="submit" disabled={account.saving || !name.trim()}>
                        {account.saving ? 'Saving…' : 'Save changes'}
                      </Button>
                    </div>
                  )}
                </form>
              )}
              {tab === 'Appearance' && (
                <>
                  <div className="account-theme-previews" role="group" aria-label="Theme">
                    {(['light', 'dark', 'system'] as AccountTheme[]).map((theme) => {
                      const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
                      const label = theme[0].toUpperCase() + theme.slice(1);
                      return (
                        <button
                          key={theme}
                          type="button"
                          aria-label={`${label} theme`}
                          aria-pressed={account.theme === theme}
                          disabled={account.saving}
                          onClick={() => {
                            setError('');
                            void account.onTheme(theme).catch((cause) => {
                              if (active.current) setError(errorMessage(cause));
                            });
                          }}
                        >
                          <span className={`account-theme-sample ${theme}`} aria-hidden="true">
                            <i>
                              <em />
                              <em />
                              <em />
                            </i>
                            <span>
                              <b />
                              <b />
                              <b />
                              <em />
                            </span>
                          </span>
                          <span className="account-theme-label">
                            <Icon size={15} aria-hidden="true" />
                            {label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {error && <Notice>{error}</Notice>}
                </>
              )}
              {tab === 'Preferences' && <PreferencesForm />}
            </div>
          </div>
          {account.canLogout && (
            <div className="account-settings-signout">
              <button
                type="button"
                aria-label="Sign out"
                title="Sign out"
                onClick={account.onLogout}
              >
                <LogOut size={16} aria-hidden="true" />
                <span>Sign out</span>
              </button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
