import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PgBoss } from 'pg-boss';
import { registerArtifactFileHandlers } from '../desktop/main/artifact-file-handlers.mjs';

async function main() {
  console.log('Desktop fixture module loaded');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const output = join(root, '.local/ux-delighters');
  const profile = await mkdtemp(join(tmpdir(), 'nod-ux-demo-'));
  await mkdir(join(profile, 'Downloads'));
  await mkdir(join(profile, 'profile', 'Shared Dictionary', 'cache'), { recursive: true });
  await mkdir(join(profile, 'profile', 'Cache', 'Cache_Data'), { recursive: true });
  await mkdir(output, { recursive: true });
  app.setPath('userData', join(profile, 'profile'));
  app.setPath('downloads', join(profile, 'Downloads'));
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  const owner = 'synthetic-ux-owner';
  const threadId = randomUUID();
  const messageId = randomUUID();
  const files = new Map();
  const add = (name, mimeType, bytes) => {
    const id = randomUUID();
    const artifact = { id, name, mimeType, size: bytes.length, url: `/api/artifacts/${id}` };
    files.set(id, { artifact, bytes });
    return artifact;
  };
  function pdf() {
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    const text =
      'BT /F1 24 Tf 55 760 Td (Venue comparison) Tj /F1 12 Tf 0 -40 Td (River House - 12 seats - EUR 1450) Tj 0 -24 Td (Garden Studio - 12 seats - EUR 1180) Tj 0 -48 Td (Prepared with synthetic data for the desktop demo.) Tj ET';
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    let data = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object, index) => {
      offsets.push(Buffer.byteLength(data));
      data += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const at = Buffer.byteLength(data);
    data += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
      .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${at}\n%%EOF`;
    return Buffer.from(data);
  }
  const image = add(
    'workspace-mark.png',
    'image/png',
    await readFile(join(root, 'desktop/assets/nod-macos.png')),
  );
  const document = add('venue-comparison.pdf', 'application/pdf', pdf());
  const note = add(
    'trip-plan.md',
    'text/markdown',
    Buffer.from(
      '# Team trip\n\nMeet at 09:30. Compare the two venues before Friday.\n\n- River House: 12 seats\n- Garden Studio: 12 seats\n',
    ),
  );
  const now = new Date().toISOString();
  const messages = [
    {
      id: randomUUID(),
      role: 'user',
      text: 'Compare these venues and prepare the trip files.',
      attachments: [],
      turnId: null,
      createdAt: new Date(Date.now() - 60000).toISOString(),
    },
    {
      id: messageId,
      role: 'assistant',
      text: 'The comparison and trip plan are ready.\n\n| Venue | Seats | Price |\n| --- | --- | --- |\n| River House | 12 | €1,450 |\n| Garden Studio | 12 | €1,180 |\n\nChoose River House if you need a projector.\n\n```json\n{"venue":"River House","seats":12}\n```',
      attachments: [image, document, note],
      turnId: null,
      createdAt: now,
    },
  ];
  const schedules = [
    {
      id: randomUUID(),
      title: 'Friday trip check',
      prompt: 'Review the trip plan each Friday.',
      kind: 'recurring',
      cron: '0 9 * * 5',
      runAt: null,
      timeZone: 'Europe/Madrid',
      enabled: true,
      revision: 0,
      nextRun: null,
      lastRun: null,
      baselineObservation: null,
      monthlyUsd: null,
    },
  ];
  const scheduler = new PgBoss('postgres://fixture.invalid/fixture');
  const previewSchedule = (schedule) => {
    if (schedule.kind === 'once')
      return schedule.runAt && new Date(schedule.runAt) > new Date() ? schedule.runAt : null;
    return (
      scheduler
        .previewSchedule(schedule.cron, {
          tz: schedule.timeZone,
          count: 1,
          from: new Date(),
        })[0]
        ?.toISOString() ?? null
    );
  };
  schedules[0].nextRun = previewSchedule(schedules[0]);
  const events = new Set();
  const refresh = () => {
    for (const response of events) response.write('data: {"type":"refresh"}\n\n');
  };
  const settings = {
    theme: 'light',
    resolvedTheme: 'light',
    notifications: false,
    launchAtLogin: false,
    onboardingPreferenceStep: 'complete',
    onboardingCompleted: true,
  };
  const preferences = {
    notificationRule: '',
    rules: '',
    timeZone: 'Europe/Madrid',
    locale: 'en-GB',
    hourCycle: 'h23',
    quietHoursEnabled: false,
    quietStart: '22:00',
    quietEnd: '08:00',
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      if (path === '/__fixture/record') {
        response.end('Recording');
        startRecording();
        return;
      }
      if (path === '/__fixture/finish') {
        response.end('Done');
        void finish();
        return;
      }
      const json = (value, status = 200) => {
        response.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        response.end(JSON.stringify(value));
      };
      if (path === '/api/events') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
        });
        response.write('data: {"type":"refresh"}\n\n');
        events.add(response);
        response.on('close', () => events.delete(response));
        return;
      }
      if (path === '/api/session')
        return json({
          user: { id: owner, name: 'Demo user', email: null, avatarUrl: null },
          settings: { theme: 'light', onboardingCompleted: true, usageData: false, traces: false },
          capabilities: { developer: false, traces: false },
        });
      if (path === '/api/state')
        return json({
          threadId,
          messages,
          turns: [],
          tasks: [],
          activity: [],
          verificationRequests: [],
          configuration: {
            provider: 'fixture',
            model: 'synthetic',
            llmReady: true,
            modelReconnect: false,
            integrationsReady: false,
            conversationResetEnabled: false,
          },
        });
      if (path === '/api/messages/search')
        return json(
          messages.filter((message) =>
            message.text.toLowerCase().includes(url.searchParams.get('q').toLowerCase()),
          ),
        );
      if (path.startsWith('/api/messages/around/')) return json(messages);
      if (path === '/api/messages' && request.method === 'GET')
        return json({ messages, hasMore: false });
      if (path === '/api/messages' && request.method === 'POST') {
        const parts = [];
        for await (const part of request) parts.push(part);
        const body = JSON.parse(Buffer.concat(parts));
        if (body.text === 'Try a failed send')
          return json({ error: 'Synthetic connection failure. Your draft was kept.' }, 503);
        const turnId = randomUUID();
        const replyTo = messages.find((message) => message.id === body.replyToMessageId);
        messages.push({
          id: body.clientMessageId,
          text: body.text,
          role: 'user',
          ...(replyTo
            ? {
                replyToMessageId: replyTo.id,
                replyTo: {
                  id: replyTo.id,
                  role: replyTo.role,
                  text: body.replyQuote ?? replyTo.text.slice(0, 1000),
                },
              }
            : {}),
          attachments: body.attachmentIds.map((id) => files.get(id).artifact),
          turnId,
          createdAt: new Date().toISOString(),
        });
        refresh();
        return json({ threadId, turnId, messageId: body.clientMessageId });
      }
      if (path === '/api/uploads') {
        const parts = [];
        for await (const part of request) parts.push(part);
        const data = Buffer.concat(parts);
        const marker = data.indexOf('\r\n\r\n');
        const head = data.subarray(0, marker).toString();
        const name = /filename="([^"]+)"/.exec(head)?.[1] ?? 'file.txt';
        if (name === 'unavailable.txt')
          return json({ error: 'Synthetic upload failure. Choose Retry to try again.' }, 503);
        const type = /Content-Type: ([^\r]+)/i.exec(head)?.[1] ?? 'text/plain';
        const boundary = /boundary=(.+)/.exec(request.headers['content-type'])?.[1];
        const end = data.lastIndexOf(Buffer.from(`\r\n--${boundary}`));
        return json(add(name, type, data.subarray(marker + 4, end)));
      }
      if (path.startsWith('/api/artifacts/')) {
        const item = files.get(path.split('/')[3]);
        if (!item) return json({ error: 'File not found.' }, 404);
        if (path.endsWith('/metadata')) return json(item.artifact);
        response.writeHead(200, {
          'Content-Type': item.artifact.mimeType,
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(item.artifact.name)}`,
          'Cache-Control': 'no-store',
        });
        response.end(item.bytes);
        return;
      }
      if (path === '/api/preferences') return json(preferences);
      if (path === '/api/trust')
        return json({
          entries: [],
          next: null,
          week: { things: 0, actions: 0, spentUsd: 0 },
          month: {
            start: now,
            days: 31,
            elapsedDays: 1,
            spentUsd: 0,
            forecastUsd: 0,
            daily: [],
            unpriced: false,
          },
          limit: null,
          taskUsd: 5,
        });
      if (path === '/api/models') return json({ providers: [], connections: [], selection: null });
      if (path === '/api/schedules') return json(schedules);
      if (/^\/api\/schedules\/[^/]+\/preview$/.test(path)) {
        const parts = [];
        for await (const part of request) parts.push(part);
        const body = JSON.parse(Buffer.concat(parts));
        return json({ nextRun: previewSchedule({ ...schedules[0], ...body }) });
      }
      if (/^\/api\/schedules\/[^/]+$/.test(path) && request.method === 'PATCH') {
        const parts = [];
        for await (const part of request) parts.push(part);
        const body = JSON.parse(Buffer.concat(parts));
        const { expectedRevision, ...update } = body;
        if (expectedRevision !== undefined && expectedRevision !== schedules[0].revision)
          return json({ error: 'This schedule changed. Check its current timing.' }, 409);
        if (update.title === 'Offline title')
          return json({ error: 'Synthetic connection failure. Your edit was kept.' }, 503);
        Object.assign(schedules[0], update);
        schedules[0].nextRun = schedules[0].enabled ? previewSchedule(schedules[0]) : null;
        schedules[0].revision++;
        refresh();
        return json(schedules[0]);
      }
      if (path === '/api/schedule-runs') return json({ runs: [], next: null });
      if (path.startsWith('/api/memory'))
        return json({ notes: [], archive: [], skills: [], saving: false, sensitive: false });
      if (path.startsWith('/api/')) return json([]);
      const asset =
        path === '/' || !extname(path) ? 'index.html' : decodeURIComponent(path).slice(1);
      const target = resolve(root, 'dist/web', asset);
      if (!target.startsWith(join(root, 'dist/web') + '/')) return json({}, 404);
      const bytes = await readFile(target);
      const types = {
        '.js': 'application/javascript',
        '.mjs': 'application/javascript',
        '.css': 'text/css',
        '.woff2': 'font/woff2',
        '.svg': 'image/svg+xml',
        '.html': 'text/html',
      };
      response.writeHead(200, {
        'Content-Type': types[extname(target)] ?? 'application/octet-stream',
      });
      response.end(bytes);
    } catch {
      response.writeHead(500);
      response.end('Synthetic fixture error');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  console.log('Desktop fixture listening');
  await app.whenReady();
  console.log('Desktop app ready');
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }, { role: 'viewMenu' }]));
  const window = new BrowserWindow({
    width: 1380,
    height: 960,
    title: 'nod · Synthetic desktop demo',
    webPreferences: {
      preload: join(root, 'desktop/preload/engine.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  const isEngine = (event) =>
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    new URL(event.senderFrame.url).origin === origin;
  registerArtifactFileHandlers({
    isEngine,
    origin: () => origin,
    token: () => '',
    window: () => window,
    icon: join(root, 'desktop/assets/nod-macos.png'),
  });
  for (const [channel, value] of Object.entries({
    'nod:renderer-ready': null,
    'nod:settings:get': settings,
    'nod:preferences:get': settings,
    'nod:chat-read:get': null,
    'nod:chat-read:set': null,
  }))
    ipcMain.handle(channel, () => value);
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') console.error('UI:', details.message);
  });
  await window.loadURL(origin);
  let capturing = false;
  let recording;
  let encoder;
  let closing = false;
  async function finish() {
    if (closing) return;
    closing = true;
    if (recording) {
      clearInterval(recording);
      while (capturing) await new Promise((resolve) => setTimeout(resolve, 50));
      encoder.stdin.end();
      await new Promise((resolve) => encoder.once('close', resolve));
    }
    for (const response of events) response.end();
    server.close();
    window.destroy();
    app.quit();
  }
  function startRecording() {
    if (recording) return;
    encoder = spawn(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'image2pipe',
        '-framerate',
        '10',
        '-i',
        '-',
        '-vf',
        'scale=1380:960:force_original_aspect_ratio=decrease,pad=1380:960:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '20',
        '-movflags',
        '+faststart',
        join(output, 'desktop.mp4'),
      ],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    );
    recording = setInterval(async () => {
      if (capturing) return;
      capturing = true;
      try {
        encoder.stdin.write((await window.webContents.capturePage()).toPNG());
      } catch {
        clearInterval(recording);
      } finally {
        capturing = false;
      }
    }, 100);
  }
  if (process.argv.includes('--record')) startRecording();
  console.log(JSON.stringify({ origin, profile, output }));
  process.once('SIGTERM', () => void finish());
  window.on('close', (event) => {
    if (!closing) {
      event.preventDefault();
      void finish();
    }
  });
}
void main().catch((cause) => {
  console.error(cause);
  app.exit(1);
});
