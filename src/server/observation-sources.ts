import type { PoolClient } from 'pg';
import type { CaptureAnalytics } from './analytics.ts';
import { connectionSources } from './app-reads.ts';
import type {
  ObservationBatch,
  ObservationProvider,
  ObservationQuery,
  ObservationSource,
} from '../ports/proactivity.ts';
import {
  createRedactor,
  createTextRedactor,
  redactSecretText,
  withoutSecretKeys,
} from './redaction.ts';
import { noMailCheck, privateEmailResult, type MailCheck } from './integration-result.ts';

type Provider = ObservationProvider & {
  sources(client?: PoolClient): Promise<ObservationSource[]>;
};

export function createObservationSources(
  providers: Provider[],
  options: { secrets?: string[]; check?: MailCheck; analytics?: CaptureAnalytics } = {},
) {
  const secrets = options.secrets ?? [];
  const redactText = createTextRedactor(secrets);
  const safeText = (value: string) => redactSecretText(redactText(value));
  function identifier(value: string) {
    if (safeText(value) !== value) throw new Error('A source returned a private identifier.');
    return value;
  }
  async function sanitize(batch: ObservationBatch, signal: AbortSignal) {
    if (!Array.isArray(batch.records) || batch.records.length > 20)
      throw new Error('The source returned an invalid observation batch.');
    const result = {
      ...batch,
      records: await Promise.all(
        batch.records.map(async (record) => {
          const deadline = new AbortController();
          const timer = setTimeout(
            () => deadline.abort(new Error('The source privacy check timed out.')),
            10000,
          );
          const stop = AbortSignal.any([signal, deadline.signal]);
          let onAbort = () => {};
          try {
            const aborted = new Promise<never>((_resolve, reject) => {
              onAbort = () => reject(stop.reason);
              stop.addEventListener('abort', onAbort, { once: true });
              if (stop.aborted) onAbort();
            });
            return await Promise.race([
              privateEmailResult(
                record,
                (mail, checkSignal) =>
                  (options.check ?? noMailCheck)(
                    mail.map((email) => ({
                      from: safeText(email.from),
                      subject: safeText(email.subject),
                      text: safeText(email.text),
                    })),
                    checkSignal,
                  ),
                stop,
              ) as Promise<ObservationBatch['records'][number]>,
              aborted,
            ]);
          } catch {
            signal.throwIfAborted();
            return {
              id: record.id,
              version: 'unknown',
              available: false,
              error: 'unavailable' as const,
              data: {},
            };
          } finally {
            clearTimeout(timer);
            stop.removeEventListener('abort', onAbort);
          }
        }),
      ),
    };
    const redact = createRedactor(secrets, {
      string: 64000,
      payload: Math.floor(100000 / Math.max(1, result.records.length)),
    });
    return {
      ...(result.nextCursor ? { nextCursor: identifier(result.nextCursor) } : {}),
      records: result.records.map(({ id, version, available, error, url, data }) => ({
        id: identifier(id),
        version: identifier(version),
        available,
        ...(error ? { error } : {}),
        ...(url && safeText(url) === url ? { url } : {}),
        data: redact(data) as Record<string, unknown>,
      })),
    };
  }
  if (providers.some((provider) => !/^[a-z0-9][a-z0-9_-]{0,49}$/.test(provider.id)))
    throw new Error('Use a short provider ID without a namespace separator.');
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  if (byId.size !== providers.length) throw new Error('Observation provider IDs must be unique.');
  async function sources(client?: PoolClient) {
    const groups = await Promise.all(
      providers.map(async (provider) =>
        (await provider.sources(client)).map((source) => {
          if (
            source.pollIntervalMs !== undefined &&
            (source.pollIntervalMs <= 0 ||
              !Number.isFinite(source.pollIntervalMs) ||
              !Number.isFinite(new Date(Date.now() + source.pollIntervalMs).getTime()))
          )
            throw new Error('A source returned an invalid check interval.');
          return {
            id: `${provider.id}:${identifier(source.id)}`,
            label: safeText(source.label),
            description: safeText(source.description),
            revision: identifier(source.revision),
            readable: source.readable === true,
            ...(source.mode ? { mode: source.mode } : {}),
            ...(source.tools ? { tools: true } : {}),
            ...(source.changeToken !== undefined
              ? { changeToken: identifier(source.changeToken) }
              : {}),
            ...(source.pollIntervalMs !== undefined
              ? { pollIntervalMs: source.pollIntervalMs }
              : {}),
          };
        }),
      ),
    );
    const all = groups.flat();
    if (new Set(all.map((source) => source.id)).size !== all.length)
      throw new Error('Observation source IDs must be unique.');
    return all;
  }
  async function read(input: ObservationQuery & { sourceId: string }, signal: AbortSignal) {
    signal.throwIfAborted();
    const started = performance.now();
    const providerId = input.sourceId.slice(0, input.sourceId.indexOf(':'));
    const source_type =
      providerId === connectionSources
        ? 'connected_app'
        : input.sourceId === 'work:tasks'
          ? 'tasks'
          : 'other';
    const capture = (outcome: 'succeeded' | 'failed' | 'cancelled', result?: ObservationBatch) =>
      options.analytics?.({
        event: 'source_read',
        properties: {
          source_type,
          operation: input.query ? 'discovery' : 'records',
          outcome,
          duration_ms: Math.max(0, Math.round(performance.now() - started)),
          ...(result
            ? {
                record_count: result.records.length,
                unavailable_count: result.records.filter((record) => !record.available).length,
              }
            : {}),
        },
      });
    let rejectAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(signal.reason ?? new Error('The source read stopped.'));
      signal.addEventListener('abort', rejectAbort, { once: true });
      if (signal.aborted) rejectAbort();
    });
    try {
      const result = await Promise.race([
        (async () => {
          const source = (await sources()).find(
            (source) => source.id === input.sourceId && source.readable,
          );
          if (!source) throw new Error('This source is unavailable.');
          if (input.revision !== undefined && input.revision !== source.revision)
            throw Object.assign(new Error('The source changed before its read.'), { notRun: true });
          const separator = input.sourceId.indexOf(':');
          const provider = byId.get(input.sourceId.slice(0, separator));
          if (!provider) throw new Error('This source provider is unavailable.');
          const { sourceId: _, ...query } = input;
          signal.throwIfAborted();
          const batch = await provider.read(
            input.sourceId.slice(separator + 1),
            { ...query, revision: source.revision },
            signal,
          );
          signal.throwIfAborted();
          const result = await sanitize(withoutSecretKeys(batch) as ObservationBatch, signal);
          signal.throwIfAborted();
          if (
            !(await sources()).some(
              (current) =>
                current.id === source.id &&
                current.readable &&
                current.revision === source.revision,
            )
          )
            throw new Error('The source changed during its read.');
          signal.throwIfAborted();
          return { ...result, checkedAt: new Date().toISOString() };
        })(),
        aborted,
      ]);
      capture('succeeded', result);
      return result;
    } catch (error) {
      capture(signal.aborted ? 'cancelled' : 'failed');
      throw error;
    } finally {
      signal.removeEventListener('abort', rejectAbort);
    }
  }
  return { sources, read };
}
