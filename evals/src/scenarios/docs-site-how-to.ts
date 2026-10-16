import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { page, type Site } from '../world/sites.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const host = 'docs.northwind.example.com';
const rotating = '/docs/api-keys/rotating';

const sections: Array<[string, string]> = [
  ['/docs/getting-started', 'Getting started'],
  ['/docs/authentication', 'Authentication'],
  ['/docs/api-keys', 'API keys'],
  [rotating, 'Rotating keys'],
  ['/docs/webhooks', 'Webhooks'],
  ['/docs/webhooks/signing-secrets', 'Webhook signing secrets'],
  ['/docs/rate-limits', 'Rate limits'],
  ['/docs/changelog', 'Changelog'],
];

const articles: Record<string, string> = {
  '/docs/getting-started': `<h1>Getting started</h1><p>Northwind is a shipping and fulfilment API. You create shipments, buy labels and track parcels with plain HTTPS requests that send and receive JSON. Every account has a test mode and a live mode, each with its own data and its own keys.</p><p>To make your first request, create an API key (see <a href="/docs/api-keys">API keys</a>), then call <code>GET https://api.northwind.example.com/v2/ping</code> with the key in the <code>Authorization</code> header. A successful call returns <code>{"ok": true}</code>.</p><p>Next, read <a href="/docs/authentication">Authentication</a> to understand how keys are sent, and <a href="/docs/rate-limits">Rate limits</a> before you go live.</p>`,
  '/docs/authentication': `<h1>Authentication</h1><p>Northwind authenticates every request with an API key sent as a bearer token: <code>Authorization: Bearer nw_live_...</code>. Requests without a key, or with a revoked key, fail with <code>401 Unauthorized</code>.</p><p>Test keys start with <code>nw_test_</code> and only see test-mode data. Live keys start with <code>nw_live_</code>. Never put a live key in client-side code or a public repository.</p><p>Keys are created, rotated and revoked from the dashboard. See <a href="/docs/api-keys">API keys</a> for how to manage them.</p>`,
  '/docs/api-keys': `<h1>API keys</h1><p>API keys identify your project when you call the Northwind API. Each key belongs to one project and one mode (test or live).</p><h2>Create a key</h2><ol><li>Open <b>Settings → API</b> in the Northwind dashboard.</li><li>Click <b>New key</b>, give it a name and choose test or live.</li><li>Copy the key. It is shown only once.</li></ol><h2>Limits</h2><p>A project can have at most <b>2 active keys</b> per mode.</p><h2>Revoke a key</h2><p>In <b>Settings → API</b>, open the key's menu and click <b>Revoke</b>. Revoking takes effect immediately: every request that uses the key fails from that moment.</p><h2>Replace a key without downtime</h2><p>If a key may have leaked, or as part of your regular security routine, rotate it instead of revoking it. See <a href="${rotating}">Rotating keys</a>.</p>`,
  [rotating]: `<h1>Rotating keys</h1><p>Rotating a key creates a new key that replaces an existing one, while giving you time to deploy the new key before the old one stops working.</p><h2>How to rotate a key</h2><ol><li>Open <b>Settings → API</b> in the Northwind dashboard.</li><li>Find the key in the <b>Active keys</b> list and click <b>Rotate</b>.</li><li>Confirm, then copy the new key. It is shown only once.</li><li>Deploy the new key to your servers.</li></ol><h2>What happens to the old key</h2><p>After you rotate, <b>the old key keeps working for 36 hours</b>. During this grace period both keys are accepted, so you can roll out the new key without downtime. When the 36 hours are over, the old key is revoked automatically and requests that still use it fail with <code>401 Unauthorized</code>.</p><p>If you need the old key to stop working sooner, open its menu and click <b>Revoke now</b>.</p><h2>Limits</h2><p>A project can have at most 2 active keys per mode, and an old key in its grace period still counts as active. If you already have two active keys, revoke one before you rotate.</p>`,
  '/docs/webhooks': `<h1>Webhooks</h1><p>Northwind sends webhook events to your endpoint when a shipment changes status, a label is purchased or a parcel is delivered. Each event is a JSON POST request signed with your endpoint's signing secret.</p><p>Configure endpoints in <b>Settings → Webhooks</b>. Northwind retries failed deliveries with exponential backoff for up to 3 days.</p><p>To verify signatures and change the secret, see <a href="/docs/webhooks/signing-secrets">Webhook signing secrets</a>.</p>`,
  '/docs/webhooks/signing-secrets': `<h1>Webhook signing secrets</h1><p>Every webhook endpoint has a signing secret that starts with <code>whsec_</code>. Northwind signs each event with it in the <code>Northwind-Signature</code> header, and you should reject events whose signature does not match.</p><h2>Roll a signing secret</h2><ol><li>Open <b>Settings → Webhooks</b> and select the endpoint.</li><li>Click <b>Roll secret</b>.</li></ol><p>After you roll a signing secret, Northwind signs events with both the old and the new secret for <b>72 hours</b>, then only with the new one. Signing secrets are separate from API keys and rolling one does not affect your keys.</p>`,
  '/docs/rate-limits': `<h1>Rate limits</h1><p>Live mode allows 100 requests per second per project and test mode allows 25. When you exceed the limit the API answers <code>429 Too Many Requests</code> with a <code>Retry-After</code> header in seconds.</p><p>Rotating or creating keys does not change your limits: limits apply to the project, not to the key.</p>`,
  '/docs/changelog': `<h1>Changelog</h1><h2>2 March 2026</h2><p>Key rotation: the grace period for the old key after a rotation is now 36 hours (previously 1 hour). See <a href="${rotating}">Rotating keys</a>.</p><h2>18 November 2025</h2><p>Webhook signing secrets can now be rolled with a 72-hour overlap.</p><h2>4 August 2025</h2><p>Projects can now have up to 2 active keys per mode (previously 1).</p>`,
};

function docs(): Site {
  return ({ url }) => {
    const path = url.pathname.replace(/\/$/, '') || '/';
    const nav = `<nav><h2>Northwind docs</h2><ul>${sections.map(([href, label]) => `<li><a href="${href}">${label}</a></li>`).join('')}</ul></nav>`;
    const shell = (title: string, body: string, status = 200) =>
      page(
        `${title} · Northwind Docs`,
        `<header><a href="/">Northwind Developers</a></header>${nav}<main><article>${body}</article></main><footer><p>© 2026 Northwind Logistics</p></footer>`,
        status,
      );
    if (path === '/' || path === '/docs')
      return shell(
        'Developer documentation',
        `<h1>Northwind developer documentation</h1><p>Build shipping into your product with the Northwind API. These guides cover setup, authentication, key management, webhooks and limits.</p><ul>${sections.map(([href, label]) => `<li><a href="${href}">${label}</a></li>`).join('')}</ul><p>Looking for the API reference? Every endpoint is documented under <a href="/docs/getting-started">Getting started</a>.</p>`,
      );
    const article = articles[path];
    if (article) {
      const label = sections.find(([href]) => href === path)?.[1] ?? 'Docs';
      return shell(label, article);
    }
    return shell('Page not found', '<h1>Page not found</h1><p>This page does not exist.</p>', 404);
  };
}

export default scenario({
  id: 'docs-site-how-to',
  title: 'How do I rotate an API key in Northwind, and does the old key keep working?',
  capabilities: ['research', 'browser'],
  tier: 'release',
  calibration: 'pending',
  stance: 'regression',
  complexity: 'simple',
  seconds: 420,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, a developer using the Northwind shipping API. You want to rotate a live API key without downtime. A short answer with the steps is enough.',
  },
  world() {
    return { apps: createApps(owner, {}), sites: { [host]: docs() } };
  },
  async play(session) {
    await session.say(
      `How do I rotate an API key in Northwind, and does the old key keep working? Their developer docs are at https://${host}`,
    );
  },
  evidence(run) {
    const opened = [
      ...new Set(run.visits.filter((visit) => visit.host === host).map((visit) => visit.path)),
    ];
    return [
      'Ground truth from the "Rotating keys" page (docs.northwind.example.com/docs/api-keys/rotating): open Settings → API in the dashboard, find the key under Active keys and click Rotate, confirm and copy the new key (shown once), then deploy it. The old key keeps working for 36 hours after the rotation and is then revoked automatically; "Revoke now" ends it sooner. A project can have at most 2 active keys per mode, and an old key in its grace period counts as active.',
      'Decoys: revoking a key (not rotating) takes effect immediately; webhook signing secrets are rolled under Settings → Webhooks with a 72-hour overlap; the changelog says the rotation grace period used to be 1 hour before 2 March 2026.',
      `Docs pages opened: ${opened.join(', ') || 'none'}.`,
    ].join('\n');
  },
  expect() {
    return [
      check(
        'gives-the-rotate-steps',
        (run) => ({
          pass: /settings/i.test(run.said) && /\bAPI\b/.test(run.said) && /\brotat/i.test(run.said),
          evidence: run.final.slice(0, 400) || 'no answer',
        }),
        {
          failure: 'reasoning',
          otherwise:
            'The answer gives the rotation steps from the Rotating keys page: open Settings then API in the Northwind dashboard, and click Rotate on the key, in any wording.',
        },
      ),
      check(
        'says-36-hours',
        (run) => ({
          pass: /\b36[\s-]*(?:h\b|hours?\b|hrs?\b)|thirty[\s-]six[\s-]hours?/i.test(run.said),
          evidence: run.final.slice(0, 400) || 'no answer',
        }),
        {
          failure: 'reasoning',
          otherwise:
            'The answer says the old API key keeps working for 36 hours after the rotation, in any wording or format.',
        },
      ),
      judge(
        'old-key-grace-period-is-right',
        'The final answer says the old API key keeps working for 36 hours after the rotation (then it is revoked automatically). It fails if it says the old key stops working immediately, after 1 hour, or after 72 hours, or that it keeps working indefinitely. Mentioning 72 hours only for webhook signing secrets, or 1 hour only as the old pre-March 2026 behaviour, is fine.',
        { failure: 'reasoning' },
      ),
      check(
        'opened-the-rotating-keys-page',
        (run) => ({
          pass: run.visits.some((visit) => visit.host === host && visit.path === rotating),
        }),
        { required: false, aspect: 'process', failure: 'incomplete' },
      ),
    ];
  },
});
