import type { ModelTrace, ModelTraceDelivery, ModelTraces } from '../ports/traces.ts';
import { createPersonalDataRedactor, type PersonalProfile } from './personal-data.ts';
import { createTextRedactor, withoutSecretKeys } from './redaction.ts';

const cacheLimit = 4096;

export function createModelTraces(deliver?: ModelTraceDelivery) {
  let enabled = false;
  let secrets: string[] = [];
  let secretText = createTextRedactor(secrets);
  let profile: () => Promise<PersonalProfile> = async () => ({ names: [] });
  let loaded: { profile: string; text: (value: string) => string } | undefined;
  let seen = -1;
  const cache = new Map<string, string>();

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
      let safe = cache.get(value);
      if (safe === undefined) {
        if (cache.size >= cacheLimit) cache.clear();
        cache.set(value, (safe = text(value)));
      }
      return safe;
    };
  }

  async function send(trace: ModelTrace) {
    const text = await scrubber();
    const scrub = (value: unknown) =>
      JSON.parse(
        JSON.stringify(withoutSecretKeys(value), (_key, item) =>
          typeof item === 'string' ? text(item) : item,
        ),
      );
    if (!enabled || !deliver) return;
    await deliver({
      ...trace,
      messages: scrub(trace.messages),
      output: scrub(trace.output),
      ...(trace.error ? { error: text(trace.error) } : {}),
    });
  }

  return {
    configure(options: {
      enabled?: boolean;
      secrets?: string[];
      profile?: () => Promise<PersonalProfile>;
    }) {
      if (options.enabled !== undefined) enabled = options.enabled;
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
