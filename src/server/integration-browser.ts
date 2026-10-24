import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { z } from 'zod';
import type { IntegrationConnectionBrowser } from '../ports/integrations.ts';

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const browserKeySchema = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: token,
    y: token,
    ext: z.literal(true).optional(),
    key_ops: z.array(z.literal('verify')).max(1).optional(),
  })
  .strict();

export function renderIntegrationBrowser(
  brokerOrigin: string,
  nonce: string,
  bridgeKey: string,
  continuation: { id?: string; expiresAt: number },
) {
  const broker = JSON.stringify(brokerOrigin).replaceAll('<', '\\u003c');
  const secret = JSON.stringify(bridgeKey).replaceAll('<', '\\u003c');
  const expected = JSON.stringify(continuation).replaceAll('<', '\\u003c');
  return String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connecting your app · nod</title><style nonce="${nonce}">:root{color-scheme:light dark}body{font:16px system-ui;margin:0;min-height:100svh;display:grid;place-items:center;background:light-dark(#fafafa,#191919);color:light-dark(#191919,#fafafa)}main{max-width:360px;padding:32px;text-align:center}h1{font-size:16px;font-weight:400}p{line-height:1.6;color:light-dark(#676767,#bfbfbf)}.failed h1{font-size:21px;font-weight:550;letter-spacing:-.4px}</style></head><body><main hidden><h1 id="heading">Opening sign-in…</h1><p id="status" role="status"></p></main><script nonce="${nonce}">
const brokerOrigin=${broker};
const bridgeKey=${secret};
const expected=${expected};
const fragment=location.hash.slice(1);
history.replaceState(null,'',location.pathname);
const slot='nod-native-connect';
const content=document.querySelector('main');
const waiting=setTimeout(()=>{content.hidden=false;},1500);
let database;
const valid=()=>{if(Date.now()>=expected.expiresAt)throw new Error();};
const open=()=>new Promise((resolve,reject)=>{const request=indexedDB.open(slot,1);request.onupgradeneeded=()=>request.result.createObjectStore('keys');request.onsuccess=()=>resolve(request.result);request.onerror=request.onblocked=()=>reject(new Error());});
const stored=(action,value)=>new Promise((resolve,reject)=>{const transaction=database.transaction('keys','readwrite',{durability:'strict'});const store=transaction.objectStore('keys');let result;const request=store.get('current');request.onsuccess=()=>{result=request.result;if(action==='put')store.put(value,'current');else store.delete('current');};transaction.oncomplete=()=>resolve(result);transaction.onerror=transaction.onabort=()=>reject(new Error());});
const encoded=(bytes)=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const request=async(body)=>{const response=await fetch('/start',{method:'POST',credentials:'same-origin',headers:{'X-Nod-Bridge':bridgeKey,'Content-Type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw new Error();return response.json();};
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
if(parts.length!==5||parts[0]!=='nod-proxy-connect-v2'||parts[1]!==expected.id||parts[2]!==location.origin||!/^[a-f0-9]{64}$/.test(parts[3])||!/^[A-Za-z0-9_-]{43}$/.test(parts[4]))throw new Error();
const signature=new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},saved.key,new TextEncoder().encode(value.challenge)));valid();if(Date.now()>=saved.expiresAt||signature.length!==64)throw new Error();
location.replace(brokerOrigin+'/v2/connect/native-proof#'+encodeURIComponent(JSON.stringify({proof:value.proof,signature:encoded(signature)})));
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
if(!/^[A-Za-z0-9_-]{43}$/.test(attempt.id)||!Number.isSafeInteger(attempt.expiresAt)||attempt.expiresAt<=Date.now()||target.origin!==brokerOrigin||target.pathname!=='/v2/connect/pair'||target.searchParams.size!==1||!target.searchParams.get('ticket')||target.username||target.password||target.hash)throw new Error();
await stored('put',{...saved,id:attempt.id,expiresAt:Math.min(expected.expiresAt,attempt.expiresAt)});valid();
location.replace(target.href);
}
}catch{
try{sessionStorage.removeItem(slot);if(database)await stored('take');}catch{}
content.hidden=false;document.body.classList.add('failed');document.title='Sign-in could not be completed · nod';document.getElementById('heading').textContent='Sign-in could not be completed';document.getElementById('status').textContent='Return to nod and try again.';
}finally{clearTimeout(waiting);database?.close();}})();
</script></body></html>`;
}

export function createIntegrationBrowser(): IntegrationConnectionBrowser {
  const attempts = new Map<
    string,
    {
      url: string;
      remote?: string;
      server: Server;
      expiresAt: number;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const opening = new Set<string>();
  let closed = false;
  async function readBody(request: IncomingMessage) {
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 4096) throw new Error();
      chunks.push(Buffer.from(chunk));
    }
    return z
      .object({ browserKey: browserKeySchema })
      .strict()
      .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }
  function finish(id: string) {
    const attempt = attempts.get(id);
    if (!attempt) return;
    clearTimeout(attempt.timer);
    attempts.delete(id);
    attempt.server.close();
    attempt.server.closeAllConnections();
  }
  return {
    async open(id, brokerOrigin, start) {
      token.parse(id);
      if (closed || attempts.has(id) || opening.has(id) || attempts.size + opening.size >= 20)
        throw new Error('Another app connection is already being opened.');
      opening.add(id);
      const capability = randomBytes(32).toString('base64url');
      const bridgeKey = randomBytes(32).toString('base64url');
      const returnPath = `/${randomBytes(32).toString('base64url')}`;
      const expiresAt = Date.now() + 10 * 60_000;
      let origin = '';
      let bootstrapped = false;
      let starting = false;
      let returned = false;
      const server = createServer(async (request, response) => {
        const nonce = randomBytes(24).toString('base64');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader(
          'Content-Security-Policy',
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        );
        const send = (status: number, value: unknown) => {
          response.writeHead(status, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(value));
        };
        const live = () => !closed && attempts.has(id) && expiresAt > Date.now();
        try {
          if (
            !live() ||
            request.headers.host !== new URL(origin).host ||
            (request.headers.origin !== undefined &&
              request.headers.origin !== origin &&
              !(
                request.method === 'GET' &&
                request.url === returnPath &&
                request.headers.origin === brokerOrigin
              ))
          )
            return send(403, { error: 'This app connection is unavailable.' });
          if (request.method === 'GET' && request.url === `/${capability}` && !bootstrapped) {
            bootstrapped = true;
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(renderIntegrationBrowser(brokerOrigin, nonce, bridgeKey, { expiresAt }));
            return;
          }
          if (
            request.method === 'GET' &&
            request.url === returnPath &&
            bootstrapped &&
            attempts.get(id)?.remote &&
            !returned
          ) {
            returned = true;
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(renderIntegrationBrowser(brokerOrigin, nonce, '', { id, expiresAt }));
            return;
          }
          if (
            request.method !== 'POST' ||
            request.url !== '/start' ||
            !bootstrapped ||
            starting ||
            request.headers.origin !== origin ||
            request.headers['sec-fetch-site'] === 'cross-site' ||
            request.headers['x-nod-bridge'] !== bridgeKey
          )
            return send(403, { error: 'This app connection is unavailable.' });
          starting = true;
          const { browserKey } = await readBody(request);
          if (!live()) throw new Error();
          const url = await start(browserKey, origin, { returnPath });
          if (!live()) throw new Error();
          const remote = new URL(url);
          if (
            remote.origin !== brokerOrigin ||
            remote.pathname !== '/v2/connect/pair' ||
            remote.searchParams.size !== 1 ||
            !remote.searchParams.get('ticket') ||
            remote.username ||
            remote.password ||
            remote.hash
          )
            throw new Error();
          attempts.get(id)!.remote = remote.href;
          send(200, { id, url: remote.href, expiresAt });
        } catch {
          send(400, {
            error: 'The app connection could not be started. Return to nod and try again.',
          });
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
      }).finally(() => opening.delete(id));
      server.unref();
      const address = server.address();
      if (!address || typeof address === 'string' || closed) {
        server.close();
        throw new Error('This app connection is unavailable.');
      }
      origin = `http://127.0.0.1:${address.port}`;
      const url = `${origin}/${capability}`;
      const timer = setTimeout(() => finish(id), expiresAt - Date.now());
      timer.unref();
      attempts.set(id, { url, server, expiresAt, timer });
      return url;
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
      for (const id of attempts.keys()) finish(id);
    },
  };
}
