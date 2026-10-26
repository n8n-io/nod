import { randomUUID } from 'node:crypto';
import type { Context, Usage, UserMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI, SessionManager } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import type { AgentAudioInput, AgentImage, AgentSessionOptions } from '../../ports/agent.ts';
import { normalizeAgentAudio } from './audio-codec.ts';

const customType = 'nod-audio-input';
const filesKey = Symbol('native audio');
const detailsSchema = z.object({
  id: z.uuid(),
  files: z.array(z.object({ id: z.uuid(), mimeType: z.string().startsWith('audio/') })).min(1),
  fallback: z.string(),
  recordedAt: z.number().int().nonnegative().optional(),
});
type Details = z.infer<typeof detailsSchema>;
type AudioMessage = UserMessage & { [filesKey]?: Details['files'] };
const missingAudio =
  'This recording could not be sent to the model. Send it again or choose a text-only model.';

export function readsNativeAudio(model: { provider: string; id: string; api: string }) {
  return (
    model.provider === 'openai' &&
    model.id === 'gpt-audio-1.5' &&
    model.api === 'openai-completions'
  );
}

export function audioMessage(text: string, images: AgentImage[], audio: AgentAudioInput) {
  const details = detailsSchema.parse({ id: randomUUID(), recordedAt: Date.now(), ...audio });
  return {
    customType,
    content: [{ type: 'text' as const, text }, ...images],
    display: false,
    details,
  };
}

function details(message: { role: string; customType?: string; details?: unknown }) {
  return message.role === 'custom' && message.customType === customType
    ? detailsSchema.safeParse(message.details).data
    : undefined;
}

export function audioEntries(manager: SessionManager) {
  const branch = manager.getBranch();
  const edited = new Set(
    branch.flatMap((entry) => (entry.type === 'context_edit' ? [entry.targetId] : [])),
  );
  return branch.flatMap((entry) => {
    if (entry.type !== 'custom_message' || entry.customType !== customType || edited.has(entry.id))
      return [];
    const value = detailsSchema.safeParse(entry.details).data;
    return value
      ? [
          {
            ...entry,
            details: {
              ...value,
              recordedAt: value.recordedAt ?? new Date(entry.timestamp).getTime(),
            },
          },
        ]
      : [];
  });
}

export function audioContext(manager: SessionManager, native: boolean) {
  return (pi: ExtensionAPI) => {
    pi.on('context', ({ messages }) => {
      const entries = audioEntries(manager);
      const active = new Set(entries.map((entry) => entry.id));
      const replaced = new Set(
        manager.getBranch().flatMap((entry) => {
          if (
            entry.type !== 'custom_message' ||
            entry.customType !== customType ||
            active.has(entry.id)
          )
            return [];
          const value = detailsSchema.safeParse(entry.details).data;
          return value ? [value.id] : [];
        }),
      );
      messages = messages.map((message) => {
        const value = details(message);
        return value && replaced.has(value.id) && message.role === 'custom'
          ? { role: 'user', content: message.content, timestamp: message.timestamp }
          : message;
      });
      const historical = entries.map((entry) => ({
        role: 'custom' as const,
        customType,
        content: entry.content,
        display: false,
        timestamp: entry.details.recordedAt,
        details: entry.details,
      }));
      const candidates = new Map(historical.map((message) => [message.details.id, message]));
      for (const message of messages) {
        const value = details(message);
        if (value)
          candidates.set(value.id, {
            role: 'custom',
            customType,
            content: message.role === 'custom' ? message.content : '',
            display: false,
            timestamp: value.recordedAt ?? message.timestamp,
            details: { ...value, recordedAt: value.recordedAt ?? message.timestamp },
          });
      }
      const lastAnswer = messages.findLastIndex((message) => message.role === 'assistant');
      const pending = messages.slice(lastAnswer + 1).flatMap((message) => {
        const value = details(message);
        return value ? [value.id] : [];
      });
      const retained = new Set([...candidates.keys()].slice(-2).concat(pending));
      const visible = new Set(
        messages.flatMap((message) => {
          const value = details(message);
          return value ? [value.id] : [];
        }),
      );
      const restored = native
        ? [...candidates.values()]
            .filter(
              (message) => retained.has(message.details.id) && !visible.has(message.details.id),
            )
            .map((message) => ({
              ...message,
              content: `Earlier recording from ${new Date(message.timestamp).toISOString()}. It is historical context, not a new request.\n${
                typeof message.content === 'string'
                  ? message.content
                  : message.content
                      .filter((part) => part.type === 'text')
                      .map((part) => part.text)
                      .join('\n')
              }`,
            }))
        : [];
      return {
        messages: [...restored, ...messages].map((message) => {
          const value = details(message);
          if (!value) return message;
          const include = native && retained.has(value.id);
          const projected: AudioMessage = {
            role: 'user',
            timestamp: message.timestamp,
            content:
              include && message.role === 'custom'
                ? message.content
                : value.fallback +
                  (native
                    ? '\nEarlier audio is represented by its internal transcript; the original recording remains saved.'
                    : ''),
            ...(include ? { [filesKey]: value.files } : {}),
          };
          return projected;
        }),
      };
    });
    pi.on('session_before_compact', ({ preparation }) => {
      const fallback = (message: (typeof preparation.messagesToSummarize)[number]) => {
        const value = details(message);
        return value && message.role === 'custom'
          ? { ...message, content: value.fallback }
          : message;
      };
      preparation.messagesToSummarize = preparation.messagesToSummarize.map(fallback);
      preparation.turnPrefixMessages = preparation.turnPrefixMessages.map(fallback);
    });
  };
}

const wireSchema = z
  .object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() }).passthrough()) })
  .passthrough();

export function nativeAudioRequest(context: Context, read: AgentSessionOptions['readAudio']) {
  const bindings = new Map<string, Details['files']>();
  const transport: Context = {
    ...context,
    messages: context.messages.map((message) => {
      if (message.role !== 'user') return message;
      const files = (message as AudioMessage)[filesKey];
      if (!files) return message;
      const marker = `nod-audio-transport:${randomUUID()}`;
      bindings.set(marker, files);
      return {
        ...message,
        content: [
          ...(typeof message.content === 'string'
            ? [{ type: 'text' as const, text: message.content }]
            : message.content),
          { type: 'text' as const, text: marker },
        ],
      };
    }),
  };
  return {
    context: transport,
    active: bindings.size > 0,
    async payload(payload: unknown, signal: AbortSignal) {
      if (!bindings.size) return payload;
      if (!read) throw new Error(missingAudio);
      const parsed = wireSchema.safeParse(payload);
      if (!parsed.success) throw new Error(missingAudio);
      const body = parsed.data;
      let total = 0;
      for (const [marker, files] of bindings) {
        const matches = body.messages.flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.flatMap((part, index) =>
                part?.type === 'text' && part.text === marker ? [{ message, index }] : [],
              )
            : [],
        );
        if (matches.length !== 1 || matches[0].message.role !== 'user')
          throw new Error(missingAudio);
        const parts = [];
        for (const file of files) {
          signal.throwIfAborted();
          const bytes = await new Promise<Uint8Array>((resolve, reject) => {
            const cancel = () => reject(signal.reason);
            signal.addEventListener('abort', cancel, { once: true });
            Promise.resolve()
              .then(() => read(file, signal))
              .then(resolve, reject)
              .finally(() => signal.removeEventListener('abort', cancel));
          });
          signal.throwIfAborted();
          if (bytes.length > 25 * 1024 * 1024)
            throw new Error('The recording is too large. Send a shorter voice message.');
          const wav = await normalizeAgentAudio(bytes, file.mimeType, signal);
          total += wav.length;
          if (total > 20 * 1024 * 1024)
            throw new Error(
              'These recordings are too long to send together. Send a shorter voice message.',
            );
          parts.push({
            type: 'input_audio',
            input_audio: { data: Buffer.from(wav).toString('base64'), format: 'wav' },
          });
        }
        const { message, index } = matches[0];
        if (!Array.isArray(message.content)) throw new Error(missingAudio);
        message.content.splice(index, 1, ...parts);
      }
      signal.throwIfAborted();
      return { ...body, modalities: ['text'] };
    },
  };
}

export function audioUsage() {
  let input: number | undefined;
  let cached = 0;
  return {
    async response(response: Response) {
      if (!response.ok || !response.body) return response;
      const decoder = new TextDecoder();
      let pending = '';
      const stream = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(bytes, controller) {
            pending += decoder.decode(bytes, { stream: true });
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            if (pending.length > 1024 * 1024) pending = '';
            for (const line of lines)
              if (line.startsWith('data: ')) {
                try {
                  const usage = JSON.parse(line.slice(6)).usage;
                  const audio = usage?.prompt_tokens_details?.audio_tokens;
                  if (Number.isSafeInteger(audio) && audio >= 0) {
                    input = audio;
                    cached = usage.prompt_tokens_details.cached_tokens ?? 0;
                  }
                } catch {}
              }
            controller.enqueue(bytes);
          },
        }),
      );
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
    apply(usage: Usage) {
      if (input === undefined || input > usage.input || cached > 0) {
        Object.assign(usage, { audioPricing: 'unavailable' });
        return;
      }
      usage.cost.input = ((usage.input - input) * 2.5 + input * 32) / 1_000_000;
      usage.cost.total =
        usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
    },
  };
}
