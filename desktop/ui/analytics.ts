import type { AnalyticsConfiguration } from '../../src/shared/analytics';
import { posthog } from 'posthog-js/no-external';
import {
  captureAnalytics,
  capturePageview,
  configureAnalytics,
} from '../../src/web/lib/analytics-client';

type Step = 'preferences' | 'preparing' | 'ready' | 'error';
const firstSetup = new URLSearchParams(location.search).get('firstSetup') === 'true';
const target = window as Window & {
  ottoDesktop?: { getAnalyticsConfiguration(): Promise<AnalyticsConfiguration> };
  ottoSetupAnalytics?: { step(step: Step): void; completed(): Promise<void> };
};
let ready = false;
let currentStep: Step | undefined;
let lastStep: Step | undefined;
let completion: Promise<void> | undefined;

function reportStep() {
  if (!ready || currentStep === lastStep || !currentStep) return;
  captureAnalytics('otto_desktop_setup_step_viewed', { step: currentStep });
  lastStep = currentStep;
}

target.ottoSetupAnalytics = {
  step(step) {
    currentStep = step;
    reportStep();
  },
  completed() {
    completion ??= Promise.resolve(initialization)
      .then(async () => {
        if (!ready) return;
        currentStep = 'ready';
        reportStep();
        if (firstSetup) captureAnalytics('otto_desktop_setup_completed');
        await posthog.shutdown();
      })
      .catch(() => {});
    return completion;
  },
};

const initialization = target.ottoDesktop
  ?.getAnalyticsConfiguration()
  .then((configuration) => {
    configureAnalytics(configuration, 'desktop');
    capturePageview('/desktop/setup');
    ready = true;
    reportStep();
  })
  .catch(() => {});
