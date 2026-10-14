import { posix } from 'node:path';

export function threadIdentity(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('Invalid thread identifier.');
  return value;
}

export const taskFolder = (taskId: string) => posix.join('tasks', threadIdentity(taskId));

export const inFolder = (folder: string | undefined, path: string) =>
  folder && path && !posix.isAbsolute(path) ? posix.join(folder, path) : path;
