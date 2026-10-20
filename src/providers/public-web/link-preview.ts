import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { parse } from 'parse5';
import { getDomainWithoutSuffix as domainWithoutSuffix } from 'tldts';
import type {
  LinkPreviewProvider,
  PublicLinkMetadata,
  SiteIcon,
} from '../../ports/link-preview.ts';
import { previewableUrl, publicMediaUrl } from '../../shared/link-preview.ts';
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
          'User-Agent': purpose === 'download' ? 'Otto-FileDownload/1.0' : 'Otto-LinkPreview/1.0',
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

function clean(value: string | undefined, max: number) {
  return (
    value
      ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max) || undefined
  );
}

function siteTitle(title: string | undefined, url: string, siteName?: string) {
  if (!title) return title;
  const squash = (value: string) =>
    value
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, '');
  const sites = [siteName, domainWithoutSuffix(url)]
    .map((value) => value && squash(value))
    .filter(Boolean);
  const matches = (value: string) => sites.includes(squash(value));
  const end = /^(.*\S)\s*[:|\-–—]\s+(.+)$/.exec(title);
  const trimmed = end && matches(end[2]) ? end[1] : title;
  const start = /^(.+?)\s*[:|\-–—]\s+(\S.*)$/.exec(trimmed);
  const result = start && matches(start[1]) ? start[2] : trimmed;
  return matches(result) ? undefined : result;
}

function jsonLdImage(text: string): string | undefined {
  try {
    const stack: unknown[] = [JSON.parse(text)];
    for (let steps = 0; stack.length && steps < 200; steps++) {
      const value = stack.pop();
      if (!value || typeof value !== 'object') continue;
      if (Array.isArray(value)) {
        stack.push(...value);
        continue;
      }
      const record = value as Record<string, unknown>;
      const image = Array.isArray(record.image) ? record.image[0] : record.image;
      const source = image && typeof image === 'object' ? (image as Record<string, unknown>) : {};
      const url = [image, source.contentUrl, source.url].find((value) => typeof value === 'string');
      if (typeof url === 'string') return url;
      if (record['@graph']) stack.push(record['@graph']);
    }
  } catch {}
  return undefined;
}

export function parseLinkMetadata(html: string, url: string): PublicLinkMetadata | null {
  const document = parse(html);
  const head = document.childNodes.find((node) => node.nodeName === 'html');
  const elements = head && 'childNodes' in head ? head.childNodes : [];
  const container = elements.find((node) => node.nodeName === 'head');
  const nodes = container && 'childNodes' in container ? container.childNodes : [];
  const meta = new Map<string, string>();
  const images: string[] = [];
  let title = '';
  for (const node of nodes) {
    if (!('attrs' in node)) continue;
    const attrs = new Map(node.attrs.map((attr) => [attr.name.toLowerCase(), attr.value]));
    if (node.nodeName === 'meta') {
      const key = (attrs.get('property') ?? attrs.get('name'))?.toLowerCase();
      if (key && attrs.has('content') && !meta.has(key)) meta.set(key, attrs.get('content')!);
      if (attrs.get('itemprop') === 'image' && attrs.get('content'))
        images.push(attrs.get('content')!);
    }
    if (node.nodeName === 'link' && attrs.get('href')) {
      const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
      if (rel.includes('image_src')) images.push(attrs.get('href')!);
    }
    if (
      node.nodeName === 'script' &&
      attrs.get('type')?.toLowerCase() === 'application/ld+json' &&
      'childNodes' in node
    ) {
      const image = jsonLdImage(
        node.childNodes.map((child) => ('value' in child ? child.value : '')).join(''),
      );
      if (image) images.push(image);
    }
    if (node.nodeName === 'title' && 'childNodes' in node)
      title = node.childNodes.map((child) => ('value' in child ? child.value : '')).join('');
  }
  const published = [meta.get('og:title'), meta.get('twitter:title'), title]
    .map((value) => clean(value, 200))
    .find(Boolean);
  const media = (value: string | undefined, secure = false) => {
    try {
      const resolved = value && publicMediaUrl(new URL(value, url).href);
      return resolved && (!secure || resolved.startsWith('https:')) ? resolved : undefined;
    } catch {
      return undefined;
    }
  };
  const image = [
    meta.get('og:image:secure_url'),
    meta.get('og:image'),
    meta.get('og:image:url'),
    meta.get('twitter:image'),
    meta.get('twitter:image:src'),
    ...images,
  ]
    .map((value) => media(value))
    .find(Boolean);
  const player =
    media(meta.get('twitter:player'), true) ??
    (meta.get('og:video:type')?.toLowerCase() === 'text/html'
      ? media(
          meta.get('og:video:secure_url') ?? meta.get('og:video:url') ?? meta.get('og:video'),
          true,
        )
      : undefined);
  const siteName = clean(meta.get('og:site_name'), 100);
  const resultTitle = siteTitle(published, url, siteName);
  return {
    url,
    ...(resultTitle ? { title: resultTitle } : {}),
    description: clean(
      meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'),
      400,
    ),
    siteName,
    ...(image ? { image } : {}),
    ...(player ? { player } : {}),
  };
}

export function decodeHtml(body: Uint8Array, contentType = '') {
  const start = Buffer.from(body.subarray(0, 2048)).toString('latin1');
  const label =
    /charset\s*=\s*["']?\s*([\w-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(start)?.[1] ??
    'utf-8';
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    return new TextDecoder().decode(body);
  }
}

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
    metadata = maxBytes < 1024 * 1024,
    destination = previewableUrl,
    signal = AbortSignal.timeout(Math.min(5000, options.timeoutMs ?? 5000)),
    purpose?: 'icon',
  ) {
    let current = value;
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted();
      const safe = destination(current);
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
    async metadata(url) {
      try {
        const result = await fetchPublic(url, 1024 * 1024, true);
        if (
          !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
            result.headers['content-type'] ?? '',
          )
        )
          return null;
        const metadata = parseLinkMetadata(
          decodeHtml(result.body, result.headers['content-type']),
          result.url,
        );
        if (!metadata?.player) return metadata;
        const { player, ...rest } = metadata;
        return (await publicUrl(player, options.resolver).then(
          () => true,
          () => false,
        ))
          ? metadata
          : rest;
      } catch {
        return null;
      }
    },
    async icon(origin) {
      const signal = AbortSignal.timeout(Math.min(8000, options.timeoutMs ?? 8000));
      const fetchIcon = async (url: string): Promise<SiteIcon | null> => {
        const result = await fetchPublic(url, 128 * 1024, false, iconUrl, signal, 'icon');
        const mimeType = icoImage(result.body) ? 'image/x-icon' : rasterImageType(result.body);
        return mimeType ? { bytes: result.body, mimeType } : null;
      };
      try {
        const icon = await fetchIcon(new URL('/favicon.ico', origin).href);
        if (icon) return icon;
      } catch {}
      try {
        const page = await fetchPublic(
          new URL('/', origin).href,
          256 * 1024,
          true,
          iconUrl,
          signal,
        );
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
    async image(url) {
      try {
        const result = await fetchPublic(url, 5 * 1024 * 1024, false, publicMediaUrl);
        const mimeType = rasterImageType(result.body);
        const declared = result.headers['content-type']?.split(';')[0].trim().toLowerCase();
        if (!mimeType || (declared === 'image/jpg' ? 'image/jpeg' : declared) !== mimeType)
          return null;
        return { bytes: result.body, mimeType };
      } catch {
        return null;
      }
    },
  };
}
