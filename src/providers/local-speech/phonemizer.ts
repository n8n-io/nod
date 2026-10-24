import { fork } from 'node:child_process';

export function phonemizeSpeech(
  text: string,
  voice: 'en-us' | 'en-gb' | 'es' | 'fr-fr' | 'hi' | 'it',
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
    for (const name of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG'])
      if (process.env[name]) env[name] = process.env[name];
    const child = fork(new URL('./phonemizer-worker.ts', import.meta.url), [], {
      env,
      execArgv: ['--import', import.meta.resolve('tsx'), '--max-old-space-size=128'],
      stdio: ['pipe', 'pipe', 'ignore', 'ipc'],
      serialization: 'json',
    });
    let finished = false;
    const timer = setTimeout(() => finish(), 15_000);
    const finish = (phonemes?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (phonemes) resolve(phonemes);
      else reject(new Error('phonemes'));
    };
    child.once('error', () => finish());
    let output = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 20_000) finish();
    });
    child.once('close', (code) => {
      try {
        const phonemes: unknown = code === 0 ? JSON.parse(output) : undefined;
        finish(typeof phonemes === 'string' ? phonemes : undefined);
      } catch {
        finish();
      }
    });
    child.stdin!.once('error', () => finish());
    child.stdin!.end(JSON.stringify({ text, voice }));
  });
}
