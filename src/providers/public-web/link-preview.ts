import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { parse } from 'parse5';
import type { LinkPreviewProvider, SiteIcon } from '../../ports/link-preview.ts';
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
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy();
          resolve({ status, headers, body: new Uint8Array() });
          return;
        }
        if (
          (headers['content-encoding'] && headers['content-encoding'] !== 'identity') ||
          (!metadata && Number(headers['content-length']) > maxBytes)
        ) {
          response.destroy();
          reject(new Error('Preview response is not supported.'));
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          const remaining = maxBytes - length;
          length += chunk.length;
          if (length > maxBytes && !metadata) {
            response.destroy(new Error('Preview response is too large.'));
            return;
          }
          chunks.push(chunk.subarray(0, remaining));
          if (
            metadata &&
            (length >= maxBytes || Buffer.concat(chunks).includes(Buffer.from('</head>')))
          ) {
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

export function createPublicLinkPreviewProvider(
  options: { resolver?: AddressResolver; request?: PreviewRequest; timeoutMs?: number } = {},
): LinkPreviewProvider {
  const request = options.request ?? requestPublicPreview;
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
