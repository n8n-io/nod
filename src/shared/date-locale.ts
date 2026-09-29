export function localeRegion(value: string | null | undefined) {
  if (!value) return null;
  try {
    return new Intl.Locale(value).maximize().region ?? null;
  } catch {
    return null;
  }
}

export function formattingLocale(region: string | null) {
  const candidate = `en-${region ?? 'GB'}`;
  try {
    if (new Intl.DateTimeFormat(candidate).resolvedOptions().locale === candidate) return candidate;
  } catch {}
  return 'en-GB';
}

export function clockOptions(
  locale: string,
  hourCycle: 'auto' | 'h12' | 'h23',
): Intl.DateTimeFormatOptions {
  const cycle =
    hourCycle === 'auto'
      ? new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle
      : hourCycle;
  return {
    hour: cycle === 'h11' || cycle === 'h12' ? 'numeric' : '2-digit',
    minute: '2-digit',
    ...(hourCycle === 'auto' ? {} : { hourCycle }),
  };
}
