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
  continuation: { id?: string; expiresAt: number },
) {
  const broker = JSON.stringify(brokerOrigin).replaceAll('<', '\\u003c');
  const secret = JSON.stringify(bridgeKey).replaceAll('<', '\\u003c');
  const expected = JSON.stringify(continuation).replaceAll('<', '\\u003c');
  return String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening Google · Otto</title><style nonce="${nonce}">:root{color-scheme:light dark}body{font:16px system-ui;margin:0;min-height:100svh;display:grid;place-items:center;background:light-dark(#fafafa,#191919);color:light-dark(#191919,#fafafa)}main{max-width:360px;padding:32px;text-align:center}svg{width:48px;height:48px;overflow:visible}h1{font-size:21px;font-weight:550;letter-spacing:-.4px}p{line-height:1.6;color:light-dark(#676767,#bfbfbf)}.orbit{transform-origin:16px 16px;animation:orbit 1.4s linear infinite}.failed .orbit{animation:none}@keyframes orbit{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.orbit{animation:none}}</style></head><body><main><svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><circle cx="16" cy="16" r="10" stroke="currentColor" stroke-width="4"/><g class="orbit"><circle cx="25" cy="6" r="4" fill="#ff91ac"/></g></svg><h1 id="heading">Opening Google…</h1><p id="status" role="status"></p></main><script nonce="${nonce}">
const brokerOrigin=${broker};
const bridgeKey=${secret};
const expected=${expected};
const fragment=location.hash.slice(1);
history.replaceState(null,'',location.pathname);
const slot='otto-native-access';
let database;
const valid=()=>{if(Date.now()>=expected.expiresAt)throw new Error();};
const open=()=>new Promise((resolve,reject)=>{const request=indexedDB.open(slot,1);request.onupgradeneeded=()=>request.result.createObjectStore('keys');request.onsuccess=()=>resolve(request.result);request.onerror=request.onblocked=()=>reject(new Error());});
const stored=(action,value)=>new Promise((resolve,reject)=>{const transaction=database.transaction('keys','readwrite',{durability:'strict'});const store=transaction.objectStore('keys');let result;const request=store.get('current');request.onsuccess=()=>{result=request.result;if(action==='put')store.put(value,'current');else store.delete('current');};transaction.oncomplete=()=>resolve(result);transaction.onerror=transaction.onabort=()=>reject(new Error());});
const encoded=(bytes)=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const request=async(body)=>{const response=await fetch('/start',{method:'POST',credentials:'same-origin',headers:{'X-Otto-Bridge':bridgeKey,'Content-Type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw new Error();return response.json();};
(async()=>{try{
database=await open();valid();
if(expected.id){
const marker=sessionStorage.getItem(slot);sessionStorage.removeItem(slot);
const saved=await stored('take');valid();
if(!saved||!marker||saved.marker!==marker||saved.id!==expected.id||saved.brokerOrigin!==brokerOrigin||saved.expiresAt<=Date.now()||saved.key?.type!=='private'||saved.key.extractable!==false||saved.key.algorithm?.name!=='ECDSA'||saved.key.algorithm.namedCurve!=='P-256')throw new Error();
if(fragment.length>16000)throw new Error();
const value=JSON.parse(decodeURIComponent(fragment));
if(!value||Object.keys(value).sort().join(',')!=='challenge,id,proof'||value.id!==expected.id||typeof value.proof!=='string'||value.proof.length>6000||typeof value.challenge!=='string'||value.challenge.length>512)throw new Error();
const parts=value.challenge.split('\n');
if(parts.length!==5||parts[0]!=='otto-proxy-access-v1'||parts[1]!==expected.id||parts[2]!==location.origin||!/^[a-f0-9]{64}$/.test(parts[3])||!/^[A-Za-z0-9_-]{43}$/.test(parts[4]))throw new Error();
const signature=new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},saved.key,new TextEncoder().encode(value.challenge)));valid();if(Date.now()>=saved.expiresAt||signature.length!==64)throw new Error();
location.replace(brokerOrigin+'/api/auth/native-proof#'+encodeURIComponent(JSON.stringify({proof:value.proof,signature:encoded(signature)})));
}else{
if(fragment)throw new Error();
await stored('take');
const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);valid();
const marker=encoded(crypto.getRandomValues(new Uint8Array(32)));
sessionStorage.setItem(slot,marker);
const saved={key:key.privateKey,marker,brokerOrigin,expiresAt:expected.expiresAt};
await stored('put',saved);valid();
const attempt=await request({browserKey:await crypto.subtle.exportKey('jwk',key.publicKey)});valid();
const target=new URL(attempt.url);
if(!/^[A-Za-z0-9_-]{43}$/.test(attempt.id)||!Number.isSafeInteger(attempt.expiresAt)||attempt.expiresAt<=Date.now()||target.origin!==brokerOrigin||target.pathname!=='/api/auth/enroll'||target.searchParams.size!==2||target.searchParams.get('id')!==attempt.id||!target.searchParams.get('handoff')||target.username||target.password||target.hash)throw new Error();
await stored('put',{...saved,id:attempt.id,expiresAt:Math.min(expected.expiresAt,attempt.expiresAt)});valid();
location.replace(target.href);
}
}catch{
try{sessionStorage.removeItem(slot);if(database)await stored('take');}catch{}
document.body.classList.add('failed');document.title='Sign-in could not be completed · Otto';document.getElementById('heading').textContent='Sign-in could not be completed';document.getElementById('status').textContent='Return to Otto and try again.';
}finally{database?.close();}})();
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
  async function enroll(
    attempt: Attempt,
    browserKey: unknown,
    origin: string,
    native?: { returnPath: string },
  ) {
    if (!live(attempt) || attempt.brokerId) throw new Error('This sign-in attempt is unavailable.');
    const result = await options.proxy.startAccess(
      publicKeySchema.parse(browserKey),
      origin,
      attempt.challenge,
      attempt.controller.signal,
      native,
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
    const returnPath = `/${randomBytes(32).toString('base64url')}`;
    let returned = false;
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
          (request.headers.origin !== undefined &&
            request.headers.origin !== origin &&
            !(
              request.method === 'GET' &&
              request.url === returnPath &&
              request.headers.origin === options.proxy.origin
            ))
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
          response.end(
            renderIntegrationAccessBridge(options.proxy.origin, nonce, bridgeKey, {
              expiresAt: attempt.expiresAt,
            }),
          );
          return;
        }
        if (
          live(attempt) &&
          bootstrapped &&
          attempt.brokerId &&
          !returned &&
          request.method === 'GET' &&
          request.url === returnPath
        ) {
          returned = true;
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end(
            renderIntegrationAccessBridge(options.proxy.origin, nonce, '', {
              id: attempt.brokerId,
              expiresAt: attempt.expiresAt,
            }),
          );
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
          const result = await enroll(attempt, input.browserKey, origin, { returnPath });
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
