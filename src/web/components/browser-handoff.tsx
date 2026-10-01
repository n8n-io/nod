import { useEffect, useRef, useState } from 'react';
import type { BrowserHandoffInput } from '../../shared/browser-handoff';
import { browserHandoffKeys } from '../../shared/browser-handoff';
import { apiResponse, errorMessage, post } from '../lib/api';
import { Button, Loading } from './ui';

const specialKeys = new Set<string>(browserHandoffKeys);

export function BrowserHandoff({ onDone }: { onDone: () => void }) {
  const screen = useRef<HTMLDivElement>(null);
  const queue = useRef(Promise.resolve());
  const typed = useRef('');
  const scrolled = useRef(0);
  const timers = useRef<{ type?: number; scroll?: number }>({});
  const [image, setImage] = useState<string>();
  const [error, setError] = useState('');
  const [closed, setClosed] = useState(false);

  async function refresh() {
    const response = await apiResponse('/api/browser-handoff/screen', { cache: 'no-store' });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? 'The browser view is unavailable.');
      return;
    }
    const url = URL.createObjectURL(await response.blob());
    setError('');
    setImage(url);
  }

  function send(input: BrowserHandoffInput) {
    queue.current = queue.current
      .then(() => post('/api/browser-handoff', input))
      .then(() => new Promise((resolve) => window.setTimeout(resolve, 300)))
      .then(refresh)
      .catch((reason: unknown) => setError(errorMessage(reason)));
  }

  useEffect(() => {
    if (closed) return;
    void refresh().catch(() => setError('The browser view is unavailable.'));
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh().catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [closed]);

  useEffect(() => {
    const element = screen.current;
    if (!element || closed) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      scrolled.current += event.deltaY;
      window.clearTimeout(timers.current.scroll);
      timers.current.scroll = window.setTimeout(flushScroll, 150);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [closed, image]);

  useEffect(() => {
    if (!image) return;
    return () => URL.revokeObjectURL(image);
  }, [image]);

  function click(event: React.MouseEvent<HTMLImageElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    screen.current?.focus();
    send({
      type: 'click',
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    });
  }

  function key(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
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

  if (closed) return null;
  return (
    <div className="browser-handoff">
      <div
        className="browser-handoff-screen"
        ref={screen}
        tabIndex={0}
        role="application"
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
        <span role="status">{error || 'Click and type here, then hand it back.'}</span>
        <Button
          onClick={() => {
            flushTyped();
            flushScroll();
            setClosed(true);
            void queue.current.then(onDone);
          }}
        >
          Done
        </Button>
      </div>
    </div>
  );
}
