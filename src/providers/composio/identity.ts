import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CredentialKeyStore } from '../../ports/key-store.ts';
import type { IntegrationIdentityCheckpoint } from '../../ports/integration-identity.ts';

async function readProtected(path: string) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const metadata = await file.stat();
    const current = await lstat(path);
    if (
      !metadata.isFile() ||
      !current.isFile() ||
      metadata.dev !== current.dev ||
      metadata.ino !== current.ino ||
      metadata.size > 8192 ||
      (process.getuid && metadata.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)
    )
      throw new Error('The integration identity file permissions are unsafe.');
    return await file.readFile();
  } finally {
    await file.close();
  }
}

async function publish(path: string, value: Buffer) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    await link(temporary, path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
  } finally {
    await rm(temporary, { force: true });
  }
}

async function persist(directory: string, dataRoot: string) {
  if (process.platform === 'win32') return;
  for (let path = directory; ; path = dirname(path)) {
    if (path !== directory && path !== dataRoot) {
      try {
        await access(path, constants.W_OK);
      } catch (error) {
        if (['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? ''))
          break;
        throw error;
      }
    }
    const parent = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    if (dirname(path) === path) break;
  }
}

export async function loadIntegrationIdentity(options: {
  dataRoot: string;
  ownerId: string;
  keyStore: CredentialKeyStore;
  checkpoint: IntegrationIdentityCheckpoint;
}) {
  const expected = await options.checkpoint.read();
  const name = createHash('sha256').update(options.ownerId).digest('hex');
  if (expected !== undefined) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(expected))
      throw new Error('Nod’s saved app identity is invalid. Restore its app data to reconnect.');
    for (const extension of ['encrypted', 'public'])
      if (
        !(await readProtected(
          join(options.dataRoot, 'integration-identity', `${name}.${extension}`),
        ))
      )
        throw new Error('Nod’s saved app identity is missing. Restore its app data to reconnect.');
  }
  if (!options.keyStore.configured)
    throw new Error('Unlock or configure Nod’s key store before connecting apps.');
  const encryptionKey = Buffer.from(await options.keyStore.getKey());
  try {
    if (encryptionKey.length !== 32) throw new Error('Nod’s key store returned an invalid key.');
    await mkdir(options.dataRoot, { recursive: true, mode: 0o700 });
    const dataRoot = await realpath(options.dataRoot);
    const directory = join(dataRoot, 'integration-identity');
    for (const [path, mask] of [
      [dataRoot, 0o022],
      [directory, 0o077],
    ] as const) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const metadata = await lstat(path);
      if (
        !metadata.isDirectory() ||
        (process.getuid && metadata.uid !== process.getuid()) ||
        (process.platform !== 'win32' && (metadata.mode & mask) !== 0)
      )
        throw new Error('The integration identity directory permissions are unsafe.');
    }
    const path = join(directory, `${name}.encrypted`);
    const markerPath = join(directory, `${name}.public`);
    const marker = await readProtected(markerPath);
    let encrypted = await readProtected(path);
    const binding = Buffer.from(JSON.stringify(['nod-integration-identity-v1', options.ownerId]));
    if (!encrypted) {
      if (marker)
        throw new Error('Nod’s saved app identity is missing. Restore its app data to reconnect.');
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
      cipher.setAAD(binding);
      const generated = generateKeyPairSync('ed25519').privateKey.export({
        type: 'pkcs8',
        format: 'der',
      });
      const ciphertext = Buffer.concat([cipher.update(generated), cipher.final()]);
      generated.fill(0);
      await publish(path, Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]));
      encrypted = await readProtected(path);
    }
    let key;
    try {
      if (!encrypted || encrypted.length < 28) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, encrypted.subarray(0, 12), {
        authTagLength: 16,
      });
      decipher.setAAD(binding);
      decipher.setAuthTag(encrypted.subarray(12, 28));
      const plaintext = Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]);
      try {
        key = createPrivateKey({ key: plaintext, type: 'pkcs8', format: 'der' });
      } finally {
        plaintext.fill(0);
      }
      if (key.asymmetricKeyType !== 'ed25519') throw new Error();
    } catch {
      throw new Error(
        'Nod could not unlock its saved app identity. Restore its key store or app data.',
      );
    }
    const publicKey = createPublicKey(key).export({ format: 'jwk' }).x;
    if (!publicKey || Buffer.from(publicKey, 'base64url').length !== 32)
      throw new Error('The integration identity is invalid.');
    if (expected !== undefined && expected !== publicKey)
      throw new Error('Nod’s saved app identity changed. Restore its app data to reconnect.');
    if (!marker) await publish(markerPath, Buffer.from(publicKey));
    if ((await readProtected(markerPath))?.toString() !== publicKey)
      throw new Error('Nod’s saved app identity changed. Restore its app data to reconnect.');
    await persist(directory, dataRoot);
    await options.checkpoint.commit(publicKey);
    return {
      key,
      publicKey,
      userId: `nod_${createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex')}`,
    };
  } finally {
    encryptionKey.fill(0);
  }
}
