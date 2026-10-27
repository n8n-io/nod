import { useEffect, useRef, useState } from 'react';
import type { Message, Task } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { desktopSettingsAvailable } from '../lib/desktop';
import { isEditingTarget, navigate, sidebarItems } from '../lib/navigation';
import { useArtifactDrawer } from './artifact-context';
import type { ImagePreview } from './attachment-images';
import { reuseFile } from './file-actions';
import { Button, Dialog, DialogContent, DialogTitle, Input, Notice } from './ui';
import { Search } from './icons';

export function ChatTools({ files, tasks = [] }: { files: ImagePreview[]; tasks?: Task[] }) {
  const drawer = useArtifactDrawer();
  const [mode, setMode] = useState<'find' | 'commands' | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<Message & { snippet?: string }>>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const active = useRef(0);
  const previousFocus = useRef<HTMLElement | null>(null);
  const actionTaken = useRef(false);
  function open(mode: 'find' | 'commands') {
    previousFocus.current = document.activeElement as HTMLElement | null;
    actionTaken.current = false;
    setQuery('');
    setMode(mode);
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing ||
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
    setError('');
    if (mode !== 'find' || !query.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setResults([]);
    setLoading(true);
    const timer = setTimeout(() => {
      void api<Array<Message & { snippet?: string }>>(
        `/api/messages/search?q=${encodeURIComponent(query.trim())}`,
        {
          signal: controller.signal,
        },
      )
        .then((items) => {
          if (active.current === version) setResults(items);
        })
        .catch((cause) => {
          if (!controller.signal.aborted && active.current === version)
            setError(errorMessage(cause));
        })
        .finally(() => {
          if (active.current === version) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [mode, query]);
  const selectedFile = files.find((file) => file.id === drawer.selectedId);
  const commands = [
    ...(selectedFile
      ? [
          {
            id: 'reuse',
            label: 'Use selected file in message',
            action: () => reuseFile(selectedFile),
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
  return (
    <>
      <span className="chat-tools">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Find in conversation"
          title="Find in conversation"
          onClick={() => open('find')}
        >
          <Search size={16} />
        </Button>
      </span>
      <Dialog
        open={mode !== null}
        onOpenChange={(open) => {
          if (!open) setMode(null);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!actionTaken.current && previousFocus.current?.isConnected)
              previousFocus.current.focus({ preventScroll: true });
          }}
        >
          <DialogTitle>{mode === 'find' ? 'Find in conversation' : 'Commands'}</DialogTitle>
          <Input
            autoFocus
            aria-label={mode === 'find' ? 'Search all messages' : 'Search commands'}
            placeholder={mode === 'find' ? 'Search all messages' : 'Go to a page, file, or task'}
            value={query}
            maxLength={200}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (
                !event.nativeEvent.isComposing &&
                !event.repeat &&
                ['ArrowDown', 'Enter'].includes(event.key)
              ) {
                event.preventDefault();
                const first = event.currentTarget
                  .closest('[role="dialog"]')
                  ?.querySelector<HTMLButtonElement>('.chat-tool-results button');
                if (event.key === 'Enter') first?.click();
                else first?.focus();
              }
            }}
          />
          {error && <Notice>{error}</Notice>}
          <div
            className="chat-tool-results"
            onKeyDown={(event) => {
              if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
              event.preventDefault();
              const items = Array.from(event.currentTarget.querySelectorAll('button'));
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              items[
                (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length
              ]?.focus();
            }}
          >
            {mode === 'find'
              ? results.map((message) => {
                  const text = message.audioCaption ?? message.text;
                  const match = text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
                  const start = Math.max(0, match - 60);
                  const snippet =
                    match < 0 && message.snippet
                      ? message.snippet
                      : text
                        ? `${start > 0 ? '…' : ''}${text.slice(start, start + 220)}${text.length > start + 220 ? '…' : ''}`
                        : message.attachments.map((item) => item.name).join(', ') ||
                          'Audio message';
                  return (
                    <button
                      type="button"
                      key={message.id}
                      onClick={() => {
                        actionTaken.current = true;
                        setMode(null);
                        window.dispatchEvent(
                          new CustomEvent('nod:focus-message', {
                            detail: { messageId: message.id },
                          }),
                        );
                      }}
                    >
                      <strong>{message.role === 'user' ? 'You' : 'Nod'}</strong>
                      <span>{snippet}</span>
                    </button>
                  );
                })
              : commands.map((command) => (
                  <button
                    type="button"
                    key={command.id}
                    onClick={() => {
                      actionTaken.current = true;
                      setMode(null);
                      command.action();
                    }}
                  >
                    {command.label}
                  </button>
                ))}
            {mode === 'find' && query.trim() && !results.length && !loading && !error && (
              <p>No messages found.</p>
            )}
            {loading && <p role="status">Searching…</p>}
            {mode === 'commands' && !commands.length && <p>No commands found.</p>}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
