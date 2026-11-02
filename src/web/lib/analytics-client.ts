import { posthog } from 'posthog-js/no-external';
import { setAnalyticsClient } from './analytics';

setAnalyticsClient(posthog);

export { configureAnalytics } from './analytics';
