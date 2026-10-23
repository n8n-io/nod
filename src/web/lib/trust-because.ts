import type { TrustBecause } from '../../shared/trust';

export function becauseText(reason: TrustBecause) {
  const quote = reason.text ? `“${reason.text}”` : '';
  if (reason.kind === 'approved') return 'You approved it';
  if (reason.kind === 'message') return `You said ${quote}`;
  if (reason.kind === 'schedule') return `Your schedule says ${quote}`;
  if (reason.kind === 'standing') return `Your standing instruction says ${quote}`;
  return `Your rule says ${quote}`;
}
