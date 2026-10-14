import { EventEmitter } from 'node:events';
import type { Task } from '../shared/contracts.ts';

type DeltaEvent = {
  type: 'delta';
  ownerId: string;
  channel: string;
  threadId: string;
  turnId: string;
  text: string;
  streamId?: string;
  done?: boolean;
};
type TaskEvent = { type: 'task'; ownerId: string; threadId: string; task: Task };
export type ServerEvent = { type: 'refresh' } | DeltaEvent | TaskEvent;

export const events = new EventEmitter<{ event: [ServerEvent] }>();
events.setMaxListeners(50);
export function refresh() {
  events.emit('event', { type: 'refresh' });
}
export function delta(event: Omit<DeltaEvent, 'type'>) {
  events.emit('event', { type: 'delta', ...event });
}
export function taskChanged(event: Omit<TaskEvent, 'type'>) {
  events.emit('event', { type: 'task', ...event });
}
