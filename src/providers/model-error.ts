export function modelErrorText(value: string, secrets: string[] = []) {
  const values = [
    ...new Set(
      secrets.filter(Boolean).flatMap((value) => {
        const variants = [value, JSON.stringify(value).slice(1, -1)];
        try {
          variants.push(encodeURIComponent(value));
        } catch {}
        return variants;
      }),
    ),
  ].sort((left, right) => right.length - left.length);
  if (!values.length) return value;
  let result = '';
  for (let at = 0; at < value.length;) {
    const secret = values.find((secret) => value.startsWith(secret, at));
    result += secret ? '[redacted]' : value[at];
    at += secret?.length ?? 1;
  }
  return result;
}

export class ModelServiceError extends Error {
  constructor(
    message: string,
    readonly reason?: string,
    readonly status?: number,
    readonly details?: string,
  ) {
    super(message);
  }
}

export async function modelServiceError(
  response: Response,
  service: string,
  secrets: string[] = [],
  detailFields = ['message', 'type', 'code', 'status', 'param'],
) {
  let reason = response.statusText;
  let serviceReason: string | undefined;
  const reader = response.body?.getReader();
  try {
    if (
      reader &&
      /\/(?:json|[\w.-]+\+json)$/i.test(
        response.headers.get('content-type')?.split(';', 1)[0].trim() ?? '',
      )
    ) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16_384) break;
        chunks.push(value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const error = body.error ?? body;
      if (typeof error === 'string') reason = serviceReason = error;
      else if (error && typeof error === 'object') {
        if (typeof error.message === 'string') serviceReason = error.message;
        else if (detailFields.includes('description') && typeof error.description === 'string')
          serviceReason = error.description;
        const fields = detailFields.flatMap((name) =>
          typeof error[name] === 'string' || typeof error[name] === 'number'
            ? [`${name}: ${error[name]}`]
            : [],
        );
        if (fields.length) reason = fields.join('; ');
      }
    }
  } catch {
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
  const details = modelErrorText(reason, secrets).slice(0, 2000);
  return new ModelServiceError(
    `${service} failed (HTTP ${response.status})${reason ? `: ${details}` : '.'}`,
    serviceReason ? modelErrorText(serviceReason, secrets) : undefined,
    Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
      ? response.status
      : undefined,
    details,
  );
}
