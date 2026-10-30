import type { Connection } from './contracts.ts';

export const onboardingSteps = ['welcome', 'email', 'brain', 'privacy'] as const;
export const onboardingEmailProviders = ['gmail', 'outlook'] as const;
export const onboardingCalendarProviders = ['googlecalendar', 'outlook'] as const;
export const onboardingVersion = 3;
export type OnboardingStep = (typeof onboardingSteps)[number];
export function connectedGmail(connection: Connection) {
  return (
    connection.slug === 'gmail' &&
    connection.status === 'connected' &&
    Boolean(connection.connectionId && connection.accountId) &&
    !connection.disconnectPending
  );
}
export function reconnectable(connection: Connection) {
  return (
    Boolean(connection.connectionId && connection.accountId) &&
    !connection.disconnectPending &&
    Boolean(connection.canReconnect) &&
    (connection.status === 'disconnected' || Boolean(connection.reconnectRequired))
  );
}
export type SuggestedTask = {
  id: string;
  title: string;
  source: string;
  kind?: 'now' | 'ongoing';
  origin?: 'learned' | 'common';
};
export type TaskSuggestions = {
  intro: string;
  tasks: SuggestedTask[];
  apps?: string[];
};
