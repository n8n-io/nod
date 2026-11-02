import { useEffect, useId, useRef, useState } from 'react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import type { Message, Task } from '../../shared/contracts';
import { api, errorMessage, requestAccountVersion } from '../lib/api';
import { analyticsForCurrentSession } from '../lib/analytics';
import { desktopSettingsAvailable } from '../lib/desktop';
import {
  isEditingTarget,
  isPrimaryModifier,
  navigate,
  shortcutLabel,
  sidebarItems,
} from '../lib/navigation';
import { formatDateTime, useDateFormat } from '../lib/date-format';
import { useArtifactDrawer } from './artifact-context';
import { ownedArtifactUrl, type ImagePreview } from './attachment-images';
import { reuseFile } from './file-actions';
import { Button, Dialog, DialogContent, DialogTitle, SearchField, Skeleton } from './ui';
import { ArrowUpRight, Search } from './icons';

const markdown = unified().use(remarkParse);

function searchText(source: string) {
  const parts: string[] = [];
  visit(markdown.parse(source), (node) => {
    if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code')
      parts.push(node.value);
    else if (node.type === 'image' && node.alt) parts.push(node.alt);
  });
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function highlighted(text: string, query: string) {
  const terms = [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter((term) => term.toUpperCase() !== 'OR')
    .sort((a, b) => b.length - a.length);
  if (!terms.length) return text;
  return text
    .split(new RegExp(`(${terms.join('|')})`, 'giu'))
    .map((part, index) => (index % 2 ? <mark key={index}>{part}</mark> : part));
}

export function ChatTools({ files, tasks = [] }: { files: ImagePreview[]; tasks?: Task[] }) {
  const drawer = useArtifactDrawer();
  const desktop = desktopSettingsAvailable();
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const dateFormat = useDateFormat();
  const input = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'find' | 'commands'>('find');
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<{
    query: string;
    items: Array<Message & { snippet?: string }>;
    error: string;
    loading: boolean;
  }>({ query: '', items: [], error: '', loading: false });
  const [attempt, setAttempt] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const list = useRef<HTMLDivElement>(null);
  const revealSelection = useRef(false);
  const id = useId();
  const trimmedQuery = query.trim();
  const currentSearch = search.query === trimmedQuery;
  const results = currentSearch ? search.items : [];
  const error = currentSearch ? search.error : '';
  const loading =
    opened && mode === 'find' && Boolean(trimmedQuery) && (!currentSearch || search.loading);
  const active = useRef(0);
  const previousFocus = useRef<HTMLElement | null>(null);
  const pendingAction = useRef<(() => void) | null>(null);
  function open(mode: 'find' | 'commands') {
    previousFocus.current = document.activeElement as HTMLElement | null;
    pendingAction.current = null;
    setQuery('');
    setSelectedIndex(-1);
    setMode(mode);
    setOpened(true);
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        !isPrimaryModifier(event) ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.repeat ||
        event.defaultPrevented ||
        isEditingTarget(event.target)
      )
        return;
      if (document.querySelector('[role="dialog"],dialog[open]')) return;
      if (
        event.key.toLowerCase() === 'k' ||
        (desktopSettingsAvailable() && event.key.toLowerCase() === 'f')
      ) {
        event.preventDefault();
        open(event.key.toLowerCase() === 'f' ? 'find' : 'commands');
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    const version = ++active.current;
    if (!opened || mode !== 'find') return;
    if (!trimmedQuery) {
      setSearch({ query: '', items: [], error: '', loading: false });
      return;
    }
    const controller = new AbortController();
    setSearch({ query: trimmedQuery, items: [], error: '', loading: true });
    const timer = setTimeout(() => {
      void api<Array<Message & { snippet?: string }>>(
        `/api/messages/search?q=${encodeURIComponent(trimmedQuery)}`,
        { signal: controller.signal },
      )
        .then((items) => {
          if (!controller.signal.aborted && active.current === version)
            setSearch({ query: trimmedQuery, items, error: '', loading: false });
        })
        .catch((cause) => {
          if (!controller.signal.aborted && active.current === version)
            setSearch({
              query: trimmedQuery,
              items: [],
              error: errorMessage(cause),
              loading: false,
            });
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [opened, mode, trimmedQuery, attempt]);
  const selectedFile = files.find(
    (file) => file.id === drawer.selectedId && !file.presentation && ownedArtifactUrl(file.url),
  );
  const commands = [
    ...(selectedFile
      ? [
          {
            id: 'reuse',
            label: 'Use selected file in message',
            action: (capture: ReturnType<typeof analyticsForCurrentSession>) =>
              reuseFile(selectedFile, 'commands', capture),
          },
        ]
      : []),
    ...sidebarItems.map((item) => ({
      id: item.path,
      label: `Open ${item.label}`,
      action: () => navigate(item.path),
    })),
    ...files.map((file) => ({
      id: file.id,
      label: `Preview ${file.name}`,
      action: () => drawer.open(file.id),
    })),
    ...tasks
      .filter((task) => task.messageId)
      .map((task) => ({
        id: task.id,
        label: `Go to ${task.title}`,
        action: () =>
          window.dispatchEvent(
            new CustomEvent('nod:focus-message', { detail: { messageId: task.messageId } }),
          ),
      })),
  ]
    .filter((item) => item.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .slice(0, 30);
  const entries =
    mode === 'find'
      ? results.map((message) => ({
          id: message.id,
          message,
          action: () =>
            window.dispatchEvent(
              new CustomEvent('nod:focus-message', {
                detail: { messageId: message.id },
              }),
            ),
        }))
      : commands;
  const selected = selectedIndex >= 0 && selectedIndex < entries.length ? selectedIndex : -1;
  const optionId = (index: number) => `${id}-option-${index}`;
  useEffect(() => {
    if (!revealSelection.current || selected < 0) return;
    const item = document.getElementById(optionId(selected));
    const container = list.current;
    if (!item || !container) return;
    const bounds = container.getBoundingClientRect();
    const target = item.getBoundingClientRect();
    if (target.top < bounds.top) container.scrollTop -= bounds.top - target.top;
    else if (target.bottom > bounds.bottom) container.scrollTop += target.bottom - bounds.bottom;
  }, [selected, query, entries.length]);
  function choose(index: number) {
    const entry = entries[index];
    if (!entry) return;
    const account = requestAccountVersion();
    const capture = analyticsForCurrentSession();
    pendingAction.current = () => {
      if (account === requestAccountVersion()) entry.action(capture);
    };
    setOpened(false);
  }
  function changeQuery(value: string) {
    setQuery(value);
    setSelectedIndex(-1);
    if (list.current) list.current.scrollTop = 0;
  }
  return (
    <>
      <span className="chat-tools">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Search chat"
          title="Search chat"
          shortcut={desktop ? shortcutLabel('f', mac) : undefined}
          aria-keyshortcuts={desktop ? `${mac ? 'Meta' : 'Control'}+F` : undefined}
          onClick={() => open('find')}
        >
          <Search size={16} />
        </Button>
      </span>
      <Dialog open={opened} onOpenChange={setOpened}>
        <DialogContent
          className="chat-search-dialog"
          aria-describedby={undefined}
          data-analytics-private
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const action = pendingAction.current;
            pendingAction.current = null;
            if (action) action();
            else if (previousFocus.current?.isConnected)
              previousFocus.current.focus({ preventScroll: true });
          }}
        >
          <DialogTitle>{mode === 'find' ? 'Search chat' : 'Commands'}</DialogTitle>
          <SearchField
            inputRef={input}
            role="combobox"
            aria-label={mode === 'find' ? 'Search messages' : 'Search commands'}
            aria-autocomplete="list"
            aria-expanded={entries.length > 0}
            aria-controls={`${id}-results`}
            aria-activedescendant={selected >= 0 ? optionId(selected) : undefined}
            aria-describedby={`${id}-keys`}
            autoComplete="off"
            spellCheck={false}
            placeholder={mode === 'find' ? 'Search messages' : 'Go to a page, file, or task'}
            value={query}
            onClear={() => {
              changeQuery('');
              input.current?.focus();
            }}
            maxLength={200}
            onChange={(event) => changeQuery(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229 ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey
              )
                return;
              if (event.key === 'Enter') {
                event.preventDefault();
                choose(selected < 0 ? 0 : selected);
              } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (!entries.length) return;
                revealSelection.current = true;
                setSelectedIndex(
                  event.key === 'ArrowDown'
                    ? (selected + 1) % entries.length
                    : selected < 0
                      ? entries.length - 1
                      : (selected - 1 + entries.length) % entries.length,
                );
              }
            }}
          />
          <div ref={list} className="chat-tool-results" aria-busy={loading}>
            <div
              id={`${id}-results`}
              role="listbox"
              aria-label={mode === 'find' ? 'Search results' : 'Commands'}
            >
              {entries.map((entry, index) => {
                const message = 'message' in entry ? entry.message : undefined;
                let snippet = '';
                if (message) {
                  const text = searchText(message.audioCaption ?? message.text);
                  const match = text.toLocaleLowerCase().indexOf(trimmedQuery.toLocaleLowerCase());
                  const start = Math.max(0, match - 60);
                  snippet =
                    match < 0 && message.snippet
                      ? searchText(message.snippet)
                      : text
                        ? `${start > 0 ? '…' : ''}${text.slice(start, start + 220)}${text.length > start + 220 ? '…' : ''}`
                        : message.attachments.map((item) => item.name).join(', ') ||
                          'Audio message';
                }
                return (
                  <button
                    key={entry.id}
                    id={optionId(index)}
                    type="button"
                    role="option"
                    aria-selected={selected === index}
                    tabIndex={-1}
                    onPointerMove={(event) => {
                      if (event.pointerType === 'mouse') {
                        revealSelection.current = false;
                        setSelectedIndex(index);
                      }
                    }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(index)}
                  >
                    {message ? (
                      <>
                        <span className="chat-search-meta">
                          <strong>{message.role === 'user' ? 'You' : 'Nod'}</strong>
                          <time dateTime={message.createdAt}>
                            {formatDateTime(message.createdAt, dateFormat)}
                          </time>
                          <ArrowUpRight size={14} aria-hidden="true" />
                        </span>
                        <span className="chat-search-excerpt">
                          {highlighted(snippet, trimmedQuery)}
                        </span>
                      </>
                    ) : 'label' in entry ? (
                      entry.label
                    ) : null}
                  </button>
                );
              })}
            </div>
            {loading ? (
              <div className="chat-search-loading" role="status" aria-label="Searching messages">
                {[0, 1, 2].map((item) => (
                  <div className="chat-search-skeleton" key={item} aria-hidden="true">
                    <Skeleton style={{ width: '28%' }} />
                    <Skeleton style={{ width: '92%' }} />
                    <Skeleton style={{ width: '68%' }} />
                  </div>
                ))}
              </div>
            ) : error ? (
              <div className="chat-search-state">
                <p role="alert">{error}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  Try again
                </Button>
              </div>
            ) : !entries.length ? (
              <div className="chat-search-state" role={trimmedQuery ? 'status' : undefined}>
                {mode === 'commands' ? (
                  <p>No commands found.</p>
                ) : trimmedQuery ? (
                  <>
                    <strong>No matching messages</strong>
                    <p>Try another word or phrase.</p>
                  </>
                ) : (
                  <p>Search by word, name, or phrase.</p>
                )}
              </div>
            ) : null}
          </div>
          <footer className="chat-search-help">
            <span className="chat-search-count" role="status">
              {loading
                ? 'Searching…'
                : error
                  ? ''
                  : entries.length
                    ? `${entries.length} ${mode === 'find' ? (entries.length === 1 ? 'message' : 'messages') : 'commands'}`
                    : ''}
            </span>
            <span className="chat-search-keys" aria-hidden="true">
              <span>↑ ↓ Navigate</span>
              <span>↵ Open</span>
            </span>
          </footer>
          <span id={`${id}-keys`} className="sr-only">
            Use up and down arrows to choose a result, Enter to open, and Escape to close.
          </span>
        </DialogContent>
      </Dialog>
    </>
  );
}
