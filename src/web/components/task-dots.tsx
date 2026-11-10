import type { CSSProperties } from 'react';
import type { Task } from '../../shared/contracts';
import { Tooltip } from './tooltip';

export function TaskDots({ tasks }: { tasks: Task[] }) {
  const open = tasks.filter(
    (task) => (task.status === 'working' || task.status === 'needs_you') && task.messageId,
  );
  if (!open.length) return null;
  return (
    <nav className="task-pips" aria-label="Open tasks">
      {open.map((task, index) => (
        <Tooltip key={task.id} side="top" content={task.title}>
          <button
            type="button"
            className="task-pip"
            data-status={task.status}
            aria-label={
              task.status === 'needs_you' ? `${task.title} needs you` : `Show ${task.title}`
            }
            style={{ '--dot-delay': `${index * -0.6}s` } as CSSProperties}
            onClick={() => {
              const cardOpened = !window.dispatchEvent(
                new CustomEvent('nod:open-task', { detail: { taskId: task.id }, cancelable: true }),
              );
              if (!cardOpened)
                window.dispatchEvent(
                  new CustomEvent('nod:focus-message', {
                    detail: { messageId: task.messageId, taskId: task.id },
                  }),
                );
            }}
          />
        </Tooltip>
      ))}
    </nav>
  );
}
