import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { channelReply, createChannels } from '../src/server/channels.ts';
import { createAgentReactionService } from '../src/server/agent-reactions.ts';
import { createChatVerification } from '../src/server/chat-verification.ts';
import { createCommunication } from '../src/server/communication.ts';
import { createVault } from '../src/server/vault.ts';
import { locksTable } from '../src/server/locks.ts';
import { createChatSdkTransport } from '../src/providers/chat-sdk/index.ts';
import type { MessagingTransport } from '../src/ports/messaging.ts';
import { createWhatsAppLinkedTransport } from '../src/providers/chat-sdk/whatsapp.ts';
import { combineMessagingTransports } from '../src/providers/chat-sdk/combined.ts';
import { createChannelSessionStore } from '../src/server/channel-session.ts';
import { createChannelMedia } from '../src/server/channel-media.ts';
import { automaticSpeechVoice, createSpeech } from '../src/server/speech.ts';
import { createOpenAISpeechProvider } from '../src/providers/openai/speech.ts';
import {
  createElevenLabsSpeechProvider,
  readElevenLabsVoices,
} from '../src/providers/elevenlabs/speech.ts';
import { createLocalSpeechProvider } from '../src/providers/local-speech/index.ts';
import { decodeLocalAudio } from '../src/providers/local-speech/audio.ts';
import { phonemizeSpeech } from '../src/providers/local-speech/phonemizer.ts';
import {
  createOpenRouterSpeechProvider,
  createOpenRouterTranscriptionProvider,
} from '../src/providers/openrouter/speech.ts';
import { createArtifactService } from '../src/server/artifacts.ts';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Artifact } from '../src/shared/contracts.ts';
import type { InboundMessage } from '../src/ports/messaging.ts';
import { ChannelMediaFailure } from '../src/server/channel-media.ts';
import { loadAudioWaveform } from '../src/web/lib/audio-waveform.ts';
import { contactCards } from '../src/shared/channel-content.ts';
import { contactAttachment } from '../src/providers/chat-sdk/content.ts';
import { gzipSync } from 'node:zlib';
import { decodeSticker } from '../src/web/lib/sticker.ts';
import { runProcess } from '../src/providers/process.ts';

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

test('audio waveform decoding bounds browser recordings and encoded samples before entering the native decoder', async (t) => {
  const webm = ({
    timestamp = 0,
    codec = 'A_OPUS',
    channels = 1,
    flags = 0x80,
    tracks = 1,
    packets = 2,
    declaredDuration = 0,
    group = false,
    padding = 0,
  } = {}) => {
    const element = (id: string, bytes: Buffer) => {
      let width = 1;
      while (bytes.length >= 2 ** (width * 7) - 1) width++;
      const length = Buffer.alloc(width);
      length.writeUIntBE(bytes.length, 0, width);
      length[0] |= 1 << (8 - width);
      return Buffer.concat([Buffer.from(id, 'hex'), length, bytes]);
    };
    const uint = (value: number) => {
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32BE(value);
      return bytes;
    };
    const duration = Buffer.alloc(8);
    duration.writeDoubleBE(declaredDuration);
    const head = Buffer.alloc(19);
    head.write('OpusHead');
    head[8] = 1;
    head[9] = channels;
    const track = element(
      'ae',
      Buffer.concat([
        element('d7', Buffer.from([1])),
        element('83', Buffer.from([2])),
        element('86', Buffer.from(codec)),
        element('63a2', head),
        element('e1', element('9f', Buffer.from([channels]))),
      ]),
    );
    return Buffer.concat([
      element('1a45dfa3', element('4282', Buffer.from('webm'))),
      Buffer.from('1853806701ffffffffffffff', 'hex'),
      element(
        '1549a966',
        Buffer.concat([
          element('2ad7b1', uint(1_000_000)),
          ...(declaredDuration ? [element('4489', duration)] : []),
        ]),
      ),
      element('1654ae6b', Buffer.concat(Array.from({ length: tracks }, () => track))),
      Buffer.from('1f43b67501ffffffffffffff', 'hex'),
      element('e7', uint(timestamp)),
      ...Array.from({ length: packets }, () => {
        const block = Buffer.from([0x81, 0, 0, flags, 0xf8, 0xff, 0xfe]);
        return group
          ? element('a0', Buffer.concat([element('a1', block), element('75a2', uint(padding))]))
          : element('a3', block);
      }),
    ]);
  };
  const wav = (samples: number) => {
    const bytes = Buffer.alloc(44 + samples * 2);
    bytes.write('RIFF');
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(8000, 24);
    bytes.writeUInt32LE(16000, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36);
    bytes.writeUInt32LE(samples * 2, 40);
    return bytes;
  };
  const extensibleWav = (bits = 24, format = 1) => {
    const bytes = Buffer.alloc(68 + (128 * 2 * bits) / 8);
    wav(128).copy(bytes, 0, 0, 36);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.writeUInt32LE(40, 16);
    bytes.writeUInt16LE(0xfffe, 20);
    bytes.writeUInt16LE(2, 22);
    bytes.writeUInt32LE((8000 * 2 * bits) / 8, 28);
    bytes.writeUInt16LE((2 * bits) / 8, 32);
    bytes.writeUInt16LE(bits, 34);
    bytes.writeUInt16LE(22, 36);
    bytes.writeUInt16LE(bits, 38);
    bytes.writeUInt32LE(3, 40);
    bytes.writeUInt32LE(format, 44);
    Buffer.from('00001000800000aa00389b71', 'hex').copy(bytes, 48);
    bytes.write('data', 60);
    bytes.writeUInt32LE(bytes.length - 68, 64);
    return bytes;
  };
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0xc4]);
  const mp3 = Buffer.concat([frame, frame]);
  const m4a = Buffer.from(
    'AAAAHGZ0eXBNNEEgAAACAE00QSBpc29taXNvMgAAAAhmcmVlAAAAIW1kYXTeAgBMYXZjNjIuMTEuMTAwAAIwQA4BGCAHAAADAm1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAyAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAItdHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAAyAAAAAAAAAAAAAAABAQAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAJGVkdHMAAAAcZWxzdAAAAAAAAAABAAAAMgAABAAAAQAAAAABpW1kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAH0AAAAWQVcQAAAAAAC1oZGxyAAAAAAAAAABzb3VuAAAAAAAAAAAAAAAAU291bmRIYW5kbGVyAAAAAVBtaW5mAAAAEHNtaGQAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAARRzdGJsAAAAanN0c2QAAAAAAAAAAQAAAFptcDRhAAAAAAAAAAEAAAAAAAAAAAABABAAAAAAH0AAAAAAADZlc2RzAAAAAAOAgIAlAAEABICAgBdAFQAAAAAAPoAAAARjBYCAgAUViFblAAaAgIABAgAAACBzdHRzAAAAAAAAAAIAAAABAAAEAAAAAAEAAAGQAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAACAAAAAQAAABxzdHN6AAAAAAAAAAAAAAACAAAAFQAAAAQAAAAUc3RjbwAAAAAAAAABAAAALAAAABpzZ3BkAQAAAHJvbGwAAAACAAAAAf//AAAAHHNiZ3AAAAAAcm9sbAAAAAEAAAACAAAAAQAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjIuMy4xMDA=',
    'base64',
  );
  const invalidWav = wav(128);
  invalidWav.writeUInt16LE(32, 22);
  const invalidMp3 = Buffer.from(mp3);
  invalidMp3[2] = 0xf0;
  const excessiveM4a = Buffer.from(m4a);
  excessiveM4a.writeUInt32BE(0xffffffff, m4a.indexOf('stts') + 12);
  const invalidM4a = Buffer.from(m4a);
  invalidM4a.writeUInt32BE(0xffffffff, m4a.indexOf('stsz') - 4);
  const oversizedM4aSample = Buffer.from(m4a);
  oversizedM4aSample.writeUInt32BE(0xffffffff, m4a.indexOf('stsz') + 16);
  const multichannelM4a = Buffer.from(m4a);
  multichannelM4a.writeUInt16BE(32, m4a.indexOf('mp4a') + 20);
  const paddedPcm = extensibleWav();
  paddedPcm.writeUInt16LE(20, 38);
  const unspecifiedSpeakers = extensibleWav();
  unspecifiedSpeakers.writeUInt32LE(0, 40);
  const corruptGuid = extensibleWav();
  corruptGuid[59] ^= 1;
  const invalidExtensibleWav = [
    [16, 38],
    [36, 21],
    [36, 24],
    [38, 0],
    [38, 25],
    [40, 7],
  ].map(([offset, value]) => {
    const bytes = extensibleWav();
    bytes.writeUInt16LE(value, offset);
    return bytes;
  });
  const reservedSpeaker = extensibleWav();
  reservedSpeaker.writeUInt32LE(0x80000001, 40);
  const invalidFloatPrecision = extensibleWav(32, 3);
  invalidFloatPrecision.writeUInt16LE(24, 38);
  const accepted = [
    wav(128),
    mp3,
    Buffer.concat([Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]), mp3]),
    m4a,
    extensibleWav(),
    extensibleWav(32, 3),
    paddedPcm,
    unspecifiedSpeakers,
    webm(),
    webm({ group: true, padding: 13_500_000 }),
    webm({ declaredDuration: 40 }),
  ];
  const files = [
    ...accepted,
    invalidWav,
    wav(4_800_001),
    invalidMp3,
    Buffer.concat(Array.from({ length: 23_000 }, () => frame)),
    excessiveM4a,
    invalidM4a,
    oversizedM4aSample,
    multichannelM4a,
    m4a.subarray(0, m4a.length - 1),
    Buffer.from('<html>Not audio</html>'),
    extensibleWav(24, 2),
    corruptGuid,
    ...invalidExtensibleWav,
    reservedSpeaker,
    invalidFloatPrecision,
    webm({ timestamp: 600_001 }),
    webm({ codec: 'A_VORBIS' }),
    webm({ channels: 3 }),
    webm({ flags: 0x82 }),
    webm({ tracks: 2 }),
    webm({ packets: 30_001 }),
    webm({ declaredDuration: 600_001 }),
    webm({ declaredDuration: Infinity }),
    webm({ declaredDuration: -1 }),
    webm({ group: true, padding: 120_000_001 }),
    webm().subarray(0, webm().length - 1),
  ];
  const ids: string[] = files.map(() => randomUUID());
  const server = createServer((request, response) => {
    const index = ids.indexOf(request.url!.split('/').at(-1)!);
    response.end(files[index]);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address() as { port: number };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options) =>
    originalFetch(new URL(String(input), `http://127.0.0.1:${address.port}`), options);
  const originalContext = Object.getOwnPropertyDescriptor(globalThis, 'OfflineAudioContext');
  let decodes = 0;
  Object.defineProperty(globalThis, 'OfflineAudioContext', {
    configurable: true,
    value: class {
      async decodeAudioData() {
        decodes++;
        throw new Error('Native decoding unavailable in this test.');
      }
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalContext) Object.defineProperty(globalThis, 'OfflineAudioContext', originalContext);
    else Reflect.deleteProperty(globalThis, 'OfflineAudioContext');
  });
  for (const [index, file] of files.entries())
    await assert.rejects(
      loadAudioWaveform(
        `/api/artifacts/${ids[index]}`,
        file.length,
        0,
        new AbortController().signal,
      ),
      index < accepted.length ? /Native decoding unavailable/ : /Waveform unavailable/,
    );
  assert.equal(decodes, accepted.length);
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
            sockets[0].events.emit('connection.update', { isNewLogin: true, qr: undefined });
            assert.equal((await transport.pairing!()).qr, undefined);
            assert.equal((await transport.pairing!()).state, 'connecting');
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
            for (const failure of ['oversized', 'unreadable', 'changed'] as const) {
              const before = sent.length;
              const answer =
                '**Seat layout**\n12A is available for EUR 25. Availability checked 2026-10-26.\nSource: https://example.com/seats';
              const file = attachment(`${failure}.png`, 'image/png', 'synthetic image');
              let reads = 0;
              let notices = 0;
              const result = await transport.post({
                channelId: 'whatsapp',
                accountId,
                threadId: jid,
                text: answer,
                replyToMessageId: 'task-prompt',
                replyToText: 'Fixture seat question',
                attachments: [
                  {
                    ...file,
                    size: failure === 'oversized' ? 50 * 1024 * 1024 + 1 : file.size,
                    async read() {
                      reads++;
                      if (failure === 'unreadable')
                        throw new Error('The owned file is unavailable.');
                      return Buffer.from('changed');
                    },
                  },
                ],
                async attachmentFailure(names) {
                  notices++;
                  assert.deepEqual(names, [file.name]);
                  return `The file ${file.name} is available in Nod.`;
                },
              });
              const delivered = sent.slice(before);
              assert.equal(reads, failure === 'oversized' ? 0 : 1);
              assert.equal(notices, 1);
              assert.equal(delivered.length, 2);
              const fallback = delivered[0].content.text as string;
              for (const line of answer.replaceAll('**', '').split('\n'))
                assert.ok(fallback.includes(line));
              assert.equal(delivered[1].content.text, `The file ${file.name} is available in Nod.`);
              assert.ok(delivered.every((message) => !message.content.image));
              assert.deepEqual(
                result.ids,
                delivered.map((message) => message.id),
              );
              assert.ok(
                delivered.every(
                  (message) => (message.quoted as { key: { id: string } }).key.id === 'task-prompt',
                ),
              );
            }
            const beforeMixed = sent.length;
            const mixed = await transport.post({
              channelId: 'whatsapp',
              accountId,
              threadId: jid,
              text: 'Both layouts use rows 1–20.',
              attachments: [
                {
                  ...attachment('missing.png', 'image/png', 'missing image'),
                  async read() {
                    throw new Error('The owned file is unavailable.');
                  },
                },
                attachment('available.png', 'image/png', 'available image'),
              ],
              async attachmentFailure(names) {
                assert.deepEqual(names, ['missing.png']);
                return 'The missing.png file is available in Nod.';
              },
            });
            assert.equal(sent.length, beforeMixed + 3);
            assert.equal(sent[beforeMixed].content.text, 'Both layouts use rows 1–20.');
            assert.deepEqual(sent[beforeMixed + 1].content.image, Buffer.from('available image'));
            assert.equal(
              sent[beforeMixed + 2].content.text,
              'The missing.png file is available in Nod.',
            );
            assert.deepEqual(
              mixed.ids,
              sent.slice(beforeMixed).map((message) => message.id),
            );
            const beforeUncertainImage = sent.length;
            let uncertainImageNotices = 0;
            failSend = true;
            await assert.rejects(
              transport.post({
                channelId: 'whatsapp',
                accountId,
                threadId: jid,
                text: 'This layout may already have arrived.',
                attachments: [attachment('uncertain.png', 'image/png', 'uncertain image')],
                async attachmentFailure() {
                  uncertainImageNotices++;
                  return 'The image is available in Nod.';
                },
              }),
              /may have accepted/,
            );
            failSend = false;
            assert.equal(sent.length, beforeUncertainImage + 1);
            assert.equal(uncertainImageNotices, 0);
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
  for (const status of [400, 401, 402, 403, 429, 503]) {
    for (const engine of ['openai', 'openrouter']) {
      let discarded = false;
      const options = {
        apiKey: async () => 'fixture-never-live',
        configured: () => true,
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(stream) {
                stream.enqueue(Buffer.from('private upstream diagnostic fixture-never-live'));
              },
              cancel() {
                discarded = true;
              },
            }),
            { status },
          ),
      };
      const provider =
        engine === 'openai'
          ? createOpenAISpeechProvider(options)
          : {
              ...createOpenRouterSpeechProvider(options),
              transcribe: createOpenRouterTranscriptionProvider(options).transcribe,
            };
      const service = createSpeech(provider);
      for (const operation of [
        () => service.transcribe({ bytes, mimeType: 'audio/ogg', name: 'voice.ogg' }),
        () => service.synthesize('Synthetic reply'),
      ]) {
        await assert.rejects(operation, (error: Error & { statusCode?: number }) => {
          assert.equal(error.statusCode, 400);
          assert.doesNotMatch(error.message, /private upstream|fixture-never-live/);
          return true;
        });
        assert.equal(discarded, true);
        discarded = false;
      }
    }
  }
  const silent = createSpeech(
    createOpenAISpeechProvider({
      apiKey: 'fixture-never-live',
      fetch: async () => Response.json({ text: '  ' }),
    }),
  );
  await assert.rejects(silent.transcribe({ bytes, mimeType: 'audio/ogg', name: 'voice.ogg' }), {
    statusCode: 400,
  });
});

test('speech honors the selected OpenAI voice and refuses voices from another engine before requesting audio', async () => {
  const requests: Record<string, unknown>[] = [];
  const service = createSpeech(
    createOpenAISpeechProvider({
      apiKey: 'fixture-never-live',
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(Buffer.from('synthetic speech'));
      },
    }),
  );
  await service.synthesize('Synthetic reply.', undefined, { voice: 'openai:cedar' });
  assert.equal(requests[0].voice, 'cedar');
  await assert.rejects(
    service.synthesize('Synthetic reply.', undefined, { voice: 'elevenlabs:sarah' }),
  );
  await assert.rejects(
    service.synthesize('Synthetic reply.', undefined, { voice: 'openai:missing' }),
  );
  assert.equal(requests.length, 1);
});

test('automatic speech selects the spoken language within the current provider and cancels pending selection', async () => {
  const { speechVoices } = await import('../src/shared/speech.ts');
  const provider = { voices: speechVoices, defaultVoice: 'local:af_heart' };
  let calls = 0;
  let language: unknown = 'fr-FR';
  const review = async (_instructions: string, input: object) => {
    calls++;
    const request = input as { text: string; availableLanguages: string[] };
    assert.equal(request.text, 'Une réponse dans la langue de notre conversation.');
    assert.ok(!request.availableLanguages.includes('ja-jp'));
    return { language };
  };
  const select = () =>
    automaticSpeechVoice(provider, 'Une réponse dans la langue de notre conversation.', review);
  assert.equal(await select(), 'local:ff_siwis');
  for (language of ['FR', ' FR_fr ', 'fr-FR-u-ca-gregory'])
    assert.equal(await select(), 'local:ff_siwis');
  for (language of ['ja-JP', null, 42, 'local:pf_dora', 'fr--FR', 'fr/<script>'])
    assert.equal(await select(), 'local:af_heart');
  const before = calls;
  assert.equal(
    await automaticSpeechVoice(
      { ...provider, defaultVoice: 'openai:coral' },
      'A multilingual reply.',
      review,
    ),
    'openai:coral',
  );
  assert.equal(
    await automaticSpeechVoice(
      {
        ...provider,
        voices: speechVoices.filter(
          (voice) => 'language' in voice && voice.language.startsWith('en'),
        ),
      },
      'An English reply.',
      review,
    ),
    'local:af_heart',
  );
  assert.equal(calls, before);
  assert.equal(
    await automaticSpeechVoice(provider, 'A reply after classification fails.', async () => {
      throw new Error('Synthetic language classification failure.');
    }),
    'local:af_heart',
  );
  const controller = new AbortController();
  const pending = automaticSpeechVoice(
    provider,
    'A cancelled reply.',
    async () => new Promise(() => {}),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('OpenRouter speech reuses the current key for selected voices and never silently changes the selected engine', async () => {
  let key: string | undefined = 'fixture-openrouter-first';
  const requests: { authorization: string | null; body: Record<string, unknown> }[] = [];
  const usage: import('../src/ports/provider-usage.ts').ProviderUsageEvent[] = [];
  const provider = createOpenRouterSpeechProvider({
    apiKey: async () => key,
    configured: () => Boolean(key),
    fetch: async (url, init) => {
      assert.equal(String(url), 'https://openrouter.ai/api/v1/audio/speech');
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal);
      requests.push({
        authorization: new Headers(init.headers).get('authorization'),
        body: JSON.parse(String(init.body)),
      });
      return new Response(Buffer.from('synthetic mp3'), {
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    },
  });
  const service = createSpeech({
    ...provider,
    get configured() {
      return provider.configured;
    },
    synthesize: (text, signal, _report, options) =>
      provider.synthesize(text, signal, (event) => usage.push(event), options),
  });
  assert.equal(service.configured, true);
  assert.equal(service.transcriptionConfigured, false);
  const audio = await service.synthesize('Synthetic reply.', undefined, {
    voice: 'elevenlabs:brian',
  });
  assert.equal(audio.mimeType, 'audio/mpeg');
  assert.equal(audio.fileName, 'reply.mp3');
  assert.deepEqual(requests[0].body, {
    model: 'elevenlabs/eleven-v4-turbo',
    input: 'Synthetic reply.',
    voice: 'brian',
    response_format: 'mp3',
  });
  key = 'fixture-openrouter-rotated';
  await service.synthesize('Another synthetic reply.', undefined, { voice: 'kokoro:bf_emma' });
  assert.equal(requests[1].body.model, 'hexgrad/kokoro-82m');
  assert.equal(requests[1].body.voice, 'bf_emma');
  assert.equal(requests[1].authorization, 'Bearer fixture-openrouter-rotated');
  for (const voice of ['openai:coral', 'local:af_heart', 'elevenlabs:missing', ''])
    await assert.rejects(service.synthesize('Synthetic reply.', undefined, { voice }));
  key = undefined;
  assert.equal(service.configured, false);
  await assert.rejects(service.synthesize('Synthetic reply.'));
  await assert.rejects(provider.synthesize('Synthetic reply.'));
  assert.equal(requests.length, 2);
  assert.equal(usage.length, 2);
  assert.notEqual(usage[0].id, usage[1].id);
  assert.equal(usage[0].costUsd, null);
  assert.equal(usage[0].pricing, 'unavailable');
  assert.equal(usage[1].model, 'hexgrad/kokoro-82m');
  assert.doesNotMatch(
    JSON.stringify(usage),
    /fixture-openrouter|Synthetic|synthetic mp3|brian|bf_emma/,
  );
});

test('OpenRouter speech refuses failed, empty, oversized and non-audio responses and honors cancellation', async () => {
  let failure: 'status' | 'mime' | 'empty' | 'size' | 'abort' = 'status';
  let cancelled = 0;
  let calls = 0;
  const controller = new AbortController();
  const usage: import('../src/ports/provider-usage.ts').ProviderUsageEvent[] = [];
  const provider = createOpenRouterSpeechProvider({
    apiKey: async () => 'fixture-never-live',
    configured: () => true,
    fetch: async (_url, init) => {
      calls++;
      if (failure === 'abort') {
        controller.abort();
        init!.signal!.throwIfAborted();
      }
      return new Response(
        new ReadableStream({
          start(stream) {
            if (failure === 'empty') stream.close();
            if (failure === 'size') stream.enqueue(Buffer.alloc(50 * 1024 * 1024 + 1));
          },
          cancel() {
            cancelled++;
          },
        }),
        {
          status: failure === 'status' ? 503 : 200,
          headers: { 'Content-Type': failure === 'mime' ? 'application/json' : 'audio/mpeg' },
        },
      );
    },
  });
  for (failure of ['status', 'mime', 'empty', 'size', 'abort'] as const)
    await assert.rejects(
      provider.synthesize('Synthetic reply.', controller.signal, (event) => usage.push(event)),
    );
  assert.equal(calls, 5);
  assert.equal(cancelled, 3);
  assert.deepEqual(
    usage.map((event) => event.status),
    ['failed', 'failed', 'failed', 'failed', 'cancelled'],
  );
  await assert.rejects(provider.synthesize('Synthetic reply.', controller.signal));
  assert.equal(calls, 5);
  const abortWhileResolvingKey = new AbortController();
  const late = createOpenRouterSpeechProvider({
    apiKey: async () => {
      abortWhileResolvingKey.abort();
      return 'fixture-never-live';
    },
    configured: () => true,
    fetch: async () => {
      throw new Error('A cancelled request must not be sent.');
    },
  });
  await assert.rejects(late.synthesize('Synthetic reply.', abortWhileResolvingKey.signal), {
    name: 'AbortError',
  });
});

test('ElevenLabs lists owned custom voices with bounded pagination and never follows provider redirects', async () => {
  const calls: URL[] = [];
  const voices = await readElevenLabsVoices('fixture-elevenlabs-key', async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(url.origin, 'https://api.elevenlabs.io');
    assert.equal(url.pathname, '/v2/voices');
    assert.equal(url.searchParams.get('page_size'), '100');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('xi-api-key'), 'fixture-elevenlabs-key');
    assert.ok(init?.signal);
    return Response.json(
      calls.length === 1
        ? {
            voices: [
              {
                voice_id: 'fixture_voice_alpha',
                name: 'My custom voice',
                description: 'Warm and clear',
              },
              { voice_id: '../../other', name: 'Invalid path' },
            ],
            has_more: true,
            next_page_token: 'fixture-next',
          }
        : {
            voices: [
              {
                voice_id: 'fixture_voice_beta',
                name: 'Second voice',
                labels: { accent: 'British', descriptive: 'Soft' },
                preview_url: 'https://untrusted.example.test/private.mp3',
              },
            ],
            has_more: false,
            next_page_token: null,
          },
    );
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].searchParams.get('next_page_token'), 'fixture-next');
  assert.deepEqual(
    voices.map((voice) => [voice.id, voice.name, voice.engine, voice.source]),
    [
      ['elevenlabs-direct:fixture_voice_alpha', 'My custom voice', 'ElevenLabs', 'elevenlabs'],
      ['elevenlabs-direct:fixture_voice_beta', 'Second voice', 'ElevenLabs', 'elevenlabs'],
    ],
  );
  assert.doesNotMatch(JSON.stringify(voices), /preview_url|untrusted/);
  let repeated = 0;
  await assert.rejects(
    readElevenLabsVoices('fixture-private-key', async () => {
      repeated++;
      return Response.json({ voices: [], has_more: true, next_page_token: 'same' });
    }),
    /voice/i,
  );
  assert.equal(repeated, 2);
  await assert.rejects(
    readElevenLabsVoices(
      'fixture-private-key',
      async () => new Response('fixture-private-key', { status: 401 }),
    ),
    (error) => error instanceof Error && !error.message.includes('fixture-private-key'),
  );
});

test('ElevenLabs accepts first-page default voices beyond the requested page size', async () => {
  const voices = await readElevenLabsVoices('fixture-key', async () =>
    Response.json({
      voices: Array.from({ length: 120 }, (_, index) => ({
        voice_id: `fixture_${index}`,
        name: `Voice ${index}`,
      })),
      has_more: false,
    }),
  );
  assert.equal(voices.length, 120);
  assert.equal(voices.at(-1)?.id, 'elevenlabs-direct:fixture_119');
});

test('ElevenLabs direct speech uses account voices and current credentials without changing the chat provider', async () => {
  let key: string | undefined = 'fixture-elevenlabs-first';
  const requests: { url: string; key: string | null; body: unknown }[] = [];
  const usage: import('../src/ports/provider-usage.ts').ProviderUsageEvent[] = [];
  const provider = createElevenLabsSpeechProvider({
    apiKey: async () => key,
    configured: () => Boolean(key),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://api.elevenlabs.io');
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal);
      const authorization = new Headers(init?.headers).get('xi-api-key');
      if (url.pathname === '/v2/voices') {
        return Response.json({
          voices: [
            {
              voice_id: key?.endsWith('first') ? 'fixture_voice_alpha' : 'fixture_voice_beta',
              name: 'Custom voice',
            },
          ],
          has_more: false,
        });
      }
      requests.push({
        url: url.href,
        key: authorization,
        body: init?.body instanceof FormData ? init.body : JSON.parse(String(init?.body)),
      });
      return url.pathname === '/v1/speech-to-text'
        ? Response.json({ text: 'Olá, vamos começar.', language_code: 'por' })
        : new Response(Buffer.from('synthetic mp3'), {
            headers: { 'Content-Type': 'audio/mpeg', 'character-cost': '8' },
          });
    },
  });
  await provider.refreshVoices!();
  assert.equal(provider.defaultVoice, 'elevenlabs-direct:fixture_voice_alpha');
  assert.equal(provider.configured, true);
  assert.equal(provider.voices?.length, 1);
  const audio = await provider.synthesize(
    'A synthetic reply.',
    undefined,
    (event) => usage.push(event),
    { voice: 'elevenlabs-direct:fixture_voice_alpha' },
  );
  assert.equal(audio.mimeType, 'audio/mpeg');
  assert.equal(
    requests[0].url,
    'https://api.elevenlabs.io/v1/text-to-speech/fixture_voice_alpha?output_format=mp3_44100_128',
  );
  assert.deepEqual(requests[0].body, { text: 'A synthetic reply.', model_id: 'eleven_v4' });
  for (const voice of [
    'elevenlabs:sarah',
    'openai:coral',
    'elevenlabs-direct:missing',
    'elevenlabs-direct:../private',
  ])
    await assert.rejects(provider.synthesize('Do not send.', undefined, undefined, { voice }));
  assert.equal(requests.length, 1);
  key = 'fixture-elevenlabs-rotated';
  await assert.rejects(
    provider.synthesize('Do not send.', undefined, undefined, {
      voice: 'elevenlabs-direct:fixture_voice_alpha',
    }),
  );
  await provider.synthesize('Another synthetic reply.', undefined, (event) => usage.push(event), {
    voice: 'elevenlabs-direct:fixture_voice_beta',
  });
  assert.equal(requests[1].key, 'fixture-elevenlabs-rotated');
  const transcript = await provider.transcribe!(
    { bytes: Buffer.from('synthetic clip'), mimeType: 'audio/mp4', name: 'voice.m4a' },
    undefined,
    (event) => usage.push(event),
  );
  assert.equal(transcript, 'Olá, vamos começar.');
  const form = requests[2].body as FormData;
  assert.equal(form.get('model_id'), 'scribe_v2');
  assert.equal(form.get('tag_audio_events'), 'false');
  assert.equal(form.get('diarize'), 'false');
  assert.equal(form.get('language_code'), null);
  assert.equal((form.get('file') as File).type, 'audio/mp4');
  assert.equal(await (form.get('file') as File).text(), 'synthetic clip');
  assert.deepEqual(
    usage.map((event) => [event.provider, event.model, event.status, event.costUsd]),
    [
      ['elevenlabs', 'eleven_v4', 'succeeded', null],
      ['elevenlabs', 'eleven_v4', 'succeeded', null],
      ['elevenlabs', 'scribe_v2', 'succeeded', null],
    ],
  );
  assert.doesNotMatch(JSON.stringify(usage), /fixture-|synthetic|Olá/);
  key = undefined;
  assert.equal(provider.configured, false);
  assert.deepEqual(provider.voices, []);
  await assert.rejects(provider.synthesize('Do not send.'));
  await assert.rejects(
    provider.transcribe!({ bytes: Buffer.from('x'), mimeType: 'audio/wav', name: 'voice.wav' }),
  );
  assert.equal(requests.length, 3);
});

test('ElevenLabs voice refresh bypasses cache explicitly and discards results after key removal', async () => {
  let key: string | undefined = 'fixture-elevenlabs-key';
  let calls = 0;
  let removeDuringRequest = false;
  const provider = createElevenLabsSpeechProvider({
    apiKey: async () => key,
    configured: () => Boolean(key),
    fetch: async () => {
      calls++;
      if (removeDuringRequest) key = undefined;
      return Response.json({
        voices: [{ voice_id: `fixture_voice_${calls}`, name: `Voice ${calls}` }],
        has_more: false,
      });
    },
  });
  const service = createSpeech(provider);
  await service.refreshVoices();
  await service.refreshVoices();
  assert.equal(calls, 1);
  assert.equal(service.voices[0].id, 'elevenlabs-direct:fixture_voice_1');
  await service.refreshVoices(undefined, true);
  assert.equal(calls, 2);
  assert.equal(service.voices[0].id, 'elevenlabs-direct:fixture_voice_2');
  removeDuringRequest = true;
  await assert.rejects(service.refreshVoices(undefined, true));
  assert.equal(calls, 3);
  assert.deepEqual(service.voices, []);
  await assert.rejects(provider.synthesize('Never send.'));
  assert.equal(calls, 3);
});

test('ElevenLabs catalog ordering preserves newer voices and fences cancelled or replaced credentials', async (t) => {
  for (const scenario of ['newer', 'cancelled', 'rotated'] as const)
    await t.test(scenario, async () => {
      let key = 'fixture-original-key';
      let catalogCalls = 0;
      const synthesis: { voice: string; key: string | null }[] = [];
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => (entered = resolve));
      const held = new Promise<void>((resolve) => (release = resolve));
      const newer = new AbortController();
      const provider = createElevenLabsSpeechProvider({
        apiKey: async () => key,
        configured: () => true,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname !== '/v2/voices') {
            synthesis.push({
              voice: url.pathname.split('/').at(-1)!,
              key: new Headers(init?.headers).get('xi-api-key'),
            });
            return new Response('synthetic audio', {
              headers: { 'Content-Type': 'audio/mpeg' },
            });
          }
          const call = ++catalogCalls;
          if (call === 1) {
            entered();
            await held;
          } else if (scenario === 'cancelled') newer.abort();
          const ids =
            call === 1
              ? ['common_voice']
              : scenario === 'rotated'
                ? ['rotated_voice']
                : ['common_voice', 'new_voice'];
          return Response.json({
            voices: ids.map((voice_id) => ({ voice_id, name: voice_id })),
            has_more: false,
          });
        },
      });
      const older = provider
        .synthesize('Synthetic reply.', undefined, undefined, {
          voice: 'elevenlabs-direct:common_voice',
        })
        .then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
      try {
        await started;
        if (scenario === 'rotated') key = 'fixture-rotated-key';
        if (scenario === 'cancelled')
          await assert.rejects(provider.refreshVoices!(newer.signal, true));
        else await provider.refreshVoices!(newer.signal, true);
        release();
        const result = await older;
        if (scenario === 'rotated') {
          assert.ok(result.error instanceof Error);
          assert.equal(synthesis.length, 0);
          assert.deepEqual(
            provider.voices?.map((voice) => voice.id),
            ['elevenlabs-direct:rotated_voice'],
          );
        } else {
          assert.equal(result.error, undefined);
          assert.equal(result.value?.bytes.toString(), 'synthetic audio');
          assert.deepEqual(
            provider.voices?.map((voice) => voice.id),
            scenario === 'cancelled'
              ? ['elevenlabs-direct:common_voice']
              : ['elevenlabs-direct:common_voice', 'elevenlabs-direct:new_voice'],
          );
        }
        if (scenario !== 'cancelled')
          await provider.synthesize('Another synthetic reply.', undefined, undefined, {
            voice: `elevenlabs-direct:${scenario === 'rotated' ? 'rotated_voice' : 'new_voice'}`,
          });
        assert.equal(catalogCalls, 2);
        assert.equal(synthesis.length, scenario === 'newer' ? 2 : 1);
        assert.ok(synthesis.every((request) => request.key === key));
      } finally {
        release();
        await older;
      }
    });
  await t.test('restored credential after failed discovery', async () => {
    let key = 'fixture-original-key';
    let catalogCalls = 0;
    const provider = createElevenLabsSpeechProvider({
      apiKey: async () => key,
      configured: () => true,
      fetch: async () => {
        catalogCalls++;
        if (key === 'fixture-rotated-key') return new Response('', { status: 503 });
        return Response.json({
          voices: [{ voice_id: 'original_voice', name: 'Original' }],
          has_more: false,
        });
      },
    });
    await provider.refreshVoices!();
    key = 'fixture-rotated-key';
    await assert.rejects(provider.refreshVoices!());
    assert.equal(provider.voices?.length, 0);
    key = 'fixture-original-key';
    await provider.refreshVoices!();
    assert.equal(catalogCalls, 3);
    assert.equal(provider.voices?.[0].id, 'elevenlabs-direct:original_voice');
  });
});

test('ElevenLabs refuses failed, malformed and oversized audio without leaking provider data or retrying', async () => {
  let mode: 'status' | 'mime' | 'empty' | 'size' | 'abort' = 'status';
  let calls = 0;
  let cancelled = 0;
  const controller = new AbortController();
  const usage: import('../src/ports/provider-usage.ts').ProviderUsageEvent[] = [];
  const provider = createElevenLabsSpeechProvider({
    apiKey: async () => 'fixture-private-key',
    configured: () => true,
    fetch: async (input, init) => {
      if (new URL(String(input)).pathname === '/v2/voices')
        return Response.json({
          voices: [{ voice_id: 'fixture_voice', name: 'Fixture' }],
          has_more: false,
        });
      calls++;
      if (mode === 'abort') {
        controller.abort();
        init!.signal!.throwIfAborted();
      }
      return new Response(
        new ReadableStream({
          start(stream) {
            if (mode === 'empty') stream.close();
            if (mode === 'size') stream.enqueue(Buffer.alloc(50 * 1024 * 1024 + 1));
          },
          cancel() {
            cancelled++;
          },
        }),
        {
          status: mode === 'status' ? 503 : 200,
          headers: { 'Content-Type': mode === 'mime' ? 'application/json' : 'audio/mpeg' },
        },
      );
    },
  });
  for (mode of ['status', 'mime', 'empty', 'size', 'abort'] as const)
    await assert.rejects(
      provider.synthesize('Synthetic private message.', controller.signal, (event) =>
        usage.push(event),
      ),
      (error) => error instanceof Error && !/fixture-private|Synthetic/.test(error.message),
    );
  assert.equal(calls, 5);
  assert.equal(cancelled, 3);
  assert.deepEqual(
    usage.map((event) => event.status),
    ['failed', 'failed', 'failed', 'failed', 'cancelled'],
  );
  assert.doesNotMatch(JSON.stringify(usage), /fixture-private|Synthetic/);
  await assert.rejects(provider.synthesize('Never send.', controller.signal));
  assert.equal(calls, 5);
});

test('ElevenLabs preserves safe setup recovery through the speech service without exposing response data', async () => {
  for (const operation of ['synthesize', 'transcribe'] as const) {
    for (const status of [401, 403, 429, 503]) {
      let calls = 0;
      const usage: import('../src/ports/provider-usage.ts').ProviderUsageEvent[] = [];
      const provider = createElevenLabsSpeechProvider({
        apiKey: async () => 'fixture-private-key',
        configured: () => true,
        fetch: async (input) => {
          if (new URL(String(input)).pathname === '/v2/voices')
            return Response.json({
              voices: [{ voice_id: 'fixture_voice', name: 'Fixture' }],
              has_more: false,
            });
          calls++;
          return new Response('fixture-private-key and synthetic private transcript', { status });
        },
      });
      const speech = createSpeech({
        ...provider,
        synthesize: (text, signal, _report, options) =>
          provider.synthesize(text, signal, (event) => usage.push(event), options),
        transcribe: (audio, signal) =>
          provider.transcribe!(audio, signal, (event) => usage.push(event)),
      });
      await assert.rejects(
        operation === 'synthesize'
          ? speech.synthesize('Synthetic private message.')
          : speech.transcribe({
              bytes: Buffer.from('synthetic clip'),
              mimeType: 'audio/wav',
              name: 'voice.wav',
            }),
        (error) => {
          assert.ok(error instanceof Error);
          assert.doesNotMatch(error.message, /fixture-private|synthetic private|Synthetic private/);
          if (status === 401) assert.match(error.message, /ElevenLabs.*API key.*reconnect/i);
          if (status === 403)
            assert.match(
              error.message,
              operation === 'synthesize'
                ? /Text to speech.*permission/i
                : /Speech to text.*permission/i,
            );
          if (status === 429) {
            assert.match(error.message, /ElevenLabs.*limit.*account/i);
            assert.doesNotMatch(error.message, /credits|balance|quota|rate|retry/i);
          }
          assert.equal((error as Error & { statusCode?: number }).statusCode, 400);
          return true;
        },
      );
      assert.equal(calls, 1);
      assert.equal(usage.length, 1);
      assert.equal(usage[0].status, 'failed');
      assert.doesNotMatch(
        JSON.stringify(usage),
        /fixture-private|synthetic private|Synthetic private/,
      );
    }
  }
});

test('local pronunciation uses each bundled language dictionary and preserves Kokoro phonemes', async () => {
  const cases = [
    ['en-us', 'red fox', 'ɹˈɛd fˈɑːks'],
    ['en-gb', 'red fox', 'ɹˈɛd fˈɒks'],
    ['es', 'rojo chico', 'rˈoxo ʧˈiko'],
    ['fr-fr', 'Bonjour Jean', 'bɔ̃ʒˈuʁ ʒˈɑ̃'],
    ['hi', 'नमस्ते दुनिया', 'nəmˈʌsteː dˈʊnɪjˌaː'],
    ['it', 'Ciao ragazzo', 'ʧˈao raɡˈaʦːo'],
  ] as const;
  for (const [language, text, expected] of cases)
    assert.equal(await phonemizeSpeech(text, language), expected, language);
  await assert.rejects(phonemizeSpeech('x'.repeat(2_001), 'en-us'));
  const unsupported = await runProcess(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL('../src/providers/local-speech/phonemizer-worker.ts', import.meta.url)),
    ],
    { input: JSON.stringify({ text: 'Synthetic words', voice: 'missing' }), timeoutMs: 15_000 },
  );
  assert.equal(unsupported.exitCode, 1);
  assert.equal(unsupported.stdout, '');
});

test('local speech setup keeps each caller cancellable and stops only after the last caller leaves', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nod-speech-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = join(root, 'worker.mjs');
  await writeFile(
    worker,
    `
    let id;
    process.on('message', (message) => {
      if (message.method === 'prepare') {
        id = message.id;
        process.send({ id, type: 'progress', progress: 1 });
      } else if (message.method === 'finish') process.send({ id, type: 'ready' });
    });
  `,
  );
  for (const [transcription, cancelledIndex] of [false, true].flatMap((input) =>
    ([1, 0, 'both', 'close'] as const).map((cancelledIndex) => [input, cancelledIndex] as const),
  )) {
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const children: ReturnType<typeof fork>[] = [];
    const provider = createLocalSpeechProvider({
      cacheDir: join(root, `${transcription}-${cancelledIndex}`),
      fork: (_path, args, options) => {
        const child = fork(worker, args, options);
        children.push(child);
        child.once('message', () => started());
        return child;
      },
    });
    try {
      const controllers = [new AbortController(), new AbortController()];
      const results = controllers.map((controller) =>
        (transcription
          ? provider.prepareTranscription(controller.signal)
          : provider.prepare(controller.signal)
        ).then(
          () => 'ready',
          (error: Error) => error.name,
        ),
      );
      await running;
      if (cancelledIndex === 'close') {
        await provider.close();
        assert.deepEqual(await Promise.all(results), ['Error', 'Error']);
      } else if (cancelledIndex === 'both') {
        const exited = new Promise<void>((resolve) => children[0].once('exit', () => resolve()));
        controllers[0].abort();
        controllers[1].abort();
        assert.deepEqual(await Promise.all(results), ['AbortError', 'AbortError']);
        await exited;
        assert.equal(
          (transcription ? provider.transcriptionStatus() : provider.status()).state,
          'not_downloaded',
        );
      } else {
        controllers[cancelledIndex].abort();
        assert.equal(
          await Promise.race([
            results[cancelledIndex],
            new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 500)),
          ]),
          'AbortError',
        );
        assert.equal(children[0].signalCode, null);
        children[0].send({ method: 'finish' });
        assert.equal(await results[1 - cancelledIndex], 'ready');
        assert.equal(provider.transcriptionConfigured, true);
        assert.equal(provider.configured, !transcription);
      }
      assert.equal(children.length, 1);
    } finally {
      await provider.close();
    }
  }
});

test('local transcription prepares only input assets and keeps voice synthesis unavailable until requested', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nod-speech-input-'));
  const worker = join(root, 'worker.mjs');
  await writeFile(
    worker,
    `
    process.on('message', (message) => {
      if (message.method === 'prepare') process.send({ id: message.id, type: 'ready' });
      else if (message.method === 'transcribe') process.send({ id: message.id, type: 'text', text: 'Synthetic recorded words.' });
    });
  `,
  );
  const requests: { method: string; transcription?: boolean }[] = [];
  const provider = createLocalSpeechProvider({
    cacheDir: join(root, 'models'),
    fork: (_path, args, options) => {
      const child = fork(worker, args, options);
      const send = child.send.bind(child);
      child.send = ((message: { method: string; transcription?: boolean }, ...rest: unknown[]) => {
        requests.push(message);
        return Reflect.apply(send, child, [message, ...rest]);
      }) as typeof child.send;
      return child;
    },
  });
  t.after(async () => {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([provider.prepareTranscription(), provider.prepareTranscription()]);
  assert.deepEqual(
    requests.map(({ method, transcription }) => ({ method, transcription })),
    [{ method: 'prepare', transcription: true }],
  );
  assert.equal(provider.transcriptionConfigured, true);
  assert.equal(provider.configured, false);
  assert.equal(provider.status().state, 'not_downloaded');
  assert.equal(provider.transcriptionStatus().state, 'ready');
  assert.equal(
    await provider.transcribe!({
      bytes: new Uint8Array([1]),
      mimeType: 'audio/wav',
      name: 'synthetic.wav',
    }),
    'Synthetic recorded words.',
  );
  await assert.rejects(provider.synthesize('Synthetic reply.'));
  await provider.prepare();
  assert.equal(provider.configured, true);
  assert.equal(requests.at(-1)?.transcription, false);
  const count = requests.length;
  await provider.prepareTranscription();
  assert.equal(requests.length, count);
});

test('local speech failures stay within their preparation mode and do not block independent input setup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nod-speech-failures-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worker = join(root, 'worker.mjs');
  await writeFile(
    worker,
    `
    let pending;
    process.on('message', (message) => {
      if (message.method === 'fail') {
        process.send({ id: pending, type: 'failed' });
        return;
      }
      if (message.method !== 'prepare') return;
      if (process.argv[3] === 'exit-input') process.exit(1);
      else if (message.transcription) process.send({ id: message.id, type: 'ready' });
      else {
        pending = message.id;
        process.send({ id: message.id, type: 'progress', progress: 1 });
      }
    });
  `,
  );
  for (const scenario of ['exit-input', 'independent-input', 'same-mode', 'cancel-input'])
    await t.test(scenario, async () => {
      let started!: () => void;
      let failPreparation!: () => void;
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      const requests: Array<{ method: string; transcription?: boolean }> = [];
      const provider = createLocalSpeechProvider({
        cacheDir: join(root, scenario),
        fork: (_path, args, options) => {
          const child = fork(worker, [...args, scenario], options);
          child.once('message', () => started());
          const send = child.send.bind(child);
          failPreparation = () => {
            send({ method: 'fail' });
          };
          child.send = ((
            message: { method: string; transcription?: boolean },
            ...rest: unknown[]
          ) => {
            requests.push(message);
            return Reflect.apply(send, child, [message, ...rest]);
          }) as typeof child.send;
          return child;
        },
      });
      try {
        if (scenario === 'exit-input') {
          await assert.rejects(provider.prepareTranscription(), /Local speech stopped/);
          assert.equal(provider.transcriptionStatus().state, 'failed');
          assert.equal(provider.status().state, 'not_downloaded');
          return;
        }
        const failed = assert.rejects(provider.prepare(), /Local speech failed/);
        await running;
        const controller = new AbortController();
        const next =
          scenario === 'same-mode'
            ? provider.prepare(controller.signal)
            : provider.prepareTranscription(controller.signal);
        await Promise.resolve();
        if (scenario === 'cancel-input') {
          const cancelled = assert.rejects(next, { name: 'AbortError' });
          controller.abort();
          await cancelled;
        }
        failPreparation();
        if (scenario === 'same-mode') await assert.rejects(next, /Local speech failed/);
        else if (scenario !== 'cancel-input') await next;
        await failed;
        assert.equal(provider.status().state, 'failed');
        assert.equal(provider.transcriptionConfigured, scenario === 'independent-input');
        assert.deepEqual(
          requests.map(({ transcription }) => transcription),
          scenario === 'independent-input' ? [false, true] : [false],
        );
      } finally {
        await provider.close();
      }
    });
});

test('on-device speech starts only when enabled, isolates the worker environment, and kills cancelled work without replay', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nod-speech-worker-'));
  const worker = join(root, 'worker.mjs');
  await writeFile(
    worker,
    `
    process.on('message', (message) => {
      if (message.method === 'prepare') {
        process.send({ id: message.id, type: 'ready' });
      } else if (message.method === 'transcribe') {
        process.send({ id: message.id, type: 'failed', reason: message.mimeType.slice('audio/'.length) });
      } else if (message.text === 'Synthetic worker exit.') {
        process.exit(1);
      } else if (message.text !== 'Synthetic delayed reply.') {
        const bytes = new Uint8Array(46);
        process.send({ id: message.id, type: 'audio', bytes });
      }
    });
  `,
  );
  const children: ReturnType<typeof fork>[] = [];
  const provider = createLocalSpeechProvider({
    cacheDir: join(root, 'models'),
    fork: (_path, args, options) => {
      assert.deepEqual(
        Object.keys(options!.env!)
          .sort()
          .filter(
            (name) =>
              ![
                'PATH',
                'SystemRoot',
                'TMPDIR',
                'TMP',
                'TEMP',
                'LANG',
                'ELECTRON_RUN_AS_NODE',
              ].includes(name),
          ),
        [],
      );
      assert.equal(options!.serialization, 'advanced');
      const child = fork(worker, args, options);
      children.push(child);
      return child;
    },
  });
  t.after(async () => {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(provider.configured, false);
  await assert.rejects(provider.synthesize('Synthetic reply.'));
  assert.equal(children.length, 0);
  await provider.prepare();
  assert.equal(provider.configured, true);
  assert.equal(provider.transcriptionConfigured, true);
  const service = createSpeech(provider);
  for (const [reason, expected] of [
    ['silence', /No speech was detected/],
    ['length', /under five minutes/],
    ['format', /supports WebM/],
    ['private-diagnostic', /Local speech failed/],
  ] as const) {
    await assert.rejects(
      service.transcribe({
        bytes: Buffer.from('Synthetic recording'),
        mimeType: `audio/${reason}`,
        name: 'voice.wav',
      }),
      (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 400);
        assert.match((error as Error).message, expected);
        assert.doesNotMatch((error as Error).message, /private-diagnostic/);
        return true;
      },
    );
  }
  await assert.rejects(
    provider.synthesize('Synthetic reply.', undefined, undefined, { voice: 'elevenlabs:sarah' }),
  );
  const controller = new AbortController();
  const cancelled = assert.rejects(
    provider.synthesize('Synthetic delayed reply.', controller.signal),
    { name: 'AbortError' },
  );
  const queued = assert.rejects(provider.synthesize('Synthetic queued reply.'), {
    name: 'AbortError',
  });
  const stopped = new Promise<void>((resolve) => children[0].once('exit', () => resolve()));
  controller.abort();
  await Promise.all([cancelled, queued, stopped]);
  assert.equal(children[0].signalCode, 'SIGKILL');
  assert.equal(children.length, 1);
  assert.equal((await provider.synthesize('Synthetic new reply.')).mimeType, 'audio/wav');
  assert.equal(children.length, 2);
  await assert.rejects(service.synthesize('Synthetic worker exit.'), (error: unknown) => {
    assert.equal((error as { statusCode?: number }).statusCode, 400);
    assert.match((error as Error).message, /Local speech stopped/);
    return true;
  });
  assert.equal(provider.status().state, 'failed');
  await provider.close();
  assert.equal(provider.configured, false);
  await assert.rejects(provider.prepare());
});

test('on-device speech decodes a real WAV into bounded mono samples and refuses unsupported recordings', async (t) => {
  const samples = 48000;
  const wav = Buffer.alloc(44 + samples * 4);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(48000 * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 4, 40);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(Math.sin((i * 2 * Math.PI * 440) / 48000) * 12000);
    wav.writeInt16LE(value, 44 + i * 4);
    wav.writeInt16LE(value, 46 + i * 4);
  }
  const decoded = await decodeLocalAudio(wav, 'audio/wav');
  assert.ok(Math.abs(decoded.length - 16000) < 4);
  const rms = Math.sqrt(decoded.reduce((sum, value) => sum + value * value, 0) / decoded.length);
  assert.ok(rms > 0.2 && rms < 0.3);
  const transported = Buffer.alloc(wav.length + 1);
  wav.copy(transported, 1);
  assert.deepEqual(await decodeLocalAudio(transported.subarray(1), 'audio/wav'), decoded);
  const muted = Buffer.from(wav);
  muted.fill(0, 44);
  await assert.rejects(decodeLocalAudio(muted, 'audio/wav'), { message: 'silence' });
  await assert.rejects(decodeLocalAudio(wav, 'audio/mp4'));
  await assert.rejects(decodeLocalAudio(Buffer.alloc(0), 'audio/wav'));
  await t.test('padded metadata leaves the decoded samples unchanged', async () => {
    const metadata = Buffer.alloc(10);
    metadata.write('JUNK');
    metadata.writeUInt32LE(1, 4);
    metadata[8] = 65;
    const padded = Buffer.concat([wav.subarray(0, 12), metadata, wav.subarray(12)]);
    padded.writeUInt32LE(padded.length - 8, 4);
    assert.deepEqual(await decodeLocalAudio(padded, 'audio/wav'), decoded);
  });
  const extensible = Buffer.concat([wav.subarray(0, 36), Buffer.alloc(24), wav.subarray(36)]);
  extensible.writeUInt32LE(extensible.length - 8, 4);
  extensible.writeUInt32LE(40, 16);
  extensible.writeUInt16LE(0xfffe, 20);
  extensible.writeUInt16LE(22, 36);
  extensible.writeUInt16LE(16, 38);
  extensible.writeUInt32LE(3, 40);
  extensible.writeUInt32LE(1, 44);
  Buffer.from('00001000800000aa00389b71', 'hex').copy(extensible, 48);
  assert.deepEqual(await decodeLocalAudio(extensible, 'audio/wav'), decoded);
  for (const [offset, value] of [
    [36, 21],
    [36, 24],
    [38, 0],
    [38, 17],
    [40, 7],
    [42, 0x8000],
    [46, 1],
    [58, 0],
  ])
    await t.test(`invalid extensible field at ${offset} is rejected`, async () => {
      const invalid = Buffer.from(extensible);
      invalid.writeUInt16LE(value, offset);
      await assert.rejects(decodeLocalAudio(invalid, 'audio/wav'), { message: 'format' });
    });
  await t.test('truncated data is rejected', async () => {
    await assert.rejects(decodeLocalAudio(wav.subarray(0, wav.length - 4), 'audio/wav'), {
      message: 'format',
    });
  });
});

test('local speech exports chunked audio as WAV and finds the silence token without loading a model', async () => {
  const { RawAudio, PreTrainedTokenizer } = await import('@huggingface/transformers');
  const samples = Float32Array.from(
    { length: 24000 },
    (_, index) => Math.sin((index * 2 * Math.PI * 440) / 24000) * 0.25,
  );
  const audio = new RawAudio([samples.subarray(0, 5000), samples.subarray(5000)], 24000);
  assert.deepEqual(audio.data, samples);
  const bytes = new Uint8Array(await audio.toBlob().arrayBuffer());
  const decoded = await decodeLocalAudio(bytes, 'audio/wav');
  assert.equal(decoded.length, 16000);
  const rms = Math.sqrt(decoded.reduce((sum, value) => sum + value * value, 0) / decoded.length);
  assert.ok(rms > 0.17 && rms < 0.18);
  const tokenizer = new PreTrainedTokenizer(
    {
      model: {
        type: 'WordLevel',
        vocab: { '[UNK]': 0, '<|nocaptions|>': 1 },
        unk_token: '[UNK]',
      },
      added_tokens: [],
      normalizer: null,
      pre_tokenizer: null,
      post_processor: null,
      decoder: null,
    },
    { unk_token: '[UNK]' },
  );
  assert.equal(tokenizer.convert_tokens_to_ids('<|nocaptions|>'), 1);
  assert.equal(tokenizer.convert_tokens_to_ids('absent'), undefined);
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
      'CREATE TABLE artifacts(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid,name text,mime_type text,size int,storage_path text,expires_at timestamptz,deleting_at timestamptz)',
    );
    const artifacts = createArtifactService({ database: pool, ownerId: owner, localRoot: root });
    let reads = 0;
    let message: InboundMessage;
    const submissions: { text: string; attachments: Artifact[] }[] = [];
    const acceptedChannels: string[] = [];
    const privateCodes: string[] = [];
    const presentations: { kind: string; reason?: string }[] = [];
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
      transcribe: async () => transcript,
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
        messageAccepted: () => (channel) => acceptedChannels.push(channel),
        submit: async (
          text,
          sourceId,
          client,
          channel,
          _messageId,
          answer,
          _reply,
          files,
          onInserted,
        ) => {
          assert.equal(answer, undefined);
          submissions.push({ text, attachments: files ?? [] });
          const turnId = await fixtureTurn(client, threadId, owner, channel, sourceId);
          onInserted?.();
          return turnId;
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
    assert.deepEqual(acceptedChannels, ['telegram']);
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
    assert.deepEqual(acceptedChannels, ['telegram']);
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
    assert.deepEqual(acceptedChannels, ['telegram']);
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
    assert.equal(
      (await readdir(join(root, 'artifacts', createHash('sha256').update(owner).digest('hex'))))
        .length,
      stored,
    );
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

test(
  'media recovery carries only the authenticated caption into language context without admitting a task',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_channel_media_language_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const ownerId = 'fixture-owner';
    const threadId = await createFixtureTables(pool, ownerId);
    await pool.query('ALTER TABLE messages ADD COLUMN suggestions jsonb');
    await pool.query('CREATE TABLE chat_verification_submissions(message_id uuid PRIMARY KEY)');
    const reviewed: Array<{
      purpose: string;
      languageContext: { userMessages: Array<{ at: string; text: string }> };
      data: object;
    }> = [];
    const notice = 'Não consegui ler o anexo. Envia uma mensagem de texto.';
    const communication = createCommunication({
      pool,
      ownerId,
      review: async (_instructions, input) => {
        reviewed.push(structuredClone(input) as (typeof reviewed)[number]);
        return { text: notice };
      },
    });
    const sent: string[] = [];
    let submissions = 0;
    let message: InboundMessage = {
      channelId: 'telegram',
      accountId: 'fixture-account',
      senderId: 'fixture-sender',
      messageId: 'caption-with-history',
      threadId: 'fixture-chat',
      text: '',
      sentAt: new Date(),
      attachments: [{ ...attachment('voice.ogg', 'audio/ogg', 'synthetic audio'), voice: true }],
    };
    const channels = await createChannels(pool, {
      ownerId,
      transport: {
        channels: [
          {
            id: 'telegram',
            status: 'configured',
            accountId: 'fixture-account',
            allowedSenderIds: ['fixture-sender'],
            missing: [],
          },
        ],
        receive: async () => ({ status: 200, body: 'ok', messages: [message] }),
        post: async ({ text }) => {
          sent.push(text);
          return { id: `fixture-reply-${sent.length}` };
        },
        close: async () => {},
      },
      media: createChannelMedia({
        artifacts: {
          storeArtifact: async () => {
            throw new Error('Failed media must not be saved.');
          },
        },
        speech: { transcribe: async () => `unaccepted transcript ${'x'.repeat(100_001)}` },
      }),
      modelConfigured: () => true,
      activeThread: async () => ({ id: threadId }),
      present: communication.present,
      submit: async () => {
        submissions++;
        throw new Error('Failed media must not start a task.');
      },
      subscribe: () => () => {},
      intervalMs: 600_000,
    });
    const app = Fastify();
    channels.registerRoutes(app);
    t.after(() => app.close());
    const addHistory = async (text: string, at: Date, owner = ownerId) => {
      const id = randomUUID();
      await pool.query(
        "INSERT INTO messages(id,owner_id,thread_id,role,text,created_at) VALUES($1,$2,$3,'user',$4,$5)",
        [id, owner, threadId, text, at],
      );
      return id;
    };
    const now = Date.now();
    await addHistory('Please reply in English.', new Date(now - 3000));
    await addHistory('Foreign owner language request.', new Date(now - 1000), 'other-owner');
    const privateId = await addHistory('483729', new Date(now - 2000));
    await pool.query('INSERT INTO chat_verification_submissions VALUES($1)', [privateId]);
    const caption =
      'Responde em português. password=fixture-caption-secret https://example.test/private /vault/private-caption';
    message = { ...message, text: caption, sentAt: new Date(now) };
    const send = async () => {
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/webhooks/telegram', payload: {} }))
          .statusCode,
        200,
      );
      await channels.drain();
    };
    await send();
    await send();
    assert.equal(reviewed.length, 1);
    assert.equal(reviewed[0].purpose, 'media_failure');
    assert.deepEqual(reviewed[0].languageContext.userMessages, [
      { at: new Date(now - 3000).toISOString(), text: 'Please reply in English.' },
      { at: new Date(now).toISOString(), text: 'Responde em português. password=[redacted]' },
    ]);
    assert.deepEqual(reviewed[0].data, { kind: 'media_failure', reason: 'text_too_long' });
    assert.deepEqual(sent, [notice]);
    await pool.query("DELETE FROM messages WHERE role='user'");
    message = {
      ...message,
      messageId: 'caption-no-history',
      text: 'Olá, responde em português.',
      sentAt: new Date(now + 1),
    };
    await send();
    assert.deepEqual(reviewed[1].languageContext.userMessages, [
      { at: new Date(now + 1).toISOString(), text: message.text },
    ]);
    await addHistory('Réponds en français.', new Date(now + 3));
    message = { ...message, messageId: 'delayed-caption', sentAt: new Date(now + 2) };
    await send();
    assert.equal(reviewed[2].languageContext.userMessages.at(-1)!.text, 'Réponds en français.');
    for (const text of ['Código: 483729', 'cvv: 123']) {
      message = { ...message, messageId: randomUUID(), text };
      await send();
      assert.deepEqual(reviewed.at(-1)!.languageContext.userMessages, [
        { at: new Date(now + 3).toISOString(), text: 'Réponds en français.' },
      ]);
    }
    assert.equal(submissions, 0);
    assert.deepEqual(sent, Array(5).fill(notice));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM turns')).rows[0].n, 0);
    const stored = await pool.query('SELECT text,attachments FROM channel_inbox');
    assert.ok(stored.rows.every((row) => row.text === '' && row.attachments.length === 0));
    const queued = await pool.query('SELECT presentation FROM channel_outbox');
    assert.doesNotMatch(
      JSON.stringify([reviewed, stored.rows, queued.rows]),
      /fixture-caption-secret|private-caption|example\.test|unaccepted transcript|483729|cvv: 123|Foreign owner/,
    );
  },
);

async function createFixtureTables(pool: pg.Pool, owner: string) {
  await pool.query(`${locksTable};
    CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL,status text NOT NULL DEFAULT 'idle',created_at timestamptz NOT NULL DEFAULT now(),archived_at timestamptz);
    CREATE TABLE turns(id uuid PRIMARY KEY,parent_turn_id uuid,owner_id text NOT NULL,thread_id uuid NOT NULL REFERENCES threads(id),message_id uuid,source text NOT NULL DEFAULT 'user',source_id text UNIQUE,channel text NOT NULL DEFAULT 'web',channel_source_id text,status text NOT NULL DEFAULT 'queued',waiting_reason text,handoff_browser_id text,background boolean NOT NULL DEFAULT false,withdrawn boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,finished_at timestamptz,session_id uuid GENERATED ALWAYS AS (CASE WHEN background THEN id ELSE thread_id END) STORED);
    CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text NOT NULL,role text NOT NULL,text text NOT NULL,thread_id uuid REFERENCES threads(id),turn_id uuid REFERENCES turns(id),attachments jsonb NOT NULL DEFAULT '[]',presentation jsonb,answer_choices jsonb,reply_to_message_id uuid,delivered_channel text,assistant_reaction text,assistant_reacted_at timestamptz,hidden_at timestamptz,created_at timestamptz NOT NULL DEFAULT now())`);
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
  const modelsLink = await channelReply('Use [Reconnect](/settings/models).', {
    threadId: 'owned-thread',
  });
  assert.match(
    modelsLink,
    /Reconnect \(Settings > Models\): https:\/\/nod\.n8n\.io\/docs\/open\/#\/settings\/models/,
  );
  assert.doesNotMatch(modelsLink, /localhost|127\.0\.0\.1|nod:\/\//);
  const informationLink = await channelReply('See [Usage](/usage).', { threadId: 'owned-thread' });
  assert.match(informationLink, /Usage: https:\/\/nod\.n8n\.io\/docs\/open\/#\/usage/);
  const prepared = `/prepared/${randomUUID()}`;
  const resultLink = await channelReply(`See [Contract \\[reply\\]](${prepared}).`, {
    threadId: 'owned-thread',
  });
  assert.ok(resultLink.includes(`https://nod.n8n.io/docs/open/#${prepared}`));
  assert.doesNotMatch(resultLink, /localhost|127\.0\.0\.1|nod:\/\//);
  const adapted = await channelReply('/credentials/request-id', {
    threadId: 'owned-thread',
    present: async () => 'Open [Settings > Models](/settings/models).',
  });
  assert.match(adapted, /https:\/\/nod\.n8n\.io\/docs\/open\/#\/settings\/models/);
  const presentation: unknown[] = [];
  const present = async (threadId: string | null, input: unknown) => {
    presentation.push({ threadId, input });
    return 'Continua na aplicação Nod.';
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
    await channelReply(`Save it in Nod: ${page}?add=login`, { threadId: 'owned-thread', present });
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
    const handoffPresentations: unknown[] = [];
    const unavailableFiles: string[][] = [];
    const whatsappFileId = randomUUID();
    const pngId = randomUUID();
    const jpegId = randomUUID();
    const largeImageId = randomUUID();
    const brokenImageId = randomUUID();
    const wrongSizeImageId = randomUUID();
    const images = new Map<string, ReturnType<typeof attachment>>([
      [pngId, attachment('page.png', 'image/png', 'synthetic screenshot pixels')],
      [jpegId, attachment('venue.jpg', 'image/jpeg', 'synthetic venue pixels')],
      [
        largeImageId,
        {
          ...attachment('large.png', 'image/png', ''),
          size: 5 * 1024 * 1024 + 1,
          read: async () => {
            throw new Error('Oversized media must not be read.');
          },
        },
      ],
      [
        brokenImageId,
        {
          ...attachment('missing.png', 'image/png', 'missing'),
          read: async () => {
            throw new Error('Missing artifact.');
          },
        },
      ],
      [wrongSizeImageId, { ...attachment('changed.png', 'image/png', 'changed bytes'), size: 1 }],
    ]);
    const uploaded: Array<{ name: string; mimeType: string; bytes: Buffer }> = [];
    let uploadFailure: 'rejected' | 'network' | 'missing-id' | undefined;
    let imageFailure: 'rejected' | 'network' | 'missing-id' | 'server' | undefined;
    let providerCalls = 0;
    let failSend = false;
    const telegramMethods: string[] = [];
    let rejectMarkdown = false;
    const rejectedFormatting: string[] = [];
    let failSubmit = false;
    let failReaction = false;
    const reacting: { provider: string; body: Record<string, unknown> }[] = [];
    const reactedTo: [string, string | null][] = [];
    const replyTargets: { sourceId: string; messageId: string | undefined }[] = [];
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
          const wire =
            init?.body instanceof FormData
              ? Object.fromEntries([...init.body].filter((entry) => typeof entry[1] === 'string'))
              : body;
          telegramMethods.push(url.split('/').at(-1)!);
          if (rejectMarkdown && wire.parse_mode === 'MarkdownV2') {
            rejectedFormatting.push('markdown');
            return Response.json(
              { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
              { status: 400 },
            );
          }
          sent.push({ provider: 'telegram', body: wire });
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
        if (/^https:\/\/graph\.facebook\.com\/v\d+\.0\/555000\/media$/.test(url)) {
          assert.ok(init?.body instanceof FormData);
          assert.equal(init.body.get('messaging_product'), 'whatsapp');
          const image = init.body.get('file');
          assert.ok(image instanceof File);
          uploaded.push({
            name: image.name,
            mimeType: image.type,
            bytes: Buffer.from(await image.arrayBuffer()),
          });
          const failure = uploadFailure;
          uploadFailure = undefined;
          if (failure === 'network') throw new Error('Upload response unavailable.');
          if (failure === 'missing-id') return Response.json({});
          if (failure === 'rejected')
            return Response.json(
              { error: { code: 131053, message: 'Image upload rejected.' } },
              { status: 400 },
            );
          return Response.json({ id: `fixture-media-${uploaded.length}` });
        }
        if (/^https:\/\/graph\.facebook\.com\/v\d+\.0\/555000\/messages$/.test(url)) {
          if (body.type === 'reaction') {
            reacting.push({ provider: 'whatsapp', body });
            return Response.json({
              messages: [{ id: `wamid.fixture-reaction-${reacting.length}` }],
            });
          }
          sent.push({ provider: 'whatsapp', body });
          if (body.type === 'image') {
            const failure = imageFailure;
            imageFailure = undefined;
            if (failure === 'network') throw new Error('Possible image acceptance.');
            if (failure === 'missing-id') return Response.json({ messages: [] });
            if (failure === 'rejected' || failure === 'server')
              return Response.json(
                { error: { code: 131000, message: 'Image was not delivered.' } },
                { status: failure === 'rejected' ? 400 : 500 },
              );
          }
          return Response.json({ messages: [{ id: `wamid.fixture-out-${sent.length}` }] });
        }
        throw new Error('Unexpected fixture provider call.');
      },
    );
    const app = Fastify();
    const transport = createChatSdkTransport(pool, fixtureEnv);
    const channels = await createChannels(pool, {
      ownerId: 'local-development',
      present: async (_thread, input) => {
        assert.doesNotMatch(JSON.stringify(input), /private-token|api\/artifacts/);
        if (input.kind === 'delivery' && input.secureAction) handoffPresentations.push(input);
        if (input.kind === 'delivery' && input.files) unavailableFiles.push(input.files);
        return 'Continua na aplicação Nod.';
      },
      transport,
      resolveAttachments: async (resolvedThreadId, ids) => {
        assert.equal(resolvedThreadId, threadId);
        if (ids.some((id) => id !== whatsappFileId && !images.has(id)))
          throw new Error('Attachment unavailable.');
        return ids.map((id) =>
          id === whatsappFileId
            ? attachment('research.csv', 'text/csv', 'A,B\n1,2\n')
            : images.get(id)!,
        );
      },
      subscribe: () => () => {},
      intervalMs: 600000,
      reacted: async (messageId, reaction) => {
        reactedTo.push([messageId, reaction]);
      },
      submit: async (_text, sourceId, client, channel, _messageId, _answer, replyToMessageId) => {
        replyTargets.push({ sourceId, messageId: replyToMessageId });
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
      assert.equal(sent.length, 4);
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
      assert.equal(sent.length, 5);
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
      assert.equal(sent.length, 5);

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
      await pool.query('UPDATE messages SET hidden_at=now() WHERE id=$1', [telegramReply]);
      try {
        await sendTelegram(telegramReaction(101, ['👍']));
        assert.equal(reactedTo.length, 6);
      } finally {
        await pool.query('UPDATE messages SET hidden_at=NULL WHERE id=$1', [telegramReply]);
      }
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
      assert.equal(sent.length, 5);

      const paragraphs = Array.from({ length: 30 }, (_, index) =>
        `Paragraph ${index} ${'detail '.repeat(40)}`.trim(),
      );
      await addReply('channel:telegram:987:123456:10', paragraphs.join('\n\n'));
      await channels.drain();
      const parts = sent.slice(5).map((message) => String(message.body.text));
      assert.ok(parts.length > 1 && parts.every((part) => part.length <= 4096));
      assert.ok(paragraphs.every((paragraph) => parts.some((part) => part.includes(paragraph))));

      const captionText =
        'Flight (economy) - 123.45 EUR. '.repeat(30) + '\nFinal cancellation deadline: 2026-10-31.';
      const beforeCaption = sent.length;
      const captionSent = await transport.post({
        channelId: 'telegram',
        accountId: '987',
        threadId: 'telegram:123456',
        text: captionText,
        attachments: [images.get(pngId)!],
      });
      const captionDelivery = sent.slice(beforeCaption);
      assert.deepEqual(
        captionSent.ids,
        captionDelivery.map((_, index) => `123456:${beforeCaption + index + 101}`),
      );
      const readable = (body: Record<string, unknown>) =>
        String(body.text ?? body.caption ?? '').replace(/\\([^\p{L}\p{N}\s])/gu, '$1');
      assert.ok(
        captionDelivery.some(({ body }) =>
          readable(body).includes('Final cancellation deadline: 2026-10-31.'),
        ),
        JSON.stringify(captionDelivery),
      );
      assert.equal(
        captionDelivery
          .map(({ body }) => readable(body))
          .join('\n')
          .match(/Flight \(economy\) - 123\.45 EUR\./g)?.length,
        30,
      );
      assert.ok(captionDelivery.every(({ body }) => String(body.caption ?? '').length <= 1024));
      const conditions = Array.from(
        { length: 100 },
        (_, index) =>
          `Condition ${index}: flight (economy) - EUR ${100 + index}. Changes (+10.00) / refunds (-20.00) / seats (+5.00). Deadline 2026-10-31!`,
      );
      for (const reject of [false, true]) {
        rejectMarkdown = reject;
        const beforeConditions: number = sent.length;
        const conditionsReply = await addReply(
          'channel:telegram:987:123456:10',
          conditions.join('\n\n'),
        );
        await channels.drain();
        const delivered = sent.slice(beforeConditions);
        assert.ok(delivered.length > 1);
        assert.ok(delivered.every(({ body }) => String(body.text).length <= 4096));
        const complete = delivered.map(({ body }) => readable(body)).join('\n\n');
        for (const condition of conditions) assert.ok(complete.includes(condition), condition);
        assert.deepEqual(
          (
            await pool.query(
              'SELECT state,provider_message_ids FROM channel_outbox WHERE message_id=$1',
              [conditionsReply],
            )
          ).rows[0],
          {
            state: 'sent',
            provider_message_ids: delivered.map(
              (_, index) => `123456:${beforeConditions + index + 101}`,
            ),
          },
        );
      }
      assert.ok(rejectedFormatting.includes('markdown'));
      rejectMarkdown = false;
      const family = '👩‍👩‍👧‍👦';
      const accented = 'e\u0301';
      const beforeUnicode = sent.length;
      await addReply(
        'channel:telegram:987:123456:10',
        `${family}${accented}`.repeat(400) + '\nFinal Unicode deadline: 2026-10-31.',
      );
      await channels.drain();
      const unicodeParts = sent.slice(beforeUnicode).map(({ body }) => readable(body));
      assert.ok(unicodeParts.length > 1);
      for (const grapheme of [family, accented])
        assert.equal(
          unicodeParts.reduce((count, part) => count + part.split(grapheme).length - 1, 0),
          400,
        );
      assert.ok(unicodeParts.every((part) => Buffer.from(part).toString() === part));
      assert.ok(unicodeParts.at(-1)!.includes('Final Unicode deadline: 2026-10-31.'));

      const formatted = [
        '**Call:** today at 17:30. [Join call](https://meet.example.com/a).',
        'Goal first.\nThen details.',
        '- **Integration:** approval\n- **Pilot:** a date',
        '1. Ask\n2. Decide',
        '| Flight | Price |\n| --- | --- |\n| LH 1 | €120.50 |',
        'Saved to outputs/report.md. Type \\*text\\* to bold, 5*3*2 stays.',
      ].join('\n\n');
      const beforeFormatted = sent.length;
      await addReply('channel:telegram:987:123456:10', formatted);
      await channels.drain();
      assert.deepEqual(
        sent.slice(beforeFormatted).map(({ body }) => [body.parse_mode, body.text]),
        [
          [
            'MarkdownV2',
            '*Call:* today at 17:30\\. [Join call](https://meet.example.com/a)\\.\n\nGoal first\\.\nThen details\\.\n\n• *Integration:* approval\n• *Pilot:* a date\n\n1\\. Ask\n2\\. Decide\n\n*LH 1*\n• Price: €120\\.50\n\nSaved to `outputs/report.md`\\. Type \\*text\\* to bold, 5\\*3\\*2 stays\\.',
          ],
        ],
      );
      assert.ok(!telegramMethods.includes('sendRichMessage'));
      await transport.post({
        channelId: 'telegram',
        accountId: '987',
        threadId: 'telegram:123456',
        replyToMessageId: '123456:10',
        text: 'Invoice https://example.com/canary?k=NS-1042',
      });
      const telegramTexts = sent.filter(
        ({ provider, body }) => provider === 'telegram' && 'text' in body,
      );
      assert.ok(telegramTexts.some(({ body }) => body.reply_parameters));
      assert.ok(telegramTexts.some(({ body }) => !body.parse_mode));
      for (const { body } of telegramTexts)
        assert.deepEqual(body.link_preview_options, { is_disabled: true });

      await pool.query("UPDATE channel_inbox SET received_at=now() WHERE provider='whatsapp'");
      const beforeFormattedWhatsApp = sent.length;
      await addReply('channel:whatsapp:555000:wamid.good', formatted);
      await channels.drain();
      assert.deepEqual(
        sent.slice(beforeFormattedWhatsApp).map(({ body }) => (body.text as { body: string }).body),
        [
          '*Call:* today at 17:30. Join call (https://meet.example.com/a).\n\nGoal first.\nThen details.\n\n- *Integration:* approval\n- *Pilot:* a date\n\n1. Ask\n2. Decide\n\n*LH 1*\n- Price: €120.50\n\nSaved to outputs/report.md. Type `*text*` to bold, 5*3*2 stays.',
        ],
      );
      const beforeWhatsApp = sent.length;
      const flightRows = Array.from(
        { length: 24 },
        (_, index) =>
          `| ${index === 0 ? 'Fare conditions '.repeat(70) : `Flight ${index}`} | EUR ${100 + index} |`,
      );
      const multipart = await addReply(
        'channel:whatsapp:555000:wamid.good',
        `${paragraphs.join('\n\n')}\n\n| Flight | Price |\n| --- | --- |\n${flightRows.join('\n')}\n\n[Source](https://example.com/flights)`,
      );
      await channels.drain();
      const whatsappParts = sent.slice(beforeWhatsApp);
      const bodies = whatsappParts.map(({ body }) => (body.text as { body: string }).body);
      assert.ok(whatsappParts.every(({ provider }) => provider === 'whatsapp'));
      assert.ok(bodies.length > 2 && bodies.every((body) => body.length <= 4096));
      assert.ok(paragraphs.every((paragraph) => bodies.some((body) => body.includes(paragraph))));
      assert.match(bodies.join('\n'), /Flight 23/);
      assert.match(bodies.at(-1)!, /https:\/\/example.com\/flights/);
      const providerIds = whatsappParts.map(
        (_, index) => `wamid.fixture-out-${beforeWhatsApp + index + 1}`,
      );
      assert.deepEqual(
        (
          await pool.query('SELECT provider_message_ids FROM channel_outbox WHERE message_id=$1', [
            multipart,
          ])
        ).rows[0].provider_message_ids,
        providerIds,
      );
      for (const index of [0, Math.floor(providerIds.length / 2), providerIds.length - 1]) {
        const nativeId = providerIds[index];
        await sendWhatsApp(whatsappReaction(nativeId, '👍'));
        assert.deepEqual(reactedTo.at(-1), [multipart, '👍']);
        const reply = whatsappPayload(`wamid.chunk-reply-${index}`);
        const value = reply.entry[0].changes[0].value;
        Object.assign(value.messages[0], { context: { id: nativeId } });
        assert.equal((await sendWhatsApp(reply)).statusCode, 200);
        await channels.drain();
        assert.deepEqual(replyTargets.at(-1), {
          sourceId: `channel:whatsapp:555000:wamid.chunk-reply-${index}`,
          messageId: multipart,
        });
      }

      const imageReply = await addReply(
        'channel:whatsapp:555000:wamid.good',
        'Here are the page and venue images.',
        [{ id: pngId }, { id: jpegId }],
      );
      await pool.query('UPDATE messages SET reply_to_message_id=$2 WHERE id=$1', [
        imageReply,
        whatsappReply,
      ]);
      const beforeImages = sent.length;
      await channels.drain();
      assert.deepEqual(uploaded, [
        {
          name: 'page.png',
          mimeType: 'image/png',
          bytes: Buffer.from('synthetic screenshot pixels'),
        },
        { name: 'venue.jpg', mimeType: 'image/jpeg', bytes: Buffer.from('synthetic venue pixels') },
      ]);
      const mediaMessages = sent.slice(beforeImages);
      assert.deepEqual(
        mediaMessages.map(({ body }) => body.type),
        ['text', 'image', 'image'],
      );
      assert.deepEqual(
        mediaMessages.slice(1).map(({ body }) => body.image),
        [{ id: 'fixture-media-1' }, { id: 'fixture-media-2' }],
      );
      assert.ok(
        mediaMessages.every(
          ({ body }) =>
            (body.context as { message_id: string }).message_id === 'wamid.fixture-out-2',
        ),
      );
      assert.doesNotMatch(JSON.stringify(mediaMessages), /api\/artifacts|https?:|"link"/);
      const imageProviderIds = mediaMessages.map(
        (_, index) => `wamid.fixture-out-${beforeImages + index + 1}`,
      );
      assert.deepEqual(
        (
          await pool.query(
            'SELECT state,provider_message_ids FROM channel_outbox WHERE message_id=$1',
            [imageReply],
          )
        ).rows[0],
        { state: 'sent', provider_message_ids: imageProviderIds },
      );
      for (const nativeId of imageProviderIds.slice(1)) {
        await sendWhatsApp(whatsappReaction(nativeId, '👍'));
        assert.deepEqual(reactedTo.at(-1), [imageReply, '👍']);
        const inbound = whatsappPayload(`wamid.media-reply-${nativeId}`);
        Object.assign(inbound.entry[0].changes[0].value.messages[0], { context: { id: nativeId } });
        await sendWhatsApp(inbound);
        await channels.drain();
        assert.equal(replyTargets.at(-1)?.messageId, imageReply);
      }
      const unquoted = await addReply(
        'channel:whatsapp:555000:wamid.good',
        'Current response without a retired quote.',
      );
      await pool.query('UPDATE messages SET reply_to_message_id=$2 WHERE id=$1', [
        unquoted,
        whatsappReply,
      ]);
      await pool.query('UPDATE messages SET hidden_at=now() WHERE id=$1', [whatsappReply]);
      try {
        const before = sent.length;
        await channels.drain();
        assert.deepEqual(
          sent.slice(before).map(({ provider, body }) => [provider, body.context ?? null]),
          [['whatsapp', null]],
        );
      } finally {
        await pool.query('UPDATE messages SET hidden_at=NULL WHERE id=$1', [whatsappReply]);
      }
      const rejectedImages = await addReply(
        'channel:whatsapp:555000:wamid.good',
        'These files remain in Nod.',
        [
          { id: largeImageId },
          { id: brokenImageId },
          { id: wrongSizeImageId },
          { id: whatsappFileId },
        ],
      );
      const beforeRejected = sent.length;
      await channels.drain();
      assert.equal(uploaded.length, 2);
      assert.equal(sent.length, beforeRejected + 2);
      assert.ok(sent.slice(beforeRejected).every(({ body }) => body.type === 'text'));
      assert.equal(
        (await pool.query('SELECT state FROM channel_outbox WHERE message_id=$1', [rejectedImages]))
          .rows[0].state,
        'sent',
      );
      for (const failure of [
        'upload-rejected',
        'upload-network',
        'upload-missing-id',
        'rejected',
      ]) {
        uploadFailure =
          failure === 'upload-rejected'
            ? 'rejected'
            : failure === 'upload-network'
              ? 'network'
              : failure === 'upload-missing-id'
                ? 'missing-id'
                : undefined;
        imageFailure = failure === 'rejected' ? 'rejected' : undefined;
        const failedImage = await addReply(
          'channel:whatsapp:555000:wamid.good',
          'The second image should still arrive.',
          [{ id: pngId }, { id: jpegId }],
        );
        const beforeFailure: number = sent.length;
        const beforeUpload: number = uploaded.length;
        const beforeNotice = unavailableFiles.length;
        await channels.drain();
        assert.equal(uploaded.length, beforeUpload + 2);
        assert.deepEqual(unavailableFiles.slice(beforeNotice), [['page.png']]);
        const delivered = sent.slice(beforeFailure);
        assert.deepEqual(
          delivered.map(({ body }) => body.type),
          failure === 'rejected' ? ['text', 'image', 'image', 'text'] : ['text', 'image', 'text'],
        );
        assert.deepEqual(delivered.at(-2)!.body.image, { id: `fixture-media-${uploaded.length}` });
        assert.match(JSON.stringify(delivered.at(-1)!.body), /Continua na aplicação Nod/);
        const acceptedIds: string[] = delivered.flatMap((_, index) =>
          failure === 'rejected' && index === 1
            ? []
            : [`wamid.fixture-out-${beforeFailure + index + 1}`],
        );
        assert.deepEqual(
          (
            await pool.query(
              'SELECT state,provider_message_ids FROM channel_outbox WHERE message_id=$1',
              [failedImage],
            )
          ).rows[0],
          { state: 'sent', provider_message_ids: acceptedIds },
        );
        await channels.drain();
        assert.equal(sent.length, beforeFailure + delivered.length);
        assert.equal(uploaded.length, beforeUpload + 2);
      }
      for (const failure of ['network', 'missing-id', 'server'] as const) {
        imageFailure = failure;
        const uncertainImage = await addReply(
          'channel:whatsapp:555000:wamid.good',
          'Sending the screenshot.',
          [{ id: pngId }, { id: jpegId }],
        );
        const beforeUpload: number = uploaded.length;
        const beforeNotice = unavailableFiles.length;
        await channels.drain();
        assert.equal(
          (
            await pool.query('SELECT state FROM channel_outbox WHERE message_id=$1', [
              uncertainImage,
            ])
          ).rows[0].state,
          'uncertain',
        );
        assert.equal(uploaded.length, beforeUpload + 1);
        assert.equal(unavailableFiles.length, beforeNotice);
        const attemptedImages: number = sent.length;
        await channels.drain();
        assert.equal(sent.length, attemptedImages);
        assert.equal(uploaded.length, beforeUpload + 1);
      }

      for (const [sourceId, provider] of [
        ['channel:telegram:987:123456:10', 'telegram'],
        ['channel:whatsapp:555000:wamid.good', 'whatsapp'],
      ]) {
        const before: number = sent.length;
        await pool.query('UPDATE channel_inbox SET received_at=now() WHERE source_id=$1', [
          sourceId,
        ]);
        await addReply(sourceId, 'The website needs sign-in.');
        const handoff = await addReply(
          sourceId,
          'Complete sign-in on this page, then return control.',
        );
        await pool.query(
          "UPDATE turns SET status='waiting',waiting_reason='question',handoff_browser_id=session_id::text WHERE id=(SELECT turn_id FROM messages WHERE id=$1)",
          [handoff],
        );
        const presented = handoffPresentations.length;
        await channels.drain();
        assert.equal(sent.length, before + 2);
        assert.equal(sent.at(-1)?.provider, provider);
        assert.match(JSON.stringify(sent.at(-1)?.body), /Continua na aplicação Nod/);
        assert.match(
          provider === 'telegram' ? readable(sent.at(-2)!.body) : JSON.stringify(sent.at(-2)?.body),
          /The website needs sign-in/,
        );
        assert.equal(handoffPresentations.length, presented + 1);
        assert.doesNotMatch(
          JSON.stringify(sent.slice(before)),
          /\/browser|handoff_browser_id|Complete sign-in/,
        );
      }

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
        present: async () => 'Consulta os ficheiros na aplicação Nod.',
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
        assert.equal(sent.length, attempts + 2);
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

test(
  'channel outbox sends only pending answer choices and rechecks after preparation',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const schema = `test_channel_choices_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    let channels: Awaited<ReturnType<typeof createChannels>> | undefined;
    t.after(async () => {
      await channels?.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const ownerId = 'fixture-choice-owner';
    const threadId = await createFixtureTables(pool, ownerId);
    const sent: Array<{ text: string; files: string[] }> = [];
    const choices = {
      multiple: false,
      options: [
        { id: randomUUID(), label: 'Work' },
        { id: randomUUID(), label: 'Personal' },
      ],
    };
    let duringAttachments: (() => Promise<void>) | undefined;
    let duringPresentation: (() => Promise<void>) | undefined;
    let resolved = 0;
    let presented = 0;
    channels = await createChannels(pool, {
      ownerId,
      transport: {
        channels: [
          {
            id: 'telegram',
            status: 'configured',
            accountId: 'fixture-account',
            allowedSenderIds: ['fixture-sender'],
            supportsAttachments: true,
            missing: [],
          },
        ],
        receive: async () => ({ status: 200, body: 'ok', messages: [] }),
        post: async ({ text, attachments }) => {
          sent.push({ text, files: attachments?.map((file) => file.name) ?? [] });
          return { id: `fixture-delivery-${sent.length}` };
        },
        close: async () => {},
      },
      resolveAttachments: async (id, ids) => {
        assert.equal(id, threadId);
        assert.equal(ids.length, 1);
        resolved++;
        const change = duringAttachments;
        duringAttachments = undefined;
        await change?.();
        return [attachment('planning.txt', 'text/plain', 'Synthetic planning note')];
      },
      present: async (_id, input) => {
        presented++;
        const change = duringPresentation;
        duringPresentation = undefined;
        await change?.();
        assert.equal(input.kind, 'delivery');
        return input.kind === 'delivery' ? input.text : 'Synthetic delivery';
      },
      submit: async () => {
        throw new Error('Outbox checks must not submit a turn.');
      },
      subscribe: () => () => {},
      intervalMs: 600_000,
    });
    const service = channels;
    async function queue(withChoices = true, withAttachment = false) {
      const sourceId = `fixture-source-${randomUUID()}`;
      const turnId = await fixtureTurn(
        pool,
        threadId,
        ownerId,
        'telegram:fixture',
        sourceId,
        withChoices ? 'waiting' : 'succeeded',
      );
      if (withChoices)
        await pool.query("UPDATE turns SET waiting_reason='question' WHERE id=$1", [turnId]);
      await pool.query(
        `INSERT INTO channel_inbox(source_id,provider,account_id,sender_id,thread_id,text,received_at,turn_id,state,owner_id,channel)
         VALUES($1,'telegram','fixture-account','fixture-sender','fixture-chat','Synthetic request',now(),$2,'submitted',$3,'telegram:fixture')`,
        [sourceId, turnId, ownerId],
      );
      const messageId = randomUUID();
      await pool.query(
        `INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text,answer_choices,attachments)
         VALUES($1,$2,$3,$4,'assistant',$5,$6,$7)`,
        [
          messageId,
          ownerId,
          threadId,
          turnId,
          withChoices ? 'Which calendar should I use?' : 'Your planning note is ready.',
          withChoices ? JSON.stringify(choices) : null,
          JSON.stringify(withAttachment ? [{ id: randomUUID() }] : []),
        ],
      );
      await pool.query('INSERT INTO channel_outbox(message_id,source_id) VALUES($1,$2)', [
        messageId,
        sourceId,
      ]);
      return { turnId, messageId };
    }
    async function answer(question: { turnId: string; messageId: string }) {
      const turnId = await fixtureTurn(pool, threadId, ownerId, 'web');
      await pool.query(
        `UPDATE turns SET parent_turn_id=$2,created_at=GREATEST(created_at,
         (SELECT created_at + interval '1 microsecond' FROM turns WHERE id=$2)) WHERE id=$1`,
        [turnId, question.turnId],
      );
      await pool.query(
        `INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text,reply_to_message_id)
         VALUES($1,$2,$3,$4,'user','Work',$5)`,
        [randomUUID(), ownerId, threadId, turnId, question.messageId],
      );
    }
    async function blocked(messageId: string, before: number) {
      await service.drain();
      assert.equal(sent.length, before);
      assert.equal(
        (await pool.query('SELECT state FROM channel_outbox WHERE message_id=$1', [messageId]))
          .rows[0].state,
        'blocked',
      );
      await service.drain();
      assert.equal(sent.length, before);
    }
    await t.test('a pending question delivers its choices and attachment', async () => {
      const question = await queue(true, true);
      await service.drain();
      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /Which calendar should I use/);
      assert.match(sent[0].text, /Work/);
      assert.match(sent[0].text, /Personal/);
      assert.deepEqual(sent[0].files, ['planning.txt']);
      assert.equal(
        (
          await pool.query('SELECT state FROM channel_outbox WHERE message_id=$1', [
            question.messageId,
          ])
        ).rows[0].state,
        'sent',
      );
    });
    await t.test('completed, cancelled and running questions cannot deliver', async () => {
      for (const status of ['succeeded', 'cancelled', 'running']) {
        const question = await queue();
        await pool.query('UPDATE turns SET status=$2 WHERE id=$1', [question.turnId, status]);
        await blocked(question.messageId, sent.length);
      }
    });
    await t.test(
      'an answered question cannot deliver even while its original turn remains waiting',
      async () => {
        const question = await queue();
        await answer(question);
        await blocked(question.messageId, sent.length);
      },
    );
    await t.test('closing a question during attachment preparation prevents delivery', async () => {
      const question = await queue(true, true);
      const before = resolved;
      duringAttachments = async () => {
        await pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [question.turnId]);
      };
      await blocked(question.messageId, sent.length);
      assert.equal(resolved, before + 1);
      assert.equal(duringAttachments, undefined);
    });
    await t.test('answering during presentation preparation prevents delivery', async () => {
      const question = await queue(true, true);
      const before = presented;
      duringPresentation = () => answer(question);
      await blocked(question.messageId, sent.length);
      assert.equal(presented, before + 1);
      assert.equal(duringPresentation, undefined);
    });
    await t.test(
      'ordinary completed replies remain deliverable with and without attachments',
      async () => {
        for (const files of [false, true]) {
          const before = sent.length;
          const reply = await queue(false, files);
          await service.drain();
          assert.equal(sent.length, before + 1);
          assert.equal(sent.at(-1)?.text, 'Your planning note is ready.');
          assert.deepEqual(sent.at(-1)?.files, files ? ['planning.txt'] : []);
          assert.equal(
            (
              await pool.query('SELECT state FROM channel_outbox WHERE message_id=$1', [
                reply.messageId,
              ])
            ).rows[0].state,
            'sent',
          );
        }
      },
    );
  },
);
