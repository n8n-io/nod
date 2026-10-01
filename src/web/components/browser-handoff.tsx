import { useEffect, useRef, useState } from 'react';
import type { BrowserHandoffInput } from '../../shared/browser-handoff';
import { browserHandoffKeys } from '../../shared/browser-handoff';
import { apiResponse, errorMessage, post } from '../lib/api';
import { Button, Loading } from './ui';

const specialKeys = new Set<string>(browserHandoffKeys);

export function BrowserHandoff({ onDone }: { onDone: () => Promise<void> }) {
  const screen = useRef<HTMLDivElement>(null);
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
  }, [closed, image]);

  function click(event: React.MouseEvent<HTMLImageElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height) return;
    screen.current?.focus();
    flushTyped();
    send({
      type: 'click',
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    });
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
  return (
    <div className="browser-handoff">
      <div
        className="browser-handoff-screen"
        ref={screen}
        tabIndex={0}
        role="application"
        aria-disabled={!interactive || Boolean(inputError) || returning}
        aria-label="Otto's browser. Click and type to use it."
        onKeyDown={key}
      >
        {image ? (
          <img src={image} alt="Otto's browser" draggable={false} onClick={click} />
        ) : (
          <Loading label="Opening Otto's browser…" />
        )}
      </div>
      <div className="browser-handoff-bar">
        <span role="status">
          {inputError || error || completionError || 'Click and type here, then hand it back.'}
        </span>
        {(inputError || error) && (
          <Button variant="ghost" onClick={() => refreshView(true)} disabled={returning}>
            Refresh view
          </Button>
        )}
        <Button
          onClick={() => void done()}
          disabled={returning || !interactive || Boolean(inputError)}
        >
          {returning ? 'Finishing…' : 'Done'}
        </Button>
      </div>
    </div>
  );
}
