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
import type { Activity } from '../../shared/contracts';
import { botInstructionsLimit, botEmojis, botNameLimit } from '../../shared/bots';
import { api, errorMessage } from '../lib/api';
import { botActivity, botLine, botPath, type Bot } from '../lib/bots';
import { Plus, Settings, X } from './icons';
import { NodModelName, BotModel } from './model-choices';
import { NodAvatar, BotAvatar } from './bot-avatar';
import { LiveLine } from './live-line';
import { sidebarItems } from '../lib/navigation';
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
  return (
    <nav className="bot-nav" aria-label="Chats">
      <div className="bot-top">
        <Button variant="ghost" size="icon" aria-label="New bot" onClick={newBot}>
          <Plus size={16} aria-hidden="true" />
        </Button>
      </div>
      <a
        href="/"
        className="bot-brand"
        aria-current={mainActive ? 'page' : undefined}
        aria-label={['Chat with Nod', nodWorking ? 'working' : null, nodUnread ? 'unread' : null]
          .filter(Boolean)
          .join(', ')}
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
      {bots.length > 0 && (
        <ul className="bot-list">
          {bots.map((bot) => {
            const active = bot.id === activeId;
            const isUnread = !active && unread(bot);
            const live = botActivity(activity, bot.id);
            return (
              <li key={bot.id} className={fresh.has(bot.id) ? 'bot-fresh' : ''}>
                <a
                  href={botPath(bot.id)}
                  className="bot-item"
                  aria-current={active ? 'page' : undefined}
                  aria-label={[
                    bot.name,
                    bot.status === 'needs_you'
                      ? 'needs you'
                      : bot.status === 'working'
                        ? 'working'
                        : null,
                    isUnread ? 'unread' : null,
                  ]
                    .filter(Boolean)
                    .join(', ')}
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
              </li>
            );
          })}
        </ul>
      )}
      <div className="bot-foot">
        {sidebarItems
          .filter((item) => item.path !== '/')
          .map((item) => (
            <a
              key={item.path}
              href={item.path}
              className="bot-foot-item"
              aria-current={path === item.path ? 'page' : undefined}
              onClick={link(item.path)}
            >
              <item.icon size={16} aria-hidden="true" />
              <span>{item.label}</span>
            </a>
          ))}
        <button
          type="button"
          className="bot-foot-item"
          aria-current={settingsActive ? 'page' : undefined}
          onClick={onSettings}
        >
          <Settings size={16} aria-hidden="true" />
          <span>Settings</span>
        </button>
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

export function ChatTop({
  bot,
  toolsRef,
}: {
  bot?: Bot;
  toolsRef?(element: HTMLDivElement | null): void;
}) {
  const panel = useContext(PanelContext);
  const summary = bot ? bot.job || 'No job yet' : 'Your main assistant';
  return (
    <header className="chat-top">
      <h1 className="chat-pill-wrap">
        <button
          type="button"
          className="chat-pill"
          aria-expanded={panel.shown}
          aria-controls="bot-panel"
          title={summary}
          onClick={panel.toggle}
        >
          {bot ? (
            <BotAvatar name={bot.name} avatar={bot.avatar} size="sm" />
          ) : (
            <NodAvatar size="sm" />
          )}
          <span className="chat-pill-name">{bot?.name ?? 'Nod'}</span>
        </button>
      </h1>
      <div className="chat-top-tools" ref={toolsRef} />
    </header>
  );
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
      const free = botEmojis.filter((emoji) => !taken.current.some((bot) => bot.avatar === emoji));
      const choices = free.length ? free : botEmojis;
      setAvatar(choices[Math.floor(Math.random() * choices.length)]!);
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
      rows={3}
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

const PanelContext = createContext<{ shown: boolean; toggle(): void }>({
  shown: false,
  toggle() {},
});

export function PanelProvider({
  path,
  bot,
  available,
  children,
}: {
  path: string;
  bot?: Bot;
  available: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [leavingFrom, setLeavingFrom] = useState<string>();
  if (open && !available) setOpen(false);
  const shown = open && available;
  const close = () => {
    if (shown) setLeavingFrom(path);
    setOpen(false);
  };
  const toggle = () => {
    if (shown) return close();
    setLeavingFrom(undefined);
    setOpen(true);
  };
  return (
    <PanelContext.Provider value={{ shown, toggle }}>
      {children}
      {(shown || leavingFrom === path) && (
        <BotPanel
          bot={bot}
          closing={!shown}
          onClose={close}
          onClosed={() => setLeavingFrom(undefined)}
        />
      )}
    </PanelContext.Provider>
  );
}

export function BotPanel({
  bot,
  closing,
  onClose,
  onClosed,
}: {
  bot?: Bot;
  closing: boolean;
  onClose(): void;
  onClosed(): void;
}) {
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      onClose();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);
  const close = (
    <Button variant="ghost" size="icon" aria-label="Close settings" onClick={onClose}>
      <X size={16} aria-hidden="true" />
    </Button>
  );
  return (
    <aside
      id="bot-panel"
      className={`bot-panel${closing ? ' bot-panel-closing' : ''}`}
      aria-label={bot ? `${bot.name} settings` : 'Nod settings'}
      inert={closing}
      onTransitionEnd={(event) => {
        if (closing && event.target === event.currentTarget && event.propertyName === 'opacity')
          onClosed();
      }}
    >
      <div className="panel-head">
        <div className="panel-head-top">{close}</div>
        <div className="panel-identity">
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
          <div className="panel-identity-text">
            {bot ? (
              <NameField key={bot.id} bot={bot} />
            ) : (
              <>
                <h2>Nod</h2>
                <p>Your main assistant</p>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="panel-body">
        {bot ? (
          <>
            <div className="panel-rows">
              <div className="panel-row">
                <label className="panel-row-head panel-row-still">
                  <span>Model</span>
                  <BotModel bot={bot} onError={toast} />
                </label>
              </div>
              <div className="panel-row">
                <div className="panel-row-head panel-row-still">
                  <span>Instructions</span>
                </div>
                <div className="panel-row-body">
                  <InstructionsField key={bot.id} bot={bot} />
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="panel-rows">
              <div className="panel-row">
                <div className="panel-row-head panel-row-still">
                  <span>Model</span>
                  <span className="panel-row-value">
                    <NodModelName />
                  </span>
                </div>
              </div>
              <div className="panel-row">
                <div className="panel-row-head panel-row-still">
                  <span>Apps</span>
                  <span className="panel-row-value">All connected apps</span>
                </div>
              </div>
              <div className="panel-row">
                <div className="panel-row-head panel-row-still">
                  <span>Memory</span>
                  <span className="panel-row-value">Yours</span>
                </div>
              </div>
            </div>
            <p className="panel-note">
              Nod can’t be renamed or removed. It holds your Vault, approvals and settings, and
              every bot’s actions go through its trust check.
            </p>
          </>
        )}
      </div>
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
