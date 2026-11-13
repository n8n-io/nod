import type { Task, TaskStatus } from './contracts.ts';

export const taskLabels: Record<TaskStatus, string> = {
  queued: 'Queued',
  failed: 'Failed',
  working: 'Working',
  needs_you: 'Needs you',
  waiting: 'Waiting',
  scheduled: 'Checking back',
  done: 'Done',
  cancelled: 'Stopped',
};

export function taskHeadline(task: Task) {
  if (task.status === 'done' || task.status === 'cancelled') return task.result || task.now;
  if (task.status === 'needs_you') return task.question ?? 'Reply to continue this task.';
  if (task.status === 'failed') return 'This task failed. Reply to continue, or stop the task.';
  return task.now;
}

export type TaskNext = 'open_browser' | 'answer' | 'reply';

export const taskNextLabels: Record<TaskNext, string> = {
  open_browser: 'Open the browser, then select Return to Nod',
  answer: 'Answer its question',
  reply: 'Reply to continue',
};

export function taskNext(task: Pick<Task, 'status' | 'question' | 'browserHandoff'>) {
  if (task.status === 'failed') return 'reply' as const;
  if (task.status !== 'needs_you') return null;
  if (task.browserHandoff) return 'open_browser' as const;
  return task.question ? ('answer' as const) : ('reply' as const);
}
