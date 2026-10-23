import { parse } from 'tldts';
import { createRedactor, redactSecretText } from './redaction.ts';
import { createPersonalDataRedactor, personalKey, type PersonalProfile } from './personal-data.ts';

const maxString = 32_000;
const maxScanned = 96_000;
const hidden = '[redacted]';
const errorStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;
const stackFormatter = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
const privateKeys =
  /^(?:name|username|user|userid|owner|ownerid|account|accountid|contact|contactid|customer|customerid|recipient|sender|handle|login|hostname|computername|deviceid|installationid|externalid|id)$|(?:userid|accountid|contactid|customerid|ownerid|messageid|threadid|conversationid|externalid)$/i;
const locations =
  /^(?:url|uri|href|host|hostname|domain|endpoint|origin|website|path|filepath|filename|directory|cwd|homedir)$/i;
const privateNames =
  /password|passwd|passphrase|secret|credential|authorization|cookie|apikey|accesskey|privatekey|signingkey|verificationcode|cardnumber|token(?:value)?$|^(?:pwd|otp|otpcode|totp|cvv|cvc|pan)$/i;

function normalize(key: string) {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function plainErrorFields(value: object) {
  const formatter = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  if (formatter?.get || formatter?.value !== stackFormatter?.value) return false;
  return ['name', 'message'].every((key) => {
    let current: object | null = value;
    for (let depth = 0; current && depth < 10; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'string';
      current = Object.getPrototypeOf(current);
    }
    return current === null;
  });
}

export function createFeedbackRedactor(options: { secrets: string[]; profile: PersonalProfile }) {
  const profileReady =
    Array.isArray(options.profile?.names) &&
    options.profile.names.length <= 100 &&
    options.profile.names.every((name) => typeof name === 'string' && name.length <= 500);
  const personal = createPersonalDataRedactor(profileReady ? options.profile : { names: [] });
  const redact = createRedactor([], { string: 64_000, payload: 160_000, minimumSecretLength: 1 });
  let previousSecrets: string[] = [];
  let secretPattern: RegExp | null = null;
  let ready = profileReady;

  function updateSecrets() {
    if (
      options.secrets.length === previousSecrets.length &&
      options.secrets.every((secret, index) => secret === previousSecrets[index]) &&
      ready === profileReady
    )
      return;
    if (
      options.secrets.length > 256 ||
      options.secrets.some((secret) => typeof secret !== 'string' || secret.length > maxString) ||
      options.secrets.reduce((sum, secret) => sum + secret.length, 0) > maxScanned
    ) {
      ready = false;
      return;
    }
    previousSecrets = [...options.secrets];
    ready = profileReady;
    const variants = [
      ...new Set(
        options.secrets
          .flatMap((secret) => [secret, secret.trim()])
          .filter(Boolean)
          .flatMap((secret) => {
            const variants = [secret, personal(secret), JSON.stringify(secret).slice(1, -1)];
            try {
              variants.push(encodeURIComponent(secret));
            } catch {}
            return variants;
          }),
      ),
    ].sort((a, b) => b.length - a.length);
    secretPattern = variants.length
      ? new RegExp(
          variants.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
          'g',
        )
      : null;
  }

  function text(value: string, stack = false) {
    const decoded = value.replace(/[^\s<>"']*%[0-9a-f]{2}[^\s<>"']*/gi, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    });
    let safe = personal(decoded);
    safe = redactSecretText(secretPattern ? safe.replace(secretPattern, hidden) : safe);
    if (stack)
      safe = safe
        .replace(/\((?:file:\/\/\/|[A-Za-z]:\\|\/)[^\r\n]+(:\d+:\d+\))/g, '([path]$1')
        .replace(
          /^(\s*at (?:async )?)(?:file:\/\/\/|[A-Za-z]:\\|\/)[^\r\n]+(:\d+:\d+)$/gm,
          '$1[path]$2',
        );
    const location = (value: string, marker: string) =>
      marker + (stack ? (value.match(/:\d+:\d+[),;]*$/)?.[0] ?? '') : '');
    return safe
      .replace(/\bdata:[^\s"'<>]+/gi, '[binary omitted]')
      .replace(/(["'])(?:https?|wss?|ftp|file):\/\/[^\r\n]*?\1/gi, '[url]')
      .replace(/\b(?:https?|wss?|ftp|file):\/\/[^\r\n]+/gi, (value) => location(value, '[url]'))
      .replace(/\b(?:https?|wss?|ftp|file)%3a(?:%2f){2}[^\r\n]+/gi, (value) =>
        location(value, '[url]'),
      )
      .replace(/(["'])(?:[A-Za-z]:[\\/]|~?\/)[^\r\n]*?\1/g, '[path]')
      .replace(
        /(?:[A-Za-z]:[\\/]|(?:~\/|\/(?:Users|home)\/[^/\r\n]+\/|\/(?:root|private|var|tmp|Volumes|mnt|workspace|app|data)\/))[^\r\n]*/g,
        (value) => location(value, '[path]'),
      )
      .replace(
        /\/(?:api|users|accounts|profiles|contacts|members|files|documents|attachments|vault|credentials|approvals|oauth)(?:\/|\?)[^\s<>"']+/gi,
        (value) => location(value, '[path]'),
      )
      .replace(/(?<![\p{L}\p{N}._%+-])@[\p{L}\p{N}][\p{L}\p{N}_.-]{1,80}/gu, '[handle]')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[identifier]')
      .replace(/\b(?:\d{6,}|(?:rec|cus|msg|acct|usr)[_-][A-Za-z0-9_-]{6,})\b/g, '[identifier]')
      .replace(/\b[A-Za-z0-9+/=_-]{128,}\b/g, '[encoded data omitted]')
      .replace(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi, (host) => {
        const domain = parse(host, { allowPrivateDomains: true });
        return domain.isIcann ||
          domain.isPrivate ||
          /\.(?:internal|local|localhost|test|invalid)$/i.test(host)
          ? '[host]'
          : host;
      });
  }

  function value(input: unknown): unknown {
    updateSecrets();
    if (!ready) return '[redaction unavailable]';
    let nodes = 0;
    let scanned = 0;
    let fragments = 0;
    const seen = new WeakSet<object>();

    function string(input: string, depth: number, stackTrace: boolean): unknown {
      if (input.length > maxString || (scanned += input.length) > maxScanned)
        return '[oversized text omitted]';
      input = personal(input);
      if (secretPattern) input = input.replace(secretPattern, hidden);
      const trimmed = input.trim();
      if (/^[{[\"]/.test(trimmed)) {
        try {
          return visit(JSON.parse(trimmed), depth + 1);
        } catch {}
      }
      const openings = /\{(?=\s*["}])|\[(?=\s*(?:[\[\]{"\d-]|true\b|false\b|null\b))/g;
      let output = '';
      let offset = 0;
      for (let match = openings.exec(input); match; match = openings.exec(input)) {
        output += text(input.slice(offset, match.index), stackTrace);
        if (++fragments > 32) return output + '[structured data omitted]';
        const stack: string[] = [];
        let quoted = false;
        let escaped = false;
        let complete = false;
        let end = match.index;
        for (; end < input.length; end++) {
          const char = input[end];
          if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
          } else if (char === '"') quoted = true;
          else if (char === '{' || char === '[') stack.push(char === '{' ? '}' : ']');
          else if (char === '}' || char === ']') {
            if (stack.pop() !== char) break;
            if (!stack.length) {
              complete = true;
              end++;
              break;
            }
          }
        }
        if (!complete) return output + '[incomplete structured data omitted]';
        try {
          output += JSON.stringify(visit(JSON.parse(input.slice(match.index, end)), depth + 1));
        } catch {
          output += '[invalid structured data omitted]';
        }
        offset = end;
        openings.lastIndex = end;
      }
      return output + text(input.slice(offset), stackTrace);
    }

    function visit(input: unknown, depth: number, stack = false): unknown {
      if (++nodes > 1200 || depth > 10) return '[truncated]';
      if (typeof input === 'string') return string(input, depth, stack);
      if (input === null || typeof input === 'boolean') return input;
      if (typeof input === 'number')
        return Number.isFinite(input) ? (Math.abs(input) >= 1e12 ? '[identifier]' : input) : null;
      if (!input || typeof input !== 'object') return '[omitted]';
      if (seen.has(input)) return '[circular]';
      seen.add(input);
      if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer) return '[binary omitted]';
      if (input instanceof Date) return '[date]';
      if (Array.isArray(input)) {
        const result: unknown[] = [];
        const length = Object.getOwnPropertyDescriptor(input, 'length')?.value;
        for (
          let index = 0;
          index < Math.min(typeof length === 'number' ? length : 0, 100);
          index++
        ) {
          const property = Object.getOwnPropertyDescriptor(input, String(index));
          result.push(
            property && 'value' in property ? visit(property.value, depth + 1) : '[omitted]',
          );
        }
        if (length > 100) result.push('[truncated]');
        return result;
      }
      const result: Record<string, unknown> = Object.create(null);
      const error = input instanceof Error;
      const binary = ['type', 'mimeType', 'mime_type'].some((key) => {
        const property = Object.getOwnPropertyDescriptor(input, key);
        return (
          property &&
          'value' in property &&
          typeof property.value === 'string' &&
          property.value.length < 100 &&
          /^(?:(?:input_|output_)?(?:image|audio|video|base64)$|(?:image|audio|video)\/|application\/(?:octet-stream|pdf))/i.test(
            property.value,
          )
        );
      });
      const named = Object.getOwnPropertyDescriptor(input, 'name');
      const privateValue =
        named &&
        'value' in named &&
        typeof named.value === 'string' &&
        (named.value.length > 200 ||
          privateNames.test(normalize(named.value)) ||
          personalKey(named.value) ||
          privateKeys.test(normalize(named.value)));
      let count = 0;
      const keys = error
        ? ['name', 'message', 'stack', 'code', 'status', 'statusCode', 'cause']
        : (function* () {
            for (const key in input) {
              yield key;
            }
          })();
      for (const key of keys) {
        if (++count > 100) {
          result.truncated = true;
          break;
        }
        const property = Object.getOwnPropertyDescriptor(input, key);
        if (!property) continue;
        if (key.length > 200) {
          result['[oversized key omitted]'] = '[omitted]';
          continue;
        }
        const safeKey = text(key);
        const normalized = normalize(key);
        const nativeStack =
          error &&
          key === 'stack' &&
          errorStackGetter &&
          property.get === errorStackGetter &&
          plainErrorFields(input);
        result[safeKey] =
          ['image_url', 'audio_url', 'base64'].includes(key) ||
          (binary && ['data', 'bytes', 'buffer'].includes(key))
            ? '[binary omitted]'
            : nativeStack
              ? visit(errorStackGetter.call(input), depth + 1, true)
              : !('value' in property)
                ? '[omitted]'
                : privateNames.test(normalized) || (privateValue && key === 'value')
                  ? hidden
                  : personalKey(key) || (!error && privateKeys.test(normalized))
                    ? '[personal]'
                    : locations.test(normalized)
                      ? '[location]'
                      : visit(property.value, depth + 1, normalized === 'stack');
      }
      if (error && !Object.hasOwn(result, 'name')) result.name = 'Error';
      return result;
    }

    try {
      const safe = redact(visit(input, 0));
      const encoded = JSON.stringify(safe);
      return Buffer.byteLength(encoded) <= 64_000
        ? safe
        : { preview: encoded.slice(0, 12_000), truncated: true };
    } catch {
      return '[unreadable data omitted]';
    }
  }

  return {
    isReady() {
      updateSecrets();
      return ready;
    },
    text(input: string) {
      const safe = value(input);
      return typeof safe === 'string' ? safe : JSON.stringify(safe);
    },
    value,
  };
}
