import type { Connection } from './contracts.ts';

export const onboardingSteps = ['welcome', 'brain', 'email', 'about', 'telegram', 'open'] as const;
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
export type InterviewMessage = { from: 'otto' | 'owner'; text: string };
export type InterviewResponse = { messages: string[]; done: boolean };
export type OnboardingInterview = {
  answers: string[];
  turns: string[][];
  done: boolean;
};
export type SuggestedTask = {
  id: string;
  title: string;
  source: 'gmail' | 'web' | 'telegram';
  kind?: 'now' | 'ongoing';
};
export type TaskSuggestions = { intro: string; tasks: SuggestedTask[] };
