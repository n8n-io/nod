import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { channelReply, createChannels } from '../src/server/channels.ts';
import { createAgentReactionService } from '../src/server/agent-reactions.ts';
import { createChatVerification } from '../src/server/chat-verification.ts';
import { createVault } from '../src/server/vault.ts';
import { locksTable } from '../src/server/locks.ts';
import { createChatSdkTransport } from '../src/providers/chat-sdk/index.ts';
import type { MessagingTransport } from '../src/ports/messaging.ts';
import { createChatSdkSetupVerifier } from '../src/providers/chat-sdk/settings.ts';
import { createWhatsAppLinkedTransport } from '../src/providers/chat-sdk/whatsapp.ts';
import { combineMessagingTransports } from '../src/providers/chat-sdk/combined.ts';
import { createChannelSessionStore } from '../src/server/channel-session.ts';
import { createChannelMedia } from '../src/server/channel-media.ts';
import { createSpeech } from '../src/server/speech.ts';
import { createOpenAISpeechProvider } from '../src/providers/openai/speech.ts';
import { createOpenRouterTranscriptionProvider } from '../src/providers/openrouter/speech.ts';
import { createArtifactService } from '../src/server/artifacts.ts';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Artifact } from '../src/shared/contracts.ts';
import type { InboundMessage } from '../src/ports/messaging.ts';
import { getHttpStream } from '@whiskeysockets/baileys';
import { spendingLimitReached } from '../src/server/ledger.ts';
import { ChannelMediaFailure } from '../src/server/channel-media.ts';
import { runProcess } from '../src/providers/process.ts';
import { loadAudioWaveform } from '../src/web/lib/audio-waveform.ts';
import { contactCards } from '../src/shared/channel-content.ts';
import { contactAttachment } from '../src/providers/chat-sdk/content.ts';
import { gzipSync } from 'node:zlib';
import { decodeSticker } from '../src/web/lib/sticker.ts';

test('TGS previews decode vector animation and refuse expansion, expression and external asset input', async () => {
  const animation = { v: '5.7.4', w: 512, h: 512, fr: 60, ip: 0, op: 180, layers: [], assets: [] };
  const decode = (value: unknown, signal = new AbortController().signal) =>
    decodeSticker(gzipSync(JSON.stringify(value)), signal);
  assert.deepEqual(await decode(animation), animation);
  const emptyMetadata = {
    ...animation,
    fonts: { list: [] },
    chars: [],
    segments: [],
    slots: {},
    layers: [{ ty: 4, ef: [], masksProperties: [], shapes: [] }],
  };
  assert.deepEqual(await decode(emptyMetadata), emptyMetadata);
  for (const change of [
    { w: 100_000 },
    { op: 181 },
    { fr: 0 },
    { fonts: {} },
    { slots: { S: { p: { k: Array.from({ length: 1000 }, () => 1) } } } },
    { __complete: true },
    { layers: [{ ty: 4, tt: 1, tp: 2 }] },
    { layers: [{ ty: 0, refId: 'large', w: 1e9, h: 1e9 }], assets: [{ id: 'large', layers: [] }] },
    { layers: [{ ty: 0, completed: true, layers: [{ ind: 1 }, { ind: 1 }] }] },
    {
      layers: [
        {
          ty: 4,
          shapes: [
            {
              ty: 'sh',
              ks: {
                a: 0,
                k: {
                  c: true,
                  v: [
                    [0, 0],
                    [0, 0],
                  ],
                  i: [
                    [0, 0],
                    [0, 0],
                  ],
                  o: [
                    [0, 0],
                    [0, 0],
                  ],
                },
              },
            },
            ...Array.from({ length: 40 }, () => ({ ty: 'rd', r: { a: 0, k: 10 } })),
          ],
        },
      ],
    },
    {
      layers: [
        {
          ty: 4,
          shapes: [
            ...Array.from({ length: 400 }, () => ({
              ty: 'el',
              p: { a: 0, k: [0, 0] },
              s: { a: 0, k: [20, 20] },
            })),
            ...Array.from({ length: 400 }, () => ({ ty: 'fl', c: { a: 0, k: [1, 0, 0, 1] } })),
          ],
        },
      ],
    },
    { assets: [{ id: 'image', p: 'https://example.test/private', u: '' }] },
    { layers: [{ ks: { x: 'while(true){}' } }] },
    { layers: [{ ty: 4, shapes: [{ ty: 'rp', c: { a: 0, k: 1e12 } }] }] },
    { layers: [{ ty: 4, shapes: [{ ty: 'zz', r: { a: 0, k: 1e12 } }] }] },
    { layers: [{ ty: 4, shapes: [{ ty: 'sr', pt: { a: 0, k: 1e12 } }] }] },
    { layers: [{ ty: 4, shapes: [{ ty: 'gf', g: { p: 1e12, k: { a: 0, k: [] } } }] }] },
    { layers: [{ ty: 4, shapes: [{ ty: 'gf', g: { p: '1000000000', k: { a: 0, k: [] } } }] }] },
    { layers: [{ ty: 4, ks: { p: { k: { 0: 1, length: 1e9 } } } }] },
    {
      layers: [{ ty: 0, refId: 'loop' }],
      assets: [{ id: 'loop', layers: [{ ty: 0, refId: 'loop' }] }],
    },
    { layers: [{ ty: 0, refId: 'missing' }] },
    {
      layers: [
        { ty: 4, ind: 1, parent: 2 },
        { ty: 4, ind: 2, parent: 1 },
      ],
    },
    { layers: [{ ty: 4, ind: '1', parent: 1 }] },
    {
      layers: [
        { ty: 4, ind: 1 },
        { ty: 4, ind: 1 },
      ],
    },
    { layers: [JSON.parse('{"__proto__":{"p":"private"}}')] },
    { layers: Array.from({ length: 100_001 }, () => 0) },
    { data: 'x'.repeat(4_000_001) },
  ])
    await assert.rejects(decode({ ...animation, ...change }));
  const nested = {
    ...animation,
    layers: [{ ty: 0, refId: 'shape' }],
    assets: [{ id: 'shape', layers: [{ ty: 4, shapes: [{ ty: 'el' }] }] }],
  };
  assert.deepEqual(await decode(nested), nested);
  await assert.rejects(
    decode({
      ...animation,
      layers: [{ ty: 0, refId: 'level0' }],
      assets: Array.from({ length: 20 }, (_, index) => ({
        id: `level${index}`,
        layers:
          index === 19
            ? [{ ty: 4, shapes: [{ ty: 'el' }] }]
            : Array.from({ length: 2 }, () => ({ ty: 0, refId: `level${index + 1}` })),
      })),
    }),
  );
  await assert.rejects(decodeSticker(new Uint8Array([1, 2, 3]), new AbortController().signal));
  await assert.rejects(
    decodeSticker(
      gzipSync(
        '{"w":512,"h":512,"fr":60,"ip":0,"op":180,"layers":[{"ty":4,"ks":{"p":{"k":[1e400,0]}}}]}',
      ),
      new AbortController().signal,
    ),
  );
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(decode(animation, stopped.signal), { name: 'AbortError' });
});

test('contact previews read vCard 2.1, 3.0 and 4.0 without treating field values as markup or links', () => {
  const text = [
    'BEGIN:VCARD',
    'VERSION:2.1',
    'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Synthetic =C3=\r\n =85ngstr=C3=B6m',
    'TEL;CELL:+34600000000',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:3.0',
    'N:Doe\\;Smith;Alex;;Dr.;',
    'ORG:Synthetic\\;Co;Research',
    'TITLE:Engineer',
    'ADR:;;Example\\; Street;City;;;Country',
    'item1.EMAIL:fixture@example.test',
    'URL:javascript:alert(1)',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:4.0',
    'FN:Synthetic <Contact>',
    'TEL;VALUE=uri:tel:+34600000001',
    'EMAIL:mailto:other@example.test',
    'END:VCARD',
  ].join('\r\n');
  const cards = contactCards(text);
  assert.equal(cards.length, 3);
  assert.equal(cards[0].name, 'Synthetic Ångström');
  assert.equal(cards[1].name, 'Dr. Alex Doe;Smith');
  assert.equal(cards[1].organization, 'Synthetic;Co · Research');
  assert.equal(cards[1].title, 'Engineer');
  assert.deepEqual(cards[1].addresses, ['Example; Street, City, Country']);
  assert.deepEqual(cards[1].urls, ['javascript:alert(1)']);
  assert.equal(cards[2].name, 'Synthetic <Contact>');
  assert.deepEqual(cards[2].phones, ['+34600000001']);
  assert.deepEqual(cards[2].emails, ['other@example.test']);
  const start = performance.now();
  assert.equal(
    contactCards(
      'BEGIN:VCARD\r\nX-BAD' + '\r\n A'.repeat(100_000) + '\r\nFN:Synthetic\r\nEND:VCARD',
    )[0].name,
    'Synthetic',
  );
  assert.ok(performance.now() - start < 5000);
  assert.deepEqual(
    contactCards('BEGIN:VCARD\r\nFN:First\r\nBEGIN:VCARD\r\nFN:Second\r\nEND:VCARD'),
    [],
  );
});

test('audio waveform reads refuse foreign URLs, oversized streams, redirects and cancelled work', async (t) => {
  const ids = Array.from({ length: 5 }, () => randomUUID());
  const opus = (count: number, granule = 0n) => {
    const head = Buffer.alloc(19);
    head.write('OpusHead');
    head[8] = 1;
    head[9] = 1;
    const packets = [
      head,
      Buffer.from('OpusTags'),
      ...Array.from({ length: count }, () => Buffer.from([25, 0])),
    ];
    return Buffer.concat(
      packets.map((packet, index) => {
        const page = Buffer.alloc(28 + packet.length);
        page.write('OggS');
        page[5] = index === 0 ? 2 : index === packets.length - 1 ? 4 : 0;
        page.writeBigUInt64LE(granule, 6);
        page.writeUInt32LE(1, 14);
        page.writeUInt32LE(index, 18);
        page[26] = 1;
        page[27] = packet.length;
        packet.copy(page, 28);
        let crc = 0;
        for (const byte of page) {
          crc ^= byte << 24;
          for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
        }
        page.writeUInt32LE(crc >>> 0, 22);
        return page;
      }),
    );
  };
  let reads = 0;
  let redirectReads = 0;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    started = resolve;
  });
  const server = createServer((request, response) => {
    reads++;
    if (request.url === `/api/artifacts/${ids[0]}`) {
      response.writeHead(200, { 'Content-Type': 'audio/ogg' });
      response.end(Buffer.alloc(25 * 1024 * 1024 + 1));
    } else if (request.url === `/api/artifacts/${ids[1]}`) {
      response.writeHead(200, { 'Content-Type': 'audio/ogg' });
      response.write('OggS');
      started();
    } else if (request.url === `/api/artifacts/${ids[2]}`) {
      response.writeHead(302, { Location: '/foreign' });
      response.end();
    } else if (
      request.url === `/api/artifacts/${ids[3]}` ||
      request.url === `/api/artifacts/${ids[4]}`
    ) {
      response.writeHead(200, { 'Content-Type': 'audio/ogg' });
      response.end(request.url.endsWith(ids[3]) ? opus(5001) : opus(1, 0x100000000n));
    } else {
      redirectReads++;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address() as { port: number };
  const original = globalThis.fetch;
  globalThis.fetch = (input, options) =>
    original(new URL(String(input), `http://127.0.0.1:${address.port}`), options);
  t.after(() => {
    globalThis.fetch = original;
  });
  const url = `/api/artifacts/${ids[0]}`;
  for (const input of [
    { url: 'https://example.invalid/private.ogg', size: 10, duration: 1 },
    { url, size: 25 * 1024 * 1024 + 1, duration: 1 },
    { url, size: 10, duration: Infinity },
    { url, size: 10, duration: 601 },
  ])
    await assert.rejects(
      loadAudioWaveform(input.url, input.size, input.duration, new AbortController().signal),
      /Waveform unavailable/,
    );
  assert.equal(reads, 0);
  await assert.rejects(
    loadAudioWaveform(url, 10, 1, new AbortController().signal),
    /too large to preview/,
  );
  const controller = new AbortController();
  const pending = loadAudioWaveform(`/api/artifacts/${ids[1]}`, 10, 1, controller.signal);
  await held;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(
    loadAudioWaveform(`/api/artifacts/${ids[2]}`, 10, 1, new AbortController().signal),
  );
  assert.equal(redirectReads, 0);
  for (const id of ids.slice(3))
    await assert.rejects(
      loadAudioWaveform(`/api/artifacts/${id}`, 100, 1, new AbortController().signal),
      /Waveform unavailable/,
    );
});

test('WhatsApp setup closes the replacement generation despite stale polls and late restart responses', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
      import assert from 'node:assert/strict';
      import {JSDOM} from 'jsdom';
      const dom = new JSDOM('<!doctype html><div id="root"></div>', {url:'http://localhost/channels'});
      Object.assign(globalThis, {window:dom.window,document:dom.window.document,
        IS_REACT_ACT_ENVIRONMENT:true,HTMLElement:dom.window.HTMLElement,
        getComputedStyle:dom.window.getComputedStyle.bind(dom.window)});
      const {createElement,act} = await import('react');
      const {createRoot} = await import('react-dom/client');
      const {WhatsAppSetup} = await import('./src/web/components/whatsapp-setup.tsx');
      const sleep = globalThis.setTimeout;
      const clear = globalThis.clearTimeout;
      let poll;
      globalThis.setTimeout = (fn,ms,...args) => ms===2000 ? (poll=fn,{poll:true}) : sleep(fn,ms,...args);
      globalThis.clearTimeout = id => {if(!id?.poll) clear(id);};
      const settle = async check => {
        for(let i=0;i<100&&!check();i++) await act(async()=>{await new Promise(resolve=>sleep(resolve,5));});
        assert.ok(check(),'The setup request did not settle.');
      };
      for(const closeDuringRestart of [false,true]) {
        const oldId='11111111-1111-4111-8111-111111111111';
        const nextId='22222222-2222-4222-8222-222222222222';
        const old={state:'expired',pairingId:oldId};
        const next={state:'awaiting_scan',pairingId:nextId,qr:'synthetic-invalid-qr'};
        let reads=0,resolvePost,resolvePoll;
        const cancelled=[];
        globalThis.fetch=async (_url,options={})=>{
          if(options.method==='DELETE') {
            cancelled.push(JSON.parse(options.body).pairingId);
            return Response.json({ok:true});
          }
          if(options.method==='POST') {
            assert.equal(JSON.parse(options.body).pairingId,oldId);
            return new Promise(resolve=>{resolvePost=()=>resolve(Response.json(next));});
          }
          if(++reads===1) return Response.json(old);
          return new Promise(resolve=>{resolvePoll=()=>resolve(Response.json(old));});
        };
        const root=createRoot(document.querySelector('#root'));
        await act(async()=>root.render(createElement(WhatsAppSetup,{
          setup:{provider:'whatsapp',enabled:true,mode:'linked',connectionState:'expired'},
          busy:false,ready:true,error:'',onSave:async()=>true,onRefresh:async()=>{},onCloud(){},onDone(){},
        })));
        const restart=()=>[...document.querySelectorAll('button')].find(button=>button.textContent.includes('Start again'));
        await settle(()=>restart()&&!restart().disabled);
        if(!closeDuringRestart) {
          await act(async()=>poll());
          await settle(()=>Boolean(resolvePoll));
        }
        await act(async()=>restart().click());
        await settle(()=>Boolean(resolvePost));
        if(closeDuringRestart) await act(async()=>root.unmount());
        await act(async()=>resolvePost());
        if(resolvePoll) await act(async()=>resolvePoll());
        if(!closeDuringRestart) await act(async()=>root.unmount());
        await settle(()=>cancelled.includes(nextId));
        assert.equal(cancelled.at(-1),nextId);
      }
      globalThis.setTimeout=sleep;
      globalThis.clearTimeout=clear;
      dom.window.close();
    `,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
});

const attachment = (name: string, mimeType: string, text: string) => ({
  name,
  mimeType,
  size: Buffer.byteLength(text),
  read: async () => Buffer.from(text),
});

const fixtureEnv = {
  TELEGRAM_ENABLED: 'true',
  TELEGRAM_BOT_TOKEN: '987:fixture-not-live',
  TELEGRAM_WEBHOOK_SECRET_TOKEN: 'fixture-webhook-secret-32-characters',
  TELEGRAM_ALLOWED_USER_ID: '123456',
  WHATSAPP_ENABLED: 'true',
  WHATSAPP_ACCESS_TOKEN: 'fixture-not-live',
  WHATSAPP_APP_SECRET: 'fixture-app-secret',
  WHATSAPP_PHONE_NUMBER_ID: '555000',
  WHATSAPP_VERIFY_TOKEN: 'fixture-verify-token',
  WHATSAPP_ALLOWED_NUMBER: '351910000000',
  WHATSAPP_POLICY_CONFIRMED: 'true',
};

test('the pinned WhatsApp download refuses redirects and stops before response headers on abort', async (t) => {
  let redirected = 0;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const server = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: '/other' });
      response.end();
    } else if (request.url === '/held') {
      entered();
    } else {
      redirected++;
      response.end('synthetic data');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  await assert.rejects(getHttpStream(origin + '/redirect', { redirect: 'error' }));
  assert.equal(redirected, 0);
  const controller = new AbortController();
  const pending = getHttpStream(origin + '/held', { signal: controller.signal });
  await waiting;
  controller.abort();
  await assert.rejects(pending, /abort/i);
});

test('Signal session changes never write key material to the process console', (t) => {
  const require = createRequire(import.meta.url);
  const { SessionRecord } = require('libsignal');
  const output: unknown[][] = [];
  for (const method of ['info', 'warn', 'error', 'log'] as const)
    t.mock.method(console, method, (...args: unknown[]) => {
      output.push(args);
    });
  const record = new SessionRecord();
  const entry = SessionRecord.createEntry();
  entry.indexInfo = { closed: -1, baseKey: Buffer.from('synthetic-private-session-key') };
  record.closeSession(entry);
  record.openSession(entry);
  assert.equal(entry.indexInfo.closed, -1);
  assert.deepEqual(output, []);
});

test(
  'WhatsApp links privately, admits only its owner, fences echoes across restart, and reconnects without repeating sends',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_whatsapp_link_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const keyStore = { id: 'fixture', configured: true, getKey: async () => key };
    const key = Buffer.alloc(32, 7);
    try {
      for (const mode of ['bot', 'self-chat'] as const)
        await t.test(mode, async () => {
          type Options = Parameters<typeof createWhatsAppLinkedTransport>[0];
          type Factory = NonNullable<Options['createSocket']>;
          const sockets: { events: EventEmitter; config: Parameters<Factory>[0] }[] = [];
          const sent: {
            jid: string;
            content: Record<string, unknown>;
            id: string;
            quoted: unknown;
          }[] = [];
          const collected: InboundMessage[] = [];
          const reacted: string[] = [];
          const presence: string[][] = [];
          let downloads = 0;
          let logouts = 0;
          let failSend = false;
          let failClear = false;
          let failLogout = false;
          let abortDownload: AbortController | undefined;
          let lateStream: PassThrough | undefined;
          let oversizedDownload = false;
          const own = mode === 'self-chat' ? '12345678' : '99999999';
          const owner = '12345678';
          const accountId = `linked:${own}`;
          const jid = `${owner}@s.whatsapp.net`;
          const store = createChannelSessionStore({ pool, ownerId: `fixture-${mode}`, keyStore });
          const createSocket: Factory = (config) => {
            const events = new EventEmitter();
            sockets.push({ events, config });
            return {
              ev: events,
              user: { id: `${own}:1@s.whatsapp.net`, lid: '55555555@lid', name: 'Fixture' },
              signalRepository: {
                lidMapping: {
                  getPNForLID: async (lid: string) =>
                    ['55555555@lid', '66666666@lid'].includes(lid) ? jid : null,
                },
              },
              end: () => {},
              logout: async () => {
                logouts++;
                if (failLogout) throw new Error('Synthetic sign-out response was lost.');
              },
              sendPresenceUpdate: async (state: string, destination: string) => {
                presence.push([state, destination]);
              },
              sendMessage: async (
                destination: string,
                content: Record<string, unknown>,
                input: { messageId: string; quoted?: unknown },
              ) => {
                sent.push({ jid: destination, content, id: input.messageId, quoted: input.quoted });
                if (failSend) throw new Error('The provider may have accepted this message.');
                return { key: { id: input.messageId } };
              },
            } as unknown as ReturnType<Factory>;
          };
          const download = (async () => {
            downloads++;
            const stream = new PassThrough();
            if (abortDownload) {
              lateStream = stream;
              abortDownload.abort();
            } else
              stream.end(
                oversizedDownload
                  ? Buffer.alloc(50 * 1024 * 1024 + 1)
                  : Buffer.from('synthetic image'),
              );
            return stream;
          }) as NonNullable<Options['download']>;
          const open = () =>
            createWhatsAppLinkedTransport({
              mode,
              allowedNumber: owner,
              store: {
                async open() {
                  const session = await store.open();
                  return {
                    ...session,
                    async clear() {
                      if (failClear) {
                        failClear = false;
                        throw new Error('Synthetic key deletion failure.');
                      }
                      await session.clear();
                    },
                  };
                },
              },
              createSocket,
              download,
            });
          let transport = open();
          try {
            const initial = await transport.pairing!();
            assert.ok(initial.pairingId);
            assert.equal(sockets[0].config.logger?.level, 'silent');
            assert.equal(sockets[0].config.maxMsgRetryCount, 0);
            assert.equal(sockets[0].config.shouldSyncHistoryMessage?.({}), false);
            sockets[0].events.emit('connection.update', { qr: 'synthetic-qr' });
            assert.equal((await transport.pairing!()).qr, 'synthetic-qr');
            assert.equal(await transport.cancelPairing!('another-setup'), false);
            const me = { id: `${own}:1@s.whatsapp.net`, lid: '55555555@lid', name: 'Fixture' };
            sockets[0].events.emit('creds.update', { me, registered: true });
            sockets[0].events.emit('connection.update', { connection: 'open' });
            assert.equal((await transport.pairing!()).qr, undefined);
            assert.equal(await transport.cancelPairing!(initial.pairingId!), false);
            assert.equal(await transport.cancelPairing!(initial.pairingId!, true), false);
            await sockets[0].config.auth.keys.set({
              session: { fixture: Uint8Array.from([1, 2, 3]) },
            });
            const envelope = (id: string, remoteJid = jid, fromMe = mode === 'self-chat') => ({
              key: { id, remoteJid, fromMe },
              messageTimestamp: Math.floor(Date.now() / 1000),
              message: { conversation: 'Fixture request' },
            });
            sockets[0].events.emit('messages.upsert', {
              type: 'notify',
              messages: [
                envelope('owner'),
                envelope('intruder', '87654321@s.whatsapp.net', false),
                envelope('group', '12345678@g.us'),
                { ...envelope('old'), messageTimestamp: Math.floor(Date.now() / 1000) - 3600 },
                {
                  ...envelope('image'),
                  message: {
                    imageMessage: {
                      caption: 'Inspect this image',
                      mimetype: 'image/jpeg',
                      fileLength: 15,
                      url: 'https://mmg.whatsapp.net/fixture',
                    },
                  },
                },
                {
                  ...envelope('reaction'),
                  message: { reactionMessage: { key: { id: 'task-prompt' }, text: '👍' } },
                },
                {
                  ...envelope('quoted'),
                  message: {
                    extendedTextMessage: {
                      text: 'Continue this task',
                      contextInfo: { stanzaId: 'task-prompt' },
                    },
                  },
                },
                envelope('lid', '55555555@lid'),
                ...(mode === 'self-chat'
                  ? [
                      {
                        ...envelope('other-lid', '66666666@lid'),
                        key: {
                          id: 'other-lid',
                          remoteJid: '66666666@lid',
                          remoteJidAlt: jid,
                          fromMe: true,
                        },
                      },
                    ]
                  : []),
              ],
            });
            sockets[0].events.emit('messages.upsert', {
              type: 'append',
              requestId: 'history-request',
              messages: [envelope('history')],
            });
            await transport.poll!(
              async (message) => {
                collected.push(message);
              },
              undefined,
              async (reaction) => {
                reacted.push(reaction.messageId);
              },
            );
            assert.deepEqual(
              collected.map((message) => message.messageId),
              ['owner', 'image', 'quoted', 'lid'],
            );
            assert.equal(collected[2].replyToMessageId, 'task-prompt');
            assert.deepEqual(reacted, ['task-prompt']);
            assert.equal(downloads, 0);
            assert.deepEqual(
              Buffer.from(await collected[1].attachments![0].read()),
              Buffer.from('synthetic image'),
            );
            assert.equal(downloads, 1);
            oversizedDownload = true;
            await assert.rejects(collected[1].attachments![0].read(), /too large/);
            oversizedDownload = false;
            abortDownload = new AbortController();
            const late = collected[1].attachments![0].read(abortDownload.signal);
            const release = setTimeout(() => lateStream?.end(), 100);
            try {
              await assert.rejects(late);
              assert.equal(lateStream?.destroyed, true);
            } finally {
              clearTimeout(release);
              lateStream?.destroy();
              abortDownload = undefined;
            }
            sockets[0].events.emit('messages.upsert', {
              type: 'notify',
              messages: [
                {
                  ...envelope('bad-media'),
                  message: {
                    imageMessage: { mimetype: 'image/jpeg', url: 'http://127.0.0.1/private' },
                  },
                },
              ],
            });
            await transport.poll!(async (message) => {
              collected.push(message);
            });
            await assert.rejects(collected.at(-1)!.attachments![0].read(), /address/);
            assert.equal(downloads, 3);
            const contact =
              'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Synthetic Contact\r\nTEL:+34600000000\r\nEND:VCARD';
            sockets[0].events.emit('messages.upsert', {
              type: 'notify',
              messages: [
                {
                  ...envelope('sticker-message'),
                  message: {
                    stickerMessage: {
                      mimetype: 'image/webp',
                      fileLength: 15,
                      contextInfo: { stanzaId: 'task-prompt' },
                    },
                  },
                },
                {
                  ...envelope('location-message'),
                  message: {
                    locationMessage: {
                      degreesLatitude: 41.4,
                      degreesLongitude: 2.17,
                      name: 'Synthetic park',
                      address: 'Synthetic address',
                      contextInfo: { stanzaId: 'task-prompt' },
                    },
                  },
                },
                {
                  ...envelope('contact-message'),
                  message: {
                    contactsArrayMessage: {
                      contacts: [{ displayName: 'Synthetic Contact', vcard: contact }],
                      contextInfo: { stanzaId: 'task-prompt' },
                    },
                  },
                },
                {
                  ...envelope('foreign-location', '87654321@s.whatsapp.net', false),
                  message: { locationMessage: { degreesLatitude: 0, degreesLongitude: 0 } },
                },
              ],
            });
            await transport.poll!(async (message) => {
              collected.push(message);
            });
            const shared = collected.slice(-3);
            assert.deepEqual(
              shared.map((message) => message.attachments![0].source),
              ['sticker', 'location', 'contact'],
            );
            assert.ok(shared.every((message) => message.replyToMessageId === 'task-prompt'));
            assert.equal(
              JSON.parse(Buffer.from(await shared[1].attachments![0].read()).toString()).name,
              'Synthetic park',
            );
            assert.equal(
              contactCards(Buffer.from(await shared[2].attachments![0].read()).toString())[0].name,
              'Synthetic Contact',
            );
            assert.equal(downloads, 3);
            await combineMessagingTransports(transport).presence!({
              channelId: 'whatsapp',
              accountId,
              threadId: jid,
              messageId: 'owner',
              status: 'Synthetic live work',
            });
            assert.deepEqual(presence, [['composing', jid]]);
            if (mode === 'self-chat') {
              await assert.rejects(
                transport.post({
                  channelId: 'whatsapp',
                  accountId,
                  threadId: '66666666@lid',
                  text: 'Private result',
                }),
                /target is unavailable/,
              );
              assert.equal(sent.length, 0);
            }
            const result = await transport.post({
              channelId: 'whatsapp',
              accountId,
              threadId: jid,
              text: '**Task complete**',
              replyToMessageId: 'task-prompt',
              replyToText: 'Fixture task question',
              attachments: [attachment('reply.ogg', 'audio/ogg', 'synthetic voice')],
            });
            assert.equal(sent[0].content.text, '*Task complete*');
            assert.equal(sent[1].content.ptt, true);
            assert.deepEqual(
              result.ids,
              sent.map((message) => message.id),
            );
            assert.equal(
              (sent[0].quoted as { message: { conversation: string } }).message.conversation,
              'Fixture task question',
            );
            const beforeImage = sent.length;
            const imageReply = await transport.post({
              channelId: 'whatsapp',
              accountId,
              threadId: jid,
              text: '**Image result**',
              attachments: [attachment('result.png', 'image/png', 'synthetic image')],
            });
            assert.equal(sent.length, beforeImage + 1);
            assert.equal(sent.at(-1)!.content.caption, '*Image result*');
            assert.equal(sent.at(-1)!.content.text, undefined);
            assert.deepEqual(imageReply.ids, [sent.at(-1)!.id]);
            await transport.post({
              channelId: 'whatsapp',
              accountId,
              threadId: jid,
              text: '',
              attachments: [attachment('contact.vcf', 'text/vcard', contact)],
              replyToMessageId: 'task-prompt',
            });
            assert.equal(
              (sent.at(-1)!.content.contacts as { contacts: { vcard: string }[] }).contacts[0]
                .vcard,
              contact,
            );
            await transport.post({
              channelId: 'whatsapp',
              accountId,
              threadId: jid,
              text: '',
              attachments: [
                attachment(
                  'location.json',
                  'application/json',
                  JSON.stringify({ latitude: 41.4, longitude: 2.17 }),
                ),
              ],
            });
            assert.equal(
              (sent.at(-1)!.content.location as { degreesLatitude: number }).degreesLatitude,
              41.4,
            );
            await transport.post({
              channelId: 'whatsapp',
              accountId,
              threadId: jid,
              text: '',
              attachments: [
                attachment(
                  'name-only.vcf',
                  'text/vcard',
                  'BEGIN:VCARD\r\nFN:Synthetic\r\nEND:VCARD',
                ),
              ],
            });
            assert.equal(sent.at(-1)!.content.contacts, undefined);
            assert.ok(sent.at(-1)!.content.document);
            failSend = true;
            await assert.rejects(
              transport.post({
                channelId: 'whatsapp',
                accountId,
                threadId: jid,
                text: 'Uncertain fixture reply',
              }),
            );
            const uncertainId = sent.at(-1)!.id;
            failSend = false;
            await transport.close();
            await assert.rejects(
              Promise.resolve(
                sockets[0].config.auth.keys.set({ session: { fixture: Uint8Array.from([9]) } }),
              ),
            );
            transport = open();
            await transport.pairing!();
            const resumed = sockets.at(-1)!;
            assert.deepEqual(
              Buffer.from((await resumed.config.auth.keys.get('session', ['fixture'])).fixture),
              Buffer.from([1, 2, 3]),
            );
            resumed.events.emit('connection.update', { connection: 'open' });
            const beforeEcho = collected.length;
            resumed.events.emit('messages.upsert', {
              type: 'notify',
              messages: [envelope(uncertainId), envelope(result.id)],
            });
            await transport.poll!(async (message) => {
              collected.push(message);
            });
            assert.equal(collected.length, beforeEcho);
            const beforeDisconnect = sockets.length;
            resumed.events.emit('connection.update', {
              connection: 'close',
              lastDisconnect: { error: { output: { statusCode: 428 } } },
            });
            assert.equal((await transport.pairing!()).state, 'disconnected');
            assert.equal(
              await transport.cancelPairing!((await transport.pairing!()).pairingId!),
              false,
            );
            const attempts = sent.length;
            await assert.rejects(
              transport.post({
                channelId: 'whatsapp',
                accountId,
                threadId: jid,
                text: 'Wait for connection',
              }),
            );
            const deadline = Date.now() + 5000;
            while (sockets.length === beforeDisconnect && Date.now() < deadline)
              await new Promise((resolve) => setTimeout(resolve, 10));
            assert.ok(sockets.length > beforeDisconnect);
            sockets.at(-1)!.events.emit('connection.update', { connection: 'open' });
            assert.equal(sent.length, attempts);
            assert.equal((await transport.pairing!()).state, 'connected');
            failClear = true;
            failLogout = true;
            await assert.rejects(transport.unlink!(), /key deletion failure/);
            assert.equal((await transport.pairing!()).state, 'failed');
            assert.equal(transport.channels[0].available, false);
            await transport.unlink!();
            await transport.unlink!();
            assert.equal(logouts, 1);
            assert.equal(
              (
                await pool.query(
                  'SELECT count(*)::int AS n FROM channel_session_keys WHERE owner_id=$1',
                  [`fixture-${mode}`],
                )
              ).rows[0].n,
              0,
            );
            assert.equal((await transport.pairing!()).state, 'logged_out');
            assert.equal(
              await transport.cancelPairing!((await transport.pairing!()).pairingId!, true),
              true,
            );
          } finally {
            await transport.close();
          }
        });
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('Telegram media keeps native replies and checks the sender before any download', async () => {
  const bytes = Buffer.from('synthetic image bytes');
  const requests: string[] = [];
  let filePath = 'photos/fixture.jpg';
  const transport = createChatSdkTransport({} as pg.Pool, fixtureEnv, {
    fetch: async (input, init) => {
      requests.push(String(input));
      if (String(input).endsWith('/getFile')) {
        assert.ok(['fixture-image', 'preview'].includes(JSON.parse(String(init?.body)).file_id));
        return Response.json({
          ok: true,
          result: { file_path: filePath, file_size: bytes.length },
        });
      }
      assert.equal(
        String(input),
        'https://api.telegram.org/file/bot987:fixture-not-live/photos/fixture.jpg',
      );
      assert.equal(init?.redirect, 'error');
      return new Response(bytes);
    },
  });
  const receive = (message: object) =>
    transport.receive({
      channelId: 'telegram',
      method: 'POST',
      query: {},
      headers: { 'x-telegram-bot-api-secret-token': fixtureEnv.TELEGRAM_WEBHOOK_SECRET_TOKEN },
      body: Buffer.from(JSON.stringify({ update_id: 123, message })),
    });
  const message = {
    message_id: 42,
    date: Math.floor(Date.now() / 1000),
    from: { id: 123456, is_bot: false, first_name: 'Fixture' },
    chat: { id: 123456, type: 'private' },
    caption: 'Read this image',
    photo: [{ file_id: 'fixture-image', file_size: bytes.length }],
    reply_to_message: { message_id: 41 },
  };
  const result = await receive(message);
  assert.equal(result.messages?.length, 1);
  assert.equal(result.messages[0].text, 'Read this image');
  assert.equal(result.messages[0].replyToMessageId, '123456:41');
  assert.equal(requests.length, 0);
  assert.deepEqual(Buffer.from(await result.messages[0].attachments![0].read()), bytes);
  requests.length = 0;
  assert.equal(
    (
      await receive({
        ...message,
        from: { ...message.from, id: 654321 },
        chat: { ...message.chat, id: 654321 },
      })
    ).messages?.length,
    0,
  );
  assert.equal(
    (await receive({ ...message, chat: { id: -123456, type: 'group' } })).messages?.length,
    0,
  );
  assert.equal(requests.length, 0);
  filePath = '../../private-fixture';
  await assert.rejects(result.messages[0].attachments![0].read(), /unavailable/);
  assert.equal(requests.length, 1);
  requests.length = 0;
  const oversized = await receive({
    ...message,
    photo: [{ file_id: 'fixture-image', file_size: 21 * 1024 * 1024 }],
  });
  await assert.rejects(oversized.messages![0].attachments![0].read(), /too large/);
  const media = createChannelMedia({
    artifacts: {
      storeArtifact: async () => {
        throw new Error('No oversized file can be stored.');
      },
    },
    speech: {
      transcribe: async () => {
        throw new Error('No oversized file can be transcribed.');
      },
    },
  });
  await assert.rejects(
    media.prepare(oversized.messages![0].attachments!, new AbortController().signal),
    (error: unknown) =>
      error instanceof ChannelMediaFailure &&
      error.reason === 'too_large' &&
      error.fileLimitMb === 20,
  );
  assert.equal(requests.length, 0);
  const voice = await receive({
    ...message,
    photo: undefined,
    caption: undefined,
    voice: { file_id: 'fixture-voice', file_size: 12 },
  });
  assert.equal(voice.messages![0].attachments![0].voice, true);
  assert.equal(voice.messages![0].text, '');
  for (const [payload, source] of [
    [{ location: { latitude: 41.4, longitude: 2.17 } }, 'location'],
    [
      {
        venue: {
          location: { latitude: 41.4, longitude: 2.17 },
          title: 'Synthetic park',
          address: 'Synthetic address',
        },
      },
      'location',
    ],
    [
      { contact: { first_name: 'Synthetic', last_name: 'Contact', phone_number: '+34600000000' } },
      'contact',
    ],
    [
      {
        sticker: { file_id: 'fixture-sticker', file_size: 12, is_animated: false, is_video: false },
      },
      'sticker',
    ],
  ] as const) {
    const shared = await receive({ ...message, photo: undefined, caption: undefined, ...payload });
    assert.equal(shared.messages![0].attachments![0].source, source);
    assert.equal(shared.messages![0].replyToMessageId, '123456:41');
    if (source !== 'sticker') {
      const content = Buffer.from(await shared.messages![0].attachments![0].read()).toString(
        'utf8',
      );
      if (source === 'location') assert.equal(JSON.parse(content).latitude, 41.4);
      else assert.equal(contactCards(content)[0].phones[0], '+34600000000');
    }
    assert.equal(
      (
        await receive({
          ...message,
          photo: undefined,
          ...payload,
          from: { ...message.from, id: 654321 },
          chat: { ...message.chat, id: 654321 },
        })
      ).messages?.length,
      0,
    );
  }
  const animated = await receive({
    ...message,
    photo: undefined,
    sticker: {
      file_id: 'animation',
      file_size: 12,
      is_animated: true,
      thumbnail: { file_id: 'preview', file_size: 12 },
    },
  });
  assert.deepEqual(
    animated.messages![0].attachments!.map((file) => [file.mimeType, file.source]),
    [
      ['application/x-tgsticker', 'sticker'],
      ['image/jpeg', 'sticker-preview'],
    ],
  );
  filePath = 'photos/fixture.jpg';
  assert.deepEqual(Buffer.from(await animated.messages![0].attachments![1].read()), bytes);
  requests.length = 0;
  assert.equal(
    (await receive({ ...message, photo: undefined, location: { latitude: 91, longitude: 2.17 } }))
      .messages?.length,
    0,
  );
  assert.equal(requests.length, 0);
});

test('speech uses a bounded transcription request and generates Ogg voice output without exposing credentials', async () => {
  const bytes = Buffer.from('synthetic voice bytes');
  const usage: import('../src/ports/provider-usage.ts').ProviderUsageEvent[] = [];
  let key: string | undefined;
  const provider = createOpenAISpeechProvider({
    apiKey: async () => key,
    configured: () => Boolean(key),
    fetch: async (input, init) => {
      assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`);
      if (String(input).endsWith('/transcriptions')) {
        assert.ok(init?.body instanceof FormData);
        assert.equal(init.body.get('model'), 'gpt-transcribe');
        assert.equal(init.body.get('response_format'), 'json');
        const file = init.body.get('file');
        assert.ok(file instanceof File);
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
        return Response.json({
          text: 'Read the attached image.',
          usage: { type: 'duration', seconds: 60 },
        });
      }
      assert.equal(JSON.parse(String(init?.body)).response_format, 'opus');
      return new Response(bytes);
    },
  });
  const speech = createSpeech({
    ...provider,
    get configured() {
      return provider.configured;
    },
    transcribe: (audio, signal) =>
      provider.transcribe!(audio, signal, (event) => usage.push(event)),
    synthesize: (text, signal) => provider.synthesize(text, signal, (event) => usage.push(event)),
  });
  await assert.rejects(speech.transcribe({ bytes, mimeType: 'audio/ogg', name: 'voice.ogg' }));
  key = 'fixture-never-live';
  assert.equal(
    await speech.transcribe({ bytes, mimeType: 'audio/ogg', name: 'voice.ogg' }),
    'Read the attached image.',
  );
  assert.deepEqual(await speech.synthesize('Fixture reply'), {
    bytes,
    mimeType: 'audio/ogg',
    fileName: 'reply.ogg',
  });
  await assert.rejects(
    speech.transcribe({ bytes: Buffer.alloc(1), mimeType: 'text/plain', name: 'voice.txt' }),
  );
  assert.equal(usage.length, 2);
  assert.notEqual(usage[0].id, usage[1].id);
  assert.equal(usage[0].costUsd, 0.0045);
  assert.equal(usage[1].costUsd, null);
  assert.doesNotMatch(
    JSON.stringify(usage),
    /fixture-never-live|Read the attached image|synthetic voice bytes/,
  );
  key = 'fixture-rotated';
  await speech.synthesize('Synthetic changed key');
  key = undefined;
  await assert.rejects(speech.synthesize('Synthetic removed key'));
  let cancelled = 0;
  const failed = createOpenAISpeechProvider({
    apiKey: 'fixture-never-live',
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        { status: 503 },
      ),
  });
  await assert.rejects(failed.transcribe!({ bytes, mimeType: 'audio/ogg', name: 'voice.ogg' }));
  await assert.rejects(failed.synthesize('Synthetic provider error'));
  assert.equal(cancelled, 2);
});

test('OpenRouter transcribes with its own current key, bounds responses, and reports cost without content', async () => {
  const audio = { bytes: Buffer.from('Synthetic voice'), mimeType: 'audio/ogg', name: 'voice.ogg' };
  let key: string | undefined;
  let calls = 0;
  let failure: 'status' | 'size' | 'abort' | undefined;
  let cancelled = 0;
  const usage: import('../src/ports/provider-usage.ts').ProviderUsageEvent[] = [];
  const controller = new AbortController();
  const provider = createOpenRouterTranscriptionProvider({
    apiKey: async () => key,
    configured: () => Boolean(key),
    model: 'qwen/qwen3-asr-1.7b',
    fetch: async (url, init) => {
      calls++;
      assert.equal(String(url), 'https://openrouter.ai/api/v1/audio/transcriptions');
      assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`);
      assert.ok(init?.body instanceof FormData);
      assert.equal(init.body.get('model'), 'qwen/qwen3-asr-1.7b');
      assert.equal(init.body.get('response_format'), 'json');
      const file = init.body.get('file');
      assert.ok(file instanceof File);
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), audio.bytes);
      if (failure === 'abort') {
        controller.abort();
        init.signal!.throwIfAborted();
      }
      if (failure)
        return new Response(
          new ReadableStream({
            start(stream) {
              if (failure === 'size') stream.enqueue(Buffer.alloc(1024 * 1024 + 1));
            },
            cancel() {
              cancelled++;
            },
          }),
          { status: failure === 'status' ? 503 : 200 },
        );
      return Response.json({
        text: 'Synthetic transcript.',
        usage: { cost: 0.001, input_tokens: 30, output_tokens: 5 },
      });
    },
  });
  const service = createSpeech({
    id: 'fixture',
    configured: false,
    get transcriptionConfigured() {
      return provider.configured;
    },
    transcribe: (audio, signal) => provider.transcribe(audio, signal, (event) => usage.push(event)),
    synthesize: async () => {
      throw new Error('No speech output in this fixture.');
    },
  });
  await assert.rejects(service.transcribe(audio));
  assert.equal(calls, 0);
  key = 'fixture-openrouter-first';
  assert.equal(await service.transcribe(audio), 'Synthetic transcript.');
  await assert.rejects(service.synthesize('Synthetic reply'));
  assert.equal(calls, 1);
  assert.equal(usage[0].provider, 'openrouter');
  assert.equal(usage[0].model, 'qwen/qwen3-asr-1.7b');
  assert.equal(usage[0].costUsd, 0.001);
  assert.equal(usage[0].pricing, 'reported');
  assert.equal(usage[0].inputTokens, 30);
  assert.equal(usage[0].outputTokens, 5);
  key = 'fixture-openrouter-rotated';
  await service.transcribe(audio);
  key = undefined;
  await assert.rejects(service.transcribe(audio));
  assert.equal(calls, 2);
  key = 'fixture-openrouter-rotated';
  for (failure of ['status', 'size', 'abort'] as const)
    await assert.rejects(service.transcribe(audio, controller.signal));
  assert.equal(calls, 5);
  assert.equal(cancelled, 2);
  assert.deepEqual(
    usage.map((event) => event.status),
    ['succeeded', 'succeeded', 'failed', 'failed', 'cancelled'],
  );
  assert.doesNotMatch(
    JSON.stringify(usage),
    /fixture-openrouter|Synthetic voice|Synthetic transcript/,
  );
});

test(
  'channel media joins concurrent duplicates, persists owned files, rejects other senders, and does not replay after restart',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_channel_receive_media_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const root = await mkdtemp(join(tmpdir(), 'nod-channel-media-'));
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    });
    const owner = 'fixture-owner';
    const threadId = await createFixtureTables(pool, owner);
    await pool.query(
      'CREATE TABLE artifacts(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid,name text,mime_type text,size int,storage_path text)',
    );
    const artifacts = createArtifactService({ database: pool, ownerId: owner, localRoot: root });
    let reads = 0;
    let message: InboundMessage;
    const submissions: { text: string; attachments: Artifact[] }[] = [];
    const privateCodes: string[] = [];
    const presentations: { kind: string; reason?: string }[] = [];
    let voiceFailure: Error | undefined;
    let modelConfigured = true;
    let verificationPending = false;
    let speechConfigured = true;
    let transcript = '483729';
    const speech = createSpeech({
      id: 'fixture',
      get configured() {
        return speechConfigured;
      },
      synthesize: async () => {
        throw new Error('Not used by the fixture.');
      },
      transcribe: async () => {
        if (voiceFailure) throw voiceFailure;
        return transcript;
      },
    });
    const transport = (): MessagingTransport => ({
      channels: [
        {
          id: 'telegram',
          status: 'configured',
          accountId: 'fixture-account',
          allowedSenderIds: ['fixture-sender'],
          missing: [],
        },
      ],
      receive: async (input) => ({
        status: 200,
        body: 'ok',
        messages: [{ ...message, ...JSON.parse(Buffer.from(input.body).toString()) }],
      }),
      post: async () => ({ id: 'fixture-reply' }),
      close: async () => {},
    });
    const open = async () => {
      const app = Fastify();
      const channels = await createChannels(pool, {
        ownerId: owner,
        transport: transport(),
        intervalMs: 600_000,
        subscribe: () => () => {},
        media: createChannelMedia({ artifacts, speech }),
        modelConfigured: () => modelConfigured,
        verificationPending: async () => verificationPending,
        activeThread: async () => ({ id: threadId }),
        present: async (_thread, presentation) => {
          presentations.push(presentation);
          return 'Fixture media notice';
        },
        answer: async () => {
          throw new Error('A file must not approve an action.');
        },
        acceptVerification: async (text) => {
          privateCodes.push(text);
          return { messageText: 'Code entered privately.' };
        },
        submit: async (text, sourceId, client, channel, _messageId, answer, _reply, files) => {
          assert.equal(answer, undefined);
          submissions.push({ text, attachments: files ?? [] });
          return fixtureTurn(client, threadId, owner, channel, sourceId);
        },
      });
      channels.registerRoutes(app);
      return { app, channels };
    };
    let fixture = await open();
    t.after(() => fixture.app.close());
    const send = () =>
      fixture.app.inject({ method: 'POST', url: '/api/webhooks/telegram', payload: {} });
    const file = {
      ...attachment('image.png', 'image/png', 'fixture image'),
      read: async () => {
        reads++;
        return Buffer.from('fixture image');
      },
    };
    message = {
      channelId: 'telegram',
      accountId: 'fixture-account',
      senderId: 'intruder',
      messageId: 'foreign',
      threadId: 'fixture-chat',
      text: '',
      attachments: [file],
      sentAt: new Date(),
    };
    await Promise.all(Array.from({ length: 32 }, send));
    assert.equal(reads, 0);
    message = {
      ...message,
      senderId: 'fixture-sender',
      messageId: 'owned-image',
      text: 'Inspect this image',
    };
    const concurrent = await Promise.all(Array.from({ length: 64 }, send));
    assert.ok(concurrent.every((response) => response.statusCode === 200));
    await fixture.channels.drain();
    assert.equal(reads, 1);
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].text, 'Inspect this image');
    assert.equal(submissions[0].attachments.length, 1);
    assert.deepEqual(
      await artifacts.readArtifact(submissions[0].attachments[0].id),
      Buffer.from('fixture image'),
    );
    await fixture.app.close();
    fixture = await open();
    await Promise.all(Array.from({ length: 32 }, send));
    await fixture.channels.drain();
    assert.equal(reads, 1);
    assert.equal(submissions.length, 1);
    message = {
      ...message,
      messageId: 'private-voice',
      text: '',
      attachments: [{ ...file, name: 'voice.ogg', mimeType: 'audio/ogg', voice: true }],
    };
    await send();
    await fixture.channels.drain();
    assert.deepEqual(privateCodes, ['483729']);
    assert.equal(submissions.length, 1);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS count FROM artifacts')).rows[0].count,
      1,
    );
    const receipt = (
      await pool.query('SELECT text,attachments FROM channel_inbox WHERE source_id=$1', [
        'channel:telegram:fixture-account:private-voice',
      ])
    ).rows[0];
    assert.equal(receipt.text, 'Code entered privately.');
    assert.deepEqual(receipt.attachments, []);
    assert.equal(
      JSON.stringify((await pool.query('SELECT text FROM channel_inbox')).rows).includes('483729'),
      false,
    );
    const sendId = (messageId: string) =>
      fixture.app.inject({
        method: 'POST',
        url: '/api/webhooks/telegram',
        payload: { messageId },
      });
    voiceFailure = new Error(spendingLimitReached);
    await sendId('limited-voice');
    await fixture.channels.drain();
    assert.ok(
      presentations.some(
        (item) => item.kind === 'media_failure' && item.reason === 'spending_limit',
      ),
    );
    voiceFailure = undefined;
    transcript = 'x'.repeat(100_001);
    await sendId('long-transcript');
    await fixture.channels.drain();
    assert.ok(
      presentations.some(
        (item) => item.kind === 'media_failure' && item.reason === 'text_too_long',
      ),
    );
    const originalAttachments = message.attachments;
    message = { ...message, attachments: [attachment('empty.png', 'image/png', '')] };
    await sendId('empty-image');
    await fixture.channels.drain();
    assert.equal(presentations.at(-1)?.reason, 'unavailable');
    message = { ...message, attachments: originalAttachments };
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let active = 0;
    let peak = 0;
    message = {
      ...message,
      text: 'Inspect this image',
      attachments: [
        {
          ...file,
          read: async () => {
            reads++;
            active++;
            peak = Math.max(peak, active);
            if (active === 4) entered();
            await held;
            active--;
            return Buffer.from('fixture image');
          },
        },
      ],
    };
    const load = Array.from({ length: 4 }, (_, index) => sendId(`load-${index}`));
    try {
      await started;
      assert.equal((await sendId('overflow')).statusCode, 503);
      assert.equal(peak, 4);
    } finally {
      release();
    }
    assert.ok((await Promise.all(load)).every((response) => response.statusCode === 200));
    await fixture.channels.drain();
    assert.equal(submissions.length, 5);
    assert.equal((await sendId('overflow')).statusCode, 200);
    await fixture.channels.drain();
    assert.equal(submissions.length, 6);
    await pool.query(
      "ALTER TABLE channel_inbox ADD CONSTRAINT reject_media_receipt CHECK(source_id NOT LIKE '%rollback-file')",
    );
    assert.equal((await sendId('rollback-file')).statusCode, 503);
    const stored = (
      await pool.query('SELECT count(*)::int AS count FROM artifacts WHERE owner_id=$1', [owner])
    ).rows[0].count;
    assert.equal((await readdir(join(root, 'artifacts'))).length, stored);
    message = {
      ...message,
      messageId: 'sticker-message',
      text: '',
      attachments: [
        { ...attachment('sticker.webp', 'image/webp', 'synthetic sticker'), source: 'sticker' },
      ],
    };
    await send();
    await fixture.channels.drain();
    assert.equal(submissions.at(-1)!.text, '');
    assert.equal(submissions.at(-1)!.attachments[0].source, 'sticker');
    message = { ...message, messageId: 'photo-without-caption', attachments: [file] };
    await send();
    await fixture.channels.drain();
    assert.equal(submissions.at(-1)!.text, '');
    assert.equal(submissions.at(-1)!.attachments[0].mimeType, 'image/png');
    assert.deepEqual(
      await artifacts.readArtifact(submissions.at(-1)!.attachments[0].id),
      Buffer.from('fixture image'),
    );
    const cards = Array.from(
      { length: 17 },
      (_, index) =>
        `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Synthetic Contact ${index}\r\nTEL:+34600000000\r\nNOTE:${index ? 'Synthetic note' : 'x'.repeat(300_000)}\r\nEND:VCARD`,
    );
    message = { ...message, messageId: 'shared-contacts', attachments: contactAttachment(cards) };
    await send();
    await fixture.channels.drain();
    const contacts = submissions.at(-1)!.attachments[0];
    assert.equal(contacts.source, 'contact');
    const savedCards = (await artifacts.readArtifact(contacts.id)).toString('utf8');
    assert.equal(savedCards, cards.join('\r\n'));
    assert.equal(contactCards(savedCards).length, 17);
    assert.equal(contactAttachment(['', '  ']).length, 0);
    assert.equal(
      contactCards('BEGIN:VCARD\r\nN:Doe;John;Quincy;Dr.;Jr.\r\nTEL:+34600000000\r\nEND:VCARD')[0]
        .name,
      'Dr. John Quincy Doe Jr.',
    );
    const beforeVoice = reads;
    const beforeSubmissions = submissions.length;
    message = {
      ...message,
      messageId: 'voice-without-model',
      attachments: [{ ...file, name: 'voice.ogg', mimeType: 'audio/ogg', voice: true }],
    };
    modelConfigured = false;
    await send();
    await send();
    await fixture.channels.drain();
    assert.equal(reads, beforeVoice);
    assert.equal(submissions.length, beforeSubmissions);
    const notices = (
      await pool.query(
        "SELECT text FROM messages WHERE role='assistant' AND text LIKE 'Connect a model service%'",
      )
    ).rows;
    assert.equal(notices.length, 1);
    verificationPending = true;
    speechConfigured = false;
    const beforeNotice = presentations.length;
    await sendId('voice-no-model-no-speech');
    await fixture.channels.drain();
    assert.equal(presentations.length, beforeNotice);
    speechConfigured = true;
    transcript = 'Synthetic ordinary voice request';
    const beforeOrdinary = submissions.length;
    await sendId('ordinary-voice-without-model');
    await fixture.channels.drain();
    assert.equal(submissions.length, beforeOrdinary);
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM channel_inbox WHERE text LIKE '%Synthetic ordinary voice request%'",
        )
      ).rowCount,
      0,
    );
    transcript = '483729';
    const codeCount = privateCodes.length;
    const artifactCount = (await pool.query('SELECT count(*)::int AS count FROM artifacts')).rows[0]
      .count;
    await sendId('voice-code-without-model');
    await fixture.channels.drain();
    assert.equal(privateCodes.length, codeCount + 1);
    assert.equal(privateCodes.at(-1), transcript);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS count FROM artifacts')).rows[0].count,
      artifactCount,
    );
    assert.equal(
      (await pool.query("SELECT 1 FROM channel_inbox WHERE text LIKE '%483729%'")).rowCount,
      0,
    );
    verificationPending = false;
    modelConfigured = true;
    speechConfigured = false;
    await sendId('voice-without-speech');
    await fixture.channels.drain();
    assert.equal(presentations.at(-1)?.reason, 'speech_setup_required');
  },
);

async function createFixtureTables(pool: pg.Pool, owner: string) {
  await pool.query(`${locksTable};
    CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,status text NOT NULL DEFAULT 'idle',created_at timestamptz NOT NULL DEFAULT now(),archived_at timestamptz);
    CREATE TABLE turns(id uuid PRIMARY KEY,parent_turn_id uuid,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),source text NOT NULL DEFAULT 'user',source_id text UNIQUE,channel text NOT NULL DEFAULT 'web',channel_source_id text,status text NOT NULL DEFAULT 'queued',waiting_reason text,background boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,finished_at timestamptz,session_id uuid GENERATED ALWAYS AS (CASE WHEN background THEN id ELSE thread_id END) STORED);
    CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text NOT NULL,role text NOT NULL,text text NOT NULL,thread_id uuid REFERENCES threads(id),turn_id uuid REFERENCES turns(id),attachments jsonb NOT NULL DEFAULT '[]',reply_to_message_id uuid,delivered_channel text,assistant_reaction text,assistant_reacted_at timestamptz,created_at timestamptz NOT NULL DEFAULT now())`);
  const threadId = randomUUID();
  await pool.query('INSERT INTO threads(id,owner_id) VALUES($1,$2)', [threadId, owner]);
  return threadId;
}

async function fixtureTurn(
  client: Pick<pg.PoolClient, 'query'>,
  threadId: string,
  owner: string,
  channel: string,
  sourceId: string | null = null,
  status = 'queued',
) {
  const result = await client.query(
    'INSERT INTO turns(id,owner_id,thread_id,source_id,channel,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
    [randomUUID(), owner, threadId, sourceId, channel, status],
  );
  return result.rows[0].id as string;
}

test(
  'channel verification stays private before inbox persistence and fences duplicate delivery across restart',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const schema = `test_channel_codes_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const threadId = await createFixtureTables(pool, 'local-development');
    const turnId = await fixtureTurn(pool, threadId, 'local-development', 'web');
    const accepted: Array<{ clientMessageId: string; channel: string }> = [];
    const submitted: string[] = [];
    const sent: Array<{ channelId: string; accountId: string; threadId: string; text: string }> =
      [];
    let injections = 0;
    let modelReady = true;
    let voiceHold: Promise<void> | undefined;
    let voiceStarted: (() => void) | undefined;
    let verification: Awaited<ReturnType<typeof createChatVerification>> | undefined;
    let beginHeld!: () => void;
    let releaseHeld!: () => void;
    const heldStarted = new Promise<void>((resolve) => {
      beginHeld = resolve;
    });
    const heldReleased = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    function transport(accountId = 'fixture-account'): MessagingTransport {
      return {
        channels: ['telegram', 'whatsapp'].map((id) => ({
          id,
          status: 'configured',
          missing: [],
          accountId,
          allowedSenderIds: ['fixture-owner'],
        })),
        receive: async (request) => {
          const input = JSON.parse(Buffer.from(request.body).toString('utf8'));
          return {
            status: 200,
            body: 'accepted',
            messages: [
              {
                channelId: request.channelId,
                accountId: 'fixture-account',
                senderId: 'fixture-owner',
                threadId: 'fixture-thread',
                ...input,
                ...(input.voice
                  ? {
                      attachments: [
                        { ...attachment('voice.ogg', 'audio/ogg', 'synthetic voice'), voice: true },
                      ],
                    }
                  : {}),
                sentAt: new Date(),
              },
            ],
          };
        },
        post: async (message) => {
          sent.push(message);
          return { id: `fixture-reply-${sent.length}` };
        },
        close: async () => {},
      };
    }
    async function open() {
      const app = Fastify();
      const channels = await createChannels(pool, {
        ownerId: 'local-development',
        transport: transport(),
        modelConfigured: () => modelReady,
        verificationPending: async (channel) =>
          Boolean((await verification?.pending(channel))?.length),
        media: createChannelMedia({
          artifacts: {
            storeArtifact: async () => {
              throw new Error('Private voice must not be stored.');
            },
          },
          speech: {
            transcribe: async () => {
              voiceStarted?.();
              await voiceHold;
              return '481927';
            },
          },
        }),
        present: async (thread) => {
          assert.equal(modelReady, true);
          assert.equal(thread, threadId);
          return 'Usa o pedido de verificação na conversa correspondente.';
        },
        intervalMs: 600000,
        subscribe: () => () => {},
        acceptVerification: async (text, input) => {
          if (verification) return verification.accept(text, input);
          accepted.push(input);
          if (text === '111111')
            throw Object.assign(new Error('Ambiguous fixture code 111111.'), { statusCode: 409 });
          if (text === '222222') throw new Error('Provider failed with code 222222.');
          if (text !== '483729' && text !== '123456') {
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              await input.persistOrdinary(client);
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            } finally {
              client.release();
            }
            return;
          }
          if (text === '123456') {
            beginHeld();
            await heldReleased;
          }
          const stored = await pool.query(
            "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id) VALUES($1,'local-development','user','Verification code sent securely.',$2,$3) ON CONFLICT(id) DO NOTHING",
            [input.clientMessageId, threadId, turnId],
          );
          if (stored.rowCount) injections++;
          return { turnId, messageText: 'Verification code sent securely.' };
        },
        submit: async (text, sourceId, client, channel) => {
          submitted.push(text);
          return fixtureTurn(client, threadId, 'local-development', channel, sourceId);
        },
      });
      channels.registerRoutes(app);
      return { app, channels };
    }
    let fixture = await open();
    const send = (messageId: string, text: string, provider = 'telegram', extra = {}) =>
      fixture.app.inject({
        method: 'POST',
        url: `/api/webhooks/${provider}`,
        headers: { 'content-type': 'application/json' },
        payload: { messageId, text, ...extra },
      });
    try {
      await send('foreign', '483729', 'telegram', { senderId: 'someone-else' });
      await send('foreign-account', '483729', 'telegram', { accountId: 'another-account' });
      assert.equal(accepted.length, 0);
      assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 0);

      await pool.query(
        "ALTER TABLE channel_inbox ADD CONSTRAINT fixture_insert_failure CHECK(provider <> 'telegram')",
      );
      const interrupted = await send('private-code', '483729');
      assert.equal(interrupted.statusCode, 503);
      assert.doesNotMatch(interrupted.body, /483729/);
      assert.equal(injections, 1);
      assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 0);
      await fixture.app.close();
      await pool.query('ALTER TABLE channel_inbox DROP CONSTRAINT fixture_insert_failure');
      fixture = await open();
      const retried = await Promise.all([
        send('private-code', '483729'),
        send('private-code', '483729'),
      ]);
      assert.ok(retried.every((response) => response.statusCode === 200));
      await fixture.channels.drain();
      assert.equal(injections, 1);
      assert.equal(new Set(accepted.map((input) => input.clientMessageId)).size, 1);
      const row = (await pool.query('SELECT * FROM channel_inbox')).rows[0];
      assert.equal(row.text, 'Verification code sent securely.');
      assert.equal(row.state, 'submitted');
      assert.equal(row.turn_id, turnId);
      assert.equal(row.message_id, accepted[0].clientMessageId);
      assert.match(accepted[0].channel, /^telegram:[a-f0-9]{32}$/);
      assert.deepEqual(submitted, []);
      const calls = accepted.length;
      await send('private-code', 'changed duplicate body');
      assert.equal(accepted.length, calls);

      assert.equal((await send('private-code', '483729', 'whatsapp')).statusCode, 200);
      assert.match(accepted.at(-1)!.channel, /^whatsapp:[a-f0-9]{32}$/);
      assert.notEqual(accepted.at(-1)!.clientMessageId, accepted[0].clientMessageId);
      assert.equal(injections, 2);

      const ambiguous = await send('ambiguous-code', '111111');
      assert.equal(ambiguous.statusCode, 200);
      assert.doesNotMatch(ambiguous.body, /111111|Ambiguous fixture/);
      await fixture.channels.drain();
      assert.equal(sent.length, 1);
      assert.deepEqual(
        { channelId: sent[0].channelId, accountId: sent[0].accountId, threadId: sent[0].threadId },
        { channelId: 'telegram', accountId: 'fixture-account', threadId: 'fixture-thread' },
      );
      const guidance = (
        await pool.query(
          "SELECT i.text,i.state,i.turn_id,m.role,m.turn_id AS reply_turn_id FROM channel_inbox i JOIN channel_outbox o USING(source_id) JOIN messages m ON m.id=o.message_id WHERE i.source_id='channel:telegram:fixture-account:ambiguous-code'",
        )
      ).rows[0];
      assert.deepEqual(guidance, {
        text: '',
        state: 'discarded',
        turn_id: null,
        role: 'assistant',
        reply_turn_id: null,
      });
      await fixture.app.close();
      fixture = await open();
      const acceptedBeforeDuplicate = accepted.length;
      await Promise.all([
        send('ambiguous-code', '111111'),
        send('ambiguous-code', 'changed duplicate body'),
      ]);
      await fixture.channels.drain();
      assert.equal(accepted.length, acceptedBeforeDuplicate);
      assert.equal(sent.length, 1);
      const unavailable = await send('unavailable-code', '222222');
      assert.equal(unavailable.statusCode, 503);
      assert.doesNotMatch(unavailable.body, /222222|Provider failed/);
      await fixture.channels.drain();
      const privateRows = (await pool.query('SELECT text FROM channel_inbox')).rows;
      assert.equal(privateRows.length, 3);
      assert.doesNotMatch(JSON.stringify(privateRows), /483729|111111|222222/);
      assert.deepEqual(submitted, []);

      assert.equal((await send('ordinary-number', '2026')).statusCode, 200);
      await fixture.channels.drain();
      assert.deepEqual(submitted, ['2026']);
      assert.equal(
        (
          await pool.query(
            "SELECT text FROM channel_inbox WHERE source_id='channel:telegram:fixture-account:ordinary-number'",
          )
        ).rows[0].text,
        '2026',
      );

      const keyStore = {
        id: 'fixture',
        configured: true,
        getKey: async () => Buffer.alloc(32, 71),
      };
      let vaultInjections = 0;
      const vault = await createVault(pool, {
        requestKey: Buffer.alloc(32, 42),
        keyStore,
        page: async () => ({ url: 'https://1.1.1.1/login', origin: 'https://1.1.1.1' }),
        inject: async (input) => {
          assert.equal(input.code, '481927');
          vaultInjections++;
        },
        resume: async () => {},
        retry: async () => {},
      });
      verification = await createChatVerification(pool, {
        ownerId: 'local-development',
        keyStore,
        submitCode: vault.submitChatCode,
        refresh() {},
      });
      const codeTurnId = await fixtureTurn(
        pool,
        threadId,
        'local-development',
        accepted[0].channel,
        null,
        'running',
      );
      await pool.query('UPDATE turns SET started_at=now() WHERE id=$1', [codeTurnId]);
      await vault.request({ threadId, turnId: codeTurnId }, 'local-development', {
        origin: 'https://1.1.1.1',
        label: 'Fixture sign-in',
        kind: 'otp',
        passwordSelector: '#code',
      });
      await send('early-code', 'The code is 481 927');
      await fixture.channels.drain();
      assert.equal(vaultInjections, 0);
      await pool.query(
        "UPDATE turns SET status='waiting',waiting_reason='credentials',finished_at=now() WHERE id=$1",
        [codeTurnId],
      );
      modelReady = false;
      assert.equal((await send('vault-code', '', 'telegram', { voice: true })).statusCode, 200);
      modelReady = true;
      await fixture.channels.drain();
      assert.equal(vaultInjections, 1);
      assert.deepEqual(submitted, ['2026']);
      const oldQuestion = randomUUID();
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id) VALUES($1,'local-development','assistant','Synthetic code question',$2,$3)",
        [oldQuestion, threadId, codeTurnId],
      );
      await pool.query(
        "INSERT INTO channel_outbox(message_id,source_id,state,provider_message_id,provider_message_ids) VALUES($1,'channel:telegram:fixture-account:private-code','sent','native-old-question',ARRAY['native-old-question'])",
        [oldQuestion],
      );
      const nextCodeTurn = await fixtureTurn(
        pool,
        threadId,
        'local-development',
        accepted[0].channel,
        null,
        'running',
      );
      await pool.query('UPDATE turns SET background=true,started_at=now() WHERE id=$1', [
        nextCodeTurn,
      ]);
      await vault.request({ threadId, turnId: nextCodeTurn }, 'local-development', {
        origin: 'https://1.1.1.1',
        label: 'Other synthetic sign-in',
        kind: 'otp',
        passwordSelector: '#code',
      });
      await pool.query(
        "UPDATE turns SET status='waiting',waiting_reason='credentials',finished_at=now() WHERE id=$1",
        [nextCodeTurn],
      );
      for (const target of ['native-old-question', 'unknown-native-question']) {
        await send(`reply-${target}`, '481927', 'telegram', { replyToMessageId: target });
        await fixture.channels.drain();
        assert.equal(vaultInjections, 1);
      }
      const nextQuestion = randomUUID();
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id) VALUES($1,'local-development','assistant','Other synthetic code question',$2,$3)",
        [nextQuestion, threadId, nextCodeTurn],
      );
      await pool.query(
        "INSERT INTO channel_outbox(message_id,source_id,state,provider_message_id,provider_message_ids) VALUES($1,'channel:telegram:fixture-account:private-code','sent','native-current-question',ARRAY['native-current-question'])",
        [nextQuestion],
      );
      await verification.bindQuestion(nextCodeTurn, nextQuestion);
      await send('reply-current-code', '481927', 'telegram', {
        replyToMessageId: 'native-current-question',
      });
      await fixture.channels.drain();
      assert.equal(vaultInjections, 2);
      await pool.query(
        "UPDATE turns SET status='running',waiting_reason=NULL,finished_at=NULL WHERE id=$1",
        [nextCodeTurn],
      );
      await vault.request({ threadId, turnId: nextCodeTurn }, 'local-development', {
        origin: 'https://1.1.1.1',
        label: 'Next step in the same sign-in',
        kind: 'otp',
        passwordSelector: '#code',
      });
      await pool.query(
        "UPDATE turns SET status='waiting',waiting_reason='credentials',finished_at=now() WHERE id=$1",
        [nextCodeTurn],
      );
      await send('reply-closed-same-turn', '481927', 'telegram', {
        replyToMessageId: 'native-current-question',
      });
      await fixture.channels.drain();
      assert.equal(vaultInjections, 2);
      const finalQuestion = randomUUID();
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id) VALUES($1,'local-development','assistant','Next synthetic code question',$2,$3)",
        [finalQuestion, threadId, nextCodeTurn],
      );
      await pool.query(
        "INSERT INTO channel_outbox(message_id,source_id,state,provider_message_id,provider_message_ids) VALUES($1,'channel:telegram:fixture-account:private-code','sent','native-next-question',ARRAY['native-next-question'])",
        [finalQuestion],
      );
      await verification.bindQuestion(nextCodeTurn, finalQuestion);
      await send('reply-next-code', '481927', 'telegram', {
        replyToMessageId: 'native-next-question',
      });
      await fixture.channels.drain();
      assert.equal(vaultInjections, 3);
      assert.doesNotMatch(
        JSON.stringify(
          (await pool.query('SELECT text FROM channel_inbox UNION ALL SELECT text FROM messages'))
            .rows,
        ),
        /481927/,
      );
      await pool.query(
        "UPDATE turns SET status='running',waiting_reason=NULL,finished_at=NULL WHERE id=$1",
        [nextCodeTurn],
      );
      await vault.request({ threadId, turnId: nextCodeTurn }, 'local-development', {
        origin: 'https://1.1.1.1',
        label: 'Synthetic held voice',
        kind: 'otp',
        passwordSelector: '#code',
      });
      await pool.query(
        "UPDATE turns SET status='waiting',waiting_reason='credentials',finished_at=now() WHERE id=$1",
        [nextCodeTurn],
      );
      modelReady = false;
      assert.equal(
        (
          await send('unknown-native-voice', '', 'telegram', {
            voice: true,
            replyToMessageId: 'unknown-native-question',
          })
        ).statusCode,
        200,
      );
      await fixture.channels.drain();
      assert.equal(
        (
          await pool.query(
            "SELECT o.state FROM channel_outbox o JOIN channel_inbox i USING(source_id) WHERE i.source_id LIKE '%:unknown-native-voice'",
          )
        ).rows[0].state,
        'sent',
      );
      let releaseVoice!: () => void;
      const beganVoice = new Promise<void>((resolve) => {
        voiceStarted = resolve;
      });
      voiceHold = new Promise<void>((resolve) => {
        releaseVoice = resolve;
      });
      const voice = send('closed-during-voice', '', 'telegram', { voice: true });
      await beganVoice;
      await pool.query(
        "UPDATE credential_requests SET status='submitted' WHERE turn_id=$1 AND status='pending'",
        [nextCodeTurn],
      );
      modelReady = true;
      releaseVoice();
      assert.equal((await voice).statusCode, 200);
      await fixture.channels.drain();
      assert.equal(vaultInjections, 3);
      assert.deepEqual(submitted, ['2026']);
      assert.deepEqual(
        (
          await pool.query(
            "SELECT state,text FROM channel_inbox WHERE source_id LIKE '%:closed-during-voice'",
          )
        ).rows,
        [{ state: 'discarded', text: '' }],
      );
      assert.doesNotMatch(
        JSON.stringify(
          (await pool.query('SELECT text FROM channel_inbox UNION ALL SELECT text FROM messages'))
            .rows,
        ),
        /481927/,
      );
      verification = undefined;

      const held = send('revoked-code', '123456');
      await Promise.race([
        heldStarted,
        held.then(() => {
          throw new Error('Expected pending verification.');
        }),
      ]);
      await fixture.channels.replaceTransport(transport('new-account'));
      releaseHeld();
      assert.equal((await held).statusCode, 503);
      assert.equal(
        (
          await pool.query(
            "SELECT * FROM channel_inbox WHERE source_id='channel:telegram:fixture-account:revoked-code'",
          )
        ).rowCount,
        0,
      );
    } finally {
      releaseHeld();
      await fixture.app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('channel presentation isolates private links from the model and rejects unsafe generated output', async () => {
  const presentation: unknown[] = [];
  const present = async (threadId: string | null, input: unknown) => {
    presentation.push({ threadId, input });
    return 'Continua na aplicação nod.';
  };
  await channelReply(
    'Continua [em segurança](/credentials/secret-id?token=secret-token) ou [aprova](http://localhost:4310/payments/private-id). Consulta https://example.com/docs.',
    { threadId: 'owned-thread', present },
  );
  assert.equal(presentation.length, 1);
  assert.doesNotMatch(JSON.stringify(presentation), /secret-id|secret-token|private-id/);
  assert.match(JSON.stringify(presentation), /https:\/\/example\.com\/docs/);
  const ordinary = 'Consulta [a fatura](https://merchant.example/payments/invoice).';
  assert.equal(await channelReply(ordinary, { threadId: 'owned-thread', present }), ordinary);
  assert.equal(presentation.length, 1);
  for (const page of ['/vault', '/trust']) {
    await channelReply(`Save it in nod: ${page}?add=login`, { threadId: 'owned-thread', present });
    assert.doesNotMatch(JSON.stringify(presentation), /(?:vault|trust)\?add/);
  }
  for (const generated of [
    '',
    'http://localhost:4310/credentials/secret-id',
    '[Continua](/payments/private-id)',
    '[Ficheiro](/api/artifacts/private-id)',
  ]) {
    await assert.rejects(
      channelReply('/credentials/request-id', {
        threadId: 'owned-thread',
        present: async () => generated,
      }),
    );
  }
  await assert.rejects(
    channelReply('/credentials/request-id', {
      threadId: 'owned-thread',
      present: async () => {
        throw new Error('Synthetic generation failure');
      },
    }),
  );
  await assert.rejects(channelReply('/credentials/request-id', { threadId: 'owned-thread' }));
});

test(
  'a webhook received during an outbound send is submitted before the active drain finishes',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_channels_overlap_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const threadId = await createFixtureTables(pool, 'local-development');
    let releaseSend = () => {};
    let markSendStarted = () => {};
    const sendReleased = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    let sends = 0;
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === 'https://api.telegram.org/bot987:fixture-not-live/getMe')
        return Response.json({
          ok: true,
          result: { id: 987, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' },
        });
      if (url.startsWith('https://api.telegram.org/bot987:fixture-not-live/send')) {
        sends++;
        markSendStarted();
        await sendReleased;
        return Response.json({
          ok: true,
          result: {
            message_id: 100,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 123456, type: 'private' },
            text: 'Fixture reply',
          },
        });
      }
      throw new Error('Unexpected fixture provider call.');
    });
    const app = Fastify();
    const channels = await createChannels(pool, {
      ownerId: 'local-development',
      transport: createChatSdkTransport(pool, { ...fixtureEnv, WHATSAPP_ENABLED: 'false' }),
      subscribe: () => () => {},
      intervalMs: 600000,
      submit: async (_text, sourceId, client, channel) =>
        fixtureTurn(client, threadId, 'local-development', channel, sourceId),
    });
    channels.registerRoutes(app);
    const send = (id: number) =>
      app.inject({
        method: 'POST',
        url: '/api/webhooks/telegram',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': fixtureEnv.TELEGRAM_WEBHOOK_SECRET_TOKEN,
        },
        payload: {
          update_id: id,
          message: {
            message_id: id,
            date: Math.floor(Date.now() / 1000),
            text: `Fixture request ${id}`,
            from: { id: 123456, is_bot: false, first_name: 'Fixture' },
            chat: { id: 123456, type: 'private' },
          },
        },
      });
    try {
      assert.equal((await send(1)).statusCode, 200);
      await channels.drain();
      const turn = (await pool.query('SELECT id FROM turns')).rows[0];
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id) VALUES($1,'local-development','assistant','Fixture reply',$2,$3)",
        [randomUUID(), threadId, turn.id],
      );
      const activeDrain = channels.drain();
      await Promise.race([
        sendStarted,
        activeDrain.then(() => {
          throw new Error('The fixture reply did not reach the provider transport.');
        }),
      ]);
      assert.equal((await send(2)).statusCode, 200);
      assert.equal((await pool.query('SELECT * FROM turns')).rowCount, 1);
      releaseSend();
      await activeDrain;
      assert.equal((await pool.query('SELECT * FROM turns')).rowCount, 2);
      assert.equal(
        (await pool.query("SELECT * FROM channel_inbox WHERE state='pending'")).rowCount,
        0,
      );
      assert.equal(sends, 1);
    } finally {
      releaseSend();
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'Chat SDK channel fixture authenticates owner messages, commits turn dedupe, and routes replies by turn channel',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_channels_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const threadId = await createFixtureTables(pool, 'local-development');
    const sent: { provider: string; body: Record<string, unknown> }[] = [];
    const whatsappFileId = randomUUID();
    let providerCalls = 0;
    let failSend = false;
    let failSubmit = false;
    let failReaction = false;
    const reacting: { provider: string; body: Record<string, unknown> }[] = [];
    const reactedTo: [string, string | null][] = [];
    t.mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        providerCalls++;
        const url = input instanceof Request ? input.url : String(input);
        const body =
          typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        if (url === 'https://api.telegram.org/bot987:fixture-not-live/getMe')
          return Response.json({
            ok: true,
            result: { id: 987, is_bot: true, first_name: 'Fixture', username: 'fixture_bot' },
          });
        if (url === 'https://api.telegram.org/bot987:fixture-not-live/setMessageReaction') {
          reacting.push({ provider: 'telegram', body });
          if (failReaction) throw new Error('Fixture reaction delivery is uncertain.');
          return Response.json({ ok: true, result: true });
        }
        if (url.startsWith('https://api.telegram.org/bot987:fixture-not-live/send')) {
          sent.push({ provider: 'telegram', body });
          if (failSend) throw new Error('Fixture transport interrupted after possible acceptance.');
          return Response.json({
            ok: true,
            result: {
              message_id: sent.length + 100,
              date: Math.floor(Date.now() / 1000),
              chat: { id: 123456, type: 'private' },
              text: 'Fixture reply',
            },
          });
        }
        if (/^https:\/\/graph\.facebook\.com\/v\d+\.0\/555000\/messages$/.test(url)) {
          if (body.type === 'reaction') {
            reacting.push({ provider: 'whatsapp', body });
            return Response.json({
              messages: [{ id: `wamid.fixture-reaction-${reacting.length}` }],
            });
          }
          sent.push({ provider: 'whatsapp', body });
          return Response.json({ messages: [{ id: `wamid.fixture-out-${sent.length}` }] });
        }
        throw new Error('Unexpected fixture provider call.');
      },
    );
    const app = Fastify();
    const channels = await createChannels(pool, {
      ownerId: 'local-development',
      present: async (_thread, input) => {
        assert.doesNotMatch(JSON.stringify(input), /private-token|api\/artifacts/);
        return 'Continua na aplicação nod.';
      },
      transport: createChatSdkTransport(pool, fixtureEnv),
      resolveAttachments: async (resolvedThreadId, ids) => {
        assert.equal(resolvedThreadId, threadId);
        if (ids.length !== 1 || ids[0] !== whatsappFileId)
          throw new Error('Attachment unavailable.');
        return [attachment('research.csv', 'text/csv', 'A,B\n1,2\n')];
      },
      subscribe: () => () => {},
      intervalMs: 600000,
      reacted: async (messageId, reaction) => {
        reactedTo.push([messageId, reaction]);
      },
      submit: async (_text, sourceId, client, channel) => {
        const turnId = await fixtureTurn(client, threadId, 'local-development', channel, sourceId);
        if (failSubmit) throw new Error('Fixture turn queue unavailable.');
        return turnId;
      },
    });
    channels.registerRoutes(app);
    const telegramPayload = (id: number, from = 123456, type = 'private') => ({
      update_id: id,
      message: {
        message_id: id,
        date: Math.floor(Date.now() / 1000),
        text: 'Help with a fixture task',
        from: { id: from, is_bot: false, first_name: 'Fixture' },
        chat: { id: from, type },
      },
    });
    const whatsappPayload = (
      id: string,
      from = '351910000000',
      phone = '555000',
      timestamp = Math.floor(Date.now() / 1000),
    ) => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: phone },
                messages: [
                  {
                    id,
                    from,
                    timestamp: String(timestamp),
                    type: 'text',
                    text: { body: 'A WhatsApp fixture request' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const sendTelegram = (payload: unknown, secret = fixtureEnv.TELEGRAM_WEBHOOK_SECRET_TOKEN) =>
      app.inject({
        method: 'POST',
        url: '/api/webhooks/telegram',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
        payload: JSON.stringify(payload),
      });
    const sendWhatsApp = (payload: unknown, valid = true) => {
      const body = JSON.stringify(payload);
      const signature = `sha256=${createHmac('sha256', fixtureEnv.WHATSAPP_APP_SECRET).update(body).digest('hex')}`;
      return app.inject({
        method: 'POST',
        url: '/api/webhooks/whatsapp',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': valid ? signature : 'sha256=invalid',
        },
        payload: body,
      });
    };
    const addReply = async (
      sourceId: string,
      text = 'The fixture task is done.',
      attachments: { id: string }[] = [],
    ) => {
      const row = (
        await pool.query('SELECT turn_id FROM channel_inbox WHERE source_id=$1', [sourceId])
      ).rows[0];
      const id = randomUUID();
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id,attachments) VALUES($1,'local-development','assistant',$2,$3,$4,$5)",
        [id, text, threadId, row.turn_id, JSON.stringify(attachments)],
      );
      return id;
    };
    try {
      assert.equal((await sendTelegram(telegramPayload(1), 'invalid')).statusCode, 401);
      assert.equal((await sendWhatsApp(whatsappPayload('wamid.bad'), false)).statusCode, 401);
      await sendTelegram(telegramPayload(2, 456789));
      await sendTelegram(telegramPayload(3, 123456, 'group'));
      await sendWhatsApp(whatsappPayload('wamid.other-user', '351920000000'));
      await sendWhatsApp(whatsappPayload('wamid.other-business', undefined, '999000'));
      await channels.drain();
      assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 0);
      assert.equal(providerCalls, 0);
      assert.equal(
        (
          await app.inject(
            '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123',
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject(
            '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=fixture-verify-token&hub.challenge=123',
          )
        ).body,
        '123',
      );

      failSubmit = true;
      await sendTelegram(telegramPayload(10));
      await channels.drain();
      assert.equal((await pool.query('SELECT * FROM turns')).rowCount, 0);
      assert.equal((await pool.query('SELECT state FROM channel_inbox')).rows[0].state, 'pending');
      failSubmit = false;
      await channels.drain();
      await Promise.all([sendTelegram(telegramPayload(10)), sendTelegram(telegramPayload(10))]);
      await sendWhatsApp(whatsappPayload('wamid.good'));
      await sendWhatsApp(whatsappPayload('wamid.good'));
      await channels.drain();
      assert.equal((await pool.query('SELECT * FROM turns')).rowCount, 2);
      assert.equal((await pool.query('SELECT * FROM channel_inbox')).rowCount, 2);
      await addReply(
        'channel:telegram:987:123456:10',
        'Finish [securely](/credentials/private-token), [approve payment](/payments/private-token) or [add a card](/vault?add=card).',
      );
      await addReply('channel:whatsapp:555000:wamid.good');
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,thread_id,turn_id) VALUES($1,'local-development','assistant','Unrelated web-only reply',$2,$3)",
        [randomUUID(), threadId, await fixtureTurn(pool, threadId, 'local-development', 'web')],
      );
      await channels.drain();
      assert.equal(sent.length, 2);

      const fileReply = await addReply(
        'channel:whatsapp:555000:wamid.good',
        `Research is ready. [File](/api/artifacts/${whatsappFileId})`,
        [{ id: whatsappFileId }],
      );
      await channels.drain();
      assert.equal(sent.length, 3);
      const fileText = JSON.stringify(sent[2].body);
      assert.doesNotMatch(fileText, /api\/artifacts/);
      assert.equal(
        (await pool.query('SELECT state FROM channel_outbox WHERE message_id=$1', [fileReply]))
          .rows[0].state,
        'sent',
      );

      const missingReply = await addReply('channel:whatsapp:555000:wamid.good', 'Missing file.', [
        { id: randomUUID() },
      ]);
      await channels.drain();
      assert.equal(sent.length, 4);
      assert.deepEqual(
        (
          await pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [
            missingReply,
          ])
        ).rows[0],
        { state: 'sent', reason: null },
      );
      assert.equal(sent.find((message) => message.provider === 'telegram')?.body.chat_id, '123456');
      assert.equal(
        sent.find((message) => message.provider === 'whatsapp')?.body.to,
        '351910000000',
      );
      assert.equal(JSON.stringify(sent).includes('private-token'), false);
      assert.equal(JSON.stringify(sent).includes('/vault?add='), false);
      assert.equal(JSON.stringify(sent).includes('Unrelated web-only'), false);
      await channels.drain();
      assert.equal(sent.length, 4);

      const idOf = async (query: string) => (await pool.query(query)).rows[0].message_id;
      const ownerMessage = await idOf(
        "SELECT message_id FROM channel_inbox WHERE source_id='channel:telegram:987:123456:10'",
      );
      const telegramReply = await idOf(
        "SELECT message_id FROM channel_outbox WHERE provider_message_id='123456:101'",
      );
      const whatsappReply = await idOf(
        "SELECT message_id FROM channel_outbox WHERE provider_message_id='wamid.fixture-out-2'",
      );
      const telegramReaction = (messageId: number, emoji: string[], from = 123456) => ({
        update_id: 500 + reactedTo.length,
        message_reaction: {
          chat: { id: from, type: 'private' },
          message_id: messageId,
          user: { id: from, is_bot: false, first_name: 'Fixture' },
          date: Math.floor(Date.now() / 1000),
          old_reaction: [],
          new_reaction: emoji.map((value) => ({ type: 'emoji', emoji: value })),
        },
      });
      const whatsappReaction = (target: string, emoji: string, from = '351910000000') => ({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: '555000' },
                  messages: [
                    {
                      id: `wamid.reaction-${randomUUID()}`,
                      from,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'reaction',
                      reaction: { message_id: target, emoji },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
      await pool.query(
        'UPDATE channel_outbox SET provider_message_ids=ARRAY[provider_message_id,$2] WHERE message_id=$1',
        [telegramReply, '123456:102'],
      );
      await sendTelegram(telegramReaction(102, ['👍']));
      await sendTelegram(telegramReaction(101, ['🔥'], 456789));
      await sendTelegram(telegramReaction(10, ['👍']));
      await sendTelegram(telegramReaction(101, []));
      await sendTelegram(telegramReaction(101, ['❤']));
      await sendTelegram(telegramReaction(101, ['🤷‍♂']));
      await sendTelegram(telegramReaction(101, ['🤷‍♀']));
      await sendWhatsApp(whatsappReaction('wamid.fixture-out-2', '❤️'));
      await sendWhatsApp(whatsappReaction('wamid.fixture-out-2', '😂', '351920000000'));
      await sendWhatsApp(whatsappReaction('123456:101', '😂'));
      assert.deepEqual(reactedTo, [
        [telegramReply, '👍'],
        [telegramReply, null],
        [telegramReply, '❤️'],
        [telegramReply, '🤷‍♂️'],
        [telegramReply, '🤷‍♀️'],
        [whatsappReply, '❤️'],
      ]);
      const whatsappOwnerMessage = await idOf(
        "SELECT message_id FROM channel_inbox WHERE source_id='channel:whatsapp:555000:wamid.good'",
      );
      assert.equal(await channels.react(ownerMessage, '👍'), 'sent');
      assert.equal(await channels.react(ownerMessage, '🫠'), 'unsupported');
      assert.equal(await channels.react(ownerMessage, null), 'sent');
      assert.equal(await channels.react(whatsappOwnerMessage, '❤️'), 'sent');
      assert.equal(await channels.react(randomUUID(), '👍'), 'absent');
      assert.deepEqual(
        reacting.map(({ provider, body }) => [provider, body.message_id ?? body.reaction]),
        [
          ['telegram', 10],
          ['telegram', 10],
          ['whatsapp', { message_id: 'wamid.good', emoji: '❤️' }],
        ],
      );
      assert.deepEqual(
        reacting.slice(0, 2).map(({ body }) => body.reaction),
        [[{ type: 'emoji', emoji: '👍' }], []],
      );
      await pool.query(
        "INSERT INTO messages(id,owner_id,role,text,thread_id) VALUES($1,'local-development','user','Synthetic request',$2)",
        [ownerMessage, threadId],
      );
      const reactions = createAgentReactionService({
        pool,
        ownerId: 'local-development',
        refresh() {},
        deliver: channels.react,
      });
      const reactionTurn = await fixtureTurn(
        pool,
        threadId,
        'local-development',
        'telegram',
        null,
        'running',
      );
      const react = (reaction: string | null) =>
        reactions.react({ threadId, turnId: reactionTurn, messageId: ownerMessage, reaction });
      const storedReaction = async () =>
        (
          await pool.query(
            'SELECT assistant_reaction,assistant_reacted_at FROM messages WHERE id=$1',
            [ownerMessage],
          )
        ).rows[0];
      assert.deepEqual(await react('🫠'), { status: 'skipped', reason: 'unsupported' });
      assert.deepEqual(await storedReaction(), {
        assistant_reaction: null,
        assistant_reacted_at: null,
      });
      failReaction = true;
      assert.deepEqual(await react('👍'), { status: 'skipped', reason: 'delivery_failed' });
      assert.equal((await storedReaction()).assistant_reaction, '👍');
      assert.ok((await storedReaction()).assistant_reacted_at);
      const reactionAttempts = reacting.length;
      assert.deepEqual(await react('👍'), { status: 'unchanged' });
      assert.equal(reacting.length, reactionAttempts);
      failReaction = false;
      await pool.query(
        'UPDATE messages SET assistant_reaction=NULL,assistant_reacted_at=NULL WHERE id=$1',
        [ownerMessage],
      );
      assert.deepEqual(await react('👍'), { status: 'updated' });
      failReaction = true;
      assert.deepEqual(await react(null), { status: 'skipped', reason: 'delivery_failed' });
      assert.equal((await storedReaction()).assistant_reaction, '👍');
      failReaction = false;
      assert.deepEqual(await react(null), { status: 'updated' });
      const aborted = new AbortController();
      aborted.abort();
      const beforeCancel = reacting.length;
      await assert.rejects(channels.react(ownerMessage, '👍', aborted.signal));
      assert.equal(reacting.length, beforeCancel);

      await sendWhatsApp(
        whatsappPayload('wamid.old', undefined, undefined, Math.floor(Date.now() / 1000) - 172800),
      );
      await channels.drain();
      await pool.query(
        "UPDATE channel_inbox SET received_at=now()-interval '2 days' WHERE provider='whatsapp'",
      );
      const expiredId = await addReply('channel:whatsapp:555000:wamid.old');
      await channels.drain();
      assert.deepEqual(
        (
          await pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [
            expiredId,
          ])
        ).rows[0],
        { state: 'blocked', reason: 'reply_window_closed' },
      );
      assert.equal(sent.length, 4);

      const paragraphs = Array.from({ length: 30 }, (_, index) =>
        `Paragraph ${index} ${'detail '.repeat(40)}`.trim(),
      );
      await addReply('channel:telegram:987:123456:10', paragraphs.join('\n\n'));
      await channels.drain();
      const parts = sent
        .slice(4)
        .map((message) =>
          String(
            (message.body.rich_message as { markdown?: string })?.markdown ?? message.body.text,
          ),
        );
      assert.ok(parts.length > 1 && parts.every((part) => part.length <= 4096));
      assert.ok(paragraphs.every((paragraph) => parts.some((part) => part.includes(paragraph))));

      failSend = true;
      const uncertainId = await addReply('channel:telegram:987:123456:10');
      await channels.drain();
      assert.equal(
        (await pool.query('SELECT state FROM channel_outbox WHERE message_id=$1', [uncertainId]))
          .rows[0].state,
        'uncertain',
      );
      const attempts = sent.length;
      await channels.drain();
      assert.equal(sent.length, attempts);
      const status = (await app.inject('/api/channels')).json();
      assert.equal(status.channels[0].status, 'configured');
      assert.equal(JSON.stringify(status).includes('fixture-app-secret'), false);
      assert.equal(JSON.stringify(status).includes('allowedSenderIds'), false);
      assert.equal(JSON.stringify(status).includes('accountId'), false);
      await pool.query("UPDATE channel_outbox SET state='sending' WHERE message_id=$1", [
        uncertainId,
      ]);
      const revokedId = await addReply('channel:telegram:987:123456:10');
      await app.close();
      const restarted = await createChannels(pool, {
        ownerId: 'local-development',
        present: async () => 'Consulta os ficheiros na aplicação nod.',
        resolveAttachments: async (_threadId, ids) => {
          if (ids.length !== 1 || ids[0] !== whatsappFileId)
            throw new Error('Attachment unavailable.');
          return [attachment('research.csv', 'text/csv', 'A,B\n1,2\n')];
        },
        transport: createChatSdkTransport(pool, {
          ...fixtureEnv,
          TELEGRAM_ALLOWED_USER_ID: '999999',
        }),
        subscribe: () => () => {},
        intervalMs: 600000,
        submit: async () => {
          throw new Error('No new turn should be submitted.');
        },
      });
      try {
        await restarted.drain();
        assert.deepEqual(
          (
            await pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [
              uncertainId,
            ])
          ).rows[0],
          { state: 'uncertain', reason: 'interrupted_send' },
        );
        assert.deepEqual(
          (
            await pool.query('SELECT state,reason FROM channel_outbox WHERE message_id=$1', [
              revokedId,
            ])
          ).rows[0],
          { state: 'blocked', reason: 'channel_access_changed' },
        );
        assert.equal(sent.length, attempts);
        await pool.query(
          "UPDATE channel_inbox SET received_at=now() WHERE source_id='channel:whatsapp:555000:wamid.good'",
        );
        await addReply('channel:whatsapp:555000:wamid.good', 'Research is ready.', [
          { id: whatsappFileId },
        ]);
        await restarted.drain();
        assert.equal(sent.length, attempts + 1);
        assert.doesNotMatch(JSON.stringify(sent.at(-1)?.body), /api\/artifacts/);
      } finally {
        await restarted.close();
      }
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
