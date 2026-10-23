export type AuthenticatorAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface AuthenticatorParameters {
  secret: Uint8Array;
  algorithm: AuthenticatorAlgorithm;
  digits: number;
  period: number;
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(value: string) {
  const secret = value.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (
    secret.length < 16 ||
    secret.length > 256 ||
    ![0, 2, 4, 5, 7].includes(secret.length % 8) ||
    !/^[A-Z2-7]+$/.test(secret)
  )
    return undefined;
  return secret;
}

function decode(secret: string) {
  const bytes: number[] = [];
  let bits = 0;
  let buffer = 0;
  for (const char of secret) {
    buffer = (buffer << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function canonical(secret: string, algorithm: string, digits: number, period: number) {
  return `otpauth://totp/?secret=${secret}&algorithm=${algorithm}&digits=${digits}&period=${period}`;
}

export function authenticatorKey(value: string) {
  const text = value.trim();
  if (!/^otpauth:\/\//i.test(text)) {
    const secret = base32(text);
    return secret ? canonical(secret, 'SHA1', 6, 30) : undefined;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.hostname.toLowerCase() !== 'totp') return undefined;
  const secret = base32(url.searchParams.get('secret') ?? '');
  const algorithm = (url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase();
  const digits = Number(url.searchParams.get('digits') ?? 6);
  const period = Number(url.searchParams.get('period') ?? 30);
  if (
    !secret ||
    !['SHA1', 'SHA256', 'SHA512'].includes(algorithm) ||
    ![6, 7, 8].includes(digits) ||
    !Number.isInteger(period) ||
    period < 1 ||
    period > 300
  )
    return undefined;
  return canonical(secret, algorithm, digits, period);
}

export function authenticatorParameters(key: string): AuthenticatorParameters {
  const normalized = authenticatorKey(key);
  if (!normalized) throw new Error('The authenticator key is invalid.');
  const url = new URL(normalized);
  return {
    secret: decode(url.searchParams.get('secret')!),
    algorithm: url.searchParams.get('algorithm') as AuthenticatorAlgorithm,
    digits: Number(url.searchParams.get('digits')),
    period: Number(url.searchParams.get('period')),
  };
}
