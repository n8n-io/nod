import type { CaptureResult, PostHog } from 'posthog-js';
import { posthogConfig, type AnalyticsConfiguration } from '../../shared/analytics';
import { modelProviders, type ModelProvider } from '../../shared/models';
import {
  onboardingSteps,
  profileCompanySizes,
  profileScopes,
  profileWhoFor,
  type OnboardingStep,
  type ProfileCompanySize,
  type ProfileScope,
  type ProfileWhoFor,
} from '../../shared/onboarding';
import {
  desktopAppOpeningAvailable,
  desktopSettingsAvailable,
  takeDesktopAppOpening,
} from './desktop';
import { analyticsHost, analyticsRoute, sanitizedAnalyticsUrl } from './analytics-privacy';
import { feedbackActivity } from './feedback-activity';
import { requestAccountVersion } from './api';
import type { AttachmentKind } from '../../shared/attachment-kind';
import type { Presentation } from '../../shared/presentation';

type AnalyticsEvents = {
  app_opened: {
    entry: 'native_setup' | 'app_ui';
    server_connection_telemetry_available?: true;
  };
  onboarding_step_viewed: {
    step: OnboardingStep;
    direction: 'forward' | 'back';
  };
  onboarding_step_skipped: { step: 'email' };
  onboarding_profile_answered: {
    scope: ProfileScope | 'skipped';
    role_owner: boolean;
    role_freelance: boolean;
    role_agency: boolean;
    role_engineering: boolean;
    role_product: boolean;
    role_gtm: boolean;
    role_manager: boolean;
    role_student: boolean;
    role_not_working: boolean;
    role_other: boolean;
    who_for: ProfileWhoFor | 'skipped' | 'not_asked';
    company_size: ProfileCompanySize | 'skipped' | 'not_asked';
    job_email: boolean;
    job_calendar: boolean;
    job_meetings: boolean;
    job_errands: boolean;
    job_research: boolean;
    job_routines: boolean;
    job_other: boolean;
  };
  onboarding_community_opened: { channel: 'discord' | 'forum' };
  onboarding_updates_email_submitted: undefined;
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
  task_action: {
    action: 'expand' | 'stop' | 'show_in_chat' | 'open_browser' | 'show_activity' | 'reply';
  };
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
const booleans = [true, false];
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
  app_opened: { entry: ['native_setup', 'app_ui'], server_connection_telemetry_available: [true] },
  onboarding_step_viewed: {
    step: onboardingSteps,
    direction: ['forward', 'back'],
  },
  onboarding_step_skipped: { step: ['email'] },
  onboarding_profile_answered: {
    scope: [...profileScopes.map((option) => option.id), 'skipped'],
    role_owner: booleans,
    role_freelance: booleans,
    role_agency: booleans,
    role_engineering: booleans,
    role_product: booleans,
    role_gtm: booleans,
    role_manager: booleans,
    role_student: booleans,
    role_not_working: booleans,
    role_other: booleans,
    who_for: [...profileWhoFor.map((option) => option.id), 'skipped', 'not_asked'],
    company_size: [...profileCompanySizes.map((option) => option.id), 'skipped', 'not_asked'],
    job_email: booleans,
    job_calendar: booleans,
    job_meetings: booleans,
    job_errands: booleans,
    job_research: booleans,
    job_routines: booleans,
    job_other: booleans,
  },
  onboarding_community_opened: { channel: ['discord', 'forum'] },
  onboarding_updates_email_submitted: {},
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
  task_action: {
    action: ['expand', 'stop', 'show_in_chat', 'open_browser', 'show_activity', 'reply'],
  },
  tab_viewed: {
    page: ['apps'],
    tab: ['all', 'connected'],
  },
  ui_error: {
    area: ['application', 'onboarding', 'chat', 'settings', 'apps', 'models'],
    action: ['load', 'save', 'send', 'connect', 'disconnect', 'prepare', 'stop', 'render'],
  },
};

const appOpenRoutes = new Set([
  '/',
  '/onboarding',
  '/apps',
  '/channels',
  '/tasks',
  '/prepared',
  '/usage',
  '/vault',
  '/settings',
]);

let configuration: AnalyticsConfiguration | undefined;
let configurationAccount: number | undefined;
let posthog: PostHog | undefined;
let initialized = false;
let identity: string | null | undefined;
let surveyIdentity: string | null | undefined;
let surface: 'web' | 'desktop' = 'web';
let lastPage: string | undefined;
let generation = 0;
const eventGenerations = new WeakMap<object, number>();
const guardedClients = new WeakSet<PostHog>();
const opened = new Set<string>();
const openingPending = new Set<string>();
const viewed = new Set<string>();
const viewListeners = new Set<() => void>();
const discoveryConnections = new Map<string, () => void>();
let nativeOpeningQueue: Promise<unknown> = Promise.resolve();

function requestNativeOpening(consented: boolean, distinctId: string | null) {
  const request = nativeOpeningQueue.then(() => takeDesktopAppOpening(consented, distinctId));
  nativeOpeningQueue = request.catch(() => null);
  return request;
}

type AnalyticsRequest = Parameters<PostHog['_send_request']>[0];

function dispatchRequest(request: AnalyticsRequest, send: (request: AnalyticsRequest) => void) {
  if (!configuration?.enabled) return;
  let url: URL;
  try {
    url = new URL(request.url);
    if (url.origin !== new URL(posthogConfig.host).origin) return;
  } catch {
    return;
  }
  const flags = url.pathname === '/flags/';
  const definitions = url.pathname === '/api/surveys/';
  const surveyRequest = flags || definitions;
  let data = request.data;
  if (surveyRequest) {
    if (!configuration.surveys) return;
    if (flags) {
      if (
        request.method !== 'POST' ||
        url.searchParams.get('only_evaluate_survey_feature_flags') !== 'true' ||
        !data ||
        Array.isArray(data) ||
        data.token !== posthogConfig.key ||
        data.distinct_id !== configuration.distinctId
      )
        return;
      data = { token: posthogConfig.key, distinct_id: configuration.distinctId };
      url.search = '?v=2&only_evaluate_survey_feature_flags=true';
    } else {
      if (request.method !== 'GET' || url.searchParams.get('token') !== posthogConfig.key) return;
      data = undefined;
      url.search = new URLSearchParams({ token: posthogConfig.key }).toString();
    }
  } else {
    const events = !data ? [] : Array.isArray(data) ? data : [data];
    if (!events.length || events.some((event) => eventGenerations.get(event) !== generation))
      return;
  }
  const current = generation;
  send({
    ...request,
    url: url.href,
    data,
    timestampMode: surveyRequest ? 'query' : request.timestampMode,
    preferSyncCompression: true,
    callback: (response) => {
      if (
        current === generation &&
        configuration?.enabled &&
        (!surveyRequest || configuration.surveys)
      )
        request.callback?.(response);
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
  configurationAccount = undefined;
  identity = undefined;
  lastPage = undefined;
  if (!posthog || !initialized) return;
  posthog.set_config({
    opt_out_capturing_by_default: true,
    disable_surveys: true,
    advanced_disable_feature_flags: true,
  });
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

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const surveyId = new RegExp(`^${uuid}$`, 'i');
const surveyResponse = new RegExp(`^\\$survey_response(_\\d+|_${uuid})?$`, 'i');
const surveyEvents = ['survey shown', 'survey sent', 'survey dismissed'];

function surveyProperties(event: string, properties: Record<string, unknown>) {
  if (typeof properties.$survey_id !== 'string' || !surveyId.test(properties.$survey_id))
    return null;
  const kept: Record<string, unknown> = { $survey_id: properties.$survey_id };
  const iteration = properties.$survey_iteration;
  if (typeof iteration === 'number' && Number.isSafeInteger(iteration) && iteration >= 0)
    kept.$survey_iteration = iteration;
  const submission = properties.$survey_submission_id;
  if (typeof submission === 'string' && surveyId.test(submission))
    kept.$survey_submission_id = submission;
  if (event === 'survey dismissed' && properties.$survey_partially_completed === true)
    kept.$survey_partially_completed = true;
  if (event !== 'survey sent') return kept;
  if (typeof properties.$survey_completed === 'boolean')
    kept.$survey_completed = properties.$survey_completed;
  if (Array.isArray(properties.$survey_questions))
    kept.$survey_questions = properties.$survey_questions.flatMap((question: unknown) => {
      const { id, question: text } = (question ?? {}) as Record<string, unknown>;
      return typeof id === 'string' && surveyId.test(id) && typeof text === 'string'
        ? [{ id, question: text.slice(0, 500) }]
        : [];
    });
  for (const [key, value] of Object.entries(properties)) {
    if (!surveyResponse.test(key)) continue;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10)
      kept[key] = value;
    else if (typeof value === 'string') kept[key] = value.slice(0, 2000);
  }
  return kept;
}

function sanitizeEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event || !configuration?.enabled) return null;
  const allowed = eventProperties[event.event as keyof AnalyticsEvents];
  const survey = surveyEvents.includes(event.event)
    ? configuration.surveys
      ? surveyProperties(event.event, event.properties)
      : null
    : undefined;
  if (survey === null) return null;
  if (event.event !== '$pageview' && !allowed && !survey) return null;
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
  Object.assign(properties, survey);
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
    if ((next || configuration) && desktopAppOpeningAvailable())
      void requestNativeOpening(false, null).catch(() => {});
    suspendAnalytics();
    return;
  }
  surface = nextSurface;
  const surveysChanged = Boolean(configuration?.surveys) !== Boolean(next.surveys);
  const changed = identity !== next.distinctId;
  if (changed) suspendAnalytics();
  if (initialized && changed) {
    const seen: [string, string][] = [];
    if (surveyIdentity === next.distinctId) {
      try {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith('seenSurvey_') || key === 'lastSeenSurveyDate') {
            const value = localStorage.getItem(key);
            if (value !== null) seen.push([key, value]);
          }
        }
      } catch {}
    }
    posthog.reset({
      resetDeviceID: true,
      bootstrap: next.distinctId ? { distinctID: next.distinctId, isIdentifiedID: true } : {},
    });
    try {
      for (const [key, value] of seen) localStorage.setItem(key, value);
    } catch {}
    posthog.set_config({ opt_out_capturing_by_default: false });
    posthog._retryQueue?.resume();
  }
  configuration = next;
  configurationAccount = requestAccountVersion();
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
      disable_surveys: !next.surveys,
      disable_surveys_automatic_display: true,
      advanced_enable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
      disable_web_experiments: true,
      disable_external_dependency_loading: true,
      advanced_disable_feature_flags: !next.surveys,
      advanced_only_evaluate_survey_feature_flags: true,
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
  } else if (changed || surveysChanged) {
    posthog.set_config({
      disable_surveys: !next.surveys,
      advanced_disable_feature_flags: !next.surveys,
    });
  }
  if (changed) {
    identity = next.distinctId;
    surveyIdentity = next.distinctId;
    lastPage = undefined;
  }
  if (next.surveys && (changed || surveysChanged)) posthog.reloadFeatureFlags();
  captureAppOpened(window.location.pathname);
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

function captureAppOpened(path: string) {
  const id = configuration?.distinctId;
  const route = analyticsRoute(path);
  if (
    !configuration?.enabled ||
    !id ||
    configurationAccount !== requestAccountVersion() ||
    window.opener ||
    !appOpenRoutes.has(route) ||
    opened.has(id) ||
    openingPending.has(id)
  )
    return;
  if (surface === 'desktop' && desktopAppOpeningAvailable()) {
    const current = generation;
    const account = configurationAccount;
    openingPending.add(id);
    void requestNativeOpening(true, id)
      .then((opening) => {
        if (
          current !== generation ||
          account !== requestAccountVersion() ||
          configurationAccount !== account ||
          !configuration?.enabled ||
          configuration.distinctId !== id ||
          opened.has(id)
        )
          return;
        opened.add(id);
        if (
          !opening ||
          !Number.isSafeInteger(opening.openedAt) ||
          opening.openedAt <= 0 ||
          !surveyId.test(opening.uuid)
        )
          return;
        try {
          posthog?.capture(
            'app_opened',
            {
              route: opening.entry === 'native_setup' ? '/onboarding' : route,
              entry: opening.entry,
              ...(opening.entry === 'native_setup' &&
              opening.serverConnectionTelemetryAvailable === true
                ? { server_connection_telemetry_available: true }
                : {}),
            },
            {
              timestamp: new Date(opening.openedAt),
              uuid: opening.uuid,
            },
          );
        } catch {}
      })
      .catch(() => {})
      .finally(() => {
        openingPending.delete(id);
        if (current !== generation) captureAppOpened(window.location.pathname);
      });
    return;
  }
  opened.add(id);
  try {
    posthog?.capture('app_opened', { route, entry: 'app_ui' });
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

export type AnalyticsSurveyQuestion = {
  id: string;
  text: string;
  optional: boolean;
} & ({ kind: 'rating'; scale: 3 | 5 | 7 | 10; low?: string; high?: string } | { kind: 'open' });

export type AnalyticsSurvey = {
  id: string;
  iteration: number | null;
  questions: AnalyticsSurveyQuestion[];
};

function readSurvey(value: unknown): AnalyticsSurvey | undefined {
  const survey = (value ?? {}) as Record<string, unknown>;
  if (typeof survey.id !== 'string' || !surveyId.test(survey.id)) return;
  if (!Array.isArray(survey.questions) || !survey.questions.length) return;
  const label = (text: unknown) => (typeof text === 'string' && text.trim() ? text : undefined);
  const questions = survey.questions.map((value: unknown): AnalyticsSurveyQuestion | undefined => {
    const question = (value ?? {}) as Record<string, unknown>;
    const text = label(question.question);
    if (typeof question.id !== 'string' || !surveyId.test(question.id) || !text) return;
    const base = { id: question.id, text, optional: question.optional === true };
    if (question.type === 'open') return { ...base, kind: 'open' };
    if (question.type !== 'rating' || ![3, 5, 7, 10].includes(question.scale as number)) return;
    return {
      ...base,
      kind: 'rating',
      scale: question.scale as 3 | 5 | 7 | 10,
      low: label(question.lowerBoundLabel),
      high: label(question.upperBoundLabel),
    };
  });
  if (questions.some((question) => !question)) return;
  const iteration = survey.current_iteration;
  return {
    id: survey.id,
    iteration: typeof iteration === 'number' && Number.isSafeInteger(iteration) ? iteration : null,
    questions: questions as AnalyticsSurveyQuestion[],
  };
}

export function watchAnalyticsSurvey(listener: (survey?: AnalyticsSurvey) => void) {
  const stops: (() => void)[] = [];
  let subscribed = false;
  let disposed = false;
  const check = () => {
    try {
      if (disposed) return;
      if (!posthog || !initialized || !configuration?.enabled || !configuration.surveys)
        return listener(undefined);
      if (!subscribed) {
        subscribed = true;
        stops.push(posthog.onFeatureFlags(check), posthog.onSurveysLoaded(check));
      }
      const current = generation;
      posthog.getActiveMatchingSurveys((surveys) => {
        if (disposed || current !== generation || !configuration?.enabled || !configuration.surveys)
          return;
        const survey = surveys.map(readSurvey).find(Boolean);
        if (survey) listener(survey);
      });
    } catch {}
  };
  viewListeners.add(check);
  check();
  return () => {
    disposed = true;
    viewListeners.delete(check);
    for (const stop of stops) stop();
  };
}

export function captureSurvey(
  event: 'shown' | 'sent' | 'dismissed',
  survey: AnalyticsSurvey,
  response?: {
    submission: string;
    answers?: Record<string, number | string>;
    completed?: boolean;
  },
) {
  try {
    if (!configuration?.enabled || !configuration.surveys) return;
    posthog?.capture(`survey ${event}`, {
      $survey_id: survey.id,
      $survey_iteration: survey.iteration,
      ...(response && { $survey_submission_id: response.submission }),
      ...(event === 'dismissed' && response && { $survey_partially_completed: true }),
      ...(event === 'sent' &&
        response?.answers && {
          $survey_completed: response.completed === true,
          $survey_questions: survey.questions.map(({ id, text }) => ({ id, question: text })),
          ...Object.fromEntries(
            Object.entries(response.answers).map(([id, value]) => [
              `$survey_response_${id}`,
              value,
            ]),
          ),
        }),
    });
    if (event === 'shown') localStorage.setItem('lastSeenSurveyDate', new Date().toISOString());
  } catch {}
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
  try {
    captureAppOpened(route);
  } catch {}
  if (route === lastPage) return;
  lastPage = route;
  try {
    posthog?.capture('$pageview', { route });
  } catch {}
}
