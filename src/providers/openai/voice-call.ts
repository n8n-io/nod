import { randomUUID } from 'node:crypto';
import type { ProviderUsageEvent } from '../../ports/provider-usage.ts';
import type { VoiceCallEvent, VoiceCallProvider } from '../../ports/voice-call.ts';
import type { OpenAIRegion } from '../../shared/models.ts';
import { openAIBaseUrl, openAIRequestError } from './api.ts';

type Connection = { key: string; region?: OpenAIRegion };
type Socket = Pick<WebSocket, 'send' | 'close' | 'addEventListener' | 'readyState'>;

export const liveVoices = ['marin', 'cedar', 'quartz', 'ripple', 'vesper', 'willow', 'stone'];

function attach(url: string, key: string): Socket {
  return new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } } as never);
}

export function createOpenAIVoiceCallProvider(options: {
  connection: () => Promise<Connection | undefined>;
  configured: () => boolean;
  model?: string;
  fetch?: typeof fetch;
  socket?: (url: string, key: string) => Socket;
}): VoiceCallProvider {
  const model = options.model || 'gpt-live-1.1';
  return {
    id: 'openai',
    get configured() {
      return options.configured();
    },
    voices: liveVoices,
    async start({ sdp, instructions, greeting, voice, signal }, report) {
      const connection = await options.connection();
      if (!connection?.key) throw new Error('Voice calls need an OpenAI API key.');
      const base = openAIBaseUrl(connection.region);
      const response = await (options.fetch ?? fetch)(`${base}/live/sessions`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { Authorization: `Bearer ${connection.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: {
            model,
            instructions,
            audio: { output: { voice: voice && liveVoices.includes(voice) ? voice : 'marin' } },
            delegation: { type: 'client' },
            ...(greeting && {
              input: [
                {
                  type: 'message',
                  role: 'developer',
                  content: [{ type: 'input_text', text: greeting }],
                },
              ],
            }),
          },
          transport: { type: 'webrtc', sdp },
        }),
      });
      if (!response.ok) throw await openAIRequestError(response, connection.key);
      const created = (await response.json()) as {
        session?: { id?: unknown };
        transport?: { sdp?: unknown };
      };
      const id = created.session?.id;
      const answer = created.transport?.sdp;
      if (typeof id !== 'string' || !/^[\w-]{1,200}$/.test(id) || typeof answer !== 'string')
        throw new Error('OpenAI returned a voice session without a session ID or SDP answer.');
      const started = Date.now();
      const socket = (options.socket ?? attach)(
        `${base.replace(/^https:/, 'wss:')}/live/sessions/${id}/attach`,
        connection.key,
      );
      const queue: VoiceCallEvent[] = [];
      const waiting: Array<(result: IteratorResult<VoiceCallEvent>) => void> = [];
      const seen = new Set<string>();
      const outbox: string[] = [];
      let seconds = 0;
      let done = false;
      const push = (event: VoiceCallEvent) => {
        if (done) return;
        if (event.type === 'closed') {
          done = true;
          const usage: ProviderUsageEvent = {
            id: randomUUID(),
            provider: 'openai',
            category: 'agent',
            operation: 'voice_call',
            model,
            status: 'succeeded',
            durationMs: Math.round(seconds * 1000) || Date.now() - started,
            costUsd: null,
            pricing: 'unavailable',
          };
          report?.(usage);
        }
        const next = waiting.shift();
        if (next) next({ value: event, done: false });
        else queue.push(event);
        if (done)
          for (const resolve of waiting.splice(0)) resolve({ value: undefined, done: true });
      };
      const send = (event: Record<string, unknown>) => {
        const text = JSON.stringify({ event_id: randomUUID(), ...event });
        if (socket.readyState === 1) socket.send(text);
        else outbox.push(text);
      };
      socket.addEventListener('open', () => {
        for (const text of outbox.splice(0)) socket.send(text);
      });
      socket.addEventListener('message', (message) => {
        let event: Record<string, any>;
        try {
          event = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (typeof event.event_id === 'string') {
          if (seen.has(event.event_id)) return;
          seen.add(event.event_id);
        }
        if (typeof event.usage?.seconds === 'number') seconds = event.usage.seconds;
        if (event.type === 'session.input_transcript.delta' && typeof event.delta === 'string')
          push({
            type: 'heard',
            text: event.delta,
            startMs: Number(event.start_ms) || 0,
            endMs: Number(event.end_ms) || 0,
          });
        else if (
          event.type === 'session.delegation.created' &&
          typeof event.delegation?.id === 'string'
        )
          push({ type: 'handoff', id: event.delegation.id, atMs: Number(event.offset_ms) || 0 });
        else if (event.type === 'error')
          push({
            type: 'error',
            error: new Error(
              `OpenAI voice session error${event.error?.code ? ` ${event.error.code}` : ''}: ${String(event.error?.message ?? 'no reason given').slice(0, 500)}`,
            ),
          });
        else if (event.type === 'session.closed')
          push({ type: 'closed', reason: String(event.reason ?? 'closed').slice(0, 100) });
      });
      socket.addEventListener('close', () => push({ type: 'closed', reason: 'disconnected' }));
      socket.addEventListener('error', () =>
        push({ type: 'error', error: new Error('The OpenAI voice session connection failed.') }),
      );
      return {
        id,
        sdp: answer,
        events: {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              queue.length
                ? Promise.resolve({ value: queue.shift()!, done: false })
                : done
                  ? Promise.resolve({ value: undefined, done: true })
                  : new Promise((resolve) => waiting.push(resolve)),
          }),
        },
        say(content, handoffId) {
          if (done) return;
          send(
            handoffId
              ? { type: 'session.commentary.append', delegation_id: handoffId, content }
              : { type: 'session.instructions.append', delegation_id: null, content },
          );
        },
        async close() {
          if (done) return;
          send({ type: 'session.close' });
          setTimeout(() => socket.close(), 2000).unref();
        },
      };
    },
  };
}
