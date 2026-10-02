function field(value: unknown) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).slice(0, 64)
    : undefined;
}

export function logFailure(event: string, error: unknown) {
  const { name, code, statusCode } = (error ?? {}) as Record<string, unknown>;
  console.error(
    JSON.stringify({ event, name: field(name), code: field(code), statusCode: field(statusCode) }),
  );
}
