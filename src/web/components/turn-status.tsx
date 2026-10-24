import { CircleCheck, CircleDashed, LoaderCircle, MessageCircle, CircleAlert } from './icons';
import type { TurnStatus } from '../../shared/contracts';

export const statusLabels: Record<TurnStatus, string> = {
  queued: 'Queued',
  running: 'Working',
  waiting: 'Needs your input',
  succeeded: 'Done',
  failed: 'Could not finish',
  cancelled: 'Stopped',
};

export function StatusIcon({ status }: { status: TurnStatus }) {
  if (status === 'running') return <LoaderCircle size={16} className="spin" aria-hidden="true" />;
  if (status === 'waiting') return <MessageCircle size={16} aria-hidden="true" />;
  if (status === 'succeeded') return <CircleCheck size={16} aria-hidden="true" />;
  if (status === 'failed') return <CircleAlert size={16} aria-hidden="true" />;
  return <CircleDashed size={16} aria-hidden="true" />;
}
