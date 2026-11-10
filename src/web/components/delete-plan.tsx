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
import type { Schedule } from '../../shared/contracts';
import { api, ApiError, errorMessage, requestAccountVersion } from '../lib/api';
import { pageDataCache } from '../lib/page-data-cache';
import {
  reconcileSchedule,
  schedulesPath,
  uncertainScheduleMutation,
} from '../lib/schedule-reconciliation';

export function DeletePlan({ id, title }: { id: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [retryable, setRetryable] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  function removed(schedules?: Schedule[]) {
    setOpen(false);
    setError('');
    setUncertain(false);
    setRetryable(false);
    pageDataCache.update<Schedule[]>(
      schedulesPath,
      (items) => schedules ?? (items ? items.filter((item) => item.id !== id) : null),
    );
    void pageDataCache.refresh(schedulesPath, true);
    queueMicrotask(() =>
      document.querySelector<HTMLButtonElement>('.secondary-heading button')?.focus(),
    );
  }
  async function verify(controller: AbortController, accountVersion: number, checked = false) {
    const result = await reconcileSchedule(
      id,
      (schedule) => schedule === undefined,
      accountVersion,
      controller.signal,
    );
    if (result.status === 'aborted') return;
    if (result.status === 'confirmed') {
      removed(result.schedules);
      return;
    }
    if (result.schedules) pageDataCache.update<Schedule[]>(schedulesPath, () => result.schedules!);
    const canRetry = checked && result.schedules?.some((schedule) => schedule.id === id) === true;
    setUncertain(true);
    setRetryable(canRetry);
    setError(
      canRetry
        ? 'The deletion may still finish. The schedule is still present. Check again or try deleting it again.'
        : 'The deletion may still finish. Check schedule status before trying again.',
    );
  }
  async function remove(retrying = false) {
    if (request.current || (uncertain && !retrying)) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setUncertain(false);
    setRetryable(false);
    setError('');
    const accountVersion = requestAccountVersion();
    try {
      await api(`${schedulesPath}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]),
      });
      if (controller.signal.aborted || accountVersion !== requestAccountVersion()) return;
      removed();
    } catch (cause) {
      if (controller.signal.aborted || accountVersion !== requestAccountVersion()) return;
      if (uncertainScheduleMutation(cause) || (cause instanceof ApiError && cause.status === 404))
        await verify(controller, accountVersion);
      else {
        setError(errorMessage(cause));
        void pageDataCache.refresh(schedulesPath, true);
      }
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) {
        setBusy(false);
      }
    }
  }
  async function check() {
    if (request.current || !uncertain) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      await verify(controller, requestAccountVersion(), true);
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function retry() {
    if (retryable) void remove(true);
  }
  function close() {
    setOpen(false);
    setRetryable(false);
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (busy) return;
        if (value) setOpen(true);
        else close();
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Delete schedule ${title}`}
          title="Delete"
          onClick={() => !uncertain && setError('')}
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
          <span>Future runs will stop. Past activity stays in Usage.</span>
        </DialogDescription>
        {error && <Notice kind={uncertain ? 'info' : 'error'}>{error}</Notice>}
        <div className="delete-plan-actions">
          <Button variant="ghost" data-keep-plan disabled={busy} onClick={close}>
            {uncertain ? 'Close' : 'Keep schedule'}
          </Button>
          {uncertain && (
            <>
              <Button variant="outline" disabled={busy} onClick={() => void check()}>
                Check status
              </Button>
              {retryable && (
                <Button variant="destructive" disabled={busy} onClick={retry}>
                  Try deleting again
                </Button>
              )}
            </>
          )}
          <Button variant="destructive" disabled={busy || uncertain} onClick={() => void remove()}>
            {busy ? 'Deleting…' : 'Delete schedule'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
