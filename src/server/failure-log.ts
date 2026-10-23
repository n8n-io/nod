import { AsyncLocalStorage } from 'node:async_hooks';

export type FailureLogSink = (
  event: string,
  error: unknown,
  context?: Record<string, unknown>,
) => void;

const failures = new AsyncLocalStorage<FailureLogSink>();

export function withFailureLog<T>(sink: FailureLogSink, run: () => T): T {
  return failures.run(sink, run);
}

function field(value: unknown) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).slice(0, 64)
    : undefined;
}

export function logFailure(event: string, error: unknown, context?: Record<string, unknown>) {
  try {
    void Promise.resolve(failures.getStore()?.(event, error, context)).catch(() => {});
  } catch {}
  const { name, code, statusCode } = (error ?? {}) as Record<string, unknown>;
  console.error(
    JSON.stringify({ event, name: field(name), code: field(code), statusCode: field(statusCode) }),
  );
}
