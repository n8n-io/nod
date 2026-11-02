import type { CaptureResult, PostHog } from 'posthog-js';
import { posthogConfig, type AnalyticsConfiguration } from '../../shared/analytics';
import { modelProviders, type ModelProvider } from '../../shared/models';
import { desktopSettingsAvailable } from './desktop';
import { analyticsHost, analyticsRoute, sanitizedAnalyticsUrl } from './analytics-privacy';
import { feedbackActivity } from './feedback-activity';
import { requestAccountVersion } from './api';
import type { AttachmentKind } from '../../shared/attachment-kind';
import type { Presentation } from '../../shared/presentation';

type AnalyticsEvents = {
  onboarding_step_viewed: {
    step: 'welcome' | 'email' | 'brain' | 'privacy';
    direction: 'forward' | 'back';
  };
  onboarding_step_skipped: { step: 'email' };
  local_setting_changed:
    | { setting: 'theme'; value: 'light' | 'dark' | 'system' }
    | { setting: 'launch_at_login' | 'desktop_notifications'; value: 'enabled' | 'disabled' }
    | { setting: 'browser_notifications'; value: 'enabled' | 'disabled' | 'dismissed' };
  notification_opened: { kind: 'reply' };
  app_connection_completed: { entry: 'apps' | 'chat' | 'onboarding' | 'manage' };
  presentation_viewed: { kind: Presentation['type'] };
  presentation_action: {
    kind: Presentation['type'];
    action: 'open' | 'copy';
    location: 'message' | 'drawer';
  };
  answer_choices_viewed: { multiple: boolean; option_count: number };
  answer_choices_selected: { multiple: boolean; option_count: number; selected_count: number };
  artifact_viewed: { kind: AttachmentKind | 'file'; location: 'message' | 'drawer' };
  artifact_action: {
    kind: AttachmentKind | 'file';
    location: 'message' | 'drawer' | 'commands' | 'composer';
    action: 'copy' | 'download' | 'download_requested' | 'open' | 'reveal' | 'reuse_requested';
  };
  settings_viewed: {
    tab: 'general' | 'notifications' | 'models' | 'voice' | 'memory' | 'privacy';
  };
  chat_message_sent: {
    has_attachments: boolean;
    is_reply: boolean;
    source: 'composer' | 'task_card' | 'ask_nod' | 'task_reply' | 'answer_choice';
    input: 'text' | 'voice';
  };
  chat_stop_requested: undefined;
  task_card_started: { kind?: 'immediate' | 'ongoing'; position: number };
  setup_link_clicked: { setup: 'app' | 'vault' | 'browser' };
  browser_handoff_action: { action: 'done' | 'back' | 'reload' | 'expand' | 'collapse' };
  message_reaction_changed: {
    operation: 'add' | 'remove' | 'change';
    reaction: 'thumbs_up' | 'heart' | 'joy' | 'party' | 'wow' | 'pray' | 'thumbs_down' | 'other';
    method: 'quick' | 'picker' | 'double_click' | 'menu' | 'pin';
    role: 'assistant' | 'user';
  };
  message_action: {
    action: 'copy' | 'reply';
    role: 'assistant' | 'user';
    method: 'button' | 'context_menu';
  };
  app_connect_clicked: {
    entry: 'apps' | 'chat' | 'onboarding' | 'manage';
    result: 'opened' | 'needs_access_setup';
  };
  model_selected: {
    provider: ModelProvider | 'other';
    entry: 'settings' | 'onboarding';
    recommended: boolean;
  };
  attachment_added: {
    method: 'picker' | 'drop' | 'paste';
    kind: 'image' | 'pdf' | 'other';
    count: '1' | '2-5' | '6+';
  };
  task_action: { action: 'expand' | 'stop' | 'show_in_chat' | 'show_activity' | 'reply' };
  tab_viewed: { page: 'apps'; tab: 'all' | 'connected' };
  ui_error: {
    area: 'application' | 'onboarding' | 'chat' | 'settings' | 'apps' | 'models';
    action: 'load' | 'save' | 'send' | 'connect' | 'disconnect' | 'prepare' | 'stop' | 'render';
  };
};

export type AnalyticsProperties<Event extends keyof AnalyticsEvents> = NonNullable<
  AnalyticsEvents[Event]
>;

const roles = ['assistant', 'user'];
const presentationKinds = [
  'image',
  'map',
  'flights',
  'seats',
  'booking',
  'chart',
  'apps',
  'diagram',
];
const artifactKinds = [
  'image',
  'sticker',
  'audio',
  'video',
  'pdf',
  'markdown',
  'html',
  'csv',
  'spreadsheet',
  'document',
  'presentation',
  'archive',
  'n8n-workflow',
  'text',
  'file',
];
const eventProperties: Record<keyof AnalyticsEvents, Record<string, readonly unknown[]>> = {
  onboarding_step_viewed: {
    step: ['welcome', 'email', 'brain', 'privacy'],
    direction: ['forward', 'back'],
  },
  onboarding_step_skipped: { step: ['email'] },
  local_setting_changed: {
    setting: ['theme', 'launch_at_login', 'desktop_notifications', 'browser_notifications'],
    value: ['light', 'dark', 'system', 'enabled', 'disabled', 'dismissed'],
  },
  notification_opened: { kind: ['reply'] },
  app_connection_completed: { entry: ['apps', 'chat', 'onboarding', 'manage'] },
  presentation_viewed: { kind: presentationKinds },
  presentation_action: {
    kind: presentationKinds,
    action: ['open', 'copy'],
    location: ['message', 'drawer'],
  },
  answer_choices_viewed: { multiple: [true, false], option_count: [1, 2, 3, 4, 5, 6] },
  answer_choices_selected: {
    multiple: [true, false],
    option_count: [1, 2, 3, 4, 5, 6],
    selected_count: [1, 2, 3, 4, 5, 6],
  },
  artifact_viewed: { kind: artifactKinds, location: ['message', 'drawer'] },
  artifact_action: {
    kind: artifactKinds,
    location: ['message', 'drawer', 'commands', 'composer'],
    action: ['copy', 'download', 'download_requested', 'open', 'reveal', 'reuse_requested'],
  },
  settings_viewed: {
    tab: ['general', 'notifications', 'models', 'voice', 'memory', 'privacy'],
  },
  chat_message_sent: {
    has_attachments: [true, false],
    is_reply: [true, false],
    source: ['composer', 'task_card', 'ask_nod', 'task_reply', 'answer_choice'],
    input: ['text', 'voice'],
  },
  chat_stop_requested: {},
  task_card_started: { kind: ['immediate', 'ongoing'], position: [0, 1, 2, 3, 4, 5] },
  setup_link_clicked: { setup: ['app', 'vault', 'browser'] },
  browser_handoff_action: { action: ['done', 'back', 'reload', 'expand', 'collapse'] },
  message_reaction_changed: {
    operation: ['add', 'remove', 'change'],
    reaction: ['thumbs_up', 'heart', 'joy', 'party', 'wow', 'pray', 'thumbs_down', 'other'],
    method: ['quick', 'picker', 'double_click', 'menu', 'pin'],
    role: roles,
  },
  message_action: {
    action: ['copy', 'reply'],
    role: roles,
    method: ['button', 'context_menu'],
  },
  app_connect_clicked: {
    entry: ['apps', 'chat', 'onboarding', 'manage'],
    result: ['opened', 'needs_access_setup'],
  },
  model_selected: {
    provider: [...modelProviders, 'other'],
    entry: ['settings', 'onboarding'],
    recommended: [true, false],
  },
  attachment_added: {
    method: ['picker', 'drop', 'paste'],
    kind: ['image', 'pdf', 'other'],
    count: ['1', '2-5', '6+'],
  },
  task_action: { action: ['expand', 'stop', 'show_in_chat', 'show_activity', 'reply'] },
  tab_viewed: {
    page: ['apps'],
    tab: ['all', 'connected'],
  },
  ui_error: {
    area: ['application', 'onboarding', 'chat', 'settings', 'apps', 'models'],
    action: ['load', 'save', 'send', 'connect', 'disconnect', 'prepare', 'stop', 'render'],
  },
};

let configuration: AnalyticsConfiguration | undefined;
let posthog: PostHog | undefined;
let initialized = false;
let identity: string | null | undefined;
let surface: 'web' | 'desktop' = 'web';
let lastPage: string | undefined;
let generation = 0;
const eventGenerations = new WeakMap<object, number>();
const guardedClients = new WeakSet<PostHog>();
const viewed = new Set<string>();
const viewListeners = new Set<() => void>();
const discoveryConnections = new Map<string, () => void>();

type AnalyticsRequest = Parameters<PostHog['_send_request']>[0];

function dispatchRequest(request: AnalyticsRequest, send: (request: AnalyticsRequest) => void) {
  if (!configuration?.enabled) return;
  const events = Array.isArray(request.data) ? request.data : request.data ? [request.data] : [];
  if (events.some((event) => eventGenerations.get(event) !== generation)) return;
  const current = generation;
  send({
    ...request,
    preferSyncCompression: true,
    callback: (response) => {
      if (current === generation && configuration?.enabled) request.callback?.(response);
    },
  });
}

function guardRetryQueue(client: PostHog) {
  const queue = client._retryQueue;
  if (!queue) return;
  const send = queue.retriableRequest.bind(queue);
  queue.retriableRequest = (request, transport) =>
    dispatchRequest(request, (guarded) => send(guarded, transport));
}

export function setAnalyticsClient(client: PostHog) {
  posthog = client;
  if (guardedClients.has(client) || !client._send_request) return;
  guardedClients.add(client);
  const send = client._send_request.bind(client);
  client._send_request = (request) => dispatchRequest(request, send);
}

function suspendAnalytics() {
  generation++;
  viewed.clear();
  discoveryConnections.clear();
  configuration = undefined;
  identity = undefined;
  lastPage = undefined;
  if (!posthog || !initialized) return;
  posthog.set_config({ opt_out_capturing_by_default: true });
  posthog.__request_queue = [];
  posthog._requestQueue?.unload();
  posthog._retryQueue?.unload();
}

const sdkProperties = [
  'token',
  'distinct_id',
  '$session_id',
  '$window_id',
  '$lib',
  '$lib_version',
  '$browser',
  '$browser_version',
  '$os',
  '$os_version',
  '$device_type',
  '$screen_height',
  '$screen_width',
  '$viewport_height',
  '$viewport_width',
  '$time',
];

function sanitizeEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event || !configuration?.enabled) return null;
  const allowed = eventProperties[event.event as keyof AnalyticsEvents];
  if (event.event !== '$pageview' && !allowed) return null;
  if (
    (event.event === 'answer_choices_viewed' ||
      event.event === 'answer_choices_selected' ||
      event.event === 'chat_message_sent' ||
      event.event === 'presentation_action') &&
    Object.entries(allowed).some(([key, values]) => !values.includes(event.properties[key]))
  )
    return null;
  const properties = Object.fromEntries(
    sdkProperties
      .filter((key) => key in event.properties)
      .map((key) => [key, event.properties[key]]),
  );
  for (const [key, values] of Object.entries(allowed ?? {}))
    if (values.includes(event.properties[key])) properties[key] = event.properties[key];
  const route = analyticsRoute(
    String(event.properties.route ?? lastPage ?? window.location.pathname),
  );
  const sanitized = {
    uuid: event.uuid,
    event: event.event,
    timestamp: event.timestamp,
    properties: {
      ...properties,
      analytics_schema: posthogConfig.schemaVersion,
      ...(configuration.appVersion ? { app_version: configuration.appVersion } : {}),
      environment: configuration.environment,
      surface,
      route,
      $current_url: sanitizedAnalyticsUrl(route),
      $pathname: route,
      $host: analyticsHost,
      $process_person_profile: false,
      $geoip_disable: true,
    },
  };
  eventGenerations.set(sanitized, generation);
  return sanitized;
}

export function configureAnalytics(
  next: AnalyticsConfiguration | undefined,
  nextSurface: 'web' | 'desktop' = typeof window !== 'undefined' && desktopSettingsAvailable()
    ? 'desktop'
    : 'web',
) {
  try {
    applyConfiguration(next, nextSurface);
  } catch {
    try {
      suspendAnalytics();
    } catch {}
  }
  for (const listener of viewListeners) listener();
}

function applyConfiguration(
  next: AnalyticsConfiguration | undefined,
  nextSurface: 'web' | 'desktop',
) {
  if (!posthog) return;
  if (!next?.enabled) {
    suspendAnalytics();
    return;
  }
  surface = nextSurface;
  const changed = identity !== next.distinctId;
  if (changed) suspendAnalytics();
  if (initialized && changed) {
    posthog.reset({
      resetDeviceID: true,
      bootstrap: next.distinctId ? { distinctID: next.distinctId, isIdentifiedID: true } : {},
    });
    posthog.set_config({ opt_out_capturing_by_default: false });
    posthog._retryQueue?.resume();
  }
  configuration = next;
  if (!initialized) {
    posthog.init(posthogConfig.key, {
      api_host: posthogConfig.host,
      persistence: 'memory',
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_exceptions: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      rageclick: false,
      capture_performance: false,
      logs: { captureConsoleLogs: false, beforeSend: () => null },
      metrics: { network: false },
      disable_session_recording: true,
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
      disable_web_experiments: true,
      disable_external_dependency_loading: true,
      advanced_disable_flags: true,
      advanced_disable_feature_flags: true,
      person_profiles: 'never',
      save_referrer: false,
      save_campaign_params: false,
      ip: false,
      bootstrap: next.distinctId ? { distinctID: next.distinctId, isIdentifiedID: true } : {},
      loaded: () => posthog && guardRetryQueue(posthog),
      before_send: sanitizeEvent,
      get_current_url: sanitizedAnalyticsUrl,
    });
    initialized = true;
  }
  if (changed) {
    identity = next.distinctId;
    lastPage = undefined;
  }
}

export function captureAnalytics<Event extends keyof AnalyticsEvents>(
  event: Event,
  ...args: AnalyticsEvents[Event] extends undefined ? [] : [AnalyticsEvents[Event]]
) {
  captureEvent(event, args[0]);
}

function captureEvent(
  event: keyof AnalyticsEvents,
  properties?: AnalyticsEvents[keyof AnalyticsEvents],
) {
  try {
    feedbackActivity.record(event, properties);
    if (configuration?.enabled) posthog?.capture(event, properties);
  } catch {}
}

export function analyticsForCurrentSession(): typeof captureAnalytics {
  const current = generation;
  const account = requestAccountVersion();
  return (event, ...args) => {
    if (current === generation && account === requestAccountVersion())
      captureAnalytics(event, ...args);
  };
}

export function appConnectionAnalytics(
  entry: AnalyticsEvents['app_connection_completed']['entry'],
) {
  const capture = analyticsForCurrentSession();
  let reported = false;
  const complete = () => {
    if (reported) return;
    reported = true;
    capture('app_connection_completed', { entry });
  };
  return { complete, transfer: (id: string) => discoveryConnections.set(id, complete) };
}

export function takeAppConnectionAnalytics(id: string) {
  const complete = discoveryConnections.get(id);
  discoveryConnections.delete(id);
  return complete;
}

export function observeAnalyticsView<
  Event extends 'presentation_viewed' | 'artifact_viewed' | 'answer_choices_viewed',
>(element: HTMLElement, key: string, event: Event, properties: AnalyticsEvents[Event]) {
  const account = requestAccountVersion();
  let intersecting = false;
  let disposed = false;
  const capture = () => {
    if (
      disposed ||
      !intersecting ||
      !configuration?.enabled ||
      account !== requestAccountVersion() ||
      document.visibilityState !== 'visible' ||
      !element.isConnected ||
      element.closest('[hidden]')
    )
      return;
    const identity = `${event}:${key}:${JSON.stringify(properties)}`;
    if (viewed.has(identity)) return;
    viewed.add(identity);
    captureEvent(event, properties);
  };
  const observer =
    typeof IntersectionObserver === 'undefined'
      ? undefined
      : new IntersectionObserver((entries) => {
          for (const entry of entries)
            if (entry.target === element) intersecting = entry.isIntersecting;
          capture();
        });
  observer?.observe(element);
  document.addEventListener('visibilitychange', capture);
  viewListeners.add(capture);
  return () => {
    disposed = true;
    observer?.disconnect();
    document.removeEventListener('visibilitychange', capture);
    viewListeners.delete(capture);
  };
}

export function capturePageview(path: string) {
  feedbackActivity.record('screen', { screen: analyticsRoute(path) });
  if (!configuration?.enabled) return;
  const route = analyticsRoute(path);
  if (route === lastPage) return;
  lastPage = route;
  try {
    posthog?.capture('$pageview', { route });
  } catch {}
}
