import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { desktopRendererReady } from './lib/desktop';
import { initializeTheme } from './lib/theme';
import { initializeFocusVisibility } from './lib/focus';
import { captureAnalytics, configureAnalytics } from './lib/analytics-client';
import { claimAccess, sessionStore } from './lib/session';
import './styles.css';
import './components/message-actions.css';
import './components/telegram-chat-link.css';
import './components/private-entry.css';
import './components/app-discovery-dialog.css';
import './components/composer.css';
import './pages/chat.css';
import './theme.css';
import './pages/secondary-pages.css';
import './pages/apps.css';
import './components/app-connection-dialog.css';
import './pages/channels.css';
import './pages/tasks.css';
import './pages/memory.css';
import './pages/trust.css';
import './pages/plan-controls.css';
import './components/emoji-picker.css';
import './components/attachment-images.css';
import './components/attachment-card.css';
import './components/artifact-drawer.css';
import './components/n8n-canvas.css';
import './components/vault-details.css';
import './pages/browser.css';
import './pages/privacy.css';
import './pages/onboarding/onboarding.css';
import './pages/onboarding/steps/welcome.css';
import './pages/onboarding/steps/brain.css';
import './pages/onboarding/steps/about.css';
import './pages/onboarding/steps/email.css';
import './pages/onboarding/steps/telegram.css';
import './components/account-settings.css';
import './components/feedback.css';
import './components/editor-formatting.css';
import './components/feedback-attachments.css';
import './components/feedback-diagnostics.css';
import './components/telegram-setup.css';
import './components/models.css';
import './components/time-zone-picker.css';
import './components/sidebar-unread.css';

class AppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    desktopRendererReady();
    captureAnalytics('nod_ui_error', { area: 'application', action: 'render' });
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
            Reload nod
          </button>
        </main>
      );
    return this.props.children;
  }
}

initializeTheme();
initializeFocusVisibility();
sessionStore.subscribe(() => {
  const { session } = sessionStore.getSnapshot();
  configureAnalytics(
    session?.user || session?.analytics?.distinctId === null ? session?.analytics : undefined,
  );
});

window.addEventListener('hashchange', async () => {
  if (await claimAccess()) await sessionStore.refresh();
});
void claimAccess().finally(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppBoundary>
        <App />
      </AppBoundary>
    </StrictMode>,
  ),
);
