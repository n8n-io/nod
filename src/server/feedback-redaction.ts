import { parse } from 'tldts';
import { secretField, secretTextSpans } from './redaction.ts';
import {
  addRedactionSpan,
  redactionMatches,
  renderRedactionSpans,
  type RedactionSpan,
} from './redaction-spans.ts';
import {
  createPersonalDataRedactor,
  createPersonalDataSpans,
  personalKey,
  type PersonalProfile,
} from './personal-data.ts';

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
  /password|passwd|passphrase|secret|credential|authorization|cookie|apikey|accesskey|privatekey|signingkey|verificationcode|cardnumber|token(?:value)?$|^(?:pwd|otp|otpcode|totp|cvv|cvc|pan|payload|claims|jwt)$/i;
const claimKeys = /^(?:sub|sid|jti|nonce|aud)$/;
const opening = /\{(?=\s*["}])|\[(?=\s*(?:[\[\]{"\d-]|true\b|false\b|null\b))/g;
const appFile =
  /^(?:src\/(?:server|providers|ports|shared|web|runtime)|dist|desktop\/main|node_modules)\/[\w@.+-]+(?:\/[\w@.+-]+)*$/;
const className = /^[A-Za-z][A-Za-z0-9_$]{0,80}$/;
const hostPattern =
  /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})\b(?:\.(?=[:/?#]))?(?::\d{1,5})?/gi;
const linkTail = /[/?#][^\s<>"']*/y;

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
  const personalSpans = createPersonalDataSpans(profileReady ? options.profile : { names: [] });
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

  function literalSpans(input: string) {
    const spans: RedactionSpan[] = [];
    if (secretPattern)
      redactionMatches(
        input,
        secretPattern,
        (match) => addRedactionSpan(spans, match.index, match.index + match[0].length, hidden),
        true,
      );
    return spans;
  }

  function textSpans(
    input: string,
    stack: boolean,
    budget: { decoded: number; carriers: number },
    decodeDepth = 0,
  ) {
    const spans: RedactionSpan[] = [];
    for (const span of [...personalSpans(input), ...literalSpans(input), ...secretTextSpans(input)])
      addRedactionSpan(spans, span.start, span.end, span.replacement);
    const whole = (pattern: RegExp, replacement: string) =>
      redactionMatches(input, pattern, (match) =>
        addRedactionSpan(spans, match.index, match.index + match[0].length, replacement),
      );
    whole(/\bdata:[^\s"'<>]+/gi, '[binary omitted]');
    whole(/(?<![\p{L}\p{N}._%+-])@[\p{L}\p{N}][\p{L}\p{N}_.-]{1,80}/gu, '[handle]');
    whole(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[identifier]');
    whole(
      /\b(?:\d{6,}(?![ -]?(?:tokens?|bytes?|characters?|chars|ms|[KMG]B|[KM]iB|items|rows)\b)|(?:rec|cus|msg|acct|usr)[_-][A-Za-z0-9_-]{6,})\b/g,
      '[identifier]',
    );
    whole(/\b[A-Za-z0-9+/=_-]{128,}\b/g, '[encoded data omitted]');
    redactionMatches(input, hostPattern, (match) => {
      const domain = parse(match[1], { allowPrivateDomains: true });
      if (
        !domain.isIcann &&
        !domain.isPrivate &&
        !/\.(?:helsinki|internal|local|localhost|test|invalid)$/i.test(match[1])
      )
        return;
      const tailPattern = new RegExp(linkTail);
      tailPattern.lastIndex = match.index + match[0].length;
      const tail = tailPattern.exec(input)?.[0] ?? '';
      addRedactionSpan(
        spans,
        match.index,
        match.index + match[0].length + tail.length,
        tail ? '[url]' : '[host]',
      );
    });
    redactionMatches(input, /[^\s<>"']*%[0-9a-f]{2}[^\s<>"']*/gi, (match) => {
      const encoded = match[0];
      let sensitive = true;
      if (
        ++budget.carriers <= 128 &&
        decodeDepth < 3 &&
        (budget.decoded += Buffer.byteLength(encoded)) <= maxScanned
      ) {
        try {
          const decoded = decodeURIComponent(encoded);
          sensitive =
            (budget.decoded += Buffer.byteLength(decoded)) > maxScanned ||
            /^[{[\"]/.test(decoded.trim()) ||
            new RegExp(opening).test(decoded) ||
            textSpans(decoded, false, budget, decodeDepth + 1).length > 0;
        } catch {}
      }
      if (sensitive)
        addRedactionSpan(
          spans,
          match.index,
          match.index + encoded.length,
          '[encoded data omitted]',
        );
    });
    const privateSpans = [...spans];
    const frames: Array<{ start: number; end: number; replacement: string }> = [];
    if (stack) {
      const frame = (match: RegExpExecArray) => {
        const path = match[2];
        const start = match.index + match[1].length;
        const end = start + path.length;
        const file = path.replace(/\\/g, '/');
        const modules = file.lastIndexOf('/node_modules/');
        const offset =
          modules >= 0
            ? modules
            : Math.max(...['/src/', '/dist/', '/desktop/'].map((part) => file.lastIndexOf(part)));
        const kept = file.slice(offset + 1);
        const allowed =
          offset >= 0 &&
          appFile.test(kept) &&
          !privateSpans.some((span) => span.start < end && span.end > start) &&
          textSpans(kept, false, budget).length === 0;
        frames.push({ start, end, replacement: allowed ? kept : '[path]' });
      };
      redactionMatches(
        input,
        /(\()((?:file:\/\/\/|[A-Za-z]:[\\/]|\/)[^\r\n]+)(:\d+:\d+\))/g,
        frame,
      );
      redactionMatches(
        input,
        /^(\s*at (?:async )?)((?:file:\/\/\/|[A-Za-z]:[\\/]|\/)[^\r\n]+)(:\d+:\d+)$/gm,
        frame,
      );
    }
    const quotedLocations: Array<{ start: number; end: number }> = [];
    const location = (pattern: RegExp, replacement: string, quoted = false) =>
      redactionMatches(
        input,
        pattern,
        (match) => {
          const start = match.index;
          const end = start + match[0].length;
          if (!quoted && quotedLocations.some((span) => start >= span.start && start < span.end))
            return;
          if (quoted) quotedLocations.push({ start, end });
          if (
            frames.some(
              (frame) =>
                frame.replacement !== '[path]' &&
                start >= frame.start &&
                (end <= frame.end || /^:\d+:\d+[),;]*$/.test(input.slice(frame.end, end))),
            )
          )
            return;
          const position = stack ? (match[0].match(/:\d+:\d+[),;]*$/)?.[0] ?? '') : '';
          addRedactionSpan(spans, start, end - position.length, replacement);
        },
        true,
      );
    location(/(["'])(?:https?|wss?|ftp|file):\/\/[^\r\n]*?\1/gi, '[url]', true);
    location(/(["'])(?:[A-Za-z]:[\\/]|~?\/)[^\r\n]*?\1/g, '[path]', true);
    location(/\b(?:https?|wss?|ftp|file):\/\/[^\r\n]+/gi, '[url]');
    location(/\b(?:https?|wss?|ftp|file)%3a(?:%2f){2}[^\r\n]+/gi, '[url]');
    location(
      /(?:[A-Za-z]:[\\/]|(?:~\/|\/(?:Users|home)\/[^/\r\n]+\/|\/(?:root|private|var|tmp|Volumes|mnt|media|run\/media|workspace|app|data)\/))[^\r\n]*/g,
      '[path]',
    );
    location(
      /\/(?:api|users|accounts|profiles|contacts|members|files|documents|attachments|vault|credentials|approvals|oauth)(?:\/|\?)[^\s<>"']+/gi,
      '[path]',
    );
    for (const frame of frames) addRedactionSpan(spans, frame.start, frame.end, frame.replacement);
    return spans;
  }

  function value(input: unknown): unknown {
    updateSecrets();
    if (!ready) return '[redaction unavailable]';
    let nodes = 0;
    let scanned = 0;
    let fragments = 0;
    const budget = { decoded: 0, carriers: 0 };
    const text = (input: string, stack = false) =>
      renderRedactionSpans(input, textSpans(input, stack, budget));
    const seen = new WeakSet<object>();
    const labels = new Map<string, string[] | null>();

    function labelViews(input: string): string[] | null {
      const cached = labels.get(input);
      if (cached !== undefined) return cached;
      if (input.length > maxString) return null;
      const views = [input];
      let current = input;
      let jsonDepth = 0;
      let uriDepth = 0;
      while (true) {
        const trimmed = current.trim();
        if (views.length > 1 && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
          labels.set(input, null);
          return null;
        }
        const json = trimmed.startsWith('"');
        if (!json && !/%[0-9a-f]{2}/i.test(current)) {
          labels.set(input, views);
          return views;
        }
        if (
          (json ? ++jsonDepth > 10 : ++uriDepth > 3) ||
          ++budget.carriers > 128 ||
          (budget.decoded += Buffer.byteLength(current)) > maxScanned
        )
          throw new Error('Metadata decode limit exceeded.');
        let decoded: unknown;
        try {
          decoded = json ? JSON.parse(trimmed) : decodeURIComponent(current);
        } catch {
          labels.set(input, null);
          return null;
        }
        if (typeof decoded !== 'string') {
          labels.set(input, null);
          return null;
        }
        if ((budget.decoded += Buffer.byteLength(decoded)) > maxScanned)
          throw new Error('Metadata decode limit exceeded.');
        views.push(decoded);
        current = decoded;
      }
    }

    function structured(input: string, parsed: unknown, depth: number) {
      const strings: Array<{ start: number; end: number }> = [];
      const escapes: Array<{ start: number; end: number }> = [];
      redactionMatches(input, /"(?:\\.|[^"\\])*"/g, (match) =>
        strings.push({ start: match.index, end: match.index + match[0].length }),
      );
      redactionMatches(input, /\\(?:u[0-9a-f]{4}|["\\/bfnrt])/gi, (match) =>
        escapes.push({ start: match.index, end: match.index + match[0].length }),
      );
      if (
        literalSpans(input).some(
          (span) =>
            !strings.some((token) => span.start > token.start && span.end < token.end) ||
            escapes.some((escape) => span.start < escape.end && span.end > escape.start),
        ) ||
        textSpans(input, false, budget).some(
          (span) => !strings.some((token) => span.start >= token.start && span.end <= token.end),
        )
      )
        return '[structured data omitted]';
      return visit(parsed, depth + 1);
    }

    function string(input: string, depth: number, stackTrace: boolean): unknown {
      if (input.length > maxString || (scanned += input.length) > maxScanned)
        return '[oversized text omitted]';
      const trimmed = input.trim();
      if (/^[{[\"]/.test(trimmed)) {
        try {
          const parsed: unknown = JSON.parse(trimmed);
          return structured(input, parsed, depth);
        } catch {}
      }
      let spans = textSpans(input, stackTrace, budget);
      const openings = new RegExp(opening);
      for (let match = openings.exec(input); match; match = openings.exec(input)) {
        if (++fragments > 32) return '[structured data omitted]';
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
        if (!complete) {
          addRedactionSpan(
            spans,
            match.index,
            input.length,
            '[incomplete structured data omitted]',
          );
          break;
        }
        let replacement = '[invalid structured data omitted]';
        try {
          const fragment = input.slice(match.index, end);
          replacement = JSON.stringify(structured(fragment, JSON.parse(fragment), depth));
        } catch {}
        spans = spans.filter((span) => span.start < match.index || span.end > end);
        addRedactionSpan(spans, match.index, end, replacement);
        openings.lastIndex = end;
      }
      return renderRedactionSpans(input, spans);
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
        const first = Object.getOwnPropertyDescriptor(input, '0');
        const names =
          first && 'value' in first && typeof first.value === 'string'
            ? labelViews(first.value)
            : undefined;
        const privateTuple =
          typeof length === 'number' &&
          length > 1 &&
          first &&
          (!('value' in first) || names === null || names?.some(secretField));
        if (privateTuple)
          return [
            first && 'value' in first && names !== null
              ? visit(first.value, depth + 1)
              : '[omitted]',
            hidden,
          ];
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
        const types =
          property && 'value' in property && typeof property.value === 'string'
            ? labelViews(property.value)
            : undefined;
        return (
          property &&
          (!('value' in property) ||
            types === null ||
            types?.some(
              (type) =>
                type.length < 100 &&
                /^(?:(?:input_|output_)?(?:image|audio|video|base64)$|(?:image|audio|video)\/|application\/(?:octet-stream|pdf))/i.test(
                  type,
                ),
            ))
        );
      });
      const named = Object.getOwnPropertyDescriptor(input, 'name');
      const names =
        named && 'value' in named && typeof named.value === 'string' && named.value.length <= 200
          ? labelViews(named.value)
          : undefined;
      const privateValue =
        named &&
        (!('value' in named) ||
          typeof named.value !== 'string' ||
          named.value.length > 200 ||
          names === null ||
          names?.some(
            (name) =>
              privateNames.test(normalize(name)) ||
              secretField(name) ||
              personalKey(name) ||
              privateKeys.test(normalize(name)),
          ));
      const errorStack = Object.getOwnPropertyDescriptor(input, 'stack')?.value;
      let count = 0;
      const keys = error
        ? ['name', 'message', 'stack', 'code', 'status', 'statusCode', 'cause']
        : (function* () {
            for (const key in input) {
              yield key;
            }
          })();
      for (const key of keys) {
        if (++count > 100) return '[structured data omitted]';
        const property = Object.getOwnPropertyDescriptor(input, key);
        if (!property) continue;
        if (key.length > 200) return '[structured data omitted]';
        if (
          /%[0-9a-f]{2}|\\(?:u[0-9a-f]{4}|["\\/bfnrt])/i.test(key) ||
          key.trimStart().startsWith('"')
        )
          return '[structured data omitted]';
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
                : privateNames.test(normalized) ||
                    secretField(key) ||
                    (privateValue && key === 'value')
                  ? hidden
                  : personalKey(key) ||
                      claimKeys.test(normalized) ||
                      (!error &&
                        privateKeys.test(normalized) &&
                        !(
                          key === 'name' &&
                          typeof property.value === 'string' &&
                          className.test(property.value) &&
                          (/(?:Error|Exception)$/.test(property.value) ||
                            (typeof errorStack === 'string' &&
                              errorStack.startsWith(`${property.value}:`)))
                        ))
                    ? '[personal]'
                    : locations.test(normalized)
                      ? '[location]'
                      : visit(property.value, depth + 1, normalized === 'stack');
      }
      if (error && !Object.hasOwn(result, 'name')) result.name = 'Error';
      return result;
    }

    try {
      const safe = visit(input, 0);
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
