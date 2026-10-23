import { createHmac } from 'node:crypto';
import { authenticatorParameters } from '../shared/authenticator-key.ts';

export function authenticatorCode(key: string, now = Date.now()) {
  const { secret, algorithm, digits, period } = authenticatorParameters(key);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period)));
  const digest = createHmac(algorithm.toLowerCase(), secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
