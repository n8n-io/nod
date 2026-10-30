import { posthog } from 'posthog-js/no-external';
import 'posthog-js/dist/posthog-recorder.js';
import { setAnalyticsClient } from './analytics';

setAnalyticsClient(posthog);

export { configureAnalytics } from './analytics';
