import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { ModelTrace, ModelTraceDelivery, ModelTraces } from '../ports/traces.ts';
import { createPersonalDataRedactor, personalKey, type PersonalProfile } from './personal-data.ts';
import { createTextRedactor, withoutSecretKeys } from './redaction.ts';

const cacheLimit = 4096;
const identifiers = new Set(['session_id', 'turn_id', 'run_id', 'parent_run_id']);

function structured(value: string, text: (value: string) => string) {
  const trimmed = value.trim();
  if (!/^[[{]/.test(trimmed)) return text(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return text(value);
  }
  const visit = (item: unknown, key?: string): unknown =>
    key !== undefined && personalKey(key) && item !== null && item !== ''
      ? '[personal]'
      : typeof item === 'string'
        ? text(item)
        : Array.isArray(item)
          ? item.map((entry) => visit(entry))
          : item && typeof item === 'object'
            ? Object.fromEntries(
                Object.entries(item).map(([name, entry]) => [text(name), visit(entry, name)]),
              )
            : item;
  return JSON.stringify(visit(withoutSecretKeys(parsed)));
}

export function createModelTraces(deliver?: ModelTraceDelivery) {
  let enabled = false;
  let secrets: string[] = [];
  let secretText = createTextRedactor(secrets);
  let profile: () => Promise<PersonalProfile> = async () => ({ names: [] });
  let loaded: { profile: string; text: (value: string) => string } | undefined;
  let seen = -1;
  const cache = new Map<string, string>();
  let stopping = new AbortController();
  const salt = randomBytes(32);
  const pseudonym = (value: string) =>
    createHmac('sha256', salt)
      .update(`${new Date().toISOString().slice(0, 10)}:${value}`)
      .digest('hex')
      .slice(0, 32);

  async function scrubber() {
    const current = await profile();
    const key = JSON.stringify(current);
    if (loaded?.profile !== key) {
      const personal = createPersonalDataRedactor(current);
      loaded = { profile: key, text: (value) => personal(secretText(value)) };
      cache.clear();
    }
    if (seen !== secrets.length) {
      seen = secrets.length;
      cache.clear();
    }
    const text = loaded.text;
    return (value: string) => {
      const key = createHash('sha256').update(value).digest('base64');
      let safe = cache.get(key);
      if (safe === undefined) {
        if (cache.size >= cacheLimit) cache.clear();
        cache.set(key, (safe = structured(value, text)));
      }
      return safe;
    };
  }

  async function send(trace: ModelTrace) {
    const signal = stopping.signal;
    const text = await scrubber();
    const scrub = (value: unknown) =>
      JSON.parse(
        JSON.stringify(withoutSecretKeys(value), (_key, item) =>
          typeof item === 'string' ? text(item) : item,
        ),
      );
    if (!enabled || !deliver || signal.aborted) return;
    await deliver(
      {
        ...trace,
        messages: scrub(trace.messages),
        output: scrub(trace.output),
        ...(trace.error ? { error: text(trace.error) } : {}),
        metadata: Object.fromEntries(
          Object.entries(trace.metadata).map(([key, value]) => [
            key,
            identifiers.has(key) ? pseudonym(value) : value,
          ]),
        ),
      },
      signal,
    );
  }

  return {
    configure(options: {
      enabled?: boolean;
      secrets?: string[];
      profile?: () => Promise<PersonalProfile>;
    }) {
      if (options.enabled !== undefined) enabled = options.enabled;
      if (!enabled) {
        cache.clear();
        stopping.abort();
        stopping = new AbortController();
      }
      if (options.secrets) {
        secrets = options.secrets;
        secretText = createTextRedactor(secrets);
        loaded = undefined;
      }
      if (options.profile) {
        profile = options.profile;
        loaded = undefined;
      }
    },
    available: deliver !== undefined,
    active: () => enabled && deliver !== undefined,
    record(trace: ModelTrace) {
      if (enabled && deliver) void send(trace).catch(() => {});
    },
  } satisfies ModelTraces & Record<string, unknown>;
}

export type ModelTraceGate = ReturnType<typeof createModelTraces>;
