import type { VaultActivityEntry, VaultActivityReason } from './contracts';

export const vaultReasons: Record<VaultActivityReason, string> = {
  owner: 'You requested it',
  asked: 'You asked',
  schedule: 'Schedule',
  always: 'Always for this site',
  allowed: 'You allowed it',
  revoked: 'You removed access',
  entered: 'You entered it',
  picked: 'You chose it',
  mailbox: 'From your email',
  readonly: 'Read-only work',
  background: 'Background work',
  injection: 'A page had instructions',
  unrequested: 'You didn’t mention it',
  rule: 'Your rule',
  payment: 'You approved',
  code_typed: 'You approved',
  said_yes: 'You approved',
};

function formatMoney(amount: { minor: number; currency: string }, locale?: string) {
  const format = new Intl.NumberFormat(locale, { style: 'currency', currency: amount.currency });
  return format.format(amount.minor / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
}

function site(origin: string) {
  try {
    return new URL(origin).host.replace(/^www\./, '');
  } catch {
    return 'Website';
  }
}

export function vaultActivityTitle(entry: VaultActivityEntry, locale?: string) {
  const where = site(entry.origin);
  const amount = entry.amount ? `${formatMoney(entry.amount, locale)} ` : '';
  const card = entry.itemKind === 'card';
  switch (entry.action) {
    case 'card':
      return `Submitted card for ${amount}at ${where}`;
    case 'uncertain':
      return `Result unknown at ${where}`;
    case 'permission':
      return card ? 'Changed payment permission' : `Changed access to ${where}`;
    case 'reveal':
      return card ? 'Revealed a saved card value' : `Revealed a saved value for ${where}`;
    case 'session':
      return `Opened a saved session on ${where}`;
    case 'code':
      return `Entered a code on ${where}`;
    case 'held':
      return card ? `Didn’t pay at ${where}` : `Didn’t sign in to ${where}`;
    case 'asked':
      return card ? `Asked to pay ${amount}at ${where}` : `Asked to sign in to ${where}`;
    default:
      return `Submitted a login to ${where}`;
  }
}
