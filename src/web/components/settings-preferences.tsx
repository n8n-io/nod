import { useEffect, useId, useRef, useState } from 'react';
import type { AccountPreferences, AccountTheme } from '../../shared/account';
import type { HourCycle } from '../../shared/contracts';
import type { AccountControls } from './account-menu';
import type { useDesktopSettings } from './desktop-settings';
import { Check, Minus, Monitor, Moon, Plus, Sun } from './icons';
import { Button, Loading, Notice, Switch } from './ui';
import { SearchPicker } from './search-picker';
import { TimeZonePicker } from './time-zone-picker';
import { TimePicker } from './time-picker';
import { useSettingsDraft } from './settings-drafts';
import { usePageData } from '../hooks/use-page-data';
import { errorMessage } from '../lib/api';
import { desktopZoomAvailable, getDesktopZoomFactor, setDesktopZoomFactor } from '../lib/desktop';
import { savePreferences } from '../lib/preferences';
import { localeRegion } from '../../shared/date-locale';
import { communityLinks, legalLinks } from '../../shared/onboarding';
import {
  dateFormatFrom,
  formatCalendarDate,
  formatClockTime,
  dayKey,
  formatTime,
  regionLocale,
  regions,
  useBrowserRegion,
  usesTwelveHourClock,
} from '../lib/date-format';

const quietKeys = ['quietHoursEnabled', 'quietStart', 'quietEnd', 'proactivePaused'] as const;
const clocks: Array<{ value: HourCycle; label: string }> = [
  { value: 'auto', label: 'Automatic' },
  { value: 'h12', label: '12-hour' },
  { value: 'h23', label: '24-hour' },
];
const regionLabels = {
  choose: 'Choose region',
  search: 'Search regions',
  placeholder: 'Search country or region',
  clear: 'Clear region search',
  list: 'Regions',
  empty: 'No regions found.',
};
const fontSizeSteps = [0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

function ThemePreview({ theme }: { theme: AccountTheme }) {
  return (
    <span className={`account-theme-sample ${theme}`} aria-hidden="true">
      {(theme === 'system' ? ['light', 'dark'] : [theme]).map((appearance) => (
        <span className={`account-theme-scene ${appearance}`} key={appearance}>
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
      ))}
    </span>
  );
}

function FontSizeControls() {
  const id = useId();
  const [factor, setFactor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const revision = useRef(0);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (pending.current) return;
      const current = ++revision.current;
      void getDesktopZoomFactor().then(
        (value) => {
          if (active && revision.current === current) {
            setFactor(value);
            setError('');
          }
        },
        (cause) => {
          if (active && revision.current === current) {
            setFactor(null);
            setError(errorMessage(cause));
          }
        },
      );
    };
    refresh();
    window.addEventListener('resize', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      window.removeEventListener('resize', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  async function change(value: number) {
    if (pending.current) return;
    pending.current = true;
    const current = ++revision.current;
    setBusy(true);
    setError('');
    try {
      const saved = await setDesktopZoomFactor(value);
      if (revision.current === current) setFactor(saved);
    } catch (cause) {
      if (revision.current === current) {
        setError(errorMessage(cause));
        try {
          const actual = await getDesktopZoomFactor();
          if (revision.current === current) setFactor(actual);
        } catch {
          if (revision.current === current) setFactor(null);
        }
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const percent = factor === null ? null : Math.round(factor * 100);
  const smaller =
    percent === null
      ? undefined
      : [...fontSizeSteps].reverse().find((value) => Math.round(value * 100) < percent);
  const larger =
    percent === null ? undefined : fontSizeSteps.find((value) => Math.round(value * 100) > percent);
  return (
    <>
      <div className="account-preference-row account-font-size">
        <span id={id}>Font size</span>
        <div className="account-font-size-actions" role="group" aria-labelledby={id}>
          <div className="settings-segmented account-font-size-stepper">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Decrease font size"
              disabled={busy || smaller === undefined}
              onClick={() => {
                if (smaller !== undefined) void change(smaller);
              }}
            >
              <Minus size={16} aria-hidden="true" />
            </Button>
            <output aria-live="polite">{percent === null ? '—' : `${percent}%`}</output>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Increase font size"
              disabled={busy || larger === undefined}
              onClick={() => {
                if (larger !== undefined) void change(larger);
              }}
            >
              <Plus size={16} aria-hidden="true" />
            </Button>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="Reset font size to 100%"
            disabled={busy || factor === null || Math.abs(factor - 1) < 0.001}
            onClick={() => void change(1)}
          >
            Reset
          </Button>
        </div>
      </div>
      {error && <Notice>{error}</Notice>}
    </>
  );
}

export function GeneralPreferences({
  account,
  native,
  desktop,
}: {
  account: AccountControls;
  native: ReturnType<typeof useDesktopSettings>;
  desktop: boolean;
}) {
  const {
    data,
    loading,
    error: loadError,
    refresh,
  } = usePageData<AccountPreferences>('/api/preferences');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const active = useRef(true);
  const id = useId();
  const detected = useBrowserRegion();
  const [example] = useState(() => new Date());
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);
  useSettingsDraft('general', { changes: [], busy, save: async () => !busy, discard: () => {} });
  async function save(change: Partial<AccountPreferences>) {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError('');
    try {
      await savePreferences(change, request.signal);
    } catch (cause) {
      if (!request.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (controller.current === request) {
        controller.current = null;
        if (!request.signal.aborted) setBusy(false);
      }
    }
  }
  const theme = desktop ? native.settings?.theme : account.theme;
  const themeBusy = desktop ? native.busy || !native.settings : account.saving;
  const region = data ? (localeRegion(data.locale) ?? 'auto') : 'auto';
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const regionOptions = [
    {
      value: 'auto',
      label: `Automatic (${names.of(detected) ?? detected})`,
      keywords: `location ${detected}`,
    },
    ...[...new Set([region, detected, ...regions])]
      .filter((value) => value !== 'auto')
      .map((value) => ({ value, label: names.of(value) ?? value, keywords: value }))
      .sort((a, b) => a.label.localeCompare(b.label, 'en')),
  ];
  const format = data ? dateFormatFrom(data) : null;
  const zones = format
    ? [...new Set([format.timeZone, ...(Intl.supportedValuesOf?.('timeZone') ?? [])])].sort()
    : [];
  return (
    <>
      <section className="account-region" aria-labelledby={`${id}-appearance`}>
        <h3 id={`${id}-appearance`}>Appearance</h3>
        <div className="account-theme-previews" role="group" aria-label="Theme">
          {(['system', 'light', 'dark'] as AccountTheme[]).map((value) => {
            const Icon = value === 'system' ? Monitor : value === 'light' ? Sun : Moon;
            const label = value[0].toUpperCase() + value.slice(1);
            return (
              <button
                key={value}
                type="button"
                aria-label={`${label} theme`}
                aria-pressed={theme === value}
                disabled={themeBusy}
                onClick={() => {
                  setError('');
                  void (desktop ? native.save({ theme: value }) : account.onTheme(value)).catch(
                    (cause) => {
                      if (active.current) setError(errorMessage(cause));
                    },
                  );
                }}
              >
                <ThemePreview theme={value} />
                <span className="account-theme-label">
                  <Icon size={18} aria-hidden="true" />
                  {label}
                  <span className="account-theme-check">
                    {theme === value && <Check size={14} aria-hidden="true" />}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {desktop && desktopZoomAvailable() && <FontSizeControls />}
      </section>
      <section className="account-region" aria-labelledby={`${id}-date`}>
        <header className="settings-subheading">
          <h3 id={`${id}-date`}>Date & time</h3>
          {format && (
            <time
              className="settings-date-example"
              dateTime={example.toISOString()}
              aria-label="Date and time example"
            >
              <span>{formatCalendarDate(dayKey(example, format), format)}</span>
              <span>{formatTime(example, format)}</span>
            </time>
          )}
        </header>
        {data && format ? (
          <>
            <div className="account-preference-row">
              <label id={`${id}-region`}>Region</label>
              <SearchPicker
                value={region}
                options={regionOptions}
                labels={regionLabels}
                labelledBy={`${id}-region`}
                disabled={busy}
                onChange={(value) => {
                  if (value !== region)
                    void save({ locale: value === 'auto' ? null : regionLocale(value) });
                }}
              />
            </div>
            <p className="field-hint">Date and number formatting.</p>
            <div className="account-preference-row">
              <span id={`${id}-clock`}>Clock</span>
              <div className="settings-segmented" role="group" aria-labelledby={`${id}-clock`}>
                {clocks.map((option) => (
                  <Button
                    key={option.value}
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-pressed={data.hourCycle === option.value}
                    onClick={() => {
                      if (data.hourCycle !== option.value) void save({ hourCycle: option.value });
                    }}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>
            <div className="account-preference-row">
              <span id={`${id}-zone`}>Time zone</span>
              <TimeZonePicker
                value={format.timeZone}
                zones={zones}
                labelledBy={`${id}-zone`}
                disabled={busy}
                onChange={(timeZone) => {
                  if (timeZone !== data.timeZone) void save({ timeZone });
                }}
              />
            </div>
            <p className="field-hint">Used for schedules and quiet hours.</p>
          </>
        ) : loading ? (
          <Loading />
        ) : (
          <Notice>
            {loadError || 'Date and time settings could not be loaded.'}
            <Button variant="ghost" size="sm" onClick={() => void refresh()}>
              Try again
            </Button>
          </Notice>
        )}
      </section>
      {desktop && native.settings && (
        <section className="account-region">
          <div className="account-preference-row">
            <span>Open at login</span>
            <Switch
              checked={native.settings.launchAtLogin}
              disabled={native.busy}
              aria-label="Open at login"
              onCheckedChange={(launchAtLogin) =>
                void native.save({ launchAtLogin }).catch(() => {})
              }
            />
          </div>
          <p className="field-hint">Open automatically when you sign in.</p>
        </section>
      )}
      <section className="account-region account-links" aria-labelledby={`${id}-community`}>
        <h3 id={`${id}-community`}>Community</h3>
        <p className="field-hint">
          Talk with other Nod users on{' '}
          <a href={communityLinks.discord} target="_blank" rel="noreferrer">
            Discord
          </a>{' '}
          or share ideas in the{' '}
          <a href={communityLinks.forum} target="_blank" rel="noreferrer">
            n8n Labs forum
          </a>
          .
        </p>
      </section>
      <section className="account-region account-links" aria-labelledby={`${id}-legal`}>
        <h3 id={`${id}-legal`}>Legal</h3>
        <p className="field-hint">
          <a href={legalLinks.terms} target="_blank" rel="noreferrer">
            Terms of Use
          </a>
          {' · '}
          <a href={legalLinks.privacy} target="_blank" rel="noreferrer">
            Privacy policy
          </a>
        </p>
      </section>
      {error && <Notice>{error}</Notice>}
    </>
  );
}

export function QuietHours() {
  const {
    data,
    loading,
    error: loadError,
    refresh,
  } = usePageData<AccountPreferences>('/api/preferences');
  const [draft, setDraft] = useState<AccountPreferences | null>(null);
  const previous = useRef<AccountPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const id = useId();
  useEffect(() => {
    if (!data) return;
    const baseline = previous.current;
    setDraft((current) =>
      !current || !baseline
        ? data
        : {
            ...data,
            ...Object.fromEntries(
              quietKeys
                .filter((key) => current[key] !== baseline[key])
                .map((key) => [key, current[key]]),
            ),
          },
    );
    previous.current = data;
  }, [data]);
  useEffect(() => () => request.current?.abort(), []);
  const format = data ? dateFormatFrom(data) : null;
  const changes =
    !data || !draft || !format
      ? []
      : [
          {
            label: 'Automatic preparation',
            before: data.proactivePaused ? 'Off' : 'On',
            after: draft.proactivePaused ? 'Off' : 'On',
          },
          {
            label: 'Quiet hours',
            before: data.quietHoursEnabled ? 'On' : 'Off',
            after: draft.quietHoursEnabled ? 'On' : 'Off',
          },
          {
            label: 'From',
            before: formatClockTime(data.quietStart, format),
            after: formatClockTime(draft.quietStart, format),
          },
          {
            label: 'Until',
            before: formatClockTime(data.quietEnd, format),
            after: formatClockTime(draft.quietEnd, format),
          },
        ].filter((change) => change.before !== change.after);
  async function save() {
    if (!data || !draft || request.current) return false;
    const current = draft;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const saved = await savePreferences(
        Object.fromEntries(
          quietKeys.filter((key) => current[key] !== data[key]).map((key) => [key, current[key]]),
        ),
        controller.signal,
      );
      if (controller.signal.aborted) return false;
      setDraft((latest) =>
        !latest
          ? saved
          : {
              ...saved,
              ...Object.fromEntries(
                quietKeys
                  .filter((key) => latest[key] !== current[key])
                  .map((key) => [key, latest[key]]),
              ),
            },
      );
      return true;
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
      return false;
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  }
  const discard = () => {
    if (!busy) {
      setDraft(data ?? null);
      setError('');
    }
  };
  useSettingsDraft('notifications', { changes, busy, save, discard });
  if (!data || !draft || !format)
    return loading ? (
      <Loading />
    ) : (
      <Notice>
        {loadError || 'Quiet hours could not be loaded.'}
        <Button variant="ghost" size="sm" onClick={() => void refresh()}>
          Try again
        </Button>
      </Notice>
    );
  return (
    <>
      <section className="account-region" aria-labelledby={`${id}-preparation`}>
        <div className="account-preference-row">
          <span id={`${id}-preparation`}>Automatic preparation</span>
          <Switch
            checked={!draft.proactivePaused}
            aria-labelledby={`${id}-preparation`}
            disabled={busy}
            onCheckedChange={(enabled) => setDraft({ ...draft, proactivePaused: !enabled })}
          />
        </div>
        <p className="field-hint">
          Prepare useful work from app changes. Spends from a $5 monthly allowance by default.
          Change it in Usage. Turning this off also pauses automatic email checks.
        </p>
      </section>
      <section className="account-region account-quiet-hours" aria-labelledby={`${id}-heading`}>
        <div className="account-preference-row">
          <span id={`${id}-heading`}>Quiet hours</span>
          <Switch
            checked={draft.quietHoursEnabled}
            aria-labelledby={`${id}-heading`}
            disabled={busy}
            onCheckedChange={(quietHoursEnabled) => setDraft({ ...draft, quietHoursEnabled })}
          />
        </div>
        <p className="field-hint">
          Pause routine preparation and notifications during these hours.
        </p>
        <div
          className="account-quiet-times"
          data-cycle={usesTwelveHourClock(format) ? 'h12' : 'h23'}
        >
          <TimePicker
            id={`${id}-start`}
            label="From"
            format={format}
            value={draft.quietStart}
            savedValue={data.quietStart}
            changed={draft.quietStart !== data.quietStart}
            disabled={busy || !draft.quietHoursEnabled}
            onChange={(quietStart) => setDraft({ ...draft, quietStart })}
          />
          <TimePicker
            id={`${id}-end`}
            label="Until"
            format={format}
            value={draft.quietEnd}
            savedValue={data.quietEnd}
            changed={draft.quietEnd !== data.quietEnd}
            disabled={busy || !draft.quietHoursEnabled}
            onChange={(quietEnd) => setDraft({ ...draft, quietEnd })}
          />
        </div>
        {error && <Notice>{error}</Notice>}
      </section>
    </>
  );
}
