import { ModelSettings } from './models';
import { useEffect, useId, useRef, useState } from 'react';
import {
  Brain,
  ChartColumn,
  Clock3,
  KeyRound,
  Globe,
  MessageSquareText,
  MapPin,
  Plug,
  Monitor,
  Moon,
  Settings,
  SlidersHorizontal,
  Sun,
} from 'lucide-react';
import type { AccountPreferences, AccountTheme } from '../../shared/account';
import type { HourCycle } from '../../shared/contracts';
import type { AccountControls, AccountTab } from './account-menu';
import { Button, Field, Input, Loading, Notice, Switch } from './ui';
import { usePageData } from '../hooks/use-page-data';
import { errorMessage } from '../lib/api';
import { captureAnalytics, type AnalyticsProperties } from '../lib/analytics';
import { posthogConfig } from '../../shared/analytics';
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
import { desktopSettingsAvailable, removeDesktopData } from '../lib/desktop';
import { DesktopOptions, useDesktopSettings } from './desktop-settings';
import { ConnectionSettings } from './connection-choice';
import { Memory } from '../pages/memory';

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

function LanguageAndRegion({
  saved,
  onBusyChange,
}: {
  saved: AccountPreferences;
  onBusyChange(busy: boolean): void;
}) {
  const heading = useId();
  const regionLabel = useId();
  const clockLabel = useId();
  const timeZoneLabel = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    onBusyChange(saving);
    return () => onBusyChange(false);
  }, [saving, onBusyChange]);
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
      <h4 id={heading} data-analytics-public>
        Date and time
      </h4>
      <div className="account-preference-row account-picker-row">
        <span id={regionLabel} data-analytics-public>
          <MapPin size={16} aria-hidden="true" />
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
        <span id={clockLabel} data-analytics-public>
          <Clock3 size={16} aria-hidden="true" />
          Clock
        </span>
        <div className="account-clock-options" role="group" aria-labelledby={clockLabel}>
          {clockOptions.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={saved.hourCycle === option.value ? 'secondary' : 'ghost'}
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
        <span id={timeZoneLabel} data-analytics-public>
          <Globe size={16} aria-hidden="true" />
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

function PreferencesForm({ onDirtyChange }: { onDirtyChange(dirty: boolean): void }) {
  const {
    data,
    loading,
    error: loadError,
    refresh,
  } = usePageData<AccountPreferences>('/api/preferences');
  const [draft, setDraft] = useState<AccountPreferences | null>(null);
  const [saving, setSaving] = useState(false);
  const [regionBusy, setRegionBusy] = useState(false);
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
  const dirty = Boolean(
    data && draft && editablePreferences.some((key) => draft[key] !== data[key]),
  );
  useEffect(() => {
    onDirtyChange(dirty || saving || regionBusy);
    return () => onDirtyChange(false);
  }, [dirty, saving, regionBusy, onDirtyChange]);
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
      <LanguageAndRegion saved={saved} onBusyChange={setRegionBusy} />
      <form onSubmit={(event) => void save(event)}>
        <div className="account-preference-row">
          <div className="account-preference-label">
            <Moon size={16} aria-hidden="true" />
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
  openRequest,
  onOpenChange,
  onReplayOnboarding,
  onTabChange,
}: {
  account: AccountControls;
  open: boolean;
  initialTab: AccountTab;
  openRequest: number;
  onOpenChange(open: boolean): void;
  onReplayOnboarding?(): void;
  onTabChange?(tab: AccountTab, replace?: boolean): void;
}) {
  const desktop = desktopSettingsAvailable();
  const native = useDesktopSettings(desktop && open);
  const tabs: AccountTab[] = ['General', 'Models', 'App connections', 'Memory'];
  const selectedTab = tabs.includes(initialTab) ? initialTab : 'General';
  const [tab, setTab] = useState<AccountTab>(selectedTab);
  const [modelDirty, setModelDirty] = useState(false);
  const [preferencesDirty, setPreferencesDirty] = useState(false);
  const [connectionDirty, setConnectionDirty] = useState(false);
  const pending = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  pending.current =
    modelDirty || preferencesDirty || connectionDirty || native.busy || account.saving;
  const [error, setError] = useState('');
  const close = () => {
    if (pending.current) setError('Save or cancel your changes first.');
    else onOpenChange(false);
  };
  const active = useRef(false);
  const recordedTab = useRef<string | null>(null);
  function recordTab(value: AccountTab) {
    const key = `${openRequest}:${value}`;
    if (recordedTab.current === key) return;
    recordedTab.current = key;
    captureAnalytics('nod_settings_viewed', {
      tab: value
        .toLowerCase()
        .replace(' ', '_') as AnalyticsProperties<'nod_settings_viewed'>['tab'],
    });
  }
  const id = useId();
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (open) {
      if (pending.current) {
        if (selectedTab !== tab) onTabChange?.(tab, true);
        setError('Save or cancel your changes first.');
        return;
      }
      setTab(selectedTab);
      recordTab(selectedTab);
      setError('');
    }
  }, [open, selectedTab, openRequest, account.user.id]);
  function changeTab(value: AccountTab) {
    if (pending.current) {
      setError('Save or cancel your changes first.');
      return false;
    }
    setTab(value);
    onTabChange?.(value);
    recordTab(value);
    setError('');
    return true;
  }
  useEffect(() => {
    if (open) heading.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (pending.current) event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  const theme = desktop ? native.settings?.theme : account.theme;
  const themeSaving = desktop ? native.busy || !native.settings : account.saving;
  return (
    <section
      className="account-settings settings-page"
      hidden={!open}
      aria-labelledby={`${id}-heading`}
    >
      <div className="page-title-row">
        <h1
          className="page-title"
          id={`${id}-heading`}
          ref={heading}
          tabIndex={-1}
          data-analytics-public
        >
          <Settings size={24} aria-hidden="true" />
          Settings
        </h1>
      </div>
      <div className="account-settings-layout">
        <nav role="tablist" aria-label="Settings" aria-orientation="vertical" data-analytics-public>
          {tabs.map((value, index) => {
            const Icon =
              value === 'Models'
                ? KeyRound
                : value === 'App connections'
                  ? Plug
                  : value === 'Memory'
                    ? Brain
                    : SlidersHorizontal;
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
                onClick={() => changeTab(value)}
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
                  if (changeTab(tabs[next]))
                    document.getElementById(`${id}-${tabs[next]}`)?.focus();
                }}
              >
                <Icon size={24} aria-hidden="true" />
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
          <header className="account-settings-header" data-analytics-public>
            <h3>{tab}</h3>
          </header>
          <div key={tab} className="account-settings-body" tabIndex={0}>
            {tab === 'General' && (
              <>
                {desktop && native.error && (
                  <Notice>
                    {native.error}{' '}
                    {!native.settings && (
                      <Button variant="ghost" size="sm" onClick={() => void native.refresh()}>
                        Try again
                      </Button>
                    )}
                  </Notice>
                )}
                <div
                  className="account-theme-previews"
                  role="group"
                  aria-label="Theme"
                  data-analytics-public
                >
                  {(['light', 'dark', 'system'] as AccountTheme[]).map((value) => {
                    const Icon = value === 'light' ? Sun : value === 'dark' ? Moon : Monitor;
                    const label = value[0].toUpperCase() + value.slice(1);
                    return (
                      <button
                        key={value}
                        type="button"
                        aria-label={`${label} theme`}
                        aria-pressed={theme === value}
                        disabled={themeSaving}
                        onClick={() => {
                          setError('');
                          void (
                            desktop ? native.save({ theme: value }) : account.onTheme(value)
                          ).catch((cause) => {
                            if (!desktop && active.current) setError(errorMessage(cause));
                          });
                        }}
                      >
                        <span className={`account-theme-sample ${value}`} aria-hidden="true">
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
                          <Icon size={16} aria-hidden="true" />
                          {label}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {desktop && native.settings && (
                  <DesktopOptions
                    settings={native.settings}
                    busy={native.busy}
                    onChange={native.save}
                  />
                )}
                <PreferencesForm onDirtyChange={setPreferencesDirty} />
                <section className="account-region" aria-labelledby={`${id}-privacy`}>
                  <h4 id={`${id}-privacy`} data-analytics-public>
                    Privacy
                  </h4>
                  <div className="account-preference-row">
                    <span data-analytics-public>
                      <ChartColumn size={16} aria-hidden="true" />
                      Share usage data
                    </span>
                    <Switch
                      checked={account.usageData}
                      disabled={account.saving}
                      aria-label="Share usage data"
                      aria-describedby={`${id}-usage-data`}
                      onCheckedChange={(usageData) => {
                        setError('');
                        void account.onUsageData(usageData).catch((cause) => {
                          if (active.current) setError(errorMessage(cause));
                        });
                      }}
                    />
                  </div>
                  <p id={`${id}-usage-data`} className="field-hint" data-analytics-public>
                    Help us make nod better by sharing how you use it. Never your messages.{' '}
                    <a href={posthogConfig.docsUrl} target="_blank" rel="noreferrer">
                      What’s shared
                    </a>
                  </p>
                  {account.traces !== undefined && (
                    <>
                      <div className="account-preference-row">
                        <span data-analytics-public>
                          <MessageSquareText size={16} aria-hidden="true" />
                          Share conversation traces
                        </span>
                        <Switch
                          checked={account.traces}
                          disabled={account.saving}
                          aria-label="Share conversation traces"
                          aria-describedby={`${id}-traces`}
                          onCheckedChange={(traces) => {
                            setError('');
                            void account.onTraces(traces).catch((cause) => {
                              if (active.current) setError(errorMessage(cause));
                            });
                          }}
                        />
                      </div>
                      <p id={`${id}-traces`} className="field-hint" data-analytics-public>
                        Send nod’s conversations, including what it reads and does, to the nod team
                        at n8n to improve nod. Your name, email addresses, phone numbers, card
                        numbers and IBANs are removed first, and traces carry no account or device
                        ID. Kept for 14 days and never used to train AI models.
                      </p>
                    </>
                  )}
                  {desktop && (
                    <Button
                      className="account-remove-data"
                      variant="destructive"
                      size="sm"
                      disabled={pending.current}
                      onClick={() => {
                        setError('');
                        void removeDesktopData().catch((cause) => {
                          if (active.current) setError(errorMessage(cause));
                        });
                      }}
                    >
                      Remove all data
                    </Button>
                  )}
                </section>
              </>
            )}
            {tab === 'Memory' && (
              <Memory
                onDone={() => {
                  close();
                }}
              />
            )}
            {tab === 'App connections' && <ConnectionSettings onDirtyChange={setConnectionDirty} />}
            {tab === 'Models' && (
              <>
                <ModelSettings onDirtyChange={desktop ? setModelDirty : undefined} />
              </>
            )}
            {onReplayOnboarding && tab === 'General' && (
              <Button variant="outline" disabled={pending.current} onClick={onReplayOnboarding}>
                Replay onboarding
              </Button>
            )}
            {error && <Notice>{error}</Notice>}
          </div>
        </div>
      </div>
    </section>
  );
}
