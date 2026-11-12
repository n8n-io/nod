import { createHash, createHmac, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import type { ModelTrace, ModelTraceDelivery, ModelTraces } from '../ports/traces.ts';
import {
  createPersonalDataRedactor,
  withoutPersonalFields,
  type PersonalProfile,
} from './personal-data.ts';
import { createTextRedactor, withoutSecretKeys } from './redaction.ts';

const cacheLimit = 4096;
const conversationGap = 30 * 60_000;
const identifiers = new Set(['turn_id', 'run_id', 'parent_run_id']);
const uuids = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const home = homedir();
const homes = home.length > 1 ? [home, JSON.stringify(home).slice(1, -1)] : [];

function structured(value: string, text: (value: string) => string) {
  const trimmed = value.trim();
  if (!/^[[{]/.test(trimmed)) return text(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return text(value);
  }
  return JSON.stringify(withoutPersonalFields(withoutSecretKeys(parsed), text));
}

export function createModelTraces(deliver?: ModelTraceDelivery) {
  let enabled = false;
  let secrets: string[] = [];
  let secretText = createTextRedactor(secrets);
  let profile: () => Promise<PersonalProfile> = async () => ({ names: [] });
  let loaded: { profile: string; text: (value: string) => string } | undefined;
  let seen = -1;
  const cache = new Map<string, string>();
  const conversations = new Map<string, { id: string; last: number }>();
  let stopping = new AbortController();
  const salt = randomBytes(32);
  const pseudonym = (value: string) =>
    createHmac('sha256', salt)
      .update(`${new Date().toISOString().slice(0, 10)}:${value}`)
      .digest('hex')
      .slice(0, 32);

  function conversation(trace: ModelTrace) {
    const session = trace.metadata.session_id;
    if (!session) return undefined;
    const start = Date.parse(trace.startedAt);
    let current = conversations.get(session);
    if (!current || start - current.last > conversationGap) {
      for (const [key, value] of conversations)
        if (start - value.last > conversationGap) conversations.delete(key);
      current = { id: randomBytes(16).toString('hex'), last: start };
      conversations.set(session, current);
    }
    current.last = Math.max(current.last, Date.parse(trace.endedAt));
    return current.id;
  }

  async function scrubber() {
    const current = await profile();
    const key = JSON.stringify(current);
    if (loaded?.profile !== key) {
      const personal = createPersonalDataRedactor(current);
      loaded = {
        profile: key,
        text: (value) =>
          personal(secretText(homes.reduce((text, path) => text.replaceAll(path, '~'), value))),
      };
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
      return safe.replace(uuids, (id) => pseudonym(id.toLowerCase()));
    };
  }

  async function send(trace: ModelTrace, thread?: string) {
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
        name: scrub(trace.name) || '[redacted]',
        provider: scrub(trace.provider) || '[redacted]',
        tools: trace.tools.map((tool) => scrub(tool) || '[redacted]'),
        messages: scrub(trace.messages),
        output: scrub(trace.output),
        ...(trace.error ? { error: text(trace.error) } : {}),
        metadata: {
          ...Object.fromEntries(
            Object.entries(trace.metadata).flatMap(([key, value]) =>
              key === 'session_id' ? [] : [[key, identifiers.has(key) ? pseudonym(value) : value]],
            ),
          ),
          ...(thread ? { thread_id: thread } : {}),
        },
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
        conversations.clear();
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
      if (enabled && deliver) void send(trace, conversation(trace)).catch(() => {});
    },
  } satisfies ModelTraces & Record<string, unknown>;
}

export type ModelTraceGate = ReturnType<typeof createModelTraces>;
