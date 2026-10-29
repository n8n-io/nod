import { execFile } from 'node:child_process';
import { createDecipheriv, createSecretKey, pbkdf2Sync } from 'node:crypto';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function readPassword(name) {
  try {
    const { stdout } = await run(
      '/usr/bin/security',
      ['find-generic-password', '-s', `${name} Safe Storage`, '-a', `${name} Key`, '-w'],
      {
        encoding: 'buffer',
        timeout: 15_000,
        maxBuffer: 4096,
        env: { PATH: '/usr/bin:/bin', HOME: homedir() },
      },
    );
    return stdout;
  } catch {
    throw new Error('Nod could not read its previous saved key.');
  }
}

export function createMacEncryption(
  encryption,
  { previousName = 'Nod', readPreviousPassword = readPassword } = {},
) {
  let previousKey;
  return {
    isAsyncEncryptionAvailable: () => encryption.isAsyncEncryptionAvailable(),
    encryptStringAsync: (value) => encryption.encryptStringAsync(value),
    decryptStringAsync: (value) => encryption.decryptStringAsync(value),
    async decryptLegacyStringAsync(value) {
      if (
        !Buffer.isBuffer(value) ||
        value.length < 19 ||
        value.subarray(0, 3).toString() !== 'v10' ||
        (value.length - 3) % 16
      )
        throw new Error('The saved key format is unsupported.');
      previousKey ??= readPreviousPassword(previousName)
        .then((password) => {
          try {
            let end = password.length;
            while (end && [10, 13].includes(password[end - 1])) end--;
            if (!end) throw new Error('The previous saved key is empty.');
            const bytes = pbkdf2Sync(password.subarray(0, end), 'saltysalt', 1003, 16, 'sha1');
            try {
              return createSecretKey(bytes);
            } finally {
              bytes.fill(0);
            }
          } finally {
            password.fill(0);
          }
        })
        .catch((error) => {
          previousKey = undefined;
          throw error;
        });
      const decipher = createDecipheriv('aes-128-cbc', await previousKey, Buffer.alloc(16, 32));
      const plaintext = Buffer.concat([decipher.update(value.subarray(3)), decipher.final()]);
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
      } finally {
        plaintext.fill(0);
      }
    },
  };
}
