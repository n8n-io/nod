import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { CommandProcess } from '../command-process.ts';
import type { E2BAllocation } from './allocation.ts';
import type { E2BCommand, E2BCommandRole } from './client.ts';

export function launchE2BCommand(
  allocation: E2BAllocation,
  role: E2BCommandRole,
  command: string,
): CommandProcess {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let handle: E2BCommand | undefined;
  let closed = false;
  let removeFence = () => {};
  let release = () => {};
  let resolveReady!: (value: E2BCommand) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<E2BCommand>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const error = () => new Error('The remote computer connection did not finish safely.');
  function stop() {
    if (handle) {
      void handle.closeStdin().catch(() => {});
      void handle.disconnect().catch(() => {});
    }
  }
  function fail() {
    if (closed) return;
    closed = true;
    removeFence();
    allocation.fence();
    release();
    stop();
    stdout.end();
    stderr.end();
    events.emit('error', error());
  }
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      void ready
        .then(async (value) => {
          if (closed) throw error();
          await value.sendStdin(chunk);
        })
        .then(
          () => callback(),
          () => {
            callback(error());
            fail();
          },
        );
    },
  });
  function output(stream: PassThrough, value: string) {
    if (closed) return;
    stream.write(value);
    if (stream.writableLength + stream.readableLength > 32 * 1024 * 1024) fail();
  }
  queueMicrotask(() => {
    removeFence = allocation.onFence(fail);
    void allocation
      .acquire()
      .then(async (acquired) => {
        release = acquired.release;
        const sandbox = acquired.sandbox;
        if (closed) {
          release();
          throw error();
        }
        const value = await sandbox.start({
          role,
          command,
          stdout: (data) => output(stdout, data),
          stderr: (data) => output(stderr, data),
        });
        handle = value;
        if (closed) {
          release();
          stop();
          throw error();
        }
        resolveReady(value);
      })
      .catch(() => {
        rejectReady(error());
        fail();
      });
    void ready
      .then(async (value) => {
        const result = await value.wait();
        if (closed) return;
        closed = true;
        removeFence();
        release();
        stdout.end();
        stderr.end();
        events.emit('close', result.exitCode);
      })
      .catch(fail);
  });
  return Object.assign(events, {
    stdin,
    stdout,
    stderr,
    kill() {
      allocation.fence();
      fail();
      return true;
    },
  });
}
