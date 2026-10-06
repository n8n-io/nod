import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2 } from 'lucide-react';
import type { BrowserHandoffInput } from '../../shared/browser-handoff';
import { browserHandoffKeys } from '../../shared/browser-handoff';
import { apiResponse, errorMessage, post } from '../lib/api';
import { BrandMark } from './brand';
import { Button, Loading } from './ui';

const specialKeys = new Set<string>(browserHandoffKeys);

export function BrowserHandoff({ onDone }: { onDone: () => Promise<void> }) {
  const screen = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const queue = useRef(Promise.resolve());
  const pending = useRef(0);
  const active = useRef(false);
  const generation = useRef(0);
  const live = useRef(false);
  const failedInput = useRef(false);
  const finishing = useRef(false);
  const capture = useRef<AbortController | null>(null);
  const imageUrl = useRef<string | undefined>(undefined);
  const typed = useRef('');
  const scrolled = useRef(0);
  const timers = useRef<{ type?: number; scroll?: number }>({});
  const [image, setImage] = useState<string>();
  const [error, setError] = useState('');
  const [inputError, setInputError] = useState('');
  const [completionError, setCompletionError] = useState('');
  const [interactive, setInteractive] = useState(false);
  const [returning, setReturning] = useState(false);
  const [closed, setClosed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [naturalWidth, setNaturalWidth] = useState(0);

  async function refresh() {
    const version = generation.current;
    const controller = new AbortController();
    capture.current = controller;
    try {
      const response = await apiResponse('/api/browser-handoff/screen', {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? 'The browser view is unavailable.');
      }
      const blob = await response.blob();
      if (!active.current || generation.current !== version || controller.signal.aborted)
        return false;
      const url = URL.createObjectURL(blob);
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
      imageUrl.current = url;
      live.current = response.headers.get('X-Screen-State') === 'live';
      setInteractive(live.current);
      setImage(url);
      setError(
        live.current ? '' : 'This is a saved browser view. Reopen the page before interacting.',
      );
      return live.current;
    } catch (reason) {
      if (active.current && generation.current === version && !controller.signal.aborted) {
        live.current = false;
        setInteractive(false);
        setError(errorMessage(reason));
      }
      return false;
    } finally {
      if (capture.current === controller) capture.current = null;
    }
  }

  function enqueue(operation: () => Promise<void>) {
    const version = generation.current;
    pending.current++;
    queue.current = queue.current
      .then(async () => {
        if (active.current && generation.current === version) await operation();
      })
      .finally(() => pending.current--);
  }

  function refreshView(recover = false) {
    if (!active.current || finishing.current || pending.current) return;
    enqueue(async () => {
      if ((await refresh()) && recover) {
        failedInput.current = false;
        setInputError('');
      }
    });
  }

  function send(input: BrowserHandoffInput) {
    if (!active.current || !live.current || failedInput.current || finishing.current) return;
    enqueue(async () => {
      if (failedInput.current) return;
      if (!live.current) {
        failedInput.current = true;
        clearBufferedInput();
        setInputError(
          'The pending action was not sent because the browser view is unavailable. Refresh the view before continuing.',
        );
        return;
      }
      try {
        await post('/api/browser-handoff', input);
      } catch (reason) {
        failedInput.current = true;
        live.current = false;
        clearBufferedInput();
        if (active.current) {
          setInteractive(false);
          setInputError(`${errorMessage(reason)} Refresh the view before continuing.`);
        }
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      if (active.current) await refresh();
    });
  }

  useEffect(() => {
    if (closed) return;
    active.current = true;
    generation.current++;
    enqueue(async () => {
      await refresh();
    });
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refreshView();
    }, 1500);
    return () => {
      active.current = false;
      generation.current++;
      window.clearInterval(timer);
      clearBufferedInput();
      capture.current?.abort();
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
      imageUrl.current = undefined;
    };
  }, [closed]);

  useEffect(() => {
    const element = screen.current;
    if (!element || closed) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!live.current || failedInput.current || finishing.current) return;
      scrolled.current += event.deltaY;
      window.clearTimeout(timers.current.scroll);
      timers.current.scroll = window.setTimeout(flushScroll, 150);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [closed, image, expanded]);

  useEffect(() => {
    if (!expanded || closed) return;
    screen.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !screen.current?.contains(event.target as Node))
        setExpanded(false);
      if (event.key !== 'Tab' || event.defaultPrevented || !dialog.current) return;
      const focusable = [
        ...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'),
      ];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const inside = dialog.current.contains(document.activeElement);
      if (!inside || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => {
      window.removeEventListener('keydown', keydown);
      screen.current?.focus();
    };
  }, [expanded, closed]);

  function click(event: React.MouseEvent<HTMLImageElement>) {
    const element = event.currentTarget;
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height || !element.naturalWidth || !element.naturalHeight) return;
    const scale = Math.min(box.width / element.naturalWidth, box.height / element.naturalHeight);
    const width = element.naturalWidth * scale;
    const height = element.naturalHeight * scale;
    const left = box.left + (box.width - width) / 2;
    const top = box.top + (box.height - height) / 2;
    const x = (event.clientX - left) / width;
    const y = (event.clientY - top) / height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    screen.current?.focus();
    flushTyped();
    send({ type: 'click', x, y });
  }

  function key(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (!live.current || failedInput.current || finishing.current) return;
    if (specialKeys.has(event.key)) {
      event.preventDefault();
      flushTyped();
      send({ type: 'key', key: event.key as (typeof browserHandoffKeys)[number] });
      return;
    }
    if (event.key.length !== 1) return;
    event.preventDefault();
    typed.current += event.key;
    window.clearTimeout(timers.current.type);
    timers.current.type = window.setTimeout(flushTyped, 250);
  }

  function paste(event: React.ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    if (!live.current || failedInput.current || finishing.current) return;
    const text = event.clipboardData
      .getData('text/plain')
      .replace(/\r\n?/g, '\n')
      .replace(/\n+$/, '');
    if (!text) return;
    flushTyped();
    for (let start = 0; start < text.length; start += 200)
      send({ type: 'type', text: text.slice(start, start + 200) });
  }

  function flushScroll() {
    window.clearTimeout(timers.current.scroll);
    const deltaY = Math.max(-2000, Math.min(2000, Math.round(scrolled.current)));
    scrolled.current = 0;
    if (deltaY) send({ type: 'scroll', deltaY });
  }

  function flushTyped() {
    window.clearTimeout(timers.current.type);
    const text = typed.current.slice(0, 200);
    typed.current = '';
    if (text) send({ type: 'type', text });
  }

  function clearBufferedInput() {
    window.clearTimeout(timers.current.type);
    window.clearTimeout(timers.current.scroll);
    typed.current = '';
    scrolled.current = 0;
  }

  async function done() {
    if (finishing.current || failedInput.current || !live.current) return;
    flushTyped();
    flushScroll();
    finishing.current = true;
    setReturning(true);
    setCompletionError('');
    try {
      await queue.current;
      if (!active.current || failedInput.current || !(await refresh())) return;
      await onDone();
      if (active.current) setClosed(true);
    } catch (reason) {
      if (active.current) setCompletionError(errorMessage(reason));
    } finally {
      finishing.current = false;
      if (active.current) setReturning(false);
    }
  }

  if (closed) return null;
  const sizeToggle = (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setExpanded(!expanded)}
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
        aria-disabled={!interactive || Boolean(inputError) || returning}
        aria-label="Otto's browser. Click and type to use it."
        onKeyDown={key}
        onPaste={paste}
      >
        {image ? (
          <img
            src={image}
            alt="Otto's browser"
            draggable={false}
            onClick={click}
            onLoad={(event) => setNaturalWidth(event.currentTarget.naturalWidth)}
          />
        ) : (
          <Loading label="Opening Otto's browser…" />
        )}
      </div>
      <div className="browser-handoff-bar">
        <span role="status">
          {inputError || error || completionError || 'Click and type here, then hand it back.'}
        </span>
        <div className="browser-handoff-actions">
          {(inputError || error) && (
            <Button variant="ghost" onClick={() => refreshView(true)} disabled={returning}>
              Refresh view
            </Button>
          )}
          {!expanded && sizeToggle}
          <Button
            onClick={() => void done()}
            disabled={returning || !interactive || Boolean(inputError)}
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
          <div className="browser-handoff-overlay" onClick={() => setExpanded(false)} />
          {panel}
        </>,
        document.body,
      )}
    </>
  );
}
