export function errorCode(error: unknown) {
  for (const value of [error, (error as { cause?: unknown } | null | undefined)?.cause]) {
    const code = (value as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string' && /^(?:[0-9A-Z]{5}|[A-Z][A-Z0-9_]{0,31})$/.test(code))
      return code;
  }
}
