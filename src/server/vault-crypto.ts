import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function sealVaultValue(key: Buffer, binding: readonly string[], value: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(binding)));
  const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64');
}

export function openVaultValue(key: Buffer, binding: readonly string[], ciphertext: string) {
  const bytes = Buffer.from(ciphertext, 'base64');
  if (bytes.length < 28) throw new Error('Invalid encrypted value.');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12), {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(JSON.stringify(binding)));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}
