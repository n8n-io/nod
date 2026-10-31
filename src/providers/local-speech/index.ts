import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  SpeechProviderError,
  type SpeechProvider,
  type LocalSpeechControls,
} from '../../ports/speech.ts';
import type { ProviderUsageEvent } from '../../ports/provider-usage.ts';
import { speechVoices } from '../../shared/speech.ts';
import { verifySpeechCache } from './cache.ts';

interface LocalSpeechStatus {
  state: 'not_downloaded' | 'downloading' | 'ready' | 'failed';
  progress?: number;
}

type Request =
  | { method: 'prepare'; transcription: boolean }
  | { method: 'synthesize'; text: string; voice: string }
  | { method: 'transcribe'; bytes: Uint8Array; mimeType: string };

type Reply =
  { type: 'ready' } | { type: 'audio'; bytes: Uint8Array } | { type: 'text'; text: string };
type Job = {
  id: number;
  request: Request;
  resolve(reply: Reply): void;
  reject(error: Error): void;
  cleanup(): void;
};
type Preparation = {
  transcription: boolean;
  promise: Promise<void>;
  controller: AbortController;
  callers: number;
};

export function createLocalSpeechProvider(options: {
  cacheDir: string;
  fork?: (path: string, args: string[], options: ForkOptions) => ChildProcess;
  idleMs?: number;
  requestMs?: number;
}): SpeechProvider & LocalSpeechControls {
  let status: LocalSpeechStatus = { state: 'not_downloaded' };
  let inputStatus: LocalSpeechStatus = { state: 'not_downloaded' };
  let child: ChildProcess | undefined;
  let active: Job | undefined;
  const queue: Job[] = [];
  let nextId = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let preparing: Preparation | undefined;
  let closed = false;
  const cached = (async () => {
    const ready = await verifySpeechCache(options.cacheDir);
    const inputReady = ready || (await verifySpeechCache(options.cacheDir, true, true));
    if (closed) return;
    if (ready && status.state === 'not_downloaded') status = { state: 'ready' };
    if (inputReady && inputStatus.state === 'not_downloaded') inputStatus = { state: 'ready' };
  })();

  function preparationStatus(transcription: boolean, value: LocalSpeechStatus) {
    if (transcription) inputStatus = value;
    else {
      status = value;
      if (inputStatus.state !== 'ready') inputStatus = value;
    }
  }
  const voices = speechVoices.filter((voice) => voice.engine === 'Local');

  function stop(error: Error) {
    const process = child;
    child = undefined;
    clearTimeout(idle);
    const jobs = [...(active ? [active] : []), ...queue.splice(0)];
    active = undefined;
    process?.kill('SIGKILL');
    for (const job of jobs) {
      job.cleanup();
      job.reject(error);
    }
    return process;
  }

  function advance() {
    if (active || closed) return;
    const job = queue.shift();
    if (!job) {
      idle = setTimeout(() => {
        stop(new SpeechProviderError('Local speech stopped.'));
      }, options.idleMs ?? 300_000);
      idle.unref();
      return;
    }
    clearTimeout(idle);
    active = job;
    if (!child) {
      const worker = (options.fork ?? fork)(
        fileURLToPath(new URL('./worker.ts', import.meta.url)),
        [options.cacheDir],
        {
          cwd: options.cacheDir,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          serialization: 'advanced',
          execArgv: ['--import', import.meta.resolve('tsx'), '--max-old-space-size=1536'],
          env: {
            ...Object.fromEntries(
              ['PATH', 'SystemRoot', 'TMPDIR', 'TMP', 'TEMP', 'LANG'].flatMap((name) =>
                process.env[name] === undefined ? [] : [[name, process.env[name]]],
              ),
            ),
            ELECTRON_RUN_AS_NODE: '1',
          },
        },
      );
      child = worker;
      const died = () => {
        if (child !== worker) return;
        const request = active?.request;
        preparationStatus(
          request?.method === 'transcribe' ||
            (request?.method === 'prepare' && request.transcription),
          { state: 'failed' },
        );
        stop(new SpeechProviderError('Local speech stopped. Try again.'));
      };
      worker.on('error', died);
      worker.on('exit', died);
      worker.on('message', (raw: unknown) => {
        if (child !== worker || !active || !raw || typeof raw !== 'object') return;
        const reply = raw as {
          id?: unknown;
          type?: unknown;
          progress?: unknown;
          reason?: unknown;
          bytes?: unknown;
          text?: unknown;
        };
        if (reply.id !== active.id) return;
        if (reply.type === 'progress' && active.request.method === 'prepare') {
          if (typeof reply.progress === 'number' && reply.progress >= 0 && reply.progress <= 100)
            preparationStatus(active.request.transcription, {
              state: 'downloading',
              progress: reply.progress,
            });
          return;
        }
        const finished = active;
        active = undefined;
        finished.cleanup();
        if (reply.type === 'ready' && finished.request.method === 'prepare')
          finished.resolve({ type: 'ready' });
        else if (
          reply.type === 'audio' &&
          finished.request.method === 'synthesize' &&
          reply.bytes instanceof Uint8Array &&
          reply.bytes.length > 44 &&
          reply.bytes.length <= 50 * 1024 * 1024
        )
          finished.resolve({ type: 'audio', bytes: reply.bytes });
        else if (
          reply.type === 'text' &&
          finished.request.method === 'transcribe' &&
          typeof reply.text === 'string' &&
          reply.text.trim() &&
          reply.text.length <= 100_000
        )
          finished.resolve({ type: 'text', text: reply.text });
        else
          finished.reject(
            new SpeechProviderError(
              reply.reason === 'silence'
                ? 'No speech was detected. Please record again.'
                : reply.reason === 'length'
                  ? 'Keep local voice messages under five minutes.'
                  : reply.reason === 'format'
                    ? 'Local speech supports WebM, Ogg, MP3 and WAV recordings.'
                    : 'Local speech failed. Try again.',
            ),
          );
        advance();
      });
    }
    child.send({ id: job.id, ...job.request }, (error) => {
      if (error && active === job)
        stop(new SpeechProviderError('Local speech stopped. Try again.'));
    });
  }

  function call(request: Request, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (closed) return Promise.reject(new SpeechProviderError('Local speech is closed.'));
    if (queue.length >= 4)
      return Promise.reject(new SpeechProviderError('Local speech is busy. Try again shortly.'));
    return new Promise<Reply>((resolve, reject) => {
      const job: Job = {
        id: ++nextId,
        request,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', abort);
        },
      };
      const abort = () => {
        const error = new DOMException('The speech request was cancelled.', 'AbortError');
        if (active === job) stop(error);
        else {
          const index = queue.indexOf(job);
          if (index >= 0) queue.splice(index, 1);
          job.cleanup();
          reject(error);
        }
      };
      const timeout = setTimeout(
        () => {
          if (active === job)
            stop(new SpeechProviderError('Local speech took too long. Try a shorter message.'));
          else {
            const index = queue.indexOf(job);
            if (index >= 0) queue.splice(index, 1);
            job.cleanup();
            reject(new SpeechProviderError('Local speech is busy. Try again shortly.'));
          }
        },
        request.method === 'prepare' ? 900_000 : (options.requestMs ?? 180_000),
      );
      signal?.addEventListener('abort', abort, { once: true });
      queue.push(job);
      try {
        advance();
      } catch {
        stop(new SpeechProviderError('Local speech could not start.'));
      }
    });
  }

  async function measured<T>(
    operation: string,
    report: ((usage: ProviderUsageEvent) => void) | undefined,
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
  ) {
    const started = Date.now();
    const usage: ProviderUsageEvent = {
      id: randomUUID(),
      provider: 'local',
      category: 'agent',
      operation,
      model: operation === 'synthesize' ? 'kokoro-82m' : 'whisper-base',
      status: 'failed',
      durationMs: 0,
      costUsd: 0,
      pricing: 'sdk_estimate',
    };
    try {
      const result = await run();
      signal?.throwIfAborted();
      usage.status = 'succeeded';
      return result;
    } finally {
      if (signal?.aborted) usage.status = 'cancelled';
      usage.durationMs = Date.now() - started;
      report?.(usage);
    }
  }

  function waitForPreparation(preparation: Preparation, signal?: AbortSignal) {
    preparation.callers++;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        preparation.callers--;
        if (error) reject(error);
        else resolve();
      };
      const abort = () => {
        finish(new DOMException('The speech request was cancelled.', 'AbortError'));
        if (!preparation.callers && preparing === preparation) {
          preparing = undefined;
          preparationStatus(preparation.transcription, { state: 'not_downloaded' });
          preparation.controller.abort();
        }
      };
      signal?.addEventListener('abort', abort, { once: true });
      preparation.promise.then(() => finish(), finish);
      if (signal?.aborted) abort();
    });
  }

  async function prepare(transcription: boolean, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await cached;
    signal?.throwIfAborted();
    if (closed) throw new SpeechProviderError('Local speech is closed.');
    if ((transcription ? inputStatus : status).state === 'ready') return;
    if (preparing) {
      const running = preparing;
      try {
        await waitForPreparation(running, signal);
      } catch (error) {
        if (running.transcription === transcription) throw error;
        signal?.throwIfAborted();
      }
      return prepare(transcription, signal);
    }
    preparationStatus(transcription, { state: 'downloading', progress: 0 });
    const preparation: Preparation = {
      transcription,
      controller: new AbortController(),
      callers: 0,
      promise: Promise.resolve(),
    };
    preparing = preparation;
    preparation.promise = (async () => {
      try {
        await mkdir(options.cacheDir, { recursive: true });
        await call({ method: 'prepare', transcription }, preparation.controller.signal);
        if (preparing === preparation) preparationStatus(transcription, { state: 'ready' });
      } catch (error) {
        if (preparing === preparation)
          preparationStatus(transcription, {
            state: preparation.controller.signal.aborted ? 'not_downloaded' : 'failed',
          });
        throw error;
      } finally {
        if (preparing === preparation) preparing = undefined;
      }
    })();
    return waitForPreparation(preparation, signal);
  }

  return {
    id: 'local',
    voices,
    defaultVoice: 'local:af_heart',
    get configured() {
      return !closed && status.state === 'ready';
    },
    get transcriptionConfigured() {
      return !closed && inputStatus.state === 'ready';
    },
    status: () => ({ ...status }),
    prepare: (signal) => prepare(false, signal),
    prepareTranscription: (signal) => prepare(true, signal),
    transcriptionStatus: () => ({ ...inputStatus }),
    async synthesize(text, signal, report, synthesis) {
      signal?.throwIfAborted();
      if (status.state !== 'ready') throw new SpeechProviderError('Enable local speech first.');
      const voice = synthesis?.voice ?? 'local:af_heart';
      if (!voices.some((choice) => choice.id === voice))
        throw new SpeechProviderError('That voice is unavailable.');
      if (!text.trim() || text.length > 4096)
        throw new SpeechProviderError('The speech text is too long.');
      return measured('synthesize', report, signal, async () => {
        const reply = await call(
          { method: 'synthesize', text, voice: voice.split(':')[1] },
          signal,
        );
        if (reply.type !== 'audio') throw new SpeechProviderError('Local speech failed.');
        return { bytes: Buffer.from(reply.bytes), mimeType: 'audio/wav', fileName: 'reply.wav' };
      });
    },
    async transcribe(audio, signal, report) {
      signal?.throwIfAborted();
      if (inputStatus.state !== 'ready')
        throw new SpeechProviderError('Enable local speech first.');
      if (!audio.bytes.length || audio.bytes.length > 25 * 1024 * 1024)
        throw new SpeechProviderError('The recording is too large.');
      return measured('transcribe', report, signal, async () => {
        const reply = await call(
          { method: 'transcribe', bytes: audio.bytes, mimeType: audio.mimeType },
          signal,
        );
        if (reply.type !== 'text') throw new SpeechProviderError('Local transcription failed.');
        return reply.text;
      });
    },
    async close() {
      closed = true;
      const process = stop(new SpeechProviderError('Local speech is closed.'));
      if (process && process.exitCode === null && process.signalCode === null)
        await new Promise<void>((resolve) => {
          process.once('exit', () => resolve());
          setTimeout(resolve, 1000).unref();
        });
    },
  };
}
