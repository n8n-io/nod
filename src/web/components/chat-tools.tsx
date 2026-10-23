import { useEffect, useRef, useState } from 'react';
import type { Message, Task } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { desktopSettingsAvailable } from '../lib/desktop';
import { isEditingTarget, navigate, sidebarItems } from '../lib/navigation';
import { useArtifactDrawer } from './artifact-context';
import type { ImagePreview } from './attachment-images';
import { reuseFile } from './file-actions';
import { Button, Dialog, DialogContent, DialogTitle, Input, Notice } from './ui';
import { Search, List } from './icons';

export function ChatTools({ files, tasks = [] }: { files: ImagePreview[]; tasks?: Task[] }) {
  const drawer = useArtifactDrawer();
  const [mode, setMode] = useState<'find' | 'commands' | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Message[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const active = useRef(0);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
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
        setQuery('');
        setMode(event.key.toLowerCase() === 'f' ? 'find' : 'commands');
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
    const timer = setTimeout(() => {
      setLoading(true);
      void api<Message[]>(`/api/messages/search?q=${encodeURIComponent(query.trim())}`, {
        signal: controller.signal,
      })
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
      ? [{ label: 'Use selected file in message', action: () => reuseFile(selectedFile) }]
      : []),
    ...sidebarItems.map((item) => ({
      label: `Open ${item.label}`,
      action: () => navigate(item.path),
    })),
    ...files.map((file) => ({ label: `Preview ${file.name}`, action: () => drawer.open(file.id) })),
    ...tasks
      .filter((task) => task.messageId)
      .map((task) => ({
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
          onClick={() => {
            setQuery('');
            setMode('find');
          }}
        >
          <Search size={16} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Commands"
          title="Commands (⌘/Ctrl K)"
          onClick={() => {
            setQuery('');
            setMode('commands');
          }}
        >
          <List size={16} />
        </Button>
      </span>
      <Dialog
        open={mode !== null}
        onOpenChange={(open) => {
          if (!open) setMode(null);
        }}
      >
        <DialogContent>
          <DialogTitle>{mode === 'find' ? 'Find in conversation' : 'Commands'}</DialogTitle>
          <Input
            autoFocus
            aria-label={mode === 'find' ? 'Search all messages' : 'Search commands'}
            placeholder={mode === 'find' ? 'Search all messages' : 'Go to a page, file, or task'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                event.currentTarget
                  .closest('[role="dialog"]')
                  ?.querySelector<HTMLButtonElement>('.chat-tool-results button')
                  ?.focus();
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
              ? results.map((message) => (
                  <button
                    type="button"
                    key={message.id}
                    onClick={() => {
                      setMode(null);
                      window.dispatchEvent(
                        new CustomEvent('nod:focus-message', { detail: { messageId: message.id } }),
                      );
                    }}
                  >
                    <strong>{message.role === 'user' ? 'You' : 'nod'}</strong>
                    <span>{message.text.slice(0, 220)}</span>
                  </button>
                ))
              : commands.map((command) => (
                  <button
                    type="button"
                    key={command.label}
                    onClick={() => {
                      setMode(null);
                      command.action();
                    }}
                  >
                    {command.label}
                  </button>
                ))}
            {mode === 'find' && query.trim() && !results.length && !loading && (
              <p>No messages found.</p>
            )}
            {loading && <p role="status">Searching…</p>}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
