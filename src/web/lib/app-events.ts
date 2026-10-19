import { sessionStore } from './session';

export function subscribeAppEvents(
  accountId: string | undefined,
  handlers: {
    open(): void;
    error(): void;
    message(event: MessageEvent<string>): void;
  },
) {
  const acceptedSession = sessionStore.getSnapshot();
  const epoch = acceptedSession.epoch;
  const owner = accountId ?? acceptedSession.session?.user?.id ?? '';
  let disposed = false;
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000;
  function current() {
    const session = sessionStore.getSnapshot();
    return (
      !disposed && Boolean(owner) && session.session?.user?.id === owner && session.epoch === epoch
    );
  }
  function clearRetry() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  function schedule() {
    if (!current() || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (current() && source?.readyState === EventSource.CLOSED) connect();
    }, delay);
    delay = Math.min(delay * 2, 30_000);
  }
  function connect() {
    if (!current()) return;
    source?.close();
    const events = new EventSource(`/api/events?account=${encodeURIComponent(owner)}`);
    source = events;
    const accepted = () => current() && source === events;
    events.onopen = () => {
      if (!accepted()) return;
      clearRetry();
      delay = 1000;
      handlers.open();
    };
    events.onerror = () => {
      if (!accepted()) return;
      handlers.error();
      void sessionStore.refresh();
      if (events.readyState === EventSource.CLOSED) schedule();
    };
    events.onmessage = (event) => {
      if (accepted()) handlers.message(event);
    };
  }
  function dispose() {
    disposed = true;
    clearRetry();
    source?.close();
    source = undefined;
    unsubscribe();
  }
  const unsubscribe = sessionStore.subscribe(() => {
    if (!current()) dispose();
  });
  connect();
  return dispose;
}
