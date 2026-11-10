import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { AppRoot } from './components/app-boundary';
import { initializeTheme } from './lib/theme';
import { initializeFocusVisibility } from './lib/focus';
import { configureAnalytics } from './lib/analytics-client';
import { claimAccess, sessionStore } from './lib/session';
import { recordFeedbackError } from './lib/feedback-errors';
import './components/dialog.css';
import './styles.css';
import './components/tabs.css';
import './components/message-actions.css';
import './components/answer-choices.css';
import './components/telegram-chat-link.css';
import './components/private-entry.css';
import './components/app-discovery-dialog.css';
import './components/composer.css';
import './pages/chat.css';
import './theme.css';
import './pages/secondary-pages.css';
import './pages/apps.css';
import './components/integration-card.css';
import './components/app-connection-dialog.css';
import './pages/channels.css';
import './pages/tasks.css';
import './pages/memory.css';
import './pages/usage.css';
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
import './pages/onboarding/steps/join.css';
import './pages/onboarding/steps/personal-connection.css';
import './components/app-account-manager.css';
import './components/whatsapp-setup.css';
import './components/account-settings.css';
import './components/data-sharing.css';
import './components/time-picker.css';
import './components/voice-settings.css';
import './components/feedback.css';
import './components/desktop-update-toast.css';
import './components/survey-card.css';
import './components/editor-formatting.css';
import './components/feedback-attachments.css';
import './components/feedback-diagnostics.css';
import './components/telegram-setup.css';
import './components/models.css';
import './components/connect-row.css';
import './components/search-picker.css';
import './components/sidebar-unread.css';
import './components/sidebar-toggle.css';
import './components/action-menu.css';
import './components/tooltip.css';

initializeTheme();
initializeFocusVisibility();
window.addEventListener('error', (event) =>
  recordFeedbackError('error', event.error ?? event.message),
);
window.addEventListener('unhandledrejection', (event) =>
  recordFeedbackError('rejection', event.reason),
);
sessionStore.subscribe(() => {
  const { session } = sessionStore.getSnapshot();
  configureAnalytics(session?.user ? session.analytics : undefined);
});

if (window.location.pathname === '/trust')
  window.history.replaceState(
    null,
    '',
    `${window.location.search.startsWith('?add=') ? `/vault${window.location.search}` : '/usage'}${window.location.hash}`,
  );
window.addEventListener('hashchange', async () => {
  if (await claimAccess()) await sessionStore.refresh();
});
void claimAccess().finally(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppRoot>{(sessionState) => <App sessionState={sessionState} />}</AppRoot>
    </StrictMode>,
  ),
);
