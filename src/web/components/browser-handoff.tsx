import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, KeyRound, Maximize2, Minimize2, RotateCw } from 'lucide-react';
import type { BrowserHandoffInput } from '../../shared/browser-handoff';
import { ApiError, apiStream, errorMessage, post } from '../lib/api';
import { browserFrames } from '../lib/browser-frames';
import { captureAnalytics } from '../lib/analytics';
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

export function BrowserHandoff({ turnId, paused = false }: { turnId: string; paused?: boolean }) {
  const screen = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const pending = useRef<BrowserHandoffInput[]>([]);
  const sending = useRef<Promise<void> | null>(null);
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
  const [expanded, setExpanded] = useState(false);
  const [naturalWidth, setNaturalWidth] = useState(0);
  const [frame, setFrame] = useState('');
  const unavailable = failures >= 3;

  function flush(): Promise<void> {
    sending.current ??= (async () => {
      while (pending.current.length) {
        const inputs: BrowserHandoffInput[] = [];
        let bytes = 0;
        for (const input of pending.current) {
          const size = encoder.encode(JSON.stringify(input)).length;
          if (inputs.length && bytes + size > batchBytes) break;
          inputs.push(input);
          bytes += size;
        }
        pending.current.splice(0, inputs.length);
        try {
          await post('/api/browser-handoff', { turnId, inputs });
          if (inputs.some((input) => input.type !== 'mouse' || input.event !== 'move'))
            setError('');
        } catch (reason) {
          setError(errorMessage(reason));
          setLive(false);
          pending.current.length = 0;
          setAttempt((value) => value + 1);
          throw reason;
        }
      }
    })().finally(() => {
      sending.current = null;
      if (pending.current.length) void flush().catch(() => {});
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
    if (!box.width || !box.height || !element.naturalWidth || !element.naturalHeight) return null;
    const scale = Math.min(box.width / element.naturalWidth, box.height / element.naturalHeight);
    const width = element.naturalWidth * scale;
    const height = element.naturalHeight * scale;
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

  function key(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (
      event.key.length === 1 &&
      !event.metaKey &&
      (event.getModifierState('AltGraph') ||
        (!event.ctrlKey && (!event.altKey || /Mac|iPhone|iPad/.test(window.navigator.platform))))
    ) {
      event.preventDefault();
      return queue({ type: 'text', text: event.key });
    }
    if (event.altKey) return;
    const letter = event.key.toLowerCase();
    if (event.ctrlKey || event.metaKey) {
      if (letter === 'v' || !/^[a-z0-9]$/.test(letter)) return;
      event.preventDefault();
      return queue({ type: 'key', key: `Control+${letter}` });
    }
    if (namedKeys.has(event.key)) {
      event.preventDefault();
      return queue({
        type: 'key',
        key: event.shiftKey && event.key === 'Tab' ? 'Shift+Tab' : event.key,
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
    captureAnalytics('otto_browser_handoff_action', { action });
    setLoading(action);
    try {
      await flush();
      await post('/api/browser-handoff/navigate', { turnId, action });
      setError('');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(null);
    }
  }

  async function done() {
    if (paused) return;
    captureAnalytics('otto_browser_handoff_action', { action: 'done' });
    setReturning(true);
    try {
      await flush();
      await post('/api/browser-handoff/done', { turnId });
      setClosed(true);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setReturning(false);
    }
  }

  async function resize(value: boolean) {
    if (returning || loading) return;
    if (value !== expanded)
      captureAnalytics('otto_browser_handoff_action', { action: value ? 'expand' : 'collapse' });
    setLoading('resize');
    try {
      await flush();
      setLive(false);
      setShown(false);
      setExpanded(value);
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
      if (event.key === 'Escape' && !screen.current?.contains(event.target as Node))
        void resize(false);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [expanded, closed, loading, returning]);

  if (closed) return null;
  const busy = returning || loading !== null;
  const status =
    error ||
    (live
      ? 'Click and type here, then hand it back.'
      : unavailable
        ? 'The browser view could not connect.'
        : shown
          ? 'Reconnecting…'
          : '');
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
      aria-label={expanded ? "Otto's browser" : undefined}
      style={
        expanded && naturalWidth
          ? { width: `min(${naturalWidth + 2}px, calc(100vw - 48px))` }
          : undefined
      }
    >
      {expanded && (
        <div className="browser-handoff-header">
          <BrandMark small />
          <span>Otto's browser</span>
          {sizeToggle}
        </div>
      )}
      <div
        className="browser-handoff-screen"
        ref={screen}
        tabIndex={0}
        role="application"
        aria-disabled={!live || busy}
        aria-label="Otto's browser. Click and type to use it."
        onKeyDown={key}
        onPaste={paste}
      >
        {!unavailable && (
          <img
            key={attempt}
            src={frame || undefined}
            alt="Otto's browser"
            draggable={false}
            hidden={!shown}
            onLoad={(event) => {
              if (imageLoad.current?.url !== event.currentTarget.src) return;
              setLive(true);
              setShown(true);
              setFailures(0);
              setNaturalWidth(event.currentTarget.naturalWidth);
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
          <Button
            variant="outline"
            onClick={() => {
              setFailures(0);
              setShown(false);
              setError('');
              setAttempt((value) => value + 1);
            }}
          >
            Try again
          </Button>
        ) : !shown ? (
          <Loading label="Opening Otto's browser…" />
        ) : null}
      </div>
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
        <span role="status">{status}</span>
        <div className="browser-handoff-actions">
          <Button variant="ghost" size="sm" asChild>
            <a href="/trust?add=login" target="_blank" rel="noopener noreferrer">
              <KeyRound size={16} aria-hidden="true" />
              Save login
            </a>
          </Button>
          {!expanded && sizeToggle}
          <Button
            onClick={() => void done()}
            disabled={!shown || busy || paused}
            title={paused ? 'Paused at the spending limit.' : undefined}
          >
            {returning ? 'Finishing…' : 'Done'}
          </Button>
        </div>
      </div>
    </div>
  );
  if (!expanded) return panel;
  return (
    <>
      <div className="browser-handoff browser-handoff-placeholder">
        <span>Otto's browser is open in a larger view.</span>
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
