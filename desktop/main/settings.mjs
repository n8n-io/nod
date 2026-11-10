import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const preferenceFields = ['launchAtLogin', 'notifications', 'onboardingCompleted'];
const onboardingPreferenceSteps = ['notifications', 'launchAtLogin', 'complete'];

export function desktopContentPolicy(posthogHost) {
  return `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' data:; connect-src 'self' ${new URL(posthogHost).origin}; media-src 'self' https: data: blob:; frame-src 'self' blob: data: https://www.openstreetmap.org; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
}

export function setupResource(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol === 'nod-setup:' &&
      url.hostname === 'app' &&
      !url.username &&
      !url.password &&
      !url.port &&
      ['/index.html', '/setup.js', '/setup.css', '/styles.css', '/Geist-Variable.woff2'].includes(
        url.pathname,
      )
    )
      return url.pathname.slice(1);
  } catch {}
}

export function serverOrigin(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) throw new Error();
    const url = new URL(value.trim());
    if (
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error('Enter an HTTPS server address, or a localhost address for an SSH tunnel.');
  }
}

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
      if (!record(value) || !record(value.secrets)) throw new Error();
      if (
        value.version !== 1 ||
        !['system', 'light', 'dark'].includes(value.theme) ||
        preferenceFields.some((field) => typeof value[field] !== 'boolean') ||
        (value.onboardingPreferenceStep !== undefined &&
          !onboardingPreferenceSteps.includes(value.onboardingPreferenceStep)) ||
        (value.serverUrl !== undefined &&
          (serverOrigin(value.serverUrl) !== value.serverUrl || !value.secrets.serverToken)) ||
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
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Nod could not open its saved settings.');
    }
    current = value ?? {
      version: 1,
      theme: 'system',
      launchAtLogin: false,
      notifications: false,
      onboardingCompleted: false,
      secrets: {},
    };
    unsynced = !!value;
    await durable();
    return current;
  }
  const keyStoreMessage =
    platform === 'darwin'
      ? 'Unlock your Mac keychain, then quit and reopen Nod.'
      : 'Unlock your system key store, then try again.';
  async function available() {
    try {
      if (
        !(platform === 'darwin'
          ? await encryption.isAsyncEncryptionAvailable()
          : encryption.isEncryptionAvailable()) ||
        encryption.getSelectedStorageBackend?.() === 'basic_text'
      )
        throw new Error();
    } catch {
      throw Object.assign(new Error(keyStoreMessage), { code: 'NOD_KEY_STORE_UNAVAILABLE' });
    }
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
      throw Object.assign(new Error(keyStoreMessage), { code: 'NOD_KEY_STORE_UNAVAILABLE' });
    }
  }
  async function reveal(field, failure) {
    const value = current.secrets[field];
    if (!value) return '';
    await available();
    try {
      if (platform === 'darwin') {
        const ciphertext = Buffer.from(value, 'base64');
        const { result } = await encryption.decryptStringAsync(ciphertext);
        if (!(await encryption.encryptStringAsync(result)).equals(ciphertext))
          throw new Error(keyStoreMessage);
        return result;
      }
      return encryption.decryptString(Buffer.from(value, 'base64'));
    } catch {
      if (platform === 'darwin' && encryption.decryptLegacyStringAsync) {
        let result;
        let replacement;
        try {
          result = await encryption.decryptLegacyStringAsync(Buffer.from(value, 'base64'));
          if (
            field === 'vaultKey'
              ? Buffer.from(result, 'base64').length !== 32 ||
                Buffer.from(result, 'base64').toString('base64') !== result
              : !/^[A-Za-z0-9_-]{43,}$/.test(result)
          )
            throw new Error();
          replacement = await protect(result);
          if (
            (await encryption.decryptStringAsync(Buffer.from(replacement, 'base64'))).result !==
            result
          )
            throw new Error();
        } catch (error) {
          if (error.code === 'NOD_KEY_STORE_UNAVAILABLE') throw error;
          replacement = undefined;
        }
        if (replacement) {
          await write({
            ...current,
            secrets: { ...current.secrets, [field]: replacement },
          });
          return result;
        }
      }
      throw (
        failure ??
        new Error(
          platform === 'darwin'
            ? 'Nod could not read its saved key. Please quit and reopen Nod. If this error continues, contact support.'
            : 'The system key store could not unlock your saved keys.',
        )
      );
    }
  }
  function redacted(value) {
    return {
      launchAtLogin: value.launchAtLogin,
      notifications: value.notifications,
      theme: value.theme,
      onboardingCompleted: value.onboardingCompleted,
      ...(value.serverUrl ? { serverUrl: value.serverUrl } : {}),
      ...(value.welcome ? { welcome: { ...value.welcome } } : {}),
      onboardingPreferenceStep:
        value.onboardingCompleted || value.onboardingPreferenceStep === 'complete'
          ? 'complete'
          : 'launchAtLogin',
    };
  }
  return {
    get() {
      return exclusive(async () => redacted(await read()));
    },
    hasSavedKeys() {
      return exclusive(async () => Object.keys((await read()).secrets).length > 0);
    },
    connection() {
      return exclusive(async () => {
        const value = await read();
        if (!value.serverUrl) return null;
        return {
          url: value.serverUrl,
          token: await reveal(
            'serverToken',
            Object.assign(
              new Error(
                'Nod could not unlock your saved server token. Reconnect with your server’s authentication token.',
              ),
              { code: 'NOD_SERVER_TOKEN_UNAVAILABLE' },
            ),
          ),
        };
      });
    },
    saveConnection(input) {
      return exclusive(async () => {
        const previous = await read();
        const value = { ...previous, secrets: { ...previous.secrets } };
        if (input === null) {
          delete value.serverUrl;
          delete value.secrets.serverToken;
        } else {
          if (
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            Object.keys(input).some((field) => !['url', 'token'].includes(field)) ||
            typeof input.token !== 'string' ||
            !/^[A-Za-z0-9_-]{43,}$/.test(input.token)
          )
            throw new Error('Enter the authentication token configured on your server.');
          value.serverUrl = serverOrigin(input.url);
          value.secrets.serverToken = await protect(input.token);
        }
        await write(value);
        return redacted(value);
      });
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
        if (input.onboardingPreferenceStep !== undefined) {
          if (previous.onboardingCompleted || input.onboardingPreferenceStep !== 'complete')
            throw new Error('Choose your desktop preference before continuing.');
          value.onboardingPreferenceStep = input.onboardingPreferenceStep;
        }
        if (
          value.onboardingCompleted &&
          !previous.onboardingCompleted &&
          value.onboardingPreferenceStep !== 'complete' &&
          !value.launchAtLogin
        )
          throw new Error('Finish the desktop preference step before continuing.');
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
        return { NOD_VAULT_KEY: await reveal('vaultKey') };
      });
    },
  };
}
