import { modelProviderInfo } from '../shared/models.ts';

const payloadDefault = 16_384;
const hidden = '[redacted]';
const secretNames =
  'password|passwd|pwd|passphrase|secret|clientsecret|authorization|proxyauthorization|cookie|setcookie|apikey|xapikey|xauthtoken|xcsrftoken|csrftoken|sessiontoken|accesskey|privatekey|signingkey|masterkey|vaultkey|token|accesstoken|refreshtoken|idtoken|bottoken|credential|credentials|otp|otpcode|verificationcode|totp|totpsecret|cvv|cvc|pan|cardnumber';
const secretKey = new RegExp(`^(?:${secretNames})$`, 'i');
const secretAssignment = new RegExp(
  String.raw`((["']?)\b(?:${secretNames
    .split('|')
    .map((name) => name.split('').join('[-_]?'))
    .join('|')})\2\s*[:=]\s*)(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s,;}&]+)`,
  'gi',
);

const tokenShapes = String.raw`\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b|-----BEGIN [^-]*PRIVATE KEY-----`;
export const secretToken = new RegExp(tokenShapes);

export function environmentSecrets(environment: Record<string, string | undefined>) {
  const modelKeys = new Set(Object.values(modelProviderInfo).map((provider) => provider.env));
  const secrets = Object.entries(environment)
    .filter(
      ([key]) =>
        modelKeys.has(key) ||
        /(?:API_KEY|SECRET|PASSWORD|VAULT_KEY|BOT_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|FEEDBACK_TOKEN|TRACES_TOKEN|UPDATES_TOKEN)$/.test(
          key,
        ),
    )
    .flatMap(([, value]) => (value ? [value] : []));
  if (environment.DATABASE_URL) {
    secrets.push(environment.DATABASE_URL);
    try {
      const password = decodeURIComponent(new URL(environment.DATABASE_URL).password);
      if (password) secrets.push(password);
    } catch {}
  }
  return secrets;
}

export function redactSecretText(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, hidden)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=:-]+/gi, hidden)
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:\s*[^\r\n]+/gi,
      hidden,
    )
    .replace(new RegExp(tokenShapes, 'g'), hidden)
    .replace(
      /((?:https?:\/\/[^\s/"'<>]+)?\/(?:vault|credentials|approvals)\/)[^\s"'<>]+/gi,
      '$1[redacted]',
    )
    .replace(
      /([?&#](?:access_token|refresh_token|id_token|token|code|state|key|api_key|secret|password|signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)=)[^\s&"'<>]*/gi,
      '$1[redacted]',
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(secretAssignment, '$1[redacted]')
    .replace(/\bdata:[^,\s]+;base64,[A-Za-z0-9+/=]+/g, '[binary omitted]');
}

function secretText(secrets: string[], minimumSecretLength = 8) {
  const values = [
    ...new Set(
      secrets
        .flatMap((value) => [value, value.trim()])
        .filter((value) => value.length >= minimumSecretLength),
    ),
  ].sort((a, b) => b.length - a.length);
  const secretVariants = [...new Set(values.flatMap((value) => [value, encodeURIComponent(value)]))]
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&'));
  const secretPattern = secretVariants.length ? new RegExp(secretVariants.join('|'), 'g') : null;
  return (value: string): string =>
    redactSecretText(secretPattern ? value.replace(secretPattern, hidden) : value);
}

function compileRedactor(
  secrets: string[] = [],
  limits: { string?: number; payload?: number; minimumSecretLength?: number } = {},
) {
  const stringLimit = Math.min(64_000, Math.max(100, limits.string ?? 8000));
  const payloadLimit = Math.min(160_000, Math.max(1000, limits.payload ?? payloadDefault));
  const text = secretText(secrets, limits.minimumSecretLength);
  return function redact(value: unknown): unknown {
    let nodes = 0;
    let fragments = 0;
    let scanned = 0;
    const seen = new WeakSet<object>();
    function embedded(value: string, depth: number): string {
      if (scanned + value.length > 512_000) return '[structured data omitted]';
      scanned += value.length;
      const bounded = value.slice(0, 64_000);
      let result = '';
      let offset = 0;
      const openings = /\{(?=\s*["}])|\[(?=\s*(?:[\[\]{"\d-]|true\b|false\b|null\b))/g;
      for (let match = openings.exec(bounded); match; match = openings.exec(bounded)) {
        const start = match.index;
        result += text(bounded.slice(offset, start));
        if (++fragments > 32) return result + '[structured data omitted]';
        const stack: string[] = [];
        let quoted = false;
        let escaped = false;
        let complete = false;
        let end = start;
        for (; end < bounded.length; end++) {
          const char = bounded[end];
          if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
          } else if (char === '"') quoted = true;
          else if (char === '{' || char === '[') stack.push(char === '{' ? '}' : ']');
          else if (char === '}' || char === ']') {
            if (stack.pop() !== char) break;
            if (stack.length === 0) {
              complete = true;
              end++;
              break;
            }
          }
        }
        if (!complete) return result + '[incomplete structured data omitted]';
        try {
          result += JSON.stringify(visit(JSON.parse(bounded.slice(start, end)), depth + 1));
        } catch {
          result += '[invalid structured data omitted]';
        }
        offset = end;
        openings.lastIndex = end;
      }
      return (
        result + text(bounded.slice(offset)) + (value.length > bounded.length ? ' [truncated]' : '')
      );
    }
    function visit(item: unknown, depth: number): unknown {
      if (++nodes > 1200 || depth > 12) return '[truncated]';
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
          if (trimmed.length >= 64_000) return '[oversized JSON payload omitted]';
          try {
            return visit(JSON.parse(trimmed), depth + 1);
          } catch {}
        }
        const safe = embedded(item, depth);
        return safe.length > stringLimit ? safe.slice(0, stringLimit) + ' [truncated]' : safe;
      }
      if (item === null || typeof item === 'boolean') return item;
      if (typeof item === 'number') return Number.isFinite(item) ? item : null;
      if (typeof item !== 'object') return '[omitted]';
      if (seen.has(item)) return '[circular]';
      seen.add(item);
      if (Buffer.isBuffer(item) || item instanceof Uint8Array) return '[binary omitted]';
      if (item instanceof Date) return Number.isFinite(item.getTime()) ? item.toISOString() : null;
      if (Array.isArray(item)) {
        if (typeof item[0] === 'string' && secretKey.test(item[0].replace(/[^a-z0-9]/gi, '')))
          return [text(item[0]), hidden];
        const result = item.slice(0, 100).map((entry) => visit(entry, depth + 1));
        if (item.length > 100) result.push('[truncated]');
        return result;
      }
      const result: Record<string, unknown> = Object.create(null);
      const namedSecret =
        'name' in item &&
        typeof item.name === 'string' &&
        secretKey.test(item.name.replace(/[^a-z0-9]/gi, ''));
      for (const [key, entry] of Object.entries(item).slice(0, 100)) {
        const normalized = key.replace(/[^a-z0-9]/gi, '');
        result[text(key)] =
          secretKey.test(normalized) || (namedSecret && key === 'value')
            ? hidden
            : (key === 'data' &&
                  'type' in item &&
                  ['image', 'audio', 'base64'].includes(String(item.type))) ||
                ['image_url', 'audio_url', 'base64'].includes(key)
              ? '[binary omitted]'
              : visit(entry, depth + 1);
      }
      return result;
    }
    const safe = visit(value, 0);
    const encoded = JSON.stringify(safe);
    if (Buffer.byteLength(encoded) <= payloadLimit) return safe;
    let preview = encoded.slice(0, 8000);
    while (Buffer.byteLength(JSON.stringify({ preview, truncated: true })) > payloadLimit)
      preview = preview.slice(0, Math.floor(preview.length * 0.8));
    return { preview, truncated: true };
  };
}

export function createRedactor(
  secrets: string[] = [],
  limits: Parameters<typeof compileRedactor>[1] = {},
) {
  let size = -1;
  let redact: ReturnType<typeof compileRedactor>;
  return (value: unknown) => {
    if (size !== secrets.length) {
      redact = compileRedactor(secrets, limits);
      size = secrets.length;
    }
    return redact(value);
  };
}

export function createTextRedactor(secrets: string[]) {
  let size = -1;
  let text: ReturnType<typeof secretText>;
  return (value: string) => {
    if (size !== secrets.length) {
      text = secretText(secrets);
      size = secrets.length;
    }
    return text(value);
  };
}

export function createErrorRedactor(secrets: string[]) {
  const redact = createRedactor(secrets, { string: 64_000, payload: 160_000 });
  return (text: string) => {
    const safe = redact(text);
    return typeof safe === 'string' ? safe : JSON.stringify(safe);
  };
}

export function withoutSecretKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    const namedSecret =
      typeof value[0] === 'string' && secretKey.test(value[0].replace(/[^a-z0-9]/gi, ''));
    return value.map((entry, index) =>
      namedSecret && index === 1 ? hidden : withoutSecretKeys(entry),
    );
  }
  if (!value || typeof value !== 'object') return value;
  const namedSecret =
    'name' in value &&
    typeof value.name === 'string' &&
    secretKey.test(value.name.replace(/[^a-z0-9]/gi, ''));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      secretKey.test(key.replace(/[^a-z0-9]/gi, '')) || (namedSecret && key === 'value')
        ? hidden
        : withoutSecretKeys(entry),
    ]),
  );
}
