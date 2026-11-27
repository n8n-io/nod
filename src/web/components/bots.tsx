import {
  Suspense,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { Activity, Schedule, Task } from '../../shared/contracts';
import { botInstructionsLimit, botNameLimit } from '../../shared/bots';
import { api, errorMessage } from '../lib/api';
import { botActivity, botLine, botPath, type Bot } from '../lib/bots';
import { ChevronDown, ChevronRight, PanelLeftClose, PanelLeftOpen, Plus, Settings } from './icons';
import { usePageData } from '../hooks/use-page-data';
import { ScheduleRow } from '../pages/schedule';
import { TaskCard } from '../pages/tasks';
import { taskLabels } from '../../shared/task-status';
import { formatDateTime, formatTime, useDateFormat, type DateFormat } from '../lib/date-format';
import { BotModel } from './model-choices';
import { ModelPicker } from './models';
import { NodAvatar, BotAvatar } from './bot-avatar';
import { LiveLine } from './live-line';
import { shortcutLabel, sidebarItems } from '../lib/navigation';
import { desktopSettingsAvailable } from '../lib/desktop';
import { Tooltip } from './tooltip';
import { Button, Dialog, DialogContent, DialogTitle, Input, Loading, Notice } from './ui';
import { EmojiCatalog } from './emoji-picker';

function plain(event: MouseEvent) {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0);
}

export function toast(text: string) {
  window.dispatchEvent(new CustomEvent('nod:toast', { detail: text }));
}

export function Toasts() {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (event: Event) => {
      setText((event as CustomEvent<string>).detail);
      setOpen(true);
      clearTimeout(timer);
      timer = setTimeout(() => setOpen(false), 2400);
    };
    window.addEventListener('nod:toast', show);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('nod:toast', show);
    };
  }, []);
  return text ? (
    <div
      className="bot-toast"
      role="status"
      data-open={open || undefined}
      onTransitionEnd={(event) => {
        if (!open && event.propertyName === 'opacity') setText('');
      }}
    >
      {text}
    </div>
  ) : null;
}

const botsChanged = () => window.dispatchEvent(new Event('nod:bots-changed'));

async function changeBot(id: string, body: object) {
  const result = await api<Bot>(`/api/bots/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  botsChanged();
  return result;
}

export function newBot() {
  window.dispatchEvent(new Event('nod:new-bot'));
}

async function removeBot(id: string) {
  await api(`/api/bots/${id}`, { method: 'DELETE' });
  botsChanged();
}

function RowMarker({ bot, unread }: { bot: Bot; unread: boolean }) {
  if (bot.status === 'needs_you')
    return <span className="bot-dot bot-dot-needs" aria-label="Needs you" />;
  if (unread) return <span className="bot-dot" aria-label="Unread" />;
  if (bot.status === 'working')
    return <span className="bot-dot bot-dot-working" aria-label="Working" />;
  return null;
}

function ContextMenu({
  bot,
  point,
  onClose,
  onOpen,
  onRemoved,
}: {
  bot: Bot;
  point: { x: number; y: number };
  onClose(): void;
  onOpen(): void;
  onRemoved(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(point);
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    setPosition({
      x: Math.min(point.x, window.innerWidth - element.offsetWidth - 8),
      y: Math.min(point.y, window.innerHeight - element.offsetHeight - 8),
    });
    element.querySelector<HTMLButtonElement>('button')?.focus();
  }, [point]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={menu}
      className="bot-context"
      role="menu"
      aria-label={`${bot.name} options`}
      style={{ left: position.x, top: position.y }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          onOpen();
        }}
      >
        Open chat
      </button>
      <button
        type="button"
        role="menuitem"
        className="danger"
        onClick={() => {
          onClose();
          void removeBot(bot.id)
            .then(() => {
              toast(`Removed ${bot.name}`);
              onRemoved();
            })
            .catch((cause) => toast(errorMessage(cause)));
        }}
      >
        Remove {bot.name}
      </button>
    </div>,
    document.body,
  );
}

function statusWord(bot: Bot, unread: boolean) {
  if (bot.status === 'needs_you') return 'needs you';
  if (bot.status === 'working') return 'working';
  return unread ? 'new message' : null;
}

export function BotNav({
  bots,
  activity,
  activeId,
  mainActive,
  nodLine,
  nodUnread,
  nodWorking,
  path,
  settingsActive,
  unread,
  expanded,
  toolsRef,
  onToggle,
  onNavigate,
  onSettings,
}: {
  bots: Bot[];
  activity?: Activity[];
  activeId?: string;
  mainActive: boolean;
  nodLine: string;
  nodUnread: boolean;
  nodWorking: boolean;
  path: string;
  settingsActive: boolean;
  unread(bot: Bot): boolean;
  expanded: boolean;
  toolsRef(element: HTMLDivElement | null): void;
  onToggle(): void;
  onNavigate(path: string): void;
  onSettings(): void;
}) {
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ bot: Bot; point: { x: number; y: number } }>();
  const ids = bots.map((bot) => bot.id).join();
  useEffect(() => {
    const next = new Set(bots.map((bot) => bot.id));
    if (known.current) {
      const added = [...next].filter((id) => !known.current!.has(id));
      if (added.length) {
        setFresh(new Set(added));
        const timer = window.setTimeout(() => setFresh(new Set()), 1800);
        known.current = next;
        return () => window.clearTimeout(timer);
      }
    }
    known.current = next;
  }, [ids]);
  const link = (path: string) => (event: MouseEvent) => {
    if (!plain(event)) return;
    event.preventDefault();
    onNavigate(path);
  };
  const openMenu = (bot: Bot, point: { x: number; y: number }) => setMenu({ bot, point });
  const tip = (text: string) => (expanded ? undefined : text);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const nodStatus = nodUnread ? 'new message' : nodWorking ? 'working' : null;
  return (
    <nav className="bot-nav" aria-label="Chats">
      <div className="bot-top">
        <Tooltip
          content={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
          shortcut={desktopSettingsAvailable() ? shortcutLabel('b', mac) : undefined}
          side="right"
        >
          <button
            type="button"
            className="bot-toggle"
            aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {expanded ? (
              <PanelLeftClose size={18} aria-hidden="true" />
            ) : (
              <PanelLeftOpen size={18} aria-hidden="true" />
            )}
          </button>
        </Tooltip>
      </div>
      <ul className="bot-list">
        <li>
          <Tooltip content={tip(nodStatus ? `Nod · ${nodStatus}` : 'Nod')} side="right">
            <a
              href="/"
              className="bot-item bot-brand"
              data-status={nodWorking ? 'working' : undefined}
              aria-current={mainActive ? 'page' : undefined}
              aria-label={['Chat with Nod', nodStatus].filter(Boolean).join(', ')}
              onClick={link('/')}
            >
              <NodAvatar />
              <span className="bot-meta">
                <span className="bot-name">Nod</span>
                <span className={`bot-sub${nodUnread ? ' bot-sub-unread' : ''}`}>
                  {nodWorking ? (
                    <LiveLine
                      item={activity?.find((item) => !item.botId && !item.background)}
                      history={false}
                    />
                  ) : (
                    nodLine || 'Ask me anything'
                  )}
                </span>
              </span>
              {nodUnread ? (
                <span className="bot-dot" aria-hidden="true" />
              ) : nodWorking ? (
                <span className="bot-dot bot-dot-working" aria-hidden="true" />
              ) : null}
            </a>
          </Tooltip>
        </li>
        {bots.map((bot) => {
          const active = bot.id === activeId;
          const isUnread = !active && unread(bot);
          const live = botActivity(activity, bot.id);
          const status = statusWord(bot, isUnread);
          return (
            <li key={bot.id} className={fresh.has(bot.id) ? 'bot-fresh' : ''}>
              <Tooltip content={tip(status ? `${bot.name} · ${status}` : bot.name)} side="right">
                <a
                  href={botPath(bot.id)}
                  className="bot-item"
                  data-status={bot.status}
                  aria-current={active ? 'page' : undefined}
                  aria-label={[bot.name, status].filter(Boolean).join(', ')}
                  onClick={link(botPath(bot.id))}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    openMenu(bot, { x: event.clientX, y: event.clientY });
                  }}
                  onKeyDown={(event: KeyboardEvent) => {
                    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
                      return;
                    event.preventDefault();
                    const box = event.currentTarget.getBoundingClientRect();
                    openMenu(bot, { x: box.left + 24, y: box.bottom });
                  }}
                >
                  <BotAvatar name={bot.name} avatar={bot.avatar} />
                  <span className="bot-meta">
                    <span className="bot-name">{bot.name}</span>
                    <span className={`bot-sub${isUnread ? ' bot-sub-unread' : ''}`}>
                      {bot.status === 'working' ? (
                        <LiveLine item={live} history={false} />
                      ) : (
                        botLine(bot)
                      )}
                    </span>
                  </span>
                  <RowMarker bot={bot} unread={isUnread} />
                </a>
              </Tooltip>
            </li>
          );
        })}
        <li>
          <Tooltip content={tip('New bot')} side="right">
            <button
              type="button"
              className="bot-item bot-new"
              aria-label="New bot"
              onClick={newBot}
            >
              <span className="av av-new" aria-hidden="true">
                <Plus size={16} />
              </span>
              <span className="bot-meta">
                <span className="bot-name">New bot</span>
              </span>
            </button>
          </Tooltip>
        </li>
      </ul>
      <div className="bot-foot">
        <div className="bot-foot-tools" ref={toolsRef} />
        {sidebarItems
          .filter((item) => item.path !== '/' && item.path !== '/tasks')
          .map((item) => (
            <Tooltip key={item.path} content={tip(item.label)} side="right">
              <a
                href={item.path}
                className="bot-foot-item"
                aria-label={item.label}
                aria-current={path === item.path ? 'page' : undefined}
                onClick={link(item.path)}
              >
                <item.icon size={18} aria-hidden="true" />
                <span>{item.label}</span>
              </a>
            </Tooltip>
          ))}
        <Tooltip content={tip('Settings')} side="right">
          <button
            type="button"
            className="bot-foot-item"
            aria-label="Settings"
            aria-current={settingsActive ? 'page' : undefined}
            onClick={onSettings}
          >
            <Settings size={18} aria-hidden="true" />
            <span>Settings</span>
          </button>
        </Tooltip>
      </div>
      {menu && (
        <ContextMenu
          bot={menu.bot}
          point={menu.point}
          onClose={() => setMenu(undefined)}
          onOpen={() => onNavigate(botPath(menu.bot.id))}
          onRemoved={() => {
            if (menu.bot.id === activeId) onNavigate('/');
          }}
        />
      )}
    </nav>
  );
}

export function ChatTop({ bot }: { bot?: Bot }) {
  return <h1 className="sr-only">{bot?.name ?? 'Nod'}</h1>;
}

async function uploadAvatar(dataUrl: string) {
  const blob = await (await fetch(dataUrl)).blob();
  const body = new FormData();
  body.append(
    'file',
    new File([blob], `avatar.${blob.type.split('/')[1] ?? 'webp'}`, { type: blob.type }),
  );
  return (await api<{ url: string }>('/api/uploads', { method: 'POST', body })).url;
}

function resizedImage(file: File) {
  return new Promise<string>((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type))
      return reject(new Error('Choose a PNG, JPG or WebP image.'));
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const size = 256;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d')!;
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      context.drawImage(
        image,
        (image.naturalWidth - side) / 2,
        (image.naturalHeight - side) / 2,
        side,
        side,
        0,
        0,
        size,
        size,
      );
      URL.revokeObjectURL(url);
      const webp = canvas.toDataURL('image/webp', 0.86);
      resolve(webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.86));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This image could not be read.'));
    };
    image.src = url;
  });
}

function AvatarMenu({
  onPick,
  onClose,
}: {
  onPick(next: string): Promise<unknown> | void;
  onClose(): void;
}) {
  const [tab, setTab] = useState<'emoji' | 'upload'>('emoji');
  const [busy, setBusy] = useState(false);
  const save = (next: string | Promise<string>, done?: string) => {
    setBusy(true);
    void Promise.resolve(next)
      .then(onPick)
      .then(() => {
        if (done) toast(done);
        onClose();
      })
      .catch((cause) => toast(errorMessage(cause)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="avatar-menu" role="dialog" aria-label="Change avatar">
      <div className="avatar-tabs" role="tablist">
        {(
          [
            ['emoji', 'Emoji'],
            ['upload', 'Upload'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'emoji' ? (
        <div className="avatar-catalog">
          <Suspense fallback={<Loading />}>
            <EmojiCatalog
              autoFocus={false}
              skinTones={false}
              onSelect={(emoji) => !busy && save(emoji)}
            />
          </Suspense>
        </div>
      ) : (
        <div className="avatar-upload">
          <label>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) save(resizedImage(file).then(uploadAvatar), 'Avatar updated');
              }}
            />
            <Button asChild variant="secondary" size="sm">
              <span>Choose image…</span>
            </Button>
          </label>
          <span className="avatar-hint">PNG or JPG, square works best.</span>
        </div>
      )}
      <button type="button" className="sr-only" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

function AvatarField({
  name,
  avatar,
  onPick,
}: {
  name: string;
  avatar: string;
  onPick(next: string): Promise<unknown> | void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);
  return (
    <span className="avatar-wrap" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="avatar-button"
        aria-expanded={open}
        aria-label="Change avatar"
        onClick={() => setOpen((value) => !value)}
      >
        <BotAvatar name={name} avatar={avatar} size="lg" />
      </button>
      {open && <AvatarMenu onPick={onPick} onClose={close} />}
    </span>
  );
}

export function NewBotDialog({ bots, onCreated }: { bots: Bot[]; onCreated(bot: Bot): void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const taken = useRef(bots);
  const createdBot = useRef(false);
  taken.current = bots;
  useEffect(() => {
    const show = () => {
      setAvatar('🤖');
      setName('');
      setError('');
      createdBot.current = false;
      setOpen(true);
    };
    window.addEventListener('nod:new-bot', show);
    return () => window.removeEventListener('nod:new-bot', show);
  }, []);
  async function create() {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const created = await api<Bot>('/api/bots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, avatar }),
      });
      botsChanged();
      createdBot.current = true;
      setOpen(false);
      onCreated(created);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <DialogContent
        className="new-bot-dialog"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          if (createdBot.current) event.preventDefault();
        }}
      >
        <DialogTitle>New bot</DialogTitle>
        <form
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <div className="new-bot-identity">
            <AvatarField name={name.trim() || 'A'} avatar={avatar} onPick={setAvatar} />
            <Input
              autoFocus
              aria-label="Name"
              placeholder="Name"
              value={name}
              maxLength={botNameLimit}
              disabled={busy}
              onChange={(event) => {
                setName(event.target.value);
                setError('');
              }}
            />
          </div>
          {error && <Notice kind="error">{error}</Notice>}
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NameField({ bot }: { bot: Bot }) {
  const [value, setValue] = useState(bot.name);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setValue(bot.name);
  }, [bot.name]);
  function commit() {
    if (!editing.current) return setValue(bot.name);
    editing.current = false;
    const next = value.replace(/\s+/g, ' ').trim();
    if (!next || next === bot.name) return setValue(bot.name);
    void changeBot(bot.id, { name: next }).catch((cause) => {
      toast(errorMessage(cause));
      setValue(bot.name);
    });
  }
  return (
    <input
      className="panel-name"
      value={value}
      maxLength={botNameLimit}
      aria-label="Name"
      onFocus={() => (editing.current = true)}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key !== 'Escape') return;
        event.preventDefault();
        editing.current = false;
        setValue(bot.name);
        event.currentTarget.blur();
      }}
    />
  );
}

function InstructionsField({ bot }: { bot: Bot }) {
  const [value, setValue] = useState(bot.instructions);
  const saved = useRef(bot.instructions);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setValue(bot.instructions);
      saved.current = bot.instructions;
    }
  }, [bot.instructions]);
  const latest = useRef(value);
  function save(next: string) {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (next.trim() === saved.current.trim()) return;
    saved.current = next;
    void changeBot(bot.id, { instructions: next }).catch((cause) => toast(errorMessage(cause)));
  }
  useEffect(
    () => () => {
      if (timer.current) save(latest.current);
    },
    [],
  );
  return (
    <textarea
      className="input"
      value={value}
      rows={4}
      aria-label="Instructions"
      placeholder="What should it always or never do?"
      maxLength={botInstructionsLimit}
      onFocus={() => (focused.current = true)}
      onChange={(event) => {
        const next = event.target.value;
        setValue(next);
        latest.current = next;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => save(next), 700);
      }}
      onBlur={() => {
        focused.current = false;
        save(value);
      }}
    />
  );
}

type CardKey = 'settings' | 'scheduled' | 'tasks';
const wideCards = () => window.matchMedia('(min-width: 1280px)').matches;

export function PanelProvider({
  bot,
  available,
  activity,
  onAsk,
  onNavigate,
  children,
}: {
  path: string;
  bot?: Bot;
  available: boolean;
  activity?: Activity[];
  onAsk(text: string, botId?: string): void;
  onNavigate(path: string): void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<Record<CardKey, boolean>>(() => ({
    settings: false,
    scheduled: wideCards(),
    tasks: wideCards(),
  }));
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1280px)');
    const change = () =>
      setOpen((current) => ({ ...current, scheduled: query.matches, tasks: query.matches }));
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return (
    <>
      {children}
      {available && (
        <BotCards
          bot={bot}
          activity={activity ?? []}
          open={open}
          onToggle={(key) => setOpen((current) => ({ ...current, [key]: !current[key] }))}
          onAsk={onAsk}
          onNavigate={onNavigate}
        />
      )}
    </>
  );
}

const finishedTask = (task: Task) => task.status === 'done' || task.status === 'cancelled';

function CardHead({
  title,
  count,
  alert,
  open,
  add,
  onToggle,
  onAdd,
}: {
  title: string;
  count: number;
  alert?: boolean;
  open: boolean;
  add: string;
  onToggle(): void;
  onAdd(): void;
}) {
  if (count === 0)
    return (
      <button type="button" className="bot-card-create" aria-label={add} onClick={onAdd}>
        <h3>{title}</h3>
        <span className="bot-card-create-hint">{add}</span>
        <Plus size={14} aria-hidden="true" />
      </button>
    );
  return (
    <div className="bot-card-head">
      <button
        type="button"
        className="bot-card-toggle"
        aria-expanded={count > 0 ? open : undefined}
        disabled={count === 0}
        onClick={onToggle}
      >
        <h3>{title}</h3>
        {count > 0 && (
          <span className={`bot-card-count${alert ? ' bot-card-count-alert' : ''}`}>{count}</span>
        )}
        {count > 0 && <ChevronDown size={12} className="bot-card-chevron" aria-hidden="true" />}
      </button>
      <Tooltip content={add}>
        <button type="button" className="bot-card-add" aria-label={add} onClick={onAdd}>
          <Plus size={14} aria-hidden="true" />
        </button>
      </Tooltip>
    </div>
  );
}

function shortWhen(schedule: Schedule, format: DateFormat) {
  if (schedule.activeRun?.status === 'waiting') return 'Needs you';
  if (schedule.activeRun) return 'Running';
  if (!schedule.enabled || !schedule.nextRun) return schedule.lastRun ? 'Done' : 'Paused';
  const next = new Date(schedule.nextRun);
  if (next.getTime() - Date.now() > 6 * 86_400_000) return formatDateTime(next, format);
  const day = new Intl.DateTimeFormat(format.locale, {
    weekday: 'short',
    timeZone: format.timeZone,
  }).format(next);
  return `${day} ${formatTime(next, format)}`;
}

function WorkLine({
  title,
  side,
  tone,
  dot,
  muted,
  open,
  onToggle,
  children,
}: {
  title: string;
  side: string;
  tone?: string;
  dot?: string;
  muted?: boolean;
  open: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  return (
    <div className="bot-line" data-open={open || undefined}>
      <button
        type="button"
        className="bot-line-row"
        aria-expanded={open}
        data-muted={muted || undefined}
        onClick={onToggle}
      >
        {dot && <span className="bot-line-dot" data-tone={dot} aria-hidden="true" />}
        <span className="bot-line-title">{title}</span>
        <span className="bot-line-side" data-tone={tone}>
          {side}
        </span>
      </button>
      {open && <div className="bot-line-detail">{children}</div>}
    </div>
  );
}

const taskTone: Partial<Record<Task['status'], string>> = {
  working: 'info',
  needs_you: 'accent',
  failed: 'error',
};

function BotCards({
  bot,
  activity,
  open,
  onToggle,
  onAsk,
  onNavigate,
}: {
  bot?: Bot;
  activity: Activity[];
  open: Record<CardKey, boolean>;
  onToggle(key: CardKey): void;
  onAsk(text: string, botId?: string): void;
  onNavigate(path: string): void;
}) {
  const schedules = usePageData<Schedule[]>('/api/schedules');
  const tasks = usePageData<Task[]>('/api/tasks');
  const format = useDateFormat();
  const [expanded, setExpanded] = useState<string>();
  const [showFinished, setShowFinished] = useState(false);
  const chatId = bot?.id ?? null;
  const name = bot?.name ?? 'Nod';
  const ask = (text: string) => onAsk(text, bot?.id);
  const toggleLine = (id: string) => setExpanded((current) => (current === id ? undefined : id));
  const scheduled = (schedules.data ?? [])
    .filter((schedule) => (schedule.botId ?? null) === chatId)
    .sort(
      (a, b) =>
        Number(Boolean(b.enabled && b.nextRun)) - Number(Boolean(a.enabled && a.nextRun)) ||
        (a.nextRun ?? '').localeCompare(b.nextRun ?? '') ||
        a.id.localeCompare(b.id),
    );
  const own = (tasks.data ?? []).filter((task) => (task.botId ?? null) === chatId);
  const running = own.filter((task) => !finishedTask(task));
  const finished = own.filter(finishedTask);
  const taskLine = (task: Task) => (
    <WorkLine
      key={task.id}
      title={task.title}
      side={taskLabels[task.status]}
      tone={taskTone[task.status]}
      dot={taskTone[task.status] ?? 'muted'}
      muted={finishedTask(task)}
      open={expanded === task.id}
      onToggle={() => toggleLine(task.id)}
    >
      <TaskCard task={task} live={activity.find((item) => item.taskId === task.id)} />
    </WorkLine>
  );
  return (
    <aside className="bot-cards" aria-label={`${name} details`}>
      <section className="bot-card bot-card-identity" aria-label={name}>
        <div className="bot-card-who">
          {bot ? (
            <AvatarField
              key={bot.id}
              name={bot.name}
              avatar={bot.avatar}
              onPick={(avatar) => changeBot(bot.id, { avatar })}
            />
          ) : (
            <NodAvatar size="lg" />
          )}
          <div className="bot-card-name">
            {bot ? <NameField key={bot.id} bot={bot} /> : <h2>Nod</h2>}
            {bot?.job && <p>{bot.job}</p>}
          </div>
          <Tooltip content={`${name} settings`}>
            <button
              type="button"
              className="bot-card-gear"
              aria-label={`${name} settings`}
              aria-expanded={open.settings}
              onClick={() => onToggle('settings')}
            >
              <Settings size={16} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
        {open.settings && (
          <div className="bot-card-settings">
            <div className="bot-card-field">
              <span className="bot-card-label">Model</span>
              {bot ? <BotModel bot={bot} /> : <ModelPicker manageConnections={false} />}
            </div>
            {bot ? (
              <label className="bot-card-field">
                <span className="bot-card-label">Instructions</span>
                <InstructionsField key={bot.id} bot={bot} />
              </label>
            ) : (
              <button
                type="button"
                className="bot-card-row"
                onClick={() => onNavigate('/settings/memory')}
              >
                <span>Memory</span>
                <span className="bot-card-row-value">Shared by every bot</span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </section>
      <section className="bot-card" aria-label="Scheduled">
        <CardHead
          title="Scheduled"
          count={scheduled.length}
          alert={scheduled.some((schedule) => schedule.activeRun?.status === 'waiting')}
          open={open.scheduled}
          add="New schedule"
          onToggle={() => onToggle('scheduled')}
          onAdd={() =>
            ask(
              'Help me create a schedule. Ask me one question at a time to work out what to do and when.',
            )
          }
        />
        {schedules.error && <Notice kind="error">{schedules.error}</Notice>}
        {open.scheduled && scheduled.length > 0 && (
          <div className="bot-card-body">
            {scheduled.map((schedule) => (
              <WorkLine
                key={schedule.id}
                title={schedule.title}
                side={shortWhen(schedule, format)}
                tone={
                  schedule.activeRun?.status === 'waiting'
                    ? 'accent'
                    : schedule.activeRun
                      ? 'info'
                      : undefined
                }
                muted={!schedule.enabled}
                open={expanded === schedule.id}
                onToggle={() => toggleLine(schedule.id)}
              >
                <ScheduleRow schedule={schedule} activity={activity} onAsk={ask} defaultOpen />
              </WorkLine>
            ))}
          </div>
        )}
      </section>
      <section className="bot-card" aria-label="Tasks">
        <CardHead
          title="Tasks"
          count={running.length}
          alert={running.some((task) => task.status === 'needs_you')}
          open={open.tasks}
          add="New task"
          onToggle={() => onToggle('tasks')}
          onAdd={() =>
            ask(
              'Help me hand you a new task. Ask me one question at a time to work out what to do.',
            )
          }
        />
        {tasks.error && <Notice kind="error">{tasks.error}</Notice>}
        {open.tasks && (running.length > 0 || finished.length > 0) && (
          <div className="bot-card-body">
            {running.map(taskLine)}
            {finished.length > 0 && (
              <button
                type="button"
                className="bot-card-link bot-card-finished"
                aria-expanded={showFinished}
                onClick={() => setShowFinished((value) => !value)}
              >
                Finished {finished.length}
              </button>
            )}
            {showFinished && finished.map(taskLine)}
          </div>
        )}
      </section>
    </aside>
  );
}

export function BotEmpty({ bot }: { bot: Bot }): ReactNode {
  return (
    <div className="bot-empty-chat">
      <BotAvatar name={bot.name} avatar={bot.avatar} size="lg" />
      <p>Hi, I’m {bot.name}. What can I take off your plate?</p>
      {bot.job && <p className="bot-empty-job">{bot.job}</p>}
    </div>
  );
}
