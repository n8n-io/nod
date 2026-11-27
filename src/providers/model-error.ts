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

const MAX_MODEL_ERROR_BODY_SIZE = 64 * 1024;
const MAX_MODEL_ERROR_TEXT_SIZE = 2000;
const MODEL_ERROR_REDACTED_MARKER = '[redacted]';

function modelErrorTextForOutput(value: string, secrets: string[]) {
  return value
    .split(MODEL_ERROR_REDACTED_MARKER)
    .map((part) => modelErrorText(part, secrets))
    .join(MODEL_ERROR_REDACTED_MARKER);
}

export async function modelServiceError(
  response: Response,
  service: string,
  secrets: string[] = [],
  detailFields = ['message', 'type', 'code', 'status', 'param'],
) {
  let reason = modelErrorText(response.statusText, secrets);
  let serviceReason: string | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.body?.getReader();
    if (
      reader &&
      /\/(?:json|[\w.-]+\+json)$/i.test(
        response.headers.get('content-type')?.split(';', 1)[0].trim() ?? '',
      )
    ) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      let complete = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          complete = true;
          break;
        }
        if (size + value.length > MAX_MODEL_ERROR_BODY_SIZE) break;
        size += value.length;
        chunks.push(value);
      }
      if (complete) {
        const body: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
        const text = (value: unknown) =>
          typeof value === 'string' && value.trim()
            ? modelErrorText(value.trim(), secrets).slice(0, MAX_MODEL_ERROR_TEXT_SIZE)
            : undefined;
        const fieldValue = (value: unknown) =>
          typeof value === 'number' && Number.isFinite(value)
            ? modelErrorTextForOutput(`${value}`, secrets).slice(0, MAX_MODEL_ERROR_TEXT_SIZE)
            : text(value);
        const fields = (error: Record<string, unknown>, message?: string) =>
          detailFields.flatMap((name) => {
            const selected = name === 'message' && message ? message : fieldValue(error[name]);
            return selected ? [`${name}: ${selected}`] : [];
          });
        const parseValidationDetails = (validationDetails: unknown[]) => {
          const entries = validationDetails.slice(0, 10);
          const selected: string[] = [];
          let message: string | undefined;
          for (const entry of entries) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
            const validation = entry as Record<string, unknown>;
            const msg = text(validation.msg);
            const entryMessage = text(validation.message);
            message ??= msg ?? entryMessage;
            if (msg) selected.push(`msg: ${msg}`);
            for (const name of detailFields) {
              if (name === 'message' && msg && !entryMessage) continue;
              const field =
                name === 'message' && entryMessage ? entryMessage : fieldValue(validation[name]);
              if (field) selected.push(`${name}: ${field}`);
            }
          }
          const formatted = selected.length ? selected.join('; ') : undefined;
          return {
            details: formatted,
            reason: message,
          };
        };
        const parseError = (value: unknown): { details?: string; reason?: string } | undefined => {
          if (typeof value === 'string') {
            const selected = text(value);
            if (!selected) return;
            return { details: selected, reason: selected };
          }
          if (Array.isArray(value)) {
            let fallback: { details?: string; reason?: string } | undefined;
            for (const entry of value.slice(0, 10)) {
              const parsed = parseError(entry);
              if (parsed?.reason) return parsed;
              fallback ??= parsed;
            }
            return fallback;
          }
          if (!value || typeof value !== 'object') return;
          const envelope = value as Record<string, unknown>;
          const error = envelope.error;
          let selected: Record<string, unknown>;
          if (error !== undefined && error !== null) {
            if (typeof error === 'string') return parseError(error);
            if (!error || typeof error !== 'object' || Array.isArray(error)) return;
            selected = error as Record<string, unknown>;
          } else if (
            typeof envelope.message !== 'string' &&
            envelope.detail &&
            typeof envelope.detail === 'object' &&
            !Array.isArray(envelope.detail)
          ) {
            selected = envelope.detail as Record<string, unknown>;
          } else {
            selected = envelope;
          }
          if (Array.isArray(selected.detail)) {
            const parsed = parseValidationDetails(selected.detail);
            if (parsed.details || parsed.reason) return parsed;
          }
          const message = text(selected.message) ?? text(selected.detail);
          const fallbackReason =
            message ??
            (detailFields.includes('description') ? text(selected.description) : undefined);
          const formatted = fields(selected, message);
          return {
            details: formatted.length ? formatted.join('; ') : undefined,
            reason: fallbackReason,
          };
        };
        const parsed = parseError(body);
        if (parsed?.details) reason = parsed.details;
        if (parsed?.reason) serviceReason = parsed.reason;
      }
    }
  } catch {
  } finally {
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const details = modelErrorTextForOutput(reason, secrets).slice(0, MAX_MODEL_ERROR_TEXT_SIZE);
  return new ModelServiceError(
    `${service} failed (HTTP ${response.status})${reason ? `: ${details}` : '.'}`,
    serviceReason
      ? modelErrorTextForOutput(serviceReason, secrets).slice(0, MAX_MODEL_ERROR_TEXT_SIZE)
      : undefined,
    Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
      ? response.status
      : undefined,
    details,
  );
}
