import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const secretFields = ['composioApiKey'];
const preferenceFields = ['launchAtLogin', 'notifications', 'onboardingCompleted'];

export function createSettingsStore(path, encryption) {
  let current;
  let loading;
  let writing = Promise.resolve();
  async function write(value) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.pending`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
    current = value;
  }
  async function read() {
    if (loading) return loading;
    if (current) return current;
    loading = (async () => {
      let value;
      try {
        value = JSON.parse(await readFile(path, 'utf8'));
        const record = (input) => input && typeof input === 'object' && !Array.isArray(input);
        if (
          !record(value) ||
          value.version !== 1 ||
          Object.keys(value).some(
            (field) =>
              !['version', 'theme', ...preferenceFields, 'secrets', 'keyMetadata'].includes(field),
          ) ||
          !['system', 'light', 'dark'].includes(value.theme) ||
          preferenceFields.some((field) => typeof value[field] !== 'boolean') ||
          !record(value.secrets) ||
          Object.entries(value.secrets).some(
            ([field, secret]) =>
              ![...secretFields, 'vaultKey', 'integrationConfiguration'].includes(field) ||
              typeof secret !== 'string' ||
              !secret,
          ) ||
          !record(value.keyMetadata) ||
          Object.entries(value.keyMetadata).some(
            ([field, metadata]) =>
              !secretFields.includes(field) ||
              !value.secrets[field] ||
              !record(metadata) ||
              Object.keys(metadata).some(
                (name) => !['suffix', 'source', 'updatedAt'].includes(name),
              ) ||
              (metadata.suffix !== null &&
                (typeof metadata.suffix !== 'string' || metadata.suffix.length !== 4)) ||
              !['manual', 'import'].includes(metadata.source) ||
              typeof metadata.updatedAt !== 'string',
          ) ||
          secretFields.some((field) => value.secrets[field] && !value.keyMetadata[field])
        )
          throw new Error();
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Otto could not open its saved settings.');
      }
      current = value ?? {
        version: 1,
        theme: 'system',
        launchAtLogin: false,
        notifications: false,
        onboardingCompleted: false,
        secrets: {},
        keyMetadata: {},
      };
      return current;
    })();
    try {
      return await loading;
    } finally {
      loading = undefined;
    }
  }
  function available() {
    if (
      !encryption.isEncryptionAvailable() ||
      encryption.getSelectedStorageBackend?.() === 'basic_text'
    )
      throw new Error('Unlock your system key store, then try again.');
  }
  function protect(value) {
    available();
    return encryption.encryptString(value).toString('base64');
  }
  function reveal(value) {
    if (!value) return '';
    available();
    try {
      return encryption.decryptString(Buffer.from(value, 'base64'));
    } catch {
      throw new Error('The system key store could not unlock your saved keys.');
    }
  }
  function redacted(value) {
    return {
      launchAtLogin: value.launchAtLogin,
      notifications: value.notifications,
      theme: value.theme,
      onboardingCompleted: value.onboardingCompleted,
    };
  }
  return {
    async get() {
      await writing;
      return redacted(await read());
    },
    save(input) {
      const operation = writing.then(async () => {
        if (!input || typeof input !== 'object' || Array.isArray(input))
          throw new Error('Check your settings and try again.');
        if (Object.keys(input).some((key) => !['theme', ...preferenceFields].includes(key)))
          throw new Error('These settings are not supported.');
        const previous = await read();
        const value = {
          ...previous,
          secrets: { ...previous.secrets },
          keyMetadata: { ...previous.keyMetadata },
        };
        if (input.theme !== undefined) {
          if (!['system', 'light', 'dark'].includes(input.theme))
            throw new Error('Choose a supported appearance.');
          value.theme = input.theme;
        }
        for (const field of preferenceFields) {
          if (input[field] === undefined) continue;
          if (typeof input[field] !== 'boolean') throw new Error('Check your preferences.');
          value[field] = input[field];
        }
        await write(value);
        return redacted(value);
      });
      writing = operation.catch(() => {});
      return operation;
    },
    async environment() {
      await writing;
      let value = await read();
      if (!value.secrets.vaultKey) {
        const operation = writing.then(async () => {
          const latest = await read();
          if (!latest.secrets.vaultKey)
            await write({
              ...latest,
              secrets: { ...latest.secrets, vaultKey: protect(randomBytes(32).toString('base64')) },
            });
        });
        writing = operation.catch(() => {});
        await operation;
        value = await read();
      }
      return {
        OTTO_VAULT_KEY: reveal(value.secrets.vaultKey),
      };
    },
  };
}
