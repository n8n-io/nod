import type { Task, TaskStatus } from './contracts';

export const taskLabels: Record<TaskStatus, string> = {
  queued: 'Queued',
  working: 'Working',
  needs_you: 'Needs you',
  waiting: 'Waiting',
  done: 'Done',
  stopped: 'Stopped',
  failed: 'Failed',
};
export const openTaskOrder: TaskStatus[] = ['needs_you', 'working', 'waiting', 'queued'];
export const isOpenTask = (task: Task) => openTaskOrder.includes(task.status);

function plain(text: string) {
  const line =
    text.split('\n').find((value) => value.trim() && !/^\s*\[[^\]]+\]:\s/.test(value)) ?? '';
  return line
    .replace(/!?\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g, '$1')
    .replace(/[*_`#>~]/g, '')
    .trim();
}

function minutes(task: Task) {
  const end = Date.parse(task.closedAt ?? task.updatedAt);
  return Math.max(1, Math.round((end - Date.parse(task.createdAt)) / 60_000));
}

export function taskSummary(task: Task) {
  if (task.status === 'needs_you') return plain(task.question ?? '') || 'Waiting for your answer';
  if (task.status === 'queued') return 'Starts when another task finishes';
  if (task.status === 'done') return `Finished in ${minutes(task)} min`;
  if (task.status === 'stopped') return `Stopped after ${minutes(task)} min`;
  if (task.status === 'failed')
    return plain(task.error ?? '') || `Failed after ${minutes(task)} min`;
  if (task.status === 'waiting' && !task.now && task.waitingFor.length)
    return `Waiting on ${task.waitingFor.map((wait) => wait.who).join(', ')}`;
  return task.now || task.steps[task.stepIndex] || '';
}

export function completedSteps(task: Task) {
  return task.status === 'done' ? task.steps.length : Math.min(task.stepIndex, task.steps.length);
}
