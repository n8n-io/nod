import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const defaults = {
  locale: null,
  timeZone: null,
  hourCycle: 'auto',
  quietHoursEnabled: true,
  quietStart: '22:00',
  quietEnd: '08:00',
};
const fields = Object.keys(defaults);

function validate(input, complete = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Check your preferences and try again.');
  if (Object.keys(input).some((field) => !fields.includes(field)))
    throw new Error('These preferences are not supported.');
  if (complete && fields.some((field) => !Object.hasOwn(input, field)))
    throw new Error('Nod could not read your preferences.');
  const result = { ...input };
  if (Object.hasOwn(result, 'locale') && result.locale !== null) {
    try {
      if (typeof result.locale !== 'string' || result.locale.length > 35) throw new Error();
      const [locale] = Intl.getCanonicalLocales(result.locale.trim());
      if (!locale || !Intl.DateTimeFormat.supportedLocalesOf(locale).length) throw new Error();
      result.locale = locale;
    } catch {
      throw new Error('Choose a valid region.');
    }
  }
  if (Object.hasOwn(result, 'timeZone') && result.timeZone !== null) {
    try {
      if (
        typeof result.timeZone !== 'string' ||
        result.timeZone.length > 100 ||
        /^[+-]/.test(result.timeZone)
      )
        throw new Error();
      new Intl.DateTimeFormat('en', { timeZone: result.timeZone });
    } catch {
      throw new Error('Choose a valid time zone.');
    }
  }
  if (Object.hasOwn(result, 'hourCycle') && !['auto', 'h12', 'h23'].includes(result.hourCycle))
    throw new Error('Choose a supported clock format.');
  if (Object.hasOwn(result, 'quietHoursEnabled') && typeof result.quietHoursEnabled !== 'boolean')
    throw new Error('Choose whether quiet hours are enabled.');
  for (const field of ['quietStart', 'quietEnd'])
    if (
      Object.hasOwn(result, field) &&
      (typeof result[field] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(result[field]))
    )
      throw new Error('Choose a valid quiet-hours time.');
  return result;
}

function fromServer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Nod could not read your preferences.');
  return validate(
    Object.fromEntries(
      fields.filter((field) => Object.hasOwn(value, field)).map((field) => [field, value[field]]),
    ),
    true,
  );
}

export function createAppPreferencesStore(path, { request, isReady }) {
  let state;
  let operations = Promise.resolve();
  function serialized(operation) {
    const result = operations.then(operation);
    operations = result.catch(() => {});
    return result;
  }
  async function read() {
    if (state) return;
    try {
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (value.version !== 1 || !Object.hasOwn(value, 'cached')) throw new Error();
      state = {
        version: 1,
        cached: value.cached === null ? null : validate(value.cached, true),
        pending: validate(value.pending),
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Nod could not open its saved preferences.');
      state = { version: 1, cached: null, pending: {} };
    }
  }
  async function write(value) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.pending`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
    state = value;
  }
  function view() {
    return {
      preferences: { ...defaults, ...state.cached, ...state.pending },
      pending: Object.keys(state.pending).length > 0,
    };
  }
  async function synchronize() {
    const response = await request('/api/preferences', { method: 'GET', redirect: 'error' });
    if (!response.ok) throw new Error('Nod could not read your preferences.');
    const cached = fromServer(await response.json());
    if (JSON.stringify(cached) !== JSON.stringify(state.cached)) await write({ ...state, cached });
    if (!Object.keys(state.pending).length) return;
    const saved = await request('/api/preferences', {
      method: 'PATCH',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state.pending),
    });
    if (!saved.ok) throw new Error('Nod could not apply your saved preferences.');
    await write({ version: 1, cached: fromServer(await saved.json()), pending: {} });
  }
  return {
    get() {
      return serialized(async () => {
        await read();
        if (isReady()) await synchronize().catch(() => {});
        return view();
      });
    },
    save(input) {
      return serialized(async () => {
        const patch = validate(input);
        await read();
        if (Object.keys(patch).length)
          await write({ ...state, pending: { ...state.pending, ...patch } });
        if (isReady()) await synchronize();
        return view();
      });
    },
    sync() {
      return serialized(async () => {
        await read();
        try {
          await synchronize();
        } catch {
          if (Object.keys(state.pending).length)
            throw Object.assign(
              new Error('Nod could not apply your saved preferences. Try again.'),
              {
                code: 'PREFERENCES_SYNC_REQUIRED',
              },
            );
        }
        return view();
      });
    },
  };
}
