import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { runProcess } from '../../../src/providers/process.ts';

export interface Visit {
  host: string;
  browser?: string;
  method: string;
  path: string;
  query: string;
  at: number;
}

export interface Page {
  status?: number;
  headers?: Record<string, string>;
  body: string | Buffer;
}

export interface UploadedFile {
  field: string;
  filename: string;
  bytes: Buffer;
}

export interface SiteContext {
  request: IncomingMessage;
  url: URL;
  form: URLSearchParams;
  text: string;
  files: UploadedFile[];
  cookie(name: string): string | undefined;
  session<T extends object>(initial: () => T): { id: string; data: T; isNew: boolean };
}

export type Site = (context: SiteContext) => Page | Promise<Page>;

export function page(title: string, body: string, status = 200, lang = 'en'): Page {
  return {
    status,
    body: `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 20px;color:#1b1b1f}header{border-bottom:1px solid #ddd;margin-bottom:24px;padding-bottom:8px}nav a{margin-right:16px}label,input,button,select{display:block;margin:12px 0;font:inherit}input,select,button{padding:8px 10px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:8px;text-align:left}.card{border:1px solid #ddd;border-radius:8px;padding:16px;margin:12px 0}.error{color:#b00020}</style></head><body>${body}</body></html>`,
  };
}

export function file(name: string, bytes: Buffer, mimeType: string): Page {
  return {
    headers: { 'Content-Type': mimeType, 'Content-Disposition': `attachment; filename="${name}"` },
    body: bytes,
  };
}

export function redirect(location: string, headers: Record<string, string> = {}): Page {
  return { status: 303, headers: { Location: location, ...headers }, body: '' };
}

export function escapeHtml(value: unknown) {
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function multipart(body: Buffer, contentType: string) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const form = new URLSearchParams();
  const files: UploadedFile[] = [];
  if (!boundary) return { form, files };
  const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let start = body.indexOf(marker);
  while (start >= 0) {
    const next = body.indexOf(marker, start + marker.length);
    if (next < 0) break;
    const part = body.subarray(start + marker.length + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    if (split >= 0) {
      const head = part.subarray(0, split).toString('utf8');
      const content = part.subarray(split + 4);
      const name = /name="([^"]*)"/.exec(head)?.[1] ?? '';
      const filename = /filename="([^"]*)"/.exec(head)?.[1];
      if (filename !== undefined)
        files.push({ field: name, filename, bytes: Buffer.from(content) });
      else form.append(name, content.toString('utf8'));
    }
    start = next;
  }
  return { form, files };
}

export async function bindAddress() {
  if (process.platform !== 'linux') return '127.0.0.1';
  const { stdout } = await runProcess('docker', [
    'network',
    'inspect',
    'bridge',
    '--format',
    '{{(index .IPAM.Config 0).Gateway}}',
  ]);
  return stdout.trim() || '172.17.0.1';
}

export async function serveSites(sites: Record<string, Site>, address = '127.0.0.1') {
  const sessions = new Map<string, object>();
  const visits: Visit[] = [];
  const server = createServer(async (request, response: ServerResponse) => {
    const host = String(request.headers['x-fixture-host'] ?? request.headers.host ?? '')
      .split(':')[0]
      .toLowerCase();
    const site = sites[host];
    if (!site) return void response.writeHead(404).end('Not found');
    const url = new URL(request.url ?? '/', `https://${host}`);
    visits.push({
      host,
      ...(typeof request.headers['x-fixture-browser'] === 'string' && {
        browser: request.headers['x-fixture-browser'],
      }),
      method: request.method ?? 'GET',
      path: url.pathname,
      query: url.search,
      at: Date.now(),
    });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 20_000_000) return void response.writeHead(413).end();
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    const type = String(request.headers['content-type'] ?? '');
    const parsed = type.startsWith('multipart/')
      ? multipart(raw, type)
      : { form: new URLSearchParams(raw.toString('utf8')), files: [] as UploadedFile[] };
    const form = parsed.form;
    const cookies = Object.fromEntries(
      (request.headers.cookie ?? '').split(/;\s*/).flatMap((entry) => {
        const at = entry.indexOf('=');
        return at > 0 ? [[entry.slice(0, at), entry.slice(at + 1)]] : [];
      }),
    );
    let issued: string | undefined;
    const context: SiteContext = {
      request,
      url,
      form,
      text: raw.toString('utf8'),
      files: parsed.files,
      cookie: (name) => cookies[name],
      session<T extends object>(initial: () => T) {
        const key = `${host}:${cookies.sid ?? ''}`;
        const existing = cookies.sid ? (sessions.get(key) as T | undefined) : undefined;
        if (existing) return { id: cookies.sid, data: existing, isNew: false };
        const id = randomBytes(18).toString('hex');
        const data = initial();
        sessions.set(`${host}:${id}`, data);
        issued = id;
        return { id, data, isNew: true };
      },
    };
    try {
      const result = await site(context);
      const headers: Record<string, string | string[]> = {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        ...result.headers,
      };
      if (issued) headers['Set-Cookie'] = `sid=${issued}; Path=/; HttpOnly; SameSite=Lax`;
      response.writeHead(result.status ?? 200, headers).end(result.body);
    } catch {
      response.writeHead(500).end('Server error');
    }
  });
  await new Promise<void>((done) => server.listen(0, address, done));
  return {
    port: (server.address() as AddressInfo).port,
    visits,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
