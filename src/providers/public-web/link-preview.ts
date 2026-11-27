import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { parse } from 'parse5';
import type { LinkPreviewProvider, PreviewImage, SiteIcon } from '../../ports/link-preview.ts';
import { publicUrl, type AddressResolver } from '../agent-browser/network.ts';
import { rasterImageType } from '../raster-image.ts';

interface PublicResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Uint8Array;
}
export type PreviewRequest = (input: {
  url: URL;
  address: string;
  signal: AbortSignal;
  maxBytes: number;
  metadata: boolean;
  purpose?: 'preview' | 'download' | 'icon';
}) => Promise<PublicResponse>;

export const requestPublicPreview: PreviewRequest = ({
  url,
  address,
  signal,
  maxBytes,
  metadata,
  purpose = 'preview',
}) =>
  new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = transport(
      url,
      {
        agent: false,
        signal,
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address, family: isIP(address) }]);
          else callback(null, address, isIP(address));
        },
        headers: {
          'User-Agent': purpose === 'download' ? 'nod-FileDownload/1.0' : 'nod-LinkPreview/1.0',
          Accept:
            purpose === 'download'
              ? '*/*'
              : purpose === 'icon'
                ? 'image/x-icon,image/vnd.microsoft.icon,image/png,image/jpeg,image/webp'
                : 'text/html,application/xhtml+xml,image/png,image/jpeg,image/webp',
          'Accept-Encoding': 'identity',
        },
        maxHeaderSize: 16384,
      },
      (response) => {
        const headers = Object.fromEntries(
          ['content-type', 'content-length', 'content-encoding', 'location'].map((key) => [
            key,
            typeof response.headers[key] === 'string' ? response.headers[key] : undefined,
          ]),
        );
        const status = response.statusCode ?? 0;
        const head =
          metadata &&
          /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(headers['content-type'] ?? '');
        const limit = head ? Math.min(maxBytes, 512 * 1024) : maxBytes;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy();
          resolve({ status, headers, body: new Uint8Array() });
          return;
        }
        if (
          (headers['content-encoding'] && headers['content-encoding'] !== 'identity') ||
          (!head && Number(headers['content-length']) > maxBytes)
        ) {
          response.destroy();
          reject(new Error('Preview response is not supported.'));
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          const remaining = limit - length;
          length += chunk.length;
          if (length > limit && !head) {
            response.destroy(new Error('Preview response is too large.'));
            return;
          }
          chunks.push(chunk.subarray(0, remaining));
          if (head && (length >= limit || Buffer.concat(chunks).includes(Buffer.from('</head>')))) {
            response.destroy();
            resolve({ status, headers, body: Buffer.concat(chunks) });
          }
        });
        response.on('error', reject);
        response.on('end', () => resolve({ status, headers, body: Buffer.concat(chunks) }));
      },
    );
    request.on('error', reject);
    request.end();
  });

function iconUrl(value: string) {
  if (value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /\.[^.]/.test(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

function icoImage(bytes: Uint8Array) {
  const value = Buffer.from(bytes);
  if (value.length < 22 || value.readUInt32LE(0) !== 0x10000) return false;
  const count = value.readUInt16LE(4);
  if (!count || value.length < 6 + count * 16) return false;
  for (let index = 0; index < count; index++) {
    const size = value.readUInt32LE(6 + index * 16 + 8);
    const offset = value.readUInt32LE(6 + index * 16 + 12);
    if (size > 0 && offset >= 6 + count * 16 && offset + size <= value.length) return true;
  }
  return false;
}

function iconLinks(html: string) {
  const links = new Set<string>();
  const document = parse(html);
  const root = document.childNodes.find((node) => node.nodeName === 'html');
  const head =
    root && 'childNodes' in root ? root.childNodes.find((node) => node.nodeName === 'head') : null;
  for (const node of head && 'childNodes' in head ? head.childNodes : []) {
    if (node.nodeName !== 'link' || !('attrs' in node)) continue;
    const attrs = new Map(node.attrs.map((attr) => [attr.name.toLowerCase(), attr.value]));
    const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
    const href = attrs.get('href')?.trim();
    if (
      href &&
      (rel.includes('icon') ||
        rel.includes('apple-touch-icon') ||
        rel.includes('apple-touch-icon-precomposed')) &&
      !/svg/i.test(attrs.get('type') ?? '') &&
      !/\.svgz?(?:[?#]|$)/i.test(href) &&
      !/^data:/i.test(href)
    ) {
      links.add(href);
      if (links.size === 8) break;
    }
  }
  return [...links];
}

function pageImage(html: string) {
  const document = parse(html);
  const root = document.childNodes.find((node) => node.nodeName === 'html');
  const head =
    root && 'childNodes' in root ? root.childNodes.find((node) => node.nodeName === 'head') : null;
  const found = new Map<string, string>();
  for (const node of head && 'childNodes' in head ? head.childNodes : []) {
    if (node.nodeName !== 'meta' || !('attrs' in node)) continue;
    const attrs = new Map(node.attrs.map((attr) => [attr.name.toLowerCase(), attr.value]));
    const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase();
    const content = attrs.get('content')?.trim();
    if (content && !found.has(key)) found.set(key, content);
  }
  return (
    found.get('og:image:secure_url') ??
    found.get('og:image') ??
    found.get('og:image:url') ??
    found.get('twitter:image') ??
    found.get('twitter:image:src') ??
    null
  );
}

export function createPublicLinkPreviewProvider(
  options: { resolver?: AddressResolver; request?: PreviewRequest; timeoutMs?: number } = {},
): LinkPreviewProvider {
  const request = options.request ?? requestPublicPreview;
  const tiles = new Map<string, { expiresAt: number; value: Promise<PreviewImage | null> }>();
  async function fetchPublic(
    value: string,
    maxBytes: number,
    metadata: boolean,
    signal: AbortSignal,
    purpose?: 'icon',
  ) {
    let current = value;
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted();
      const safe = iconUrl(current);
      if (!safe) throw new Error('Preview destination is not supported.');
      const resolved = await new Promise<Awaited<ReturnType<typeof publicUrl>>>(
        (resolve, reject) => {
          const aborted = () => reject(new Error('Preview timed out.'));
          signal.addEventListener('abort', aborted, { once: true });
          void publicUrl(safe, options.resolver).then(
            (value) => {
              signal.removeEventListener('abort', aborted);
              resolve(value);
            },
            (error) => {
              signal.removeEventListener('abort', aborted);
              reject(error);
            },
          );
        },
      );
      signal.throwIfAborted();
      const result = await request({
        ...resolved,
        signal,
        maxBytes,
        metadata,
        purpose,
      });
      signal.throwIfAborted();
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        if (!result.headers.location) throw new Error('Preview redirect is not supported.');
        current = new URL(result.headers.location, resolved.url).href;
        continue;
      }
      if (
        result.status !== 200 ||
        result.body.byteLength > maxBytes ||
        (result.headers['content-encoding'] && result.headers['content-encoding'] !== 'identity')
      )
        throw new Error('Preview response is not supported.');
      return { ...result, url: resolved.url.href };
    }
    throw new Error('Too many preview redirects.');
  }
  return {
    async image(value, stop) {
      const timeout = AbortSignal.timeout(Math.min(6000, options.timeoutMs ?? 6000));
      const signal = stop ? AbortSignal.any([stop, timeout]) : timeout;
      const imageMax = 3 * 1024 * 1024;
      const raster = (body: Uint8Array): PreviewImage | null => {
        const mimeType = rasterImageType(body);
        return mimeType ? { bytes: body, mimeType } : null;
      };
      try {
        const first = await fetchPublic(value, imageMax, true, signal);
        if (/^image\//i.test(first.headers['content-type'] ?? '')) return raster(first.body);
        if (
          !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
            first.headers['content-type'] ?? '',
          )
        )
          return null;
        const href = pageImage(Buffer.from(first.body.subarray(0, 512 * 1024)).toString('utf8'));
        if (!href || /^data:/i.test(href) || /\.svgz?(?:[?#]|$)/i.test(href)) return null;
        const image = await fetchPublic(new URL(href, first.url).href, imageMax, false, signal);
        return raster(image.body);
      } catch {
        return null;
      }
    },
    mapTile(zoom, x, y, stop) {
      if (stop?.aborted) return Promise.resolve(null);
      const key = `${zoom}/${((x % 2 ** zoom) + 2 ** zoom) % 2 ** zoom}/${y}`;
      let entry = tiles.get(key);
      if (!entry || entry.expiresAt <= Date.now()) {
        tiles.delete(key);
        const timeout = AbortSignal.timeout(Math.min(6000, options.timeoutMs ?? 6000));
        const value = fetchPublic(
          `https://tile.openstreetmap.org/${key}.png`,
          512 * 1024,
          false,
          timeout,
        )
          .then((tile) => {
            const mimeType = rasterImageType(tile.body);
            return mimeType ? { bytes: tile.body, mimeType } : null;
          })
          .catch(() => null)
          .then((tile) => {
            if (!tile && tiles.get(key)?.value === value) tiles.delete(key);
            return tile;
          });
        entry = { expiresAt: Date.now() + 7 * 86_400_000, value };
        tiles.set(key, entry);
        while (tiles.size > 256) tiles.delete(tiles.keys().next().value!);
      }
      if (!stop) return entry.value;
      return new Promise<PreviewImage | null>((resolve) => {
        const onAbort = () => resolve(null);
        stop.addEventListener('abort', onAbort, { once: true });
        entry.value.then((tile) => {
          stop.removeEventListener('abort', onAbort);
          resolve(stop.aborted ? null : tile);
        });
      });
    },
    async icon(origin) {
      const signal = AbortSignal.timeout(Math.min(8000, options.timeoutMs ?? 8000));
      const fetchIcon = async (url: string): Promise<SiteIcon | null> => {
        const result = await fetchPublic(url, 128 * 1024, false, signal, 'icon');
        const mimeType = icoImage(result.body) ? 'image/x-icon' : rasterImageType(result.body);
        return mimeType ? { bytes: result.body, mimeType } : null;
      };
      try {
        const icon = await fetchIcon(new URL('/favicon.ico', origin).href);
        if (icon) return icon;
      } catch {}
      try {
        const page = await fetchPublic(new URL('/', origin).href, 256 * 1024, true, signal);
        if (
          !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
            page.headers['content-type'] ?? '',
          )
        )
          return null;
        for (const href of iconLinks(Buffer.from(page.body).toString('utf8'))) {
          if (signal.aborted) return null;
          try {
            const icon = await fetchIcon(new URL(href, page.url).href);
            if (icon) return icon;
          } catch {}
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}
