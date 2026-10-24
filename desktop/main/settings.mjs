import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const preferenceFields = ['launchAtLogin', 'notifications', 'onboardingCompleted'];
const onboardingPreferenceSteps = ['notifications', 'launchAtLogin', 'complete'];
const notificationRequests = ['pending', 'requested', 'chosen', 'unsupported', 'failed', 'legacy'];

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
      const saved = JSON.parse(await readFile(path, 'utf8'));
      const record = (input) => input && typeof input === 'object' && !Array.isArray(input);
      if (!record(saved) || !record(saved.secrets)) throw new Error();
      const fields = [
        'version',
        'theme',
        ...preferenceFields,
        'onboardingPreferenceStep',
        'notificationRequest',
        'welcome',
        'secrets',
      ];
      value = Object.fromEntries(Object.entries(saved).filter(([field]) => fields.includes(field)));
      value.secrets = Object.hasOwn(saved.secrets, 'vaultKey')
        ? { vaultKey: saved.secrets.vaultKey }
        : {};
      if (
        value.version !== 1 ||
        !['system', 'light', 'dark'].includes(value.theme) ||
        preferenceFields.some((field) => typeof value[field] !== 'boolean') ||
        (value.onboardingPreferenceStep !== undefined &&
          !onboardingPreferenceSteps.includes(value.onboardingPreferenceStep)) ||
        (value.notificationRequest !== undefined &&
          !notificationRequests.includes(value.notificationRequest)) ||
        (value.welcome !== undefined &&
          (!record(value.welcome) ||
            Object.keys(value.welcome).some(
              (field) => !['usageData', 'continued', 'acknowledged'].includes(field),
            ) ||
            (value.welcome.acknowledged !== undefined &&
              (value.welcome.acknowledged !== true || value.welcome.continued !== true)) ||
            typeof value.welcome.usageData !== 'boolean' ||
            typeof value.welcome.continued !== 'boolean')) ||
        Object.values(value.secrets).some((secret) => typeof secret !== 'string' || !secret)
      )
        throw new Error();
      value.notificationRequest ??= 'legacy';
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('nod could not open its saved settings.');
    }
    current = value ?? {
      version: 1,
      theme: 'system',
      launchAtLogin: false,
      notifications: false,
      notificationRequest: 'pending',
      onboardingCompleted: false,
      secrets: {},
    };
    unsynced = !!value;
    await durable();
    return current;
  }
  const keyStoreMessage =
    platform === 'darwin'
      ? 'Unlock your Mac keychain, then quit and reopen nod.'
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
        : value.onboardingPreferenceStep === 'complete' && value.launchAtLogin
          ? 'complete'
          : 'launchAtLogin',
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
        if (input.notifications !== undefined) value.notificationRequest = 'chosen';
        if (input.onboardingPreferenceStep !== undefined) {
          const step = redacted(previous).onboardingPreferenceStep;
          const repeated =
            !previous.onboardingCompleted &&
            step === 'complete' &&
            input.onboardingPreferenceStep === 'complete' &&
            input.launchAtLogin === true;
          if (
            !repeated &&
            (step === 'complete' ||
              input.onboardingPreferenceStep !== 'complete' ||
              input.launchAtLogin !== true)
          )
            throw new Error('Choose your desktop preference before continuing.');
          value.onboardingPreferenceStep = input.onboardingPreferenceStep;
        }
        if (value.onboardingCompleted && !previous.onboardingCompleted && !value.launchAtLogin)
          throw new Error('Turn on Open at login to finish setup.');
        if (value.onboardingCompleted) delete value.welcome;
        await write(value);
        return redacted(value);
      });
    },
    claimNotificationRequest() {
      return exclusive(async () => {
        const value = await read();
        if (value.notificationRequest !== 'pending' || value.notifications) return false;
        await write({ ...value, notificationRequest: 'requested' });
        return true;
      });
    },
    finishNotificationRequest(status) {
      return exclusive(async () => {
        if (!['requested', 'unsupported', 'failed'].includes(status))
          throw new Error('This notification request is invalid.');
        const value = await read();
        if (value.notificationRequest !== 'requested') return redacted(value);
        const next = {
          ...value,
          notificationRequest: status,
          notifications: status === 'requested',
        };
        await write(next);
        return redacted(next);
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
        return { NOD_VAULT_KEY: await reveal(current.secrets.vaultKey) };
      });
    },
  };
}
