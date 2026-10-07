import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { BookmarkCheck, ChevronDown } from 'lucide-react';
import type { Message } from '../../shared/contracts';
import type { MemoryNote, MemoryUpdate, MemoryView } from '../../shared/memory';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage } from '../lib/api';
import { Button, Notice } from './ui';

const MemoryContext = createContext<ReturnType<typeof usePageData<MemoryView>> | null>(null);

export function MemoryReceipts({ children, revision }: { children: ReactNode; revision: string }) {
  const memory = usePageData<MemoryView>('/api/memory');
  const seen = useRef(revision);
  useLayoutEffect(() => {
    if (seen.current === revision) return;
    seen.current = revision;
    void memory.refresh();
  }, [memory.refresh, revision]);
  return <MemoryContext value={memory}>{children}</MemoryContext>;
}

function ReceiptNote({
  note,
  disabled,
  onChange,
}: {
  note: MemoryNote & { id: string };
  disabled: boolean;
  onChange(view: MemoryView): void;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'forget'>('view');
  const [text, setText] = useState(note.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controls = useRef<HTMLDivElement>(null);

  function cancel() {
    setMode('view');
    setText(note.text);
    setError('');
    requestAnimationFrame(() =>
      controls.current?.querySelectorAll('button')[mode === 'edit' ? 0 : 1]?.focus(),
    );
  }

  async function send(method: 'PATCH' | 'DELETE') {
    if (busy || disabled) return;
    setBusy(true);
    setError('');
    try {
      const next = await api<MemoryUpdate>(
        `/api/memory/notes/${note.path}${method === 'DELETE' ? `?id=${encodeURIComponent(note.id)}` : ''}`,
        {
          method,
          ...(method === 'PATCH'
            ? { body: JSON.stringify({ id: note.id, text: text.trim() }) }
            : {}),
        },
      );
      onChange(next);
      setMode('view');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (text.trim() === note.text) cancel();
    else void send('PATCH');
  }

  return (
    <div className="memory-receipt-note" aria-busy={busy}>
      {mode === 'edit' ? (
        <form className="memory-form" onSubmit={save}>
          <textarea
            className="input"
            aria-label="Saved memory"
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={600}
            rows={3}
            disabled={busy}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !busy) cancel();
            }}
          />
          <div className="memory-actions">
            <Button type="submit" size="sm" disabled={busy || disabled || !text.trim()}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p className="memory-receipt-text">{note.text}</p>
          {mode === 'forget' ? (
            <>
              <p className="memory-receipt-status">Forget this note and its earlier versions?</p>
              <div className="memory-actions">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy || disabled}
                  onClick={() => void send('DELETE')}
                  autoFocus
                >
                  {busy ? 'Forgetting…' : 'Forget'}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={cancel}>
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <div className="memory-actions" ref={controls}>
              <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setMode('edit')}>
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => setMode('forget')}
              >
                Forget
              </Button>
            </div>
          )}
        </>
      )}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}

export function MemoryReceipt({ receipt }: { receipt: NonNullable<Message['memory']> }) {
  const memory = useContext(MemoryContext);
  const [open, setOpen] = useState(false);
  const summary = useRef<HTMLElement>(null);
  if (!memory) return null;
  const { data, error, loading, refreshing, refresh, update } = memory;
  const notes = error
    ? []
    : (data?.notes.filter(
        (note): note is MemoryNote & { id: string } =>
          typeof note.id === 'string' &&
          receipt.notes.some((saved) => saved.path === note.path && saved.id === note.id),
      ) ?? []);
  const known = Boolean(data && !error && (!refreshing || notes.length));
  const label = !known
    ? 'Memory saved'
    : !notes.length
      ? 'No longer active'
      : notes.length === 1
        ? 'Remembered:'
        : `Remembered ${notes.length} details`;

  return (
    <details
      className="memory-receipt"
      data-analytics-private
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (event.currentTarget.open) void refresh();
      }}
    >
      <summary ref={summary}>
        <BookmarkCheck size={14} aria-hidden="true" />
        <span className="memory-receipt-label">{label}</span>
        {notes.length === 1 && <span className="memory-receipt-preview">{notes[0].text}</span>}
        <ChevronDown size={14} className="memory-receipt-chevron" aria-hidden="true" />
      </summary>
      {open && (
        <div className="memory-receipt-details">
          {(loading || (refreshing && !notes.length)) && (
            <p className="memory-receipt-status">Loading memory…</p>
          )}
          {error ? (
            <>
              <Notice>Could not load the current memory.</Notice>
              <Button
                variant="ghost"
                size="sm"
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                Try again
              </Button>
            </>
          ) : (
            <>
              {notes.map((note) => (
                <ReceiptNote
                  key={`${note.id}:${note.updated}`}
                  note={note}
                  disabled={refreshing}
                  onChange={(next) => {
                    update(() => next);
                    summary.current?.focus();
                  }}
                />
              ))}
              {known && notes.length < receipt.notes.length && (
                <p className="memory-receipt-status">
                  {receipt.notes.length === 1
                    ? 'This detail is no longer in active memory.'
                    : 'Some details are no longer in active memory.'}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </details>
  );
}
