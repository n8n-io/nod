import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { browserFrame, browserSocketPath } from './protocol.ts';

export function runBrowserBridge(options: {
  input: Readable;
  output: Writable;
  socketPath?: string;
  multiplex?: boolean;
}): Promise<number> {
  return new Promise((resolve) => {
    const socket = connect(options.socketPath ?? browserSocketPath);
    options.input.setEncoding('utf8');
    let input = '';
    let output = false;
    let requestId: string | undefined;
    let cancelled = false;
    let ended = false;
    let multiplex = false;
    let readySent = false;
    if (options.multiplex === true) {
      multiplex = true;
      socket.on('connect', () => {
        if (ended || readySent) return;
        readySent = true;
        socket.write(JSON.stringify({ type: 'multiplex' }) + '\n');
        options.output.write(JSON.stringify({ type: 'ready' }) + '\n');
      });
    }
    const finish = (code: number) => {
      if (ended) return;
      ended = true;
      options.input.removeListener('data', incoming);
      options.input.removeListener('end', inputEnded);
      options.input.removeListener('error', errored);
      options.input.removeListener('close', inputEnded);
      options.output.removeListener('error', errored);
      socket.destroy();
      resolve(code);
    };
    const inputEnded = () => finish(multiplex ? 0 : 1);
    const errored = () => finish(1);
    const incoming = (chunk: Buffer | string) => {
      input += chunk.toString();
      for (let line = input.indexOf('\n'); line >= 0; line = input.indexOf('\n')) {
        const raw = input.slice(0, line);
        input = input.slice(line + 1);
        try {
          const frame = browserFrame.parse(JSON.parse(raw));
          if (!multiplex) {
            if (frame.type === 'multiplex') return finish(1);
            if (frame.type === 'request') {
              if (requestId) return finish(1);
              requestId = frame.request.id;
            } else {
              if (!requestId || cancelled || frame.id !== requestId) return finish(1);
              if (frame.type === 'cancel') cancelled = true;
            }
          }
          if (!socket.write(JSON.stringify(frame) + '\n')) {
            options.input.pause();
            socket.once('drain', () => options.input.resume());
          }
        } catch {
          return finish(1);
        }
      }
    };
    socket.on('error', () => finish(1));
    socket.on('data', (chunk: Buffer) => {
      output = true;
      if (!options.output.write(chunk)) {
        socket.pause();
        options.output.once('drain', () => socket.resume());
      }
    });
    socket.on('end', () => finish(!multiplex && output ? 0 : 1));
    options.input.on('data', incoming);
    options.input.on('end', inputEnded);
    options.input.on('error', errored);
    options.input.on('close', inputEnded);
    options.output.on('error', errored);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runBrowserBridge({
    input: process.stdin,
    output: process.stdout,
    multiplex: process.argv.includes('--multiplex'),
  });
  process.stdin.destroy();
}
