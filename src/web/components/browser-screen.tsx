import { useEffect, useRef, useState } from 'react';
import { Maximize2, Monitor } from './icons';
import { Button, Dialog, DialogContent, DialogTitle, Notice } from './ui';
import { post, errorMessage, apiResponse } from '../lib/api';
import { formatTime } from '../lib/date-format';
import type { CurrentBrowser } from '../../shared/contracts';
import { browserErrorMessage } from '../../shared/browser-errors';

export function BrowserScreen({
  data,
  onStopped,
}: {
  data: { currentBrowser?: CurrentBrowser | null } | null;
  onStopped(threadId: string): void;
}) {
  const browserId = data?.currentBrowser?.threadId;
  const activity = useRef(data?.currentBrowser?.lastActivityAt);
  activity.current = data?.currentBrowser?.lastActivityAt;
  const [error, setError] = useState('');
  const [stoppingBrowser, setStoppingBrowser] = useState<string>();
  const [screen, setScreen] = useState('');
  const [screenThread, setScreenThread] = useState<string>();
  const currentScreen = screenThread === browserId ? screen : '';
  const [screenState, setScreenState] = useState('Waiting for a browser session.');
  const [updated, setUpdated] = useState<Date | null>(null);
  const [enlarged, setEnlarged] = useState(false);
  const [captureAttempt, setCaptureAttempt] = useState(0);
  const [capturePaused, setCapturePaused] = useState(false);
  const imageUrl = useRef('');
  useEffect(() => {
    if (!currentScreen) setEnlarged(false);
  }, [currentScreen]);
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    let blockedActivity: string | null = null;
    const controller = new AbortController();
    setScreen('');
    setUpdated(null);
    setCapturePaused(false);
    if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
    imageUrl.current = '';
    setScreenState(
      browserId ? 'Opening the browser view…' : 'The browser appears when nod uses it.',
    );
    async function frame() {
      if (
        !browserId ||
        document.hidden ||
        (blockedActivity !== null && blockedActivity === (activity.current ?? ''))
      ) {
        if (!stopped) timer = setTimeout(() => void frame(), 1000);
        return;
      }
      blockedActivity = null;
      setCapturePaused(false);
      const requestedActivity = activity.current ?? '';
      try {
        const response = await apiResponse(
          `/api/browser/screen?threadId=${encodeURIComponent(browserId)}`,
          {
            cache: 'no-store',
            credentials: 'same-origin',
            signal: controller.signal,
          },
        );
        if (stopped) return;
        if (!response.ok) {
          setScreen('');
          setUpdated(null);
          if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
          imageUrl.current = '';
          const payload = response.status === 409 ? await response.json().catch(() => null) : null;
          if (stopped) return;
          const message = browserErrorMessage(payload?.code);
          if (message || response.status === 423) {
            blockedActivity = requestedActivity;
            setCapturePaused(Boolean(message));
          }
          setScreenState(
            message
              ? message
              : response.status === 423
                ? ''
                : response.status === 404
                  ? 'No browser view is available yet.'
                  : 'The browser view is temporarily unavailable.',
          );
        } else {
          const bytes = await response.blob();
          if (stopped) return;
          const next = URL.createObjectURL(bytes),
            previous = imageUrl.current;
          imageUrl.current = next;
          setScreenThread(browserId);
          setScreen(next);
          setUpdated(new Date(response.headers.get('X-Screen-Captured-At') ?? Date.now()));
          setScreenState('');
          if (previous) URL.revokeObjectURL(previous);
        }
      } catch {
        if (!stopped) {
          setScreen('');
          setUpdated(null);
          if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
          imageUrl.current = '';
          setScreenState('Reconnecting to the browser…');
        }
      } finally {
        if (!stopped) timer = setTimeout(() => void frame(), 1000);
      }
    }
    void frame();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
      imageUrl.current = '';
    };
  }, [browserId, captureAttempt]);
  return (
    <>
      {error && <Notice>{error}</Notice>}
      <section className="live-screen">
        <div className="browser-control">
          <div className="browser-control-heading" role="group" aria-label="Browser view">
            {screen && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Enlarge browser screen"
                onClick={() => setEnlarged(true)}
              >
                <Maximize2 size={16} />
              </Button>
            )}
            {capturePaused && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCaptureAttempt((value) => value + 1)}
              >
                Retry view
              </Button>
            )}
            {browserId &&
              data?.currentBrowser?.threadId === browserId &&
              data.currentBrowser.status === 'running' && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={stoppingBrowser === browserId}
                  aria-label="Stop nod"
                  onClick={() => {
                    const id = browserId;
                    setStoppingBrowser(id);
                    void post('/api/thread/stop')
                      .then(() => {
                        setError('');
                        onStopped(id);
                      })
                      .catch((cause) => setError(errorMessage(cause)))
                      .finally(() => setStoppingBrowser(undefined));
                  }}
                >
                  Stop
                </Button>
              )}
          </div>
          {currentScreen ? (
            <button
              className="screen-preview"
              aria-label="Enlarge browser screen"
              onClick={() => setEnlarged(true)}
            >
              <img src={currentScreen} alt="Browser screen" draggable={false} />
            </button>
          ) : (
            <div className="screen-empty">
              <Monitor size={24} />
              <p>{screenState}</p>
            </div>
          )}
        </div>
        {updated && (
          <div className="screen-caption">
            Updated {formatTime(updated, undefined, { seconds: true })}
          </div>
        )}
      </section>

      <Dialog open={enlarged && Boolean(currentScreen)} onOpenChange={setEnlarged}>
        <DialogContent className="screen-dialog">
          <DialogTitle>Browser screen</DialogTitle>
          <img src={currentScreen} alt="Enlarged browser screen" />
          <p className="field-hint">
            {updated && `Captured ${formatTime(updated, undefined, { seconds: true })}`}
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
