import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo, Socket } from 'node:net';
import type { FastifyInstance, preValidationHookHandler } from 'fastify';
import type {
  IntegrationProvider,
  IntegrationService,
  IntegrationSession,
  VerificationEmail,
} from '../src/ports/integrations.ts';
import { runProcess } from '../src/providers/process.ts';
import { fixtureChannelCredentials } from './e2e-channels.ts';

const fixtureOrigin = 'https://example.com';
export const fixturePrefix = '/__otto_e2e__/';
export const fixtureLogin = fixtureOrigin + fixturePrefix + 'login';
export const fixtureHotel = fixtureOrigin + fixturePrefix + 'hotel';
export const fixtureFlight = fixtureOrigin + fixturePrefix + 'flight';
export const fixtureCredentials = {
  username: 'tester@example.test',
  password: 'Synthetic-only-pass-47!',
  code: '482619',
};
export const fixtureSignup = {
  base: { recipient: 'tester+trial@example.test', code: '731408' },
  alternate: { recipient: 'tester+trial-two@example.test', code: '529163' },
};
type SignupVariant = keyof typeof fixtureSignup;
export type Audit = (
  kind: string,
  fields?: Record<string, string | number | boolean | null>,
) => void;

function html(title: string, body: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:18px system-ui;max-width:650px;margin:64px auto;padding:24px}label,input,button{display:block;margin:16px 0}input,button{font:inherit;padding:10px}small{color:#555}a{color:#174cab}table{border-collapse:collapse}td,th{padding:12px;border:1px solid #aaa}</style><h1>${title}</h1>${body}</html>`;
}

async function form(request: IncomingMessage) {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new Error('Fixture form exceeds the limit.');
    parts.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(parts).toString('utf8'));
}

function createSignupFixture(audit: Audit, operatorPath?: string) {
  const sessions = new Map<
    string,
    { variant: SignupVariant; emailVerified: boolean; humanVerified: boolean; created: boolean }
  >();
  const counts = {
    base: { submissions: 0, created: 0 },
    alternate: { submissions: 0, created: 0 },
  };
  const path = fixturePrefix + 'signup';
  const event = (kind: string, variant: SignupVariant, fields: Record<string, boolean | number>) =>
    audit(kind, { alternate: variant === 'alternate', ...fields });
  const start = (variant: SignupVariant, error = '') =>
    html(
      'Start your Northstar trial',
      `${error}<form method="post" action="${path}?variant=${variant}"><label for="trial-email">Work email</label><input id="trial-email" name="email" type="email" autocomplete="username" required><button type="submit">Start free trial</button></form>`,
    );
  const codePage = (error = '') =>
    html(
      'Verify your email',
      `${error}<p>We sent a six-digit verification code to your email.</p><form method="post" action="${path}/email"><label for="email-code">Verification code</label><input id="email-code" name="code" inputmode="numeric" autocomplete="one-time-code" required><button type="submit">Verify email</button></form>`,
    );
  const details = (variant: SignupVariant, error = '') => {
    const name =
      '<label for="display-name">Your name</label><input id="display-name" name="name" value="Trial user" required>';
    const instance =
      '<label for="instance-name">Instance name</label><input id="instance-name" name="instance" value="My trial" required>';
    const challenge = `<iframe title="Human verification" src="${path}/challenge" style="width:100%;height:245px;border:1px solid #aaa"></iframe>`;
    return html(
      'Set up your trial',
      `${error}<p>Your email is verified. Review your trial details and complete the human verification.</p>${variant === 'alternate' ? challenge : ''}<form method="post" action="${path}/create">${variant === 'alternate' ? instance + name : name + instance}${variant === 'base' ? challenge : ''}<button type="submit">Create trial instance</button></form>`,
    );
  };
  const challengePage = (verified: boolean, failed = false) =>
    html(
      'Security verification',
      '<style>body{margin:0;padding:12px}h1{font-size:18px}</style>' +
        (verified
          ? '<p role="status">Verification complete.</p>'
          : `${failed ? '<p role="alert">Automatic verification was unsuccessful. Complete this check manually to continue.</p>' : ''}<form method="post"><button type="submit">Verify I am human</button></form>`),
    );
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname !== path && !url.pathname.startsWith(path + '/')) return false;
    const variant: SignupVariant =
      url.searchParams.get('variant') === 'alternate' ? 'alternate' : 'base';
    const token = /(?:^|;\s*)e2e_signup=([a-f0-9]{48})(?:;|$)/.exec(
      request.headers.cookie || '',
    )?.[1];
    const session = token ? sessions.get(token) : undefined;
    if (url.pathname === path && request.method === 'GET') response.end(start(variant));
    else if (url.pathname === path && request.method === 'POST') {
      const input = await form(request);
      const accepted = input.get('email') === fixtureSignup[variant].recipient;
      event('fixture_signup_identifier', variant, { accepted });
      if (!accepted)
        response.end(start(variant, '<p role="alert">Use the email selected for this trial.</p>'));
      else {
        if (sessions.size >= 100) sessions.delete(sessions.keys().next().value!);
        const id = randomBytes(24).toString('hex');
        sessions.set(id, { variant, emailVerified: false, humanVerified: false, created: false });
        response.setHeader(
          'Set-Cookie',
          `e2e_signup=${id}; HttpOnly; Secure; SameSite=Lax; Path=${path}`,
        );
        event('fixture_signup_code_sent', variant, { sent: true });
        response.end(codePage());
      }
    } else if (!session) response.writeHead(303, { Location: path }).end();
    else if (url.pathname === path + '/email' && request.method === 'POST') {
      const input = await form(request);
      const accepted =
        !session.emailVerified && input.get('code') === fixtureSignup[session.variant].code;
      event('fixture_signup_email', session.variant, { accepted });
      if (!accepted)
        response.end(codePage('<p role="alert">The verification code was not accepted.</p>'));
      else {
        session.emailVerified = true;
        response.end(details(session.variant));
      }
    } else if (!session.emailVerified) response.end(codePage());
    else if (url.pathname === path + '/challenge' && request.method === 'GET')
      response.end(challengePage(session.humanVerified));
    else if (url.pathname === path + '/challenge' && request.method === 'POST') {
      const released = operatorPath
        ? await readFile(operatorPath, 'utf8')
            .then((value) => JSON.parse(value)[session.variant] === true)
            .catch(() => false)
        : false;
      session.humanVerified ||= released;
      event('fixture_signup_human', session.variant, { accepted: session.humanVerified });
      response.end(challengePage(session.humanVerified, !session.humanVerified));
    } else if (url.pathname === path + '/create' && request.method === 'POST') {
      const input = await form(request);
      const current = counts[session.variant];
      current.submissions += 1;
      const accepted =
        session.humanVerified &&
        !session.created &&
        Boolean(input.get('name')?.trim()) &&
        Boolean(input.get('instance')?.trim());
      if (accepted) {
        session.created = true;
        current.created += 1;
      }
      event('fixture_signup_submit', session.variant, {
        accepted,
        submissions: current.submissions,
        created: current.created,
      });
      if (session.created) response.writeHead(303, { Location: path + '/account' }).end();
      else
        response.end(
          details(
            session.variant,
            '<p role="alert">Complete the details and human verification before creating the trial.</p>',
          ),
        );
    } else if (url.pathname === path + '/account' && request.method === 'GET' && session.created) {
      event('fixture_signup_account', session.variant, {
        authenticated: true,
        created: counts[session.variant].created,
      });
      response.end(
        html(
          'Your Northstar trial',
          `<p role="status">Your trial instance is ready.</p><p>Signed in as ${fixtureSignup[session.variant].recipient}.</p><p>The trial workspace is active.</p>`,
        ),
      );
    } else response.writeHead(404).end('Trial page unavailable.');
    return true;
  };
}

export function createAuthFixture(
  audit: Audit = () => {},
  pricesPath?: string,
  operatorPath?: string,
) {
  const signup = createSignupFixture(audit, operatorPath);
  const sessions = new Map<string, { stage: 'password' | 'otp' | 'portal'; expires: number }>();
  const login = (error = '') =>
    html(
      'Northstar demo sign in',
      `<p>Synthetic test account. No real company or customer data.</p>${error}<form method="post" action="${fixturePrefix}password"><label for="username">Email</label><input id="username" name="username" type="email" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Sign in</button></form>`,
    );
  const stagedLogin = (error = '', methods = true) =>
    html(
      'Northstar staged sign in',
      `<p>Synthetic test account. Email and password are entered on separate pages.</p>${error}<form method="post" action="${fixturePrefix}identifier"><label for="username">Email</label><input id="username" name="username" type="email" autocomplete="username" required><button type="submit">Next</button></form>${methods ? `<a href="${fixturePrefix}provider-google">Continue with Google</a><br><a href="${fixturePrefix}provider-apple">Continue with Apple</a>` : ''}`,
    );
  const passwordStep = (error = '') =>
    html(
      'Enter your password',
      `${error}<form method="post" action="${fixturePrefix}password"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Sign in</button></form>`,
    );
  const otp = (error = '') =>
    html(
      'Verify your sign in',
      `${error}<p>Enter the six-digit code from the synthetic operator page.</p><form method="post" action="${fixturePrefix}otp"><label for="code">Verification code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required><button type="submit">Verify</button></form>`,
    );
  return async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    const url = new URL(request.url || '/', fixtureOrigin);
    if (!url.pathname.startsWith(fixturePrefix)) {
      response.writeHead(404).end('Only the fixed synthetic fixture is available on this host.');
      return;
    }
    const cookie = /(?:^|;\s*)e2e_session=([a-f0-9]{48})(?:;|$)/.exec(
      request.headers.cookie || '',
    )?.[1];
    const session = cookie ? sessions.get(cookie) : undefined;
    const active = session && session.expires > Date.now() ? session : undefined;
    try {
      if (await signup(request, response, url)) return;
      if (
        request.method === 'GET' &&
        [fixturePrefix + 'hotel', fixturePrefix + 'flight'].includes(url.pathname)
      ) {
        const saved = pricesPath ? JSON.parse(await readFile(pricesPath, 'utf8')) : {};
        const hotel = url.pathname.endsWith('hotel');
        const price = saved[hotel ? 'hotel' : 'flight'] ?? (hotel ? 180 : 240);
        if (!Number.isInteger(price) || price < 1 || price > 10_000)
          throw new Error('Fixture price is invalid.');
        audit('fixture_price_view', { offer: hotel ? 'hotel' : 'flight', price });
        response.end(
          html(
            hotel ? 'Northstar Hotel rate' : 'Northstar Air fare',
            hotel
              ? `<p>Northstar Hotel, Lisbon. 14–16 October 2026. Standard double room for two adults. Free cancellation until 13 October 2026. Total stay price: €${price}. Taxes included. Room only.</p>`
              : `<p>Northstar Air, Athens (ATH) to Barcelona (BCN), 14 November 2026; return Barcelona (BCN) to Athens (ATH), 17 November 2026. Flights NS 204 and NS 205, direct, one adult, economy basic. Total return fare: €${price}. Taxes included. Cabin bag included. No checked bag.</p>`,
          ),
        );
      } else if (url.pathname === fixturePrefix + 'manual' && request.method === 'GET') {
        response.end(
          html(
            'Manual control check',
            `<p>Use the inspector to enter Hello Northstar and submit.</p><form method="post" action="${fixturePrefix}manual"><label for="note">Test note</label><input id="note" name="note" autocomplete="off" required><button type="submit">Submit test note</button></form>`,
          ),
        );
      } else if (url.pathname === fixturePrefix + 'manual' && request.method === 'POST') {
        const input = await form(request);
        const accepted = input.get('note') === 'Hello Northstar';
        audit('fixture_manual_submit', { accepted });
        response.end(
          html(
            'Manual control check',
            `<p>${accepted ? 'Manual input accepted: MANUAL-741.' : 'The test note did not match.'}</p>`,
          ),
        );
      } else if (request.method === 'GET' && url.pathname === fixturePrefix + 'staged-login') {
        response.end(stagedLogin());
      } else if (
        request.method === 'GET' &&
        [fixturePrefix + 'provider-google', fixturePrefix + 'provider-apple'].includes(url.pathname)
      ) {
        audit('fixture_sign_in_method', {
          provider: url.pathname.endsWith('google') ? 'google' : 'apple',
        });
        response.end(stagedLogin('', false));
      } else if (request.method === 'POST' && url.pathname === fixturePrefix + 'identifier') {
        const input = await form(request);
        const accepted = input.get('username') === fixtureCredentials.username;
        audit('fixture_identifier_submit', { accepted });
        if (!accepted)
          return void response.end(
            stagedLogin('<p role="alert">Email was not found. Try again.</p>', false),
          );
        if (sessions.size >= 100) sessions.delete(sessions.keys().next().value!);
        const id = randomBytes(24).toString('hex');
        sessions.set(id, { stage: 'password', expires: Date.now() + 30 * 60_000 });
        response.setHeader(
          'Set-Cookie',
          `e2e_session=${id}; HttpOnly; Secure; SameSite=Lax; Path=${fixturePrefix}`,
        );
        response.end(passwordStep());
      } else if (request.method === 'POST' && url.pathname === fixturePrefix + 'password') {
        const input = await form(request);
        const accepted =
          (input.get('username') === fixtureCredentials.username || active?.stage === 'password') &&
          input.get('password') === fixtureCredentials.password;
        audit('fixture_password_submit', { accepted });
        if (!accepted)
          return void response.end(
            active?.stage === 'password'
              ? passwordStep('<p role="alert">Password was incorrect. Try again.</p>')
              : login('<p role="alert">Email or password was incorrect. Try again.</p>'),
          );
        if (sessions.size >= 100) sessions.delete(sessions.keys().next().value!);
        const id = randomBytes(24).toString('hex');
        sessions.set(id, { stage: 'otp', expires: Date.now() + 30 * 60_000 });
        response.setHeader(
          'Set-Cookie',
          `e2e_session=${id}; HttpOnly; Secure; SameSite=Lax; Path=${fixturePrefix}`,
        );
        response.end(otp());
      } else if (request.method === 'POST' && url.pathname === fixturePrefix + 'otp') {
        const input = await form(request);
        const accepted = active?.stage === 'otp' && input.get('code') === fixtureCredentials.code;
        audit('fixture_otp_submit', { accepted });
        if (!accepted)
          return void response.end(
            active ? otp('<p role="alert">That code was incorrect. Try again.</p>') : login(),
          );
        active.stage = 'portal';
        response.writeHead(303, { Location: fixturePrefix + 'portal' }).end();
      } else if (
        request.method === 'GET' &&
        url.pathname === fixturePrefix + 'portal' &&
        active?.stage === 'portal'
      ) {
        audit('fixture_portal_view');
        response.end(
          html(
            'Northstar account',
            '<p>Signed in to the synthetic Northstar account.</p><table><tr><th>Invoice</th><th>Status</th><th>Amount</th></tr><tr><td>NS-1042</td><td>Awaiting review</td><td>EUR 240.00</td></tr><tr><td>NS-1043</td><td>Paid</td><td>EUR 85.00</td></tr></table><p>Next project milestone: Send the review summary on Friday.</p>',
          ),
        );
      } else if (request.method === 'GET' && url.pathname === fixturePrefix + 'slow') {
        setTimeout(
          () =>
            response.end(html('Delayed fixture page', '<p>The synthetic result is READY-903.</p>')),
          12_000,
        ).unref();
      } else if (request.method === 'GET') {
        response.end(active?.stage === 'otp' ? otp() : login());
      } else response.writeHead(405).end('Method not allowed.');
    } catch {
      response.writeHead(400).end('Fixture request could not be processed.');
    }
  };
}

export async function createFixtureProxy(
  directory: string,
  audit: Audit = () => {},
  execute: typeof runProcess = runProcess,
  operatorPath?: string,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'prices.json'), '{"hotel":180,"flight":240}', { mode: 0o600 });
  const key = join(directory, 'fixture.key');
  const cert = join(directory, 'fixture.crt');
  const generated = await runProcess('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    '1',
    '-subj',
    '/CN=example.com',
    '-addext',
    'subjectAltName=DNS:example.com',
  ]);
  if (generated.exitCode) throw new Error('Could not create the isolated fixture certificate.');
  const certificate = await readFile(cert);
  const fingerprint = createHash('sha256')
    .update(new X509Certificate(certificate).publicKey.export({ format: 'der', type: 'spki' }))
    .digest('base64');
  const https = createHttpsServer(
    { key: await readFile(key), cert: certificate },
    createAuthFixture(audit, join(directory, 'prices.json'), operatorPath),
  );
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  let upstream: URL | undefined;
  const proxy = createServer((request, response) => {
    if (!upstream) return void response.writeHead(503).end();
    const forward = httpRequest(
      upstream,
      { method: request.method, path: request.url, headers: request.headers },
      (result) => {
        response.writeHead(result.statusCode || 502, result.headers);
        result.pipe(response);
      },
    );
    forward.on('error', () => response.destroy());
    request.pipe(forward);
  });
  proxy.on('connection', track);
  proxy.on('connect', (request, socket, head) => {
    if (request.url === 'example.com:443') {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) socket.unshift(head);
      https.emit('connection', socket);
      return;
    }
    if (!upstream) return socket.destroy();
    const forward = httpRequest(upstream, {
      method: 'CONNECT',
      path: request.url,
      headers: { host: request.url || '' },
    });
    forward.on('socket', track);
    socket.on('close', () => forward.destroy());
    socket.on('error', () => forward.destroy());
    forward.on('connect', (response, remote, remoteHead) => {
      socket.write(
        `HTTP/1.1 ${response.statusCode || 502} ${response.statusMessage || ''}\r\n\r\n`,
      );
      if (response.statusCode !== 200) {
        remote.destroy();
        socket.destroy();
        return;
      }
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.on('error', () => socket.destroy());
      remote.on('close', () => {
        if (!remote.readableEnded) socket.destroy();
      });
      socket.on('error', () => remote.destroy());
      socket.on('close', () => remote.destroy());
      remote.pipe(socket).pipe(remote);
    });
    forward.on('error', () => socket.destroy());
    forward.end();
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', resolve);
  });
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  function upstreamProxy(value: string) {
    const target = new URL(value);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1')
      throw new Error('Fixture proxy requires the production loopback guard.');
    if (upstream && upstream.href !== target.href)
      throw new Error('The fixture guard changed unexpectedly.');
    upstream = target;
    return proxyUrl;
  }
  return {
    proxyUrl,
    certificate,
    nativeArgs(args: string[]) {
      const proxyIndex = args.findIndex((arg) => arg.startsWith('--proxy-server='));
      if (proxyIndex < 0) throw new Error('Fixture browser proxy was missing.');
      const values = [...args];
      values[proxyIndex] = `--proxy-server=${upstreamProxy(values[proxyIndex].slice(15))}`;
      values.splice(values.length - 1, 0, `--ignore-certificate-errors-spki-list=${fingerprint}`);
      return values;
    },
    run: (async (command, args, options) => {
      const values = [...args];
      const proxyIndex = values.indexOf('--proxy');
      if (proxyIndex >= 0) {
        values[proxyIndex + 1] = upstreamProxy(values[proxyIndex + 1]);
        const flags = values.indexOf('--args');
        if (flags < 0) throw new Error('Fixture browser arguments were missing.');
        values[flags + 1] += `,--ignore-certificate-errors-spki-list=${fingerprint}`;
      }
      return execute(command, values, options);
    }) satisfies typeof runProcess,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      https.close();
    },
  };
}

const names: Record<IntegrationService, string> = {
  gmail: 'Gmail',
  googlecalendar: 'Google Calendar',
  googledrive: 'Google Drive',
  googlesheets: 'Google Sheets',
  googledocs: 'Google Docs',
  slack: 'Slack',
  notion: 'Notion',
  linear: 'Linear',
};
const spendingCsv = [
  'Date,Category,Merchant,Amount EUR,Monthly budget EUR,Kind',
  '2026-09-28,Food,Grocer One,32.50,200.00,one-off',
  '2026-09-28,Food,Grocer Two,17.50,200.00,one-off',
  '2026-09-28,Transport,Rail Pass,125.00,100.00,one-off',
  '2026-09-28,Software,Figma,20.00,60.00,subscription',
  '2026-09-28,Software,Notion,20.00,60.00,subscription',
].join('\n');
const toolDefinitions = [
  {
    name: 'GMAIL_LIST_LABELS',
    description: 'List labels in the selected synthetic Gmail account.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'GMAIL_FETCH_EMAILS',
    description: 'Read synthetic Gmail messages. Use query in:sent for sent mail, newest first.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max_results: { type: 'integer', minimum: 1, maximum: 100 },
        user_id: { type: 'string' },
        include_payload: { type: 'boolean' },
        verbose: { type: 'boolean' },
        label_ids: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
    description: 'Read a synthetic email by its observed emailId, including attachment metadata.',
    parameters: {
      type: 'object',
      properties: { message_id: { type: 'string' }, user_id: { type: 'string' } },
      required: ['message_id'],
    },
  },
  {
    name: 'GMAIL_GET_ATTACHMENT',
    description:
      'Download an observed synthetic Gmail attachment with the apps download action. This is a read and never sends email.',
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        attachment_id: { type: 'string' },
        file_name: { type: 'string' },
        user_id: { type: 'string' },
      },
      required: ['message_id', 'attachment_id', 'file_name'],
    },
  },
  {
    name: 'SLACK_SEARCH_MESSAGES',
    description: 'Search synthetic Slack messages in the selected workspace.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, count: { type: 'integer' } },
      required: ['query'],
    },
  },
  {
    name: 'NOTION_SEARCH_NOTION_PAGE',
    description: 'Search synthetic Notion pages by title and read their short summaries.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, page_size: { type: 'integer' } },
    },
  },
  {
    name: 'GOOGLECALENDAR_EVENTS_LIST',
    description: 'Read synthetic calendar events.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'GOOGLEDRIVE_FIND_FILE',
    description: 'Find a synthetic CSV export by name in the selected Google Drive account.',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    name: 'GOOGLEDRIVE_DOWNLOAD_FILE',
    description: 'Download an observed synthetic CSV file by ID for private text analysis.',
    parameters: {
      type: 'object',
      properties: { fileId: { type: 'string' } },
      required: ['fileId'],
    },
  },
  {
    name: 'GOOGLESHEETS_SEARCH_SPREADSHEETS',
    description: 'Find spreadsheets by title in the selected synthetic Google Sheets account.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, max_results: { type: 'integer' } },
    },
  },
  {
    name: 'GOOGLESHEETS_GET_SPREADSHEET_INFO',
    description: 'Get the title and tab names of a synthetic Google spreadsheet by ID or URL.',
    parameters: {
      type: 'object',
      properties: { spreadsheet_id: { type: 'string' } },
      required: ['spreadsheet_id'],
    },
  },
  {
    name: 'GOOGLESHEETS_BATCH_GET',
    description: 'Read bounded cell ranges from a synthetic Google spreadsheet.',
    parameters: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string' },
        ranges: { type: 'array', items: { type: 'string' } },
      },
      required: ['spreadsheet_id'],
    },
  },
  {
    name: 'GMAIL_CREATE_EMAIL_DRAFT',
    description: 'Save an unsent synthetic Gmail draft. This does not send email.',
    parameters: {
      type: 'object',
      properties: {
        recipient_email: { type: 'string', maxLength: 320 },
        subject: { type: 'string', maxLength: 300 },
        body: { type: 'string', maxLength: 12000 },
        user_id: { type: 'string', enum: ['me'] },
      },
      required: ['recipient_email', 'subject', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'GMAIL_LIST_DRAFTS',
    description: 'List unsent drafts in the selected synthetic Gmail account.',
    parameters: {
      type: 'object',
      properties: { user_id: { type: 'string', enum: ['me'] } },
      additionalProperties: false,
    },
  },
  {
    name: 'GMAIL_GET_DRAFT',
    description: 'Read one unsent synthetic draft using its observed draft ID.',
    parameters: {
      type: 'object',
      properties: { draft_id: { type: 'string' }, user_id: { type: 'string', enum: ['me'] } },
      required: ['draft_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'GMAIL_DELETE_MESSAGE',
    description:
      'Permanently delete an observed synthetic email or draft message from the selected account. Use the message ID, not the draft ID.',
    parameters: {
      type: 'object',
      properties: { message_id: { type: 'string' }, user_id: { type: 'string', enum: ['me'] } },
      required: ['message_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'GMAIL_SEND_EMAIL',
    description:
      'Send a fixture-only message when the user explicitly requested sending. No external delivery occurs.',
    parameters: {
      type: 'object',
      properties: {
        recipient_email: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['recipient_email', 'subject', 'body'],
    },
  },
];

export function createIntegrationFixture(
  baseUrl: string,
  audit: Audit = () => {},
  options: { signup?: boolean } = {},
) {
  const accounts = new Map<
    string,
    {
      ownerId: string;
      service: IntegrationService;
      callback: string;
      active: boolean;
      number: number;
    }
  >();
  const sessions = new Map<string, IntegrationSession>();
  const verificationMail = new Map<SignupVariant, VerificationEmail>();
  const accountEmail = (account: { service: IntegrationService; number: number }) =>
    options.signup && account.service === 'gmail'
      ? fixtureCredentials.username
      : `tester${account.number}@example.test`;
  const writes: Array<{ id: string; accountId: string; action: string }> = [];
  const drafts = new Map<
    string,
    {
      id: string;
      accountId: string;
      message: { id: string; to: string; subject: string; body: string; labelIds: string[] };
    }
  >();
  const deletedMessages = new Set<string>();
  function recordWrite(action: string, accountId: string) {
    if (writes.length >= 1000) throw new Error('The synthetic write limit was reached.');
    const item = { id: randomUUID(), accountId, action };
    writes.push(item);
    audit('fixture_integration_write', item);
    return item;
  }
  let accountSequence = 0;
  const observedAt = Date.now();
  const attachmentText = 'invoice,status,amount_eur\nNS-2048,Reviewed,360.00\n';
  function sentMessages(number: number) {
    return [
      {
        id: `fixture-sent-${number}-newest`,
        emailId: `fixture-sent-${number}-newest`,
        threadId: `fixture-sent-thread-${number}`,
        from: `tester${number}@example.test`,
        to: 'alex@example.test',
        subject: 'Northstar sent review: NS-2048',
        body: 'Attached is the latest Northstar invoice review. Synthetic test data only.',
        date: new Date(observedAt - 60_000).toISOString(),
        labelIds: ['SENT'],
        attachments: [
          {
            attachmentId: `fixture-attachment-${number}-2048`,
            filename: 'northstar-review-2048.csv',
            mimeType: 'text/csv',
            size: Buffer.byteLength(attachmentText),
          },
        ],
      },
      {
        id: `fixture-sent-${number}-older`,
        emailId: `fixture-sent-${number}-older`,
        threadId: `fixture-older-thread-${number}`,
        from: `tester${number}@example.test`,
        to: 'alex@example.test',
        subject: 'Earlier Northstar review: NS-1042',
        body: 'An earlier synthetic review, superseded by the latest sent email.',
        date: new Date(observedAt - 86_400_000).toISOString(),
        labelIds: ['SENT'],
        attachments: [],
      },
    ];
  }
  const prefix = 'https://otto-consent.example/__otto_e2e__/';
  const provider: IntegrationProvider = {
    id: 'synthetic-apps',
    configured: true,
    supportedServices: (Object.keys(names) as IntegrationService[]).filter(
      (service) => service !== 'linear',
    ),
    webhooksConfigured: false,
    supportsSubscriptions: [],
    async createSession(ownerId) {
      const session: IntegrationSession = {
        id: randomUUID(),
        async authorize(service, callback) {
          const accountId = randomUUID();
          accounts.set(accountId, {
            ownerId,
            service,
            callback,
            active: false,
            number: ++accountSequence,
          });
          return { accountId, url: prefix + accountId };
        },
        async search() {
          return {
            tools: toolDefinitions,
            suggestions: [
              {
                useCase:
                  'Read synthetic app data, save an unsent Gmail draft, send an explicitly requested fixture email or delete an observed fixture message.',
                primaryToolSlugs: toolDefinitions.map((tool) => tool.name),
              },
            ],
          };
        },
        async execute(action, args, accountId) {
          const account = accountId ? accounts.get(accountId) : undefined;
          if (!account?.active || account.ownerId !== ownerId)
            throw new Error('Connect the selected synthetic account first.');
          if (!toolDefinitions.some((tool) => tool.name === action))
            throw new Error('This synthetic tool is not implemented.');
          const service = action.split('_')[0].toLowerCase();
          if (account.service !== service)
            throw new Error('The synthetic action does not match the selected app.');
          if (action.startsWith('GMAIL_') && args.user_id !== undefined && args.user_id !== 'me')
            throw new Error('Use the selected synthetic account.');
          const fields =
            action === 'GMAIL_LIST_DRAFTS'
              ? ['user_id']
              : action === 'GMAIL_GET_DRAFT'
                ? ['draft_id', 'user_id']
                : action === 'GMAIL_DELETE_MESSAGE'
                  ? ['message_id', 'user_id']
                  : undefined;
          if (fields && Object.keys(args).some((key) => !fields.includes(key)))
            throw new Error('The synthetic action fields are invalid.');
          const sent =
            action === 'GMAIL_FETCH_EMAILS' &&
            (/(?:^|\s)(?:in|label):sent(?:\s|$)/i.test(String(args.query ?? '')) ||
              (Array.isArray(args.label_ids) && args.label_ids.includes('SENT')));
          audit('fixture_integration_execute', {
            action,
            accountId: accountId!,
            ...(action === 'GMAIL_FETCH_EMAILS' ? { mailbox: sent ? 'sent' : 'inbox' } : {}),
          });
          if (action === 'GMAIL_LIST_LABELS')
            return {
              labels: [
                { id: 'INBOX', name: 'INBOX' },
                { id: 'REVIEW', name: `Review account ${account.number}` },
              ],
              fixture: true,
            };
          if (action === 'GMAIL_FETCH_EMAILS')
            return {
              messages: (sent
                ? sentMessages(account.number)
                : [
                    {
                      id: 'fixture-mail-1',
                      emailId: 'fixture-mail-1',
                      from: 'alex@example.test',
                      subject: 'Northstar review',
                      body: 'Please review invoice NS-1042 for EUR 240 and prepare a summary by Friday. This is synthetic test data.',
                    },
                  ]
              )
                .filter((message) => !deletedMessages.has(`${accountId}:${message.id}`))
                .slice(
                  0,
                  typeof args.max_results === 'number'
                    ? Math.max(1, Math.min(100, args.max_results))
                    : 10,
                ),
              fixture: true,
            };
          if (action === 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID') {
            const message = sentMessages(account.number).find(
              (item) =>
                item.emailId === args.message_id && !deletedMessages.has(`${accountId}:${item.id}`),
            );
            if (!message) throw new Error('The synthetic email was not found in this account.');
            return { message, fixture: true };
          }
          if (action === 'GMAIL_GET_ATTACHMENT')
            return { downloadRequired: true, action, args, fixture: true };
          if (action === 'GMAIL_CREATE_EMAIL_DRAFT') {
            if (
              Object.keys(args).some(
                (key) => !['recipient_email', 'subject', 'body', 'user_id'].includes(key),
              ) ||
              typeof args.recipient_email !== 'string' ||
              !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.recipient_email) ||
              args.recipient_email.length > 320 ||
              typeof args.subject !== 'string' ||
              !args.subject ||
              args.subject.length > 300 ||
              typeof args.body !== 'string' ||
              !args.body ||
              args.body.length > 12000
            )
              throw new Error('The synthetic draft fields are invalid.');
            const item = recordWrite(action, accountId!);
            const draft = {
              id: item.id,
              accountId: accountId!,
              message: {
                id: `fixture-draft-message-${item.id}`,
                to: args.recipient_email,
                subject: args.subject,
                body: args.body,
                labelIds: ['DRAFT'],
              },
            };
            drafts.set(draft.id, draft);
            return {
              id: draft.id,
              message: draft.message,
              fixture: true,
              deliveredExternally: false,
            };
          }
          if (action === 'GMAIL_LIST_DRAFTS')
            return {
              drafts: [...drafts.values()]
                .filter((draft) => draft.accountId === accountId)
                .map((draft) => ({ id: draft.id, message: draft.message })),
              fixture: true,
            };
          if (action === 'GMAIL_GET_DRAFT') {
            const draft = typeof args.draft_id === 'string' ? drafts.get(args.draft_id) : undefined;
            if (!draft || draft.accountId !== accountId)
              throw new Error('The synthetic draft was not found in this account.');
            return { id: draft.id, message: draft.message, fixture: true };
          }
          if (action === 'GMAIL_DELETE_MESSAGE') {
            const draft = [...drafts.values()].find(
              (value) => value.accountId === accountId && value.message.id === args.message_id,
            );
            const message = sentMessages(account.number).find(
              (value) => value.id === args.message_id,
            );
            if (
              typeof args.message_id !== 'string' ||
              (!draft && !message && args.message_id !== 'fixture-mail-1') ||
              deletedMessages.has(`${accountId}:${args.message_id}`)
            )
              throw new Error('The synthetic email was not found in this account.');
            const item = recordWrite(action, accountId!);
            if (draft) drafts.delete(draft.id);
            deletedMessages.add(`${accountId}:${args.message_id}`);
            return {
              id: item.id,
              message_id: args.message_id,
              deleted: true,
              fixture: true,
              deliveredExternally: false,
            };
          }
          if (action === 'SLACK_SEARCH_MESSAGES') {
            const message = {
              text: 'Northstar review: invoice NS-2048 is ready. The next milestone is Friday at 15:00. Synthetic test data only.',
              channel: { id: `fixture-slack-channel-${account.number}`, name: 'northstar-review' },
              ts: String(Math.floor(observedAt / 1000)),
            };
            const matches =
              !args.query || /northstar|review|invoice/i.test(String(args.query)) ? [message] : [];
            return { messages: { matches, total: matches.length }, fixture: true };
          }
          if (action === 'NOTION_SEARCH_NOTION_PAGE') {
            const page = {
              id: `fixture-notion-page-${account.number}`,
              object: 'page',
              title: 'Northstar review notes',
              summary:
                'The NS-2048 review is complete. Prepare the next summary by Friday at 15:00. Synthetic test data only.',
              last_edited_time: new Date(observedAt).toISOString(),
            };
            const results =
              !args.query || /northstar|review|invoice/i.test(String(args.query)) ? [page] : [];
            return { results, has_more: false, fixture: true };
          }
          if (action === 'GOOGLECALENDAR_EVENTS_LIST')
            return {
              items: [
                {
                  id: 'fixture-event-1',
                  summary: 'Northstar review',
                  start: { dateTime: new Date(Date.now() + 86_400_000).toISOString() },
                  end: { dateTime: new Date(Date.now() + 90_000_000).toISOString() },
                },
              ],
              fixture: true,
            };
          if (action === 'GOOGLEDRIVE_FIND_FILE') {
            const query = String(args.query ?? '').toLowerCase();
            return {
              files:
                !query || 'september spending export.csv'.includes(query)
                  ? [
                      {
                        id: 'otto-e2e-spending-csv-2026-09',
                        name: 'September spending export.csv',
                        mimeType: 'text/csv',
                        webViewLink:
                          'https://drive.google.com/file/d/otto-e2e-spending-csv-2026-09/view',
                      },
                    ]
                  : [],
              fixture: true,
            };
          }
          if (action === 'GOOGLESHEETS_SEARCH_SPREADSHEETS') {
            const query = String(args.query ?? '').toLowerCase();
            return {
              spreadsheets:
                !query || 'september spending test'.includes(query)
                  ? [
                      {
                        id: 'otto-e2e-spending-2026-09',
                        name: 'September spending test',
                        webViewLink:
                          'https://docs.google.com/spreadsheets/d/otto-e2e-spending-2026-09/edit',
                      },
                    ]
                  : [],
              fixture: true,
            };
          }
          if (
            action === 'GOOGLESHEETS_GET_SPREADSHEET_INFO' ||
            action === 'GOOGLESHEETS_BATCH_GET'
          ) {
            const id = 'otto-e2e-spending-2026-09';
            let matched = args.spreadsheet_id === id;
            if (!matched && typeof args.spreadsheet_id === 'string') {
              try {
                const url = new URL(args.spreadsheet_id);
                matched =
                  url.origin === 'https://docs.google.com' &&
                  !url.username &&
                  !url.password &&
                  [`/spreadsheets/d/${id}`, `/spreadsheets/d/${id}/edit`].includes(
                    url.pathname.replace(/\/$/, ''),
                  );
              } catch {}
            }
            if (!matched) throw new Error('The synthetic spreadsheet was not found.');
            if (action === 'GOOGLESHEETS_GET_SPREADSHEET_INFO')
              return {
                spreadsheetId: id,
                properties: { title: 'September spending test' },
                sheets: ['Spending', 'Budget'].map((title) => ({ properties: { title } })),
                fixture: true,
              };
            if (args.ranges !== undefined && !Array.isArray(args.ranges))
              throw new Error('The synthetic cell ranges are invalid.');
            const valueRanges = (
              Array.isArray(args.ranges) ? args.ranges : ['Spending!A1:E20']
            ).map((range) => {
              const cells =
                typeof range === 'string'
                  ? /^(?:'([^']+)'|([^'!]+))!\$?([A-Z]{1,3})\$?([1-9]\d{0,7})(?::\$?([A-Z]{1,3})\$?([1-9]\d{0,7}))?$/i.exec(
                      range,
                    )
                  : null;
              if (!cells) throw new Error('The synthetic cell range is invalid.');
              const tab = cells[1] ?? cells[2];
              const column = (name: string) =>
                [...name.toUpperCase()].reduce(
                  (value, letter) => value * 26 + letter.charCodeAt(0) - 64,
                  0,
                );
              const firstColumn = column(cells[3]);
              const lastColumn = column(cells[5] ?? cells[3]);
              const firstRow = Number(cells[4]);
              const lastRow = Number(cells[6] ?? cells[4]);
              if (lastColumn < firstColumn || lastRow < firstRow)
                throw new Error('The synthetic cell range is invalid.');
              const values =
                tab === 'Spending'
                  ? [
                      ['Date', 'Category', 'Merchant', 'Amount EUR', 'Kind'],
                      ['2026-09-28', 'Food', 'Grocer One', '32.50', 'one-off'],
                      ['2026-09-28', 'Food', 'Grocer Two', '17.50', 'one-off'],
                      ['2026-09-28', 'Transport', 'Rail Pass', '125.00', 'one-off'],
                      ['2026-09-28', 'Software', 'Figma', '20.00', 'subscription'],
                      ['2026-09-28', 'Software', 'Notion', '20.00', 'subscription'],
                    ]
                  : tab === 'Budget'
                    ? [
                        ['Category', 'Monthly budget EUR'],
                        ['Food', '200.00'],
                        ['Transport', '100.00'],
                        ['Software', '60.00'],
                      ]
                    : undefined;
              if (!values) throw new Error('The synthetic sheet tab was not found.');
              return {
                range,
                values: values
                  .slice(firstRow - 1, lastRow)
                  .map((row) => row.slice(firstColumn - 1, lastColumn))
                  .filter((row) => row.length > 0),
              };
            });
            return { spreadsheetId: id, valueRanges, fixture: true };
          }
          if (action === 'GMAIL_SEND_EMAIL') {
            const item = recordWrite(action, accountId!);
            return { id: item.id, fixture: true, deliveredExternally: false };
          }
          throw new Error('This synthetic tool is not implemented.');
        },
        async download(action, args, accountId, signal) {
          if (signal?.aborted)
            throw new DOMException('Synthetic download cancelled.', 'AbortError');
          const account = accounts.get(accountId);
          if (!account?.active || account.ownerId !== ownerId)
            throw new Error('Connect the selected synthetic account first.');
          if (action === 'GOOGLEDRIVE_DOWNLOAD_FILE') {
            if (
              account.service !== 'googledrive' ||
              args.fileId !== 'otto-e2e-spending-csv-2026-09'
            )
              throw new Error('The synthetic CSV file was not found in this account.');
            audit('fixture_integration_download', { action, accountId });
            return {
              bytes: Buffer.from(spendingCsv),
              name: 'September spending export.csv',
              mimeType: 'text/csv',
            };
          }
          if (account.service !== 'gmail')
            throw new Error('Connect the selected synthetic Gmail account first.');
          const message = sentMessages(account.number)[0];
          const attachment = message.attachments[0];
          if (
            action !== 'GMAIL_GET_ATTACHMENT' ||
            deletedMessages.has(`${accountId}:${message.id}`) ||
            args.message_id !== message.emailId ||
            args.attachment_id !== attachment.attachmentId ||
            args.file_name !== attachment.filename ||
            (args.user_id !== undefined &&
              args.user_id !== 'me' &&
              args.user_id !== message.from) ||
            Object.keys(args).some(
              (key) => !['message_id', 'attachment_id', 'file_name', 'user_id'].includes(key),
            )
          )
            throw new Error(
              'The synthetic attachment does not match the observed email and account.',
            );
          const bytes = Buffer.from(attachmentText);
          audit('fixture_integration_download', { action, accountId, size: bytes.byteLength });
          return { name: attachment.filename, mimeType: attachment.mimeType, bytes };
        },
      };
      sessions.set(session.id, session);
      return session;
    },
    async restoreSession(id) {
      const session = sessions.get(id);
      if (!session) throw new Error('Synthetic session expired.');
      return session;
    },
    async deleteSession(id) {
      sessions.delete(id);
    },
    async inspectAccount(id, ownerId) {
      const account = accounts.get(id);
      return account?.ownerId === ownerId
        ? {
            active: account.active,
            service: account.service,
            accountName: `Synthetic account ${account.number}`,
            accountEmail: accountEmail(account),
          }
        : { active: false, service: 'unknown' };
    },
    async verificationEmails(accountId, query, signal) {
      signal.throwIfAborted();
      const account = accounts.get(accountId);
      if (!options.signup || !account?.active || account.service !== 'gmail') return;
      const messages = [...verificationMail.values()].filter(
        (message) =>
          message.recipients.includes(query.recipient) &&
          message.receivedAt >= query.after &&
          message.receivedAt <= query.before,
      );
      audit('fixture_signup_mailbox_read', { matched: messages.length === 1 });
      return messages;
    },
    async deleteAccount(id) {
      accounts.delete(id);
    },
    parseCallback(query) {
      const value = query as Record<string, string>;
      return {
        state: value.state || '',
        accountId: value.account_ref || '',
        success: value.outcome === 'success',
      };
    },
    async subscribe() {
      throw new Error('Synthetic trigger delivery is not configured.');
    },
    async unsubscribe() {},
    async verifyWebhook() {
      throw new Error('Synthetic webhook delivery is disabled.');
    },
    matchesSubscription() {
      return false;
    },
  };
  return {
    provider,
    writes,
    signupCodeSent(alternate: boolean) {
      if (!options.signup) return;
      const variant = alternate ? 'alternate' : 'base';
      const input = fixtureSignup[variant];
      verificationMail.set(variant, {
        id: randomUUID(),
        receivedAt: Date.now(),
        sender: 'verify@transactional.example.com',
        recipients: [input.recipient],
        authenticatedDomain: 'example.com',
        text: `Your email verification code is ${input.code}.`,
      });
    },
    register(app: FastifyInstance) {
      app.addHook('onSend', async (_request, _reply, payload) => {
        if (typeof payload !== 'string' || !payload.includes(prefix)) return payload;
        return payload.replaceAll(prefix, `${baseUrl}/e2e/connect/`);
      });
      app.get<{ Params: { id: string } }>('/e2e/connect/:id', async (request, reply) => {
        const account = accounts.get(request.params.id);
        if (!account) return reply.code(404).send('Synthetic consent expired.');
        return reply.type('text/html').send(
          html(
            `Connect synthetic ${names[account.service]}`,
            `<p>This is synthetic app consent, not a real provider sign-in. It exposes only synthetic records to this isolated Otto instance.</p><p>Account: ${accountEmail(account)}</p><form id="fixture-consent" method="post"><input type="hidden" name="consent" value="connect"><button type="submit">Connect synthetic account</button></form><p id="consent-error" role="alert" hidden>Could not connect the synthetic account. Try again.</p><script>
const consentForm = document.getElementById('fixture-consent');
const consentButton = consentForm.querySelector('button');
const consentError = document.getElementById('consent-error');
consentForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (consentButton.disabled) return;
  consentButton.disabled = true;
  consentError.hidden = true;
  try {
    const action = new URL(consentForm.action, location.href);
    if (action.origin !== location.origin) throw new Error('Invalid destination');
    const response = await fetch(action.href, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ consent: 'connect' }),
    });
    if (!response.ok) throw new Error('Connection failed');
    const destination = new URL(response.url, location.href);
    if (destination.origin !== location.origin || !['/apps', '/', '/onboarding', '/connected.html'].includes(destination.pathname))
      throw new Error('Unexpected destination');
    location.assign(destination.href);
  } catch {
    consentError.hidden = false;
  } finally {
    consentButton.disabled = false;
  }
});
</script>`,
          ),
        );
      });
      app.post<{ Params: { id: string } }>('/e2e/connect/:id', async (request, reply) => {
        const account = accounts.get(request.params.id);
        if (!account) return reply.code(404).send('Synthetic consent expired.');
        account.active = true;
        const callback = new URL(account.callback);
        callback.searchParams.set('account_ref', request.params.id);
        callback.searchParams.set('outcome', 'success');
        audit('fixture_account_connected', {
          accountId: request.params.id,
          service: account.service,
        });
        return reply.redirect(callback.href);
      });
    },
  };
}

export function operatorAccess(token: string): { preValidation: preValidationHookHandler } {
  return {
    preValidation: async (request, reply) => {
      if (request.headers.authorization !== `Bearer ${token}`)
        return reply.code(401).send({ error: 'Operator authorization required.' });
    },
  };
}

export function registerOperatorPage(app: FastifyInstance, token: string) {
  app.get('/e2e', async (_request, reply) =>
    reply
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .type('text/html')
      .send(
        html(
          'Otto acceptance controls',
          `<form id="operator-access"><label for="operator-token">Operator token</label><input id="operator-token" type="password" autocomplete="off" required><button type="submit">Open controls</button></form><p id="operator-result" role="status"></p><div id="operator-controls"></div><pre id="operator-events" hidden></pre><script>
      (() => {
        const access = document.getElementById('operator-access');
        const input = document.getElementById('operator-token');
        const controls = document.getElementById('operator-controls');
        const result = document.getElementById('operator-result');
        const events = document.getElementById('operator-events');
        let token = '';
        async function request(path, method = 'GET') {
          const response = await fetch(path, { method, headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', redirect: 'error' });
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || 'The operator request failed.');
          }
          return response;
        }
        access.addEventListener('submit', async event => {
          event.preventDefault();
          const button = access.querySelector('button');
          if (button.disabled) return;
          button.disabled = true;
          token = input.value;
          input.value = '';
          result.textContent = '';
          try {
            const response = await request('/e2e/operator');
            controls.innerHTML = new DOMParser().parseFromString(await response.text(), 'text/html').body.innerHTML;
            access.hidden = true;
          } catch (error) {
            token = '';
            result.textContent = error.message;
          } finally { button.disabled = false; }
        });
        controls.addEventListener('click', async event => {
          const button = event.target.closest('button[data-operator]');
          if (!button || button.disabled) return;
          const action = button.dataset.operator;
          if (!['base', 'alternate', 'status'].includes(action)) return;
          button.disabled = true;
          result.textContent = '';
          try {
            const response = await request(action === 'status' ? '/e2e/status' : '/e2e/signup/' + action, action === 'status' ? 'GET' : 'POST');
            if (action === 'status') {
              events.textContent = JSON.stringify(await response.json(), null, 2);
              events.hidden = false;
            } else result.textContent = 'Case released. Complete verification in the handed-off browser, then click Done.';
          } catch (error) { result.textContent = error.message; }
          finally { button.disabled = false; }
        });
      })();
      </script>`,
        ),
      ),
  );
  app.get('/e2e/operator', operatorAccess(token), async (_request, reply) =>
    reply
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .type('text/html')
      .send(operatorPage()),
  );
}

export function operatorPage() {
  const signupOperator = `<h2>Trial signup evaluation</h2><p>Connect synthetic Gmail as ${fixtureCredentials.username} before starting. Each attempt needs a fresh acceptance harness. The trial details have editable defaults.</p><p>Base recipient: ${fixtureSignup.base.recipient}. Holdout recipient: ${fixtureSignup.alternate.recipient}.</p><p>After Otto asks you to complete human verification, release the matching case here. Then click Verify I am human in Otto's handed-off browser and click Done to return control.</p><button type="button" data-operator="base">Release base case</button><button type="button" data-operator="alternate">Release holdout case</button>`;
  return html(
    'Otto isolated acceptance environment',
    signupOperator +
      `<p><a href="/">Open Otto</a></p><button type="button" data-operator="status">Timing events</button><p>The assistant and browser are real. Google, Slack and Notion accounts, files, channel setup and the Northstar site are synthetic. No external messages are delivered.</p><h2>Secure sign-in fixture</h2><p>Give the assistant this URL: <code>${fixtureLogin}</code></p><p>Enter these synthetic values only in the Vault form, never in chat:</p><dl><dt>Email</dt><dd>${fixtureCredentials.username}</dd><dt>Password</dt><dd>${fixtureCredentials.password}</dd><dt>One-time code</dt><dd>${fixtureCredentials.code}</dd></dl><p>Slow page for acknowledgement checks: <code>${fixtureOrigin + fixturePrefix}slow</code></p><p>The fixture URL works only in the assistant's isolated browser. The user's normal browser should use this localhost page and the Vault.</p><h2>Channels UI fixture</h2><p>Open <a href="/channels">Channels</a> and enter these fixed synthetic values in its setup forms. Both channels start disconnected. No provider is contacted and incoming or outgoing messages are disabled, including after setup.</p><h3>Telegram</h3><dl><dt>Bot token</dt><dd>${fixtureChannelCredentials.telegram.botToken}</dd></dl><p>Leave the callback blank. The saved account is labelled Synthetic Telegram bot (UI only). It stays at Waiting for Start because incoming messages are disabled.</p><h3>WhatsApp</h3><dl><dt>Business phone number ID</dt><dd>${fixtureChannelCredentials.whatsapp.phoneNumberId}</dd><dt>Your WhatsApp number</dt><dd>${fixtureChannelCredentials.whatsapp.allowedNumber}</dd><dt>Business access token</dt><dd>${fixtureChannelCredentials.whatsapp.accessToken}</dd><dt>Meta app secret</dt><dd>${fixtureChannelCredentials.whatsapp.appSecret}</dd><dt>Webhook verification token</dt><dd>${fixtureChannelCredentials.whatsapp.verifyToken}</dd></dl><p>Check the policy box for this synthetic setup and leave the callback blank. The saved account remains at Finish delivery setup; no callback is registered.</p>`,
  );
}
