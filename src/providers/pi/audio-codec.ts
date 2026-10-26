import { fork, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export async function normalizeAgentAudio(
  bytes: Uint8Array,
  mimeType: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (!bytes.byteLength || bytes.byteLength > 25 * 1024 * 1024)
    throw new Error('Keep audio messages under 25 MB.');
  const mime = mimeType.split(';')[0].trim().toLowerCase();
  if (
    ![
      'audio/wav',
      'audio/x-wav',
      'audio/webm',
      'audio/mpeg',
      'audio/mp3',
      'audio/ogg',
      'audio/opus',
    ].includes(mime)
  )
    throw new Error('This audio format is not supported. Use WebM, Ogg, MP3 or WAV.');
  return new Promise((resolve, reject) => {
    let child: ChildProcess | undefined;
    let settled = false;
    const finish = (error?: Error, result?: Uint8Array) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child?.kill('SIGKILL');
      if (error) reject(error);
      else resolve(result!);
    };
    const failed = () =>
      finish(new Error('This audio recording could not be read. Try recording it again.'));
    const abort = () => finish(new DOMException('Audio decoding was cancelled.', 'AbortError'));
    const timer = setTimeout(
      () => finish(new Error('Audio decoding took too long. Try a shorter recording.')),
      30_000,
    );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    try {
      child = fork(fileURLToPath(new URL('./audio-codec-worker.ts', import.meta.url)), [], {
        cwd: tmpdir(),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced',
        execArgv: ['--import', import.meta.resolve('tsx'), '--max-old-space-size=256'],
        env: {
          ...Object.fromEntries(
            ['PATH', 'SystemRoot', 'TMPDIR', 'TMP', 'TEMP', 'LANG'].flatMap((name) =>
              process.env[name] === undefined ? [] : [[name, process.env[name]]],
            ),
          ),
          ELECTRON_RUN_AS_NODE: '1',
        },
      });
      child.once('error', failed);
      child.once('exit', failed);
      child.once('message', (raw: unknown) => {
        if (!raw || typeof raw !== 'object') return failed();
        const reply = raw as { bytes?: unknown; reason?: unknown };
        if (
          reply.bytes instanceof Uint8Array &&
          reply.bytes.byteLength > 44 &&
          reply.bytes.byteLength <= 44 + 16_000 * 300 * 2
        )
          return finish(undefined, reply.bytes);
        if (reply.reason === 'length')
          return finish(new Error('Keep audio messages under five minutes.'));
        if (reply.reason === 'silence')
          return finish(new Error('No sound was detected. Try recording again.'));
        failed();
      });
      child.send({ bytes, mimeType: mime }, (error) => {
        if (error) failed();
      });
    } catch {
      failed();
    }
  });
}
