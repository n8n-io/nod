import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { initializeTheme } from './lib/theme';
import { captureAnalytics, configureAnalytics } from './lib/analytics-client';
import { sessionStore } from './lib/session';
import './styles.css';
import './pages/chat.css';
import './theme.css';
import './pages/secondary-pages.css';
import './pages/apps.css';
import './pages/channels.css';
import './pages/tasks.css';
import './pages/plan-controls.css';
import './components/emoji-picker.css';
import './components/attachment-images.css';
import './components/attachment-card.css';
import './components/vault-details.css';
import './pages/inspector.css';
import './pages/sign-in.css';
import './pages/privacy.css';
import './pages/onboarding.css';
import './components/account-settings.css';
import './components/models.css';
import './components/time-zone-picker.css';
import './components/sidebar-unread.css';

class AppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    captureAnalytics('otto_ui_error', { area: 'application', action: 'render' });
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
            Reload Otto
          </button>
        </main>
      );
    return this.props.children;
  }
}

initializeTheme();
sessionStore.subscribe(() => {
  const { session, signingOut } = sessionStore.getSnapshot();
  configureAnalytics(
    !signingOut && (session?.user || session?.analytics?.distinctId === null)
      ? session?.analytics
      : undefined,
  );
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppBoundary>
      <App />
    </AppBoundary>
  </StrictMode>,
);
