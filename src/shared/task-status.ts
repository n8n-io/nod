import type { Task, TaskStatus } from './contracts.ts';

export const taskLabels: Record<TaskStatus, string> = {
  queued: 'Queued',
  failed: 'Failed',
  working: 'Working',
  needs_you: 'Needs you',
  waiting: 'Waiting',
  scheduled: 'Checking back',
  stalled: 'Stalled',
  done: 'Done',
  cancelled: 'Stopped',
};

export function taskHeadline(task: Task) {
  if (task.status === 'done' || task.status === 'cancelled') return task.result || task.now;
  if (task.status === 'needs_you') return task.question ?? 'Reply to continue this task.';
  if (task.status === 'failed') return 'This task failed. Reply to continue, or stop the task.';
  if (task.status === 'stalled') return 'Nothing is planned next. Tell Otto to continue or stop.';
  return task.now;
}

export function taskSummary(task: Task, detail = false) {
  const closed = task.status === 'done' || task.status === 'cancelled';
  const step = task.steps?.[task.stepIndex ?? 0];
  return [
    `${taskLabels[task.status]} · ${task.title}`,
    taskHeadline(task),
    detail ? `Done when: ${task.doneWhen}` : '',
    detail
      ? (task.steps
          ?.map(
            (text, index) =>
              `${index < (task.stepIndex ?? 0) || task.status === 'done' ? '✓' : index + 1} ${text}`,
          )
          .join('\n') ?? '')
      : !closed && step
        ? `Step ${(task.stepIndex ?? 0) + 1}/${task.steps!.length}: ${step}`
        : '',
    ...task.waitingFor.map((wait) => `Waiting on ${wait.who} · ${wait.via}`),
    task.nextCheck ? `Next check: ${task.nextCheck}` : '',
    !closed && (task.revision ?? 0) > (task.appliedRevision ?? 0) ? 'Owner update queued' : '',
  ]
    .filter(Boolean)
    .join('\n');
}
