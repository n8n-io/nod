import { useEffect, useRef, useState } from 'react';
import { Trash2 } from './icons';
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

export function DeletePlan({ id, title }: { id: string; title: string }) {
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
    const path = '/api/schedules';
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
        setError('Could not delete this schedule. Try again.');
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
          size="icon"
          aria-label={`Delete schedule ${title}`}
          title="Delete"
          onClick={() => setError('')}
        >
          <Trash2 size={16} aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent
        className="delete-plan-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.querySelector<HTMLButtonElement>('[data-keep-plan]')?.focus();
        }}
      >
        <DialogTitle>Delete schedule?</DialogTitle>
        <DialogDescription>
          {title}
          <span>Future runs will stop. Past runs stay in Previous.</span>
        </DialogDescription>
        {error && <Notice>{error}</Notice>}
        <div className="delete-plan-actions">
          <Button variant="ghost" data-keep-plan disabled={busy} onClick={() => setOpen(false)}>
            Keep schedule
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy ? 'Deleting…' : 'Delete schedule'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
