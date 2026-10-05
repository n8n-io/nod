import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  Notice,
} from './ui';
import { api } from '../lib/api';
import { pageDataCache } from '../lib/page-data-cache';

export function DeletePlan({
  kind,
  id,
  title,
}: {
  kind: 'task' | 'schedule';
  id: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function remove() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    const path = `/api/${kind}s`;
    try {
      await api(`${path}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      });
      if (controller.signal.aborted) return;
      setOpen(false);
      pageDataCache.update<Array<{ id: string }>>(path, (items) =>
        items ? items.filter((item) => item.id !== id) : null,
      );
      void pageDataCache.refresh(path, true);
      queueMicrotask(() =>
        document.querySelector<HTMLButtonElement>('.secondary-heading button')?.focus(),
      );
    } catch {
      if (!controller.signal.aborted) {
        setError(`Could not delete this ${kind}. Try again.`);
        void pageDataCache.refresh(path, true);
      }
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <Dialog open={open} onOpenChange={(value) => !busy && setOpen(value)}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Delete ${kind} ${title}`}
          onClick={() => {
            setError('');
          }}
        >
          <Trash2 size={14} />
          Delete
        </Button>
      </DialogTrigger>
      <DialogContent
        className="delete-plan-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.querySelector<HTMLButtonElement>('[data-keep-plan]')?.focus();
        }}
      >
        <DialogTitle>Delete {kind}?</DialogTitle>
        <DialogDescription>
          {title}
          <span>
            {kind === 'schedule'
              ? 'Future runs will stop. Past runs stay in History.'
              : 'Otto will stop working on it and its checks will stop.'}
          </span>
        </DialogDescription>
        {error && <Notice>{error}</Notice>}
        <div className="delete-plan-actions">
          <Button variant="ghost" data-keep-plan disabled={busy} onClick={() => setOpen(false)}>
            Keep {kind}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy ? 'Deleting…' : `Delete ${kind}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
