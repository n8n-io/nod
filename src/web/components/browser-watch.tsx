import { useEffect, useRef, useState } from 'react';
import { ApiError, apiStream } from '../lib/api';
import { browserFrames } from '../lib/browser-frames';
import { BrandMark } from './brand';
import { Button, Loading } from './ui';

export function BrowserWatch({ taskId, title }: { taskId: string; title: string }) {
  const [attempt, setAttempt] = useState(0);
  const [frame, setFrame] = useState('');
  const [shown, setShown] = useState(false);
  const [withheld, setWithheld] = useState(false);
  const [ended, setEnded] = useState('');
  const imageLoad = useRef<{ url: string; finish: (error?: unknown) => void } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let current = '';
    const release = () => {
      if (imageLoad.current?.url === current) imageLoad.current = null;
      if (current) URL.revokeObjectURL(current);
      current = '';
    };
    setFrame('');
    setShown(false);
    setWithheld(false);
    setEnded('');
    void apiStream(
      `/api/browser-watch/stream?taskId=${encodeURIComponent(taskId)}`,
      { signal: controller.signal },
      (body, signal) =>
        browserFrames(body, (bytes) => {
          signal?.throwIfAborted();
          if (!bytes.length) {
            release();
            setFrame('');
            setShown(false);
            setWithheld(true);
            return;
          }
          return new Promise<void>((resolve, reject) => {
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
            imageLoad.current = { url, finish };
            signal?.addEventListener('abort', abort, { once: true });
            setFrame(url);
          });
        }),
    )
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setFrame('');
        setShown(false);
        setWithheld(false);
        setEnded(reason instanceof ApiError ? reason.message : 'The browser view ended.');
      })
      .finally(release);
    return () => {
      controller.abort();
      release();
    };
  }, [taskId, attempt]);
  return (
    <div className="browser-handoff" role="region" aria-label={`Browser for ${title}`}>
      <div className="browser-handoff-header">
        <BrandMark small />
        <span className="browser-handoff-title">Browser</span>
        <span className="browser-handoff-state" role="status" aria-live="polite">
          {ended ? 'Not showing' : withheld ? 'Hidden' : shown ? 'Nod has control' : 'Opening…'}
        </span>
      </div>
      <div className="browser-handoff-screen">
        {frame && !ended && (
          <img
            src={frame}
            alt={`Nod's browser for ${title}`}
            draggable={false}
            hidden={!shown}
            onLoad={(event) => {
              if (imageLoad.current?.url !== event.currentTarget.src) return;
              setShown(true);
              setWithheld(false);
              imageLoad.current.finish();
            }}
            onError={(event) => {
              if (imageLoad.current?.url !== event.currentTarget.src) return;
              imageLoad.current.finish(new Error('The browser frame could not load.'));
            }}
          />
        )}
        {ended ? (
          <div className="browser-handoff-recovery">
            <p>{ended}</p>
            <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
              Watch again
            </Button>
          </div>
        ) : withheld && !shown ? (
          <div className="browser-handoff-recovery">
            <p>
              This page has details Nod entered privately, so it stays hidden. The view comes back
              when the page changes.
            </p>
          </div>
        ) : (
          !shown && <Loading label="Opening Nod's browser…" />
        )}
      </div>
      <div className="browser-handoff-bar">
        <span>
          {ended
            ? 'The browser view has ended.'
            : "You're watching. Nod keeps control of this page."}
        </span>
      </div>
    </div>
  );
}
