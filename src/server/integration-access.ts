import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IntegrationAccessProvider } from '../ports/integrations.ts';
import type {
  IntegrationAccessAttempt,
  IntegrationAccessProgress,
  IntegrationManagedAccess,
} from '../shared/integrations.ts';

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const publicKeySchema = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: idSchema,
    y: idSchema,
    ext: z.literal(true).optional(),
    key_ops: z.array(z.literal('verify')).max(1).optional(),
  })
  .strict();

export function renderIntegrationAccessBridge(
  brokerOrigin: string,
  nonce: string,
  bridgeKey: string,
) {
  const broker = JSON.stringify(brokerOrigin).replaceAll('<', '\\u003c');
  const secret = JSON.stringify(bridgeKey).replaceAll('<', '\\u003c');
  return String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to Otto</title><style nonce="${nonce}">body{font:16px system-ui;margin:12vh auto;padding:24px;max-width:420px;color:#202322;background:#fafaf8}button{font:inherit;padding:12px 18px;border:1px solid #b8bcb5;border-radius:8px;background:white;cursor:pointer}p{line-height:1.5}</style></head><body><h1>Sign in to Otto</h1><p id="status">Continue with Google to enable Otto’s app connection on this installation.</p><button id="continue">Continue with Google</button><script nonce="${nonce}">
const brokerOrigin=${broker};
const bridgeKey=${secret};
const button=document.getElementById('continue');
const status=document.getElementById('status');
let popup, key, attempt, timer, stopped=false, proved=false;
const request=async(path,body)=>{const response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'X-Otto-Bridge':bridgeKey,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});if(!response.ok)throw new Error('Sign-in is unavailable. Return to Otto and try again.');return response.json();};
const stop=(message)=>{stopped=true;clearTimeout(timer);status.textContent=message;button.disabled=true;};
window.addEventListener('message',async(event)=>{const value=event.data;if(stopped||proved||event.source!==popup||event.origin!==brokerOrigin||!attempt||Date.now()>=attempt.expiresAt||!key||!value||value.type!=='otto:proxy-access:challenge'||value.id!==attempt.id||typeof value.challenge!=='string'||value.challenge.length>512||!value.challenge.startsWith('otto-proxy-access-v1\n'+attempt.id+'\n'+location.origin+'\n')||value.challenge.length<=('otto-proxy-access-v1\n'+attempt.id+'\n'+location.origin+'\n').length)return;proved=true;try{const signature=new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,new TextEncoder().encode(value.challenge)));if(stopped||Date.now()>=attempt.expiresAt||signature.length!==64)return;popup.postMessage({type:'otto:proxy-access:proof',id:attempt.id,signature:btoa(String.fromCharCode(...signature)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')},brokerOrigin);}catch{stop('Sign-in could not be verified. Return to Otto and try again.');}});
const poll=async()=>{if(stopped)return;try{const result=await request('/status');if(stopped)return;if(result.status==='completed'){stop('You’re signed in. Return to Otto to continue.');return;}if(result.status==='denied'||result.status==='cancelled'){stop('Sign-in was not completed. Return to Otto to try again.');return;}timer=setTimeout(poll,1000);}catch{stop('Return to Otto to check your connection.');}};
button.addEventListener('click',async()=>{if(button.disabled)return;popup=window.open('','_blank','popup,width=520,height=720');if(!popup){status.textContent='Allow pop-ups, then continue with Google.';return;}button.disabled=true;try{key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);const browserKey=await crypto.subtle.exportKey('jwk',key.publicKey);attempt=await request('/start',{browserKey});if(stopped)return;const target=new URL(attempt.url);if(target.origin!==brokerOrigin||target.pathname!=='/api/auth/enroll'||target.searchParams.get('id')!==attempt.id)throw new Error('Invalid sign-in address.');popup.location.href=target.href;status.textContent='Finish signing in with Google in the other window.';void poll();}catch{popup?.close();stop('Sign-in is unavailable. Return to Otto and try again.');}});
window.addEventListener('pagehide',()=>{stopped=true;clearTimeout(timer);});
</script></body></html>`;
}

export function createIntegrationAccess(options: {
  proxy: IntegrationAccessProvider;
  origin: string;
  desktop: boolean;
}) {
  type Attempt = {
    id: string;
    brokerId?: string;
    challenge: string;
    expiresAt: number;
    status: IntegrationAccessProgress['status'];
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
    bridge?: Server;
    bridgeExpiresAt?: number;
    completing?: Promise<IntegrationManagedAccess>;
  };
  const attempts = new Map<string, Attempt>();
  let current: Attempt | undefined;
  let closed = false;
  let generation = 0;
  let observed: IntegrationManagedAccess = { state: 'sign_in_required', email: null };
  async function accessStatus() {
    observed = await options.proxy.accessStatus();
    return { ...observed };
  }
  const live = (attempt: Attempt) =>
    !closed &&
    current === attempt &&
    !attempt.controller.signal.aborted &&
    attempt.expiresAt > Date.now() &&
    ['pending', 'authorized'].includes(attempt.status);
  function closeBridge(attempt: Attempt) {
    clearTimeout(attempt.timer);
    attempt.bridge?.close();
    attempt.bridge?.closeAllConnections();
    attempt.bridge = undefined;
    attempt.bridgeExpiresAt = undefined;
  }
  function stop(attempt: Attempt, status: Attempt['status']) {
    attempt.status = status;
    attempt.controller.abort();
    clearTimeout(attempt.timer);
    if (attempt.bridge && ['completed', 'denied'].includes(status)) {
      attempt.bridgeExpiresAt = Date.now() + 5000;
      attempt.timer = setTimeout(() => closeBridge(attempt), 5000);
      attempt.timer.unref();
    } else closeBridge(attempt);
  }
  async function cancelAttempt(attempt: Attempt) {
    if (['cancelled', 'completed', 'denied'].includes(attempt.status)) {
      closeBridge(attempt);
      return;
    }
    stop(attempt, 'cancelled');
    if (attempt.brokerId) await options.proxy.cancelAccess(attempt.brokerId).catch(() => {});
  }
  function required(id: string) {
    const attempt = attempts.get(idSchema.parse(id));
    if (!attempt) throw new Error('This sign-in attempt is unavailable.');
    if (
      attempt.expiresAt <= Date.now() &&
      !['completed', 'cancelled', 'denied'].includes(attempt.status)
    )
      void cancelAttempt(attempt);
    return attempt;
  }
  async function enroll(attempt: Attempt, browserKey: unknown, origin: string) {
    if (!live(attempt) || attempt.brokerId) throw new Error('This sign-in attempt is unavailable.');
    const result = await options.proxy.startAccess(
      publicKeySchema.parse(browserKey),
      origin,
      attempt.challenge,
      attempt.controller.signal,
    );
    if (!live(attempt)) {
      await options.proxy.cancelAccess(result.id).catch(() => {});
      throw new Error('This sign-in attempt is unavailable.');
    }
    attempt.brokerId = result.id;
    attempt.expiresAt = Math.min(attempt.expiresAt, result.expiresAt);
    clearTimeout(attempt.timer);
    attempt.timer = setTimeout(
      () => {
        void cancelAttempt(attempt);
      },
      Math.max(0, attempt.expiresAt - Date.now()),
    );
    attempt.timer.unref();
    return result;
  }
  async function status(id: string): Promise<IntegrationAccessProgress> {
    const attempt = required(id);
    if (!live(attempt) || !attempt.brokerId) return { status: attempt.status };
    const result = await options.proxy.pollAccess(attempt.brokerId, attempt.controller.signal);
    if (!live(attempt)) return { status: attempt.status };
    if (['cancelled', 'denied', 'completed'].includes(result.status)) stop(attempt, result.status);
    else attempt.status = result.status;
    return { status: attempt.status };
  }
  async function complete(id: string): Promise<IntegrationManagedAccess> {
    const attempt = required(id);
    if (attempt.status === 'completed') return accessStatus();
    if (!live(attempt) || !attempt.brokerId)
      throw new Error('This sign-in attempt is unavailable.');
    attempt.completing ??= (async () => {
      const progress = await status(id);
      if (progress.status !== 'authorized' || !live(attempt))
        throw new Error('Finish signing in with Google first.');
      const result = await options.proxy.completeAccess(
        attempt.brokerId!,
        attempt.challenge,
        attempt.controller.signal,
      );
      if (!live(attempt)) throw new Error('This sign-in attempt is unavailable.');
      stop(attempt, result.state === 'enabled' ? 'completed' : 'denied');
      observed = result;
      return result;
    })().finally(() => {
      attempt.completing = undefined;
    });
    return attempt.completing;
  }
  async function body(request: IncomingMessage) {
    if (request.headers['content-type']?.split(';')[0] !== 'application/json')
      throw new Error('Invalid request.');
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 4096) throw new Error('Invalid request.');
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
  async function bridge(attempt: Attempt) {
    const capability = randomBytes(32).toString('base64url');
    const bridgeKey = randomBytes(32).toString('base64url');
    let origin = '';
    let bootstrapped = false;
    let starting = false;
    const server = createServer(async (request, response) => {
      const nonce = randomBytes(24).toString('base64');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader(
        'Content-Security-Policy',
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      );
      const send = (code: number, value: unknown) => {
        response.writeHead(code, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      const terminal = () =>
        !closed &&
        current === attempt &&
        (attempt.bridgeExpiresAt ?? 0) > Date.now() &&
        ['completed', 'denied'].includes(attempt.status);
      try {
        if (
          (!live(attempt) && !terminal()) ||
          request.headers.host !== new URL(origin).host ||
          (request.headers.origin !== undefined && request.headers.origin !== origin)
        )
          return send(403, { error: 'This sign-in attempt is unavailable.' });
        if (
          live(attempt) &&
          request.method === 'GET' &&
          request.url === `/${capability}` &&
          !bootstrapped
        ) {
          bootstrapped = true;
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end(renderIntegrationAccessBridge(options.proxy.origin, nonce, bridgeKey));
          return;
        }
        if (
          !bootstrapped ||
          request.headers['sec-fetch-site'] === 'cross-site' ||
          request.headers['x-otto-bridge'] !== bridgeKey
        )
          return send(403, { error: 'This sign-in attempt is unavailable.' });
        if (request.method === 'GET' && request.url === '/status')
          return send(200, { status: attempt.status });
        if (!live(attempt)) return send(403, { error: 'This sign-in attempt is unavailable.' });
        if (
          request.method === 'POST' &&
          request.url === '/start' &&
          request.headers.origin === origin &&
          !starting
        ) {
          starting = true;
          const input = z
            .object({ browserKey: publicKeySchema })
            .strict()
            .parse(await body(request));
          const result = await enroll(attempt, input.browserKey, origin);
          return send(200, result);
        }
        send(404, { error: 'This request is unavailable.' });
      } catch {
        send(400, { error: 'Sign-in could not be started. Return to Otto and try again.' });
      }
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.maxHeadersCount = 32;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.unref();
    attempt.bridge = server;
    const address = server.address();
    if (!address || typeof address === 'string' || !live(attempt)) {
      server.close();
      throw new Error('This sign-in attempt is unavailable.');
    }
    origin = `http://127.0.0.1:${address.port}`;
    return `${origin}/${capability}`;
  }
  async function start(
    input: { native: true } | { browserKey: unknown },
  ): Promise<IntegrationAccessAttempt> {
    if (closed || ('native' in input && !options.desktop))
      throw new Error('This sign-in is unavailable.');
    const started = ++generation;
    if (current) await cancelAttempt(current);
    if (closed || started !== generation) throw new Error('This sign-in attempt was replaced.');
    for (const [id, attempt] of attempts)
      if (attempt.expiresAt <= Date.now() || attempts.size >= 20) attempts.delete(id);
    const id = randomBytes(32).toString('base64url');
    const attempt: Attempt = {
      id,
      challenge: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + 10 * 60_000,
      status: 'pending',
      controller: new AbortController(),
      timer: setTimeout(() => {
        void cancelAttempt(attempt);
      }, 10 * 60_000),
    };
    attempt.timer.unref();
    current = attempt;
    attempts.set(id, attempt);
    try {
      if ('native' in input)
        return { id, url: await bridge(attempt), expiresAt: attempt.expiresAt };
      const result = await enroll(attempt, input.browserKey, options.origin);
      attempts.delete(id);
      attempt.id = result.id;
      attempts.set(attempt.id, attempt);
      return result;
    } catch (error) {
      await cancelAttempt(attempt);
      throw error;
    }
  }
  async function revoke() {
    if (current) await cancelAttempt(current);
    observed = await options.proxy.revokeAccess();
    return { ...observed };
  }
  return {
    status: accessStatus,
    observedStatus: () => ({ ...observed }),
    start,
    progress: status,
    complete,
    async cancel(id: string) {
      await cancelAttempt(required(id));
      return { cancelled: true as const };
    },
    revoke,
    async close() {
      closed = true;
      await Promise.all([...attempts.values()].map(cancelAttempt));
      attempts.clear();
    },
    register(app: FastifyInstance) {
      app.addHook('onClose', async () => {
        closed = true;
        await Promise.all([...attempts.values()].map(cancelAttempt));
        attempts.clear();
      });
      void app.register(async (routes) => {
        routes.setErrorHandler((_error, _request, reply) =>
          reply
            .code(400)
            .send({ error: 'This sign-in could not be completed. Return to Otto and try again.' }),
        );
        routes.post('/api/integrations/access/start', async (request) =>
          start(
            z
              .union([
                z.object({ native: z.literal(true) }).strict(),
                z.object({ browserKey: publicKeySchema }).strict(),
              ])
              .parse(request.body),
          ),
        );
        routes.get('/api/integrations/access/status', async (request) =>
          status(z.object({ id: idSchema }).strict().parse(request.query).id),
        );
        routes.post('/api/integrations/access/complete', async (request) =>
          complete(z.object({ id: idSchema }).strict().parse(request.body).id),
        );
        routes.post('/api/integrations/access/cancel', async (request) => {
          await cancelAttempt(required(z.object({ id: idSchema }).strict().parse(request.body).id));
          return { cancelled: true };
        });
        routes.delete('/api/integrations/access', revoke);
      });
    },
  };
}
