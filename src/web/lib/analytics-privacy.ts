import type { SessionRecordingOptions } from 'posthog-js';

const routes = new Set([
  '/',
  '/onboarding',
  '/apps',
  '/channels',
  '/tasks',
  '/trust',
  '/browser',
  '/credentials',
  '/payments',
]);

export function analyticsRoute(value: string) {
  try {
    const path = new URL(value, 'https://otto.invalid').pathname.replace(/\/$/, '') || '/';
    if (/^\/(?:vault|credentials)\/[^/]+$/.test(path)) return '/credentials';
    if (/^\/payments\/[^/]+$/.test(path)) return '/payments';
    if (path.startsWith('/browser-connect/')) return '/apps';
    if (path === '/you') return '/';
    return routes.has(path) ? path : '/not-found';
  } catch {
    return '/not-found';
  }
}

export function sanitizedAnalyticsUrl(value: string) {
  return `https://otto.invalid${analyticsRoute(value)}`;
}

const blocked = [
  '[data-analytics-private]',
  '.ph-no-capture',
  '.message-text',
  '.browser-window',
  '.browser-handoff',
  '.vault-inset-value',
  '.vault-edit-form',
  '.vault-add-form',
  '.model-key-form',
  '.model-connection-label',
  '.model-option small',
  '.message-reply-quote',
  '.reply-context',
  '.message-link-previews',
  '.message-attachments',
  '.pending-attachments',
  '.artifact-drawer',
  '.chat-turn-preview',
  '.task-preview-title',
  '.task-preview-line',
  '.task-preview-question',
  '.task-preview-result',
  '.task-preview-steps',
  '.task-facts',
  '.task-activity',
  '.saved-plan-title',
  '.saved-plan-description',
  '.saved-plan-note',
  '.schedule-run-error',
  '.trust-sentence',
  '.vault-use-text',
  '.vault-item-text',
  '.vault-hero',
  '.compact-account-details',
  '.channel-account-label',
  'img',
  'picture',
  'video',
  'audio',
  'iframe',
  'canvas',
  'object',
  'embed',
  'input[type="hidden"]',
  'input[type="file"]',
].join(',');

const structuralAttributes = new Set([
  'class',
  'role',
  'type',
  'tabindex',
  'hidden',
  'disabled',
  'checked',
  'selected',
  'open',
  'contenteditable',
  'aria-hidden',
  'aria-expanded',
  'aria-selected',
  'aria-checked',
  'aria-pressed',
  'aria-busy',
  'aria-current',
  'data-state',
  'data-side',
  'data-orientation',
  'width',
  'height',
  'viewBox',
  'viewbox',
  'd',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'cx',
  'cy',
  'r',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'points',
  'xmlns',
]);

function masked(text: string) {
  return text.replace(/\S/g, '*');
}

export const recordingOptions: SessionRecordingOptions = {
  maskAllInputs: true,
  maskInputFn: masked,
  maskTextSelector: '*',
  maskTextFn: (text, element) =>
    element?.closest('[data-analytics-public]') &&
    !element.closest('[data-analytics-private], input, textarea, [contenteditable="true"]')
      ? text
      : masked(text),
  blockSelector: blocked,
  maskAllElementAttributes: false,
  maskAttributeFn: (name, value, element) => {
    if (name === 'data-theme') return ['light', 'dark', 'system'].includes(value) ? value : '';
    if (name === 'data-desktop') return ['true', 'false'].includes(value) ? value : '';
    if (name === '_cssText' || name === 'style')
      return value.replace(/url\([^)]*\)/gi, 'none').replace(/content\s*:[^;]*/gi, 'content: none');
    if (structuralAttributes.has(name)) return value;
    if (
      name === 'href' &&
      element?.tagName === 'LINK' &&
      element.getAttribute('rel') === 'stylesheet'
    )
      return '';
    if (name === 'href') return sanitizedAnalyticsUrl(value);
    return '';
  },
  recordHeaders: false,
  recordBody: false,
  recordCrossOriginIframes: false,
  captureCanvas: { recordCanvas: false },
  captureJsonLd: false,
  collectFonts: false,
  inlineStylesheet: true,
  slimDOMOptions: 'all',
  maskCapturedNetworkRequestFn: (request) =>
    !request.initiatorType && Object.keys(request).length === 1
      ? { ...request, name: sanitizedAnalyticsUrl(request.name) }
      : undefined,
};
