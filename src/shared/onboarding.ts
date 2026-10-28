import type { Connection } from './contracts.ts';

export const onboardingSteps = ['welcome', 'intro', 'email', 'calendar', 'brain', 'apps'] as const;
export const onboardingEmailProviders = ['gmail', 'outlook'] as const;
export const onboardingCalendarProviders = ['googlecalendar', 'outlook'] as const;
export const onboardingVersion = 2;
export type OnboardingStep = (typeof onboardingSteps)[number];
export function connectedGmail(connection: Connection) {
  return (
    connection.slug === 'gmail' &&
    connection.status === 'connected' &&
    Boolean(connection.connectionId && connection.accountId) &&
    !connection.disconnectPending
  );
}
export const interviewQuestions = 3;
export const interviewAnswerChars = 1200;
export type OnboardingInterview = {
  generation: string;
  completed: boolean;
  answers: string[];
  turns: string[][];
  done: boolean;
};
export type OnboardingInterviewState = OnboardingInterview | { resetVersion: string };
export type SuggestedTask = {
  id: string;
  title: string;
  source: string;
  kind?: 'now' | 'ongoing';
};
export type TaskSuggestions = { intro: string; tasks: SuggestedTask[] };
