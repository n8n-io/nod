import { z } from 'zod';
import { approvalTitle } from './action-presentation.ts';

export interface ActionHistoryEvent {
  at: string;
  type: 'proposal' | 'read' | 'effect';
  action: string;
  kind: 'app' | 'browser' | 'sign_in' | 'files' | 'memory' | 'settings';
  app: string | null;
  account: string | null;
  work: 'chat' | 'task' | 'schedule' | 'event' | 'check' | 'resume' | 'other';
  task: string | null;
  approval: string | null;
  policy:
    | 'asked'
    | 'read'
    | 'owner_message'
    | 'schedule'
    | 'notification_rule'
    | 'owner_rule'
    | 'approved'
    | 'unknown';
  outcome: 'waiting' | 'approved' | 'running' | 'ran' | 'declined' | 'not_run' | 'uncertain';
}

export interface ActionHistoryRow {
  type: 'proposal' | 'ran';
  at: Date;
  action: unknown;
  account: unknown;
  source: unknown;
  proactive: unknown;
  task: unknown;
  approval: unknown;
  basis: unknown;
  status: unknown;
}

const uuid = (value: unknown) =>
  typeof value === 'string' && z.uuid().safeParse(value).success ? value.toLowerCase() : null;

const actionName = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : 'unknown';

function kindOf(action: string): ActionHistoryEvent['kind'] {
  if (action === 'NOD_browser') return 'browser';
  if (action === 'NOD_vault_allow') return 'sign_in';
  if (action === 'NOD_read_source') return 'app';
  if (action.startsWith('LOCAL_FILES_')) return 'files';
  if (action.startsWith('NOD_memory_')) return 'memory';
  if (action.startsWith('NOD_')) return 'settings';
  return 'app';
}

const works: Record<string, ActionHistoryEvent['work']> = {
  user: 'chat',
  task: 'task',
  schedule: 'schedule',
  event: 'event',
  resume: 'resume',
};

const policies: Record<string, ActionHistoryEvent['policy']> = {
  read: 'read',
  message: 'owner_message',
  schedule: 'schedule',
  standing: 'notification_rule',
  rule: 'owner_rule',
  approved: 'approved',
};

const outcomes: Record<string, ActionHistoryEvent['outcome']> = {
  pending: 'waiting',
  confirmed: 'approved',
  executing: 'running',
  completed: 'ran',
  declined: 'declined',
  expired: 'not_run',
  uncertain: 'uncertain',
};

export function actionHistoryEvent(row: ActionHistoryRow): ActionHistoryEvent {
  const action = actionName(row.action);
  const basis =
    row.basis && typeof row.basis === 'object' ? (row.basis as { kind?: unknown }).kind : undefined;
  const policy =
    row.type === 'proposal' ? 'asked' : (policies[String(basis)] ?? ('unknown' as const));
  return {
    at: row.at.toISOString(),
    type: row.type === 'proposal' ? 'proposal' : policy === 'read' ? 'read' : 'effect',
    action,
    kind: kindOf(action),
    app: (action !== 'unknown' && approvalTitle(action).app) || null,
    account: uuid(row.account),
    work:
      row.source === 'event' && row.proactive === true
        ? 'check'
        : (works[String(row.source)] ?? 'other'),
    task: uuid(row.task),
    approval: uuid(row.approval),
    policy,
    outcome:
      row.type === 'proposal' ? (outcomes[String(row.status)] ?? 'uncertain') : ('ran' as const),
  };
}

export function actionHistoryFileName(exported: Date) {
  return `nod-action-history-${exported.toISOString().slice(0, 10)}.json`;
}
