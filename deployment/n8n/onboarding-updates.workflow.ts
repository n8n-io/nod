import { workflow, node, trigger, ifElse, newCredential, expr } from '@n8n/workflow-sdk';

const request = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.2,
  config: {
    name: 'Nod onboarding email submitted',
    parameters: {
      httpMethod: 'POST',
      path: 'nod/onboarding-updates',
      authentication: 'none',
      responseMode: 'responseNode',
      options: {},
    },
    position: [0, 300],
  },
  output: [
    {
      body: {
        version: 1,
        email: 'person@example.test',
        consent: true,
        consent_version: 2,
        consent_text:
          'I agree that n8n GmbH links my email to my Nod usage data and emails me about Nod and other n8n products.',
        consent_privacy_url: 'https://n8n.io/legal/privacy/',
      },
    },
  ],
});

const validate = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate consent and choices',
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode:
        "const body = $json.body;\nconst object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);\nconst exact = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));\nconst scalar = (value, allowed) => typeof value === 'string' && allowed.includes(value);\nconst choices = (value, allowed) => Array.isArray(value) && value.length > 0 && value.length <= allowed.length && value.every((item) => scalar(item, allowed)) && new Set(value).size === value.length && (value.length === 1 || !value.includes('skipped'));\nconst invalid = () => ({ json: { valid: false } });\nif (!object(body) || JSON.stringify(body).length > 2048 || !exact(body, ['version', 'email', 'consent', 'consent_version', 'consent_text', 'consent_privacy_url', 'profile'])) return invalid();\nif (body.version !== 1 || body.consent !== true || body.consent_version !== 2) return invalid();\nif (body.consent_text !== 'I agree that n8n GmbH links my email to my Nod usage data and emails me about Nod and other n8n products.' || body.consent_privacy_url !== 'https://n8n.io/legal/privacy/') return invalid();\nif (typeof body.email !== 'string') return invalid();\nconst email = body.email.trim().toLowerCase();\nif (email.length > 254 || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/u.test(email)) return invalid();\nconst profile = body.profile;\nif (profile !== undefined) {\n  if (!object(profile) || !exact(profile, ['onboarding_profile_completed', 'onboarding_scope', 'onboarding_roles', 'onboarding_who_for', 'onboarding_company_size', 'onboarding_jobs'])) return invalid();\n  if (profile.onboarding_profile_completed !== true || !scalar(profile.onboarding_scope, ['work', 'personal', 'both', 'skipped'])) return invalid();\n  if (!choices(profile.onboarding_roles, ['owner', 'freelance', 'agency', 'engineering', 'product', 'gtm', 'manager', 'student', 'not_working', 'other', 'skipped'])) return invalid();\n  if (!scalar(profile.onboarding_who_for, ['me', 'clients', 'both', 'skipped', 'not_asked'])) return invalid();\n  if (!scalar(profile.onboarding_company_size, ['solo', '2_10', '11_100', '101_1000', '1000_plus', 'skipped', 'not_asked'])) return invalid();\n  if (!choices(profile.onboarding_jobs, ['email', 'calendar', 'meetings', 'errands', 'research', 'routines', 'other', 'skipped'])) return invalid();\n}\nreturn { json: { valid: true, email, consent_at: new Date().toISOString(), consent_version: body.consent_version, consent_text: body.consent_text, consent_privacy_url: body.consent_privacy_url, ...(profile ? { profile } : {}) } };",
    },
    position: [280, 300],
  },
  output: [{ valid: true, email: 'person@example.test', consent_at: '2026-11-10T10:00:00.000Z' }],
});

const accepted = ifElse({
  version: 2.4,
  config: {
    name: 'Valid submission?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          {
            leftValue: expr('{{ $json.valid }}'),
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
    },
    position: [560, 300],
  },
  output: [{ valid: true, email: 'person@example.test', consent_at: '2026-11-10T10:00:00.000Z' }],
});

const upsert = node({
  type: 'n8n-nodes-base.customerIo',
  version: 1,
  config: {
    name: 'Upsert Nod subscriber',
    parameters: {
      resource: 'customer',
      operation: 'upsert',
      id: expr('{{ $json.email }}'),
      jsonParameters: true,
      additionalFieldsJson: expr(
        '{{ JSON.stringify({ email: $json.email, nod_updates_email_consent: true, nod_updates_email_consent_at: $json.consent_at, nod_updates_email_consent_version: $json.consent_version, nod_updates_email_consent_text: $json.consent_text, nod_updates_email_consent_privacy_url: $json.consent_privacy_url, ...($json.profile ?? {}) }) }}',
      ),
    },
    credentials: { customerIoApi: newCredential('Customer.io account 5') },
    onError: 'continueErrorOutput',
    position: [840, 200],
  },
  output: [{ email: 'person@example.test' }],
});

const ok = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Accept submission',
    parameters: {
      respondWith: 'json',
      responseBody: '{"ok":true}',
      options: { responseCode: 200, enableStreaming: false },
    },
    position: [1120, 140],
  },
  output: [{ ok: true }],
});

const bad = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Reject invalid submission',
    parameters: {
      respondWith: 'json',
      responseBody: '{"ok":false,"error":"invalid"}',
      options: { responseCode: 400, enableStreaming: false },
    },
    position: [840, 430],
  },
  output: [{ ok: false, error: 'invalid' }],
});

const unavailable = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Report Customer.io unavailable',
    parameters: {
      respondWith: 'json',
      responseBody: '{"ok":false,"error":"unavailable"}',
      options: { responseCode: 503, enableStreaming: false },
    },
    position: [1120, 330],
  },
  output: [{ ok: false, error: 'unavailable' }],
});

export default workflow('nod-onboarding-updates', 'Nod onboarding updates')
  .add(request)
  .to(validate)
  .to(accepted.onTrue(upsert.to(ok)).onFalse(bad))
  .add(upsert.onError(unavailable))
  .group('Validate signup', [validate, accepted], {
    description: 'Accepts only versioned, consented email and fixed About choices.',
  });
