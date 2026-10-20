import { noteChars } from './memory.ts';

export const onboardingSteps = ['welcome', 'brain', 'email', 'about', 'telegram', 'open'] as const;
export const onboardingVersion = 2;
export type OnboardingStep = (typeof onboardingSteps)[number];
export const interviewLabels = ['Working on', 'Aiming for', 'Take off your plate'] as const;
export const interviewAnswerChars =
  noteChars - Math.max(...interviewLabels.map((label) => `${label}: `.length));
export const lastQuestion =
  'What can I take off your plate? Or tell me anything else on your mind.';
export type InterviewResponse = { ack: string; question: string };
export type InterviewSave = { answers: [string, string, string] };
export type SuggestedTask = {
  id: string;
  title: string;
  source: 'gmail' | 'web' | 'telegram';
  kind?: 'now' | 'ongoing';
};
export type TaskSuggestions = { intro: string; tasks: SuggestedTask[] };
