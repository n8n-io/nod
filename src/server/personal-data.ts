import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { findPhoneNumbersInText, type CountryCode } from 'libphonenumber-js/max';

export interface PersonalProfile {
  names: string[];
  region?: string;
}

const ibanLengths = Object.fromEntries(
  'AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BI27 BR29 BY28 CH21 CR22 CY28 CZ24 DE22 DJ27 DK18 DO28 EE20 EG29 ES24 FI18 FK18 FO18 FR27 GB22 GE22 GI23 GL18 GR27 GT28 HN28 HR21 HU28 IE22 IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 LB28 LC32 LI21 LT20 LU20 LV21 LY25 MC27 MD24 ME22 MK19 MN20 MR27 MT31 MU30 NI28 NL18 NO15 OM23 PK24 PL28 PS29 PT25 QA29 RO24 RS22 RU33 SA24 SC31 SD18 SE24 SI19 SK24 SM27 SO23 ST25 SV28 TL23 TN24 TR26 UA29 VA22 VG24 XK20 YE30'
    .split(' ')
    .map((entry) => [entry.slice(0, 2), Number(entry.slice(2))]),
);

const personalKeys = new Set(
  'firstname lastname fullname displayname givenname familyname middlename surname nickname birthday birthdate dateofbirth dob address homeaddress streetaddress formattedaddress street addressline1 addressline2 postalcode postcode zipcode zip phone phonenumber phonenumbers mobile mobilephone telephone tel fax email emailaddress ssn taxid nationalid passport passportnumber iban'.split(
    ' ',
  ),
);

function luhn(digits: string) {
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

function cardIssuer(digits: string) {
  const two = Number(digits.slice(0, 2));
  const four = Number(digits.slice(0, 4));
  const three = Number(digits.slice(0, 3));
  return (
    digits[0] === '4' ||
    (two >= 51 && two <= 55) ||
    (four >= 2221 && four <= 2720) ||
    two === 34 ||
    two === 37 ||
    (three >= 300 && three <= 305) ||
    two === 36 ||
    two === 38 ||
    four === 6011 ||
    two === 65 ||
    (three >= 644 && three <= 649) ||
    (four >= 3528 && four <= 3589) ||
    two === 62 ||
    two === 50 ||
    (two >= 56 && two <= 69)
  );
}

function card(candidate: string) {
  const digits = candidate.replace(/\D/g, '');
  return digits.length >= 13 && digits.length <= 19 && cardIssuer(digits) && luhn(digits);
}

function mod97(value: string) {
  let remainder = 0;
  for (const char of value) {
    const code = char >= 'A' && char <= 'Z' ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of code) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder;
}

function iban(candidate: string) {
  const compact = candidate.replace(/[ -]/g, '').toUpperCase();
  return (
    ibanLengths[compact.slice(0, 2)] === compact.length &&
    mod97(compact.slice(4) + compact.slice(0, 4)) === 1
  );
}

function spanishId(candidate: string) {
  const compact = candidate.replace(/-/g, '').toUpperCase();
  const number = compact.replace(/^[XYZ]/, (prefix) => String('XYZ'.indexOf(prefix)));
  return 'TRWAGMYFPDXBNJZSQVHLCKE'[Number(number.slice(0, -1)) % 23] === number.slice(-1);
}

function cpf(candidate: string) {
  const digits = candidate.replace(/\D/g, '');
  if (/^(\d)\1{10}$/.test(digits)) return false;
  const check = (length: number) => {
    let sum = 0;
    for (let index = 0; index < length; index++)
      sum += Number(digits[index]) * (length + 1 - index);
    return ((sum * 10) % 11) % 10 === Number(digits[length]);
  };
  return check(9) && check(10);
}

const verhoeffMultiply = [
  '0123456789',
  '1234067895',
  '2340178956',
  '3401289567',
  '4012395678',
  '5987604321',
  '6598710432',
  '7659821043',
  '8765932104',
  '9876543210',
];
const verhoeffPermute = [
  '0123456789',
  '1576283094',
  '5803796142',
  '8916043527',
  '9453126870',
  '4286573901',
  '2793806415',
  '7046913258',
];

function aadhaar(candidate: string) {
  const digits = candidate.replace(/\D/g, '');
  let check = 0;
  for (let index = 0; index < digits.length; index++)
    check = Number(
      verhoeffMultiply[check][
        Number(verhoeffPermute[index % 8][Number(digits[digits.length - 1 - index])])
      ],
    );
  return check === 0;
}

const base58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function bitcoinLegacy(candidate: string) {
  let value = 0n;
  for (const char of candidate) value = value * 58n + BigInt(base58.indexOf(char));
  const hex = value.toString(16).padStart(50, '0');
  if (hex.length !== 50) return false;
  const bytes = Buffer.from(hex, 'hex');
  const digest = createHash('sha256')
    .update(createHash('sha256').update(bytes.subarray(0, 21)).digest())
    .digest();
  return digest.subarray(0, 4).equals(bytes.subarray(21));
}

const bech32Charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bitcoinSegwit(candidate: string) {
  const address = candidate.toLowerCase();
  const separator = address.lastIndexOf('1');
  const values = [...address.slice(separator + 1)].map((char) => bech32Charset.indexOf(char));
  if (values.some((value) => value < 0)) return false;
  const prefix = address.slice(0, separator);
  const expanded = [
    ...[...prefix].map((char) => char.charCodeAt(0) >> 5),
    0,
    ...[...prefix].map((char) => char.charCodeAt(0) & 31),
    ...values,
  ];
  const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of expanded) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit++) if ((top >>> bit) & 1) checksum ^= generator[bit];
  }
  return checksum === 1 || checksum === 0x2bc830a3;
}

function ipAddress(candidate: string) {
  const version = isIP(candidate);
  if (version === 4) return !/^(?:127\.|0\.0\.0\.0$)/.test(candidate);
  return version === 6 && !['::', '::1'].includes(candidate);
}

const word = String.raw`[\p{L}\p{M}\p{N}]`;
const emailPattern = String.raw`[\p{L}\p{N}._%+-]{1,64}@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}{2,24}`;

const detectors: [RegExp, string, ((match: string) => boolean)?][] = [
  [
    new RegExp(
      String.raw`(?:"[^"\n]{1,100}"|\p{L}[\p{L}\p{M}'’.-]{0,40}(?:[ \t]+[\p{L}\p{M}'’.-]{1,40}){0,4})[ \t]*<[ \t]*${emailPattern}[ \t]*>`,
      'gu',
    ),
    '[name] <[email]>',
  ],
  [new RegExp(String.raw`(?<![\p{L}\p{N}._%+-])${emailPattern}(?!${word}|-)`, 'gu'), '[email]'],
  [/\b(?:bc1|tb1)[a-z0-9]{11,71}\b/gi, '[wallet]', bitcoinSegwit],
  [/\b[13][1-9A-HJ-NP-Za-km-z]{25,34}\b/g, '[wallet]', bitcoinLegacy],
  [/\b0x[0-9a-fA-F]{40}\b/g, '[wallet]'],
  [/\b[A-Za-z]{2}\d{2}(?:[ -]?[A-Za-z0-9]){11,30}\b/g, '[iban]', iban],
  [/(?<![\p{N}\p{L}.-])\d(?:[ -]?\d){12,18}(?![\p{N}\p{L}-])/gu, '[card]', card],
  [/\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/g, '[id number]'],
  [/\b(?:\d{8}-?[A-Za-z]|[XYZxyz]-?\d{7}-?[A-Za-z])\b/g, '[id number]', spanishId],
  [/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, '[id number]', cpf],
  [
    /\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g,
    '[id number]',
  ],
  [/\b[2-9]\d{3}[ -]\d{4}[ -]\d{4}\b/g, '[id number]', aadhaar],
  [/\b[0-9A-Fa-f]{2}([:-])[0-9A-Fa-f]{2}(?:\1[0-9A-Fa-f]{2}){4}\b/g, '[mac]'],
  [/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?!\d|\.[A-Za-z0-9])/g, '[ip]', ipAddress],
  [/(?<![\w:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])/g, '[ip]', ipAddress],
];

export function personalKey(key: string) {
  return personalKeys.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase());
}

export function withoutPersonalFields(value: unknown, text: (value: string) => string): unknown {
  const visit = (item: unknown, key?: string): unknown =>
    key !== undefined && personalKey(key) && item !== null && item !== ''
      ? '[personal]'
      : typeof item === 'string'
        ? text(item)
        : Array.isArray(item)
          ? item.map((entry) => visit(entry))
          : item && typeof item === 'object'
            ? Object.fromEntries(
                Object.entries(item).map(([name, entry]) => [text(name), visit(entry, name)]),
              )
            : item;
  return visit(value);
}

function valueEnd(text: string, start: number) {
  const first = text[start];
  if (first === '"') {
    for (let index = start + 1; index < text.length; index++) {
      if (text[index] === '\\') index++;
      else if (text[index] === '"') return index + 1;
    }
    return -1;
  }
  if (first === '{' || first === '[') {
    let depth = 0;
    let quoted = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (char === '\\') index++;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{' || char === '[') depth++;
      else if ((char === '}' || char === ']') && --depth === 0) return index + 1;
    }
    return -1;
  }
  const primitive = /^[^,}\]\s]{1,100}/.exec(text.slice(start, start + 100));
  return primitive ? start + primitive[0].length : -1;
}

function personalValues(text: string) {
  const key = /"((?:[^"\\]|\\.){1,60})"\s*:\s*/g;
  let result = '';
  let offset = 0;
  for (let match = key.exec(text); match; match = key.exec(text)) {
    if (!personalKey(match[1])) continue;
    const start = match.index + match[0].length;
    const end = valueEnd(text, start);
    if (end < 0 || ['null', '""', '[]', '{}'].includes(text.slice(start, end))) continue;
    result += text.slice(offset, start) + '"[personal]"';
    offset = end;
    key.lastIndex = end;
  }
  return result + text.slice(offset);
}

function phones(text: string, region?: string) {
  let result = text;
  const found = findPhoneNumbersInText(text, {
    ...(region ? { defaultCountry: region as CountryCode } : {}),
  });
  for (const match of found.reverse())
    result = result.slice(0, match.startsAt) + '[phone]' + result.slice(match.endsAt);
  return result;
}

function ownerNames(names: string[]) {
  const variants = [
    ...new Set(
      names.flatMap((name) => {
        const clean = name.trim().replace(/\s+/g, ' ');
        return [clean, ...clean.split(' ')].filter((part) => [...part].length >= 3);
      }),
    ),
  ]
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&').replace(/ /g, '\\s+'));
  return variants.length
    ? new RegExp(`(?<!${word})(?:${variants.join('|')})(?!${word})`, 'giu')
    : null;
}

function replaceValid(match: string, replacement: string, valid?: (match: string) => boolean) {
  if (!valid) return replacement;
  for (let end = match.length; end > 0; end--)
    if ((end === match.length || /[ -]/.test(match[end])) && valid(match.slice(0, end)))
      return replacement + match.slice(end);
  return match;
}

export function createPersonalDataRedactor(profile: PersonalProfile) {
  const names = ownerNames(profile.names);
  const region = profile.region && /^[A-Z]{2}$/.test(profile.region) ? profile.region : undefined;
  return (input: string) => {
    let text = personalValues(input);
    for (const [pattern, replacement, valid] of detectors)
      text = text.replace(pattern, (match) => replaceValid(match, replacement, valid));
    text = phones(text, region);
    return names ? text.replace(names, '[owner]') : text;
  };
}
