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
