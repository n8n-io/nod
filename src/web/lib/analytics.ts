import type { CaptureResult, PostHog } from 'posthog-js';
import { posthogConfig, type AnalyticsConfiguration } from '../../shared/analytics';
import { modelProviders, type ModelProvider } from '../../shared/models';
import { desktopSettingsAvailable } from './desktop';
import { analyticsRoute, recordingOptions, sanitizedAnalyticsUrl } from './analytics-privacy';
import { feedbackActivity } from './feedback-activity';
import { requestAccountVersion } from './api';

type AnalyticsEvents = {
  nod_onboarding_step_viewed: {
    step: 'welcome' | 'email' | 'brain' | 'privacy';
    direction: 'forward' | 'back';
  };
  nod_onboarding_step_skipped: { step: 'email' };
  nod_settings_viewed: {
    tab:
      'general' | 'notifications' | 'models' | 'voice' | 'app_connections' | 'memory' | 'privacy';
  };
  answer_choices_viewed: { multiple: boolean; option_count: number };
  answer_choices_selected: { multiple: boolean; option_count: number; selected_count: number };
  chat_message_sent: {
    has_attachments: boolean;
    is_reply: boolean;
    source: 'composer' | 'task_card' | 'ask_nod' | 'task_reply' | 'answer_choice';
    input: 'text' | 'voice';
  };
  nod_chat_stop_requested: undefined;
  nod_task_card_started: { kind?: 'immediate' | 'ongoing'; position: number };
  nod_setup_link_clicked: { setup: 'app' | 'vault' | 'browser' };
  nod_browser_handoff_action: { action: 'done' | 'back' | 'reload' | 'expand' | 'collapse' };
  nod_message_reaction_changed: {
    operation: 'add' | 'remove' | 'change';
    reaction: 'thumbs_up' | 'heart' | 'joy' | 'party' | 'wow' | 'pray' | 'thumbs_down' | 'other';
    method: 'quick' | 'picker' | 'double_click' | 'menu' | 'pin';
    role: 'assistant' | 'user';
  };
  nod_message_action: {
    action: 'copy' | 'reply';
    role: 'assistant' | 'user';
    method: 'button' | 'context_menu';
  };
  nod_app_connect_clicked: {
    entry: 'apps' | 'chat' | 'onboarding' | 'manage';
    result: 'opened' | 'needs_access_setup';
  };
  nod_model_selected: {
    provider: ModelProvider | 'other';
    entry: 'settings' | 'onboarding';
    recommended: boolean;
  };
  nod_attachment_added: {
    method: 'picker' | 'drop' | 'paste';
    kind: 'image' | 'pdf' | 'other';
    count: '1' | '2-5' | '6+';
  };
  nod_task_action: { action: 'expand' | 'stop' | 'show_in_chat' | 'show_activity' | 'reply' };
  nod_tab_viewed: { page: 'apps'; tab: 'all' | 'connected' };
  nod_ui_error: {
    area: 'application' | 'onboarding' | 'chat' | 'settings' | 'apps' | 'models';
    action: 'load' | 'save' | 'send' | 'connect' | 'disconnect' | 'prepare' | 'stop' | 'render';
  };
};

export type AnalyticsProperties<Event extends keyof AnalyticsEvents> = NonNullable<
  AnalyticsEvents[Event]
>;

const roles = ['assistant', 'user'];
const eventProperties: Record<keyof AnalyticsEvents, Record<string, readonly unknown[]>> = {
  nod_onboarding_step_viewed: {
    step: ['welcome', 'email', 'brain', 'privacy'],
    direction: ['forward', 'back'],
  },
  nod_onboarding_step_skipped: { step: ['email'] },
  nod_settings_viewed: {
    tab: ['general', 'notifications', 'models', 'voice', 'app_connections', 'memory', 'privacy'],
  },
  answer_choices_viewed: { multiple: [true, false], option_count: [1, 2, 3, 4, 5, 6] },
  answer_choices_selected: {
    multiple: [true, false],
    option_count: [1, 2, 3, 4, 5, 6],
    selected_count: [1, 2, 3, 4, 5, 6],
  },
  chat_message_sent: {
    has_attachments: [true, false],
    is_reply: [true, false],
    source: ['composer', 'task_card', 'ask_nod', 'task_reply', 'answer_choice'],
    input: ['text', 'voice'],
  },
  nod_chat_stop_requested: {},
  nod_task_card_started: { kind: ['immediate', 'ongoing'], position: [0, 1, 2, 3, 4, 5] },
  nod_setup_link_clicked: { setup: ['app', 'vault', 'browser'] },
  nod_browser_handoff_action: { action: ['done', 'back', 'reload', 'expand', 'collapse'] },
  nod_message_reaction_changed: {
    operation: ['add', 'remove', 'change'],
    reaction: ['thumbs_up', 'heart', 'joy', 'party', 'wow', 'pray', 'thumbs_down', 'other'],
    method: ['quick', 'picker', 'double_click', 'menu', 'pin'],
    role: roles,
  },
  nod_message_action: {
    action: ['copy', 'reply'],
    role: roles,
    method: ['button', 'context_menu'],
  },
  nod_app_connect_clicked: {
    entry: ['apps', 'chat', 'onboarding', 'manage'],
    result: ['opened', 'needs_access_setup'],
  },
  nod_model_selected: {
    provider: [...modelProviders, 'other'],
    entry: ['settings', 'onboarding'],
    recommended: [true, false],
  },
  nod_attachment_added: {
    method: ['picker', 'drop', 'paste'],
    kind: ['image', 'pdf', 'other'],
    count: ['1', '2-5', '6+'],
  },
  nod_task_action: { action: ['expand', 'stop', 'show_in_chat', 'show_activity', 'reply'] },
  nod_tab_viewed: {
    page: ['apps'],
    tab: ['all', 'connected'],
  },
  nod_ui_error: {
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
let recordingFrame: number | undefined;
let generation = 0;
const eventGenerations = new WeakMap<object, number>();
const guardedClients = new WeakSet<PostHog>();
const viewed = new Set<string>();
const viewListeners = new Set<() => void>();

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
  configuration = undefined;
  identity = undefined;
  lastPage = undefined;
  if (recordingFrame !== undefined) cancelAnimationFrame(recordingFrame);
  recordingFrame = undefined;
  if (!posthog || !initialized) return;
  const recording = posthog.sessionRecording as unknown as
    { _discardRecording(discardProducerEvents: boolean): void } | undefined;
  recording?._discardRecording(true);
  posthog.stopSessionRecording();
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
  '$snapshot_data',
  '$snapshot_bytes',
  '$snapshot_source',
];

const triggerStatuses = ['trigger_activated', 'trigger_pending', 'trigger_disabled'];
const replayProperties: Record<string, readonly unknown[]> = {
  $recording_status: [
    'disabled',
    'sampled',
    'active',
    'buffering',
    'paused',
    'lazy_loading',
    'awaiting_config',
    'missing_config',
    'rrweb_error',
  ],
  $sdk_debug_replay_url_trigger_status: triggerStatuses,
  $sdk_debug_replay_event_trigger_status: triggerStatuses,
  $sdk_debug_replay_linked_flag_trigger_status: triggerStatuses,
  $sdk_debug_recording_script_not_loaded: [true, false],
  $sdk_debug_replay_stale_config: [true, false],
  $sdk_debug_replay_rrweb_error: [true, false],
  $sdk_debug_rrweb_attached: [true, false],
  $sdk_debug_rrweb_start_attempted: [true, false],
  $sdk_debug_replay_flush_hold_reason: [
    'no_interaction_since_recording_started',
    'no_interaction_since_session_rotated',
  ],
  $session_recording_start_reason: [
    'sampling_overridden',
    'recording_initialized',
    'linked_flag_matched',
    'linked_flag_overridden',
    'sampled',
    'session_id_changed',
    'url_trigger_matched',
    'event_trigger_matched',
  ],
};

function sanitizeEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event || !configuration?.enabled) return null;
  const allowed = eventProperties[event.event as keyof AnalyticsEvents];
  if (event.event !== '$snapshot' && event.event !== '$pageview' && !allowed) return null;
  if (
    (event.event === 'answer_choices_viewed' ||
      event.event === 'answer_choices_selected' ||
      event.event === 'chat_message_sent') &&
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
  for (const [key, values] of Object.entries(replayProperties))
    if (values.includes(event.properties[key])) properties[key] = event.properties[key];
  for (const key of [
    '$sdk_debug_replay_internal_buffer_length',
    '$sdk_debug_replay_internal_buffer_size',
    '$sdk_debug_replay_flushed_size',
  ]) {
    const value: unknown = event.properties[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      properties[key] = value;
  }
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
      $host: 'nod.invalid',
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
      ui_host: 'https://eu.posthog.com',
      persistence: 'memory',
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_exceptions: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      rageclick: false,
      capture_performance: false,
      enable_recording_console_log: false,
      logs: { captureConsoleLogs: false, beforeSend: () => null },
      metrics: { network: false },
      disable_session_recording: true,
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
      disable_web_experiments: true,
      disable_external_dependency_loading: true,
      advanced_disable_feature_flags: true,
      person_profiles: 'never',
      save_referrer: false,
      save_campaign_params: false,
      ip: false,
      session_recording: recordingOptions,
      bootstrap: next.distinctId ? { distinctID: next.distinctId, isIdentifiedID: true } : {},
      loaded: () => posthog && guardRetryQueue(posthog),
      before_send: sanitizeEvent,
      get_current_url: sanitizedAnalyticsUrl,
    });
    initialized = true;
  } else if (changed && !posthog._lastRemoteConfig?.ok) {
    posthog._remoteConfigLoader?.load();
  }
  if (changed) {
    identity = next.distinctId;
    lastPage = undefined;
    const current = generation;
    if (recordingFrame !== undefined) cancelAnimationFrame(recordingFrame);
    recordingFrame = requestAnimationFrame(() => {
      recordingFrame = undefined;
      try {
        if (current === generation && configuration?.enabled) posthog?.startSessionRecording();
      } catch {}
    });
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

export function analyticsReplaySession() {
  try {
    return (configuration?.enabled && posthog?.get_session_id()) || undefined;
  } catch {
    return undefined;
  }
}

export function analyticsForCurrentSession(): typeof captureAnalytics {
  const current = generation;
  const account = requestAccountVersion();
  return (event, ...args) => {
    if (current === generation && account === requestAccountVersion())
      captureAnalytics(event, ...args);
  };
}

export function observeAnalyticsView<Event extends 'answer_choices_viewed'>(
  element: HTMLElement,
  key: string,
  event: Event,
  properties: AnalyticsEvents[Event],
) {
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
