import { Component, createRef, type ReactNode } from 'react';
import { useSession } from '../hooks/use-session';
import { desktopRendererReady } from '../lib/desktop';
import { captureAnalytics } from '../lib/analytics';
import { recordFeedbackError } from '../lib/feedback-errors';
import { FeedbackDialog } from './feedback';

class AppBoundary extends Component<
  { children: ReactNode; ownerId: string | null },
  { failed: boolean; feedbackOpen: boolean }
> {
  state = { failed: false, feedbackOpen: false };
  feedbackTrigger = createRef<HTMLButtonElement>();
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    recordFeedbackError('render', error);
    desktopRendererReady();
    captureAnalytics('ui_error', { area: 'application', action: 'render' });
  }
  render() {
    if (this.state.failed)
      return (
        <main className="empty-state">
          <h1>Let’s try that again.</h1>
          <p>The workspace could not be displayed.</p>
          <button
            className="button button-primary button-default"
            onClick={() => window.location.reload()}
          >
            Reload Nod
          </button>
          {this.props.ownerId && (
            <>
              <button
                ref={this.feedbackTrigger}
                className="button button-outline button-default"
                onClick={() => this.setState({ feedbackOpen: true })}
              >
                Send feedback
              </button>
              <FeedbackDialog
                ownerId={this.props.ownerId}
                open={this.state.feedbackOpen}
                onOpenChange={(feedbackOpen) => this.setState({ feedbackOpen })}
                returnFocus={() => this.feedbackTrigger.current}
              />
            </>
          )}
        </main>
      );
    return this.props.children;
  }
}

export function AppRoot({
  children,
}: {
  children(sessionState: ReturnType<typeof useSession>): ReactNode;
}) {
  const sessionState = useSession();
  const ownerId =
    !sessionState.loading && !sessionState.locked && sessionState.session?.settings
      ? (sessionState.session.user?.id ?? null)
      : null;
  return (
    <AppBoundary key={`${ownerId ?? ''}:${sessionState.epoch}`} ownerId={ownerId}>
      {children(sessionState)}
    </AppBoundary>
  );
}
