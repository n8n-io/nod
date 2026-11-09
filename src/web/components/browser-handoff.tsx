import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, KeyRound, Maximize2, Minimize2, RotateCw } from './icons';
import type { BrowserHandoffInput } from '../../shared/browser-handoff';
import { ApiError, api, apiStream, errorMessage } from '../lib/api';
import { browserFrames } from '../lib/browser-frames';
import { analyticsForCurrentSession } from '../lib/analytics';
import { isPrimaryModifier } from '../lib/navigation';
import { BrandMark } from './brand';
import { Button, Loading } from './ui';

const namedKeys = new Set([
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);
const buttons = ['left', 'middle', 'right'] as const;
const batchBytes = 64 * 1024;
const textPiece = 2000;
const encoder = new TextEncoder();
const revealed = new Set<string>();

async function post<T = unknown>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  try {
    return await api<T>(path, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(75_000)])
        : AbortSignal.timeout(75_000),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError')
      throw new Error(
        'The browser did not confirm this request. Check the page before trying again.',
      );
    throw error;
  }
}

export function BrowserHandoff({ turnId, paused = false }: { turnId: string; paused?: boolean }) {
  const screen = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const pending = useRef<BrowserHandoffInput[]>([]);
  const sending = useRef<Promise<void> | null>(null);
  const lifetime = useRef(new AbortController());
  const clipboardCopies = useRef(
    new Map<
      BrowserHandoffInput,
      { resolve(value: Blob): void; reject(reason: unknown): void; writing: Promise<void> }
    >(),
  );
  const view = useRef(crypto.randomUUID());
  const imageLoad = useRef<{
    url: string;
    resolve: () => void;
    reject: (reason: unknown) => void;
  } | null>(null);
  const pressed = useRef<{ x: number; y: number; button: (typeof buttons)[number] } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [live, setLive] = useState(false);
  const [shown, setShown] = useState(false);
  const [failures, setFailures] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState<'back' | 'reload' | 'resize' | null>(null);
  const [returning, setReturning] = useState(false);
  const [closed, setClosed] = useState(false);
  const [returned, setReturned] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [frame, setFrame] = useState('');
  const unavailable = failures >= 3;

  function stopInput(controller: AbortController = lifetime.current) {
    controller.abort();
    pending.current.length = 0;
    for (const copy of clipboardCopies.current.values()) copy.reject(controller.signal.reason);
    clipboardCopies.current.clear();
  }

  useEffect(() => {
    if (closed) return;
    if (lifetime.current.signal.aborted) lifetime.current = new AbortController();
    const controller = lifetime.current;
    return () => stopInput(controller);
  }, [closed]);

  function flush(): Promise<void> {
    const signal = lifetime.current.signal;
    sending.current ??= (async () => {
      while (pending.current.length && !signal.aborted) {
        const inputs: BrowserHandoffInput[] = [];
        let bytes = 0;
        for (const input of pending.current) {
          const size = encoder.encode(JSON.stringify(input)).length;
          if (
            inputs.length &&
            (bytes + size > batchBytes || input.type === 'copy' || inputs.at(-1)?.type === 'copy')
          )
            break;
          inputs.push(input);
          bytes += size;
        }
        pending.current.splice(0, inputs.length);
        try {
          const result = await post<{ copiedText?: string }>(
            '/api/browser-handoff',
            { turnId, inputs },
            signal,
          );
          if (signal.aborted) return;
          if (inputs.some((input) => input.type !== 'mouse' || input.event !== 'move'))
            setError('');
          const copy = inputs.find((input) => input.type === 'copy');
          const deferred = copy ? clipboardCopies.current.get(copy) : undefined;
          const copiedText =
            typeof result.copiedText === 'string' && result.copiedText.length
              ? result.copiedText
              : undefined;
          if (copy) clipboardCopies.current.delete(copy);
          if (deferred) {
            if (copiedText) {
              void deferred.writing.catch(() => {
                if (!signal.aborted)
                  setError('The selected text could not be copied to your clipboard.');
              });
              deferred.resolve(new Blob([copiedText], { type: 'text/plain' }));
            } else deferred.reject(new Error('No selected text.'));
          } else if (copy && copiedText)
            try {
              void navigator.clipboard.writeText(copiedText).catch(() => {
                if (!signal.aborted)
                  setError('The selected text could not be copied to your clipboard.');
              });
            } catch {
              setError('The selected text could not be copied to your clipboard.');
            }
        } catch (reason) {
          if (signal.aborted) return;
          for (const input of [...inputs, ...pending.current]) {
            const deferred = clipboardCopies.current.get(input);
            if (!deferred) continue;
            clipboardCopies.current.delete(input);
            deferred.reject(reason);
          }
          setError(errorMessage(reason));
          setLive(false);
          pending.current.length = 0;
          setAttempt((value) => value + 1);
          throw reason;
        }
      }
    })().finally(() => {
      sending.current = null;
      if (pending.current.length && !signal.aborted) void flush().catch(() => {});
    });
    return sending.current;
  }

  function queue(input: BrowserHandoffInput) {
    if (!live || returning || loading) return;
    const queued = pending.current;
    const last = queued.at(-1);
    if (
      last?.type === 'mouse' &&
      last.event === 'move' &&
      input.type === 'mouse' &&
      input.event === 'move'
    )
      queued[queued.length - 1] = input;
    else if (last?.type === 'wheel' && input.type === 'wheel')
      queued[queued.length - 1] = {
        type: 'wheel',
        deltaX: last.deltaX + input.deltaX,
        deltaY: last.deltaY + input.deltaY,
      };
    else if (
      last?.type === 'text' &&
      input.type === 'text' &&
      last.text.length + input.text.length <= textPiece
    )
      queued[queued.length - 1] = { type: 'text', text: last.text + input.text };
    else queued.push(input);
    void flush().catch(() => {});
  }

  function point(event: React.MouseEvent<HTMLImageElement>) {
    const element = event.currentTarget;
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height || !naturalSize.width || !naturalSize.height) return null;
    const scale = Math.min(box.width / naturalSize.width, box.height / naturalSize.height);
    const width = naturalSize.width * scale;
    const height = naturalSize.height * scale;
    const x = (event.clientX - box.left - (box.width - width) / 2) / width;
    const y = (event.clientY - box.top - (box.height - height) / 2) / height;
    return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
  }

  function mouse(event: React.MouseEvent<HTMLImageElement>, kind: 'move' | 'down' | 'up') {
    const at = point(event);
    const button = buttons[event.button] ?? 'left';
    if (!at) return;
    if (kind === 'down') {
      screen.current?.focus();
      pressed.current = { ...at, button };
    }
    if (kind === 'up') pressed.current = null;
    queue({ type: 'mouse', event: kind, ...at, ...(kind === 'move' ? {} : { button }) });
  }

  function release() {
    const held = pressed.current;
    pressed.current = null;
    if (held) queue({ type: 'mouse', event: 'up', x: held.x, y: held.y, button: held.button });
  }

  function copy() {
    if (!live || returning || loading) return;
    const input: BrowserHandoffInput = { type: 'copy' };
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      let resolve!: (value: Blob) => void;
      let reject!: (reason: unknown) => void;
      const data = new Promise<Blob>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      try {
        const writing = navigator.clipboard.write([new ClipboardItem({ 'text/plain': data })]);
        void writing.catch(() => {});
        clipboardCopies.current.set(input, { resolve, reject, writing });
      } catch {}
    }
    queue(input);
  }

  function key(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    const mac = /Mac|iPhone|iPad/.test(window.navigator.platform);
    if (
      event.key.length === 1 &&
      !event.metaKey &&
      (event.getModifierState('AltGraph') || (!event.ctrlKey && (!event.altKey || mac)))
    ) {
      event.preventDefault();
      return queue({ type: 'text', text: event.key });
    }
    if (event.altKey) return;
    const letter = event.key.toLowerCase();
    if (event.ctrlKey || event.metaKey) {
      if (!isPrimaryModifier(event, mac) || letter === 'v' || !/^[a-z0-9]$/.test(letter)) return;
      event.preventDefault();
      if (letter === 'c' && !event.shiftKey) return copy();
      return queue({ type: 'key', key: `Control+${event.shiftKey ? 'Shift+' : ''}${letter}` });
    }
    if (namedKeys.has(event.key)) {
      event.preventDefault();
      return queue({
        type: 'key',
        key: `${event.shiftKey ? 'Shift+' : ''}${event.key}`,
      });
    }
  }

  function paste(event: React.ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    const text = event.clipboardData
      .getData('text/plain')
      .replace(/\r\n?/g, '\n')
      .replace(/\n+$/, '');
    for (const piece of text.match(/[\s\S]{1,2000}/gu) ?? []) queue({ type: 'text', text: piece });
  }

  async function navigate(action: 'back' | 'reload') {
    const capture = analyticsForCurrentSession();
    setLoading(action);
    try {
      await flush();
      await post('/api/browser-handoff/navigate', { turnId, action });
      capture('browser_handoff_action', { action });
      setError('');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(null);
    }
  }

  async function done() {
    if (paused) return;
    const capture = analyticsForCurrentSession();
    setReturning(true);
    try {
      await flush();
      await post('/api/browser-handoff/done', { turnId });
      capture('browser_handoff_action', { action: 'done' });
      setReturned(true);
      stopInput();
      setClosed(true);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setReturning(false);
    }
  }

  async function resize(value: boolean) {
    if (returning || loading) return;
    const capture = analyticsForCurrentSession();
    setLoading('resize');
    try {
      await flush();
      setLive(false);
      setShown(false);
      setExpanded(value);
      if (value !== expanded)
        capture('browser_handoff_action', { action: value ? 'expand' : 'collapse' });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(null);
    }
  }

  useEffect(() => {
    if (closed || unavailable) return;
    const controller = new AbortController();
    let activeSignal: AbortSignal | undefined = controller.signal;
    let current = '';
    const release = () => {
      if (imageLoad.current?.url === current) imageLoad.current = null;
      if (current) URL.revokeObjectURL(current);
      current = '';
    };
    setLive(false);
    setShown(false);
    setFrame('');
    void apiStream(
      `/api/browser-handoff/stream?turnId=${encodeURIComponent(turnId)}&view=${view.current}-${attempt}`,
      { signal: controller.signal },
      (body, signal) => {
        activeSignal = signal;
        return browserFrames(
          body,
          (bytes) =>
            new Promise<void>((resolve, reject) => {
              signal?.throwIfAborted();
              const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
              release();
              current = url;
              const finish = (error?: unknown) => {
                window.clearTimeout(timeout);
                signal?.removeEventListener('abort', abort);
                if (imageLoad.current?.url === url) imageLoad.current = null;
                if (error) reject(error);
                else resolve();
              };
              const abort = () => finish(signal?.reason);
              const timeout = window.setTimeout(
                () => finish(new Error('The browser frame did not load.')),
                10_000,
              );
              imageLoad.current = { url, resolve: () => finish(), reject: finish };
              signal?.addEventListener('abort', abort, { once: true });
              setFrame(url);
            }),
        );
      },
    )
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setLive(false);
        if (
          activeSignal?.aborted ||
          (reason instanceof DOMException && reason.name === 'AbortError') ||
          (reason instanceof ApiError && reason.status === 423)
        ) {
          stopInput();
          setClosed(true);
          return;
        }
        setFailures((value) => value + 1);
      })
      .finally(release);
    return () => {
      controller.abort();
      release();
    };
  }, [turnId, attempt, closed, expanded, unavailable]);

  useEffect(() => {
    const element = dialog.current;
    if (!shown || !element || revealed.has(turnId)) return;
    const reveal = () => {
      if (revealed.has(turnId) || !element.getClientRects().length) return;
      revealed.add(turnId);
      observer?.disconnect();
      element.scrollIntoView({
        block: 'nearest',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      });
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reveal);
    observer?.observe(element);
    reveal();
    return () => observer?.disconnect();
  }, [shown, turnId]);

  useEffect(() => {
    if (closed || live || failures >= 3) return;
    const timer = window.setTimeout(() => setFailures((value) => value + 1), 15_000);
    return () => window.clearTimeout(timer);
  }, [attempt, closed, live, failures]);

  useEffect(() => {
    if (closed || !failures || failures >= 3) return;
    const timer = window.setTimeout(() => setAttempt((value) => value + 1), 1000);
    return () => window.clearTimeout(timer);
  }, [closed, failures]);

  useEffect(() => {
    const element = screen.current;
    if (!element || closed) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
      queue({
        type: 'wheel',
        deltaX: Math.round(event.deltaX * scale),
        deltaY: Math.round(event.deltaY * scale),
      });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [closed, live, expanded, loading, returning]);

  useEffect(() => {
    if (!expanded || closed) return;
    screen.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !event.isComposing &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !screen.current?.contains(event.target as Node)
      )
        void resize(false);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [expanded, closed, loading, returning]);

  if (closed)
    return (
      <p className="browser-handoff-feedback" role="status">
        {returned
          ? 'Control returned to Nod. It will check the page and continue.'
          : 'This browser handoff has ended. Continue in chat.'}
      </p>
    );
  const busy = returning || loading !== null;
  const status = returning
    ? 'Returning control…'
    : unavailable
      ? 'Disconnected'
      : live
        ? 'You have control'
        : failures
          ? 'Reconnecting…'
          : 'Opening browser…';
  const sizeToggle = (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => void resize(!expanded)}
      disabled={busy}
      aria-label={expanded ? 'Shrink browser' : 'Enlarge browser'}
      title={expanded ? 'Shrink browser' : 'Enlarge browser'}
    >
      {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
    </Button>
  );
  const panel = (
    <div
      ref={dialog}
      className={`browser-handoff${expanded ? ' browser-handoff-expanded' : ''}`}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded || undefined}
      aria-label={expanded ? "Nod's browser" : undefined}
      style={
        expanded && naturalSize.width
          ? { width: `min(${naturalSize.width + 2}px, calc(100vw - 48px))` }
          : undefined
      }
    >
      <div className="browser-handoff-header">
        <BrandMark small />
        <span className="browser-handoff-title">Browser</span>
        <span className="browser-handoff-state" role="status" aria-live="polite">
          {status}
        </span>
        {sizeToggle}
      </div>
      <div
        className="browser-handoff-screen"
        ref={screen}
        tabIndex={0}
        role="application"
        aria-disabled={!live || busy}
        aria-label="Nod's browser. Click and type to use it."
        onKeyDown={key}
        onPaste={paste}
      >
        {!unavailable && (
          <img
            key={attempt}
            src={frame || undefined}
            alt="Nod's browser"
            draggable={false}
            hidden={!shown}
            onLoad={(event) => {
              if (imageLoad.current?.url !== event.currentTarget.src) return;
              setLive(true);
              setShown(true);
              setFailures(0);
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
              setNaturalSize((size) =>
                size.width === width && size.height === height ? size : { width, height },
              );
              imageLoad.current.resolve();
            }}
            onError={(event) => {
              if (imageLoad.current?.url !== event.currentTarget.src) return;
              imageLoad.current?.reject(new Error('The browser frame could not load.'));
            }}
            onMouseMove={(event) => mouse(event, 'move')}
            onMouseDown={(event) => mouse(event, 'down')}
            onMouseUp={(event) => mouse(event, 'up')}
            onMouseLeave={release}
            onContextMenu={(event) => event.preventDefault()}
          />
        )}
        {unavailable ? (
          <div className="browser-handoff-recovery">
            <strong>The browser view could not connect.</strong>
            <p>
              Your task is waiting. Try to reconnect the view. The page can close after 30 minutes.
              Your last input will not run again.
            </p>
            <Button
              variant="outline"
              onClick={() => {
                setFailures(0);
                setShown(false);
                setError('');
                setAttempt((value) => value + 1);
              }}
            >
              Reconnect view
            </Button>
          </div>
        ) : !shown ? (
          <Loading label="Opening Nod's browser…" />
        ) : null}
      </div>
      {error && (
        <p className="browser-handoff-feedback" role="alert">
          {error}
        </p>
      )}
      <div className="browser-handoff-bar">
        <div className="browser-handoff-actions">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void navigate('back')}
            disabled={!live || busy}
            aria-label="Back"
            title="Back"
          >
            <ArrowLeft size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void navigate('reload')}
            disabled={!live || busy}
            aria-label={loading === 'reload' ? 'Reloading' : 'Reload'}
            title="Reload"
          >
            <RotateCw size={16} className={loading ? 'spin' : undefined} />
          </Button>
        </div>
        <span>
          {paused
            ? 'Reply in chat to continue this task.'
            : 'Nod is paused while you use this page.'}
        </span>
        <div className="browser-handoff-actions">
          <Button variant="ghost" size="sm" asChild>
            <a
              href="/vault?add=login"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Save login"
              title="Save login"
            >
              <KeyRound size={16} aria-hidden="true" />
              <span className="browser-handoff-save-label">Save login</span>
            </a>
          </Button>
          <Button
            onClick={() => void done()}
            disabled={busy || paused}
            title={paused ? 'Paused at the spending limit.' : undefined}
          >
            {returning ? 'Returning…' : 'Return to Nod'}
          </Button>
        </div>
      </div>
    </div>
  );
  if (!expanded) return panel;
  return (
    <>
      <div className="browser-handoff browser-handoff-placeholder">
        <span>Nod's browser is open in a larger view.</span>
        {sizeToggle}
      </div>
      {createPortal(
        <>
          <div className="browser-handoff-overlay" onClick={() => void resize(false)} />
          {panel}
        </>,
        document.body,
      )}
    </>
  );
}
