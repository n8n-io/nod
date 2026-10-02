import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { availableModels, modelCatalog, selectedModel } from './models.mjs';

export const secretFields = ['openaiApiKey', 'anthropicApiKey', 'composioApiKey'];
const integrationKeys = [
  'COMPOSIO_GMAIL_AUTH_CONFIG_ID',
  'COMPOSIO_CALENDAR_AUTH_CONFIG_ID',
  'COMPOSIO_DRIVE_AUTH_CONFIG_ID',
  'COMPOSIO_SHEETS_AUTH_CONFIG_ID',
  'COMPOSIO_DOCS_AUTH_CONFIG_ID',
  'COMPOSIO_SLACK_AUTH_CONFIG_ID',
  'COMPOSIO_NOTION_AUTH_CONFIG_ID',
];
const preferenceFields = ['launchAtLogin', 'notifications', 'onboardingCompleted'];

export function createSettingsStore(path, encryption, validate = async () => {}) {
  let current;
  let loading;
  let writing = Promise.resolve();
  let engineRevision = 0;
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
        if (
          ![1, 2].includes(value.version) ||
          !['openai', 'anthropic'].includes(value.provider) ||
          !value.secrets ||
          typeof value.secrets !== 'object' ||
          Array.isArray(value.secrets)
        )
          throw new Error();
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Otto could not open its saved settings.');
      }
      const migrated = {
        ...value,
        version: 2,
        provider: value?.provider || 'openai',
        model: value?.model || '',
        theme: ['system', 'light', 'dark'].includes(value?.theme) ? value.theme : 'system',
        launchAtLogin: value?.launchAtLogin === true,
        notifications: value?.notifications === true,
        onboardingCompleted: value?.version === 1 || value?.onboardingCompleted === true,
        secrets: value?.secrets || {},
        keyMetadata: value?.keyMetadata || {},
      };
      if (value?.version === 1) await write(migrated);
      else current = migrated;
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
      provider: value.provider,
      model: selectedModel(value),
      hasOpenAIKey: Boolean(value.secrets.openaiApiKey),
      hasAnthropicKey: Boolean(value.secrets.anthropicApiKey),
      hasComposioKey: Boolean(value.secrets.composioApiKey),
      launchAtLogin: value.launchAtLogin,
      notifications: value.notifications,
      theme: value.theme,
      onboardingCompleted: value.onboardingCompleted,
      models: availableModels(value),
      keys: Object.fromEntries(
        secretFields.map((field) => {
          const metadata = value.keyMetadata[field];
          const present = Boolean(value.secrets[field]);
          return [
            field,
            {
              suffix:
                present && typeof metadata?.suffix === 'string' ? metadata.suffix.slice(-4) : null,
              source: present
                ? ['manual', 'import'].includes(metadata?.source)
                  ? metadata.source
                  : 'saved'
                : null,
              updatedAt:
                present && typeof metadata?.updatedAt === 'string' ? metadata.updatedAt : null,
            },
          ];
        }),
      ),
    };
  }
  return {
    async get() {
      await writing;
      return redacted(await read());
    },
    async revision() {
      await writing;
      return engineRevision;
    },
    async revealKey(field) {
      if (!secretFields.includes(field)) throw new Error('Choose a supported provider key.');
      await writing;
      return reveal((await read()).secrets[field]);
    },
    save(input, importedConfiguration) {
      const operation = writing.then(async () => {
        if (!input || typeof input !== 'object' || Array.isArray(input))
          throw new Error('Check your settings and try again.');
        if (
          Object.keys(input).some(
            (key) =>
              ![
                'provider',
                'model',
                'theme',
                'clearKeys',
                ...preferenceFields,
                ...secretFields,
              ].includes(key),
          )
        )
          throw new Error('These settings are not supported.');
        const previous = await read();
        const value = {
          ...previous,
          secrets: { ...previous.secrets },
          keyMetadata: { ...previous.keyMetadata },
        };
        let validatedProvider;
        if (input.provider !== undefined) {
          if (!['openai', 'anthropic'].includes(input.provider))
            throw new Error('Choose OpenAI or Anthropic.');
          value.provider = input.provider;
          if (value.provider !== previous.provider) value.model = '';
        }
        if (input.model !== undefined) {
          if (typeof input.model !== 'string' || input.model.length > 256)
            throw new Error('Choose an available model.');
          const model = input.model.trim();
          if (
            model &&
            !importedConfiguration &&
            !modelCatalog[value.provider].some(({ id }) => id === model) &&
            !(value.provider === previous.provider && model === previous.model)
          )
            throw new Error('Choose an available model.');
          value.model = model;
        }
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
        if (input.clearKeys !== undefined) {
          if (
            !Array.isArray(input.clearKeys) ||
            input.clearKeys.some((key) => !secretFields.includes(key))
          )
            throw new Error('Choose a supported key to remove.');
          for (const key of input.clearKeys) {
            delete value.secrets[key];
            delete value.keyMetadata[key];
          }
        }
        for (const key of secretFields) {
          if (input[key] === null) {
            delete value.secrets[key];
            delete value.keyMetadata[key];
            continue;
          }
          if (input[key] === undefined || input[key] === '') continue;
          if (typeof input[key] !== 'string' || input[key].length > 16_384)
            throw new Error('Enter a valid provider key.');
          const secret = input[key].trim();
          if (secret) {
            if (key !== 'composioApiKey') {
              const provider = key === 'openaiApiKey' ? 'openai' : 'anthropic';
              await validate(
                provider,
                secret,
                provider === value.provider ? selectedModel(value) : undefined,
              );
              if (provider === value.provider) validatedProvider = provider;
            }
            value.secrets[key] = protect(secret);
            value.keyMetadata[key] = {
              suffix: secret.length > 4 ? secret.slice(-4) : null,
              source: importedConfiguration ? 'import' : 'manual',
              updatedAt: new Date().toISOString(),
            };
          }
        }
        if (
          validatedProvider !== value.provider &&
          (value.provider !== previous.provider || selectedModel(value) !== selectedModel(previous))
        ) {
          const field = value.provider === 'openai' ? 'openaiApiKey' : 'anthropicApiKey';
          if (value.secrets[field])
            await validate(value.provider, reveal(value.secrets[field]), selectedModel(value));
        }
        if (importedConfiguration) {
          const allowed = Object.fromEntries(
            integrationKeys
              .filter((key) => typeof importedConfiguration[key] === 'string')
              .map((key) => [key, importedConfiguration[key]]),
          );
          value.secrets.integrationConfiguration = protect(JSON.stringify(allowed));
        }
        if (secretFields.some((field) => value.secrets[field]))
          value.secrets.vaultKey ??= protect(randomBytes(32).toString('base64'));
        const changed =
          value.provider !== previous.provider ||
          selectedModel(value) !== selectedModel(previous) ||
          [...secretFields, 'integrationConfiguration'].some(
            (field) => value.secrets[field] !== previous.secrets[field],
          );
        await write(value);
        if (changed) engineRevision++;
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
        ...(value.secrets.integrationConfiguration
          ? JSON.parse(reveal(value.secrets.integrationConfiguration))
          : {}),
        LLM_PROVIDER: value.provider,
        LLM_MODEL: selectedModel(value),
        OPENAI_API_KEY: reveal(value.secrets.openaiApiKey),
        ANTHROPIC_API_KEY: reveal(value.secrets.anthropicApiKey),
        COMPOSIO_API_KEY: reveal(value.secrets.composioApiKey),
        OTTO_VAULT_KEY: reveal(value.secrets.vaultKey),
      };
    },
  };
}
