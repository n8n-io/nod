import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const secretFields = ['composioApiKey'];
const preferenceFields = ['launchAtLogin', 'notifications', 'onboardingCompleted'];
const onboardingPreferenceSteps = ['notifications', 'launchAtLogin', 'complete'];

export function createSettingsStore(path, encryption, platform = process.platform) {
  let current;
  let unsynced = false;
  let writing = Promise.resolve();
  async function durable() {
    if (!unsynced) return;
    if (process.platform !== 'win32') {
      const directory = await realpath(dirname(path));
      for (let parent = directory; ; parent = dirname(parent)) {
        if (parent !== directory) {
          try {
            await access(parent, constants.W_OK);
          } catch (error) {
            if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) break;
            throw error;
          }
        }
        const handle = await open(parent, 'r');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (dirname(parent) === parent) break;
      }
    }
    unsynced = false;
  }
  function exclusive(action) {
    const operation = writing.then(async () => {
      await durable();
      return action();
    });
    writing = operation.catch(() => {});
    return operation;
  }
  async function write(value) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.pending`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(value));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      current = value;
      unsynced = true;
      await durable();
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async function read() {
    if (current) return current;
    let value;
    try {
      value = JSON.parse(await readFile(path, 'utf8'));
      const record = (input) => input && typeof input === 'object' && !Array.isArray(input);
      if (
        !record(value) ||
        value.version !== 1 ||
        Object.keys(value).some(
          (field) =>
            ![
              'version',
              'theme',
              ...preferenceFields,
              'onboardingPreferenceStep',
              'welcome',
              'secrets',
              'keyMetadata',
            ].includes(field),
        ) ||
        !['system', 'light', 'dark'].includes(value.theme) ||
        preferenceFields.some((field) => typeof value[field] !== 'boolean') ||
        (value.onboardingPreferenceStep !== undefined &&
          !onboardingPreferenceSteps.includes(value.onboardingPreferenceStep)) ||
        (value.welcome !== undefined &&
          (!record(value.welcome) ||
            Object.keys(value.welcome).some(
              (field) => !['usageData', 'continued', 'acknowledged'].includes(field),
            ) ||
            (value.welcome.acknowledged !== undefined &&
              (value.welcome.acknowledged !== true || value.welcome.continued !== true)) ||
            typeof value.welcome.usageData !== 'boolean' ||
            typeof value.welcome.continued !== 'boolean')) ||
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
    unsynced = !!value;
    await durable();
    return current;
  }
  const keyStoreMessage =
    platform === 'darwin'
      ? 'Unlock your Mac keychain, then quit and reopen Otto.'
      : 'Unlock your system key store, then try again.';
  async function available() {
    if (
      !(platform === 'darwin'
        ? await encryption.isAsyncEncryptionAvailable()
        : encryption.isEncryptionAvailable()) ||
      encryption.getSelectedStorageBackend?.() === 'basic_text'
    )
      throw new Error(keyStoreMessage);
  }
  async function protect(value) {
    try {
      await available();
      return (
        platform === 'darwin'
          ? await encryption.encryptStringAsync(value)
          : encryption.encryptString(value)
      ).toString('base64');
    } catch {
      throw new Error(keyStoreMessage);
    }
  }
  async function reveal(value) {
    if (!value) return '';
    try {
      await available();
      if (platform === 'darwin') {
        const ciphertext = Buffer.from(value, 'base64');
        const { result } = await encryption.decryptStringAsync(ciphertext);
        if (!(await encryption.encryptStringAsync(result)).equals(ciphertext))
          throw new Error(keyStoreMessage);
        return result;
      }
      return encryption.decryptString(Buffer.from(value, 'base64'));
    } catch {
      throw new Error(
        platform === 'darwin'
          ? keyStoreMessage
          : 'The system key store could not unlock your saved keys.',
      );
    }
  }
  function redacted(value) {
    return {
      launchAtLogin: value.launchAtLogin,
      notifications: value.notifications,
      theme: value.theme,
      onboardingCompleted: value.onboardingCompleted,
      ...(value.welcome ? { welcome: { ...value.welcome } } : {}),
      onboardingPreferenceStep: value.onboardingCompleted
        ? 'complete'
        : (value.onboardingPreferenceStep ?? 'notifications'),
    };
  }
  return {
    get() {
      return exclusive(async () => redacted(await read()));
    },
    save(input) {
      return exclusive(async () => {
        if (!input || typeof input !== 'object' || Array.isArray(input))
          throw new Error('Check your settings and try again.');
        if (
          Object.keys(input).some(
            (key) =>
              !['theme', ...preferenceFields, 'onboardingPreferenceStep', 'welcome'].includes(key),
          )
        )
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
        if (input.welcome !== undefined) {
          if (
            previous.onboardingCompleted ||
            previous.welcome?.continued ||
            !input.welcome ||
            typeof input.welcome !== 'object' ||
            Array.isArray(input.welcome) ||
            Object.keys(input.welcome).some(
              (field) => !['usageData', 'continued'].includes(field),
            ) ||
            typeof input.welcome.usageData !== 'boolean' ||
            typeof input.welcome.continued !== 'boolean'
          )
            throw new Error('Welcome has already finished or its choices are invalid.');
          value.welcome = { ...input.welcome };
        }
        for (const field of preferenceFields) {
          if (input[field] === undefined) continue;
          if (typeof input[field] !== 'boolean') throw new Error('Check your preferences.');
          value[field] = input[field];
        }
        if (input.onboardingPreferenceStep !== undefined) {
          const step = redacted(previous).onboardingPreferenceStep;
          const next = step === 'notifications' ? 'launchAtLogin' : 'complete';
          const answered =
            input.onboardingPreferenceStep === 'launchAtLogin'
              ? 'notifications'
              : input.onboardingPreferenceStep === 'complete'
                ? 'launchAtLogin'
                : undefined;
          const repeated =
            answered &&
            !previous.onboardingCompleted &&
            input.onboardingPreferenceStep === step &&
            input[answered] === previous[answered];
          if (
            !repeated &&
            (step === 'complete' ||
              input.onboardingPreferenceStep !== next ||
              typeof input[step] !== 'boolean')
          )
            throw new Error('Choose your desktop preference before continuing.');
          value.onboardingPreferenceStep = input.onboardingPreferenceStep;
        }
        if (value.onboardingCompleted) delete value.welcome;
        await write(value);
        return redacted(value);
      });
    },
    acknowledgeWelcome(expected) {
      return exclusive(async () => {
        const value = await read();
        if (
          !value.welcome ||
          value.welcome.continued !== true ||
          value.welcome.usageData !== expected.usageData ||
          value.welcome.continued !== expected.continued
        )
          throw new Error('Welcome changed. Try again.');
        await write({ ...value, welcome: { ...value.welcome, acknowledged: true } });
      });
    },
    legacyIntegration() {
      return exclusive(async () => {
        const value = await read();
        if (!value.secrets.composioApiKey) return;
        const apiKey = await reveal(value.secrets.composioApiKey);
        if (!apiKey.trim() || apiKey.length > 16384)
          throw new Error('Otto could not open its saved app connection.');
        const names = {
          COMPOSIO_GMAIL_AUTH_CONFIG_ID: 'gmail',
          COMPOSIO_CALENDAR_AUTH_CONFIG_ID: 'googlecalendar',
          COMPOSIO_DRIVE_AUTH_CONFIG_ID: 'googledrive',
          COMPOSIO_SHEETS_AUTH_CONFIG_ID: 'googlesheets',
          COMPOSIO_DOCS_AUTH_CONFIG_ID: 'googledocs',
          COMPOSIO_SLACK_AUTH_CONFIG_ID: 'slack',
          COMPOSIO_NOTION_AUTH_CONFIG_ID: 'notion',
        };
        let configuration = {};
        if (value.secrets.integrationConfiguration) {
          const encoded = await reveal(value.secrets.integrationConfiguration);
          try {
            configuration = JSON.parse(encoded);
          } catch {
            throw new Error('Otto could not open its saved app connection.');
          }
        }
        if (
          !configuration ||
          typeof configuration !== 'object' ||
          Array.isArray(configuration) ||
          Object.entries(configuration).some(
            ([name, id]) =>
              !Object.hasOwn(names, name) || typeof id !== 'string' || id.length > 16384,
          )
        )
          throw new Error('Otto could not open its saved app connection.');
        return {
          receipt: createHash('sha256')
            .update(
              JSON.stringify([
                value.secrets.composioApiKey,
                value.secrets.integrationConfiguration,
              ]),
            )
            .digest('hex'),
          apiKey,
          authConfigs: Object.fromEntries(
            Object.entries(configuration)
              .filter(([, id]) => id.trim())
              .map(([name, id]) => [names[name], id]),
          ),
        };
      });
    },
    acknowledgeLegacyIntegration(receipt) {
      return exclusive(async () => {
        current = undefined;
        const previous = await read();
        if (!previous.secrets.composioApiKey) return;
        const expected = createHash('sha256')
          .update(
            JSON.stringify([
              previous.secrets.composioApiKey,
              previous.secrets.integrationConfiguration,
            ]),
          )
          .digest('hex');
        if (receipt !== expected) throw new Error('The saved app connection changed.');
        const value = {
          ...previous,
          secrets: { ...previous.secrets },
          keyMetadata: { ...previous.keyMetadata },
        };
        delete value.secrets.composioApiKey;
        delete value.secrets.integrationConfiguration;
        delete value.keyMetadata.composioApiKey;
        await write(value);
      });
    },
    environment() {
      return exclusive(async () => {
        const value = await read();
        if (!value.secrets.vaultKey)
          await write({
            ...value,
            secrets: {
              ...value.secrets,
              vaultKey: await protect(randomBytes(32).toString('base64')),
            },
          });
        return { OTTO_VAULT_KEY: await reveal(current.secrets.vaultKey) };
      });
    },
  };
}
