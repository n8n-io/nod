import { openAIRegions, type OpenAIRegion } from '../../shared/models.ts';

export function openAIBaseUrl(region: OpenAIRegion = 'global') {
  if (!Object.hasOwn(openAIRegions, region)) throw new Error('Choose an OpenAI API region.');
  return `https://${region === 'global' ? '' : `${region}.`}api.openai.com/v1`;
}

export class OpenAIRequestError extends Error {
  constructor(
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

export async function openAIRequestError(response: Response, key: string) {
  const redact = (value: string) => (key ? value.replaceAll(key, '[redacted]') : value);
  let detail = response.statusText;
  let reason: string | undefined;
  const reader = response.body?.getReader();
  try {
    if (reader && response.headers.get('content-type')?.includes('application/json')) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16_384) throw new Error('The error response is too large.');
        chunks.push(value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const error = body.error ?? body;
      if (typeof error === 'string') detail = reason = redact(error);
      else if (error && typeof error === 'object') {
        if (typeof error.message === 'string') reason = redact(error.message);
        const fields = Object.fromEntries(
          ['message', 'type', 'code', 'param'].flatMap((name) =>
            typeof error[name] === 'string' || typeof error[name] === 'number'
              ? [[name, typeof error[name] === 'string' ? redact(error[name]) : error[name]]]
              : [],
          ),
        );
        if (Object.keys(fields).length) detail = JSON.stringify(fields);
      }
    }
  } catch {
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
  return new OpenAIRequestError(
    `OpenAI API request failed (${response.status})${detail ? `: ${redact(detail)}` : '.'}`,
    reason,
  );
}
