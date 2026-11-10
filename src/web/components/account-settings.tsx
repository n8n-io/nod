import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Bell,
  Brain,
  Ellipsis,
  KeyRound,
  Mic,
  Settings,
  ShieldCheck,
} from './icons';
import type { AccountControls, AccountTab } from './account-menu';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Notice,
  Switch,
} from './ui';
import { DataSharing } from './data-sharing';
import { ModelSettings } from './models';
import { VoiceSettings } from './voice-settings';
import { Memory, type MemoryNavigationState } from '../pages/memory';
import { GeneralPreferences, QuietHours } from './settings-preferences';
import { SettingsDraftContext, useSettingsDrafts } from './settings-drafts';
import { ActionMenu, ActionMenuItem } from './action-menu';
import { BrowserNotificationSettings } from './browser-notifications';
import { useDesktopSettings } from './desktop-settings';
import {
  desktopRuntimeAvailable,
  desktopSettingsAvailable,
  removeDesktopData,
} from '../lib/desktop';
import { guardNavigation } from '../lib/navigation';
import { captureAnalytics, type AnalyticsProperties } from '../lib/analytics';
import { errorMessage } from '../lib/api';

export const settingsSections = [
  { id: 'general', label: 'General', path: '/settings', icon: Settings },
  { id: 'notifications', label: 'Notifications', path: '/settings/notifications', icon: Bell },
  { id: 'models', label: 'Models', path: '/settings/models', icon: KeyRound },
  { id: 'voice', label: 'Voice & audio', path: '/settings/voice', icon: Mic },
  { id: 'memory', label: 'Memory', path: '/settings/memory', icon: Brain },
  { id: 'privacy', label: 'Privacy & data', path: '/settings/privacy', icon: ShieldCheck },
] as const;

export function isSettingsPage(path: string) {
  return settingsSections.some((section) => section.path === path);
}

export function AccountSettings({
  account,
  open,
  initialTab,
  openRequest,
  onOpenChange,
  onReplayOnboarding,
  onTabChange,
  onOpenSource,
}: {
  account: AccountControls;
  open: boolean;
  initialTab: AccountTab;
  openRequest: number;
  onOpenChange(open: boolean): void;
  onReplayOnboarding?(): void;
  onTabChange?(tab: AccountTab, replace?: boolean): void;
  onOpenSource?(messageId: string): void;
}) {
  const id = useId();
  const desktop = desktopSettingsAvailable();
  const native = useDesktopSettings(desktop && open);
  const { drafts, register } = useSettingsDrafts();
  const selected =
    settingsSections.find((section) => section.label === initialTab) ?? settingsSections[0];
  const [section, setSection] = useState<string>(selected.id);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [review, setReview] = useState(false);
  const [error, setError] = useState('');
  const [privacyError, setPrivacyError] = useState('');
  const [removing, setRemoving] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const jumped = useRef<{ target: string; top: number } | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const reviewTitle = useRef<HTMLHeadingElement>(null);
  const exitAction = useRef<(() => void) | null>(null);
  const memorySourceView = useRef<{ ownerId: string; view: MemoryNavigationState } | null>(null);
  const allowExit = useRef(false);
  const active = useRef(true);
  const current = useRef({ drafts, busy: false });
  const busy =
    saving ||
    voiceBusy ||
    native.busy ||
    account.saving ||
    removing ||
    drafts.some((draft) => draft.busy);
  current.current = { drafts, busy };
  const changed = drafts.filter((draft) => draft.changes.length);
  const changes = changed.flatMap((draft) => draft.changes);
  const recorded = useRef('');
  const runExit = useCallback((action: () => void) => {
    allowExit.current = true;
    action();
    queueMicrotask(() => {
      allowExit.current = false;
    });
  }, []);
  const requestExit = useCallback(
    (action: () => void) => {
      if (current.current.busy) {
        setError('Wait for the current change to finish.');
        return false;
      }
      if (current.current.drafts.some((draft) => draft.changes.length)) {
        exitAction.current = action;
        setReview(true);
        return false;
      }
      runExit(action);
      return true;
    },
    [runExit],
  );
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    return guardNavigation((path, proceed) => {
      if (allowExit.current || isSettingsPage(path.split(/[?#]/, 1)[0])) return true;
      if (!current.current.busy && !current.current.drafts.some((draft) => draft.changes.length))
        return true;
      requestExit(proceed);
      return false;
    });
  }, [open, requestExit]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (
        open &&
        (current.current.busy || current.current.drafts.some((draft) => draft.changes.length))
      )
        event.preventDefault();
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const overlays = document.querySelectorAll<HTMLElement>(
        '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="combobox"][aria-expanded="true"], dialog[open]',
      );
      if (
        [...overlays].some(
          (overlay) =>
            !overlay.closest('[hidden], [inert]') &&
            overlay.dataset.state !== 'closed' &&
            overlay.getClientRects().length &&
            getComputedStyle(overlay).visibility !== 'hidden',
        )
      )
        return;
      event.preventDefault();
      requestExit(() => onOpenChange(false));
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [open, onOpenChange, requestExit]);
  function jump(target: string, smooth = false, focus = true) {
    const scroller = content.current;
    const heading = document.getElementById(`${id}-${target}`);
    if (!scroller || !heading) return;
    const top = Math.max(
      0,
      Math.min(
        heading.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop -
          32,
        scroller.scrollHeight - scroller.clientHeight,
      ),
    );
    jumped.current = { target, top };
    scroller.scrollTo({
      top,
      behavior:
        smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'smooth'
          : 'instant',
    });
    setSection(target);
    if (focus) heading.focus({ preventScroll: true });
  }
  useLayoutEffect(() => {
    if (!open) {
      setReview(false);
      exitAction.current = null;
      return;
    }
    setError('');
    memorySourceView.current = null;
    const frame = requestAnimationFrame(() => jump(selected.id));
    return () => cancelAnimationFrame(frame);
  }, [open, selected.id, openRequest]);
  useEffect(() => {
    const scroller = content.current;
    if (!open || !scroller) return;
    const release = () => {
      jumped.current = null;
    };
    const resized =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            if (jumped.current) jump(jumped.current.target, false, false);
          });
    for (const child of scroller.children) resized?.observe(child);
    const settings = scroller.closest('.account-settings') ?? scroller;
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    for (const name of events)
      settings.addEventListener(name, release, { passive: true, capture: true });
    return () => {
      resized?.disconnect();
      for (const name of events) settings.removeEventListener(name, release, { capture: true });
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const key = `${openRequest}:${section}`;
    if (recorded.current === key) return;
    recorded.current = key;
    captureAnalytics('settings_viewed', {
      tab: section as AnalyticsProperties<'settings_viewed'>['tab'],
    });
  }, [open, openRequest, section]);
  function trackScroll() {
    const scroller = content.current;
    if (!scroller) return;
    if (jumped.current && Math.abs(scroller.scrollTop - jumped.current.top) < 2)
      return setSection(jumped.current.target);
    const top = scroller.getBoundingClientRect().top;
    const reached = settingsSections.filter((candidate) => {
      const heading = document.getElementById(`${id}-${candidate.id}`);
      return heading && heading.getBoundingClientRect().top <= top + 108;
    });
    const atEnd = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 4;
    setSection(atEnd ? 'privacy' : (reached.at(-1)?.id ?? 'general'));
  }
  async function saveAll(leave: boolean) {
    if (current.current.busy) return;
    const pending = current.current.drafts.filter((draft) => draft.changes.length);
    setSaving(true);
    setError('');
    let success = true;
    for (const draft of pending) {
      const latest = current.current.drafts.find((entry) => entry.id === draft.id);
      if (!latest || latest.revision !== draft.revision) {
        if (latest?.changes.length) success = false;
        continue;
      }
      try {
        if (!(await draft.save())) success = false;
      } catch (cause) {
        success = false;
        if (active.current) setError(errorMessage(cause));
      }
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (!active.current) return;
    setSaving(false);
    if (!success || current.current.drafts.some((draft) => draft.changes.length)) {
      setError('Some changes still need attention. Your edits are kept.');
      return;
    }
    setReview(false);
    if (leave && exitAction.current) {
      const action = exitAction.current;
      exitAction.current = null;
      runExit(action);
    }
  }
  function discardAll(leave: boolean) {
    if (current.current.busy) return;
    for (const draft of current.current.drafts) draft.discard();
    setError('');
    setReview(false);
    if (leave && exitAction.current) {
      const action = exitAction.current;
      exitAction.current = null;
      runExit(action);
    }
  }
  const source = (messageId: string, view: MemoryNavigationState) =>
    requestExit(() => {
      memorySourceView.current = { ownerId: account.user.id, view };
      if (onOpenSource) onOpenSource(messageId);
      else window.dispatchEvent(new CustomEvent('nod:focus-message', { detail: { messageId } }));
    });
  return (
    <SettingsDraftContext.Provider value={register}>
      <section
        className="account-settings settings-page"
        hidden={!open}
        aria-labelledby={`${id}-heading`}
      >
        {open && (
          <>
            <aside className="settings-sidebar">
              <header>
                <h1 id={`${id}-heading`} ref={title} tabIndex={-1}>
                  Settings
                </h1>
                {onReplayOnboarding && (
                  <ActionMenu
                    label="Settings options"
                    trigger={
                      <Button variant="ghost" size="icon">
                        <Ellipsis size={18} />
                      </Button>
                    }
                    contentClassName="action-menu-compact"
                  >
                    {(close) => (
                      <ActionMenuItem
                        onClick={() => {
                          close();
                          requestExit(onReplayOnboarding);
                        }}
                      >
                        Replay onboarding
                      </ActionMenuItem>
                    )}
                  </ActionMenu>
                )}
              </header>
              <nav aria-label="Settings categories">
                {settingsSections.map(({ id: key, label, icon: Icon }) => (
                  <button
                    key={key}
                    type="button"
                    className="settings-nav-item"
                    aria-current={section === key ? 'location' : undefined}
                    onClick={() => {
                      jump(key, true);
                      onTabChange?.(label);
                    }}
                  >
                    <Icon size={20} aria-hidden="true" />
                    <span>{label}</span>
                    {changed.some((draft) => draft.id.toLowerCase().startsWith(key)) && (
                      <span className="settings-dirty-dot" aria-label="Unsaved changes" />
                    )}
                  </button>
                ))}
              </nav>
              <Button
                className="settings-back"
                variant="ghost"
                onClick={() => requestExit(() => onOpenChange(false))}
                title="Back"
                shortcut="Esc"
              >
                <ArrowLeft size={18} aria-hidden="true" />
                Back
              </Button>
            </aside>
            <div className="settings-main">
              <div className="settings-scroll" ref={content} onScroll={trackScroll}>
                <div className="account-settings-body">
                  {native.error && (
                    <Notice>
                      {native.error}
                      {!native.settings && (
                        <Button variant="ghost" size="sm" onClick={() => void native.refresh()}>
                          Try again
                        </Button>
                      )}
                    </Notice>
                  )}
                  <section className="settings-category" aria-labelledby={`${id}-general`}>
                    <h2 id={`${id}-general`} tabIndex={-1}>
                      General
                    </h2>
                    <GeneralPreferences account={account} native={native} desktop={desktop} />
                  </section>
                  <section className="settings-category" aria-labelledby={`${id}-notifications`}>
                    <h2 id={`${id}-notifications`} tabIndex={-1}>
                      Notifications
                    </h2>
                    {desktop ? (
                      <section className="account-region">
                        <div className="account-preference-row">
                          <span>Notifications</span>
                          <Switch
                            checked={native.settings?.notifications ?? false}
                            disabled={native.busy || !native.settings}
                            aria-label="Notifications"
                            onCheckedChange={(notifications) =>
                              void native.save({ notifications }).catch(() => {})
                            }
                          />
                        </div>
                        <p className="field-hint">
                          If they don’t appear, check your computer’s notification and Focus
                          settings.
                        </p>
                      </section>
                    ) : (
                      <BrowserNotificationSettings ownerId={account.user.id} />
                    )}
                    <QuietHours />
                  </section>
                  <section className="settings-category" aria-labelledby={`${id}-models`}>
                    <h2 id={`${id}-models`} tabIndex={-1}>
                      Models
                    </h2>
                    <ModelSettings />
                  </section>
                  <section className="settings-category" aria-labelledby={`${id}-voice`}>
                    <h2 id={`${id}-voice`} tabIndex={-1}>
                      Voice & audio
                    </h2>
                    <VoiceSettings onBusyChange={setVoiceBusy} />
                  </section>
                  <section
                    className="settings-category settings-memory"
                    aria-labelledby={`${id}-memory`}
                  >
                    <h2 id={`${id}-memory`} tabIndex={-1}>
                      Memory
                    </h2>
                    <Memory
                      onDone={() => requestExit(() => onOpenChange(false))}
                      onOpenSource={source}
                      initialView={
                        memorySourceView.current?.ownerId === account.user.id
                          ? memorySourceView.current.view
                          : undefined
                      }
                    />
                  </section>
                  <section
                    className="settings-category settings-privacy"
                    aria-labelledby={`${id}-privacy`}
                  >
                    <h2 id={`${id}-privacy`} tabIndex={-1}>
                      Privacy & data
                    </h2>
                    <DataSharing
                      className="settings-data-sharing"
                      usage={account.usageData}
                      traces={account.traces}
                    />
                    <section className="account-region">
                      <div className="account-preference-row">
                        <span>Share usage data</span>
                        <Switch
                          checked={account.usageData}
                          disabled={account.saving}
                          aria-label="Share usage data"
                          onCheckedChange={(usageData) => {
                            setPrivacyError('');
                            void account.onUsageData(usageData).catch((cause) => {
                              if (active.current) setPrivacyError(errorMessage(cause));
                            });
                          }}
                        />
                      </div>
                      <p className="field-hint">
                        Share how you use Nod, including your onboarding answers and your email if
                        you gave it, without your messages or screen recordings.
                      </p>
                    </section>
                    {account.traces !== undefined && (
                      <section className="account-region">
                        <div className="account-preference-row">
                          <span>Share conversation traces</span>
                          <Switch
                            checked={account.traces}
                            disabled={account.saving}
                            aria-label="Share conversation traces"
                            onCheckedChange={(traces) => {
                              setPrivacyError('');
                              void account.onTraces(traces).catch((cause) => {
                                if (active.current) setPrivacyError(errorMessage(cause));
                              });
                            }}
                          />
                        </div>
                        <p className="field-hint">Help improve replies.</p>
                        <p className="field-hint">
                          Kept for 14 days. Never used to train AI models.
                        </p>
                      </section>
                    )}
                    {desktopRuntimeAvailable() && (
                      <section className="account-region">
                        <div className="account-preference-row">
                          <span>Remove all data</span>
                          <Button
                            variant="destructive"
                            disabled={busy}
                            onClick={() =>
                              requestExit(() => {
                                setRemoving(true);
                                setPrivacyError('');
                                void removeDesktopData()
                                  .catch((cause) => {
                                    if (active.current) setPrivacyError(errorMessage(cause));
                                  })
                                  .finally(() => {
                                    if (active.current) setRemoving(false);
                                  });
                              })
                            }
                          >
                            Remove all data
                          </Button>
                        </div>
                        <p className="field-hint">
                          Erase the data on this computer and start setup again.
                        </p>
                      </section>
                    )}
                    {privacyError && <Notice>{privacyError}</Notice>}
                  </section>
                </div>
              </div>
              {(changes.length > 0 || error) && (
                <footer className="settings-save-bar">
                  <div>
                    {error ? (
                      <p className="settings-save-error" role="alert">
                        {error}
                      </p>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          exitAction.current = null;
                          setReview(true);
                        }}
                      >
                        {changes.length} unsaved {changes.length === 1 ? 'change' : 'changes'}
                      </Button>
                    )}
                  </div>
                  {changes.length > 0 && (
                    <div className="settings-save-actions">
                      <Button variant="ghost" disabled={busy} onClick={() => discardAll(false)}>
                        Discard
                      </Button>
                      <Button disabled={busy} onClick={() => void saveAll(false)}>
                        {saving ? 'Saving…' : 'Save changes'}
                      </Button>
                    </div>
                  )}
                </footer>
              )}
            </div>
          </>
        )}
      </section>
      <Dialog
        open={open && review}
        onOpenChange={(next) => {
          if (!saving) {
            setReview(next);
            if (!next) exitAction.current = null;
          }
        }}
      >
        <DialogContent
          className="settings-review-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            reviewTitle.current?.focus();
          }}
        >
          <DialogTitle ref={reviewTitle} tabIndex={-1}>
            {exitAction.current ? 'Save your changes?' : 'Unsaved changes'}
          </DialogTitle>
          <DialogDescription>
            {exitAction.current
              ? 'Review your edits before leaving Settings.'
              : 'These changes haven’t been saved.'}
          </DialogDescription>
          <dl className="settings-change-list">
            {changes.map((change, index) => (
              <div key={`${change.label}-${index}`}>
                <dt>{change.label}</dt>
                <dd>
                  <span>{change.before || 'Not set'}</span>
                  <ArrowUpRight size={14} aria-hidden="true" />
                  <strong>{change.after || 'Not set'}</strong>
                </dd>
              </div>
            ))}
          </dl>
          {error && <Notice>{error}</Notice>}
          <div className="dialog-actions">
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setReview(false);
                exitAction.current = null;
              }}
            >
              Keep editing
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => discardAll(Boolean(exitAction.current))}
            >
              Discard
            </Button>
            <Button disabled={busy} onClick={() => void saveAll(Boolean(exitAction.current))}>
              {saving ? 'Saving…' : exitAction.current ? 'Save and continue' : 'Save changes'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </SettingsDraftContext.Provider>
  );
}
