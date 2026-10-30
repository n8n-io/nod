import { readFile, stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { PrivacyNoticeResponse } from '../shared/privacy.ts';

function parsePrivacyNotice(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('Configure a valid public privacy notice.');
  return value.trim() || undefined;
}

export async function loadPrivacyNoticeFile(path?: string): Promise<string | undefined> {
  if (path === undefined) return undefined;
  try {
    if (typeof path !== 'string') throw new Error();
    if (!path.trim()) return undefined;
    if (!(await stat(path)).isFile()) throw new Error();
    const content = parsePrivacyNotice(
      new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path)),
    );
    if (!content) throw new Error();
    return content;
  } catch {
    throw new Error('Configure a valid public privacy notice.');
  }
}

export function registerPrivacyNotice(app: FastifyInstance, notice?: string) {
  const content = parsePrivacyNotice(notice) ?? null;
  app.get('/api/privacy', async (_request, reply): Promise<PrivacyNoticeResponse> => {
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
    return { content };
  });
}
