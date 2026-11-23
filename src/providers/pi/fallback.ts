import {
  clampThinkingLevel,
  createAssistantMessageEventStream,
  isContextOverflow,
  isRetryableAssistantError,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { estimateTokens } from '@earendil-works/pi-coding-agent';
import type { ModelAccess } from '../../ports/models.ts';
import type { createPiModelRuntime } from './models.ts';
import { hasNativeAudio, readsNativeAudio } from './audio.ts';

type Connection = Awaited<ReturnType<typeof createPiModelRuntime>>;
type Stream = Connection['runtime']['streamSimple'];

export function modelKey(access: ModelAccess) {
  return `${access.connectionId ?? access.provider}/${access.method}/${access.definition.choice.id}`;
}

function fits(choice: ModelAccess['definition']['choice'], context: Context) {
  const images = context.messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((part) => part.type === 'image'),
  );
  if (images && !choice.images) return false;
  const tokens =
    context.messages.reduce((total, message) => total + estimateTokens(message as never), 0) +
    (context.systemPrompt?.length ?? 0) / 4;
  return !choice.contextWindow || tokens < choice.contextWindow * 0.9;
}

function failedRequest(
  model: Pick<Model<Api>, 'api' | 'provider' | 'id'>,
  error: unknown,
  aborted: boolean,
): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

export function failedBeforeAnswer(message: AssistantMessage, phase: string | undefined) {
  return (
    message.stopReason === 'error' && (isRetryableAssistantError(message) || phase !== 'stream')
  );
}

export function createTurnFallback(options: {
  primary: { access: ModelAccess; connection: Connection; stream: Stream };
  backups: ModelAccess[];
  start: number;
  automatic: boolean;
  connect(access: ModelAccess): Promise<Connection>;
  retrying(): boolean;
  shared(): number;
  switched(at: number): void;
  moved(from: number, to: number): void;
  failed(message: AssistantMessage): void;
}) {
  const candidates: Array<{ access: ModelAccess; connection?: Promise<Connection> }> = [
    { access: options.primary.access, connection: Promise.resolve(options.primary.connection) },
    ...options.backups.map((access) => ({ access })),
  ];
  const ready = new Map<number, Connection>([[0, options.primary.connection]]);
  const ranOn = new WeakMap<object, Model<Api>>();
  const tried: string[] = [];
  let at = Math.min(options.start, candidates.length - 1);
  let serving = 0;

  function move(next: number) {
    at = next;
    options.switched(at);
  }

  async function open(
    index: number,
    target: Model<Api>,
    context: Context,
    streamOptions: SimpleStreamOptions | undefined,
  ) {
    if (index === 0)
      return {
        connection: options.primary.connection,
        model: target,
        upstream: options.primary.stream(target, context, streamOptions),
      };
    const candidate = candidates[index]!;
    const { choice } = candidate.access.definition;
    if (!fits(choice, context))
      throw new Error(`${choice.name} can't take this conversation, so Nod didn't try it.`);
    candidate.connection ??= options.connect(candidate.access);
    const connection = await candidate.connection;
    ready.set(index, connection);
    if (options.automatic) await candidate.access.prepareRequest?.(connection.model.id, true);
    const { apiKey: _, headers: __, env: ___, ...rest } = streamOptions ?? {};
    const level = clampThinkingLevel(connection.model, candidate.access.effort);
    return {
      connection,
      model: connection.model,
      upstream: connection.runtime.streamSimple(connection.model, context, {
        ...rest,
        reasoning: level === 'off' ? undefined : level,
      } as SimpleStreamOptions),
    };
  }

  const movesOn = (message: AssistantMessage, index: number, connection: Connection) =>
    failedBeforeAnswer(message, connection.requestFacts?.(message)?.requestPhase) &&
    (index > 0 || !isContextOverflow(message, connection.model.contextWindow ?? 0)) &&
    (!isRetryableAssistantError(message) || !options.retrying());

  return {
    stream(target: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions) {
      if (
        (streamOptions?.maxTokens === 1 && streamOptions.maxRetries === 0) ||
        target.api === 'pi-virtual' ||
        (readsNativeAudio(target) && hasNativeAudio(context))
      )
        return options.primary.stream(target, context, streamOptions);
      const out = createAssistantMessageEventStream();
      const stopped = () => Boolean(streamOptions?.signal?.aborted);
      void (async () => {
        at = Math.max(at, Math.min(options.shared(), candidates.length - 1));
        for (;;) {
          const index = at;
          const { access } = candidates[index]!;
          const last = index + 1 >= candidates.length;
          let sent = false;
          let reason: string;
          try {
            const opened = await open(index, target, context, streamOptions);
            const { model } = opened;
            const held: AssistantMessageEvent[] = [];
            let failure: AssistantMessage | undefined;
            for await (const event of opened.upstream) {
              if (!sent && event.type === 'start') {
                held.push(event);
                continue;
              }
              if (
                !sent &&
                !last &&
                event.type === 'error' &&
                !stopped() &&
                movesOn(event.error, index, opened.connection)
              ) {
                failure = event.error;
                break;
              }
              if (!sent && event.type !== 'error' && index !== serving) {
                options.moved(serving, index);
                serving = index;
              }
              if (!sent) for (const item of held.splice(0)) out.push(item);
              sent = true;
              out.push(event);
            }
            if (!failure) {
              const result = await opened.upstream.result();
              ranOn.set(result, model);
              if (result.stopReason !== 'error' && result.stopReason !== 'aborted')
                tried.length = 0;
              out.end(result);
              return;
            }
            ranOn.set(failure, model);
            options.failed(failure);
            reason = failure.errorMessage?.trim() || 'The provider gave no reason.';
          } catch (error) {
            if (stopped() || last || sent) {
              const result = failedRequest(
                index
                  ? { api: target.api, provider: access.provider, id: access.definition.choice.id }
                  : target,
                error,
                stopped(),
              );
              out.push({
                type: 'error',
                reason: result.stopReason === 'aborted' ? 'aborted' : 'error',
                error: result,
              });
              out.end(result);
              return;
            }
            reason = error instanceof Error ? error.message : String(error);
          }
          tried.push(`${access.provider} / ${access.definition.choice.id}: ${reason}`);
          move(index + 1);
        }
      })();
      return out;
    },
    describe(message: AssistantMessage) {
      if (message.stopReason !== 'error' || !tried.length) return undefined;
      return [
        ...tried,
        `${message.provider} / ${message.model}: ${message.errorMessage?.trim() || 'The provider gave no reason.'}`,
      ].join('; then ');
    },
    method(provider: string, model: string) {
      const index = [at, ...candidates.keys()].find((index) => {
        const { access } = candidates[index]!;
        return (
          access.provider === provider &&
          [access.definition.choice.id, access.textModel?.definition.choice.id].includes(model)
        );
      });
      return candidates[index ?? at]!.access.method;
    },
    model(usage: { provider: string; model: string }) {
      const exact = ranOn.get(usage);
      if (exact) return exact;
      for (const connection of [ready.get(at), ...ready.values()]) {
        const found =
          connection?.model.provider === usage.provider && connection.model.id === usage.model
            ? connection.model
            : connection?.runtime.getModel(usage.provider, usage.model);
        if (found) return found;
      }
      return undefined;
    },
    current: () => candidates[at]!.access.definition.choice.name,
    switched: () => at > 0,
  };
}
