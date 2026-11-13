export class ModelServiceError extends Error {
  constructor(
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

export async function modelServiceError(
  response: Response,
  service: string,
  secrets: string[] = [],
) {
  const redact = (value: string) =>
    secrets.reduce(
      (text, secret) => (secret ? text.replaceAll(secret, '[redacted]') : text),
      value,
    );
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
        const fields = ['message', 'type', 'code', 'status', 'param'].flatMap((name) =>
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
  return new ModelServiceError(
    `${service} failed (HTTP ${response.status})${reason ? `: ${redact(reason).slice(0, 2000)}` : '.'}`,
    serviceReason ? redact(serviceReason) : undefined,
  );
}
