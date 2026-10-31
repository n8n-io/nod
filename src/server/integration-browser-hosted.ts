import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IntegrationConnectionBrowser } from '../ports/integrations.ts';
import { logFailure } from './failure-log.ts';

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const input = z
  .object({
    browserKey: z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: token, y: token }),
  })
  .strict();

function page(
  brokerOrigin: string,
  id: string,
  expiresAt: number,
  bridgeKey: string,
  nonce: string,
) {
  const values = JSON.stringify({ brokerOrigin, id, expiresAt, bridgeKey }).replaceAll(
    '<',
    '\\u003c',
  );
  return String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect your app · Nod</title><style nonce="${nonce}">:root{color-scheme:light dark}body{font:16px system-ui;margin:0;min-height:100svh;display:grid;place-items:center;background:light-dark(#fafafa,#191919);color:light-dark(#191919,#fafafa)}main{max-width:360px;padding:32px;text-align:center}h1{font-size:21px;font-weight:550;letter-spacing:-.4px}p{line-height:1.6;color:light-dark(#676767,#bfbfbf)}button{font:inherit;padding:12px 20px;border:0;border-radius:8px;background:light-dark(#191919,#fafafa);color:light-dark(#fafafa,#191919);cursor:pointer}button:disabled{opacity:.5;cursor:default}</style></head><body><main><h1>Connect your app</h1><p id="status" role="status">Keep this page open while you sign in.</p><button id="connect" type="button">Continue to sign in</button></main><script nonce="${nonce}">
const {brokerOrigin,id,expiresAt,bridgeKey}=${values};
const button=document.getElementById('connect');
const status=document.getElementById('status');
let popup,key,started=false,signed=false,deadline=expiresAt;
const valid=()=>{if(Date.now()>=deadline)throw new Error();};
const fail=()=>{button.disabled=true;status.textContent='Sign-in could not be completed. Return to Nod and try again.';popup?.close();};
const encoded=(bytes)=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
window.addEventListener('message',async(event)=>{
if(!key||signed||event.origin!==brokerOrigin||event.source!==popup)return;
const value=event.data;
if(!value||value.type!=='nod:proxy-connect:challenge'||value.id!==id||typeof value.challenge!=='string'||value.challenge.length>512)return;
const parts=value.challenge.split('\n');
if(parts.length!==5||parts[0]!=='nod-proxy-connect-v2'||parts[1]!==id||parts[2]!==location.origin||!/^[a-f0-9]{64}$/.test(parts[3])||!/^[A-Za-z0-9_-]{43}$/.test(parts[4]))return;
signed=true;
try{valid();const signature=new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,new TextEncoder().encode(value.challenge)));valid();if(signature.length!==64)throw new Error();key=undefined;popup.postMessage({type:'nod:proxy-connect:proof',id,signature:encoded(signature)},brokerOrigin);status.textContent='Finish signing in in the other window. You can then return to Nod.';}catch{fail();}
});
button.addEventListener('click',async()=>{
if(started)return;
try{valid();popup=window.open('about:blank','_blank','popup,width=520,height=720');if(!popup){status.textContent='Allow popups for Nod, then select Continue to sign in.';return;}started=true;button.disabled=true;
const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);valid();key=pair.privateKey;
const response=await fetch(location.pathname,{method:'POST',credentials:'same-origin',headers:{'X-Nod-Bridge':bridgeKey,'Content-Type':'application/json'},body:JSON.stringify({browserKey:await crypto.subtle.exportKey('jwk',pair.publicKey)})});if(!response.ok)throw new Error();
const attempt=await response.json();const target=new URL(attempt.url);if(attempt.id!==id||!Number.isSafeInteger(attempt.expiresAt)||target.origin!==brokerOrigin||target.pathname!=='/v2/connect/pair'||target.searchParams.size!==1||!target.searchParams.get('ticket')||target.username||target.password||target.hash)throw new Error();deadline=Math.min(deadline,attempt.expiresAt);valid();if(popup.closed)throw new Error();popup.location.replace(target.href);status.textContent='Finish signing in in the other window.';
}catch{key=undefined;fail();}
});
setTimeout(()=>{key=undefined;button.disabled=true;if(!signed)fail();},Math.max(0,expiresAt-Date.now()));
</script></body></html>`;
}

export function createHostedIntegrationBrowser(origin: string): IntegrationConnectionBrowser & {
  registerRoutes(app: FastifyInstance): void;
} {
  const attempts = new Map<
    string,
    {
      id: string;
      url: string;
      brokerOrigin: string;
      bridgeKey: string;
      expiresAt: number;
      bootstrapped: boolean;
      starting: boolean;
      remote?: string;
      timer: ReturnType<typeof setTimeout>;
      start: Parameters<IntegrationConnectionBrowser['open']>[2];
    }
  >();
  let closed = false;
  function finish(id: string) {
    for (const [capability, attempt] of attempts) {
      if (attempt.id !== id) continue;
      clearTimeout(attempt.timer);
      attempts.delete(capability);
    }
  }
  return {
    async open(id, brokerOrigin, start) {
      token.parse(id);
      if (closed || attempts.size >= 20 || [...attempts.values()].some((value) => value.id === id))
        throw new Error('Another app connection is already being opened.');
      const capability = randomBytes(32).toString('base64url');
      const url = `${origin}/api/apps/connect/${capability}`;
      const expiresAt = Date.now() + 10 * 60_000;
      const timer = setTimeout(() => finish(id), expiresAt - Date.now());
      timer.unref();
      attempts.set(capability, {
        id,
        url,
        brokerOrigin,
        bridgeKey: randomBytes(32).toString('base64url'),
        expiresAt,
        timer,
        start,
        bootstrapped: false,
        starting: false,
      });
      return url;
    },
    registerRoutes(app) {
      app.route<{ Params: { capability: string } }>({
        method: ['GET', 'POST'],
        url: '/api/apps/connect/:capability',
        bodyLimit: 4096,
        async handler(request, reply) {
          const attempt = attempts.get(request.params.capability);
          const nonce = randomBytes(24).toString('base64');
          reply
            .header('Cache-Control', 'no-store')
            .header('Referrer-Policy', 'no-referrer')
            .header('X-Content-Type-Options', 'nosniff')
            .header(
              'Content-Security-Policy',
              `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
            );
          const unavailable = () =>
            reply.code(403).send({ error: 'This app connection is unavailable.' });
          if (
            !attempt ||
            closed ||
            attempt.expiresAt <= Date.now() ||
            request.url !== new URL(attempt.url).pathname ||
            request.headers.host !== new URL(origin).host ||
            (request.headers.origin !== undefined && request.headers.origin !== origin)
          )
            return unavailable();
          if (request.method === 'GET') {
            if (attempt.bootstrapped) return unavailable();
            attempt.bootstrapped = true;
            return reply
              .type('text/html; charset=utf-8')
              .send(
                page(attempt.brokerOrigin, attempt.id, attempt.expiresAt, attempt.bridgeKey, nonce),
              );
          }
          if (
            !attempt.bootstrapped ||
            attempt.starting ||
            request.headers.origin !== origin ||
            request.headers['sec-fetch-site'] === 'cross-site' ||
            request.headers['x-nod-bridge'] !== attempt.bridgeKey
          )
            return unavailable();
          attempt.starting = true;
          try {
            const { browserKey } = input.parse(request.body);
            const remote = new URL(await attempt.start(browserKey, origin));
            if (
              closed ||
              attempts.get(request.params.capability) !== attempt ||
              attempt.expiresAt <= Date.now() ||
              remote.origin !== attempt.brokerOrigin ||
              remote.pathname !== '/v2/connect/pair' ||
              remote.searchParams.size !== 1 ||
              !remote.searchParams.get('ticket') ||
              remote.username ||
              remote.password ||
              remote.hash
            )
              throw new Error('The app sign-in address could not be verified.');
            attempt.remote = remote.href;
            return { id: attempt.id, url: remote.href, expiresAt: attempt.expiresAt };
          } catch (error) {
            finish(attempt.id);
            logFailure('app_connection_start', error);
            return reply.code(400).send({
              error: 'The app connection could not be started. Return to Nod and try again.',
            });
          }
        },
      });
    },
    owns: (url) =>
      [...attempts.values()].some(
        (attempt) => attempt.url === url && attempt.expiresAt > Date.now(),
      ),
    remote: (url) =>
      [...attempts.values()].find(
        (attempt) => attempt.url === url && attempt.expiresAt > Date.now(),
      )?.remote,
    finish,
    async close() {
      closed = true;
      for (const attempt of attempts.values()) finish(attempt.id);
    },
  };
}
