import { createRoot } from 'react-dom/client';
import { BrandMark } from '../../src/web/components/brand';
import { MessageBubble } from '../../src/web/components/message';
import { Usage } from '../../src/web/pages/usage';
import { Vault } from '../../src/web/pages/vault';
import { Credentials, Payment } from '../../src/web/pages/credentials';
import { pageDataCache } from '../../src/web/lib/page-data-cache';
import '../../src/web/styles.css';
import '../../src/web/theme.css';
import '../../src/web/pages/chat.css';
import '../../src/web/pages/secondary-pages.css';
import '../../src/web/pages/usage.css';
import '../../src/web/components/private-entry.css';
import '../../src/web/components/message-actions.css';
import '../../src/web/components/vault-details.css';
import './trust-tour.css';

export const scenes = [
  {
    title: 'Give Nod the task.',
    text: 'Give Nod the task. You stay in charge.',
    points: ['Your request', 'Your private forms', 'Your record of the work'],
  },
  {
    title: 'Your words. Your call.',
    text: 'Your words guide the check. For anything outside your request, Nod asks.',
    points: ['Your words guide the check.', 'Nod asks when the action goes beyond your request.'],
    messages: [
      ['user', 'Summarise my unread email.'],
      ['assistant', 'Should I forward invoices to another address?'],
      ['user', 'No. Only a summary.'],
      ['assistant', 'I did not forward them.'],
    ],
  },
  {
    title: 'Secrets take a private path.',
    text: 'Passwords and codes belong in private forms.',
    points: ['Enter passwords and codes privately.', 'Saved secrets stay out of the model.'],
    view: 'code',
  },
  {
    title: 'Check it. Approve it.',
    text: 'Check the shop and amount. Approve each payment.',
    points: ['Check the shop and amount.', 'Approve each payment privately.'],
    view: 'payment',
  },
  {
    title: 'See it. Set limits.',
    text: 'See what Nod did and spent. Set limits. Choose what Nod does on its own.',
    points: [
      'See actions and costs.',
      'Set spending limits.',
      'Choose the work Nod does on its own.',
    ],
    view: 'usage',
  },
  {
    title: 'You stay in charge.',
    text: 'The model check can make mistakes. Review important results. You stay in charge.',
    points: ['Review important results.', 'The model check can make mistakes.'],
  },
];

const now = '2026-10-22T11:25:00.000Z';
const logins = [
  'Billing portal',
  'Business mail',
  'Client portal',
  'Docs workspace',
  'Travel bookings',
].map((label, index) => ({
  id: `login-${index}`,
  kind: 'login',
  label,
  origin: `https://site-${index}.example`,
  username: 'demo@example.com',
  usernameHint: 'demo@example.com',
  updatedAt: now,
}));
const entries = [
  ...logins,
  {
    id: 'card',
    kind: 'card',
    label: 'Travel card',
    brand: 'Visa',
    last4: '4242',
    expiryMonth: 12,
    expiryYear: 2028,
    updatedAt: now,
  },
];
const trust = {
  week: { things: 63, actions: 63, spentUsd: 18.42 },
  month: {
    start: '2026-10-01T00:00:00.000Z',
    days: 31,
    elapsedDays: 22,
    spentUsd: 18.42,
    forecastUsd: 25.95,
    daily: [2.31, 3.54, 4.12, 8.45],
    unpriced: false,
  },
  limit: { monthlyUsd: 40, reached: false },
  taskUsd: 5,
  entries: [
    {
      id: 'email',
      at: now,
      title: 'Send Ana the review time',
      source: 'chat',
      channel: 'web',
      error: null,
      costUsd: 0.12,
      actions: ['Email: send message'],
    },
    {
      id: 'trip',
      at: now,
      title: 'Compare train options',
      source: 'task',
      channel: 'web',
      error: null,
      costUsd: 0.54,
      actions: ['Browser: read train times'],
    },
  ],
  next: null,
};
const fixtures: Record<string, unknown> = {
  '/api/trust': trust,
  '/api/vault': entries,
  '/api/vault/sessions': [],
  '/api/vault/activity': {
    week: { signIns: 3, payments: 1, held: 1 },
    entries: [
      {
        id: 'use',
        at: now,
        action: 'sign_in',
        origin: 'https://site-0.example',
        itemId: 'login-0',
        itemKind: 'login',
        task: 'Read the billing report',
        reason: 'asked',
      },
    ],
  },
  '/api/preferences': {
    notificationRule: 'Flag messages that need my reply. Do not send a reply.',
    timeZone: 'Europe/Lisbon',
    locale: 'en-GB',
    hourCycle: 'h23',
    quietHoursEnabled: false,
    quietStart: '22:00',
    quietEnd: '08:00',
  },
  '/api/credential-requests/demo': {
    id: 'demo',
    turnId: 'demo',
    origin: 'https://example.com',
    label: 'Example account',
    kind: 'otp',
    status: 'pending',
  },
  '/api/credential-requests/demo/status': { status: 'pending' },
  '/api/payment-requests/demo': {
    origin: 'https://shop.example',
    amount: '€42.00',
    card: 'Visa •••• 4242',
    destinations: ['https://shop.example'],
  },
  '/api/payment-requests/demo/status': { status: 'pending' },
};
for (const login of logins)
  fixtures[`/api/vault/${login.id}/details`] = { ...login, hasPassword: true };
const missingPaths: string[] = [];
Object.assign(window, { mediaMissingPaths: missingPaths });
window.fetch = async (input) => {
  const path = new URL(String(input), location.href).pathname;
  if (/^\/api\/vault\/login-\d+\/icon$/.test(path)) return new Response(null, { status: 404 });
  if (!(path in fixtures)) {
    missingPaths.push(path);
    throw new Error(`No media fixture for ${path}`);
  }
  return new Response(JSON.stringify(fixtures[path]), {
    headers: { 'Content-Type': 'application/json' },
  });
};
window.EventSource = class {
  addEventListener() {}
  removeEventListener() {}
  close() {}
} as unknown as typeof EventSource;
let serial = 0;
const root = createRoot(document.getElementById('root')!);
function Brand() {
  return (
    <div className="tour-brand">
      <BrandMark />
      <span>Nod</span>
    </div>
  );
}
function Messages({ rows }: { rows: string[][] }) {
  return (
    <div className="tour-messages chat-page">
      {rows.map(([role, text], index) => (
        <MessageBubble
          key={index}
          message={{
            id: `message-${index}`,
            role: role as 'user' | 'assistant',
            text,
            turnId: null,
            createdAt: now,
            attachments: [],
          }}
        />
      ))}
    </div>
  );
}
function Window({ scene }: { scene: (typeof scenes)[number] }) {
  return (
    <div className="tour-window">
      <header>
        <Brand />
        <span>{scene.view === 'usage' ? 'Usage' : scene.view ? 'Private entry' : 'Chat'}</span>
      </header>
      <div className="tour-window-body">
        {scene.view === 'usage' ? (
          <Usage />
        ) : scene.view === 'code' ? (
          <Credentials id="demo" embedded />
        ) : scene.view === 'payment' ? (
          <Payment id="demo" embedded />
        ) : (
          <>
            <Messages rows={scene.messages ?? []} />
            <div className="tour-composer">
              Message Nod…<span>↑</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
function render(index: number, kind = 'video') {
  serial++;
  const card = kind === 'usage-card';
  trust.month.spentUsd = card ? 7.52 : 18.42;
  trust.limit.monthlyUsd = card ? 25 : 40;
  trust.week.things = card ? 45 : 63;
  (fixtures['/api/preferences'] as { notificationRule: string }).notificationRule = card
    ? ''
    : 'Flag messages that need my reply. Do not send a reply.';
  pageDataCache.clear();
  document.documentElement.dataset.theme = document.documentElement.dataset.theme ?? 'light';
  document.body.dataset.kind = kind;
  const scene = scenes[index];
  root.render(
    kind === 'code' ? (
      <Credentials key={serial} id="demo" />
    ) : kind === 'vault' ? (
      <Vault key={serial} />
    ) : kind.startsWith('usage') ? (
      <Usage key={serial} />
    ) : (
      <div className="tour-stage">
        <header className="tour-header">
          <Brand />
          <span>Trust and Vault</span>
          <small>
            {String(index + 1).padStart(2, '0')} / {String(scenes.length).padStart(2, '0')}
          </small>
        </header>
        {index === 0 || index === scenes.length - 1 ? (
          <main className="tour-cover">
            <Brand />
            <h1>{scene.title}</h1>
            <p>
              {index === 0
                ? 'Give it the task. Review its work.'
                : 'The model check can make mistakes.'}
            </p>
            <div>
              {scene.points.map((point) => (
                <span key={point}>{point}</span>
              ))}
            </div>
          </main>
        ) : (
          <main className="tour-content">
            <Window key={serial} scene={scene} />
            <aside>
              <h1>{scene.title}</h1>
              <ol>
                {scene.points.map((point, i) => (
                  <li key={point}>
                    <b>{i + 1}</b>
                    <span>{point}</span>
                  </li>
                ))}
              </ol>
            </aside>
          </main>
        )}
        <footer className="tour-footer">
          <span>Synthetic demonstration · No live accounts</span>
          <span>Nod · Trust and Vault</span>
          <div>
            <i style={{ width: `${((index + 1) / scenes.length) * 100}%` }} />
          </div>
        </footer>
      </div>
    ),
  );
}
Object.assign(window, { mediaScenes: scenes, renderMedia: render, mediaReady: true });
render(
  Number(new URLSearchParams(location.search).get('scene') ?? 0),
  new URLSearchParams(location.search).get('kind') ?? 'video',
);
