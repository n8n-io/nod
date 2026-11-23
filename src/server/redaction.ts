import {
  addRedactionSpan,
  redactionMatches,
  renderRedactionSpans,
  type RedactionSpan,
} from './redaction-spans.ts';
export { environmentSecrets } from '../shared/environment-secrets.mjs';

const payloadDefault = 16_384;
const hidden = '[redacted]';
const secretNames =
  'password|passwd|pwd|passphrase|secret|clientsecret|authorization|proxyauthorization|cookie|setcookie|apikey|xapikey|xauthtoken|xcsrftoken|csrftoken|sessiontoken|accesskey|privatekey|signingkey|masterkey|vaultkey|token|accesstoken|refreshtoken|idtoken|bottoken|credential|credentials|otp|otpcode|verificationcode|totp|totpsecret|cvv|cvc|pan|cardnumber';
const secretKey = new RegExp(`^(?:${secretNames})$`, 'i');
const secretSuffix = new RegExp(
  `(?:${secretNames
    .split('|')
    .map((name) => `${name.length < 5 ? '(?:^|_)' : ''}${name.split('').join('_*')}`)
    .join('|')})$`,
  'i',
);
const fieldCharacters = String.raw`[\p{L}\p{N}_.$-]`;
const fieldIdentifier = new RegExp(`^${fieldCharacters}+$`, 'u');
const assignmentPrefix = new RegExp(
  String.raw`((["']?)(?<!${fieldCharacters})(${fieldCharacters}+)\2\s*[:=]\s*)`,
  'gu',
);
const assignmentValue = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s,;}&]+/y;

const privateKeyStart = '-----BEGIN [^-]*PRIVATE KEY-----';
const bearerToken = /\bBearer\s+[A-Za-z0-9+/_.=:~-]+/gi;
const basicToken = /\bBasic\s+([A-Za-z0-9+/_.=:-]+)/gi;
const privateHeader =
  /\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:\s*[^\r\n]+/gi;
const privateRoute = /((?:https?:\/\/[^\s/"'<>]+)?\/(?:vault|credentials|approvals)\/)[^\s"'<>]+/gi;
const privateQuery =
  /([?&#](?:access_token|refresh_token|id_token|token|code|state|key|api_key|secret|password|signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)=)[^\s&"'<>]*/gi;
const privateUserInfo = /(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi;
const base64Data = /\bdata:[^,\s]+;base64,[A-Za-z0-9+/=]+/g;

const tokenShapes = String.raw`\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b|${privateKeyStart}`;
export const secretToken = new RegExp(tokenShapes);

export function secretField(key: string) {
  if (secretKey.test(key.replace(/[^a-z0-9]/gi, ''))) return true;
  return (
    fieldIdentifier.test(key) &&
    secretSuffix.test(
      key
        .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1_$2')
        .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1_$2')
        .replace(/[^a-z0-9]/gi, '_'),
    )
  );
}

function secretAssignmentSpans(input: string) {
  const spans: RedactionSpan[] = [];
  const prefix = new RegExp(assignmentPrefix);
  const value = new RegExp(assignmentValue);
  for (let match = prefix.exec(input); match; match = prefix.exec(input)) {
    if (!secretField(match[3])) continue;
    value.lastIndex = prefix.lastIndex;
    const found = value.exec(input);
    if (!found) continue;
    addRedactionSpan(spans, found.index, value.lastIndex, hidden);
    prefix.lastIndex = value.lastIndex;
  }
  return spans;
}

function validBasic(token: string) {
  const decoded = Buffer.from(token, 'base64');
  const encoded = decoded.toString('base64');
  return decoded.includes(58) && (token === encoded || token === encoded.replace(/=+$/u, ''));
}

export function secretTextSpans(input: string) {
  const spans: RedactionSpan[] = [];
  const whole = (pattern: RegExp, replacement = hidden) =>
    redactionMatches(
      input,
      pattern,
      (match) => addRedactionSpan(spans, match.index, match.index + match[0].length, replacement),
      true,
    );
  const suffix = (pattern: RegExp, trailing = 0) =>
    redactionMatches(
      input,
      pattern,
      (match) =>
        addRedactionSpan(
          spans,
          match.index + match[1].length,
          match.index + match[0].length - trailing,
          hidden,
        ),
      true,
    );
  let keyEnd = 0;
  redactionMatches(input, new RegExp(privateKeyStart, 'g'), (match) => {
    if (match.index < keyEnd) return;
    const bodyStart = match.index + match[0].length;
    const endMarker = match[0].replace('-----BEGIN ', '-----END ');
    const end = input.indexOf(endMarker, bodyStart);
    const nested = input.indexOf('-----BEGIN ', bodyStart);
    keyEnd = end >= 0 && (nested < 0 || nested > end) ? end + endMarker.length : input.length;
    addRedactionSpan(spans, match.index, keyEnd, hidden);
  });
  whole(bearerToken);
  redactionMatches(
    input,
    basicToken,
    (match) => {
      if (validBasic(match[1]))
        addRedactionSpan(spans, match.index, match.index + match[0].length, hidden);
    },
    true,
  );
  whole(privateHeader);
  whole(new RegExp(tokenShapes, 'g'));
  suffix(privateRoute);
  suffix(privateQuery);
  suffix(privateUserInfo, 1);
  for (const span of secretAssignmentSpans(input))
    addRedactionSpan(spans, span.start, span.end, span.replacement);
  whole(base64Data, '[binary omitted]');
  return spans;
}

export function redactSecretText(value: string): string {
  return renderRedactionSpans(value, secretTextSpans(value));
}

function secretText(secrets: string[], minimumSecretLength = 8) {
  const values = [
    ...new Set(
      secrets
        .flatMap((value) => (typeof value === 'string' ? [value, value.trim()] : []))
        .filter((value) => value.length >= minimumSecretLength),
    ),
  ].sort((a, b) => b.length - a.length);
  const secretVariants = [...new Set(values.flatMap((value) => [value, encodeURIComponent(value)]))]
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&'));
  const secretPattern = secretVariants.length ? new RegExp(secretVariants.join('|'), 'g') : null;
  return (value: string): string => {
    const spans = secretTextSpans(value);
    if (secretPattern)
      redactionMatches(
        value,
        secretPattern,
        (match) => addRedactionSpan(spans, match.index, match.index + match[0].length, hidden),
        true,
      );
    return renderRedactionSpans(value, spans);
  };
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
        if (item.length > 1 && typeof item[0] === 'string' && secretField(item[0]))
          return [text(item[0]), hidden];
        const result = item.slice(0, 100).map((entry) => visit(entry, depth + 1));
        if (item.length > 100) result.push('[truncated]');
        return result;
      }
      const result: Record<string, unknown> = Object.create(null);
      const namedSecret = 'name' in item && typeof item.name === 'string' && secretField(item.name);
      for (const [key, entry] of Object.entries(item).slice(0, 100)) {
        result[text(key)] =
          secretField(key) || (namedSecret && key === 'value')
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

export function createCommandRedactor(secrets: string[]) {
  const text = createTextRedactor(secrets);
  const structured = createErrorRedactor(secrets);
  return (value: string) => structured(text(value).slice(-64_000));
}

export function withoutSecretKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length > 1 && typeof value[0] === 'string' && secretField(value[0]))
      return [value[0], hidden];
    return value.map(withoutSecretKeys);
  }
  if (!value || typeof value !== 'object') return value;
  const namedSecret = 'name' in value && typeof value.name === 'string' && secretField(value.name);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      secretField(key) || (namedSecret && key === 'value') ? hidden : withoutSecretKeys(entry),
    ]),
  );
}
